// alerts.js - Progressive alerts (50/80/90/100%) + burn-rate alerts, delivered
// to Slack via an Incoming Webhook (free Slack feature - no paid plan needed).
// Falls back to logging only if no webhook URL is configured.
//
// Delivery ordering: an alert is only marked "fired" in budget_alert_state
// AFTER deliverAlert() resolves successfully. If delivery throws (network
// blip, misconfigured webhook, SMTP outage), the tier is left unmarked so
// the next scheduled check retries it, instead of silently losing that
// alert for the rest of the month.

const logger = require("./logger");
const db = require("./storage");
const { yearMonthExpr } = require("./storage/dialectSql");
const { deliverAlert } = require("./alertDelivery");

async function hasFired(budgetId, month, tier) {
  const row = await db.get(
    "SELECT 1 AS found FROM budget_alert_state WHERE budget_id = ? AND month = ? AND tier = ?",
    [budgetId, month, tier]
  );
  return Boolean(row);
}

// "INSERT OR IGNORE" is SQLite-specific syntax. Postgres's equivalent is
// "INSERT ... ON CONFLICT DO NOTHING" - but that requires a matching UNIQUE
// constraint on (budget_id, month, tier) to target, same as the
// pricing_overrides ON CONFLICT clause in pricing.js. Rather than assume
// that constraint exists without checking the schema, do the same
// check-then-insert as hasFired() above; a harmless duplicate insert
// attempt is caught the same way at the call site regardless.
async function markFired(budgetId, month, tier) {
  const already = await hasFired(budgetId, month, tier);
  if (already) return;
  await db.run(
    "INSERT INTO budget_alert_state (budget_id, month, tier) VALUES (?, ?, ?)",
    [budgetId, month, tier]
  );
}

// Call this periodically (e.g. from a cron, or after each ingest) to check
// budgets and fire alerts exactly once per threshold per month.
async function checkBudgetAlerts() {
  const budgets = await db.all("SELECT * FROM budgets");
  const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = await db.get(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events
       WHERE ${col} = ? AND ${yearMonthExpr("event_time")} = ?`,
      [b.scope_value, month]
    );

    const pct = b.monthly_limit_usd > 0 ? spend.spend / b.monthly_limit_usd : 0;
    const crossedTiers = [];
    if (pct >= 0.5) crossedTiers.push("50%");
    if (pct >= 0.8) crossedTiers.push("80%");
    if (pct >= 0.9) crossedTiers.push("90%");
    if (pct >= 1.0) crossedTiers.push("exceeded");

    for (const tier of crossedTiers) {
      const already = await hasFired(b.id, month, tier);
      if (already) continue;
      try {
        await deliverAlert(
          `:warning: Budget alert - *${b.scope_type}:${b.scope_value}* has reached *${tier}* of its $${b.monthly_limit_usd} monthly budget (spent $${spend.spend.toFixed(2)}).`
        );
        await markFired(b.id, month, tier);
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
async function checkBurnRate() {
  const budgets = await db.all("SELECT * FROM budgets");
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const month = now.toISOString().slice(0, 7);

  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = await db.get(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events
       WHERE ${col} = ? AND ${yearMonthExpr("event_time")} = ?`,
      [b.scope_value, month]
    );

    const projected = (spend.spend / dayOfMonth) * daysInMonth;
    const overrunPct = b.monthly_limit_usd > 0 ? (projected - b.monthly_limit_usd) / b.monthly_limit_usd : 0;

    if (overrunPct > 0.2) {
      const tier = `burnrate-${month}`;
      const already = await hasFired(b.id, month, tier);
      if (already) continue;
      try {
        await deliverAlert(
          `:fire: Burn-rate alert - *${b.scope_type}:${b.scope_value}* is on pace to spend ~$${projected.toFixed(2)} this month, ${Math.round(overrunPct * 100)}% over its $${b.monthly_limit_usd} budget.`
        );
        await markFired(b.id, month, tier);
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
