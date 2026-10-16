// 0013 - invites: pending/accepted/revoked "invite a teammate" records
// (single-tenant mode; see server/invites.js and routes/invites.js).
//
// Only a HASH of each invite token is stored (sha256, see tokenHash.js), never
// the raw token - the raw token exists only in the emailed link and in the
// request that redeems it, same reasoning as users.reset_token_hash (0010).
//
// One row per invitation, never deleted by the app: accepted_at / revoked_at
// record how it ended, which keeps an audit trail and makes "single use"
// enforceable with one atomic conditional UPDATE. `email` is stored normalised
// (trimmed, lower-case); it is deliberately NOT unique - re-inviting an address
// supersedes the older pending invite in application code rather than failing.
//
// Multi-tenant mode keeps its own copy of this table, with a tenant_id column,
// in the control-plane schema (schema.controlPlane.js) - that schema is not
// migrated by this system.
//
// Idempotent, additive-only - same pattern as every migration before this.

module.exports = {
  version: 13,
  name: "invites",
  up: {
    sqlite(db) {
      if (!db.tableExists("invites")) {
        db.exec(`
          CREATE TABLE invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            role TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            invited_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            accepted_at TEXT,
            revoked_at TEXT
          )
        `);
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email)");
    },
    async postgres(db) {
      if (!(await db.tableExists("invites"))) {
        await db.exec(`
          CREATE TABLE invites (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            role TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            invited_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            accepted_at TEXT,
            revoked_at TEXT
          )
        `);
      }
      await db.exec("CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email)");
    },
  },
};
