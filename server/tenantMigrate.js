// tenantMigrate.js - migrate EVERY tenant schema up front and report per tenant
// (`npm run migrate-tenants`, scripts/migrate-tenants.js).
//
// Tenant schemas are also migrated lazily when a tenant is first opened (H1a).
// That is safe but invisible: nothing says which tenants are behind, and a
// tenant that fails is only found when its customer hits an error. This runs the
// same migrator over all of them in a controlled way:
//
//   - the control plane first; if it cannot be migrated nothing else is touched
//   - then one tenant at a time, closing each pool afterwards, so connections
//     stay at one tenant's pool (max 3) plus the control plane instead of
//     tenants x 3
//   - a failure on one tenant is recorded and reported, and the run CONTINUES
//   - idempotent: tenants already current cost one read, so re-running after a
//     fix does only the remaining work (that is the resume mechanism)
//   - dry run: reads versions and plans, applies and records nothing
//   - deleted (purged) tenants are skipped, and a tenant whose schema is missing
//     is reported as failed rather than silently recreated empty
//
// It is safe to run while the server is serving traffic: each schema takes its
// own advisory lock, so the lazy path and this command never apply the same
// migration twice.

const { Pool } = require("pg");
const tenancy = require("./tenancy");
const migrator = require("./storage/migrator");
const { migrationsFor } = require("./storage/schemaRunner");

const DIALECTS = ["postgres"];
// Schema names reach SQL here as quoted identifiers. They come from the
// control-plane `schema_name` column (server generated) and the control-plane
// env name, both already restricted by tenancy.js; re-check before quoting.
const SAFE = /^[a-z_][a-z0-9_]{0,62}$/;
function ident(name) {
  if (!SAFE.test(name)) throw new Error(`Refusing unsafe schema name ${JSON.stringify(name)}`);
  return `"${name}"`;
}

async function schemaExists(pool, schema) {
  const r = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [schema]);
  return r.rows.length === 1;
}

// null = the schema has no schema_migrations table yet (created before versioning).
async function readApplied(pool, schema) {
  const t = await pool.query("SELECT to_regclass($1) AS t", [`${ident(schema)}.schema_migrations`]);
  if (!t.rows[0].t) return null;
  const r = await pool.query(`SELECT version, name, checksum FROM ${ident(schema)}.schema_migrations ORDER BY version`);
  return r.rows.map((x) => ({ ...x, version: Number(x.version) }));
}

const maxVersion = (rows) => (rows && rows.length ? Math.max(...rows.map((r) => r.version)) : null);

// What would run, without running it. An unversioned schema would first get its
// baseline row recorded (version 1), so that counts as pending.
function plan(kind, rows) {
  const list = migrationsFor(kind);
  if (rows === null) return { pending: [1, ...list.map((m) => m.version)] };
  const allowNewer = process.env.FINOPS_ALLOW_NEWER_SCHEMA === "true";
  return { pending: migrator.planMigrations(list, rows, { allowNewer, dialects: DIALECTS }).pending.map((m) => m.version) };
}

function summarize(results) {
  const s = { total: results.length, migrated: 0, current: 0, failed: 0, pending: 0, blocked: 0 };
  for (const r of results) s[r.outcome]++;
  return s;
}

async function migrateAllTenants({ dryRun = false, tenantId = null, onResult = () => {} } = {}) {
  const url = process.env.FINOPS_POSTGRES_URL;
  if (!url) throw new Error("FINOPS_POSTGRES_URL is not set");
  const cpSchema = tenancy.controlPlaneSchema;
  // Introspection only (versions, existence, the tenants list). Migrating goes
  // through tenancy so the lazy path and this command share one code path.
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    // ---- control plane ----
    const cpBefore = await readApplied(pool, cpSchema);
    const controlPlane = { schema: cpSchema, from: maxVersion(cpBefore), to: maxVersion(cpBefore), applied: [], pending: [] };
    if (dryRun) {
      try { controlPlane.pending = plan("controlPlane", cpBefore).pending; } catch (err) { controlPlane.blocked = err.message; }
    } else {
      await tenancy.initControlPlane().controlPlaneReady; // migrates; throws, and we stop, if it cannot
      const cpAfter = await readApplied(pool, cpSchema);
      const had = new Set((cpBefore || []).map((r) => r.version));
      controlPlane.to = maxVersion(cpAfter);
      controlPlane.applied = cpAfter.map((r) => r.version).filter((v) => !had.has(v));
    }

    // ---- which tenants ----
    const tenantsTable = `${ident(cpSchema)}.tenants`;
    let tenants;
    if (tenantId !== null) {
      const row = (await pool.query(`SELECT id, name, schema_name, status FROM ${tenantsTable} WHERE id = $1`, [tenantId])).rows[0];
      if (!row) throw new Error(`No tenant with id ${tenantId}`);
      if (row.status === "deleted") throw new Error(`Tenant ${tenantId} is deleted (purged); there is nothing to migrate`);
      tenants = [row];
    } else {
      tenants = (await pool.query(`SELECT id, name, schema_name, status FROM ${tenantsTable} WHERE status <> 'deleted' ORDER BY id`)).rows;
    }

    // ---- one tenant at a time ----
    const results = [];
    for (const t of tenants) {
      const schema = t.schema_name;
      const r = { tenant_id: Number(t.id), name: t.name, schema_name: schema, status: t.status, outcome: null, from: null, to: null, applied: [], pending: [], error: null };
      try {
        if (!(await schemaExists(pool, schema))) {
          const err = new Error(`schema '${schema}' does not exist (dropped, or never created); not recreating it`);
          err.record = true; // getTenantDb was never called, so nothing recorded this yet
          throw err;
        }
        const before = await readApplied(pool, schema);
        r.from = maxVersion(before);
        r.to = r.from;
        if (dryRun) {
          try {
            r.pending = plan("tenant", before).pending;
            r.outcome = r.pending.length ? "pending" : "current";
          } catch (err) {
            r.outcome = "blocked";
            r.error = err.message;
          }
        } else {
          // force: bypass the retry window - we were just asked to try again.
          await tenancy.getTenantDb(schema, { force: true });
          const after = await readApplied(pool, schema);
          const had = new Set((before || []).map((x) => x.version));
          r.to = maxVersion(after);
          r.applied = after.map((x) => x.version).filter((v) => !had.has(v));
          r.outcome = r.applied.length ? "migrated" : "current";
        }
      } catch (err) {
        r.outcome = "failed";
        r.error = err.message;
        if (err.record && !dryRun) await tenancy.recordSchemaStatus(schema, { error: err.message });
      } finally {
        if (!dryRun) await tenancy.closeTenantPool(schema).catch(() => {});
      }
      results.push(r);
      onResult(r);
    }

    return { dryRun, controlPlane, results, summary: summarize(results) };
  } finally {
    await pool.end();
  }
}

module.exports = { migrateAllTenants };
