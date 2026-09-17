const fmt$ = (n) => `$${Number(n || 0).toFixed(2)}`;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------------------------------------------------------------- */
/* Theme toggle                                                      */
/* ---------------------------------------------------------------- */
const themeLight = document.getElementById("themeLight");
const themeDark = document.getElementById("themeDark");
const htmlEl = document.documentElement;

function applyTheme(theme) {
  htmlEl.setAttribute("data-theme", theme);
  themeLight.classList.toggle("active", theme === "light");
  themeDark.classList.toggle("active", theme === "dark");
  localStorage.setItem("finops_theme", theme);
  // Re-render charts so Chart.js grid/label colors pick up the new theme
  if (window.__finopsChartData) renderCharts(window.__finopsChartData.byTime, window.__finopsChartData.byTeam);
}

const savedTheme = localStorage.getItem("finops_theme") || "dark";
applyTheme(savedTheme);
themeLight.addEventListener("click", () => applyTheme("light"));
themeDark.addEventListener("click", () => applyTheme("dark"));

function themeColor(varName) {
  return getComputedStyle(htmlEl).getPropertyValue(varName).trim();
}

/* ---------------------------------------------------------------- */
/* Auth                                                               */
/* ---------------------------------------------------------------- */
const apiKeyInput = document.getElementById("apiKeyInput");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginMsg = document.getElementById("loginMsg");
const loginStatus = document.getElementById("loginStatus");

apiKeyInput.value = localStorage.getItem("finops_api_key") || "";
apiKeyInput.addEventListener("change", () => {
  localStorage.setItem("finops_api_key", apiKeyInput.value.trim());
  loadDashboard();
});

const hashMatch = location.hash.match(/session=([^&]+)/);
if (hashMatch) {
  localStorage.setItem("finops_session_token", hashMatch[1]);
  history.replaceState(null, "", location.pathname);
}

function getSessionToken() {
  return localStorage.getItem("finops_session_token") || "";
}

function updateLoginStatus() {
  const token = getSessionToken();
  const username = localStorage.getItem("finops_session_username");
  if (token && username) {
    loginStatus.innerHTML = `Logged in as <strong>${username}</strong> &middot; <a href="#" id="logoutLink" style="color:var(--signal);">log out</a>`;
    document.getElementById("logoutLink")?.addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.removeItem("finops_session_token");
      localStorage.removeItem("finops_session_username");
      updateLoginStatus();
      loadDashboard();
    });
  } else {
    loginStatus.textContent = "";
  }
}
updateLoginStatus();

loginBtn.addEventListener("click", async () => {
  const username = loginUsername.value.trim();
  const password = loginPassword.value;
  if (!username || !password) {
    loginMsg.innerHTML = `<span style="color:var(--danger);">Enter a username and password</span>`;
    return;
  }
  loginMsg.textContent = "Logging in…";
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
    loginMsg.textContent = "";
    updateLoginStatus();
    loadDashboard();
  } catch (err) {
    loginMsg.innerHTML = `<span style="color:var(--danger);">${err.message}</span>`;
  }
});

