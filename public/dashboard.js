/* dashboard.js - FinOps console. Vanilla JS, no build step.
   Motion layer (spotlight, reveal, count-up, sparkline, skeletons) is native
   and gated by prefers-reduced-motion. */

const $ = (id) => document.getElementById(id);
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Escape anything that came from the API before it touches innerHTML. */
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (d) => new Intl.NumberFormat("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt$ = (n) => `$${nf(2).format(Number(n || 0))}`;

const ICON_EMPTY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>`;
const empty = (msg) => `<div class="empty">${ICON_EMPTY}<span>${esc(msg)}</span></div>`;
const emptyRow = (cols, msg) => `<tr><td colspan="${cols}" class="faint" style="font-family:var(--font-ui)">${esc(msg)}</td></tr>`;

/* ---------------------------------------------------------------- */
/* Toasts                                                             */
/* ---------------------------------------------------------------- */
function toast(msg, type = "info") {
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.textContent = msg;
  $("toasts").appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 260);
  }, 3800);
}

/* ---------------------------------------------------------------- */
/* Motion helpers: spotlight cursor glow + scroll reveal              */
/* ---------------------------------------------------------------- */
document.addEventListener(
  "pointermove",
  (e) => {
    const el = e.target.closest && e.target.closest(".spot");
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  },
  { passive: true }
);

const revealObserver =
  "IntersectionObserver" in window && !prefersReducedMotion
    ? new IntersectionObserver(
        (entries) => entries.forEach((en) => {
          if (en.isIntersecting) { en.target.classList.add("in"); revealObserver.unobserve(en.target); }
        }),
        { threshold: 0.06 }
      )
    : null;
document.querySelectorAll(".reveal").forEach((el) => (revealObserver ? revealObserver.observe(el) : el.classList.add("in")));

/* Count-up (the 21st.dev "Number Ticker" idea, in ~15 lines) */
function animateValue(el, endValue, { prefix = "", decimals = 2, duration = 800 } = {}) {
  const format = (v) => prefix + nf(decimals).format(v);
  if (prefersReducedMotion) { el.textContent = format(endValue); return; }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(endValue * (1 - Math.pow(1 - t, 3)));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- */
/* Theme                                                              */
/* ---------------------------------------------------------------- */
const htmlEl = document.documentElement;
function applyTheme(theme) {
  htmlEl.setAttribute("data-theme", theme);
  $("themeLight").classList.toggle("active", theme === "light");
  $("themeDark").classList.toggle("active", theme === "dark");
  try { localStorage.setItem("finops_theme", theme); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#f6f8fb" : "#020617";
  if (window.__finopsChartData) renderCharts(window.__finopsChartData.byTime, window.__finopsChartData.byTeam, false);
}
const themeColor = (v) => getComputedStyle(htmlEl).getPropertyValue(v).trim();
applyTheme(htmlEl.getAttribute("data-theme") || "dark");
$("themeLight").addEventListener("click", () => applyTheme("light"));
$("themeDark").addEventListener("click", () => applyTheme("dark"));

/* ---------------------------------------------------------------- */
/* Auth                                                               */
/* ---------------------------------------------------------------- */
const apiKeyInput = $("apiKeyInput");
const loginUsername = $("loginUsername");
const loginPassword = $("loginPassword");
const loginMsg = $("loginMsg");
const loginStatus = $("loginStatus");

apiKeyInput.value = localStorage.getItem("finops_api_key") || "";
apiKeyInput.addEventListener("change", () => {
  localStorage.setItem("finops_api_key", apiKeyInput.value.trim());
  syncAccessPanel();
  loadDashboard();
});

const hashMatch = location.hash.match(/session=([^&]+)/);
if (hashMatch) {
  localStorage.setItem("finops_session_token", hashMatch[1]);
  history.replaceState(null, "", location.pathname);
}
const getSessionToken = () => localStorage.getItem("finops_session_token") || "";

function syncAccessPanel() {
  const authed = Boolean(getSessionToken() || apiKeyInput.value.trim());
  $("accessPanel").open = !authed; // collapse once you're in; one click to reopen
  const badge = $("accessState");
  badge.textContent = authed ? "Authenticated" : "Not signed in";
  badge.className = `badge ${authed ? "ok" : "warn"}`;
}

function updateLoginStatus() {
  const token = getSessionToken();
  const username = localStorage.getItem("finops_session_username");
  if (token && username) {
    loginStatus.innerHTML = `Signed in as <strong>${esc(username)}</strong> &middot; <a href="#" id="logoutLink">log out</a>`;
    $("logoutLink").addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem("finops_session_token");
      localStorage.removeItem("finops_session_username");
      updateLoginStatus();
      syncAccessPanel();
      toast("Signed out", "info");
      loadDashboard();
    });
  } else {
    loginStatus.textContent = "";
  }
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = `status-line${kind ? " " + kind : ""}`;
}

$("loginBtn").addEventListener("click", async () => {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  if (!username || !password) return setMsg(loginMsg, "Enter a username and password", "err");
  setMsg(loginMsg, "Logging in…");
  $("loginBtn").disabled = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Login failed");
    localStorage.setItem("finops_session_token", body.token);
    localStorage.setItem("finops_session_username", body.username);
    loginPassword.value = "";
    setMsg(loginMsg, "");
    updateLoginStatus();
    syncAccessPanel();
    toast(`Welcome back, ${body.username}`, "ok");
    loadDashboard();
  } catch (err) {
    setMsg(loginMsg, err.message, "err");
  } finally {
    $("loginBtn").disabled = false;
  }
});
[loginUsername, loginPassword].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginBtn").click(); }));

function authHeaders() {
  const session = getSessionToken();
  if (session) return { "X-Session-Token": session };
  const key = apiKeyInput.value.trim();
  return key ? { "X-API-Key": key } : {};
}

async function getJSON(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${url} -> ${res.status}`);
  }
  return res.json();
}

