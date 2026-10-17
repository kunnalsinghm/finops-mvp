// scripts/migrate-tenants.js - migrate every tenant schema now, instead of
// waiting for each tenant's first request after a deploy.
//
//   npm run migrate-tenants                       migrate everything
//   npm run migrate-tenants -- --dry-run          show what is pending, change nothing
//   npm run migrate-tenants -- --tenant 37        just one tenant
//   npm run migrate-tenants -- --json             machine-readable result
//
// Exit codes: 0 all good, 1 at least one tenant failed or is blocked (details
// printed; fix the cause and run the same command again, it only does what is
// still behind), 2 usage or setup error.
//
// Safe while the server is running: every schema takes its own advisory lock.
// Multi-tenant mode is Postgres only: set FINOPS_POSTGRES_URL (a .env file in
// the working directory is read, like the server does).
require("dotenv").config();

const USAGE = "Usage: npm run migrate-tenants -- [--dry-run] [--tenant <id>] [--json]";

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, tenantId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--tenant") {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error("--tenant needs a numeric tenant id");
      opts.tenantId = Number(v);
    } else throw new Error(`Unknown argument ${JSON.stringify(a)}`);
  }
  return opts;
}

const vs = (v) => (v === null || v === undefined ? "unversioned" : `v${v}`);

function line(r, dryRun) {
  const who = `tenant ${r.tenant_id} (${r.schema_name})`;
  switch (r.outcome) {
    case "migrated": return `ok       ${who}: ${vs(r.from)} -> ${vs(r.to)} (applied ${r.applied.join(", ")})`;
    case "current": return `current  ${who}: ${vs(r.to)}`;
    case "pending": return `pending  ${who}: ${vs(r.from)}, would apply ${r.pending.join(", ")}`;
    case "blocked": return `BLOCKED  ${who}: ${r.error}`;
    default: return `FAILED   ${who}: ${r.error}`;
  }
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (!process.env.FINOPS_POSTGRES_URL) {
    console.error("FINOPS_POSTGRES_URL is not set. Multi-tenant mode uses Postgres; point this at the same database as the server.");
    process.exit(2);
  }
  const { migrateAllTenants } = require("../server/tenantMigrate");
  const tenancy = require("../server/tenancy");
  const say = opts.json ? () => {} : (s) => console.log(s);
  let report;
  try {
    say(opts.dryRun ? "DRY RUN: nothing will be changed or recorded." : "Migrating the control plane, then each tenant, one at a time.");
    report = await migrateAllTenants({ dryRun: opts.dryRun, tenantId: opts.tenantId, onResult: (r) => say(line(r, opts.dryRun)) });
  } catch (err) {
    console.error(`migrate-tenants stopped before finishing: ${err.message}`);
    await tenancy.closeAll().catch(() => {});
    process.exit(/^No tenant with id|is deleted \(purged\)/.test(err.message) ? 2 : 1);
  }
  await tenancy.closeAll().catch(() => {});

  const s = report.summary;
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const cp = report.controlPlane;
    say(`Control plane (${cp.schema}): ${cp.blocked ? `BLOCKED: ${cp.blocked}` : opts.dryRun ? `${vs(cp.from)}, pending ${cp.pending.join(", ") || "none"}` : `${vs(cp.from)} -> ${vs(cp.to)}`}`);
    say(`Summary: ${s.total} tenants: ${s.migrated} migrated, ${s.current} already current, ${s.pending} pending, ${s.failed} failed, ${s.blocked} blocked${opts.dryRun ? " (dry run: nothing changed)" : ""}.`);
    if (s.failed || s.blocked) {
      say("Fix the cause, then re-run the same command: tenants already current are skipped, so it only does what is still behind.");
    }
  }
  process.exit(s.failed || s.blocked || report.controlPlane.blocked ? 1 : 0);
})().catch((err) => {
  console.error("migrate-tenants failed:", err.message);
  process.exit(1);
});
