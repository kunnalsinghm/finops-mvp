const fmt$ = (n) => `$${Number(n || 0).toFixed(2)}`;

const apiKeyInput = document.getElementById("apiKeyInput");
const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");
const loginBtn = document.getElementById("loginBtn");
const loginStatus = document.getElementById("loginStatus");

apiKeyInput.value = localStorage.getItem("finops_api_key") || "";
apiKeyInput.addEventListener("change", () => {
  localStorage.setItem("finops_api_key", apiKeyInput.value.trim());
  loadDashboard();
});

// Pick up a session token handed off via URL fragment after an SSO redirect
// (see server/routes/sso.js callback - it redirects to /#session=<token>)
const hashMatch = location.hash.match(/session=([^&]+)/);
if (hashMatch) {
  localStorage.setItem("finops_session_token", hashMatch[1]);
  history.replaceState(null, "", location.pathname); // clean the URL
}

function getSessionToken() {
  return localStorage.getItem("finops_session_token") || "";
}

function updateLoginStatus() {
  const token = getSessionToken();
  const username = localStorage.getItem("finops_session_username");
  if (token && username) {
    loginStatus.innerHTML = `Logged in as <strong>${username}</strong> · <a href="#" id="logoutLink" style="color:var(--accent);">log out</a>`;
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
    loginStatus.innerHTML = `<span style="color:var(--bad);">Enter a username and password</span>`;
    return;
  }
  loginStatus.textContent = "Logging in…";
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
    updateLoginStatus();
    loadDashboard();
  } catch (err) {
    loginStatus.innerHTML = `<span style="color:var(--bad);">${err.message}</span>`;
  }
});

// Session token takes priority over a pasted API key if both are present,
// since it represents an actual logged-in human rather than a shared secret
// sitting in a text box.
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

function renderCards(summary, untagged) {
  const el = document.getElementById("summaryCards");
  el.innerHTML = `
    <div class="card"><div class="label">Total Spend</div><div class="value">${fmt$(summary.total_cost)}</div></div>
    <div class="card"><div class="label">Spend Today</div><div class="value">${fmt$(summary.today_cost)}</div></div>
    <div class="card"><div class="label">Total Events</div><div class="value">${summary.event_count || 0}</div></div>
    <div class="card"><div class="label">Untagged Spend</div><div class="value">${fmt$(untagged.total_untagged_cost)}</div></div>
  `;
}

function renderTimeChart(rows) {
  const ctx = document.getElementById("timeChart");
  new Chart(ctx, {
    type: "line",
    data: {
      labels: rows.map((r) => r.day),
      datasets: [{
        label: "Daily cost (USD)",
        data: rows.map((r) => r.total_cost),
        borderColor: "#6ea8fe",
        backgroundColor: "rgba(110,168,254,0.15)",
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#8b93a7" }, grid: { color: "#232838" } },
        y: { ticks: { color: "#8b93a7" }, grid: { color: "#232838" } },
      },
    },
  });
}

function renderTeamChart(rows) {
  const ctx = document.getElementById("teamChart");
  new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.team),
      datasets: [{
        data: rows.map((r) => r.total_cost),
        backgroundColor: ["#6ea8fe", "#4ade80", "#facc15", "#f87171", "#a78bfa", "#38bdf8"],
      }],
    },
    options: {
      plugins: { legend: { position: "bottom", labels: { color: "#e6e9f0", boxWidth: 12 } } },
    },
  });
}

function renderModelTable(rows) {
  const tbody = document.querySelector("#modelTable tbody");
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.provider}</td>
        <td>${r.model}</td>
        <td>${r.event_count}</td>
        <td>${fmt$(r.total_cost)}</td>
      </tr>`
    )
    .join("");
}

function renderBudgetTable(rows) {
  const tbody = document.querySelector("#budgetTable tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#8b93a7">No budgets set. POST to /api/budgets to add one.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.scope_type}: ${r.scope_value}</td>
        <td>${fmt$(r.spent_this_month)}</td>
        <td>${fmt$(r.monthly_limit_usd)}</td>
        <td class="tier-${r.alert_tier}">${r.pct_used}% (${r.alert_tier})</td>
      </tr>`
    )
    .join("");
}

