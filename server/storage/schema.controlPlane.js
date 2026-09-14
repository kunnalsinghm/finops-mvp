// storage/schema.controlPlane.js - the ONE schema shared across all tenants
// in a multi-tenant (FINOPS_MULTI_TENANT=true) deployment. Lives in its own
// dedicated Postgres schema (FINOPS_CONTROL_PLANE_SCHEMA, default
// "control_plane") - deliberately NOT "public" - so it can never collide
// with a single-tenant deployment's tables if the two ever accidentally
// point at the same physical database.
//
// This holds ONLY identity/routing data: which tenants exist, which schema
// each one's data lives in, and which api_keys/users belong to which
// tenant. A request has to resolve its tenant HERE, in a schema everyone
// can see, before it can even know which tenant schema to look in for
// everything else - so identity data structurally cannot itself be
// tenant-scoped.
//
// Deliberately NOT reused from schema.postgres.js: single-tenant api_keys/
// users have no tenant_id column at all, and adding one there would be a
// breaking schema change to every existing single-tenant Postgres
// deployment (and the 224 tests that assume today's shape). Keeping this
// fully separate means single-tenant mode is byte-for-byte unaffected by
// any of this.

const CONTROL_PLANE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  schema_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  key_id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  team TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  quarantine_reason TEXT,
  created_at TEXT NOT NULL DEFAULT NOW()::text
);

CREATE INDEX IF NOT EXISTS idx_control_plane_keys_tenant ON api_keys(tenant_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT NOW()::text,
  UNIQUE(tenant_id, username)
);
`;
// NOTE: users.username is UNIQUE PER TENANT here (UNIQUE(tenant_id,
// username)), not globally unique like single-tenant mode's users table.
// Two different customers each having someone named "admin" is normal and
// must not collide.

module.exports = { CONTROL_PLANE_SCHEMA_SQL };
