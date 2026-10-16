// openapi.js - hand-written OpenAPI 3.0 description of the stable, versioned
// API, served at GET /api/v1/openapi.json.
//
// SCOPE, stated plainly: proxy, ingest, keys, auth (and invites, which are part
// of the account flow). The other route groups (costs, budgets, alerts, ...) are
// mounted under /api/v1 too - they work - but are NOT described here yet.
//
// HAND-WRITTEN, so it can rot. Two things stop it from rotting silently
// (test/openapi.test.js): (1) every documented path+method must exist on the
// real router, and (2) every route the real routers in scope expose must be
// documented. Request/response SCHEMAS are not machine-checked against
// handlers - treat them as descriptions of the validation each handler does,
// reviewed by hand.
//
// `servers` is `/api/v1`, so every path below is relative to it. The original
// unversioned `/api/...` paths keep working and are identical.

const ROLES = ["admin", "budget-manager", "developer", "viewer", "auditor", "agent"];
const DASHBOARD_ROLES = ROLES.filter((r) => r !== "agent");

const err = (description) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});
const ok = { description: "Success", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } };
const json = (schema) => ({ required: true, content: { "application/json": { schema } } });
const R = {
  400: err("Invalid request"),
  401: err("Missing or invalid credentials"),
  403: err("The credential's role does not permit this"),
  404: err("Not found"),
  429: err("Rate limited or quota exceeded"),
};
const authed = [{ apiKey: [] }, { sessionToken: [] }];
const keyIdParam = { name: "keyId", in: "path", required: true, schema: { type: "string" } };
const usernameParam = { name: "username", in: "path", required: true, schema: { type: "string" } };

const tagHeaders = ["X-Environment", "X-Git-Branch", "X-Feature-Id", "X-Customer-Id", "X-Project-Id", "X-Cost-Center", "X-Client-Region", "X-Agent-Id", "X-Session-Id", "X-Task-Id", "X-Task-Status", "X-Team", "X-Workload-Type"].map((name) => ({
  name,
  in: "header",
  required: false,
  schema: { type: "string" },
}));

