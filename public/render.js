/* render.js - how the dashboard turns server data into HTML, safely.
 *
 * WHY THIS EXISTS. dashboard.js used to build every table, alert and audit entry
 * with template strings assigned to innerHTML, interpolating server strings
 * directly. Many of those strings are chosen by whoever holds an API key: the model
 * name (any string in a proxy or ingest request), team, agent id, key label, the
 * message of an alert built from those, and the actor/target of an audit entry. A
 * model name like <img src=x onerror=...> therefore became a live element in an
 * administrator's dashboard (stored XSS). The Content-Security-Policy
 * (script-src 'self', script-src-attr 'none') stops a browser running such a
 * handler, but markup injection (spoofed links and text) still renders, and one
 * loosened directive would turn it back into script execution. So the escaping is
 * done here too, by construction rather than by remembering:
 *
 *   html`<td>${value}</td>`   every ${value} is HTML-escaped unless it is itself
 *                             the result of html`` (SafeHtml) or an array of those.
 *   setHtml(el, safe)         the ONLY place that assigns innerHTML; it refuses
 *                             anything that did not come from html``.
 *
 * test/dashboardRender.test.js enforces both: no template literal containing markup
 * may be untagged, and no code outside this file may assign innerHTML.
 *
 * Browser: loaded by a plain <script> before dashboard.js and exposed as
 * window.FinopsRender. Node: require()d by the tests. The builders are pure
 * (data in, SafeHtml out); they never touch the DOM.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FinopsRender = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  // Escapes for HTML text AND attribute values (both quote characters), so one function
  // is safe in either position. null and undefined become the empty string.
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  // Markup that is safe to put in innerHTML. Only html`` and raw() make one.
  class SafeHtml {
    constructor(text) {
      this.text = text;
    }
    toString() {
      return this.text;
    }
  }

  function fragment(value) {
    if (value instanceof SafeHtml) return value.text;
    if (Array.isArray(value)) return value.map(fragment).join("");
    return escapeHtml(value);
  }

  // Tagged template: literal parts are the author's markup and pass through; every
  // interpolated value is escaped unless it is SafeHtml (or an array of values).
  function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += fragment(values[i]) + strings[i + 1];
    return new SafeHtml(out);
  }

  // Marks a string as already-safe markup. Use only for constants, never for data.
  function raw(text) {
    return new SafeHtml(String(text));
  }

  // The only innerHTML assignment in the dashboard.
  function setHtml(element, safe) {
    if (!(safe instanceof SafeHtml)) {
      throw new TypeError("setHtml needs the result of html`...`; a plain string would bypass escaping");
    }
    element.innerHTML = safe.text;
  }

  const fmtUsd = (n) => `$${Number(n || 0).toFixed(2)}`;

  const MESSAGE_COLORS = { danger: "var(--danger)", good: "var(--good)" };

  // ---- builders: one per dashboard panel --------------------------------

  const loginStatusHtml = (username) =>
    html`Logged in as <strong>${username}</strong> &middot; <a href="#" id="logoutLink" style="color:var(--signal);">log out</a>`;

  // A one-line status message: kind is "danger" or "good".
  const messageHtml = (kind, text) =>
    html`<span style="color:${MESSAGE_COLORS[kind] || MESSAGE_COLORS.danger};">${text}</span>`;

  const cardsHtml = () => html`
    <div class="card live stagger-in" style="animation-delay:0.02s;"><div class="label">Total Spend</div><div class="value" id="v-total">$0.00</div></div>
    <div class="card stagger-in" style="animation-delay:0.06s;"><div class="label">Spend Today</div><div class="value" id="v-today">$0.00</div></div>
    <div class="card stagger-in" style="animation-delay:0.10s;"><div class="label">Total Events</div><div class="value" id="v-events">0</div></div>
    <div class="card stagger-in" style="animation-delay:0.14s;"><div class="label">Untagged Spend</div><div class="value" id="v-untagged">$0.00</div></div>
  `;

  const errorCardHtml = (message, suffix = "") =>
    html`<div class="card"><div class="label">Error</div><div class="value" style="font-size:14px;color:var(--danger);font-family:var(--font-ui);">${message}${suffix}</div></div>`;

  const modelRowsHtml = (rows) =>
    rows.map((r) => html`<tr><td>${r.provider}</td><td>${r.model}</td><td>${r.event_count}</td><td>${fmtUsd(r.total_cost)}</td></tr>`);

  const budgetRowsHtml = (rows) => {
    if (!rows.length) {
      return html`<tr><td colspan="4" style="color:var(--text-faint);font-family:var(--font-ui);">No budgets set. POST to /api/budgets to add one.</td></tr>`;
    }
    return rows.map((r) => html`<tr>
        <td style="font-family:var(--font-ui);">${r.scope_type}: ${r.scope_value}</td>
        <td>${fmtUsd(r.spent_this_month)}</td>
        <td>${fmtUsd(r.monthly_limit_usd)}</td>
        <td class="tier-${r.alert_tier}">${r.pct_used}% (${r.alert_tier})</td>
      </tr>`);
  };

  const recommendationsHtml = (items) => {
    if (!items.length) {
      return html`<div style="color:var(--text-faint);font-size:13px;">No recommendations yet — need more usage data.</div>`;
    }
    return items.map((r) => html`<div style="border-bottom:1px solid var(--border);padding:10px 0;font-size:13px;">
        <strong>${r.current.provider}/${r.current.model}</strong> → <strong>${r.suggested.provider}/${r.suggested.model}</strong>
        <span style="color:var(--good);font-family:var(--font-data);"> save ~${fmtUsd(r.estimated_savings_usd)} (${r.estimated_savings_pct}%)</span>
        <div style="color:var(--text-faint);margin-top:4px;font-size:12px;">${r.caveat}</div>
      </div>`);
  };

  const alertsHtml = (rows) => {
    if (!rows.length) return html`<div style="color:var(--text-faint);font-size:13px;">No alerts yet.</div>`;
    return rows.slice(0, 10).map((a) => html`<div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:13px;">
        <span style="color:var(--money);text-transform:uppercase;font-size:10.5px;font-weight:600;letter-spacing:0.04em;">${a.type}</span>
        <div style="margin-top:2px;">${a.message}</div>
        <div style="color:var(--text-faint);font-size:11px;font-family:var(--font-data);margin-top:2px;">${a.created_at}</div>
      </div>`);
  };

  const reconcileRowsHtml = (rows) => {
    if (!rows.length) {
      return html`<tr><td colspan="6" style="color:var(--text-faint);font-family:var(--font-ui);">No billing exports uploaded yet.</td></tr>`;
    }
    return rows.map((r) => html`<tr>
        <td>${r.day}</td>
        <td style="font-family:var(--font-ui);">${r.provider}</td>
        <td>${fmtUsd(r.reported_cost)}</td>
        <td>${fmtUsd(r.tracked_cost)}</td>
        <td class="${r.flagged ? "tier-exceeded" : "tier-ok"}">${fmtUsd(r.gap_usd)} (${r.gap_pct}%)</td>
        <td class="${r.flagged ? "tier-exceeded" : "tier-ok"}" style="font-family:var(--font-ui);">${r.flagged ? "⚠ Shadow spend" : "OK"}</td>
      </tr>`);
  };

  const reconcileErrorRowHtml = (message) =>
    html`<tr><td colspan="6" style="color:var(--danger)">${message}</td></tr>`;

  const backupRowsHtml = (rows) => {
    if (!rows || !rows.length) {
      return html`<tr><td colspan="3" style="color:var(--text-faint);font-family:var(--font-ui);">No backups yet, or admin access required to view.</td></tr>`;
    }
    return rows.slice(0, 5).map((b) => html`<tr>
        <td style="font-family:var(--font-ui);font-size:12px;">${b.name}</td>
        <td>${(b.sizeBytes / 1024).toFixed(1)} KB</td>
        <td style="font-size:11px;">${new Date(b.createdAt).toLocaleString()}</td>
      </tr>`);
  };

  const auditHtml = (rows) => {
    if (!rows || !rows.length) {
      return html`<div style="color:var(--text-faint);font-size:13px;">No audit entries yet, or admin access required to view.</div>`;
    }
    return rows.slice(0, 10).map((a) => html`<div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:13px;">
        <span style="color:var(--signal);font-family:var(--font-data);font-size:11.5px;">${a.action}</span>
        <span style="color:var(--text-muted);"> by ${a.actor}${a.target ? html` &rarr; ${a.target}` : ""}</span>
        <div style="color:var(--text-faint);font-size:11px;font-family:var(--font-data);margin-top:2px;">${a.created_at}</div>
      </div>`);
  };

  // A builder may produce a list of row fragments; callers (and setHtml) want ONE SafeHtml.
  const one = (build) => (...args) => {
    const out = build(...args);
    return out instanceof SafeHtml ? out : html`${out}`;
  };

  return {
    escapeHtml, html, raw, setHtml, SafeHtml, fmtUsd,
    loginStatusHtml, messageHtml, cardsHtml, errorCardHtml, reconcileErrorRowHtml,
    modelRowsHtml: one(modelRowsHtml),
    budgetRowsHtml: one(budgetRowsHtml),
    recommendationsHtml: one(recommendationsHtml),
    alertsHtml: one(alertsHtml),
    reconcileRowsHtml: one(reconcileRowsHtml),
    backupRowsHtml: one(backupRowsHtml),
    auditHtml: one(auditHtml),
  };
});
