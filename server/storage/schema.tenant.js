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
  key_id TEXT,
  feature_id TEXT,
  customer_id TEXT,
  project_id TEXT,
  cost_center TEXT,
  client_region TEXT,
  agent_id TEXT,
  session_id TEXT,
  task_id TEXT,
  task_status TEXT,
  workload_type TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL,
  tagged INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_team ON usage_events(team);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(event_time);
CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage_events(provider, model);
CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_events(feature_id);
CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_cost_center ON usage_events(cost_center);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_events(task_id);

CREATE TABLE IF NOT EXISTS gpu_usage_events (
  id SERIAL PRIMARY KEY,
  event_time TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  gpu_type TEXT,
  utilization_pct DOUBLE PRECISION,
  cost_usd DOUBLE PRECISION NOT NULL,
  team TEXT,
  shared_across_teams TEXT,
  received_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE INDEX IF NOT EXISTS idx_gpu_time ON gpu_usage_events(event_time);
CREATE INDEX IF NOT EXISTS idx_gpu_team ON gpu_usage_events(team);

CREATE TABLE IF NOT EXISTS tool_calls (
  id SERIAL PRIMARY KEY,
  event_time TEXT NOT NULL DEFAULT NOW()::text,
  agent_id TEXT,
  session_id TEXT,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  target TEXT,
  region TEXT,
  risk_level TEXT NOT NULL DEFAULT 'low',
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_reasons TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_toolcalls_agent ON tool_calls(agent_id);
CREATE INDEX IF NOT EXISTS idx_toolcalls_time ON tool_calls(event_time);
CREATE INDEX IF NOT EXISTS idx_toolcalls_flagged ON tool_calls(flagged);

CREATE TABLE IF NOT EXISTS tag_inferences (
  usage_event_id INTEGER PRIMARY KEY,
  inferred_team TEXT,
  confidence DOUBLE PRECISION NOT NULL,
  basis TEXT NOT NULL,
  corrected_team TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS region_allowlist (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  region TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE(scope_type, scope_value, region)
);

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  monthly_limit_usd DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS tag_rules (
  id SERIAL PRIMARY KEY,
  api_key_prefix TEXT NOT NULL,
  team TEXT,
  environment TEXT,
  project_id TEXT,
  cost_center TEXT,
  customer_id TEXT,
  feature_id TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);
CREATE INDEX IF NOT EXISTS idx_tag_rules_prefix ON tag_rules(api_key_prefix);

CREATE TABLE IF NOT EXISTS anomaly_alert_state (
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  period TEXT NOT NULL,
  anomaly_type TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT NOW()::text,
  PRIMARY KEY (scope_type, scope_value, period, anomaly_type)
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

CREATE TABLE IF NOT EXISTS commitments (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  initial_amount_usd DOUBLE PRECISION NOT NULL,
  starts_at TEXT NOT NULL DEFAULT NOW()::text,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS commitment_alert_state (
  commitment_id INTEGER NOT NULL,
  tier TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT NOW()::text,
  PRIMARY KEY (commitment_id, tier)
);

CREATE TABLE IF NOT EXISTS weekly_briefing_state (
  week_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete',
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  updated_at TEXT NOT NULL DEFAULT NOW()::text
);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS key_id TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_center TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_events(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_cost_center ON usage_events(cost_center);
`;

// Every table a tenant's own schema contains - used by
// tenantLifecycle.js's exportTenantData to dump a complete tenant export
// without hardcoding the table list a second time in a different file.
// Keep this in sync with the CREATE TABLE statements above (deliberately
// listed once, by hand, rather than introspected from information_schema -
// an explicit list makes it obvious at a glance whether a new table was
// wired into exports, instead of silently picking up anything anyone adds
// to this file later, tenant-data table or not).
const TENANT_TABLES = [
  "usage_events",
  "gpu_usage_events",
  "tool_calls",
  "tag_inferences",
  "region_allowlist",
  "budgets",
  "tag_rules",
  "pricing_overrides",
  "alerts_log",
  "budget_alert_state",
  "reconciliation_rows",
  "audit_log",
  "shadow_comparisons",
  "model_allowlist",
  "token_quotas",
  "commitments",
  "commitment_alert_state",
  "weekly_briefing_state",
  "subscriptions",
];

module.exports = { TENANT_SCHEMA_SQL, TENANT_TABLES };