const spec = {
  openapi: "3.0.3",
  info: {
    title: "FinOps API",
    version: "1.0.0",
    description:
      "Metering proxy, usage ingest, API keys and accounts. Partial: other route groups exist under the same prefix but are not described yet. " +
      "Authenticate with `X-API-Key` (a service key) or `X-Session-Token` (a dashboard login). In multi-tenant mode the tenant is derived from the credential, never from the request.",
  },
  servers: [{ url: "/api/v1", description: "Stable versioned path. `/api/...` (unversioned) is an identical alias." }],
  tags: [{ name: "proxy" }, { name: "ingest" }, { name: "keys" }, { name: "auth" }, { name: "invites" }],
  paths: {
    "/proxy/{provider}": {
      post: {
        tags: ["proxy"],
        operationId: "proxyProvider",
        summary: "Forward a chat request to a provider and meter it",
        description:
          "Forwards the JSON body to the provider unchanged and records usage and cost. Your real provider key goes in `X-Provider-Key` and is forwarded only, never stored. " +
          "Team and workload class come from the API key, not from headers. Streaming (`stream: true`) is passed through. The response is the provider's own response, status included, on success.",
        security: [{ apiKey: [] }, { sessionToken: [] }],
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string", enum: ["openai", "anthropic"] } },
          { name: "X-Provider-Key", in: "header", required: true, schema: { type: "string" }, description: "Your own OpenAI/Anthropic key." },
          ...tagHeaders,
        ],
        requestBody: json({ type: "object", description: "The provider's chat request body, passed through.", additionalProperties: true }),
        responses: {
          200: { description: "The provider's response, passed through (JSON or event stream)." },
          400: err("Unknown provider, missing `X-Provider-Key`, invalid tag header, or request blocked (e.g. prompt injection)"),
          401: R[401],
          402: err("Team is over its monthly budget and no fallback model is configured"),
          403: err("Blocked by policy: model allow-list, data-residency, or identity rules"),
          422: err("No price configured for the model and the deployment refuses unpriced models"),
          429: err("Rate limit, token quota, monthly event quota, or quarantined-key limit"),
          502: err("Upstream provider request or stream failed"),
          503: err("Metering store unavailable and the deployment is fail-closed"),
          504: err("Upstream provider did not respond in time"),
        },
      },
    },
    "/ingest": {
      post: {
        tags: ["ingest"],
        operationId: "ingestEvent",
        summary: "Record a usage event you metered yourself",
        security: authed,
        requestBody: json({ $ref: "#/components/schemas/UsageEvent" }),
        responses: {
          201: { description: "Recorded", content: { "application/json": { schema: { $ref: "#/components/schemas/IngestResult" } } } },
          400: err("Missing provider/model, invalid `task_status`, or request blocked (e.g. prompt injection)"),
          401: R[401],
          403: R[403],
          429: R[429],
        },
      },
    },
    "/keys": {
      get: {
        tags: ["keys"],
        operationId: "listKeys",
        summary: "List API keys (own tenant only in multi-tenant mode)",
        security: authed,
        responses: {
          200: { description: "Keys", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/ApiKey" } } } } },
          401: R[401],
          403: R[403],
        },
      },
      post: {
        tags: ["keys"],
        operationId: "createKey",
        summary: "Create an API key (requires `manage_keys`)",
        security: authed,
        requestBody: json({
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string" },
            role: { type: "string", enum: ROLES, default: "developer" },
            team: { type: "string" },
            allow_background: { type: "boolean", default: false },
            allow_pii_bypass: { type: "boolean", default: false },
          },
        }),
        responses: {
          201: { description: "Created. The key id is the credential.", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiKey" } } } },
          400: R[400],
          401: R[401],
          403: R[403],
          429: err("Tenant API-key quota reached"),
        },
      },
    },
    "/keys/{keyId}": {
      patch: {
        tags: ["keys"],
        operationId: "updateKey",
        summary: "Bind a team or change background/PII flags (requires `manage_keys`)",
        security: authed,
        parameters: [keyIdParam],
        requestBody: json({
          type: "object",
          properties: { team: { type: "string", nullable: true, description: "null unbinds the team" }, allow_background: { type: "boolean" }, allow_pii_bypass: { type: "boolean" } },
        }),
        responses: { 200: { description: "Updated key", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiKey" } } } }, 400: R[400], 401: R[401], 403: R[403], 404: R[404] },
      },
    },
    "/keys/{keyId}/quarantine": {
      post: { tags: ["keys"], operationId: "quarantineKey", summary: "Quarantine a key (requires `approve_quarantine`)", security: authed, parameters: [keyIdParam], responses: { 200: ok, 401: R[401], 403: R[403], 404: R[404] } },
    },
    "/keys/{keyId}/approve": {
      post: { tags: ["keys"], operationId: "approveKey", summary: "Lift a quarantine (requires `approve_quarantine`)", security: authed, parameters: [keyIdParam], responses: { 200: ok, 401: R[401], 403: R[403], 404: R[404] } },
    },
    "/keys/{keyId}/dismiss-rotation": {
      post: { tags: ["keys"], operationId: "dismissKeyRotation", summary: "Clear a rotation recommendation (requires `approve_quarantine`)", security: authed, parameters: [keyIdParam], responses: { 200: ok, 401: R[401], 403: R[403], 404: R[404] } },
    },
    "/keys/{keyId}/revoke": {
      post: { tags: ["keys"], operationId: "revokeKey", summary: "Revoke a key (requires `manage_keys`)", security: authed, parameters: [keyIdParam], responses: { 200: ok, 401: R[401], 403: R[403], 404: R[404] } },
    },
    "/auth/register": {
      post: {
        tags: ["auth"],
        operationId: "register",
        summary: "Create a dashboard account",
        description:
          "Requires an authenticated `manage_keys` caller. Single-tenant exception: while no users and no API keys exist yet, the very first account may self-register and becomes admin.",
        security: [{}, ...authed],
        requestBody: json({
          type: "object",
          required: ["username", "password"],
          properties: { username: { type: "string" }, password: { type: "string", minLength: 8 }, role: { type: "string", enum: DASHBOARD_ROLES, default: "viewer" }, email: { type: "string", format: "email" } },
        }),
        responses: { 201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } } }, 400: R[400], 401: R[401], 403: R[403] },
      },
    },
    "/auth/login": {
      post: {
        tags: ["auth"],
        operationId: "login",
        summary: "Log in; returns a session token for `X-Session-Token`",
        description: "IP-rate-limited. Multi-tenant mode additionally requires `tenant_id`.",
        security: [],
        requestBody: json({
          type: "object",
          required: ["username", "password"],
          properties: { tenant_id: { type: "integer", description: "Required in multi-tenant mode." }, username: { type: "string" }, password: { type: "string" } },
        }),
        responses: {
          200: { description: "Session", content: { "application/json": { schema: { $ref: "#/components/schemas/Session" } } } },
          400: R[400],
          401: err("Invalid credentials"),
          403: err("Tenant is suspended or otherwise denied"),
          429: R[429],
        },
      },
    },
    "/auth/logout": {
      post: { tags: ["auth"], operationId: "logout", summary: "End a session", security: [], parameters: [{ name: "X-Session-Token", in: "header", required: false, schema: { type: "string" } }], responses: { 200: ok } },
    },
    "/auth/users/{username}/reset-password": {
      post: {
        tags: ["auth"],
        operationId: "adminResetPassword",
        summary: "Set a user's password (requires `manage_keys`)",
        security: authed,
        parameters: [usernameParam],
        requestBody: json({ type: "object", required: ["newPassword"], properties: { newPassword: { type: "string", minLength: 8 } } }),
        responses: { 200: ok, 400: R[400], 401: R[401], 403: R[403], 404: R[404] },
      },
    },
    "/auth/forgot-password": {
      post: {
        tags: ["auth"],
        operationId: "forgotPassword",
        summary: "Email a password-reset link",
        description:
          "Give exactly one of `username` or `email` (both or neither is a 400). The response is identical whether or not an account matched. Email lookup matches verified addresses only. Multi-tenant mode requires `tenant_id`.",
        security: [],
        requestBody: json({ type: "object", properties: { tenant_id: { type: "integer" }, username: { type: "string" }, email: { type: "string", format: "email" } } }),
        responses: { 200: { description: "Generic acknowledgement", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } }, 400: R[400], 429: R[429] },
      },
    },
    "/auth/reset-password": {
      post: {
        tags: ["auth"],
        operationId: "resetPassword",
        summary: "Redeem an emailed reset token",
        security: [],
        requestBody: json({ type: "object", required: ["token", "newPassword"], properties: { token: { type: "string" }, newPassword: { type: "string", minLength: 8 } } }),
        responses: { 200: ok, 400: err("Invalid or expired token, or invalid password"), 429: R[429] },
      },
    },
    "/auth/resend-verification": {
      post: {
        tags: ["auth"],
        operationId: "resendVerification",
        summary: "Email a new address-verification link",
        description: "Generic response regardless of whether the account exists. Multi-tenant mode requires `tenant_id`.",
        security: [],
        requestBody: json({ type: "object", required: ["username"], properties: { tenant_id: { type: "integer" }, username: { type: "string" } } }),
        responses: { 200: { description: "Generic acknowledgement", content: { "application/json": { schema: { $ref: "#/components/schemas/Ok" } } } }, 400: R[400], 429: R[429] },
      },
    },
    "/auth/verify-email": {
      post: {
        tags: ["auth"],
        operationId: "verifyEmail",
        summary: "Redeem an emailed verification token",
        security: [],
        requestBody: json({ type: "object", required: ["token"], properties: { token: { type: "string" } } }),
        responses: { 200: ok, 400: err("Invalid or expired token"), 429: R[429] },
      },
    },
    "/invites": {
      post: {
        tags: ["invites"],
        operationId: "createInvite",
        summary: "Invite a teammate by email (requires `manage_keys`)",
        description: "Emails a single-use link valid for 7 days. You can only grant a role whose permissions you hold. The token is never returned. Re-inviting an address supersedes its older pending invite.",
        security: authed,
        requestBody: json({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" }, role: { type: "string", enum: DASHBOARD_ROLES, default: "viewer" } } }),
        responses: {
          201: { description: "Invite created", content: { "application/json": { schema: { $ref: "#/components/schemas/Invite" } } } },
          400: R[400],
          401: R[401],
          403: err("Role not grantable by the caller, or caller lacks `manage_keys`"),
          429: err("Too many pending invites"),
        },
      },
      get: {
        tags: ["invites"],
        operationId: "listInvites",
        summary: "List pending invites (requires `manage_keys`)",
        security: authed,
        responses: { 200: { description: "Pending invites", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/PendingInvite" } } } } }, 401: R[401], 403: R[403] },
      },
    },
    "/invites/{id}": {
      delete: {
        tags: ["invites"],
        operationId: "revokeInvite",
        summary: "Revoke a pending invite (requires `manage_keys`)",
        security: authed,
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { 200: ok, 401: R[401], 403: R[403], 404: err("No such pending invitation") },
      },
    },
    "/invites/accept": {
      post: {
        tags: ["invites"],
        operationId: "acceptInvite",
        summary: "Redeem an invite and choose a username and password",
        description: "Anonymous and IP-rate-limited. Unknown, expired, used, revoked and suspended-tenant tokens all return the same 400. Returns `tenant_id` in multi-tenant mode.",
        security: [],
        requestBody: json({ type: "object", required: ["token", "username", "password"], properties: { token: { type: "string" }, username: { type: "string" }, password: { type: "string", minLength: 8 } } }),
        responses: {
          201: { description: "Account created", content: { "application/json": { schema: { $ref: "#/components/schemas/Account" } } } },
          400: err("Invalid or expired invitation, or invalid input"),
          409: err("That username is already taken (the link still works)"),
          429: R[429],
        },
      },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
      sessionToken: { type: "apiKey", in: "header", name: "X-Session-Token" },
    },
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: { type: "string" } }, additionalProperties: true },
      Ok: { type: "object", properties: { ok: { type: "boolean" }, message: { type: "string" } } },
      UsageEvent: {
        type: "object",
        required: ["provider", "model"],
        properties: {
          provider: { type: "string" },
          model: { type: "string" },
          team: { type: "string" },
          environment: { type: "string" },
          git_branch: { type: "string" },
          user_id: { type: "string" },
          feature_id: { type: "string" },
          customer_id: { type: "string" },
          project_id: { type: "string" },
          cost_center: { type: "string" },
          agent_id: { type: "string" },
          session_id: { type: "string" },
          task_id: { type: "string" },
          task_status: { type: "string", enum: ["success", "failed", "aborted"] },
          workload_type: { type: "string" },
          input_tokens: { type: "integer", default: 0 },
          output_tokens: { type: "integer", default: 0 },
          event_time: { type: "string", format: "date-time" },
        },
      },
      IngestResult: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          tagged: { type: "boolean" },
          cost_usd: { type: "number" },
          rate_found: { type: "boolean" },
          anomalies: { type: "array", items: { type: "object", additionalProperties: true } },
          fraud_signal: { type: "object", additionalProperties: true },
          tag_inference: { type: "object", additionalProperties: true },
          warning: { type: "string" },
        },
      },
      ApiKey: {
        type: "object",
        properties: {
          key_id: { type: "string" },
          label: { type: "string" },
          role: { type: "string", enum: ROLES },
          team: { type: "string", nullable: true },
          allow_background: { type: "boolean" },
          allow_pii_bypass: { type: "boolean" },
          status: { type: "string" },
          quarantine_reason: { type: "string", nullable: true },
          rotation_recommended: { type: "integer" },
          rotation_reason: { type: "string", nullable: true },
          created_at: { type: "string" },
        },
      },
      Account: {
        type: "object",
        properties: { ok: { type: "boolean" }, username: { type: "string" }, role: { type: "string", enum: DASHBOARD_ROLES }, email: { type: "string", nullable: true }, tenant_id: { type: "integer" }, note: { type: "string" } },
      },
      Session: {
        type: "object",
        properties: { token: { type: "string" }, username: { type: "string" }, role: { type: "string", enum: DASHBOARD_ROLES }, tenant_id: { type: "integer" } },
      },
      Invite: {
        type: "object",
        properties: { ok: { type: "boolean" }, id: { type: "integer" }, email: { type: "string" }, role: { type: "string" }, expires_at: { type: "string", format: "date-time" }, email_sent: { type: "boolean" } },
      },
      PendingInvite: {
        type: "object",
        properties: { id: { type: "integer" }, email: { type: "string" }, role: { type: "string" }, invited_by: { type: "string" }, created_at: { type: "string" }, expires_at: { type: "string" } },
      },
    },
  },
};

module.exports = spec;