/* ---------------------------------------------------------------- */
/* Sparkline + KPI cards                                              */
/* ---------------------------------------------------------------- */
function sparkline(values, w = 120, h = 40) {
  if (values.length < 2) return "";
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values
    .map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 8)).toFixed(1)}`)
    .join("");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" d="${d}L${w},${h}L0,${h}Z"/><path class="spark-line" d="${d}" pathLength="1"/></svg>`;
}

function deltaChip(pct) {
  if (pct === null || !isFinite(pct)) return "";
  const cls = Math.abs(pct) < 1 ? "flat" : pct > 0 ? "up" : "down";
  const arrow = cls === "flat" ? "→" : pct > 0 ? "↑" : "↓";
  return `<span class="delta ${cls}" title="Today so far vs. the average daily spend">${arrow} ${Math.abs(pct).toFixed(1)}%</span><span>vs daily avg</span>`;
}

function renderCards(summary, untagged, byTime) {
  const total = Number(summary.total_cost || 0);
  const today = Number(summary.today_cost || 0);
  const events = Number(summary.event_count || 0);
  const untag = Number(untagged.total_untagged_cost || 0);
  const series = byTime.map((r) => Number(r.total_cost || 0));
  const avgDaily = series.length ? series.reduce((a, b) => a + b, 0) / series.length : 0;
  const delta = avgDaily > 0 ? ((today - avgDaily) / avgDaily) * 100 : null;
  const untagPct = total > 0 ? (untag / total) * 100 : 0;
  const untagBadge = untag === 0 ? `<span class="badge ok">All tagged</span>` : `<span class="badge ${untagPct > 20 ? "bad" : "warn"}">${untagPct.toFixed(1)}% of spend</span>`;

  $("summaryCards").innerHTML = `
    <div class="card live spot stagger-in" style="--d:.02s"><div class="label">Total Spend</div><div class="value" id="v-total">$0.00</div><div class="meta">${series.length ? `${series.length}-day trend` : "No data yet"}</div>${sparkline(series)}</div>
    <div class="card spot stagger-in" style="--d:.07s"><div class="label">Spend Today</div><div class="value" id="v-today">$0.00</div><div class="meta">${deltaChip(delta) || "Not enough history"}</div></div>
    <div class="card spot stagger-in" style="--d:.12s"><div class="label">Total Events</div><div class="value" id="v-events">0</div><div class="meta">${series.length ? `~${nf(0).format(events / series.length)} per day` : ""}</div></div>
    <div class="card spot stagger-in" style="--d:.17s"><div class="label">Untagged Spend</div><div class="value" id="v-untagged">$0.00</div><div class="meta">${untagBadge}</div></div>`;
  animateValue($("v-total"), total, { prefix: "$" });
  animateValue($("v-today"), today, { prefix: "$" });
  animateValue($("v-events"), events, { decimals: 0 });
  animateValue($("v-untagged"), untag, { prefix: "$" });
}

/* ---------------------------------------------------------------- */
/* Charts                                                             */
/* ---------------------------------------------------------------- */
let timeChartInstance, teamChartInstance, chartsAnimated = false;

