// storage/schema.sqlite.js - the original SQLite schema, extracted from
// db.js so it lives alongside its Postgres counterpart (schema.postgres.js)
// and the two can be kept visibly in sync. See that file's header comment
// for the specific dialect differences.

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  event_time TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  team TEXT,
  environment TEXT,
  git_branch TEXT,
  user_id TEXT,
  feature_id TEXT,
  customer_id TEXT,
  client_region TEXT,
  agent_id TEXT,
  session_id TEXT,
  task_id TEXT,
  task_status TEXT,
  workload_type TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL,
  tagged INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_team ON usage_events(team);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(event_time);
CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage_events(provider, model);
CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_events(feature_id);
CREATE INDEX IF NOT EXISTS idx_usage_customer ON usage_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_usage_task ON usage_events(task_id);

-- GPU / self-hosted inference cost, ingested separately from API-provider
-- spend in usage_events (see gpuUsage.js for why a blended view is
-- computed at query time rather than by writing GPU rows into
-- usage_events itself - the two have genuinely different natural units).
CREATE TABLE IF NOT EXISTS gpu_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_time TEXT NOT NULL,
  cluster_name TEXT NOT NULL,
  gpu_type TEXT,
  utilization_pct REAL,
  cost_usd REAL NOT NULL,
  team TEXT,
  shared_across_teams TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gpu_time ON gpu_usage_events(event_time);
CREATE INDEX IF NOT EXISTS idx_gpu_team ON gpu_usage_events(team);

-- Agent tool-call audit trail (file access, API calls, command execution) -
-- distinct from usage_events, which is LLM completions only. See
-- toolCallGovernance.js.
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_time TEXT NOT NULL DEFAULT (datetime('now')),
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

-- Smart/inferred tagging: for an untagged event, a best-guess team +
-- confidence score, kept SEPARATE from the real 'team' column on
-- usage_events so an inference can never be mistaken for a real tag (see
-- smartTagging.js). corrected_team, when set, is the feedback signal used
-- to improve future inference for that key.
CREATE TABLE IF NOT EXISTS tag_inferences (
  usage_event_id INTEGER PRIMARY KEY,
  inferred_team TEXT,
  confidence REAL NOT NULL,
  basis TEXT NOT NULL,
  corrected_team TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Data-residency policy: which regions are approved. A key/team with no
-- row here is unrestricted (same "opt-in allow-list" pattern as
-- model_allowlist/token_quotas elsewhere in this codebase).
CREATE TABLE IF NOT EXISTS region_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  region TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_value, region)
);

CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  initial_amount_usd REAL NOT NULL,
  starts_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commitment_alert_state (
  commitment_id INTEGER NOT NULL,
  tier TEXT NOT NULL,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (commitment_id, tier)
);

CREATE TABLE IF NOT EXISTS weekly_briefing_state (
  week_key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'incomplete',
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,       -- 'team' | 'project' | 'key'
  scope_value TEXT NOT NULL,
  monthly_limit_usd REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pricing_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_per_1k REAL NOT NULL,
  output_per_1k REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, model)
);

-- API keys for auth + RBAC + quarantine status
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL UNIQUE,        -- the actual key string clients send
  label TEXT NOT NULL,                -- human-friendly name
  role TEXT NOT NULL DEFAULT 'developer', -- admin | budget-manager | developer | viewer
  team TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | quarantined | revoked
  quarantine_reason TEXT,
  allow_background INTEGER NOT NULL DEFAULT 0, -- 1 = may send X-Workload-Type: background (budget-exempt); admin-granted, see keyIdentity.js
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Alerts log (progressive budget alerts, quarantine events, anomalies)
CREATE TABLE IF NOT EXISTS alerts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged INTEGER NOT NULL DEFAULT 0
);

-- Budget alert tier tracking (so we only fire each threshold once per month)
CREATE TABLE IF NOT EXISTS budget_alert_state (
  budget_id INTEGER NOT NULL,
  month TEXT NOT NULL,      -- 'YYYY-MM'
  tier TEXT NOT NULL,       -- '50%' | '80%' | '90%' | 'exceeded'
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (budget_id, month, tier)
);

-- Human users for session-based dashboard login (separate from API keys,
-- which are for programmatic/proxy access)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reconciliation imports: provider billing exports uploaded for shadow-spend detection
CREATE TABLE IF NOT EXISTS reconciliation_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- 'YYYY-MM-DD'
  provider TEXT NOT NULL,
  reported_cost_usd REAL NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Immutable audit trail for config changes (distinct from alerts_log, which
-- is system-generated: budget thresholds, circuit breaker triggers)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shadow A/B test results: when a proxy request opts in (X-Enable-Shadow-Test),
-- the same prompt is also sent to a cheaper same-provider alternative model
-- (see modelAlternatives.js) AFTER the real response is already returned to
-- the client, purely for evaluation. Costs here are real (both models were
-- actually called) but are intentionally NOT written to usage_events/budgets -
-- this is evaluation traffic the operator chose to run, not production spend,
-- and mixing the two would distort dashboards and could trip budget alerts
-- for a test the operator initiated.
CREATE TABLE IF NOT EXISTS shadow_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  provider TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  shadow_model TEXT NOT NULL,
  team TEXT,
  primary_cost_usd REAL NOT NULL,
  shadow_cost_usd REAL,
  similarity REAL,
  primary_length INTEGER,
  shadow_length INTEGER,
  length_delta_pct REAL,
  shadow_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_shadow_pair ON shadow_comparisons(provider, primary_model, shadow_model);
CREATE INDEX IF NOT EXISTS idx_shadow_time ON shadow_comparisons(created_at);

-- Model allow-listing: restrict specific teams/keys to a pre-approved list
-- of models. A key/team with zero rows here is UNRESTRICTED - this is an
-- opt-in allow-list, not a default-deny system. See modelAllowlist.js for
-- full enforcement logic (most-specific-wins between key and team scope).
CREATE TABLE IF NOT EXISTS model_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,   -- 'key' | 'team'
  scope_value TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_value, provider, model)
);

CREATE INDEX IF NOT EXISTS idx_allowlist_scope ON model_allowlist(scope_type, scope_value);

-- Token quotas: cap raw input+output TOKEN consumption (not request count,
-- not dollar cost) per key/team over a daily or weekly calendar window.
-- A key/team with zero rows here is UNRESTRICTED. A key/team can have both
-- a daily AND a weekly row simultaneously - exceeding either blocks.
-- See tokenQuota.js for full enforcement logic (most-specific-wins between
-- key and team scope, same as model_allowlist).
CREATE TABLE IF NOT EXISTS token_quotas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,   -- 'key' | 'team'
  scope_value TEXT NOT NULL,
  period TEXT NOT NULL,       -- 'daily' | 'weekly'
  token_limit INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_value, period)
);

CREATE INDEX IF NOT EXISTS idx_token_quota_scope ON token_quotas(scope_type, scope_value);
`;

module.exports = { SCHEMA_SQL };
