// HTML is built by render.js (loaded first by index.html): html`` escapes every value, setHtml() is the only
// innerHTML write. See test/dashboardRender.test.js for the rules this file must keep.
const R = FinopsRender;
const { setHtml } = R;

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
    setHtml(loginStatus, R.loginStatusHtml(username));
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
    setHtml(loginMsg, R.messageHtml("danger", "Enter a username and password"));
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
    setHtml(loginMsg, R.messageHtml("danger", err.message));
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
  setHtml(el, R.cardsHtml());
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
  setHtml(tbody, R.modelRowsHtml(rows));
}

function renderBudgetTable(rows) {
  const tbody = document.querySelector("#budgetTable tbody");
  setHtml(tbody, R.budgetRowsHtml(rows));
}

function renderRecommendations(data) {
  const el = document.getElementById("recommendations");
  setHtml(el, R.recommendationsHtml(data.model_switch || []));
}

function renderAlerts(rows) {
  const el = document.getElementById("alerts");
  setHtml(el, R.alertsHtml(rows));
}

function renderReconcileTable(rows) {
  const tbody = document.querySelector("#reconcileTable tbody");
  setHtml(tbody, R.reconcileRowsHtml(rows));
}

async function loadReconcileReport() {
  try {
    const rows = await getJSON("/api/reconcile/report");
    renderReconcileTable(rows);
  } catch (err) {
    setHtml(document.querySelector("#reconcileTable tbody"), R.reconcileErrorRowHtml(err.message));
  }
}

document.getElementById("reconcileUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("reconcileFile");
  const status = document.getElementById("reconcileStatus");
  const file = fileInput.files[0];
  if (!file) {
    setHtml(status, R.messageHtml("danger", "Choose a CSV file first"));
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
    setHtml(status, R.messageHtml("good", `Imported ${body.rowCount} rows (${body.replacedDayProviderPairs} day/provider pairs replaced).`));
    fileInput.value = "";
    loadReconcileReport();
  } catch (err) {
    setHtml(status, R.messageHtml("danger", err.message));
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
  setHtml(tbody, R.backupRowsHtml(rows));
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
    setHtml(status, R.messageHtml("good", "Backup created."));
    loadBackups();
  } catch (err) {
    setHtml(status, R.messageHtml("danger", err.message));
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
  setHtml(el, R.auditHtml(rows));
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
    setHtml(document.getElementById("summaryCards"), R.errorCardHtml(err.message));
  }
}

loadDashboard().catch((err) => {
  console.error(err);
  setHtml(document.getElementById("summaryCards"), R.errorCardHtml(err.message, ". Is the server running?"));
});