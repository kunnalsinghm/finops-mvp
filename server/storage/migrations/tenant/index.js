// The ordered list of migrations for every TENANT schema (multi-tenant mode,
// Postgres only). Same rules as ../README.md: append, never reorder, renumber
// or edit an applied one (its source is checksummed per schema).
//
// Version 1 is the frozen baseline: schema.tenant.js as it stood when tenant
// schemas became versioned. Do not edit schema.tenant.js again; add a numbered
// file here instead. A new tenant is the baseline plus every migration below,
// and an existing tenant runs only the ones it has not recorded.
//
// Each migration only needs `up.postgres`; there is no SQLite tenant schema.
// A change that also affects single-tenant needs a migration in ../index.js
// too; test/tenantMigrations.test.js (PARITY) fails if the two diverge.
module.exports = [
  require("./0002_usage_event_id"),
];
