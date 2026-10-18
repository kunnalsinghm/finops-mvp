// meteringSpool.js - a last-resort durable record for usage events that could
// not be written to the database.
//
// Why this exists: the proxy forwards a request to a paid provider FIRST and
// meters it afterwards (token counts only exist once the response is back). If
// the metering write fails after that point - DB down, disk full, a transient
// lock - the money is already spent. Previously the streaming path swallowed
// that error (spend silently vanished) and the non-streaming path answered
// 502 for a call that had in fact succeeded and been billed.
//
// Now the failed row is appended, as one JSON line, to a local file so it can
// be replayed once the store is healthy (`npm run replay-spool`). Appending a
// line to a file is the most failure-independent write available here: it
// works when the database doesn't.
//
// What it does NOT do: it is not a queue with delivery guarantees. If the disk
// itself is unwritable the event is lost, and that is logged loudly rather than
// hidden.

const fs = require("fs");
const path = require("path");
const logger = require("./logger");

function spoolPath() {
  return process.env.FINOPS_SPOOL_PATH || path.join(__dirname, "..", "data", "metering-spool.jsonl");
}

function spoolEvent(row, reason, { tenantSchema = null } = {}) {
  const file = spoolPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      // tenant_schema is what keeps a replayed row in the tenant it came from; absent (single-tenant
      // mode, or a spool written before multi-tenancy) means the one shared database.
      JSON.stringify({ spooled_at: new Date().toISOString(), reason: String(reason || ""), tenant_schema: tenantSchema, row }) + "\n"
    );
    return { spooled: true, file };
  } catch (err) {
    logger.error(`[meteringSpool] could not write spool file '${file}': ${err.message} - usage event LOST: ${JSON.stringify(row)}`);
    return { spooled: false, file, error: err.message };
  }
}

// Replays every spooled row through the normal insert. Rows that still fail are
// kept in the file; rows that succeed are removed. Returns counts so the CLI
// (and tests) can report exactly what happened.
//
// Safe to run twice, and after a crash at any point: the insert is idempotent on
// the row's event_id (see usageStore.js), so a row that is already stored counts
// as `duplicates`, is NOT inserted again, and leaves the spool. The worst a crash
// can do is leave lines in the spool that the next run recognises as duplicates.
// Rows from before event_id existed (no id) are inserted once per run, as before.
async function replaySpool() {
  const file = spoolPath();
  if (!fs.existsSync(file)) return { total: 0, replayed: 0, duplicates: 0, remaining: 0 };
  const { insertUsageEvent } = require("./usageStore");

  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const kept = [];
  let replayed = 0;
  let duplicates = 0;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      kept.push(line); // unparseable - keep for a human, never drop silently
      continue;
    }
    try {
      let targetDb;
      if (entry.tenant_schema) {
        // If the tenant can't be resolved right now, the row stays in the spool - it must
        // never be replayed into the default schema, which would attribute one customer's
        // usage to whoever owns that schema.
        const tenancy = require("./tenancy");
        // getTenantDb() will CREATE SCHEMA for any well-formed name, so a row for a tenant that
        // has since been deleted would silently resurrect its schema. Only a tenant the control
        // plane still knows may receive a replay.
        const { controlPlaneReady, controlPlaneDb } = tenancy.initControlPlane();
        await controlPlaneReady;
        const known = await controlPlaneDb.get("SELECT 1 AS ok FROM tenants WHERE schema_name = ?", [entry.tenant_schema]);
        if (!known) throw new Error(`unknown tenant schema '${entry.tenant_schema}'`);
        targetDb = await tenancy.getTenantDb(entry.tenant_schema);
      }
      const insertedId = await insertUsageEvent(entry.row, targetDb);
      if (insertedId === null) duplicates++;
      else replayed++;
    } catch {
      kept.push(line);
    }
  }
  if (kept.length === 0) {
    fs.unlinkSync(file);
  } else {
    // Write the kept lines to a temp file and rename it over the spool: rename is
    // atomic, so a crash mid-rewrite leaves the ORIGINAL file intact. (Rewriting
    // in place truncates first, so a crash there used to lose every kept line.)
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, kept.join("\n") + "\n");
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  }
  return { total: lines.length, replayed, duplicates, remaining: kept.length };
}

module.exports = { spoolEvent, replaySpool, spoolPath };