function renderCharts(byTime, byTeam, allowAnimation = true) {
  window.__finopsChartData = { byTime, byTeam };
  const animate = allowAnimation && !chartsAnimated && !prefersReducedMotion;
  const animation = animate ? { duration: 1000, easing: "easeOutQuart" } : false;
  const gridColor = themeColor("--border");
  const tickColor = themeColor("--text-muted");
  const signal = themeColor("--c1");
  const palette = [1, 2, 3, 4, 5, 6].map((i) => themeColor(`--c${i}`));

  Chart.defaults.font.family = '"Fira Sans", system-ui, sans-serif';
  Chart.defaults.color = tickColor;
  const tooltip = {
    backgroundColor: themeColor("--surface-2"), borderColor: themeColor("--border-strong"), borderWidth: 1,
    titleColor: themeColor("--text"), bodyColor: themeColor("--text-muted"),
    padding: 10, cornerRadius: 8, displayColors: true, boxPadding: 4,
  };

  if (timeChartInstance) timeChartInstance.destroy();
  if (teamChartInstance) teamChartInstance.destroy();

  const tctx = $("timeChart").getContext("2d");
  const grad = tctx.createLinearGradient(0, 0, 0, 260);
  grad.addColorStop(0, signal + "55");
  grad.addColorStop(1, signal + "00");

  timeChartInstance = new Chart($("timeChart"), {
    type: "line",
    data: {
      labels: byTime.map((r) => r.day),
      datasets: [{ label: "Daily cost", data: byTime.map((r) => r.total_cost), borderColor: signal, backgroundColor: grad, borderWidth: 2, tension: 0.38, fill: true, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: signal, pointHoverBorderColor: themeColor("--surface"), pointHoverBorderWidth: 2 }],
    },
    options: {
      maintainAspectRatio: false, animation,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (c) => ` ${fmt$(c.parsed.y)}` } } },
      scales: {
        x: { ticks: { color: tickColor, font: { size: 11 }, maxTicksLimit: 8 }, grid: { display: false }, border: { color: gridColor } },
        y: { beginAtZero: true, ticks: { color: tickColor, font: { size: 11 }, callback: (v) => "$" + v }, grid: { color: gridColor }, border: { display: false } },
      },
    },
  });

  teamChartInstance = new Chart($("teamChart"), {
    type: "doughnut",
    data: { labels: byTeam.map((r) => r.team || "Untagged"), datasets: [{ data: byTeam.map((r) => r.total_cost), backgroundColor: palette, borderColor: themeColor("--surface"), borderWidth: 3, borderRadius: 4, hoverOffset: 6 }] },
    options: {
      maintainAspectRatio: false, animation, cutout: "68%",
      plugins: {
        legend: { position: "bottom", labels: { color: themeColor("--text"), boxWidth: 10, boxHeight: 10, usePointStyle: true, font: { size: 11.5 } } },
        tooltip: { ...tooltip, callbacks: { label: (c) => ` ${c.label}: ${fmt$(c.parsed)}` } },
      },
    },
  });
  if (allowAnimation) chartsAnimated = true;
}

/* ---------------------------------------------------------------- */
/* Tables & lists                                                     */
/* ---------------------------------------------------------------- */
function growMeters(root) {
  requestAnimationFrame(() => requestAnimationFrame(() =>
    root.querySelectorAll(".meter > i[data-w]").forEach((i) => { i.style.width = i.dataset.w + "%"; })
  ));
}

function renderModelTable(rows) {
  const tbody = document.querySelector("#modelTable tbody");
  if (!rows.length) { tbody.innerHTML = emptyRow(5, "No usage recorded yet."); return; }
  const total = rows.reduce((s, r) => s + Number(r.total_cost || 0), 0) || 1;
  tbody.innerHTML = rows
    .map((r) => {
      const share = (Number(r.total_cost || 0) / total) * 100;
      return `<tr><td>${esc(r.provider)}</td><td>${esc(r.model)}</td><td class="num">${nf(0).format(r.event_count)}</td><td class="num">${fmt$(r.total_cost)}</td>
        <td><div class="status-cell"><div class="meter neutral"><i data-w="${share.toFixed(1)}"></i></div><span class="muted">${share.toFixed(0)}%</span></div></td></tr>`;
    })
    .join("");
  growMeters(tbody);
}

