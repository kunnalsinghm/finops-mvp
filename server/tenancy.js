// tenancy.js - multi-tenant hosting layer. Postgres-only, and fully OPT-IN
// via FINOPS_MULTI_TENANT=true - when that's unset (the default, and the
// only mode single-tenant self-hosted deployments ever use), nothing in
// this file is ever imported by a request path, and the existing
// single-tenant behavior in auth.js/storage/postgres.js is completely
// unaffected. This file's job is ONLY multi-tenant mode.
//
// ISOLATION MODEL - read this before touching anything below:
//
// Each tenant gets its own real Postgres SCHEMA and its own DEDICATED
// connection Pool (small: max 3, closed when idle) - NOT one shared pool
// with a per-request `SET search_path`. This is a deliberate choice over
// the more common shared-pool approach:
//
//   Shared pool + SET search_path + reset-on-release: fewer idle
//   connections, but the safety of every tenant's data depends on every
//   single call site remembering to reset search_path before releasing a
//   client back to the pool - forget it ONCE, under load, and the next
//   unrelated request that happens to reuse that physical connection
//   silently queries the wrong tenant's schema. That failure mode is a
//   customer data breach, not a bug ticket.
//
//   Dedicated pool per tenant (chosen here): a tenant's connections are
//   PHYSICALLY incapable of serving another tenant's query, by
//   construction - there is no shared state to forget to reset. The cost
//   is more idle connections at scale, which is the right tradeoff for a
//   platform with a modest number of paying customers; if this ever grows
//   into hundreds of tenants, that's a good problem to have and a
//   deliberate re-architecture at that point, not a silent risk today.
//
// requireAuth (see auth.js) resolves a request's tenant from the CONTROL
// PLANE (schema-agnostic, shared) FIRST, then hands the route a `req.db`
// bound to that tenant's own pool - route code that uses req.db literally
// cannot reach another tenant's data even if it tried.

const { Pool, types } = require("pg");

const MULTI_TENANT = process.env.FINOPS_MULTI_TENANT === "true";

// Same rationale as storage/postgres.js's identical block: avoid silent
// precision loss AND avoid "0" === 0 being false in bootstrap-style checks.
types.setTypeParser(20 /* int8/bigint */, (val) => parseInt(val, 10));

function assertSafeSchemaName(name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`Schema name must be a lowercase identifier (letters, digits, underscore, not starting with a digit), got '${name}'`);
  }
  return name;
}

// ---- Tenant status classification - shared by both auth.js branches
// (API-key and session-token) and by tenantLifecycle.js's own checks, so
// "is this tenant allowed to authenticate right now" is decided in exactly
// one place regardless of which credential type a request used. ----

function isTrialExpired(tenantRow) {
  return Boolean(
    tenantRow &&
      tenantRow.status === "trial" &&
      tenantRow.trial_ends_at &&
      new Date(tenantRow.trial_ends_at).getTime() < Date.now()
  );
}

// Returns a human-readable reason a request should be REJECTED, or null if
// the tenant is fine. Pure/sync - classification only. A 'trial' tenant
// whose trial_ends_at is still in the future is treated the same as
// 'active'; once it's past, the tenant is blocked exactly like
// 'trial_expired' even if the periodic sweep (tenantLifecycle.js's
// checkTrialExpirations) hasn't flipped the stored status yet - a request
// arriving one second after the trial ends shouldn't have to wait for the
// next timer tick to actually be blocked.
function tenantAccessDenialReason(tenantRow) {
  if (!tenantRow) return null;
  switch (tenantRow.status) {
    case "active":
      return null;
    case "trial":
      return isTrialExpired(tenantRow) ? "This tenant's trial period has ended" : null;
    case "trial_expired":
      return "This tenant's trial period has ended";
    case "suspended":
      return tenantRow.suspended_reason
        ? `This tenant's account is suspended: ${tenantRow.suspended_reason}`
        : "This tenant's account is suspended";
    case "offboarding":
      return "This tenant's account is being offboarded and is no longer accepting requests";
    case "deleted":
      return "This tenant's account no longer exists";
    default:
      return "This tenant's account is not active";
  }
}

