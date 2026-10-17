// 0002 - record each tenant's schema version and last migration error on the
// control-plane `tenants` row.
//
// WHY: tenant schemas are migrated lazily (when a tenant is first opened) and by
// `npm run migrate-tenants`. Without a record, "which tenants are behind, and why
// did tenant 37 fail" lives only in a terminal or a log line. These columns are
// written by both paths (tenancy.js recordSchemaStatus; best effort, never fails
// a request) and are what an operator console (H4) will read.
//
// Additive and nullable, so an older build keeps working: it never selects them
// by name, and SELECT * callers just see extra fields.
module.exports = {
  version: 2,
  name: "tenants_schema_status",
  up: {
    async postgres(db) {
      await db.exec("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS schema_version INTEGER");
      await db.exec("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS schema_migration_error TEXT");
      await db.exec("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS schema_migration_error_at TEXT");
    },
  },
};
