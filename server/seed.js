// seed.js - populates sample usage events so you can see the dashboard working immediately.
// Run with: npm run seed

const db = require("./db");
const { computeCost } = require("./pricing");

const teams = ["growth", "platform", "research", null]; // null -> untagged, on purpose
const envs = ["prod", "staging", null];
const combos = [
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "anthropic", model: "claude-sonnet" },
  { provider: "anthropic", model: "claude-haiku" },
  { provider: "bedrock", model: "titan-text-express" },
];

const insert = db.prepare(`
  INSERT INTO usage_events
    (event_time, provider, model, team, environment, git_branch, user_id,
     input_tokens, output_tokens, cost_usd, tagged, raw_json)
  VALUES
    (@event_time, @provider, @model, @team, @environment, @git_branch, @user_id,
     @input_tokens, @output_tokens, @cost_usd, @tagged, @raw_json)
`);

function insertMany(rows) {
  db.exec("BEGIN");
  try {
    for (const r of rows) insert.run(r);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function randDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(Math.floor(Math.random() * 24));
  return d.toISOString();
}

const rows = [];
for (let day = 13; day >= 0; day--) {
  const eventsToday = 20 + Math.floor(Math.random() * 40);
  for (let i = 0; i < eventsToday; i++) {
    const combo = combos[Math.floor(Math.random() * combos.length)];
    const team = teams[Math.floor(Math.random() * teams.length)];
    const environment = envs[Math.floor(Math.random() * envs.length)];
    const input_tokens = 200 + Math.floor(Math.random() * 3000);
    const output_tokens = 100 + Math.floor(Math.random() * 1500);
    const { cost_usd } = computeCost({ ...combo, input_tokens, output_tokens });

    rows.push({
      event_time: randDate(day),
      provider: combo.provider,
      model: combo.model,
      team,
      environment,
      git_branch: "main",
      user_id: `user_${Math.floor(Math.random() * 8)}`,
      input_tokens,
      output_tokens,
      cost_usd: cost_usd ?? 0,
      tagged: team && environment ? 1 : 0,
      raw_json: "{}",
    });
  }
}

insertMany(rows);

// Sample budgets
db.prepare("DELETE FROM budgets").run();
db.prepare("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?)").run(
  "team", "growth", 50
);
db.prepare("INSERT INTO budgets (scope_type, scope_value, monthly_limit_usd) VALUES (?, ?, ?)").run(
  "team", "platform", 100
);

console.log(`Seeded ${rows.length} usage events and 2 sample budgets.`);