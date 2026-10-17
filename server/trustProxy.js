// trustProxy.js - FINOPS_TRUST_PROXY (RFC 0001, phase A2).
//
// WHY: behind a load balancer or reverse proxy, Express reports the socket
// peer as req.ip, so every client looks like the proxy. The per-IP login and
// forgot-password limiters (loginRateLimit.js, the only users of req.ip)
// then share one global bucket. Express's "trust proxy" setting fixes that,
// but a wrong value is worse than none: trusting too much lets any client
// choose its own address by sending X-Forwarded-For, which defeats the very
// limiters this is meant to repair.
//
// So this is opt-in and strict:
//   - unset / empty  -> nothing is set; behaviour is exactly as before.
//   - "1".."32"      -> trust that many hops from the socket.
//   - IP / CIDR list -> trust only those addresses (comma separated).
//                       Express keywords loopback, linklocal, uniquelocal
//                       are accepted too.
//   - anything else, including "true" and any range that matches every
//     address (0.0.0.0/0, ::/0), throws. The server refuses to start rather
//     than quietly trusting everyone.

const net = require("node:net");

const NAME = "FINOPS_TRUST_PROXY";
const MAX_HOPS = 32;
const KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

function fail(raw, why) {
  throw new Error(
    `${NAME}=${JSON.stringify(raw)} is not valid: ${why}. ` +
      `Use a hop count (1-${MAX_HOPS}) or a comma-separated list of proxy IPs/CIDRs ` +
      `(for example "10.0.0.0/8,192.168.1.5"). "true" and ranges that match every address are refused ` +
      `because they let clients fake their address. Unset ${NAME} to trust no proxy.`
  );
}

function validateEntry(raw, entry) {
  if (!entry) fail(raw, "empty entry in the list");
  if (KEYWORDS.has(entry)) return entry;
  const slash = entry.indexOf("/");
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = net.isIP(addr);
  if (!family) fail(raw, `${JSON.stringify(entry)} is not an IP address, CIDR or keyword`);
  if (slash !== -1) {
    const prefixText = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) fail(raw, `${JSON.stringify(entry)} has a malformed prefix length`);
    const prefix = Number(prefixText);
    const max = family === 4 ? 32 : 128;
    if (prefix > max) fail(raw, `${JSON.stringify(entry)} has a prefix length above ${max}`);
    if (prefix === 0) fail(raw, `${JSON.stringify(entry)} matches every address`);
  }
  return entry;
}

// Returns undefined (leave Express alone), a number, or an array of strings.
// Throws an Error that names FINOPS_TRUST_PROXY on any invalid value.
function parseTrustProxy(value) {
  if (value === undefined || value === null) return undefined;
  const raw = String(value);
  const text = raw.trim();
  if (text === "") return undefined;

  if (/^-?\d+(\.\d+)?$/.test(text)) {
    if (!/^\d+$/.test(text)) fail(raw, "a hop count must be a whole number");
    const hops = Number(text);
    if (hops < 1) fail(raw, "a hop count must be at least 1");
    if (hops > MAX_HOPS) fail(raw, `a hop count above ${MAX_HOPS} is not plausible and would let clients fake their address`);
    return hops;
  }

  return text.split(",").map((part) => validateEntry(raw, part.trim()));
}

// Applies the setting to an Express app. Validation happens first, so an
// invalid value throws without having changed the app.
function applyTrustProxy(app, value) {
  const parsed = parseTrustProxy(value);
  if (parsed !== undefined) app.set("trust proxy", parsed);
  return parsed;
}

module.exports = { parseTrustProxy, applyTrustProxy, NAME };
