// apiMounts.js - the ONE place that decides which URL prefixes serve an API
// route group, so the versioned alias cannot drift from the original mount.
//
// Every route group is reachable at both `/api/<name>` (the original, kept for
// backwards compatibility) and `/api/v1/<name>` (the stable, versioned path).
// They are the SAME router instance, so behaviour cannot diverge between them.
//
// WHY THIS IS A MODULE AND NOT TWO LINES IN index.js: tenantGuard.js switches
// off route groups that are not tenant-aware in multi-tenant mode, and it did
// so by registering a guard at the exact path `/api/<name>` and matching
// `req.baseUrl === "/api/<name>"`. A plain `app.use("/api/v1/<name>", router)`
// next to that would have SKIPPED the guard entirely - a not-yet-tenant-aware
// group would answer on /api/v1 with the default tenant's data while /api
// correctly answered 501. Mounting and guarding therefore both go through
// here, and the guard also normalises /api/v1 itself (canonicalApiPath) as a
// second line of defence.
//
// Deliberately NOT versioned (mounted by index.js directly, at one path):
//   * POST /api/billing/webhook - Stripe is configured with that exact URL and
//     needs the raw body (registered before the JSON parser);
//   * /api/platform/* - the operator surface; a versioned public alias buys
//     nothing and widens what is exposed;
//   * /api/health - liveness, not part of the product API.

const API_PREFIXES = ["/api", "/api/v1"];

// "/api/v1/costs" -> "/api/costs"; anything else is returned unchanged. Used so
// a path-keyed decision (the tenant guard's list) is made once, on the
// canonical name, however the request arrived.
function canonicalApiPath(p) {
  return typeof p === "string" ? p.replace(/^\/api\/v1(?=\/|$)/, "/api") : p;
}

// `routePath` is written the way it always was: "/api/costs".
function versionedPaths(routePath) {
  if (!/^\/api\/[^/]/.test(routePath)) {
    throw new Error(`mountApi expects a path like "/api/<name>", got '${routePath}'`);
  }
  const name = routePath.slice("/api".length); // "/costs"
  return API_PREFIXES.map((prefix) => prefix + name);
}

function mountApi(app, routePath, ...handlers) {
  for (const p of versionedPaths(routePath)) app.use(p, ...handlers);
}

module.exports = { API_PREFIXES, canonicalApiPath, versionedPaths, mountApi };
