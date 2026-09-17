// gpuUsage.js - GPU/self-hosted inference cost, tracked separately from
// API-provider spend (usage_events), then blended into one normalized
// view. Kept as a separate table rather than writing GPU rows into
// usage_events itself: a GPU cluster's cost isn't naturally expressed as
// provider/model/input_tokens/output_tokens - forcing it into that shape
// would mean inventing fake values for columns that don't apply, which is
// exactly the "sets non-applicable columns to null, not fake values"
// principle this codebase already applies elsewhere (see focusExport.js).
//
// SHARED-CLUSTER COST ALLOCATION (the FOCUS 1.3 "split cost allocation"
// feature): a GPU cluster shared across multiple teams has no per-team
// utilization telemetry in this MVP - there's no way to know team A used
// 40% of the cluster's actual GPU-hours vs team B's 60%. The proxy used
// here is each team's RELATIVE SHARE OF TOTAL API SPEND across the teams
// sharing that cluster, as a stand-in for relative compute usage. This is
// a genuine approximation, not a measured allocation - teams that make
// heavy API calls but light self-hosted-model use would be over-charged
// for GPU cost under this method, and vice versa. Flagging this clearly
// rather than presenting a split cost as if it were precisely measured.

const db = require("./storage");

function round4(n) {
  return Math.round((n || 0) * 10000) / 10000;
}

async function ingestGpuUsage({ event_time, cluster_name, gpu_type, utilization_pct, cost_usd, team, shared_across_teams }) {
  if (!cluster_name || cost_usd === undefined || cost_usd === null) {
    throw Object.assign(new Error("cluster_name and cost_usd are required"), { code: "VALIDATION" });
  }
  if (!team && !shared_across_teams) {
    throw Object.assign(new Error("either team (single-owner) or shared_across_teams (comma-separated list) is required"), {
      code: "VALIDATION",
    });
  }

  const result = await db.run(
    `INSERT INTO gpu_usage_events (event_time, cluster_name, gpu_type, utilization_pct, cost_usd, team, shared_across_teams)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      event_time || new Date().toISOString(),
      cluster_name,
      gpu_type || null,
      utilization_pct ?? null,
      cost_usd,
      team || null,
      shared_across_teams || null,
    ]
  );
  return result.lastInsertRowid;
}

// Computes each team's fraction of a shared cost, using relative API
// spend as the weighting signal (see the module-level comment above for
// why, and its limitations). Extracted as its own function because BOTH
// the blended-view aggregate (getBlendedCostByTeam) and the FOCUS export's
// per-event split (getGpuEventsExpanded, in this same file) need to apply
// the exact same allocation method to a specific value - keeping this in
// one place means the two views can never quietly compute a shared row's
// split two different ways.
async function computeSharedSplitFractions(teams) {
  const apiTotals = await Promise.all(
    teams.map((t) => db.get("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE team = ?", [t]))
  );
  const apiShares = apiTotals.map((r) => Number(r.total || 0));
  const totalApi = apiShares.reduce((a, b) => a + b, 0);

  return teams.map((t, i) => ({
    team: t,
    fraction: totalApi > 0 ? apiShares[i] / totalApi : 1 / teams.length,
  }));
}

async function getBlendedCostByTeam() {
  const apiTotals = await db.all(
    `SELECT COALESCE(team, 'Untagged') AS team, SUM(cost_usd) AS total FROM usage_events GROUP BY COALESCE(team, 'Untagged')`
  );
  const directGpuTotals = await db.all(
    `SELECT team, SUM(cost_usd) AS total FROM gpu_usage_events WHERE team IS NOT NULL GROUP BY team`
  );
  const sharedRows = await db.all(
    `SELECT shared_across_teams, SUM(cost_usd) AS total FROM gpu_usage_events WHERE shared_across_teams IS NOT NULL GROUP BY shared_across_teams`
  );

  const blended = {};
  const ensure = (team) => {
    if (!blended[team]) blended[team] = { team, api_cost_usd: 0, gpu_cost_usd: 0 };
    return blended[team];
  };

  for (const row of apiTotals) ensure(row.team).api_cost_usd += Number(row.total || 0);
  for (const row of directGpuTotals) ensure(row.team).gpu_cost_usd += Number(row.total || 0);

  for (const row of sharedRows) {
    const teams = row.shared_across_teams.split(",").map((t) => t.trim()).filter(Boolean);
    if (teams.length === 0) continue;

    const splits = await computeSharedSplitFractions(teams);
    for (const { team, fraction } of splits) {
      ensure(team).gpu_cost_usd += Number(row.total || 0) * fraction;
    }
  }

  return Object.values(blended)
    .map((r) => ({
      team: r.team,
      api_cost_usd: round4(r.api_cost_usd),
      gpu_cost_usd: round4(r.gpu_cost_usd),
      blended_total_usd: round4(r.api_cost_usd + r.gpu_cost_usd),
    }))
    .sort((a, b) => b.blended_total_usd - a.blended_total_usd);
}

// For FOCUS export (see focusExport.js): expands each gpu_usage_events row
// into one or more per-team rows, splitting shared-cluster cost using the
// exact same method as the blended view above. Single-owner rows pass
// through unchanged (split_method: null - a directly-measured cost, not
// an allocation). Shared rows are split into N rows, each carrying
// split_method so a FOCUS reader can tell an allocated number apart from
// a directly-measured one, per this file's own honesty principle about
// not presenting an approximation as a precise measurement.
async function getGpuEventsExpanded({ from, to } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push("event_time >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("event_time <= ?");
    params.push(to);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.all(`SELECT * FROM gpu_usage_events ${where} ORDER BY event_time ASC`, params);

  const expanded = [];
  for (const row of rows) {
    if (row.team) {
      expanded.push({ ...row, allocated_cost_usd: round4(row.cost_usd), allocated_team: row.team, split_method: null });
      continue;
    }
    const teams = (row.shared_across_teams || "").split(",").map((t) => t.trim()).filter(Boolean);
    if (teams.length === 0) continue;
    const splits = await computeSharedSplitFractions(teams);
    for (const { team, fraction } of splits) {
      expanded.push({
        ...row,
        allocated_cost_usd: round4(row.cost_usd * fraction),
        allocated_team: team,
        split_method: "relative-api-spend",
      });
    }
  }
  return expanded;
}

module.exports = { ingestGpuUsage, getBlendedCostByTeam, getGpuEventsExpanded };
