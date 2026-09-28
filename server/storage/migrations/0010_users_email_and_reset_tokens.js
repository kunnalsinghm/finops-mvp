// 0010 - users.email, users.email_verified, users.reset_token_hash/expiry,
// users.verify_token_hash/expiry
//
// P0: self-service "forgot password" + email verification (see users.js's
// requestPasswordReset/resetPasswordWithToken and
// generateEmailVerificationToken/verifyEmailToken, and the parallel
// tenantUsers.js functions for multi-tenant mode).
//
// email is nullable, not required - existing accounts (and any admin-created
// account going forward) may not have one, and a user with no email simply
// can't use self-service reset (there's nowhere to send the link) or
// verification; that's a graceful degradation, not an error state, so
// nothing here backfills or requires it.
//
// Only a HASH of each token is stored (sha256, see tokenHash.js), never the
// raw token - the raw token exists only in the URL emailed to the user and
// in the HTTP request that redeems it. This mirrors why password_hash/salt
// exist instead of a plaintext password column: a DB dump alone must not be
// enough to take over an account via a leaked/logged reset link.
//
// Idempotent, additive-only - same pattern as every migration before this.

module.exports = {
  version: 10,
  name: "users_email_and_reset_tokens",
  up: {
    sqlite(db) {
      const columns = [
        ["email", "TEXT"],
        ["email_verified", "INTEGER NOT NULL DEFAULT 0"],
        ["reset_token_hash", "TEXT"],
        ["reset_token_expires_at", "TEXT"],
        ["verify_token_hash", "TEXT"],
        ["verify_token_expires_at", "TEXT"],
      ];
      for (const [name, def] of columns) {
        if (!db.columnExists("users", name)) {
          db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
        }
      }
    },
    async postgres(db) {
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT");
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER NOT NULL DEFAULT 0");
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash TEXT");
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TEXT");
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_hash TEXT");
      await db.exec("ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires_at TEXT");
    },
  },
};