// Self-healing: called from the request path the first time a trial's
// expiry is actually OBSERVED, so the stored status reflects reality
// immediately rather than staying 'trial' until tenantLifecycle.js's
// periodic sweep next runs (up to one check interval later). The extra
// `AND status = 'trial'` guard makes this safe to call unconditionally on
// every denied request without a race against a concurrent reactivation.
async function markTrialExpiredIfObserved(tenantRow) {
  if (!isTrialExpired(tenantRow)) return;
  const { controlPlaneDb } = initControlPlane();
  await controlPlaneDb.run("UPDATE tenants SET status = 'trial_expired' WHERE id = ? AND status = 'trial'", [tenantRow.id]);
}

function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wraps a single Pool into the same { get, all, run, exec, transaction }
// shape storage/postgres.js exposes, so any code written against `db.get`/
// `db.run` today needs zero changes to work against a tenant-scoped pool
// later - only which pool it's bound to changes.
function wrapPool(pool) {
  async function get(sql, params = []) {
    const result = await pool.query(toPositional(sql), params);
    return result.rows[0];
  }
  async function all(sql, params = []) {
    const result = await pool.query(toPositional(sql), params);
    return result.rows;
  }
  async function run(sql, params = []) {
    const result = await pool.query(toPositional(sql), params);
    const lastInsertRowid = result.rows[0]?.id;
    return { lastInsertRowid, changes: result.rowCount };
  }
  async function exec(sql) {
    await pool.query(sql);
  }
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        get: async (sql, params = []) => (await client.query(toPositional(sql), params)).rows[0],
        all: async (sql, params = []) => (await client.query(toPositional(sql), params)).rows,
        run: async (sql, params = []) => {
          const result = await client.query(toPositional(sql), params);
          return { lastInsertRowid: result.rows[0]?.id, changes: result.rowCount };
        },
      };
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // swallow - don't mask the original error
      }
      throw err;
    } finally {
      client.release();
    }
  }
  return { get, all, run, exec, transaction, pool };
}

// ---- Control plane: one schema, shared by every tenant, holds ONLY
// tenants/api_keys/users (see schema.controlPlane.js for why). ----

const rawControlPlaneSchema = process.env.FINOPS_CONTROL_PLANE_SCHEMA || "control_plane";
const controlPlaneSchema = assertSafeSchemaName(String(rawControlPlaneSchema).toLowerCase());

let controlPlanePool = null;
let controlPlaneReady = null;
let controlPlaneDb = null;

function initControlPlane() {
  if (controlPlanePool) return { controlPlanePool, controlPlaneReady, controlPlaneDb };

  controlPlanePool = new Pool({
    connectionString: process.env.FINOPS_POSTGRES_URL,
    options: `-c search_path=${controlPlaneSchema},public`,
  });
  controlPlaneDb = wrapPool(controlPlanePool);
  const { CONTROL_PLANE_SCHEMA_SQL } = require("./storage/schema.controlPlane");
  controlPlaneReady = (async () => {
    await controlPlanePool.query(`CREATE SCHEMA IF NOT EXISTS ${controlPlaneSchema}`);
    await controlPlanePool.query(CONTROL_PLANE_SCHEMA_SQL);
  })().catch((err) => {
    throw new Error(`Control-plane schema initialization failed: ${err.message}`);
  });

  return { controlPlanePool, controlPlaneReady, controlPlaneDb };
}

// ---- Per-tenant pools: lazily created, cached, small, and closeable. ----

const tenantPools = new Map(); // schema_name -> { pool, db, ready }

function getTenantPool(schemaName) {
  assertSafeSchemaName(schemaName);
  let entry = tenantPools.get(schemaName);
  if (entry) return entry;

  const pool = new Pool({
    connectionString: process.env.FINOPS_POSTGRES_URL,
    options: `-c search_path=${schemaName},public`,
    max: 3, // deliberately small - many of these may exist at once, one per active tenant
    idleTimeoutMillis: 30000, // release connections for tenants that go quiet, rather than holding them forever
  });
  const db = wrapPool(pool);
  const { TENANT_SCHEMA_SQL } = require("./storage/schema.tenant");
  const ready = (async () => {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    await pool.query(TENANT_SCHEMA_SQL);
  })().catch((err) => {
    throw new Error(`Tenant schema initialization failed for '${schemaName}': ${err.message}`);
  });

  entry = { pool, db, ready };
  tenantPools.set(schemaName, entry);
  return entry;
}