function renderRecommendations(data) {
  const el = document.getElementById("recommendations");
  const items = data.model_switch || [];
  if (!items.length) {
    el.innerHTML = `<div style="color:#8b93a7;font-size:13px;">No recommendations yet — need more usage data.</div>`;
    return;
  }
  el.innerHTML = items
    .map(
      (r) => `<div style="border-bottom:1px solid var(--border);padding:10px 0;font-size:13px;">
        <strong>${r.current.provider}/${r.current.model}</strong> → <strong>${r.suggested.provider}/${r.suggested.model}</strong>
        <span style="color:var(--good);"> save ~${fmt$(r.estimated_savings_usd)} (${r.estimated_savings_pct}%)</span>
        <div style="color:#8b93a7;margin-top:4px;font-size:12px;">${r.caveat}</div>
      </div>`
    )
    .join("");
}

function renderAlerts(rows) {
  const el = document.getElementById("alerts");
  if (!rows.length) {
    el.innerHTML = `<div style="color:#8b93a7;font-size:13px;">No alerts yet.</div>`;
    return;
  }
  el.innerHTML = rows
    .slice(0, 10)
    .map(
      (a) => `<div style="border-bottom:1px solid var(--border);padding:8px 0;font-size:13px;">
        <span style="color:var(--warn);text-transform:uppercase;font-size:11px;">${a.type}</span>
        <div>${a.message}</div>
        <div style="color:#8b93a7;font-size:11px;">${a.created_at}</div>
      </div>`
    )
    .join("");
}

function renderReconcileTable(rows) {
  const tbody = document.querySelector("#reconcileTable tbody");
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#8b93a7">No billing exports uploaded yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${r.day}</td>
        <td>${r.provider}</td>
        <td>${fmt$(r.reported_cost)}</td>
        <td>${fmt$(r.tracked_cost)}</td>
        <td class="${r.flagged ? "tier-exceeded" : "tier-ok"}">${fmt$(r.gap_usd)} (${r.gap_pct}%)</td>
        <td class="${r.flagged ? "tier-exceeded" : "tier-ok"}">${r.flagged ? "⚠ Shadow spend" : "OK"}</td>
      </tr>`
    )
    .join("");
}

async function loadReconcileReport() {
  try {
    const rows = await getJSON("/api/reconcile/report");
    renderReconcileTable(rows);
  } catch (err) {
    document.querySelector("#reconcileTable tbody").innerHTML =
      `<tr><td colspan="6" style="color:var(--bad)">${err.message}</td></tr>`;
  }
}

document.getElementById("reconcileUploadBtn").addEventListener("click", async () => {
  const fileInput = document.getElementById("reconcileFile");
  const status = document.getElementById("reconcileStatus");
  const file = fileInput.files[0];
  if (!file) {
    status.innerHTML = `<span style="color:var(--bad);">Choose a CSV file first</span>`;
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
    status.innerHTML = `<span style="color:var(--bad);">${err.message}</span>`;
  }
});

async function loadDashboard() {
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
    renderTimeChart(byTime);
    renderTeamChart(byTeam);
    renderModelTable(byModel);
    renderBudgetTable(budgetStatus);
    renderRecommendations(recommendations);
    renderAlerts(alerts);
    loadReconcileReport();
  } catch (err) {
    document.getElementById("summaryCards").innerHTML =
      `<div class="card"><div class="label">Error</div><div class="value" style="font-size:14px;color:#f87171">${err.message}</div></div>`;
  }
}

loadDashboard().catch((err) => {
  console.error(err);
  document.getElementById("summaryCards").innerHTML =
    `<div class="card"><div class="label">Error</div><div class="value" style="font-size:14px;color:#f87171">${err.message}. Is the server running?</div></div>`;
});