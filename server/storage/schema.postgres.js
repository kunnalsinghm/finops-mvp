// storage/schema.postgres.js - Postgres translation of the SQLite schema in
// storage/schema.sqlite.js. Keep these two files structurally in sync: same
// tables, same columns, same indexes, in the same order - only the dialect-
// specific type/keyword syntax differs. See the comment block at the top of
// schema.sqlite.js for the full column-by-column rationale; this file only
// documents what's DIFFERENT here:
//
//   - INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
//   - REAL -> DOUBLE PRECISION (matches SQLite's REAL, which is always
//     8-byte regardless of declared width; NUMERIC would be more correct
//     for currency but is a bigger change, tracked as a future improvement,
//     not part of this migration)
//   - All date/time columns stay TEXT (ISO 8601 strings), NOT native
//     TIMESTAMPTZ - deliberate compatibility choice so every existing
//     `new Date().toISOString()` call site and every dialectSql.js helper
//     keeps working unchanged against either backend. A future pass could
//     move these to real TIMESTAMPTZ columns for proper native date
//     querying, but that's a separate, larger change than this migration.
//   - DEFAULT (datetime('now')) -> DEFAULT NOW()::text (keeps the stored
//     value a plain ISO-ish string default, consistent with the TEXT
//     column type above)

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id SERIAL PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT NOW()::text,
  event_time TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  team TEXT,
  environment TEXT,
  git_branch TEXT,
  user_id TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL,
  tagged INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_team ON usage_events(team);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(event_time);
CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage_events(provider, model);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  monthly_limit_usd DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS pricing_overrides (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_1k DOUBLE PRECISION NOT NULL,
  output_per_1k DOUBLE PRECISION NOT NULL,
  updated_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE(provider, model)
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  key_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  team TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  quarantine_reason TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS alerts_log (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_alert_state (
  budget_id INTEGER NOT NULL,
  month TEXT NOT NULL,
  tier TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT NOW()::text,
  PRIMARY KEY (budget_id, month, tier)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS reconciliation_rows (
  id SERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  reported_cost_usd DOUBLE PRECISION NOT NULL,
  imported_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS shadow_comparisons (
  id SERIAL PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  shadow_model TEXT NOT NULL,
  team TEXT,
  primary_cost_usd DOUBLE PRECISION NOT NULL,
  shadow_cost_usd DOUBLE PRECISION,
  similarity DOUBLE PRECISION,
  primary_length INTEGER,
  shadow_length INTEGER,
  length_delta_pct DOUBLE PRECISION,
  shadow_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_shadow_pair ON shadow_comparisons(provider, primary_model, shadow_model);
CREATE INDEX IF NOT EXISTS idx_shadow_time ON shadow_comparisons(created_at);

CREATE TABLE IF NOT EXISTS model_allowlist (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE(scope_type, scope_value, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_allowlist_scope ON model_allowlist(scope_type, scope_value);

CREATE TABLE IF NOT EXISTS token_quotas (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  period TEXT NOT NULL,
  token_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE(scope_type, scope_value, period)
);

CREATE INDEX IF NOT EXISTS idx_token_quota_scope ON token_quotas(scope_type, scope_value);
`;

module.exports = { SCHEMA_SQL };
