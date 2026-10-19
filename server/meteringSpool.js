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
// handed back to the live spool; rows that succeed are gone. Returns counts so the
// CLI (and tests) can report exactly what happened: `remaining` is how many lines
// are in the live spool NOW (failures, plus anything spooled while this ran).
//
// Safe to run while the server is serving, twice, and after a crash at any point.
//
//  - It never edits the live spool in place. It CLAIMS it first by renaming it to
//    `<spool>.replaying.<pid>` (atomic): the server's next append simply creates a
//    fresh live file. Rewriting the file in place used to delete or overwrite any
//    line the server appended during the replay - a billed call with no usage row.
//  - A line written into the claimed file after we read it (spoolEvent opened the
//    path just before the rename) is caught by re-reading the claimed file until it
//    stops growing, before it is deleted.
//  - Failures are appended to the live spool BEFORE the claimed files are deleted,
//    so a crash in between leaves them in both places rather than in neither.
//  - A claimed file left by a crashed run is claimed again by the next run, which
//    is why this starts by looking for `<spool>.replaying.*` as well as the spool.
//  - The insert is idempotent on the row's event_id (see usageStore.js), so a row
//    seen twice (the crash window above, two replays at once) counts as
//    `duplicates` and is NOT inserted again. Rows from before event_id existed (no
//    id) have no such protection and could be inserted twice in those windows.
async function replaySpool() {
  const file = spoolPath();
  const dir = path.dirname(file);
  const claimedPrefix = `${path.basename(file)}.replaying.`;
  const { insertUsageEvent } = require("./usageStore");

  // Leftovers from a crashed run first, then a fresh claim of the live spool.
  const claimed = [];
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(claimedPrefix)) claimed.push(path.join(dir, name));
    }
  }
  if (fs.existsSync(file)) {
    const mine = `${file}.replaying.${process.pid}`;
    // Our own pid may already be claimed (a crashed earlier run in this process):
    // never overwrite it, claim under a unique name instead.
    const target = claimed.includes(mine) ? `${mine}.${Date.now()}` : mine;
    fs.renameSync(file, target);
    claimed.push(target);
  }
  if (claimed.length === 0) return { total: 0, replayed: 0, duplicates: 0, remaining: countLines(file) };

  const kept = [];
  let total = 0;
  let replayed = 0;
  let duplicates = 0;

  async function replayLine(line) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      kept.push(line); // unparseable - keep for a human, never drop silently
      return;
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

  for (const claimedFile of claimed) {
    // Read, replay, and read again until the file stops growing (see the note above
    // about a write that lands in the claimed file after the rename).
    let offset = 0;
    for (;;) {
      const buf = fs.readFileSync(claimedFile);
      if (buf.length <= offset) break;
      const fresh = buf.subarray(offset).toString("utf8").split("\n").filter((l) => l.trim() !== "");
      offset = buf.length;
      for (const line of fresh) {
        total++;
        await replayLine(line);
      }
    }
  }

  // Hand failures back to the live spool first, delete the claimed files after.
  if (kept.length > 0) {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, kept.join("\n") + "\n");
  }
  for (const claimedFile of claimed) {
    try {
      fs.unlinkSync(claimedFile);
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // another replay already removed it
    }
  }
  return { total, replayed, duplicates, remaining: countLines(file) };
}

function countLines(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  } catch {
    return 0;
  }
}

module.exports = { spoolEvent, replaySpool, spoolPath };
