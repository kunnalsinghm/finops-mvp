// db.js - SQLite storage layer (free, embedded, zero-config).
// Uses Node's BUILT-IN node:sqlite module (no native compilation, no Visual
// Studio Build Tools needed on Windows - it ships inside Node itself since
// Node 22.5+). Swap this module out later for Postgres/ClickHouse without
// touching route logic much, since all access goes through the functions
// exported here and the .prepare/.run/.get/.all API is very similar.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.FINOPS_DB_PATH || path.join(DATA_DIR, "finops.db");
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
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
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL NOT NULL,
  tagged INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_team ON usage_events(team);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_events(event_time);
CREATE INDEX IF NOT EXISTS idx_usage_provider_model ON usage_events(provider, model);

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
`);

module.exports = db;