function authHeaders() {
  const session = getSessionToken();
  if (session) return { "X-Session-Token": session };
  const key = apiKeyInput.value.trim();
  if (key) return { "X-API-Key": key };
  return {};
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
/* Count-up animation for card values                                */
/* ---------------------------------------------------------------- */
function animateValue(el, endValue, { prefix = "", decimals = 2, duration = 700 } = {}) {
  if (prefersReducedMotion) {
    el.textContent = prefix + endValue.toFixed(decimals);
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const current = endValue * eased;
    el.textContent = prefix + current.toFixed(decimals);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = prefix + endValue.toFixed(decimals);
  }
  requestAnimationFrame(tick);
}

/* ---------------------------------------------------------------- */
/* Renderers                                                          */
/* ---------------------------------------------------------------- */
function renderCards(summary, untagged) {
  const el = document.getElementById("summaryCards");
  el.innerHTML = `
    <div class="card live stagger-in" style="animation-delay:0.02s;"><div class="label">Total Spend</div><div class="value" id="v-total">$0.00</div></div>
    <div class="card stagger-in" style="animation-delay:0.06s;"><div class="label">Spend Today</div><div class="value" id="v-today">$0.00</div></div>
    <div class="card stagger-in" style="animation-delay:0.10s;"><div class="label">Total Events</div><div class="value" id="v-events">0</div></div>
    <div class="card stagger-in" style="animation-delay:0.14s;"><div class="label">Untagged Spend</div><div class="value" id="v-untagged">$0.00</div></div>
  `;
  animateValue(document.getElementById("v-total"), Number(summary.total_cost || 0), { prefix: "$" });
  animateValue(document.getElementById("v-today"), Number(summary.today_cost || 0), { prefix: "$" });
  animateValue(document.getElementById("v-events"), Number(summary.event_count || 0), { decimals: 0 });
  animateValue(document.getElementById("v-untagged"), Number(untagged.total_untagged_cost || 0), { prefix: "$" });
}

let timeChartInstance, teamChartInstance;

function renderCharts(byTime, byTeam) {
  window.__finopsChartData = { byTime, byTeam };
  const gridColor = themeColor("--border");
  const tickColor = themeColor("--text-muted");
  const signal = themeColor("--signal");

  if (timeChartInstance) timeChartInstance.destroy();
  if (teamChartInstance) teamChartInstance.destroy();

  timeChartInstance = new Chart(document.getElementById("timeChart"), {
    type: "line",
    data: {
      labels: byTime.map((r) => r.day),
      datasets: [{
        label: "Daily cost (USD)",
        data: byTime.map((r) => r.total_cost),
        borderColor: signal,
        backgroundColor: signal + "26",
        tension: 0.35,
        fill: true,
        pointRadius: 2,
        pointHoverRadius: 5,
      }],
    },
    options: {
      animation: prefersReducedMotion ? false : { duration: 900, easing: "easeOutQuart" },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: tickColor, font: { size: 11 } }, grid: { color: gridColor } },
        y: { ticks: { color: tickColor, font: { size: 11 } }, grid: { color: gridColor } },
      },
    },
  });

  teamChartInstance = new Chart(document.getElementById("teamChart"), {
    type: "doughnut",
    data: {
      labels: byTeam.map((r) => r.team),
      datasets: [{
        data: byTeam.map((r) => r.total_cost),
        backgroundColor: ["#4c82ff", "#35c98c", "#f0b429", "#f0546b", "#a78bfa", "#38bdf8"],
        borderColor: themeColor("--surface"),
        borderWidth: 2,
      }],
    },
    options: {
      animation: prefersReducedMotion ? false : { duration: 900, easing: "easeOutQuart" },
      plugins: { legend: { position: "bottom", labels: { color: themeColor("--text"), boxWidth: 11, font: { size: 11.5 } } } },
    },
  });
}

function renderModelTable(rows) {
  const tbody = document.querySelector("#modelTable tbody");
  tbody.innerHTML = rows
    .map((r) => `<tr><td>${r.provider}</td><td>${r.model}</td><td>${r.event_count}</td><td>${fmt$(r.total_cost)}</td></tr>`)
    .join("");
}

function renderBudgetTable(rows) {
  const tbody = document.querySelector("#budgetTable tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text-faint);font-family:var(--font-ui);">No budgets set. POST to /api/budgets to add one.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => `<tr>
        <td style="font-family:var(--font-ui);">${r.scope_type}: ${r.scope_value}</td>
        <td>${fmt$(r.spent_this_month)}</td>
        <td>${fmt$(r.monthly_limit_usd)}</td>
        <td class="tier-${r.alert_tier}">${r.pct_used}% (${r.alert_tier})</td>
      </tr>`)
    .join("");
}

