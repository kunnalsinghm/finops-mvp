// toolCallGovernance.js - agent tool-call auditing (file access, API calls,
// command execution) - distinct from usage_events, which only covers LLM
// completions. Agentic workloads need governance over ACTIONS, not just
// text, which is the whole point of this module (see the v2 product plan's
// "Agent Action Governance" section).
//
// DESIGN DECISIONS:
//   - This is a REPORTING/AUDIT mechanism, not a live blocking gate, unlike
//     the PII/prompt-injection/model-allowlist checks in routes/proxy.js.
//     Those can block because the LLM call itself happens INSIDE this
//     service's request path - we're the one making the call, so we can
//     refuse to. A tool call (a bash command, a file write, a database
//     query) happens somewhere else entirely, reported to us after the
//     fact or just before, by whatever's calling this API. We have no
//     mechanism to actually stop that execution - only to flag it for
//     review. Pretending otherwise would be dishonest about what this
//     endpoint can actually guarantee.
//   - Risky-command detection is rule-based pattern matching, same
//     "floor, not ceiling" honesty as promptInjection.js - it catches
//     known-dangerous command shapes (destructive filesystem/database
//     operations, privilege escalation), not a semantic understanding of
//     what a command does.
//   - Data-access anomaly detection reuses fraudDetection.js's exact
//     volume-spike method (today's count vs. a rolling per-agent daily
//     average), applied to tool-call volume instead of LLM-request volume.

const defaultDb = require("./storage");
const { sinceDaysAgo, dayFloorExpr, todayClause } = require("./storage/dialectSql");
const { checkRegionAllowed } = require("./dataResidency");

const RISKY_COMMAND_PATTERNS = [
  { name: "recursive-force-delete", regex: /rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/i },
  { name: "drop-database-object", regex: /\bdrop\s+(table|database|schema)\b/i },
  { name: "delete-without-filter", regex: /\bdelete\s+from\s+\w+\s*;?\s*$/i },
  { name: "truncate-table", regex: /\btruncate\s+table\b/i },
  { name: "privilege-escalation", regex: /\bsudo\b|\bchmod\s+777\b|\bchown\s+-r\s+root\b/i },
  { name: "fork-bomb", regex: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: "disk-overwrite", regex: /\bdd\s+.*of=\/dev\/(sd|nvme|disk)/i },
  { name: "shutdown-or-reboot", regex: /\bshutdown\b|\breboot\b|\bhalt\b/i },
];

function detectRiskyCommand(text) {
  if (!text || typeof text !== "string") return [];
  return RISKY_COMMAND_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.name);
}

const VOLUME_BASELINE_LOOKBACK_DAYS = 14;
const VOLUME_SPIKE_MULTIPLIER = 5;

async function checkToolCallVolumeSpike(agentId, db = defaultDb) {
  if (!agentId) return null;
  const todayRow = await db.get(
    `SELECT COUNT(*) AS n FROM tool_calls WHERE agent_id = ? AND ${todayClause("event_time")}`,
    [agentId]
  );
  const todayCount = Number(todayRow?.n || 0);
  if (todayCount === 0) return null;

  const historyRow = await db.get(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT ${dayFloorExpr("event_time")}) AS days
     FROM tool_calls
     WHERE agent_id = ? AND event_time >= ${sinceDaysAgo(VOLUME_BASELINE_LOOKBACK_DAYS)}
       AND NOT ${todayClause("event_time")}`,
    [agentId]
  );
  const days = Number(historyRow?.days || 0);
  if (days < 3) return null;

  const avgPerDay = Number(historyRow.n || 0) / days;
  if (avgPerDay < 1) return null;

  if (todayCount > avgPerDay * VOLUME_SPIKE_MULTIPLIER) {
    return `data-access-volume-spike: ${todayCount} tool calls today vs. a ${avgPerDay.toFixed(1)}/day average`;
  }
  return null;
}

async function logToolCall({ agent_id, session_id, task_id, tool_name, target, region, keyId, team, raw, db = defaultDb }) {
  const reasons = [];

  const riskyMatches = detectRiskyCommand(`${tool_name} ${target || ""}`);
  if (riskyMatches.length > 0) {
    reasons.push(...riskyMatches.map((m) => `risky-command:${m}`));
  }

  const volumeSignal = await checkToolCallVolumeSpike(agent_id, db);
  if (volumeSignal) reasons.push(volumeSignal);

  let residency = null;
  if (region) {
    residency = await checkRegionAllowed({ keyId, team, region, db });
    if (!residency.allowed) reasons.push(`data-residency-violation: region '${region}' not in the ${residency.scope}-level allow-list`);
  }

  const riskLevel = riskyMatches.length > 0 ? "high" : reasons.length > 0 ? "medium" : "low";
  const flagged = reasons.length > 0;

  const result = await db.run(
    `INSERT INTO tool_calls (agent_id, session_id, task_id, tool_name, target, region, risk_level, flagged, flag_reasons, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      agent_id || null,
      session_id || null,
      task_id || null,
      tool_name,
      target || null,
      region || null,
      riskLevel,
      flagged ? 1 : 0,
      reasons.length > 0 ? JSON.stringify(reasons) : null,
      raw ? JSON.stringify(raw) : null,
    ]
  );

  return { id: result.lastInsertRowid, risk_level: riskLevel, flagged, reasons };
}

async function listToolCalls({ onlyFlagged = false, agent_id, db = defaultDb } = {}) {
  const clauses = [];
  const params = [];
  if (onlyFlagged) clauses.push("flagged = 1");
  if (agent_id) {
    clauses.push("agent_id = ?");
    params.push(agent_id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.all(`SELECT * FROM tool_calls ${where} ORDER BY id DESC LIMIT 200`, params);
}

module.exports = { logToolCall, listToolCalls, detectRiskyCommand, RISKY_COMMAND_PATTERNS };
