// alerts.js - Progressive alerts (50/80/90/100%) + burn-rate alerts, delivered
// to Slack via an Incoming Webhook (free Slack feature - no paid plan needed).
// Falls back to logging only if no webhook URL is configured.
//
// Delivery ordering: the budget_alert_state row is the arbiter (see fireOnce.js).
// A check CLAIMS the tier with an INSERT ... ON CONFLICT DO NOTHING and only the
// caller that created the row delivers, so two replicas (or two overlapping
// checks) cannot both send. If delivery throws (network blip, misconfigured
// webhook, SMTP outage) the claim is released, so the next scheduled check
// retries it, instead of silently losing that alert for the rest of the month.
// The cheap SELECT below is only a fast path that skips the insert attempt.

const logger = require("./logger");
const defaultDb = require("./storage");
const { currentMonthBounds } = require("./storage/dialectSql");
const { deliverAlert } = require("./alertDelivery");
const { fireOnce } = require("./fireOnce");

async function hasFired(budgetId, month, tier, db = defaultDb) {
  const row = await db.get(
    "SELECT 1 AS found FROM budget_alert_state WHERE budget_id = ? AND month = ? AND tier = ?",
    [budgetId, month, tier]
  );
  return Boolean(row);
}

// Call this periodically (e.g. from a cron, or after each ingest) to check
// budgets and fire alerts exactly once per threshold per month.
//
// `db` defaults to the single global database (single-tenant mode). In
// multi-tenant mode the periodic scheduler (see tenantJobs.js) calls this
// once per active tenant, passing that tenant's own req.db-equivalent - the
// alert logic itself has no tenant concept, it just runs entirely inside
// whichever schema `db` points at, same as any other tenant-scoped route.
async function checkBudgetAlerts(db = defaultDb) {
  const budgets = await db.all("SELECT * FROM budgets");
  const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM' - dedup key for hasFired/fireOnce below, unrelated to the query fix
  // Sargable range for the SUM query below, not yearMonthExpr() - see
  // currentMonthBounds's comment in dialectSql.js. Both computed once
  // outside the loop since they're the same for every budget row this pass.
  const { start, end } = currentMonthBounds();

  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = await db.get(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events
       WHERE ${col} = ? AND event_time >= ? AND event_time < ?`,
      [b.scope_value, start, end]
    );

    const pct = b.monthly_limit_usd > 0 ? spend.spend / b.monthly_limit_usd : 0;
    const crossedTiers = [];
    if (pct >= 0.5) crossedTiers.push("50%");
    if (pct >= 0.8) crossedTiers.push("80%");
    if (pct >= 0.9) crossedTiers.push("90%");
    if (pct >= 1.0) crossedTiers.push("exceeded");

    for (const tier of crossedTiers) {
      const already = await hasFired(b.id, month, tier, db);
      if (already) continue;
      try {
        await fireOnce(db, "budget_alert_state", { budget_id: b.id, month, tier }, () =>
          deliverAlert(
            `:warning: Budget alert - *${b.scope_type}:${b.scope_value}* has reached *${tier}* of its $${b.monthly_limit_usd} monthly budget (spent $${spend.spend.toFixed(2)}).`,
            "budget",
            db
          )
        );
      } catch (err) {
        logger.error("Budget alert delivery failed - will retry on next check", {
          budgetId: b.id,
          tier,
          error: err.message,
        });
      }
    }
  }
}

// Burn-rate alert: flags if current daily pace implies >20% budget overrun by month end
async function checkBurnRate(db = defaultDb) {
  const budgets = await db.all("SELECT * FROM budgets");
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const month = now.toISOString().slice(0, 7); // dedup key (tier string + hasFired/fireOnce below), unrelated to the query fix
  // Sargable range for the SUM query below, not yearMonthExpr() - see
  // currentMonthBounds's comment in dialectSql.js. Same UTC semantics
  // `month` already had (toISOString() is always UTC), so this is a
  // faithful swap for the query, not a change to which rows count as
  // "this month".
  const { start, end } = currentMonthBounds(now);

  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = await db.get(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events
       WHERE ${col} = ? AND event_time >= ? AND event_time < ?`,
      [b.scope_value, start, end]
    );

    const projected = (spend.spend / dayOfMonth) * daysInMonth;
    const overrunPct = b.monthly_limit_usd > 0 ? (projected - b.monthly_limit_usd) / b.monthly_limit_usd : 0;

    if (overrunPct > 0.2) {
      const tier = `burnrate-${month}`;
      const already = await hasFired(b.id, month, tier, db);
      if (already) continue;
      try {
        await fireOnce(db, "budget_alert_state", { budget_id: b.id, month, tier }, () =>
          deliverAlert(
            `:fire: Burn-rate alert - *${b.scope_type}:${b.scope_value}* is on pace to spend ~$${projected.toFixed(2)} this month, ${Math.round(overrunPct * 100)}% over its $${b.monthly_limit_usd} budget.`,
            "budget",
            db
          )
        );
      } catch (err) {
        logger.error("Burn-rate alert delivery failed - will retry on next check", {
          budgetId: b.id,
          error: err.message,
        });
      }
    }
  }
}

module.exports = { checkBudgetAlerts, checkBurnRate };