function renderRecommendations(data) {
  const el = document.getElementById("recommendations");
  const items = data.model_switch || [];
  if (!items.length) {
    el.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">No recommendations yet — need more usage data.</div>`;
    return;
  }
  el.innerHTML = items
    .map((r) => `<div style="border-bottom:1px solid var(--border);padding:10px 0;font-size:13px;">
        <strong>${r.current.provider}/${r.current.model}</strong> → <strong>${r.suggested.provider}/${r.suggested.model}</strong>
        <span style="color:var(--good);font-family:var(--font-data);"> save ~${fmt$(r.estimated_savings_usd)} (${r.estimated_savings_pct}%)</span>
        <div style="color:var(--text-faint);margin-top:4px;font-size:12px;">${r.caveat}</div>
      </div>`)
    .join("");
}

function renderAlerts(rows) {
  const el = document.getElementById("alerts");
  if (!rows.length) {
    el.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">No alerts yet.</div>`;
    return;
  }
  el.innerHTML = rows
    .slice(0, 10)
    .map((a) => `<div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:13px;">
        <span style="color:var(--money);text-transform:uppercase;font-size:10.5px;font-weight:600;letter-spacing:0.04em;">${a.type}</span>
        <div style="margin-top:2px;">${a.message}</div>
        <div style="color:var(--text-faint);font-size:11px;font-family:var(--font-data);margin-top:2px;">${a.created_at}</div>
      </div>`)
    .join("");
}

function renderReconcileTable(rows) {
  const tbody = document.querySelector("#reconcileTable tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-faint);font-family:var(--font-ui);">No billing exports uploaded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => `<tr>
        <td>${r.day}</td>
        <td style="font-family:var(--font-ui);">${r.provider}</td>
        <td>${fmt$(r.reported_cost)}</td>
        <td>${fmt$(r.tracked_cost)}</td>
        <td class="${r.flagged ? "tier-exceeded" : "tier-ok"}">${fmt$(r.gap_usd)} (${r.gap_pct}%)</td>
        <td class="${r.flagged ? "tier-exceeded" : "tier-ok"}" style="font-family:var(--font-ui);">${r.flagged ? "⚠ Shadow spend" : "OK"}</td>
      </tr>`)
    .join("");
}

async function loadReconcileReport() {
  try {
    const rows = await getJSON("/api/reconcile/report");
    renderReconcileTable(rows);
  } catch (err) {
    document.querySelector("#reconcileTable tbody").innerHTML =
      `<tr><td colspan="6" style="color:var(--danger)">${err.message}</td></tr>`;
  }
}

document.getElementById("reconcileUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("reconcileFile");
  const status = document.getElementById("reconcileStatus");
  const file = fileInput.files[0];
  if (!file) {
    status.innerHTML = `<span style="color:var(--danger);">Choose a CSV file first</span>`;
    return;
  }
  status.textContent = "Uploading…";
  try {
    const text = await file.text();
    const res = await fetch("/api/reconcile/upload", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "text/csv" },
      body: text,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Upload failed");
    status.innerHTML = `<span style="color:var(--good);">Imported ${body.rowCount} rows (${body.replacedDayProviderPairs} day/provider pairs replaced).</span>`;
    fileInput.value = "";
    loadReconcileReport();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--danger);">${err.message}</span>`;
  }
});