const TIER_BADGE = { ok: ["ok", "On track"], 50: ["ok", "50%"], 80: ["warn", "80%"], 90: ["warn", "90%"], exceeded: ["bad", "Over budget"] };
function renderBudgetTable(rows) {
  const tbody = document.querySelector("#budgetTable tbody");
  if (!rows.length) { tbody.innerHTML = emptyRow(4, "No budgets set. POST to /api/budgets to add one."); return; }
  tbody.innerHTML = rows
    .map((r) => {
      const pct = Math.max(0, Math.min(100, Number(r.pct_used || 0)));
      const [cls, label] = TIER_BADGE[r.alert_tier] || ["info", r.alert_tier];
      return `<tr><td>${esc(r.scope_type)}: ${esc(r.scope_value)}</td><td class="num">${fmt$(r.spent_this_month)}</td><td class="num">${fmt$(r.monthly_limit_usd)}</td>
        <td><div class="status-cell"><div class="meter t-${esc(r.alert_tier)}"><i data-w="${pct}"></i></div><span class="badge ${cls}" title="${esc(r.pct_used)}% used">${esc(r.pct_used)}% · ${esc(label)}</span></div></td></tr>`;
    })
    .join("");
  growMeters(tbody);
}

function renderRecommendations(data) {
  const items = (data && data.model_switch) || [];
  $("recommendations").innerHTML = items.length
    ? items.map((r) => `<div class="item"><div class="row"><span><strong>${esc(r.current.provider)}/${esc(r.current.model)}</strong> → <strong>${esc(r.suggested.provider)}/${esc(r.suggested.model)}</strong></span>
        <span class="badge ok">Save ~${fmt$(r.estimated_savings_usd)} · ${esc(r.estimated_savings_pct)}%</span></div><div class="sub">${esc(r.caveat)}</div></div>`).join("")
    : empty("No recommendations yet — need more usage data.");
}

function renderAlerts(rows) {
  $("alerts").innerHTML = rows.length
    ? rows.slice(0, 10).map((a) => `<div class="item"><div class="row"><span class="badge warn">${esc(a.type)}</span></div><div style="margin-top:6px">${esc(a.message)}</div><div class="stamp">${esc(a.created_at)}</div></div>`).join("")
    : empty("No alerts yet.");
}

function renderReconcileTable(rows) {
  const tbody = document.querySelector("#reconcileTable tbody");
  if (!rows.length) { tbody.innerHTML = emptyRow(6, "No billing exports uploaded yet."); return; }
  tbody.innerHTML = rows
    .map((r) => `<tr><td>${esc(r.day)}</td><td style="font-family:var(--font-ui)">${esc(r.provider)}</td><td class="num">${fmt$(r.reported_cost)}</td><td class="num">${fmt$(r.tracked_cost)}</td>
      <td class="num ${r.flagged ? "tier-exceeded" : "tier-ok"}">${fmt$(r.gap_usd)} (${esc(r.gap_pct)}%)</td>
      <td><span class="badge ${r.flagged ? "bad" : "ok"}">${r.flagged ? "Shadow spend" : "OK"}</span></td></tr>`)
    .join("");
}

function renderBackupTable(rows) {
  const tbody = document.querySelector("#backupTable tbody");
  if (!rows || !rows.length) { tbody.innerHTML = emptyRow(3, "No backups yet, or admin access required to view."); return; }
  tbody.innerHTML = rows.slice(0, 5)
    .map((b) => `<tr><td style="font-size:12px">${esc(b.name)}</td><td class="num">${(b.sizeBytes / 1024).toFixed(1)} KB</td><td style="font-size:11px">${esc(new Date(b.createdAt).toLocaleString())}</td></tr>`)
    .join("");
}

function renderAuditLog(rows) {
  $("auditLog").innerHTML = rows && rows.length
    ? rows.slice(0, 10).map((a) => `<div class="item"><div class="row"><span class="badge info">${esc(a.action)}</span><span class="muted" style="font-size:12px">by ${esc(a.actor)}${a.target ? ` → ${esc(a.target)}` : ""}</span></div><div class="stamp">${esc(a.created_at)}</div></div>`).join("")
    : empty("No audit entries yet, or admin access required to view.");
}

/* ---------------------------------------------------------------- */
/* Secondary loaders (admin-gated ones fail gracefully)               */
/* ---------------------------------------------------------------- */
async function loadReconcileReport() {
  try { renderReconcileTable(await getJSON("/api/reconcile/report")); }
  catch (err) { document.querySelector("#reconcileTable tbody").innerHTML = emptyRow(6, err.message); }
}
async function loadCacheStats() {
  try {
    const s = await getJSON("/api/cache/stats");
    $("cacheHitRate").textContent = `${s.hit_rate_pct}%`;
    $("cacheSize").textContent = nf(0).format(s.current_size);
  } catch { $("cacheHitRate").textContent = "—"; $("cacheSize").textContent = "—"; }
}
async function loadBackups() { try { renderBackupTable(await getJSON("/api/backup")); } catch { renderBackupTable([]); } }
async function loadAuditLog() { try { renderAuditLog(await getJSON("/api/audit?limit=10")); } catch { renderAuditLog([]); } }

