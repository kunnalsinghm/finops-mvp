// test/usageEventIdTenant.test.js - usage_events.event_id in multi-tenant mode.
//
// Tenant schemas are versioned by their own migration list (H1a), so the
// column and the unique index arrive as tenant migration 2 - for a tenant
// created after this change AND for one that already exists and holds data.
// The key is unique PER TENANT SCHEMA: two tenants may each hold an event with
// the same id (they are different customers), and a replay lands in the tenant
// it came from and nowhere else. Postgres only.

const test = require("node:test");
const assert = require("node:assert/strict");

if (process.env.FINOPS_DB_DRIVER !== "postgres") {
  test("tenant event_id tests skipped - requires FINOPS_DB_DRIVER=postgres", () => {});
} else {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { randomUUID } = require("node:crypto");
  const CP_SCHEMA = `cp_eidt_${process.pid}`;
  const SPOOL = path.join(os.tmpdir(), `finops-spool-eidt-${process.pid}.jsonl`);
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = CP_SCHEMA;
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_SPOOL_PATH = SPOOL;

  const { Pool } = require("pg");
  const tenancy = require("../server/tenancy");
  const { replaySpool, spoolEvent } = require("../server/meteringSpool");
  const tenantList = require("../server/storage/migrations/tenant");
  const { TENANT_SCHEMA_SQL } = require("../server/storage/schema.tenant");

  const URL = process.env.FINOPS_POSTGRES_URL;
  let admin;
  const q = (sql, params) => admin.query(sql, params).then((r) => r.rows);
  const made = new Set();

  test.before(() => { admin = new Pool({ connectionString: URL }); });
  test.afterEach(() => { try { fs.unlinkSync(SPOOL); } catch {} });
  test.after(async () => {
    await tenancy.closeAll();
    for (const s of made) await q(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await q(`DROP SCHEMA IF EXISTS ${CP_SCHEMA} CASCADE`);
    await admin.end();
    try { fs.unlinkSync(SPOOL); } catch {}
  });

  const eventIdIndex = (schema) => q(
    `SELECT i.indisunique, i.indisvalid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE ns.nspname = $1 AND c.relname = 'usage_events' AND a.attname = 'event_id'`, [schema]);
  const versions = (schema) => q(`SELECT version FROM ${schema}.schema_migrations ORDER BY version`).then((r) => r.map((x) => x.version));
  const sampleRow = (event_id) => ({
    event_time: new Date().toISOString(), provider: "openai", model: "gpt-4.1", team: "t", environment: "e", git_branch: null,
    user_id: "tenant-user", input_tokens: 10, output_tokens: 5, cost_usd: 0.25, tagged: 1, raw_json: "{}", event_id,
  });
  const countIn = (schema, event_id) => q(`SELECT COUNT(*)::int AS n FROM ${schema}.usage_events WHERE event_id = $1`, [event_id]).then((r) => r[0].n);
  const newTenant = async (name) => { const t = await tenancy.createTenant({ name }); made.add(t.schema_name); return t; };

  test("tenant migration 2 is registered, named usage_event_id, and non-transactional", () => {
    const m = tenantList.find((x) => x.version === 2);
    assert.ok(m, "tenant migration 2 is registered");
    assert.equal(m.name, "usage_event_id");
    assert.equal(m.transaction, false);
    assert.equal(typeof m.up.postgres, "function");
  });

  test("a new tenant gets event_id and a VALID unique index", async () => {
    const t = await newTenant("eid new tenant");
    const idx = await eventIdIndex(t.schema_name);
    assert.equal(idx.length, 1);
    assert.equal(idx[0].indisunique, true);
    assert.equal(idx[0].indisvalid, true);
    assert.deepEqual(await versions(t.schema_name), [1, 2]);
  });

  test("a tenant that existed before, with data, is upgraded when opened: rows kept, table not rewritten", async () => {
    const schema = `tenant_eidt_legacy_${process.pid}`;
    made.add(schema);
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`).catch(() => {});
    const c = await admin.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query(TENANT_SCHEMA_SQL);
      for (let i = 0; i < 12; i++) {
        await c.query("INSERT INTO usage_events (event_time, provider, model, user_id, input_tokens, output_tokens, cost_usd, tagged) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',$1,1,1,0.5,0)", [`old-${i}`]);
      }
    } finally { c.release(); }
    const relfile = () => q("SELECT c.relfilenode::text AS f FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relname = 'usage_events'", [schema]).then((r) => r[0].f);
    const before = await relfile();
    assert.equal((await eventIdIndex(schema)).length, 0, "precondition: the old schema has no event_id");

    await tenancy.getTenantDb(schema);
    assert.deepEqual(await versions(schema), [1, 2]);
    assert.equal(await relfile(), before, "no table rewrite");
    assert.equal((await q(`SELECT COUNT(*)::int AS n FROM ${schema}.usage_events WHERE event_id IS NULL`))[0].n, 12);
    const idx = await eventIdIndex(schema);
    assert.equal(idx[0].indisvalid, true);
    assert.equal(idx[0].indisunique, true);
  });

  test("a tenant left with a stale INVALID index by a failed concurrent build is repaired when opened", async () => {
    const schema = `tenant_eidt_stale_${process.pid}`;
    made.add(schema);
    await q(`CREATE SCHEMA ${schema}`);
    const c = await admin.connect();
    try {
      await c.query(`SET search_path TO ${schema}, public`);
      await c.query(TENANT_SCHEMA_SQL);
      await c.query("ALTER TABLE usage_events ADD COLUMN event_id TEXT");
      const ins = (user) => c.query("INSERT INTO usage_events (event_time, provider, model, user_id, input_tokens, output_tokens, cost_usd, tagged, event_id) VALUES ('2026-01-01T00:00:00Z','openai','gpt-4o',$1,1,1,0.5,0,'44444444-4444-4444-8444-444444444444')", [user]);
      await ins("a");
      await ins("b");
      await assert.rejects(() => c.query("CREATE UNIQUE INDEX CONCURRENTLY idx_usage_events_event_id ON usage_events (event_id)"), /duplicate key|unique/i);
      const left = await eventIdIndex(schema);
      assert.equal(left.length, 1, "precondition: the failed build left an index behind");
      assert.equal(left[0].indisvalid, false, "precondition: and it is INVALID");
      await c.query("DELETE FROM usage_events WHERE user_id = 'b'");
    } finally { c.release(); }

    await tenancy.getTenantDb(schema);
    const idx = await eventIdIndex(schema);
    assert.equal(idx.length, 1);
    assert.equal(idx[0].indisvalid, true, "IF NOT EXISTS alone would have kept the invalid index");
    assert.equal(idx[0].indisunique, true);
    assert.deepEqual(await versions(schema), [1, 2]);
  });

  test("replaying a tenant's spooled event twice yields one row in that tenant", async () => {
    const t = await newTenant("eid replay tenant");
    const id = randomUUID();
    spoolEvent(sampleRow(id), "db down", { tenantSchema: t.schema_name });
    const copy = fs.readFileSync(SPOOL);
    assert.deepEqual(await replaySpool(), { total: 1, replayed: 1, duplicates: 0, remaining: 0 });
    fs.writeFileSync(SPOOL, copy);
    assert.deepEqual(await replaySpool(), { total: 1, replayed: 0, duplicates: 1, remaining: 0 });
    assert.equal(await countIn(t.schema_name, id), 1);
  });

  test("event_id is unique per tenant schema, not across tenants", async () => {
    const a = await newTenant("eid tenant A");
    const b = await newTenant("eid tenant B");
    const id = randomUUID();
    spoolEvent(sampleRow(id), "db down", { tenantSchema: a.schema_name });
    spoolEvent(sampleRow(id), "db down", { tenantSchema: b.schema_name });
    assert.deepEqual(await replaySpool(), { total: 2, replayed: 2, duplicates: 0, remaining: 0 });
    assert.equal(await countIn(a.schema_name, id), 1);
    assert.equal(await countIn(b.schema_name, id), 1);
  });
}