/* ---------------------------------------------------------------- */
/* Main load                                                          */
/* ---------------------------------------------------------------- */
async function loadDashboard() {
  /* ---------------------------------------------------------------- */
/* Cache stats, backups, audit log (admin-gated - fail gracefully)   */
/* ---------------------------------------------------------------- */
async function loadCacheStats() {
  try {
    const stats = await getJSON("/api/cache/stats");
    document.getElementById("cacheHitRate").textContent = `${stats.hit_rate_pct}%`;
    document.getElementById("cacheSize").textContent = stats.current_size;
  } catch {
    document.getElementById("cacheHitRate").textContent = "—";
    document.getElementById("cacheSize").textContent = "—";
  }
}

function renderBackupTable(rows) {
  const tbody = document.querySelector("#backupTable tbody");
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" style="color:var(--text-faint);font-family:var(--font-ui);">No backups yet, or admin access required to view.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .slice(0, 5)
    .map((b) => `<tr>
        <td style="font-family:var(--font-ui);font-size:12px;">${b.name}</td>
        <td>${(b.sizeBytes / 1024).toFixed(1)} KB</td>
        <td style="font-size:11px;">${new Date(b.createdAt).toLocaleString()}</td>
      </tr>`)
    .join("");
}

async function loadBackups() {
  try {
    const rows = await getJSON("/api/backup");
    renderBackupTable(rows);
  } catch {
    renderBackupTable([]);
  }
}

document.getElementById("runBackupBtn").addEventListener("click", async () => {
  const status = document.getElementById("backupStatus");
  status.textContent = "Running backup…";
  try {
    const res = await fetch("/api/backup/run", { method: "POST", headers: authHeaders() });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Backup failed");
    status.innerHTML = `<span style="color:var(--good);">Backup created.</span>`;
    loadBackups();
  } catch (err) {
    status.innerHTML = `<span style="color:var(--danger);">${err.message}</span>`;
  }
});

document.getElementById("exportDataBtn").addEventListener("click", () => {
  fetch("/api/data/export?format=csv", { headers: authHeaders() })
    .then((res) => {
      if (!res.ok) throw new Error("Export failed - check you're logged in.");
      return res.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "finops_usage_export.csv";
      a.click();
      URL.revokeObjectURL(url);
    })
    .catch((err) => alert(err.message));
});

function renderAuditLog(rows) {
  const el = document.getElementById("auditLog");
  if (!rows || !rows.length) {
    el.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">No audit entries yet, or admin access required to view.</div>`;
    return;
  }
  el.innerHTML = rows
    .slice(0, 10)
    .map((a) => `<div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:13px;">
        <span style="color:var(--signal);font-family:var(--font-data);font-size:11.5px;">${a.action}</span>
        <span style="color:var(--text-muted);"> by ${a.actor}${a.target ? ` &rarr; ${a.target}` : ""}</span>
        <div style="color:var(--text-faint);font-size:11px;font-family:var(--font-data);margin-top:2px;">${a.created_at}</div>
      </div>`)
    .join("");
}

async function loadAuditLog() {
  try {
    const rows = await getJSON("/api/audit?limit=10");
    renderAuditLog(rows);
  } catch {
    renderAuditLog([]);
  }
}
  try {
    const [summary, untagged, byTime, byTeam, byModel, budgetStatus, recommendations, alerts] = await Promise.all([
      getJSON("/api/costs/summary"),
      getJSON("/api/costs/untagged"),
      getJSON("/api/costs/over-time"),
      getJSON("/api/costs/by-team"),
      getJSON("/api/costs/by-model"),
      getJSON("/api/budgets/status"),
      getJSON("/api/recommendations"),
      getJSON("/api/alerts"),
    ]);

    renderCards(summary, untagged);
    renderCharts(byTime, byTeam);
    renderModelTable(byModel);
    renderBudgetTable(budgetStatus);
    renderRecommendations(recommendations);
    renderAlerts(alerts);
    loadReconcileReport();
    loadCacheStats();
    loadBackups();
    loadAuditLog();
  } catch (err) {
    document.getElementById("summaryCards").innerHTML =
      `<div class="card"><div class="label">Error</div><div class="value" style="font-size:14px;color:var(--danger);font-family:var(--font-ui);">${err.message}</div></div>`;
  }
}

loadDashboard().catch((err) => {
  console.error(err);
  document.getElementById("summaryCards").innerHTML =
    `<div class="card"><div class="label">Error</div><div class="value" style="font-size:14px;color:var(--danger);font-family:var(--font-ui);">${err.message}. Is the server running?</div></div>`;
});