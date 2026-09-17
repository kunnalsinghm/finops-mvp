// scripts/loadtest.js - concurrent load test for the proxy, against the
// mock provider (scripts/mock-provider.js) so this is zero real API cost
// and repeatable. This is the "genuinely load-tested proxy" item the
// product plan calls out as the highest-risk, hardest-to-fake gap - it's
// deliberately NOT a code feature, it's a tool you run and read the
// output of, since "the proxy is fast enough" isn't something that can be
// asserted by a unit test.
//
// Deliberately written with ZERO new dependencies (plain http/fetch, no
// autocannon/k6/artillery) - matching this codebase's own existing
// philosophy of a lean dependency set and its own test suite's "zero
// external test dependencies" choice (see package.json: `npm test` is
// `node --test`, nothing else). Load-testing tooling is exactly the kind
// of thing that's easy to justify as "just a devDependency," but this
// script is simple enough not to need one.
//
// USAGE:
//   1. node scripts/mock-provider.js                     (in one terminal)
//   2. OPENAI_BASE_URL=http://localhost:5001/v1/chat/completions \
//      ANTHROPIC_BASE_URL=http://localhost:5001/v1/messages \
//      node server/index.js                               (in another)
//   3. node scripts/loadtest.js                          (in a third)
//
// Reads FINOPS_LOAD_TEST_* env vars for configuration (all optional):
//   FINOPS_LOAD_TEST_URL           default http://127.0.0.1:4000
//   FINOPS_LOAD_TEST_API_KEY       default: auto-provisions one via bootstrap
//   FINOPS_LOAD_TEST_CONCURRENCY   default 20
//   FINOPS_LOAD_TEST_TOTAL         default 500
//   FINOPS_LOAD_TEST_STREAMING     default false ("true" to test the SSE path)

const BASE_URL = process.env.FINOPS_LOAD_TEST_URL || "http://127.0.0.1:4000";
const CONCURRENCY = Number(process.env.FINOPS_LOAD_TEST_CONCURRENCY) || 20;
const TOTAL_REQUESTS = Number(process.env.FINOPS_LOAD_TEST_TOTAL) || 500;
const USE_STREAMING = process.env.FINOPS_LOAD_TEST_STREAMING === "true";

async function ensureApiKey() {
  if (process.env.FINOPS_LOAD_TEST_API_KEY) return process.env.FINOPS_LOAD_TEST_API_KEY;

  // Relies on bootstrap mode (see README) if no key/user exists yet on a
  // fresh instance - creates a real, dedicated key for this run rather
  // than silently reusing bootstrap's unrestricted access for every
  // request, so the numbers reflect a REAL authenticated key's path
  // through governance (rate limiting, quotas, etc.), not the bootstrap
  // shortcut.
  const label = `load-test-${Date.now()}`;
  const res = await fetch(`${BASE_URL}/api/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, role: "developer" }),
  });
  if (!res.ok) {
    throw new Error(
      `Could not auto-provision a load-test API key (HTTP ${res.status}). ` +
        `Either the server isn't reachable at ${BASE_URL}, or bootstrap mode is already closed - ` +
        `in that case set FINOPS_LOAD_TEST_API_KEY to an existing key yourself.`
    );
  }
  const body = await res.json();
  return body.key_id;
}

function percentile(sortedLatencies, p) {
  if (sortedLatencies.length === 0) return null;
  const idx = Math.min(sortedLatencies.length - 1, Math.floor((p / 100) * sortedLatencies.length));
  return sortedLatencies[idx];
}

async function fireOneRequest(apiKey) {
  const start = performance.now();
  try {
    const res = await fetch(`${BASE_URL}/api/proxy/openai`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "X-Provider-Key": "load-test-fake-upstream-key",
        "X-Team": "load-test",
        "X-Environment": "load-test",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: USE_STREAMING,
        messages: [{ role: "user", content: "Say a short sentence about load testing." }],
      }),
    });

    if (USE_STREAMING && res.ok) {
      // Drain the stream fully - latency should reflect time-to-completion,
      // not just time-to-first-byte, since that's what a real client waits for.
      const reader = res.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } else {
      await res.text();
    }

    const latencyMs = performance.now() - start;
    return { ok: res.ok, status: res.status, latencyMs };
  } catch (err) {
    return { ok: false, status: 0, latencyMs: performance.now() - start, error: err.message };
  }
}

async function runWorker(apiKey, remainingCounter, results) {
  while (remainingCounter.count > 0) {
    remainingCounter.count--;
    results.push(await fireOneRequest(apiKey));
  }
}

async function main() {
  console.log(`FinOps Guard proxy load test`);
  console.log(`  Target:      ${BASE_URL}/api/proxy/openai`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Requests:    ${TOTAL_REQUESTS}`);
  console.log(`  Streaming:   ${USE_STREAMING}`);
  console.log(`  IMPORTANT: this hits real upstream URLs unless OPENAI_BASE_URL points at`);
  console.log(`  scripts/mock-provider.js on the SERVER process - verify before running`);
  console.log(`  against anything other than a local mock, or this will spend real money.\n`);

  const apiKey = await ensureApiKey();
  console.log(`Using API key: ${apiKey}\n`);

  const results = [];
  const remainingCounter = { count: TOTAL_REQUESTS };
  const wallStart = performance.now();

  const workers = Array.from({ length: CONCURRENCY }, () => runWorker(apiKey, remainingCounter, results));
  await Promise.all(workers);

  const wallMs = performance.now() - wallStart;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const successCount = results.filter((r) => r.ok).length;
  const errorCount = results.length - successCount;
  const statusCounts = {};
  for (const r of results) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;

  console.log("--- Results ---");
  console.log(`Total requests:     ${results.length}`);
  console.log(`Successful (2xx):   ${successCount}`);
  console.log(`Errors:             ${errorCount}`);
  console.log(`Status breakdown:   ${JSON.stringify(statusCounts)}`);
  console.log(`Wall time:          ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`Throughput:         ${(results.length / (wallMs / 1000)).toFixed(1)} req/s`);
  console.log(`Latency p50:        ${percentile(latencies, 50)?.toFixed(1)}ms`);
  console.log(`Latency p95:        ${percentile(latencies, 95)?.toFixed(1)}ms`);
  console.log(`Latency p99:        ${percentile(latencies, 99)?.toFixed(1)}ms`);
  console.log(`Latency max:        ${latencies[latencies.length - 1]?.toFixed(1)}ms`);

  if (errorCount > 0) {
    console.log(`\n${errorCount} request(s) failed - inspect status codes above and server logs before trusting this configuration under real traffic.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Load test failed to run:", err.message);
  process.exitCode = 1;
});
