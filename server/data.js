// data.js - export and retention controls for usage_events.
//
// Two things missing from the original build that any real deployment
// needs: a way to get data OUT (for BI tools, backups, or compliance
// requests), and a way to enforce a retention window (so the SQLite file
// doesn't grow forever and so you have a real answer if asked "how long do
// you keep this data").

const db = require("./db");
const { logAudit } = require("./audit");

function exportUsageEvents({ from, to, format = "json" } = {}) {
  let query = "SELECT * FROM usage_events WHERE 1=1";
  const params = [];
  if (from) {
    query += " AND event_time >= ?";
    params.push(from);
  }
  if (to) {
    query += " AND event_time <= ?";
    params.push(to);
  }
  query += " ORDER BY event_time ASC";

  const rows = db.prepare(query).all(...params);

  if (format === "csv") {
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]);
    const lines = [headers.join(",")];
    for (const row of rows) {
      lines.push(headers.map((h) => csvEscape(row[h])).join(","));
    }
    return lines.join("\n");
  }

  return rows; // json
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Deletes usage_events older than the given ISO date. Returns count deleted.
// Deliberately requires an explicit cutoff rather than a vague "days ago"
// default - retention policy should be a conscious decision, not a default
// that quietly deletes data nobody meant to lose.
function purgeUsageEvents(beforeIsoDate, actor) {
  if (!beforeIsoDate) throw new Error("beforeIsoDate is required");
  const countRow = db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE event_time < ?").get(beforeIsoDate);
  const count = countRow.n;
  db.prepare("DELETE FROM usage_events WHERE event_time < ?").run(beforeIsoDate);
  logAudit(actor, "data.purge", null, { before: beforeIsoDate, rowsDeleted: count });
  return count;
}

module.exports = { exportUsageEvents, purgeUsageEvents };