// fireOnce.js - "do this at most once per key", with the database as the arbiter.
//
// The state tables behind every fire-once alert (budget_alert_state,
// commitment_alert_state, weekly_briefing_state, anomaly_alert_state) have a
// PRIMARY KEY on exactly the columns that identify "this alert, this period". The
// old pattern - SELECT whether it fired, send, INSERT a marker - lets two callers
// both SELECT before either INSERTs, so both send: two replicas running the same
// periodic job, or two concurrent requests in ONE process for the per-request
// anomaly checks.
//
// Here the INSERT decides. claim() is INSERT ... ON CONFLICT DO NOTHING and reports
// whether THIS call created the row (rows changed, which is how both SQLite and
// Postgres say it; lastInsertRowid is not reliable for an ignored insert). Only the
// winner runs the action. If the action throws, the claim is released so the next
// check retries it - the retry-on-next-check behaviour the old send-then-mark order
// existed for.
//
// TRADE-OFF, stated plainly: claim-then-send means a process that dies between the
// claim and the send loses that one alert (the key stays claimed). The old order
// could not lose it but could send it twice. For alerts that fire once per period,
// a rare lost one is the smaller harm than a duplicate on every race; a graceful
// shutdown drains running jobs, so only a hard kill in that window can lose one.
//
// Table and column names are interpolated into SQL, so they must be plain
// identifiers; they are code constants, never user input, and are checked anyway.
// Values are always bound.

const IDENT = /^[a-z_][a-z0-9_]*$/;

function parts(table, key) {
  if (!IDENT.test(table)) throw new Error(`fireOnce: table must be a plain identifier, got ${JSON.stringify(table)}`);
  const cols = Object.keys(key);
  if (cols.length === 0) throw new Error("fireOnce: a key needs at least one column");
  for (const c of cols) {
    if (!IDENT.test(c)) throw new Error(`fireOnce: column must be a plain identifier, got ${JSON.stringify(c)}`);
  }
  return { cols, vals: cols.map((c) => key[c]) };
}

// True if this call created the row, false if it already existed.
async function claim(db, table, key) {
  const { cols, vals } = parts(table, key);
  const result = await db.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
    vals
  );
  return Number(result.changes) === 1;
}

async function release(db, table, key) {
  const { cols, vals } = parts(table, key);
  await db.run(`DELETE FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`, vals);
}

// Runs `action` iff this call wins the claim. Returns { fired, value }.
async function fireOnce(db, table, key, action) {
  if (!(await claim(db, table, key))) return { fired: false };
  try {
    return { fired: true, value: await action() };
  } catch (err) {
    try {
      await release(db, table, key);
    } catch (releaseErr) {
      // The claim stays, so this alert will not retry until the period rolls over.
      // Say so loudly: it is the one way a failed delivery can be lost.
      require("./logger").error("Could not release a fire-once claim after a failed action", {
        table, key, error: releaseErr.message,
      });
    }
    throw err;
  }
}

module.exports = { fireOnce, claim, release };
