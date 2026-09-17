// storage/index.js - picks the active storage backend.
//
// Default is SQLite (free, embedded, zero-config - the self-hosted single-
// team use case this project started from). Set FINOPS_DB_DRIVER=postgres
// and FINOPS_POSTGRES_URL to opt into Postgres, which is what a hosted/
// multi-tenant deployment would use. See the migration plan doc
// (postgres-multitenant-migration-plan.md) for the full reasoning on why
// both backends are kept rather than migrating wholesale.
//
// Every module in this codebase should require THIS file, never
// storage/sqlite.js or storage/postgres.js directly - that's what makes the
// backend swap actually invisible to route/module code.

const driver = process.env.FINOPS_DB_DRIVER === "postgres" ? "postgres" : "sqlite";

module.exports = require(`./${driver}`);
