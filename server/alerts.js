// alerts.js - Progressive alerts (50/80/90/100%) + burn-rate alerts, delivered
// to Slack via an Incoming Webhook (free Slack feature - no paid plan needed).
// Falls back to logging only if no webhook URL is configured.

const db = require("./db");
const { logAlert } = require("./governance");

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

async function sendSlack(message) {
  logAlert("budget", message); // always log locally regardless of Slack config

  if (!SLACK_WEBHOOK_URL) return; // no-op if not configured - see .env.example

  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch (err) {
    console.error("Failed to deliver Slack alert:", err.message);
  }
}

const hasFiredStmt = db.prepare(
  "SELECT 1 FROM budget_alert_state WHERE budget_id = ? AND month = ? AND tier = ?"
);
const markFiredStmt = db.prepare(
  "INSERT OR IGNORE INTO budget_alert_state (budget_id, month, tier) VALUES (?, ?, ?)"
);

// Call this periodically (e.g. from a cron, or after each ingest) to check
// budgets and fire alerts exactly once per threshold per month.
async function checkBudgetAlerts() {
  const budgets = db.prepare("SELECT * FROM budgets").all();
  const month = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events
         WHERE ${col} = ? AND strftime('%Y-%m', event_time) = ?`
      )
      .get(b.scope_value, month);

    const pct = b.monthly_limit_usd > 0 ? spend.spend / b.monthly_limit_usd : 0;
    const crossedTiers = [];
    if (pct >= 0.5) crossedTiers.push("50%");
    if (pct >= 0.8) crossedTiers.push("80%");
    if (pct >= 0.9) crossedTiers.push("90%");
    if (pct >= 1.0) crossedTiers.push("exceeded");

    for (const tier of crossedTiers) {
      const already = hasFiredStmt.get(b.id, month, tier);
      if (already) continue;
      markFiredStmt.run(b.id, month, tier);
      await sendSlack(
        `:warning: Budget alert - *${b.scope_type}:${b.scope_value}* has reached *${tier}* of its $${b.monthly_limit_usd} monthly budget (spent $${spend.spend.toFixed(2)}).`
      );
    }
  }
}

// Burn-rate alert: flags if current daily pace implies >20% budget overrun by month end
async function checkBurnRate() {
  const budgets = db.prepare("SELECT * FROM budgets").all();
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const month = now.toISOString().slice(0, 7);

  for (const b of budgets) {
    const col = b.scope_type === "team" ? "team" : b.scope_type === "key" ? "user_id" : "environment";
    const spend = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM usage_events
         WHERE ${col} = ? AND strftime('%Y-%m', event_time) = ?`
      )
      .get(b.scope_value, month);

    const projected = (spend.spend / dayOfMonth) * daysInMonth;
    const overrunPct = b.monthly_limit_usd > 0 ? (projected - b.monthly_limit_usd) / b.monthly_limit_usd : 0;

    if (overrunPct > 0.2) {
      const tier = `burnrate-${month}`;
      const already = hasFiredStmt.get(b.id, month, tier);
      if (already) continue;
      markFiredStmt.run(b.id, month, tier);
      await sendSlack(
        `:fire: Burn-rate alert - *${b.scope_type}:${b.scope_value}* is on pace to spend ~$${projected.toFixed(2)} this month, ${Math.round(overrunPct * 100)}% over its $${b.monthly_limit_usd} budget.`
      );
    }
  }
}

module.exports = { checkBudgetAlerts, checkBurnRate, sendSlack };