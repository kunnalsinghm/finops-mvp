// storage/schemaRunner.js - runs the migrator against a multi-tenant schema.
//
// The single-tenant database is migrated from storage/postgres.js. The two
// multi-tenant kinds of schema (one per tenant, and the shared control plane)
// are created lazily by tenancy.js, so this is called from there, right after
// the baseline script, on a pool whose search_path points at that schema. The
// migrator already scopes its bookkeeping table and its advisory lock by
// current_schema(), so every schema is versioned, checksummed, ordered and
// locked independently of every other one.
//
// An existing schema created before versioning has no schema_migrations table:
// the migrator records the baseline row and applies only what is newer.

const migrator = require("./migrator");

const KINDS = {
  tenant: { list: () => require("./migrations/tenant") },
  controlPlane: { list: () => require("./migrations/controlPlane") },
};

function migrateSchema(pool, kind, opts = {}) {
  const entry = KINDS[kind];
  if (!entry) throw new Error(`Unknown schema kind '${kind}' (expected 'tenant' or 'controlPlane')`);
  return migrator.runPostgres(pool, {
    migrations: entry.list(),
    dialects: ["postgres"],
    log: require("../logger"),
    ...opts,
  });
}

// The registered list for a kind, for tooling that plans without applying.
function migrationsFor(kind) {
  const entry = KINDS[kind];
  if (!entry) throw new Error(`Unknown schema kind '${kind}' (expected 'tenant' or 'controlPlane')`);
  return entry.list();
}

// The baseline hook for runPostgres: create the schema, then run its frozen
// version-1 script. runPostgres calls it only for a schema with no
// schema_migrations table yet, under the same lock as the migrations. The name is
// interpolated into DDL, so it is checked here as well as by the callers.
const SAFE_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;
function baselineFor(schema, sql) {
  if (!SAFE_SCHEMA.test(schema)) throw new Error(`Refusing unsafe schema name ${JSON.stringify(schema)}`);
  return async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(sql);
  };
}

module.exports = { migrateSchema, migrationsFor, baselineFor };
