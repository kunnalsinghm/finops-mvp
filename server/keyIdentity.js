// keyIdentity.js - decides WHO a proxy request is acting as, and whether it may
// claim a background workload.
//
// The problem this fixes: the proxy used to read `team` and `workload type`
// straight from request headers (X-Team, X-Workload-Type). Every budget /
// allow-list / quota that is scoped to a team was therefore only as strong as
// the caller's honesty - omit X-Team and there is no team to enforce against;
// send X-Workload-Type: background and the hard budget block is skipped
// entirely; claim another team's name and you spend under (or hide from) it.
// The api_keys table already had a `team` column that the proxy never read.
//
// New rules (pure function, no I/O, so the whole policy is unit-testable):
//
//   TEAM
//   - Key bound to a team  -> that team is authoritative. An X-Team header is
//     accepted only if it matches; a different value is a 403, not a silent
//     override, so a misconfigured client fails loudly instead of being
//     quietly re-attributed.
//   - Key NOT bound        -> X-Team is a self-declared label (the legacy
//     behaviour, kept so existing deployments don't break on upgrade), and
//     spend under it is only as trustworthy as the client. Set
//     FINOPS_STRICT_IDENTITY=true to refuse unbound keys on the proxy
//     altogether. Recommended for anything where budgets are a real control.
//
//   BACKGROUND WORKLOADS (X-Workload-Type: background)
//   - Exempts a request from the budget hard-block/degrade, so it must be a
//     privilege an admin grants to a key (api_keys.allow_background), never
//     something a caller can assert. A key without it that sends the header
//     gets a 403.
//   - Bootstrap mode (no keys exist yet, everything is already open) is
//     exempt so first-run setup keeps working.
//
// Other X-Workload-Type values ("interactive", "batch", ...) remain free-form
// labels; only "background" carries enforcement consequences.
//
// PII REDACTION BYPASS (X-Disable-PII-Redaction: true)
// - Same shape as background workloads, for the same reason: skipping PII
//   redaction is a real privilege (a support-bot use case that legitimately
//   needs to send a customer's real email to the model), so it must be
//   admin-granted per key (api_keys.allow_pii_bypass), not something any
//   caller with proxy access can flip by sending a header. A key without it
//   that sends the header gets a 403 - see proxy.js and ingest.js for where
//   the redaction itself happens.
// - Bootstrap mode is exempt, same as background.
// - Exposed as its own resolvePiiBypass() below (not folded only into
//   resolveIdentity()) because ingest.js accepts this same header on the
//   stored raw payload but never goes through team/workload identity
//   resolution at all - it needs the permission check without the rest of
//   resolveIdentity's machinery.

const BOOTSTRAP_KEY_ID = "bootstrap";

function isStrictIdentity(env = process.env) {
  return env.FINOPS_STRICT_IDENTITY === "true";
}

function truthy(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}

// Pure, standalone permission check for X-Disable-PII-Redaction. Returns
// { ok: true, piiBypassAllowed } whether or not the header was even sent
// (piiBypassAllowed is simply false when it wasn't, or wasn't "true") - a
// 403 is only ever returned when the header WAS sent and the key lacks the
// privilege.
function resolvePiiBypass(apiKey, piiBypassHeader) {
  if (piiBypassHeader !== "true") {
    return { ok: true, piiBypassAllowed: false };
  }
  const isBootstrap = apiKey?.key_id === BOOTSTRAP_KEY_ID;
  if (truthy(apiKey?.allow_pii_bypass) || isBootstrap) {
    return { ok: true, piiBypassAllowed: true };
  }
  return {
    ok: false,
    status: 403,
    code: "pii-bypass-not-permitted",
    error: "This API key is not permitted to send X-Disable-PII-Redaction. An admin can grant it: PATCH /api/keys/:keyId { \"allow_pii_bypass\": true }.",
  };
}

function resolveIdentity(apiKey, { teamHeader, workloadHeader, piiBypassHeader } = {}, env = process.env) {
  const keyTeam = apiKey?.team || null;
  const declaredTeam = teamHeader || null;
  const isBootstrap = apiKey?.key_id === BOOTSTRAP_KEY_ID;

  let team;
  let teamSource;

  if (keyTeam) {
    if (declaredTeam && declaredTeam !== keyTeam) {
      return {
        ok: false,
        status: 403,
        code: "team-mismatch",
        error: `X-Team '${declaredTeam}' does not match the team this API key is bound to. Remove the header or use a key bound to that team.`,
      };
    }
    team = keyTeam;
    teamSource = "key";
  } else {
    if (isStrictIdentity(env) && !isBootstrap) {
      return {
        ok: false,
        status: 403,
        code: "key-not-bound",
        error: "This API key is not bound to a team, and this deployment requires team-bound keys (FINOPS_STRICT_IDENTITY=true). Ask an admin to bind it: PATCH /api/keys/:keyId { \"team\": \"...\" }.",
      };
    }
    team = declaredTeam;
    teamSource = declaredTeam ? "header" : "none";
  }

  const workloadType = workloadHeader || null;
  let backgroundExempt = false;
  if (workloadType === "background") {
    if (truthy(apiKey?.allow_background) || isBootstrap) {
      backgroundExempt = true;
    } else {
      return {
        ok: false,
        status: 403,
        code: "background-not-permitted",
        error: "This API key is not permitted to send background workloads (X-Workload-Type: background), which are exempt from budget enforcement. An admin can grant it: PATCH /api/keys/:keyId { \"allow_background\": true }.",
      };
    }
  }

  const piiBypass = resolvePiiBypass(apiKey, piiBypassHeader);
  if (!piiBypass.ok) return piiBypass;

  return { ok: true, team, teamSource, workloadType, backgroundExempt, piiBypassAllowed: piiBypass.piiBypassAllowed };
}

// The id to store in usage_events.key_id: the authenticated API key that sent
// the event. Dashboard-session logins ("user:<name>") and bootstrap mode are
// not API keys - nothing can be quarantined or revoked through them - so they
// record NULL rather than a value that looks like a key but isn't one.
// Accepts either the key row or the bare id string.
function realKeyId(keyOrId) {
  const id = typeof keyOrId === "string" ? keyOrId : keyOrId?.key_id;
  if (!id || id === BOOTSTRAP_KEY_ID || id.startsWith("user:")) return null;
  return id;
}

module.exports = { resolveIdentity, resolvePiiBypass, isStrictIdentity, realKeyId };