// The function route/auth code actually calls: returns a ready-to-use db
// object scoped to one tenant's schema. Awaits that tenant's own schema
// creation first, same "ready-before-query" discipline as
// storage/postgres.js - so the very first request ever served for a brand
// new tenant doesn't race its own schema being created.
async function getTenantDb(schemaName) {
  const entry = getTenantPool(schemaName);
  await entry.ready;
  return entry.db;
}

// Creates a new tenant: a control-plane row + that tenant's own real
// Postgres schema, fully provisioned and ready to use immediately.
// schema_name is generated here, NEVER taken from caller-supplied input -
// letting a customer-controlled string become part of a `CREATE SCHEMA`
// identifier is exactly the kind of thing that turns "add a company name"
// into a SQL-identifier-injection bug. The human-readable name is stored
// separately in the `name` column instead, where it's just data.
function generateSchemaName() {
  const suffix = require("crypto").randomBytes(6).toString("hex");
  return `tenant_${suffix}`;
}

async function createTenant({ name, trial_days = null, max_api_keys = null, max_budgets = null, max_monthly_events = null }) {
  if (!MULTI_TENANT) {
    throw new Error("createTenant() called but FINOPS_MULTI_TENANT is not enabled");
  }
  if (!name || typeof name !== "string") {
    throw new Error("createTenant requires a 'name'");
  }
  const { controlPlaneReady, controlPlaneDb } = initControlPlane();
  await controlPlaneReady;

  const schemaName = generateSchemaName();
  const status = trial_days ? "trial" : "active";
  const trialEndsAt = trial_days ? new Date(Date.now() + trial_days * 24 * 60 * 60 * 1000).toISOString() : null;

  const columns = ["name", "schema_name", "status"];
  const values = [name, schemaName, status];
  if (trialEndsAt) { columns.push("trial_ends_at"); values.push(trialEndsAt); }
  if (max_api_keys != null) { columns.push("max_api_keys"); values.push(max_api_keys); }
  if (max_budgets != null) { columns.push("max_budgets"); values.push(max_budgets); }
  if (max_monthly_events != null) { columns.push("max_monthly_events"); values.push(max_monthly_events); }

  const placeholders = columns.map(() => "?").join(", ");
  const inserted = await controlPlaneDb.run(
    `INSERT INTO tenants (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    values
  );

  // Provision the tenant's own schema/tables up front (rather than lazily
  // on first request) so tenant creation fails loudly here, at a point
  // where the caller is already expecting to handle an error - not
  // silently on someone's very first API call against a half-set-up tenant.
  await getTenantDb(schemaName);

  return { id: inserted.lastInsertRowid, name, schema_name: schemaName, status, trial_ends_at: trialEndsAt };
}

async function createTenantApiKey({ tenant_id, label, role = "developer", team = null, allow_background = false }) {
  const { controlPlaneReady, controlPlaneDb } = initControlPlane();
  await controlPlaneReady;
  const key_id = `fk_${require("crypto").randomBytes(20).toString("hex")}`;
  // team + allow_background are what make identity enforceable for this key
  // (see keyIdentity.js): they used to be silently dropped here, so a key created
  // through the API could never actually be bound to a team in multi-tenant mode.
  await controlPlaneDb.run("INSERT INTO api_keys (tenant_id, key_id, label, role, team, allow_background) VALUES (?, ?, ?, ?, ?, ?)", [
    tenant_id,
    key_id,
    label,
    role,
    team || null,
    allow_background ? 1 : 0,
  ]);
  return { key_id, tenant_id, label, role, team: team || null, allow_background: Boolean(allow_background) };
}

// The function auth.js's requireAuth calls on every request in multi-tenant
// mode: resolves an X-API-Key against the control plane and returns enough
// to both authorize the request (role) AND route it to the right tenant
// schema (tenant_id, tenant_schema) - joined in one query rather than two
// round trips.
async function resolveTenantApiKey(keyId) {
  const { controlPlaneReady, controlPlaneDb } = initControlPlane();
  await controlPlaneReady;
  return controlPlaneDb.get(
    `SELECT api_keys.*, tenants.schema_name AS tenant_schema, tenants.status AS tenant_status,
            tenants.trial_ends_at AS tenant_trial_ends_at, tenants.suspended_reason AS tenant_suspended_reason,
            tenants.max_api_keys AS tenant_max_api_keys, tenants.max_budgets AS tenant_max_budgets,
            tenants.max_monthly_events AS tenant_max_monthly_events
     FROM api_keys JOIN tenants ON tenants.id = api_keys.tenant_id
     WHERE api_keys.key_id = ?`,
    [keyId]
  );
}

// Session-token auth (see tenantUsers.js) already knows which tenant a
// session belongs to (tenantId, cached at login) but NOT whether that
// tenant has since been suspended or offboarded mid-session - a session can
// live up to 24h, far longer than it'd take an operator to suspend an
// abusive tenant, so every session-authenticated request re-checks status
// here rather than trusting whatever was true at login time.
async function getTenantStatus(tenantId) {
  const { controlPlaneReady, controlPlaneDb } = initControlPlane();
  await controlPlaneReady;
  return controlPlaneDb.get("SELECT * FROM tenants WHERE id = ?", [tenantId]);
}

// The list the periodic background-job scheduler (tenantJobs.js) and the
// trial-expiry sweep (tenantLifecycle.js) both iterate over. 'trial' tenants
// are included deliberately - a trial customer still gets budget alerts and
// weekly briefings right up until (and not after) their trial actually
// expires; 'suspended'/'offboarding'/'trial_expired'/'deleted' tenants are
// excluded because there is no legitimate reason to spend a background
// job's Postgres connection on a tenant that can't even log in right now.
async function listActiveTenants() {
  const { controlPlaneReady, controlPlaneDb } = initControlPlane();
  await controlPlaneReady;
  return controlPlaneDb.all("SELECT * FROM tenants WHERE status IN ('active', 'trial') ORDER BY id");
}

// Every tenant, any status - used by admin/reporting tooling
// (tenantLifecycle.js's listTenantsForAdmin) that needs to see suspended
// and offboarding tenants too, not just the ones background jobs run for.
async function listAllTenants() {
  const { controlPlaneReady, controlPlaneDb } = initControlPlane();
  await controlPlaneReady;
  return controlPlaneDb.all("SELECT * FROM tenants ORDER BY id");
}

// Test/shutdown helper: closes every pool this module has ever opened
// (control plane + every tenant pool created so far). Not used in normal
// server operation - server processes just exit - but essential for test
// suites, which otherwise leak one open Postgres connection pool per
// tenant created across the whole run.
async function closeAll() {
  const closers = [];
  if (controlPlanePool) closers.push(controlPlanePool.end());
  for (const { pool } of tenantPools.values()) closers.push(pool.end());
  await Promise.all(closers);
  tenantPools.clear();
  controlPlanePool = null;
  controlPlaneReady = null;
  controlPlaneDb = null;
}

// Closes and forgets ONE tenant's pool - called by tenantLifecycle.js's
// purgeTenant right after DROP SCHEMA, so a purged tenant's now-pointless
// (its schema no longer exists) pool doesn't linger holding connections,
// and so a schema_name reused far in the future (extremely unlikely given
// generateSchemaName's randomness, but not impossible) can't accidentally
// pick up a stale cached pool/ready-promise from a tenant that no longer
// exists. A no-op if this schema was never opened (nothing to close).
async function closeTenantPool(schemaName) {
  const entry = tenantPools.get(schemaName);
  if (!entry) return;
  tenantPools.delete(schemaName);
  await entry.pool.end();
}

module.exports = {
  MULTI_TENANT,
  controlPlaneSchema,
  initControlPlane,
  getTenantDb,
  createTenant,
  createTenantApiKey,
  resolveTenantApiKey,
  getTenantStatus,
  listActiveTenants,
  listAllTenants,
  isTrialExpired,
  tenantAccessDenialReason,
  markTrialExpiredIfObserved,
  closeAll,
  closeTenantPool,
  // exposed for tests that need to inspect pool identity/count, not for
  // route code
  _tenantPools: tenantPools,
};
