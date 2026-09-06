// forecast.js - simple moving-average spend forecasting. No ML, no external
// forecasting API - a straight projection from recent daily spend, extended
// forward. Answers "roughly how much will we spend over the next N days at
// this rate" - explicitly not a sophisticated seasonal/trend model.
//
// DESIGN DECISIONS:
//   - Uses a simple N-day moving average of daily spend (default lookback:
//     7 days) as the projected daily run-rate, then multiplies out to the
//     requested horizon. Deliberately NOT linear regression or anything
//     trend-aware - with typically sparse/bursty daily usage data, a more
//     "sophisticated" model would likely just be overfitting noise rather
//     than adding real signal. A plain average is honest about what it is.
//   - Refuses to forecast (returns null) with fewer than MIN_DAYS_FOR_FORECAST
//     days of data, rather than returning a number built on 1-2 noisy days
//     that would look falsely precise.
//   - Ignores day-of-week effects and trends entirely - see the caveat
//     string returned alongside every forecast, which is meant to travel
//     with the number wherever it's displayed, not just live in this file.

const db = require("./db");

const MIN_DAYS_FOR_FORECAST = 3;

function getDailySpend({ days = 30 } = {}) {
  return db
    .prepare(
      `SELECT date(event_time) AS day, ROUND(SUM(cost_usd), 4) AS cost
       FROM usage_events
       WHERE event_time >= datetime('now', ?)
       GROUP BY date(event_time)
       ORDER BY day ASC`
    )
    .all(`-${days} days`);
}

// Returns null if there isn't enough data yet to forecast responsibly,
// otherwise a forecast object with the projection and its own caveat text.
function forecastSpend({ lookbackDays = 7, horizonDays = 30 } = {}) {
  const daily = getDailySpend({ days: lookbackDays });

  if (daily.length < MIN_DAYS_FOR_FORECAST) {
    return null;
  }

  const total = daily.reduce((sum, d) => sum + (d.cost || 0), 0);
  const avgDailySpend = total / daily.length;
  const projectedTotal = avgDailySpend * horizonDays;

  return {
    lookback_days: lookbackDays,
    days_with_data: daily.length,
    avg_daily_spend_usd: Math.round(avgDailySpend * 10000) / 10000,
    horizon_days: horizonDays,
    projected_spend_usd: Math.round(projectedTotal * 100) / 100,
    method: "simple-moving-average",
    caveat:
      "Straight average of recent daily spend, extended forward - ignores trends, seasonality, and day-of-week effects. Treat as a rough order-of-magnitude estimate, not a precise prediction.",
  };
}

module.exports = { forecastSpend, getDailySpend, MIN_DAYS_FOR_FORECAST };
