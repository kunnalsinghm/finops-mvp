// storage/schema.tenant.js - applied to EVERY tenant's own private schema in
// a multi-tenant (FINOPS_MULTI_TENANT=true) deployment.
//
// Deliberately just the api_keys/users/sessions-free subset of
// schema.postgres.js's SCHEMA_SQL, copied verbatim otherwise - every other
// table (usage_events, budgets, alerts, audit log, etc.) keeps the exact
// same columns/indexes/constraints that are already tested against in
// single-tenant mode, just applied per-tenant instead of once globally.
// Keep this in sync with schema.postgres.js for anything that isn't
// api_keys/users: if a column is added there, it almost certainly needs to
// be added here too.

const TENANT_SCHEMA_SQL = `
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

module.exports = { TENANT_SCHEMA_SQL };
