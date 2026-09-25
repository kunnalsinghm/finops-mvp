// test/multiTenantIsolation.test.js
//
// tenancy.test.js proves the CONTROL PLANE + auth resolution mechanism
// works, using its own throwaway demo routes. This file proves the REAL
// production routes - the ones an actual customer hits - are correctly
// tenant-scoped now that they've been converted to use req.db/
// req.controlPlaneDb instead of a single global database. Two tenants,
// real HTTP requests, real route files, real requireAuth middleware.
//
// Requires Postgres (FINOPS_DB_DRIVER=postgres) - multi-tenant mode has
// no SQLite equivalent, per tenancy.js's header comment.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const isPostgres = process.env.FINOPS_DB_DRIVER === "postgres";

if (!isPostgres) {
  test("multi-tenant isolation suite requires Postgres - skipped under SQLite", { skip: true }, () => {});
} else {
  process.env.FINOPS_MULTI_TENANT = "true";
  process.env.FINOPS_CONTROL_PLANE_SCHEMA = `test_control_${process.pid}`;

  const tenancy = require("../server/tenancy");
  const { requireAuth } = require("../server/auth");
  const proxyRoute = require("../server/routes/proxy");
  const costsRoute = require("../server/routes/costs");
  const budgetsRoute = require("../server/routes/budgets");
  const keysRoute = require("../server/routes/keys");
  const cacheRoute = require("../server/routes/cache");
  const ingestRoute = require("../server/routes/ingest");
  const alertsRoute = require("../server/routes/alerts");
  const commitmentsRoute = require("../server/routes/commitments");
  const { router: gitopsRoute } = require("../server/routes/gitops");
  const reconcileRoute = require("../server/routes/reconcile");
  const reportsRoute = require("../server/routes/reports");
  const queryRoute = require("../server/routes/query");
  const toolCallsRoute = require("../server/routes/toolCalls");
  const toolCallDenylistRoute = require("../server/routes/toolCallDenylist");
  const shadowTestRoute = require("../server/routes/shadowTest");

  let server;
  let tenantA, tenantB, keyA, keyB;

  test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/proxy", proxyRoute);
    app.use("/api/ingest", ingestRoute);
    app.use("/api/costs", costsRoute);
    app.use("/api/budgets", budgetsRoute);
    app.use("/api/keys", keysRoute);
    app.use("/api/cache", cacheRoute);
    app.use("/api/alerts", alertsRoute);
    app.use("/api/commitments", commitmentsRoute);
    app.use("/api/gitops", gitopsRoute);
    app.use("/api/reconcile", reconcileRoute);
    app.use("/api/reports", reportsRoute);
    app.use("/api/query", queryRoute);
    app.use("/api/tool-calls", toolCallsRoute);
    app.use("/api/tool-call-denylist", toolCallDenylistRoute);
    app.use("/api/shadow-test", shadowTestRoute);

    server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });

    tenantA = await tenancy.createTenant({ name: `Tenant A ${process.pid}` });
    tenantB = await tenancy.createTenant({ name: `Tenant B ${process.pid}` });
    keyA = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "A key", role: "admin" });
    keyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "B key", role: "admin" });
  });

  test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const { controlPlanePool } = tenancy.initControlPlane();
    try {
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenantA.schema_name} CASCADE`);
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${tenantB.schema_name} CASCADE`);
      await controlPlanePool.query(`DROP SCHEMA IF EXISTS ${process.env.FINOPS_CONTROL_PLANE_SCHEMA} CASCADE`);
    } catch (err) {
      console.warn(`[multiTenantIsolation] cleanup failed: ${err.message}`);
    }
    await tenancy.closeAll();
    delete process.env.FINOPS_MULTI_TENANT;
  });

  function request(method, pathName, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : undefined;
      const reqHeaders = { "Content-Type": "application/json", ...headers };
      if (data !== undefined) reqHeaders["Content-Length"] = Buffer.byteLength(data);
      const req = http.request(
        { hostname: "127.0.0.1", port: server.address().port, path: pathName, method, headers: reqHeaders },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = text;
            }
            resolve({ status: res.statusCode, body: json });
          });
        }
      );
      req.on("error", reject);
      if (data !== undefined) req.write(data);
      req.end();
    });
  }
  const get = (p, opts) => request("GET", p, opts);
  const post = (p, opts) => request("POST", p, opts);

  test("ingested usage events never cross tenant boundaries in cost summaries", async () => {
    await post("/api/ingest", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", model: "gpt-4o-mini", team: "growth", environment: "production", input_tokens: 1000, output_tokens: 500 },
    });
    await post("/api/ingest", {
      headers: { "X-API-Key": keyB.key_id },
      body: { provider: "anthropic", model: "claude-haiku", team: "growth", environment: "production", input_tokens: 1000, output_tokens: 500 },
    });

    const summaryA = await get("/api/costs/by-model", { headers: { "X-API-Key": keyA.key_id } });
    const summaryB = await get("/api/costs/by-model", { headers: { "X-API-Key": keyB.key_id } });

    assert.ok(summaryA.body.some((r) => r.provider === "openai"), "tenant A should see its own openai event");
    assert.ok(!summaryA.body.some((r) => r.provider === "anthropic"), "tenant A must NOT see tenant B's anthropic event");

    assert.ok(summaryB.body.some((r) => r.provider === "anthropic"), "tenant B should see its own anthropic event");
    assert.ok(!summaryB.body.some((r) => r.provider === "openai"), "tenant B must NOT see tenant A's openai event");
  });

  test("budgets are isolated per tenant", async () => {
    await post("/api/budgets", {
      headers: { "X-API-Key": keyA.key_id },
      body: { scope_type: "team", scope_value: "growth", monthly_limit_usd: 500 },
    });

    const budgetsA = await get("/api/budgets", { headers: { "X-API-Key": keyA.key_id } });
    const budgetsB = await get("/api/budgets", { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(budgetsA.body.length, 1, "tenant A should see the budget it created");
    assert.equal(budgetsB.body.length, 0, "tenant B must NOT see tenant A's budget");
  });

  test("api keys are isolated per tenant (control-plane tenant_id scoping)", async () => {
    await post("/api/keys", {
      headers: { "X-API-Key": keyA.key_id },
      body: { label: "A second key", role: "viewer" },
    });

    const keysA = await get("/api/keys", { headers: { "X-API-Key": keyA.key_id } });
    const keysB = await get("/api/keys", { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(keysA.body.length, 2, "tenant A should see both of its own keys (admin + viewer)");
    assert.equal(keysB.body.length, 1, "tenant B must NOT see tenant A's keys - only its own");
    assert.ok(keysB.body.every((k) => k.key_id === keyB.key_id));
  });

  test("a tenant cannot quarantine, approve, or revoke another tenant's key by guessing its id", async () => {
    const revokeAttempt = await post(`/api/keys/${keyB.key_id}/revoke`, { headers: { "X-API-Key": keyA.key_id } });
    assert.equal(revokeAttempt.status, 404, "tenant A targeting tenant B's key_id must be rejected as not-found, not silently succeed");

    const quarantineAttempt = await post(`/api/keys/${keyB.key_id}/quarantine`, { headers: { "X-API-Key": keyA.key_id }, body: {} });
    assert.equal(quarantineAttempt.status, 404);

    // Confirm tenant B's key genuinely still works after the attack attempt.
    const stillWorks = await get("/api/costs/by-model", { headers: { "X-API-Key": keyB.key_id } });
    assert.equal(stillWorks.status, 200, "tenant B's key must still be fully active - the cross-tenant attempts above must not have affected it");
  });

  test("exact-match cache never returns one tenant's cached response to another", async (t) => {
    const identicalBody = { model: "gpt-4o-mini", messages: [{ role: "user", content: "cross-tenant cache probe" }] };

    let callCount = 0;
    t.mock.method(global, "fetch", async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: `response #${callCount}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    });

    const respA1 = await post("/api/proxy/openai", {
      headers: { "X-API-Key": keyA.key_id, "X-Provider-Key": "sk-fake", "X-Enable-Cache": "true" },
      body: identicalBody,
    });
    // Tenant B makes the BYTE-IDENTICAL request. If the cache leaked across
    // tenants, this would return tenant A's cached response (call count
    // would stay at 1) instead of hitting the (mocked) provider again.
    const respB1 = await post("/api/proxy/openai", {
      headers: { "X-API-Key": keyB.key_id, "X-Provider-Key": "sk-fake", "X-Enable-Cache": "true" },
      body: identicalBody,
    });

    assert.equal(callCount, 2, "an identical request from a DIFFERENT tenant must not be served from the first tenant's cache");
    assert.notEqual(
      respA1.body.choices[0].message.content,
      respB1.body.choices[0].message.content,
      "tenant B must get its own provider response, not tenant A's cached one"
    );

    // Now tenant A repeats its OWN request - THIS should hit the cache.
    const respA2 = await post("/api/proxy/openai", {
      headers: { "X-API-Key": keyA.key_id, "X-Provider-Key": "sk-fake", "X-Enable-Cache": "true" },
      body: identicalBody,
    });
    assert.equal(callCount, 2, "tenant A's own repeated request should hit its own cache, not call the provider again");
    assert.equal(respA2.body.choices[0].message.content, respA1.body.choices[0].message.content);
  });

  // ---- The 7 route groups that used to be 501'd in multi-tenant mode
  // (see tenantGuard.js) - each converted to req.db instead of a hardcoded
  // global database. One isolation test per group, proving tenant A's
  // writes are invisible to tenant B and vice versa, through the real
  // route files with real requireAuth-resolved req.db.

  test("alerts: a budget breach + alert fired for tenant A is invisible to tenant B", async () => {
    const team = `alerts-iso-${process.pid}`;
    await post("/api/budgets", {
      headers: { "X-API-Key": keyA.key_id },
      body: { scope_type: "team", scope_value: team, monthly_limit_usd: 1 },
    });
    // Push tenant A's spend on this team well past 100% of the $1 budget.
    await post("/api/ingest", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", model: "gpt-4o", team, environment: "production", input_tokens: 200000, output_tokens: 100000 },
    });

    const checkResult = await post("/api/alerts/check-now", { headers: { "X-API-Key": keyA.key_id } });
    assert.equal(checkResult.status, 200);

    const alertsA = await get("/api/alerts", { headers: { "X-API-Key": keyA.key_id } });
    const alertsB = await get("/api/alerts", { headers: { "X-API-Key": keyB.key_id } });

    assert.ok(alertsA.body.some((a) => a.message.includes(team)), "tenant A should see its own budget alert");
    assert.ok(!alertsB.body.some((a) => a.message.includes(team)), "tenant B must NOT see tenant A's budget alert");
  });

  test("commitments: a prepaid balance created for tenant A is invisible to tenant B", async () => {
    const label = `commitment-iso-${process.pid}`;
    await post("/api/commitments", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", label, initial_amount_usd: 100 },
    });

    const commitmentsA = await get("/api/commitments", { headers: { "X-API-Key": keyA.key_id } });
    const commitmentsB = await get("/api/commitments", { headers: { "X-API-Key": keyB.key_id } });

    assert.ok(commitmentsA.body.some((c) => c.label === label), "tenant A should see its own commitment");
    assert.ok(!commitmentsB.body.some((c) => c.label === label), "tenant B must NOT see tenant A's commitment");
  });

  test("gitops: syncing finops.yaml writes budgets into the calling tenant's OWN schema only", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const CONFIG_PATH = path.join(__dirname, "..", "finops.yaml");
    const team = `gitops-iso-${process.pid}`;
    const original = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, "utf8") : null;
    try {
      fs.writeFileSync(CONFIG_PATH, `budgets:\n  - scope_type: team\n    scope_value: ${team}\n    monthly_limit_usd: 55\n`, "utf8");

      const syncResult = await post("/api/gitops/sync", { headers: { "X-API-Key": keyA.key_id } });
      assert.equal(syncResult.status, 200);
      assert.equal(syncResult.body.created, 1);

      const budgetsA = await get("/api/budgets", { headers: { "X-API-Key": keyA.key_id } });
      const budgetsB = await get("/api/budgets", { headers: { "X-API-Key": keyB.key_id } });

      assert.ok(budgetsA.body.some((b) => b.scope_value === team), "tenant A should have the synced budget");
      assert.ok(!budgetsB.body.some((b) => b.scope_value === team), "tenant B must NOT get a budget it never synced");
    } finally {
      if (original !== null) fs.writeFileSync(CONFIG_PATH, original, "utf8");
      else { try { fs.unlinkSync(CONFIG_PATH); } catch {} }
    }
  });

  test("reconcile: a CSV imported for tenant A does not appear in tenant B's reconciliation report", async () => {
    const marker = `recon-iso-${process.pid}`;
    const csv = `date,provider,cost\n2026-01-05,${marker},12.34\n`;
    // The route expects raw text via express.text(), not JSON - send manually.
    const uploaded = await new Promise((resolve, reject) => {
      const r = http.request(
        { hostname: "127.0.0.1", port: server.address().port, path: "/api/reconcile/upload", method: "POST",
          headers: { "X-API-Key": keyA.key_id, "Content-Type": "text/csv", "Content-Length": Buffer.byteLength(csv) } },
        (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(t) })); }
      );
      r.on("error", reject);
      r.write(csv);
      r.end();
    });
    assert.equal(uploaded.status, 201);

    const reportA = await get("/api/reconcile/report", { headers: { "X-API-Key": keyA.key_id } });
    const reportB = await get("/api/reconcile/report", { headers: { "X-API-Key": keyB.key_id } });

    const seenInA = JSON.stringify(reportA.body).includes(marker);
    const seenInB = JSON.stringify(reportB.body).includes(marker);
    assert.ok(seenInA, "tenant A's reconciliation report should reflect the row it just imported");
    assert.ok(!seenInB, "tenant B must NOT see tenant A's imported invoice row");
  });

  test("reports: the weekly briefing preview's top movers only reflect the calling tenant's own spend", async () => {
    const teamA = `report-iso-A-${process.pid}`;
    const teamB = `report-iso-B-${process.pid}`;
    await post("/api/ingest", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", model: "gpt-4o-mini", team: teamA, environment: "production", input_tokens: 5000, output_tokens: 1000 },
    });
    await post("/api/ingest", {
      headers: { "X-API-Key": keyB.key_id },
      body: { provider: "openai", model: "gpt-4o-mini", team: teamB, environment: "production", input_tokens: 5000, output_tokens: 1000 },
    });

    const previewA = await get("/api/reports/weekly/preview", { headers: { "X-API-Key": keyA.key_id } });
    const previewB = await get("/api/reports/weekly/preview", { headers: { "X-API-Key": keyB.key_id } });

    const moversA = previewA.body.top_movers.map((m) => m.team);
    const moversB = previewB.body.top_movers.map((m) => m.team);
    assert.ok(moversA.includes(teamA), "tenant A's briefing should list its own team as a mover");
    assert.ok(!moversA.includes(teamB), "tenant A's briefing must NOT include tenant B's team");
    assert.ok(moversB.includes(teamB), "tenant B's briefing should list its own team as a mover");
    assert.ok(!moversB.includes(teamA), "tenant B's briefing must NOT include tenant A's team");
  });

  test("query: the NL query endpoint only recognizes team names from the calling tenant's own data", async () => {
    const teamA = `query-iso-A-${process.pid}`;
    await post("/api/ingest", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", model: "gpt-4o-mini", team: teamA, environment: "production", input_tokens: 2000, output_tokens: 500 },
    });

    const answerA = await get(`/api/query?q=${encodeURIComponent(`what did we spend on ${teamA}`)}`, {
      headers: { "X-API-Key": keyA.key_id },
    });
    const answerB = await get(`/api/query?q=${encodeURIComponent(`what did we spend on ${teamA}`)}`, {
      headers: { "X-API-Key": keyB.key_id },
    });

    assert.equal(answerA.body.team, teamA, "tenant A should recognize its own team name in the question");
    assert.notEqual(answerB.body.team, teamA, "tenant B must NOT recognize a team name that only exists in tenant A's data");
  });

  test("tool-calls: an agent action logged for tenant A does not appear in tenant B's audit log", async () => {
    const agentId = `agent-iso-${process.pid}`;
    const logResult = await post("/api/tool-calls", {
      headers: { "X-API-Key": keyA.key_id },
      body: { agent_id: agentId, tool_name: "read_file", target: "/etc/hosts" },
    });
    assert.equal(logResult.status, 201);

    const callsA = await get(`/api/tool-calls?agent_id=${agentId}`, { headers: { "X-API-Key": keyA.key_id } });
    const callsB = await get(`/api/tool-calls?agent_id=${agentId}`, { headers: { "X-API-Key": keyB.key_id } });

    assert.equal(callsA.body.length, 1, "tenant A should see the tool call it logged");
    assert.equal(callsB.body.length, 0, "tenant B must NOT see tenant A's logged tool call");
  });

  // ---- A9: RBAC roles (auditor, agent) enforce identically in multi-tenant
  // mode. Role enforcement (hasPermission/requireAuth) is dialect-agnostic -
  // the role lives on the tenant-scoped api_keys row either way (see
  // tenancy.js's createTenantApiKey) - so this is deliberately just proving
  // that assumption holds over real HTTP requests, not new plumbing.

  test("auditor role: a tenant A auditor key can read /api/alerts but is 403'd on /api/keys and /api/costs", async () => {
    const auditorKey = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "tenant A auditor", role: "auditor" });
    const alertsRes = await get("/api/alerts", { headers: { "X-API-Key": auditorKey.key_id } });
    assert.equal(alertsRes.status, 200);

    const keysRes = await get("/api/keys", { headers: { "X-API-Key": auditorKey.key_id } });
    assert.equal(keysRes.status, 403);

    const costsRes = await get("/api/costs/by-team", { headers: { "X-API-Key": auditorKey.key_id } });
    assert.equal(costsRes.status, 403);
  });

  test("agent role: a tenant B agent key can log a tool call but is 403'd on /api/keys", async () => {
    const agentKey = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "tenant B agent", role: "agent" });
    const toolCallRes = await post("/api/tool-calls", {
      headers: { "X-API-Key": agentKey.key_id },
      body: { tool_name: "read_file", target: "/etc/hosts" },
    });
    assert.equal(toolCallRes.status, 201);

    const keysRes = await get("/api/keys", { headers: { "X-API-Key": agentKey.key_id } });
    assert.equal(keysRes.status, 403);
  });

  test("auditor role: one tenant's auditor key cannot read another tenant's alerts_log (role AND tenant isolation both hold)", async () => {
    const teamA = `rbac-iso-A-${process.pid}`;
    await post("/api/ingest", {
      headers: { "X-API-Key": keyA.key_id },
      body: { provider: "openai", model: "gpt-4o-mini", team: teamA, cost_usd: 999999, input_tokens: 1, output_tokens: 1 },
    });
    await post("/api/alerts/check-now", { headers: { "X-API-Key": keyA.key_id } });

    const auditorKeyB = await tenancy.createTenantApiKey({ tenant_id: tenantB.id, label: "tenant B auditor", role: "auditor" });
    const alertsFromB = await get("/api/alerts", { headers: { "X-API-Key": auditorKeyB.key_id } });
    assert.equal(alertsFromB.status, 200);
    // Whatever tenant B's own alerts_log holds, none of it can be a row
    // generated by tenant A's ingest above - schema-per-tenant means B's
    // query physically cannot see A's table.
    assert.ok(!alertsFromB.body.some((row) => row.message && row.message.includes(teamA)));
  });

  // ---- A6: automated compromised-key response is tenant-scoped too. This
  // should "fall out naturally" from req.db/req.controlPlaneDb already
  // being resolved per-tenant by requireAuth (same mechanism every other
  // route in this file relies on) - this test exists to actually PROVE
  // that, not just assume it.

  test("fraud auto-quarantine: two concurrent signals on a tenant A key quarantine ONLY that key, never touching tenant B's key", async () => {
    const suspectKey = await tenancy.createTenantApiKey({ tenant_id: tenantA.id, label: "tenant A suspect key", role: "developer" });

    // Establish a low, steady baseline for the suspect key: 20 distinct
    // days (1/day) - satisfies BOTH the volume-spike baseline (avg ~1/day)
    // AND new-model-mix's 20-event "established key" threshold at once.
    for (let d = 1; d <= 20; d++) {
      await post("/api/ingest", {
        headers: { "X-API-Key": suspectKey.key_id },
        body: {
          provider: "openai",
          model: "gpt-4o",
          input_tokens: 100,
          output_tokens: 50,
          event_time: new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    }
    // Today: 9 requests on the ALREADY-ESTABLISHED model first (this
    // alone builds the volume-spike signal without touching new-model-mix -
    // each of these individually re-triggers only the single-signal
    // rotation-recommended path, which is expected and harmless), THEN one
    // final request switches to a brand-new model. That final request is
    // the first moment both signals are true AT ONCE: today's count is
    // already past the spike threshold, and this is the very first time
    // this provider/model combo has ever appeared on this key. This
    // ordering matters because after that final request runs once, the new
    // model would no longer be "new" - so the two signals can only overlap
    // on this exact request, not on a repeat of it.
    for (let i = 0; i < 9; i++) {
      await post("/api/ingest", {
        headers: { "X-API-Key": suspectKey.key_id },
        body: { provider: "openai", model: "gpt-4o", input_tokens: 100, output_tokens: 50 },
      });
    }
    const last = await post("/api/ingest", {
      headers: { "X-API-Key": suspectKey.key_id },
      body: { provider: "anthropic", model: "claude-opus", input_tokens: 100, output_tokens: 50 },
    });
    assert.equal(last.status, 201);

    const keysInA = await get("/api/keys", { headers: { "X-API-Key": keyA.key_id } });
    const suspectInA = keysInA.body.find((k) => k.key_id === suspectKey.key_id);
    assert.equal(suspectInA.status, "quarantined", "the suspect key itself should be auto-quarantined");

    // Tenant B's own admin key must be completely unaffected - different
    // schema, different api_keys row, never touched by tenant A's check.
    const keysInB = await get("/api/keys", { headers: { "X-API-Key": keyB.key_id } });
    const bAdminInB = keysInB.body.find((k) => k.key_id === keyB.key_id);
    assert.equal(bAdminInB.status, "active");
    // And tenant B's key list must not even contain tenant A's suspect key -
    // schema-per-tenant means it's not just unaffected, it's invisible.
    assert.ok(!keysInB.body.some((k) => k.key_id === suspectKey.key_id));
  });

  // ---- A7: tool-call deny-list and approval-queue tables are tenant-scoped ----

  test("A7 deny-list: a tenant A denylist entry has no effect on an identical call from tenant B", async () => {
    const denyRes = await post("/api/tool-call-denylist", {
      headers: { "X-API-Key": keyA.key_id },
      body: { scope_type: "team", scope_value: "shared-team-name", tool_name: "wipe_disk" },
    });
    assert.equal(denyRes.status, 201);

    const checkInA = await post("/api/tool-calls/check", {
      headers: { "X-API-Key": keyA.key_id },
      body: { tool_name: "wipe_disk", target: "/dev/sda", team: "shared-team-name" },
    });
    assert.equal(checkInA.body.allowed, false, "tenant A's own denylist entry should deny this in tenant A");

    // Same tool_name, same (coincidentally identically-named) team, from
    // tenant B - must be unaffected, since tenant B's tool_call_denylist
    // table is a physically different table (schema-per-tenant).
    const checkInB = await post("/api/tool-calls/check", {
      headers: { "X-API-Key": keyB.key_id },
      body: { tool_name: "wipe_disk", target: "/dev/sda", team: "shared-team-name" },
    });
    assert.equal(checkInB.body.allowed, true, "tenant B must not inherit tenant A's deny-list entry");

    const listInB = await get("/api/tool-call-denylist", { headers: { "X-API-Key": keyB.key_id } });
    assert.equal(listInB.body.length, 0, "tenant B's deny-list must not contain tenant A's entry");
  });

  test("A7 approval queue: a pending approval raised in tenant A is invisible to tenant B's admin", async () => {
    const checkRes = await post("/api/tool-calls/check", {
      headers: { "X-API-Key": keyA.key_id },
      body: { agent_id: `agent-iso-${process.pid}`, tool_name: "bash", target: "sudo rm -rf /data" },
    });
    assert.equal(checkRes.body.requires_approval, true);

    const pendingInA = await get("/api/tool-calls/approvals", { headers: { "X-API-Key": keyA.key_id } });
    assert.ok(pendingInA.body.some((p) => p.id === checkRes.body.approval_id));

    const pendingInB = await get("/api/tool-calls/approvals", { headers: { "X-API-Key": keyB.key_id } });
    assert.ok(
      !pendingInB.body.some((p) => p.id === checkRes.body.approval_id),
      "tenant B must not see tenant A's pending approval, even though ids could coincidentally collide across separate per-tenant sequences"
    );

    // Tenant B's admin trying to decide an id that only exists in tenant
    // A's own schema must find nothing there (404), not reach across into
    // tenant A's table.
    const decideFromB = await post(`/api/tool-calls/approvals/${checkRes.body.approval_id}/approve`, {
      headers: { "X-API-Key": keyB.key_id },
    });
    assert.equal(decideFromB.status, 404);
  });

  // ---- A8: shadow_comparisons and flagged_test_cases are tenant-scoped ----

  test("A8 shadow_comparisons: a comparison recorded for tenant A is invisible to tenant B", async (t) => {
    const shadowTest = require("../server/shadowTest");
    const flaggedTestCases = require("../server/flaggedTestCases");
    const tenantADb = await tenancy.getTenantDb(tenantA.schema_name);

    t.mock.method(global, "fetch", async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "completely unrelated giraffe content, nothing like the primary" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));

    const fakeEndpoint = {
      url: "https://api.openai.test/v1/chat/completions",
      authHeader: () => ({}),
      extractUsage: (json) => ({ input_tokens: json?.usage?.prompt_tokens || 0, output_tokens: json?.usage?.completion_tokens || 0 }),
    };

    await shadowTest.runShadowTest({
      providerName: "openai",
      primaryModel: "gpt-4o",
      primaryRequestBody: { model: "gpt-4o", messages: [] },
      primaryResponseJson: {
        choices: [{ message: { content: "the actual primary response about quarterly revenue" } }],
      },
      primaryCostUsd: 0.02,
      providerKey: "sk-test",
      team: `iso-team-${process.pid}`,
      endpoint: fakeEndpoint,
      sampleRate: 1.0,
      db: tenantADb,
    });

    const comparisonsInA = await get("/api/shadow-test/comparisons", { headers: { "X-API-Key": keyA.key_id } });
    assert.ok(comparisonsInA.body.some((r) => r.team === `iso-team-${process.pid}`));

    const comparisonsInB = await get("/api/shadow-test/comparisons", { headers: { "X-API-Key": keyB.key_id } });
    assert.ok(
      !comparisonsInB.body.some((r) => r.team === `iso-team-${process.pid}`),
      "tenant B must not see tenant A's shadow_comparisons row"
    );

    // The low-similarity comparison above should also have captured a
    // flagged_test_cases row in tenant A's schema, and ONLY there.
    const flaggedInA = await get("/api/shadow-test/flagged-test-cases", { headers: { "X-API-Key": keyA.key_id } });
    assert.ok(flaggedInA.body.some((f) => f.source === "shadow-low-similarity"));

    const flaggedInB = await get("/api/shadow-test/flagged-test-cases", { headers: { "X-API-Key": keyB.key_id } });
    assert.equal(flaggedInB.body.length, 0, "tenant B's flagged_test_cases table must be untouched by tenant A's shadow test");
  });
}
