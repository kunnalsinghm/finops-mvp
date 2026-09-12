// test/sso.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// Sweep any leftover .tmp-sso-*.db* files from a PREVIOUS run of this file
// that never got a chance to clean up (e.g. Ctrl+C, a crashed process, a
// killed terminal) - test.after() below only runs on a normal exit, so an
// interrupted run leaves orphaned temp DB files behind indefinitely
// otherwise. Doing this at startup, not just teardown, means the next run
// cleans up after the last one even if that one never got the chance to.
for (const f of fs.readdirSync(__dirname)) {
  if (/^\.tmp-sso-\d+\.db/.test(f)) {
    try { fs.unlinkSync(path.join(__dirname, f)); } catch {}
  }
}

process.env.FINOPS_DB_PATH = path.join(__dirname, `.tmp-sso-${process.pid}.db`);
const dbPath = process.env.FINOPS_DB_PATH;

// Gives this test file its own disposable Postgres schema (when running
// against Postgres) instead of sharing "public" with every other test
// file - the same kind of isolation SQLite gets for free via the unique
// file above. Only takes effect if FINOPS_DB_DRIVER=postgres is already
// set in the environment; harmless no-op otherwise.
const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";
if (isPostgres) {
  process.env.FINOPS_POSTGRES_SCHEMA = `test_sso_${process.pid}`;
}

const ORIGINAL_ENV = {
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET: process.env.OIDC_CLIENT_SECRET,
  OIDC_REDIRECT_URI: process.env.OIDC_REDIRECT_URI,
};
process.env.OIDC_ISSUER = "https://idp.test";
process.env.OIDC_CLIENT_ID = "test-client-id";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";
process.env.OIDC_REDIRECT_URI = "http://localhost:4000/api/sso/callback";

const db = require("../server/db");
const storage = require("../server/storage");

test.after(async () => {
  if (isPostgres && storage.schemaName) {
    try {
      await storage.pool.query(`DROP SCHEMA IF EXISTS ${storage.schemaName} CASCADE`);
    } catch (err) {
      console.warn(`[sso.test.js] Failed to drop test schema: ${err.message}`);
    }
    await storage.pool.end();
  }
  try { db.close(); } catch {}
  for (const suffix of ["", "-shm", "-wal"]) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const {
  isConfigured,
  getDiscoveryDocument,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  decodeIdTokenUnsafe,
  validateState,
  loginOrProvisionSsoUser,
} = require("../server/sso");

const fakeDiscoveryDoc = {
  authorization_endpoint: "https://idp.test/authorize",
  token_endpoint: "https://idp.test/token",
};

function fakeIdToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fake-signature`;
}

test("isConfigured is true when all three OIDC env vars are set", () => {
  assert.equal(isConfigured(), true);
});

test("isConfigured is false when a required env var is missing", () => {
  const saved = process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_CLIENT_SECRET;
  assert.equal(isConfigured(), false);
  process.env.OIDC_CLIENT_SECRET = saved;
});

test("getDiscoveryDocument fetches and parses the well-known OIDC document", async (t) => {
  t.mock.method(global, "fetch", async (url) => {
    assert.equal(url, "https://idp.test/.well-known/openid-configuration");
    return { ok: true, json: async () => fakeDiscoveryDoc };
  });

  const doc = await getDiscoveryDocument();
  assert.deepEqual(doc, fakeDiscoveryDoc);
});

test("getDiscoveryDocument throws with the status code when the fetch fails", async (t) => {
  t.mock.method(global, "fetch", async () => ({ ok: false, status: 503 }));
  await assert.rejects(getDiscoveryDocument(), /503/);
});

test("buildAuthorizationUrl includes the required params and a fresh state each call", () => {
  const url1 = buildAuthorizationUrl(fakeDiscoveryDoc);
  const url2 = buildAuthorizationUrl(fakeDiscoveryDoc);

  assert.match(url1, /^https:\/\/idp\.test\/authorize\?/);
  assert.match(url1, /response_type=code/);
  assert.match(url1, /client_id=test-client-id/);
  assert.match(url1, /scope=openid\+profile\+email/);

  const state1 = new URL(url1).searchParams.get("state");
  const state2 = new URL(url2).searchParams.get("state");
  assert.ok(state1);
  assert.notEqual(state1, state2, "each call should generate a distinct state");
});

test("validateState accepts a state that was just issued, and is single-use", () => {
  const url = buildAuthorizationUrl(fakeDiscoveryDoc);
  const state = new URL(url).searchParams.get("state");

  assert.equal(validateState(state), true);
  assert.equal(validateState(state), false, "a state should not validate a second time");
});

test("validateState rejects an unknown state", () => {
  assert.equal(validateState("never-issued-state"), false);
});

test("exchangeCodeForTokens posts the expected form fields and returns the parsed tokens", async (t) => {
  t.mock.method(global, "fetch", async (url, opts) => {
    assert.equal(url, fakeDiscoveryDoc.token_endpoint);
    assert.equal(opts.method, "POST");
    const body = opts.body instanceof URLSearchParams ? opts.body : new URLSearchParams(opts.body);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "auth-code-123");
    assert.equal(body.get("client_id"), "test-client-id");
    assert.equal(body.get("client_secret"), "test-client-secret");
    return { ok: true, json: async () => ({ access_token: "at", id_token: "it" }) };
  });

  const tokens = await exchangeCodeForTokens(fakeDiscoveryDoc, "auth-code-123");
  assert.equal(tokens.access_token, "at");
  assert.equal(tokens.id_token, "it");
});

test("exchangeCodeForTokens throws with the status and body text on a failed exchange", async (t) => {
  t.mock.method(global, "fetch", async () => ({
    ok: false,
    status: 400,
    text: async () => "invalid_grant",
  }));

  await assert.rejects(exchangeCodeForTokens(fakeDiscoveryDoc, "bad-code"), /400/);
});

test("decodeIdTokenUnsafe reads the JWT payload without verifying the signature", () => {
  const token = fakeIdToken({ sub: "user-1", email: "person@example.test" });
  const payload = decodeIdTokenUnsafe(token);
  assert.equal(payload.sub, "user-1");
  assert.equal(payload.email, "person@example.test");
});

test("loginOrProvisionSsoUser provisions a new viewer-role user on first SSO login", async () => {
  const token = await loginOrProvisionSsoUser("newperson@example.test");
  assert.ok(token, "expected a session token to be returned");

  const row = await storage.get("SELECT * FROM users WHERE username = ?", ["newperson@example.test"]);
  assert.ok(row, "expected a user row to be provisioned");
  assert.equal(row.role, "viewer");
});

test("loginOrProvisionSsoUser reuses the existing user on a second login, not creating a duplicate", async () => {
  await loginOrProvisionSsoUser("repeat@example.test");
  await loginOrProvisionSsoUser("repeat@example.test");

  const rows = await storage.all("SELECT * FROM users WHERE username = ?", ["repeat@example.test"]);
  assert.equal(rows.length, 1, "expected exactly one user row, not a duplicate");
});
