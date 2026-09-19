// test/keyIdentity.test.js - the identity/privilege policy, as a pure function.
// No DB, no server: resolveIdentity() takes the key row + the two headers and
// returns a decision, so every rule can be checked directly.
const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveIdentity } = require("../server/keyIdentity");

const noStrict = {}; // env without FINOPS_STRICT_IDENTITY
const strict = { FINOPS_STRICT_IDENTITY: "true" };

test("a key bound to a team is authoritative when no X-Team header is sent", () => {
  const r = resolveIdentity({ key_id: "k", team: "finance" }, {}, noStrict);
  assert.equal(r.ok, true);
  assert.equal(r.team, "finance");
  assert.equal(r.teamSource, "key");
});

test("a bound key may repeat its own team in X-Team (harmless, keeps existing clients working)", () => {
  const r = resolveIdentity({ key_id: "k", team: "finance" }, { teamHeader: "finance" }, noStrict);
  assert.equal(r.ok, true);
  assert.equal(r.team, "finance");
});

test("a bound key claiming a DIFFERENT team is rejected 403, not silently overridden", () => {
  const r = resolveIdentity({ key_id: "k", team: "finance" }, { teamHeader: "marketing" }, noStrict);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "team-mismatch");
});

test("an unbound key falls back to the X-Team header (legacy behaviour) and says so", () => {
  const r = resolveIdentity({ key_id: "k", team: null }, { teamHeader: "growth" }, noStrict);
  assert.equal(r.ok, true);
  assert.equal(r.team, "growth");
  assert.equal(r.teamSource, "header");
});

test("an unbound key with no header has no team (nothing to enforce against - documented gap)", () => {
  const r = resolveIdentity({ key_id: "k", team: null }, {}, noStrict);
  assert.equal(r.ok, true);
  assert.equal(r.team, null);
  assert.equal(r.teamSource, "none");
});

test("strict mode: an unbound key is refused, with or without a header", () => {
  for (const headers of [{}, { teamHeader: "growth" }]) {
    const r = resolveIdentity({ key_id: "k", team: null }, headers, strict);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, "key-not-bound");
  }
});

test("strict mode: a bound key still works, and bootstrap mode is exempt so first-run setup isn't bricked", () => {
  assert.equal(resolveIdentity({ key_id: "k", team: "finance" }, {}, strict).ok, true);
  assert.equal(resolveIdentity({ key_id: "bootstrap" }, {}, strict).ok, true);
});

test("background: refused for a key that was not granted it", () => {
  for (const key of [{ key_id: "k", allow_background: 0 }, { key_id: "k" }, { key_id: "k", allow_background: null }]) {
    const r = resolveIdentity(key, { workloadHeader: "background" }, noStrict);
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.code, "background-not-permitted");
  }
});

test("background: honoured (and exempt) for a key granted it - accepts 1, true and '1' from either DB backend", () => {
  for (const v of [1, true, "1"]) {
    const r = resolveIdentity({ key_id: "k", team: "ops", allow_background: v }, { workloadHeader: "background" }, noStrict);
    assert.equal(r.ok, true);
    assert.equal(r.backgroundExempt, true);
    assert.equal(r.workloadType, "background");
  }
});

test("background: bootstrap mode may use it (everything is already open before the first key exists)", () => {
  const r = resolveIdentity({ key_id: "bootstrap" }, { workloadHeader: "background" }, noStrict);
  assert.equal(r.ok, true);
  assert.equal(r.backgroundExempt, true);
});

test("other X-Workload-Type values are free-form labels: recorded, but never exempt from anything", () => {
  const r = resolveIdentity({ key_id: "k" }, { workloadHeader: "interactive" }, noStrict);
  assert.equal(r.ok, true);
  assert.equal(r.workloadType, "interactive");
  assert.equal(r.backgroundExempt, false);
});

test("team and workload rules compose: a mismatched team is refused before background is even considered", () => {
  const r = resolveIdentity(
    { key_id: "k", team: "finance", allow_background: 1 },
    { teamHeader: "other", workloadHeader: "background" },
    noStrict
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "team-mismatch");
});