/* ---------------------------------------------------------------- */
/* Actions (registered once)                                          */
/* ---------------------------------------------------------------- */
$("reconcileUploadBtn").addEventListener("click", async () => {
  const fileInput = $("reconcileFile"), status = $("reconcileStatus");
  const file = fileInput.files[0];
  if (!file) return setMsg(status, "Choose a CSV file first", "err");
  setMsg(status, "Uploading…");
  try {
    const res = await fetch("/api/reconcile/upload", { method: "POST", headers: { ...authHeaders(), "Content-Type": "text/csv" }, body: await file.text() });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Upload failed");
    setMsg(status, `Imported ${body.rowCount} rows (${body.replacedDayProviderPairs} day/provider pairs replaced).`, "ok");
    toast("Billing CSV imported", "ok");
    fileInput.value = "";
    loadReconcileReport();
  } catch (err) { setMsg(status, err.message, "err"); }
});

$("runBackupBtn").addEventListener("click", async () => {
  const status = $("backupStatus");
  setMsg(status, "Running backup…");
  try {
    const res = await fetch("/api/backup/run", { method: "POST", headers: authHeaders() });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Backup failed");
    setMsg(status, "Backup created.", "ok");
    toast("Backup created", "ok");
    loadBackups();
  } catch (err) { setMsg(status, err.message, "err"); }
});

$("exportDataBtn").addEventListener("click", () => {
  fetch("/api/data/export?format=csv", { headers: authHeaders() })
    .then((res) => { if (!res.ok) throw new Error("Export failed - check you're logged in."); return res.blob(); })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: "finops_usage_export.csv" });
      a.click();
      URL.revokeObjectURL(url);
      toast("Export downloaded", "ok");
    })
    .catch((err) => toast(err.message, "error"));
});

/* ---------------------------------------------------------------- */
/* Main load + live-refresh                                           */
/* ---------------------------------------------------------------- */
let lastUpdated = null, loading = false;

function setSync(state, text) {
  $("syncPill").classList.toggle("error", state === "error");
  $("syncText").textContent = text;
}
function agoText() {
  if (!lastUpdated) return "Loading…";
  const s = Math.round((Date.now() - lastUpdated) / 1000);
  return s < 5 ? "Updated just now" : s < 60 ? `Updated ${s}s ago` : `Updated ${Math.round(s / 60)}m ago`;
}

async function loadDashboard() {
  if (loading) return;
  loading = true;
  $("refreshBtn").classList.add("spinning");
  try {
    const [summary, untagged, byTime, byTeam, byModel, budgetStatus, recommendations, alerts] = await Promise.all([
      getJSON("/api/costs/summary"), getJSON("/api/costs/untagged"), getJSON("/api/costs/over-time"), getJSON("/api/costs/by-team"),
      getJSON("/api/costs/by-model"), getJSON("/api/budgets/status"), getJSON("/api/recommendations"), getJSON("/api/alerts"),
    ]);
    renderCards(summary, untagged, byTime);
    renderCharts(byTime, byTeam);
    renderModelTable(byModel);
    renderBudgetTable(budgetStatus);
    renderRecommendations(recommendations);
    renderAlerts(alerts);
    loadReconcileReport(); loadCacheStats(); loadBackups(); loadAuditLog();
    lastUpdated = Date.now();
    setSync("ok", agoText());
  } catch (err) {
    $("summaryCards").innerHTML = `<div class="card"><div class="label">Error</div><div class="value" style="font-size:14px;color:var(--danger);font-family:var(--font-ui)">${esc(err.message)}</div><div class="meta">Check your login / API key, and that the server is running.</div></div>`;
    setSync("error", "Couldn't load data");
    toast(err.message, "error");
  } finally {
    loading = false;
    $("refreshBtn").classList.remove("spinning");
  }
}

$("refreshBtn").addEventListener("click", () => loadDashboard());
setInterval(() => { if (!document.hidden) loadDashboard(); }, 60000);        // live-ish: refresh each minute
setInterval(() => { if (lastUpdated && !$("syncPill").classList.contains("error")) setSync("ok", agoText()); }, 10000);

updateLoginStatus();
syncAccessPanel();
loadDashboard();
