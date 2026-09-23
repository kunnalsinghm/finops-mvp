// routes/keys.js - create/list/quarantine/revoke API keys

const express = require("express");
const crypto = require("crypto");
const { requireAuth } = require("../auth");
const { quarantineKey, approveKey } = require("../governance");
const { logAudit } = require("../audit");
const tenancy = require("../tenancy");
const router = express.Router();

const KEY_COLUMNS = "id, key_id, label, role, team, allow_background, status, quarantine_reason, created_at";

function generateKey() {
  return "fk_" + crypto.randomBytes(20).toString("hex");
}

router.get("/", requireAuth("read"), async (req, res) => {
  // Multi-tenant mode: api_keys lives in the shared control-plane schema,
  // so this MUST filter by tenant_id - without this WHERE clause every
  // tenant could list every other tenant's keys (a real bug caught by
  // test/multiTenantIsolation.test.js, not a hypothetical one). Single-
  // tenant mode has no tenant_id column at all, so it lists everything,
  // same as always.
  const rows = tenancy.MULTI_TENANT
    ? await req.controlPlaneDb.all(
        `SELECT ${KEY_COLUMNS} FROM api_keys WHERE tenant_id = ? ORDER BY id DESC`,
        [req.tenantId]
      )
    : await req.controlPlaneDb.all(
        `SELECT ${KEY_COLUMNS} FROM api_keys ORDER BY id DESC`
      );
  res.json(rows);
});

router.post("/", requireAuth("manage_keys"), async (req, res) => {
  const { label, role = "developer", team, allow_background = false } = req.body || {};
  if (!label) return res.status(400).json({ error: "label is required" });
  if (typeof allow_background !== "boolean") {
    return res.status(400).json({ error: "allow_background must be true or false" });
  }
  if (!["admin", "budget-manager", "developer", "viewer"].includes(role)) {
    return res.status(400).json({ error: "invalid role" });
  }

  // Multi-tenant mode: go through tenancy.js's own key-creation path, which
  // sets tenant_id correctly on the new row - a raw INSERT here would create
  // a key resolveTenantApiKey() could never route anywhere, since it joins
  // api_keys to tenants on tenant_id. Single-tenant mode has no tenant_id
  // column at all, so it keeps the original direct INSERT.
  if (tenancy.MULTI_TENANT) {
    const created = await tenancy.createTenantApiKey({ tenant_id: req.tenantId, label, role, team, allow_background });
    await logAudit(req.apiKey.key_id, "key.create", created.key_id, { role, team: team || null, allow_background }, req.db);
    return res.status(201).json(created);
  }

  const key_id = generateKey();
  await req.controlPlaneDb.run("INSERT INTO api_keys (key_id, label, role, team, allow_background) VALUES (?, ?, ?, ?, ?)", [
    key_id,
    label,
    role,
    team || null,
    allow_background ? 1 : 0,
  ]);

  // key_id is only ever shown here at creation time - treat it like a password
  res.status(201).json({ key_id, label, role, team, allow_background });
});

// Every mutation below (quarantine/approve/revoke) targets a key by ID
// supplied in the URL - in multi-tenant mode that MUST be checked against
// req.tenantId before doing anything, or any authenticated tenant could
// quarantine/approve/revoke ANY OTHER tenant's key just by guessing or
// enumerating key_id values. assertOwnsKey throws a 404 (not 403) so this
// doesn't even confirm a key with that id exists to a caller who doesn't
// own it.
async function assertOwnsKey(req, keyId) {
  if (!tenancy.MULTI_TENANT) return; // single-tenant: no cross-tenant concept to violate
  const row = await req.controlPlaneDb.get("SELECT tenant_id FROM api_keys WHERE key_id = ?", [keyId]);
  if (!row || row.tenant_id !== req.tenantId) {
    const err = new Error("No key with that id in this tenant");
    err.statusCode = 404;
    throw err;
  }
}

// Bind an existing key to a team / grant or revoke background-workload rights
// without recreating it (recreating would mean redistributing a new secret).
// A team binding is what makes team budgets, allow-lists and quotas
// enforceable against this key - see keyIdentity.js. Pass "team": null to
// unbind. Only the fields present in the body are changed.
router.patch("/:keyId", requireAuth("manage_keys"), async (req, res) => {
  const body = req.body || {};
  // In multi-tenant mode a key id from ANOTHER tenant must look exactly like an
  // unknown one (404) - otherwise a tenant could bind, or grant background
  // (budget-exempt) rights to, a key it does not own.
  try {
    await assertOwnsKey(req, req.params.keyId);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const existing = await req.controlPlaneDb.get("SELECT key_id, team, allow_background FROM api_keys WHERE key_id = ?", [req.params.keyId]);
  if (!existing) return res.status(404).json({ error: "Unknown key" });

  const sets = [];
  const params = [];
  if ("team" in body) {
    if (body.team !== null && (typeof body.team !== "string" || !body.team.trim())) {
      return res.status(400).json({ error: "team must be a non-empty string, or null to unbind" });
    }
    sets.push("team = ?");
    params.push(body.team === null ? null : body.team.trim());
  }
  if ("allow_background" in body) {
    if (typeof body.allow_background !== "boolean") {
      return res.status(400).json({ error: "allow_background must be true or false" });
    }
    sets.push("allow_background = ?");
    params.push(body.allow_background ? 1 : 0);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nothing to update - provide team and/or allow_background" });

  await req.controlPlaneDb.run(`UPDATE api_keys SET ${sets.join(", ")} WHERE key_id = ?`, [...params, req.params.keyId]);
  await logAudit(req.apiKey.key_id, "key.update", req.params.keyId, {
    before: { team: existing.team, allow_background: Boolean(existing.allow_background) },
    changes: body,
  }, req.db);
  const updated = await req.controlPlaneDb.get("SELECT key_id, label, role, team, allow_background, status FROM api_keys WHERE key_id = ?", [req.params.keyId]);
  res.json({ ...updated, allow_background: Boolean(updated.allow_background) });
});

router.post("/:keyId/quarantine", requireAuth("approve_quarantine"), async (req, res) => {
  try {
    await assertOwnsKey(req, req.params.keyId);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  const { reason = "manually quarantined" } = req.body || {};
  // api_keys lives in the control-plane schema; alerts_log lives in the
  // tenant's own schema - see governance.js's quarantineKey signature.
  // quarantineKey now throws when key_id doesn't exist (see governance.js) -
  // caught here and surfaced as a real 404 instead of an unhandled
  // rejection falling through to a generic 500.
  try {
    await quarantineKey(req.params.keyId, reason, req.controlPlaneDb, req.db);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/:keyId/approve", requireAuth("approve_quarantine"), async (req, res) => {
  try {
    await assertOwnsKey(req, req.params.keyId);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  try {
    await approveKey(req.params.keyId, req.controlPlaneDb);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post("/:keyId/revoke", requireAuth("manage_keys"), async (req, res) => {
  try {
    await assertOwnsKey(req, req.params.keyId);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  await req.controlPlaneDb.run("UPDATE api_keys SET status = 'revoked' WHERE key_id = ?", [req.params.keyId]);
  res.json({ ok: true });
});

module.exports = router;
