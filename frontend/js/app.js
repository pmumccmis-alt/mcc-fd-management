const API = '/api';
let charts = {}; // keep Chart.js instances so we can destroy/recreate on filter change

// ---------- Session helpers ----------
function getToken() { return localStorage.getItem('mcc_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('mcc_user') || 'null'); } catch { return null; }
}
function setSession(token, user) {
  localStorage.setItem('mcc_token', token);
  localStorage.setItem('mcc_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('mcc_token');
  localStorage.removeItem('mcc_user');
}

async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API + path, Object.assign({}, opts, { headers }));
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }

  if (res.status === 401) {
    clearSession();
    showView('login');
    throw new Error((data && data.error) || 'Session expired. Please sign in again.');
  }
  if (!res.ok) {
    const msg = (data && (data.error || (data.errors && data.errors[0] && data.errors[0].msg))) || 'Request failed.';
    throw new Error(msg);
  }
  return data;
}

async function downloadFile(path) {
  const token = getToken();
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error((data && data.error) || 'Export failed.');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="(.+)"/);
  const filename = match ? match[1] : 'export.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- View switching ----------
function showView(name) {
  document.getElementById('loginView').hidden = name !== 'login';
  document.getElementById('otpView').hidden = name !== 'otp';
  document.getElementById('adminView').hidden = name !== 'admin';
  document.getElementById('bankView').hidden = name !== 'bank';
  document.getElementById('sessionBox').hidden = name === 'login' || name === 'otp';
}

function renderSessionBox() {
  const user = getUser();
  if (!user) return;
  let label;
  if (user.role === 'master') label = `${user.full_name || user.username} · Master (${user.officer_id || ''})`;
  else if (user.role === 'admin') label = `${user.full_name || user.username} · Officer (${user.officer_id || ''})`;
  else label = `${user.bank_name || user.username} · Bank User`;
  document.getElementById('whoami').textContent = label;
}

// ---------- Formatting ----------
function formatMoney(n) {
  if (n == null) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function tenureLabel(days) {
  if (days % 365 === 0) return `${days / 365} yr (${days}d)`;
  if (days % 30 === 0) return `${days / 30} mo (${days}d)`;
  return `${days} days`;
}
function badge(status) {
  return `<span class="badge ${status}">${status.replace('_', ' ')}</span>`;
}
function statusLabel(status) { return status.replace('_', ' '); }

// ---------- Boot ----------
let pendingOtpUserId = null;

window.addEventListener('DOMContentLoaded', () => {
  const user = getUser();
  if (user && getToken()) {
    renderSessionBox();
    enterRoleView(user);
  } else {
    showView('login');
  }
  wireEvents();
});

function enterRoleView(user) {
  if (user.role === 'master' || user.role === 'admin') {
    document.querySelectorAll('.master-only').forEach(el => { el.hidden = user.role !== 'master'; });
    showView('admin');
    loadDepartmentsFilter();
    loadBanksFilter();
    loadDashboard();
    loadFunds();
    loadBanks();
    loadDepositsBankFilter();
    loadDeposits();
    if (user.role === 'master') loadOfficers();
  } else {
    showView('bank');
    loadBankFunds();
    loadBankDashboard();
  }
}

function wireEvents() {
  document.getElementById('loginForm').addEventListener('submit', onLoginStep1);
  document.getElementById('otpForm').addEventListener('submit', onLoginStep2);
  document.getElementById('resendOtpBtn').addEventListener('click', onResendOtp);
  document.getElementById('backToLoginBtn').addEventListener('click', () => { showView('login'); document.getElementById('otpError').textContent = ''; });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    clearSession();
    showView('login');
  });

  document.querySelectorAll('#adminView .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#adminView .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#adminView .tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
  document.querySelectorAll('#bankView .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#bankView .tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#bankView .tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.bankTab).classList.add('active');
    });
  });

  document.getElementById('refreshFundsBtn').addEventListener('click', loadFunds);
  document.getElementById('newFundForm').addEventListener('submit', onCreateFund);
  document.getElementById('newBankForm').addEventListener('submit', onCreateBank);
  document.getElementById('newOfficerForm').addEventListener('submit', onCreateOfficer);

  document.getElementById('applyFiltersBtn').addEventListener('click', loadDashboard);
  document.getElementById('clearFiltersBtn').addEventListener('click', () => {
    ['filterDateFrom', 'filterDateTo', 'filterStatus', 'filterDepartment', 'filterBank'].forEach(id => document.getElementById(id).value = '');
    loadDashboard();
  });
  document.getElementById('exportExcelBtn').addEventListener('click', onExportExcel);

  document.getElementById('bankApplyFiltersBtn').addEventListener('click', loadBankDashboard);
  document.getElementById('bankClearFiltersBtn').addEventListener('click', () => {
    ['bankFilterDateFrom', 'bankFilterDateTo', 'bankFilterStatus'].forEach(id => document.getElementById(id).value = '');
    loadBankDashboard();
  });

  document.getElementById('depApplyFiltersBtn').addEventListener('click', loadDeposits);
  document.getElementById('depClearFiltersBtn').addEventListener('click', () => {
    ['depFilterDateFrom', 'depFilterDateTo', 'depFilterStatus', 'depFilterBank'].forEach(id => document.getElementById(id).value = '');
    loadDeposits();
  });
  document.getElementById('depExportExcelBtn').addEventListener('click', onExportDepositsExcel);

  document.getElementById('closeFundModal').addEventListener('click', () => { document.getElementById('fundModal').hidden = true; });
  document.getElementById('closeQuoteModal').addEventListener('click', () => { document.getElementById('quoteModal').hidden = true; });
  document.getElementById('closeDepositModal').addEventListener('click', () => { document.getElementById('depositModal').hidden = true; });
}

/* =========================================================
   LOGIN (STEP 1: credentials, STEP 2: OTP)
   ========================================================= */
async function onLoginStep1(e) {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    pendingOtpUserId = data.userId;
    document.getElementById('otpSubtitle').textContent = `An OTP has been sent to your registered mobile number ending ${data.maskedMobile.slice(-4)}. It is valid for ${data.expiresInMinutes} minutes.`;
    const devBanner = document.getElementById('devOtpBanner');
    if (data.devOtp) {
      devBanner.hidden = false;
      devBanner.textContent = `DEV MODE — no SMS gateway configured. Your OTP is: ${data.devOtp}`;
    } else {
      devBanner.hidden = true;
    }
    document.getElementById('otpInput').value = '';
    document.getElementById('otpError').textContent = '';
    showView('otp');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function onLoginStep2(e) {
  e.preventDefault();
  const errEl = document.getElementById('otpError');
  errEl.textContent = '';
  const otp = document.getElementById('otpInput').value.trim();

  try {
    const data = await api('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ userId: pendingOtpUserId, otp }) });
    setSession(data.token, data.user);
    renderSessionBox();
    enterRoleView(data.user);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function onResendOtp() {
  const errEl = document.getElementById('otpError');
  try {
    const data = await api('/auth/resend-otp', { method: 'POST', body: JSON.stringify({ userId: pendingOtpUserId }) });
    const devBanner = document.getElementById('devOtpBanner');
    if (data.devOtp) {
      devBanner.hidden = false;
      devBanner.textContent = `DEV MODE — no SMS gateway configured. Your OTP is: ${data.devOtp}`;
    }
    errEl.className = 'success';
    errEl.textContent = 'A new OTP has been sent.';
  } catch (err) {
    errEl.className = 'error';
    errEl.textContent = err.message;
  }
}

/* =========================================================
   DASHBOARD (Master/Admin) — filters, KPIs, charts, table, export
   ========================================================= */
function currentFilters() {
  return {
    date_from: document.getElementById('filterDateFrom').value,
    date_to: document.getElementById('filterDateTo').value,
    status: document.getElementById('filterStatus').value,
    department: document.getElementById('filterDepartment').value,
    bank_id: document.getElementById('filterBank').value
  };
}
function toQuery(obj) {
  const params = Object.entries(obj).filter(([, v]) => v);
  return params.length ? '?' + new URLSearchParams(params).toString() : '';
}

async function loadDepartmentsFilter() {
  try {
    const depts = await api('/funds/meta/departments');
    const sel = document.getElementById('filterDepartment');
    const previousValue = sel.value; // preserve whatever the user currently has selected
    sel.innerHTML = `<option value="">All</option>` + depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    if (previousValue && depts.includes(previousValue)) sel.value = previousValue;
  } catch { /* non-critical */ }
}
async function loadBanksFilter() {
  try {
    const banks = await api('/auth/banks');
    const sel = document.getElementById('filterBank');
    const previousValue = sel.value; // preserve whatever the user currently has selected
    sel.innerHTML = `<option value="">All</option>` + banks.map(b => `<option value="${b.id}">${escapeHtml(b.bank_name)}</option>`).join('');
    if (previousValue && banks.some(b => String(b.id) === previousValue)) sel.value = previousValue;
  } catch { /* non-critical */ }
}

let appliedFilters = {}; // the filter set actually in effect — updated only when loadDashboard runs

async function loadDashboard() {
  appliedFilters = currentFilters(); // lock in exactly what's applied — Export will use this, not live DOM state
  const q = toQuery(appliedFilters);
  try {
    const stats = await api('/dashboard/stats' + q);
    renderKpis(stats.kpis);
    renderStatusChart(stats.byStatus);
    renderMonthChart(stats.byMonth);
    renderDeptChart(stats.byDepartment, appliedFilters.department);
    renderTenureChart(stats.byTenure);
    renderBankChart(stats.byBank, appliedFilters.bank_id);
  } catch (err) {
    console.error(err);
  }
  await loadDashboardTable();
}

function renderKpis(k) {
  const grid = document.getElementById('kpiGrid');
  grid.innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Total Funds</div><div class="kpi-value">${k.total_funds}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Amount Published</div><div class="kpi-value">${formatMoney(k.total_amount)}</div></div>
    <div class="kpi-card gold"><div class="kpi-label">Total Amount Awarded</div><div class="kpi-value">${formatMoney(k.awarded_amount)}</div></div>
    <div class="kpi-card success-accent"><div class="kpi-label">Avg. Awarded Rate</div><div class="kpi-value">${k.avg_awarded_rate != null ? k.avg_awarded_rate + '%' : '—'}</div></div>
    <div class="kpi-card"><div class="kpi-label">Open</div><div class="kpi-value">${k.open_count}</div></div>
    <div class="kpi-card"><div class="kpi-label">Result Declared</div><div class="kpi-value">${k.result_declared_count}</div></div>
    <div class="kpi-card"><div class="kpi-label">Awarded</div><div class="kpi-value">${k.awarded_count}</div></div>
    <div class="kpi-card"><div class="kpi-label">Cancelled</div><div class="kpi-value">${k.cancelled_count}</div></div>
  `;
}

function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

function renderStatusChart(rows) {
  destroyChart('status');
  const ctx = document.getElementById('statusChart');
  charts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => statusLabel(r.status)),
      datasets: [{ data: rows.map(r => r.count), backgroundColor: ['#2C5F7C', '#B3852E', '#1F7A4D', '#B3261E'] }]
    },
    options: { plugins: { legend: { position: 'bottom' } } }
  });
}
function renderMonthChart(rows) {
  destroyChart('month');
  const ctx = document.getElementById('monthChart');
  charts.month = new Chart(ctx, {
    type: 'bar',
    data: { labels: rows.map(r => r.month), datasets: [{ label: 'Amount (₹)', data: rows.map(r => r.amount), backgroundColor: '#14304D' }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}
function renderDeptChart(rows, departmentFilterActive) {
  const card = document.getElementById('deptChartCard');
  if (departmentFilterActive) {
    card.querySelector('.chart-hidden-note')?.remove();
    card.querySelector('canvas').style.display = 'none';
    destroyChart('dept');
    const note = document.createElement('p');
    note.className = 'muted chart-hidden-note';
    note.textContent = `Hidden — you've already filtered to a single department ("${departmentFilterActive}"), so a department breakdown isn't meaningful here. Clear the department filter to see it again.`;
    card.appendChild(note);
    return;
  }
  card.querySelector('.chart-hidden-note')?.remove();
  card.querySelector('canvas').style.display = '';
  destroyChart('dept');
  const ctx = document.getElementById('deptChart');
  charts.dept = new Chart(ctx, {
    type: 'bar',
    data: { labels: rows.map(r => r.department), datasets: [{ label: 'Amount (₹)', data: rows.map(r => r.amount), backgroundColor: '#B3852E' }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } }
  });
}
function renderTenureChart(rows) {
  destroyChart('tenure');
  const ctx = document.getElementById('tenureChart');
  charts.tenure = new Chart(ctx, {
    type: 'bar',
    data: { labels: rows.map(r => r.bucket), datasets: [{ label: 'Avg. Awarded Rate (%)', data: rows.map(r => r.avg_rate), backgroundColor: '#1F7A4D' }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
  });
}
function renderBankChart(rows, bankFilterActive) {
  const card = document.getElementById('bankChartCard');
  card.style.display = '';
  card.querySelector('.chart-hidden-note')?.remove();

  if (bankFilterActive) {
    card.querySelector('canvas').style.display = 'none';
    destroyChart('bank');
    const note = document.createElement('p');
    note.className = 'muted chart-hidden-note';
    note.textContent = `Hidden — you've filtered to a single bank, so this chart's "quotes vs. wins" comparison across banks isn't meaningful here. Clear the bank filter to see it again.`;
    card.appendChild(note);
    return;
  }
  if (!rows || !rows.length) { card.style.display = 'none'; return; }

  card.querySelector('canvas').style.display = '';
  destroyChart('bank');
  const ctx = document.getElementById('bankChart');
  charts.bank = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: rows.map(r => r.bank_name),
      datasets: [
        { label: 'Quotes Submitted', data: rows.map(r => r.quote_count), backgroundColor: '#2C5F7C' },
        { label: 'Funds Won', data: rows.map(r => r.wins), backgroundColor: '#B3852E' }
      ]
    },
    options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
  });
}

async function loadDashboardTable() {
  const tbody = document.querySelector('#dashboardFundsTable tbody');
  tbody.innerHTML = `<tr><td colspan="10">Loading…</td></tr>`;
  try {
    const funds = await api('/funds' + toQuery(currentFilters()));
    if (!funds.length) {
      tbody.innerHTML = `<tr><td colspan="10">No funds match the selected filters.</td></tr>`;
      return;
    }
    tbody.innerHTML = funds.map(f => {
      const bankName = f.status === 'awarded' ? f.awarded_bank_name : f.result_bank_name;
      const rate = f.status === 'awarded' ? f.awarded_rate : f.result_rate;
      return `
        <tr>
          <td class="mono">${f.reference_no}</td>
          <td>${escapeHtml(f.title)}</td>
          <td>${escapeHtml(f.department || '—')}</td>
          <td class="mono">${formatMoney(f.amount)}</td>
          <td>${tenureLabel(f.tenure_days)}</td>
          <td>${formatDate(f.bid_deadline)}</td>
          <td>${badge(f.status)}</td>
          <td>${bankName ? escapeHtml(bankName) : '—'}</td>
          <td class="mono">${rate != null ? rate + '%' : '—'}</td>
          <td>${f.awarded_at ? formatDate(f.awarded_at) : '—'}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="error">${err.message}</td></tr>`;
  }
}

async function onExportExcel() {
  const btn = document.getElementById('exportExcelBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Exporting…';
  try {
    const activeFilterCount = Object.values(appliedFilters).filter(Boolean).length;
    await downloadFile('/funds/export/excel' + toQuery(appliedFilters));
    btn.textContent = activeFilterCount
      ? `✓ Exported (${activeFilterCount} filter${activeFilterCount > 1 ? 's' : ''} applied)`
      : '✓ Exported (all records)';
    setTimeout(() => { btn.textContent = original; }, 2500);
    return;
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
  btn.textContent = original;
}

/* =========================================================
   ADMIN/MASTER: FUNDS TAB
   ========================================================= */
async function loadFunds() {
  const tbody = document.querySelector('#fundsTable tbody');
  tbody.innerHTML = `<tr><td colspan="9">Loading…</td></tr>`;
  try {
    const funds = await api('/funds');
    if (!funds.length) {
      tbody.innerHTML = `<tr><td colspan="9">No funds have been entered yet. Use "New Fund Entry" to add one.</td></tr>`;
      return;
    }
    tbody.innerHTML = funds.map(f => {
      const bankName = f.status === 'awarded' ? f.awarded_bank_name : f.result_bank_name;
      const rate = f.status === 'awarded' ? f.awarded_rate : f.result_rate;
      return `
      <tr>
        <td class="mono">${f.reference_no}</td>
        <td>${escapeHtml(f.title)}</td>
        <td class="mono">${formatMoney(f.amount)}</td>
        <td>${tenureLabel(f.tenure_days)}</td>
        <td>${formatDate(f.bid_deadline)}</td>
        <td>${badge(f.status)}</td>
        <td>${f.quote_count}</td>
        <td>${bankName ? `<span class="mono">${rate}%</span><br><small>${escapeHtml(bankName)}</small>` : '—'}</td>
        <td><button class="btn small outline" data-id="${f.id}">Manage</button></td>
      </tr>
    `; }).join('');
    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openFundModal(btn.dataset.id));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" class="error">${err.message}</td></tr>`;
  }
}

async function onCreateFund(e) {
  e.preventDefault();
  const msg = document.getElementById('newFundMsg');
  msg.textContent = ''; msg.className = 'success';
  try {
    const payload = {
      title: document.getElementById('fundTitle').value.trim(),
      department: document.getElementById('fundDept').value.trim(),
      amount: parseFloat(document.getElementById('fundAmount').value),
      tenure_days: parseInt(document.getElementById('fundTenure').value, 10),
      bid_deadline: new Date(document.getElementById('fundDeadline').value).toISOString(),
      details: document.getElementById('fundDetails').value.trim()
    };
    const res = await api('/funds', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = `Fund ${res.reference_no} published. Banks can now submit rate quotations. The result will be declared automatically the moment the deadline passes.`;
    e.target.reset();
    loadFunds();
    loadDepartmentsFilter();
  } catch (err) {
    msg.className = 'error'; msg.textContent = err.message;
  }
}

async function openFundModal(id) {
  const modal = document.getElementById('fundModal');
  const content = document.getElementById('fundModalContent');
  content.innerHTML = 'Loading…';
  modal.hidden = false;
  try {
    const fund = await api(`/funds/${id}`);
    let quotes = [];
    let quotesSealedMessage = null;
    try {
      quotes = await api(`/funds/${id}/quotes`);
    } catch (err) {
      // Expected for an Officer viewing a fund that's still open — quotes are sealed until
      // the deadline auto-declares the result. Show the reason instead of failing the modal.
      quotesSealedMessage = err.message;
    }
    renderFundModal(fund, quotes, quotesSealedMessage);
  } catch (err) {
    content.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function renderFundModal(fund, quotes, quotesSealedMessage) {
  const content = document.getElementById('fundModalContent');
  const sorted = [...quotes].sort((a, b) => b.interest_rate - a.interest_rate || new Date(a.submitted_at) - new Date(b.submitted_at));

  let quoteListHtml;
  if (quotesSealedMessage) {
    quoteListHtml = `<p class="muted">🔒 ${escapeHtml(quotesSealedMessage)}</p>`;
  } else if (sorted.length) {
    quoteListHtml = `<ul class="rank-list">` + sorted.map((q, i) => `
        <li class="${i === 0 ? 'h1' : ''}">
          <span>${escapeHtml(q.bank_name)} ${i === 0 ? '<span class="h1-tag">H1</span>' : ''}</span>
          <span class="rate">${q.interest_rate}%</span>
        </li>`).join('') + `</ul>`;
  } else {
    quoteListHtml = `<p class="muted">No quotations received yet.</p>`;
  }

  let actionsHtml = '';
  if (fund.status === 'open') {
    actionsHtml = `<button class="btn danger" id="cancelFundBtn">Cancel Fund</button>
                    <p class="muted" style="width:100%;">The result is declared automatically the moment the bid deadline passes — there is no manual "close bidding" option, by design, so the process can't be closed early or influenced.</p>`;
  } else if (fund.status === 'result_declared') {
    actionsHtml = `${fund.result_bank_name ? `<button class="btn gold" id="awardH1Btn">Award to H1 (${escapeHtml(fund.result_bank_name)} @ ${fund.result_rate}%)</button>` : '<p class="muted">No quotes were received — nothing to award.</p>'}
                    <button class="btn danger" id="cancelFundBtn">Cancel Fund</button>`;
  } else if (fund.status === 'awarded') {
    const awardedQuote = sorted.find(q => q.bank_name === fund.awarded_bank_name && Number(q.interest_rate) === Number(fund.awarded_rate));
    const integrityWarning = (!quotesSealedMessage && sorted.length && !awardedQuote)
      ? `<p class="error" style="width:100%;">⚠ Data integrity warning: this award (${escapeHtml(fund.awarded_bank_name || '')} at ${fund.awarded_rate}%) does not match any submitted quote shown above. This should never happen through normal use of the app — it indicates the record was altered outside the award workflow. Please verify this fund manually.</p>`
      : '';
    actionsHtml = `<p class="success">Awarded to <strong>${escapeHtml(fund.awarded_bank_name)}</strong> at <strong>${fund.awarded_rate}%</strong> on ${formatDate(fund.awarded_at)}.</p>${integrityWarning}`;
  } else {
    actionsHtml = `<p class="muted">This fund entry was cancelled.</p>`;
  }

  content.innerHTML = `
    <h3>${escapeHtml(fund.title)}</h3>
    <dl class="kv">
      <dt>Reference No.</dt><dd class="mono">${fund.reference_no}</dd>
      <dt>Department</dt><dd>${escapeHtml(fund.department || '—')}</dd>
      <dt>Amount</dt><dd class="mono">${formatMoney(fund.amount)}</dd>
      <dt>Tenure</dt><dd>${tenureLabel(fund.tenure_days)}</dd>
      <dt>Bid Deadline</dt><dd>${formatDate(fund.bid_deadline)}</dd>
      <dt>Status</dt><dd>${badge(fund.status)}</dd>
      <dt>Details</dt><dd>${escapeHtml(fund.details || '—')}</dd>
    </dl>
    <h3>Bank Quotations (highest first)</h3>
    ${quoteListHtml}
    <div class="modal-actions" style="margin-top:16px; display:flex; gap:10px; flex-wrap:wrap;">${actionsHtml}</div>
    <p class="error" id="fundModalError"></p>
  `;

  const errEl = () => document.getElementById('fundModalError');

  const cancelBtn = document.getElementById('cancelFundBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!confirm('Cancel this fund entry? This cannot be undone.')) return;
    try { await api(`/funds/${fund.id}/cancel`, { method: 'POST' }); document.getElementById('fundModal').hidden = true; loadFunds(); loadDashboard(); }
    catch (err) { errEl().textContent = err.message; }
  });

  const awardBtn = document.getElementById('awardH1Btn');
  if (awardBtn) awardBtn.addEventListener('click', async () => {
    if (!confirm(`Award this FD to ${fund.result_bank_name} at ${fund.result_rate}%? This finalizes the decision.`)) return;
    try { await api(`/funds/${fund.id}/award`, { method: 'POST', body: JSON.stringify({}) }); await openFundModal(fund.id); loadFunds(); loadDashboard(); }
    catch (err) { errEl().textContent = err.message; }
  });
}

/* =========================================================
   ADMIN/MASTER: BANKS TAB
   ========================================================= */
async function loadBanks() {
  const tbody = document.querySelector('#banksTable tbody');
  tbody.innerHTML = `<tr><td colspan="4">Loading…</td></tr>`;
  try {
    const banks = await api('/auth/banks');
    if (!banks.length) { tbody.innerHTML = `<tr><td colspan="4">No banks added yet.</td></tr>`; return; }
    tbody.innerHTML = banks.map(b => `
      <tr>
        <td>${escapeHtml(b.bank_name)}</td>
        <td class="mono">${escapeHtml(b.username)}</td>
        <td class="mono">${escapeHtml(b.mobile_number || '—')}</td>
        <td>${b.is_active ? badge('open') : badge('cancelled')}</td>
        <td><button class="btn small outline" data-id="${b.id}" data-active="${b.is_active}">${b.is_active ? 'Deactivate' : 'Activate'}</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active !== '1';
        try { await api(`/auth/banks/${btn.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ is_active: newActive }) }); loadBanks(); loadBanksFilter(); }
        catch (err) { alert(err.message); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" class="error">${err.message}</td></tr>`;
  }
}

async function onCreateBank(e) {
  e.preventDefault();
  const msg = document.getElementById('newBankMsg');
  msg.className = 'success'; msg.textContent = '';
  try {
    const payload = {
      bank_name: document.getElementById('bankName').value.trim(),
      username: document.getElementById('bankUsername').value.trim(),
      mobile_number: document.getElementById('bankMobile').value.trim(),
      password: document.getElementById('bankPassword').value
    };
    await api('/auth/banks', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = `Login created for ${payload.bank_name}. Share the username/password with the bank securely — OTPs will be sent to the mobile number provided.`;
    e.target.reset();
    loadBanks(); loadBanksFilter();
  } catch (err) {
    msg.className = 'error'; msg.textContent = err.message;
  }
}

/* =========================================================
   MASTER: OFFICERS TAB
   ========================================================= */
async function loadOfficers() {
  const tbody = document.querySelector('#officersTable tbody');
  tbody.innerHTML = `<tr><td colspan="6">Loading…</td></tr>`;
  try {
    const officers = await api('/auth/officers');
    if (!officers.length) { tbody.innerHTML = `<tr><td colspan="6">No officer accounts added yet.</td></tr>`; return; }
    tbody.innerHTML = officers.map(o => `
      <tr>
        <td>${escapeHtml(o.full_name || '—')}</td>
        <td class="mono">${escapeHtml(o.officer_id || '—')}</td>
        <td class="mono">${escapeHtml(o.username)}</td>
        <td class="mono">${escapeHtml(o.mobile_number || '—')}</td>
        <td>${o.is_active ? badge('open') : badge('cancelled')}</td>
        <td><button class="btn small outline" data-id="${o.id}" data-active="${o.is_active}">${o.is_active ? 'Deactivate' : 'Activate'}</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active !== '1';
        try { await api(`/auth/officers/${btn.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ is_active: newActive }) }); loadOfficers(); }
        catch (err) { alert(err.message); }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="error">${err.message}</td></tr>`;
  }
}

async function onCreateOfficer(e) {
  e.preventDefault();
  const msg = document.getElementById('newOfficerMsg');
  msg.className = 'success'; msg.textContent = '';
  try {
    const payload = {
      full_name: document.getElementById('officerFullName').value.trim(),
      officer_id: document.getElementById('officerId').value.trim(),
      username: document.getElementById('officerUsername').value.trim(),
      mobile_number: document.getElementById('officerMobile').value.trim(),
      password: document.getElementById('officerPassword').value
    };
    await api('/auth/officers', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = `Officer login created for ${payload.full_name} (Officer ID: ${payload.officer_id}). OTPs will be sent to the mobile number provided.`;
    e.target.reset();
    loadOfficers();
  } catch (err) {
    msg.className = 'error'; msg.textContent = err.message;
  }
}

/* =========================================================
   BANK USER: OPEN FUNDS + SUBMIT QUOTES
   ========================================================= */
async function loadBankFunds() {
  const tbody = document.querySelector('#bankFundsTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">Loading…</td></tr>`;
  try {
    const funds = await api('/funds');
    if (!funds.length) { tbody.innerHTML = `<tr><td colspan="8">No open fund requirements at the moment.</td></tr>`; return; }
    tbody.innerHTML = funds.map(f => {
      let result = '—';
      if (f.status === 'result_declared' || f.status === 'awarded') {
        result = f.my_rate != null
          ? `<span class="mono">${f.my_rate}%</span> ${f.result_bank_name && f.my_rate === f.result_rate ? '<span class="h1-tag">H1</span>' : ''}`
          : 'No quote submitted';
      }
      // A quote is a one-time, final, binding submission — not a bid. Once a bank has quoted,
      // the button never comes back, even while the fund is still open for other banks.
      const alreadyQuoted = f.my_rate != null;
      const canQuote = f.status === 'open' && !alreadyQuoted && new Date(f.bid_deadline).getTime() > Date.now();

      let lastColumn;
      if (canQuote) {
        lastColumn = `<button class="btn small outline" data-id="${f.id}">Submit Quote</button>`;
      } else if (f.status === 'open' && alreadyQuoted) {
        lastColumn = `<span class="mono">${f.my_rate}%</span> <span class="muted">(submitted — final)</span>`;
      } else {
        lastColumn = result;
      }

      return `
        <tr>
          <td class="mono">${f.reference_no}</td>
          <td>${escapeHtml(f.title)}</td>
          <td class="mono">${formatMoney(f.amount)}</td>
          <td>${tenureLabel(f.tenure_days)}</td>
          <td>${formatDate(f.bid_deadline)}</td>
          <td>${badge(f.status)}</td>
          <td>${f.my_rate != null ? `<span class="mono">${f.my_rate}%</span>` : '<span class="muted">Not quoted</span>'}</td>
          <td>${lastColumn}</td>
        </tr>
      `;
    }).join('');
    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', () => openQuoteModal(btn.dataset.id));
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="error">${err.message}</td></tr>`;
  }
}

async function openQuoteModal(fundId) {
  const modal = document.getElementById('quoteModal');
  const content = document.getElementById('quoteModalContent');
  content.innerHTML = 'Loading…';
  modal.hidden = false;
  try {
    const fund = await api(`/funds/${fundId}`);
    content.innerHTML = `
      <h3>${escapeHtml(fund.title)}</h3>
      <dl class="kv">
        <dt>Reference No.</dt><dd class="mono">${fund.reference_no}</dd>
        <dt>Amount</dt><dd class="mono">${formatMoney(fund.amount)}</dd>
        <dt>Tenure</dt><dd>${tenureLabel(fund.tenure_days)}</dd>
        <dt>Quote Submission Deadline</dt><dd>${formatDate(fund.bid_deadline)}</dd>
        <dt>Details</dt><dd>${escapeHtml(fund.details || '—')}</dd>
      </dl>
      <p class="muted" style="background:#FCECEB; border:1px solid #E7B3AE; border-radius:6px; padding:10px 12px; color:#8A2A24;">
        ⚠ This is a one-time, final quote. Once submitted it cannot be revised, edited, or resubmitted — check your figure carefully before confirming.
      </p>
      <form id="quoteForm">
        <label>FD Interest Rate Offered (% p.a.)
          <input type="number" id="quoteRate" min="0.01" max="99" step="0.01" required>
        </label>
        <label>Remarks (optional)
          <textarea id="quoteRemarks" rows="2"></textarea>
        </label>
        <label class="consent-check">
          <input type="checkbox" id="quoteDeclaration" required>
          <span>I hereby declare that the FD interest rate and details entered above are final, correct, and binding for this bank. I understand this quote cannot be changed once submitted.</span>
        </label>
        <button class="btn primary" type="submit">Submit Quote</button>
        <p class="success" id="quoteMsg"></p>
      </form>
    `;
    document.getElementById('quoteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('quoteMsg');
      msg.className = 'success';
      const declared = document.getElementById('quoteDeclaration').checked;
      if (!declared) {
        msg.className = 'error';
        msg.textContent = 'You must tick the declaration checkbox before submitting your quote.';
        return;
      }
      const rateValue = document.getElementById('quoteRate').value;
      if (!confirm(`Submit a final quote of ${rateValue}% for this fund? This cannot be changed once submitted.`)) {
        return;
      }
      try {
        const payload = {
          interest_rate: parseFloat(rateValue),
          remarks: document.getElementById('quoteRemarks').value.trim(),
          declaration: true
        };
        const res = await api(`/quotes/${fundId}`, { method: 'POST', body: JSON.stringify(payload) });
        msg.textContent = res.message;
        loadBankFunds();
      } catch (err) {
        msg.className = 'error'; msg.textContent = err.message;
      }
    });
  } catch (err) {
    content.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

/* =========================================================
   BANK USER: MY DASHBOARD
   ========================================================= */
function bankCurrentFilters() {
  return {
    date_from: document.getElementById('bankFilterDateFrom').value,
    date_to: document.getElementById('bankFilterDateTo').value,
    status: document.getElementById('bankFilterStatus').value
  };
}

async function loadBankDashboard() {
  try {
    const stats = await api('/dashboard/stats' + toQuery(bankCurrentFilters()));
    const k = stats.kpis;
    document.getElementById('bankKpiGrid').innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Funds Participated</div><div class="kpi-value">${k.total_funds}</div></div>
      <div class="kpi-card gold"><div class="kpi-label">Amount Won</div><div class="kpi-value">${formatMoney(k.awarded_amount)}</div></div>
      <div class="kpi-card"><div class="kpi-label">Open</div><div class="kpi-value">${k.open_count}</div></div>
      <div class="kpi-card"><div class="kpi-label">Awarded to Us</div><div class="kpi-value">${k.awarded_count}</div></div>
    `;
    destroyChart('bankStatus');
    charts.bankStatus = new Chart(document.getElementById('bankStatusChart'), {
      type: 'doughnut',
      data: { labels: stats.byStatus.map(r => statusLabel(r.status)), datasets: [{ data: stats.byStatus.map(r => r.count), backgroundColor: ['#2C5F7C', '#B3852E', '#1F7A4D', '#B3261E'] }] },
      options: { plugins: { legend: { position: 'bottom' } } }
    });
    destroyChart('bankMonth');
    charts.bankMonth = new Chart(document.getElementById('bankMonthChart'), {
      type: 'bar',
      data: { labels: stats.byMonth.map(r => r.month), datasets: [{ label: 'Funds Participated', data: stats.byMonth.map(r => r.count), backgroundColor: '#14304D' }] },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  } catch (err) {
    console.error(err);
  }
}

// ---------- Utils ----------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* =========================================================
   ADMIN/MASTER: FD DEPOSITS TAB (deposit-to-maturity lifecycle)
   ========================================================= */
function depositFilters() {
  return {
    date_from: document.getElementById('depFilterDateFrom').value,
    date_to: document.getElementById('depFilterDateTo').value,
    status: document.getElementById('depFilterStatus').value,
    bank_id: document.getElementById('depFilterBank').value
  };
}

async function loadDepositsBankFilter() {
  try {
    const banks = await api('/auth/banks');
    const sel = document.getElementById('depFilterBank');
    const previousValue = sel.value;
    sel.innerHTML = `<option value="">All</option>` + banks.map(b => `<option value="${b.id}">${escapeHtml(b.bank_name)}</option>`).join('');
    if (previousValue && banks.some(b => String(b.id) === previousValue)) sel.value = previousValue;
  } catch { /* non-critical */ }
}

function depositStatusBadge(row) {
  if (row.status === 'matured') return `<span class="badge awarded">matured</span>`;
  if (row.status === 'active' && row.maturity_due) return `<span class="badge result_declared">maturity due</span>`;
  if (row.status === 'active') return `<span class="badge open">active</span>`;
  return `<span class="badge cancelled">pending deposit</span>`;
}

async function loadDeposits() {
  try {
    const summary = await api('/deposits/summary' + toQuery(depositFilters()));
    document.getElementById('depKpiGrid').innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Total Records</div><div class="kpi-value">${summary.total_deposits}</div></div>
      <div class="kpi-card"><div class="kpi-label">Pending Deposit</div><div class="kpi-value">${summary.pending_deposit_count}</div></div>
      <div class="kpi-card"><div class="kpi-label">Active</div><div class="kpi-value">${summary.active_count}</div></div>
      <div class="kpi-card gold"><div class="kpi-label">Maturity Due</div><div class="kpi-value">${summary.maturity_due_count}</div></div>
      <div class="kpi-card"><div class="kpi-label">Matured</div><div class="kpi-value">${summary.matured_count}</div></div>
      <div class="kpi-card"><div class="kpi-label">Total Deposited</div><div class="kpi-value">${formatMoney(summary.total_deposited)}</div></div>
      <div class="kpi-card success-accent"><div class="kpi-label">Total Matured Amount</div><div class="kpi-value">${formatMoney(summary.total_matured_amount)}</div></div>
      <div class="kpi-card success-accent"><div class="kpi-label">Total Interest Earned</div><div class="kpi-value">${formatMoney(summary.total_interest_earned)}</div></div>
    `;
  } catch (err) { console.error(err); }

  const tbody = document.querySelector('#depositsTable tbody');
  tbody.innerHTML = `<tr><td colspan="12">Loading…</td></tr>`;
  try {
    const rows = await api('/deposits' + toQuery(depositFilters()));
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="12">No awarded funds yet — deposit tracking starts automatically once a fund is awarded.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const interest = r.maturity_amount != null ? (r.maturity_amount - r.deposit_amount) : null;
      let actionBtn = '';
      if (r.status === 'pending_deposit') actionBtn = `<button class="btn small outline" data-action="deposit" data-fund="${r.fund_id}">Mark Deposited</button>`;
      else if (r.status === 'active') actionBtn = `<button class="btn small gold" data-action="mature" data-fund="${r.fund_id}">Record Maturity</button>`;
      else actionBtn = `<span class="muted">Complete</span>`;
      return `
        <tr>
          <td class="mono">${escapeHtml(r.reference_no)}</td>
          <td>${escapeHtml(r.title)}</td>
          <td>${escapeHtml(r.bank_name)}</td>
          <td class="mono">${r.fd_rate}%</td>
          <td>${tenureLabel(r.tenure_days)}</td>
          <td>${depositStatusBadge(r)}</td>
          <td class="mono">${r.deposit_amount != null ? formatMoney(r.deposit_amount) : '—'}</td>
          <td>${r.deposit_date ? formatDate(r.deposit_date) : '—'}</td>
          <td>${r.maturity_date ? formatDate(r.maturity_date) : '—'}</td>
          <td class="mono">${r.maturity_amount != null ? formatMoney(r.maturity_amount) : '—'}</td>
          <td class="mono">${interest != null ? formatMoney(interest) : '—'}</td>
          <td>${actionBtn}</td>
        </tr>
      `;
    }).join('');
    tbody.querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.action === 'deposit') openDepositRecordModal(btn.dataset.fund, rows.find(r => r.fund_id == btn.dataset.fund));
        else openMaturityRecordModal(btn.dataset.fund, rows.find(r => r.fund_id == btn.dataset.fund));
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="12" class="error">${err.message}</td></tr>`;
  }
}

async function onExportDepositsExcel() {
  const btn = document.getElementById('depExportExcelBtn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Exporting…';
  try {
    await downloadFile('/deposits/export/excel' + toQuery(depositFilters()));
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function openDepositRecordModal(fundId, row) {
  const modal = document.getElementById('depositModal');
  const content = document.getElementById('depositModalContent');
  const today = new Date().toISOString().slice(0, 10);
  content.innerHTML = `
    <h3>Record FD Deposit</h3>
    <dl class="kv">
      <dt>Reference No.</dt><dd class="mono">${escapeHtml(row.reference_no)}</dd>
      <dt>Bank</dt><dd>${escapeHtml(row.bank_name)}</dd>
      <dt>FD Rate</dt><dd class="mono">${row.fd_rate}% <span class="muted">(fixed at award)</span></dd>
      <dt>Tenure</dt><dd>${tenureLabel(row.tenure_days)} <span class="muted">(fixed at award)</span></dd>
      <dt>Amount to Deposit</dt><dd class="mono">${formatMoney(row.awarded_amount)} <span class="muted">(fixed — the awarded fund amount)</span></dd>
    </dl>
    <p class="muted" style="background:#F0F4F8; border:1px solid var(--border); border-radius:6px; padding:10px 12px;">
      Rate, tenure, and amount were all fixed when this fund was awarded and cannot be edited here — this prevents any mismatch between the award and the actual deposit. Only the deposit date is entered below.
    </p>
    <form id="depositForm">
      <label>Deposit Date
        <input type="date" id="depDate" value="${today}" required>
      </label>
      <p class="muted">Maturity date will be calculated automatically as deposit date + ${row.tenure_days} days.</p>
      <button class="btn primary" type="submit">Confirm Deposit of ${formatMoney(row.awarded_amount)}</button>
      <p class="success" id="depositFormMsg"></p>
    </form>
  `;
  document.getElementById('depositForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('depositFormMsg');
    msg.className = 'success';
    try {
      const payload = {
        deposit_date: new Date(document.getElementById('depDate').value).toISOString()
      };
      const res = await api(`/deposits/${fundId}/deposit`, { method: 'POST', body: JSON.stringify(payload) });
      msg.textContent = `${res.message} Maturity date: ${formatDate(res.maturity_date)}.`;
      loadDeposits();
    } catch (err) {
      msg.className = 'error'; msg.textContent = err.message;
    }
  });
  modal.hidden = false;
}

function openMaturityRecordModal(fundId, row) {
  const modal = document.getElementById('depositModal');
  const content = document.getElementById('depositModalContent');
  const today = new Date().toISOString().slice(0, 10);

  // Reference calculation only (simple interest) — actual bank-credited amount can legitimately
  // differ slightly (compounding method, TDS, etc.), so this pre-fills the field as a sanity
  // check rather than being enforced outright like the deposit amount is.
  const expectedMaturity = row.deposit_amount * (1 + (row.fd_rate / 100) * (row.tenure_days / 365));

  content.innerHTML = `
    <h3>Record FD Maturity</h3>
    <dl class="kv">
      <dt>Reference No.</dt><dd class="mono">${escapeHtml(row.reference_no)}</dd>
      <dt>Bank</dt><dd>${escapeHtml(row.bank_name)}</dd>
      <dt>FD Rate</dt><dd class="mono">${row.fd_rate}%</dd>
      <dt>Amount Deposited</dt><dd class="mono">${formatMoney(row.deposit_amount)}</dd>
      <dt>Deposit Date</dt><dd>${formatDate(row.deposit_date)}</dd>
      <dt>Maturity Date</dt><dd>${formatDate(row.maturity_date)}</dd>
      <dt>Expected Amount</dt><dd class="mono">${formatMoney(expectedMaturity)} <span class="muted">(calculated, simple interest — for reference)</span></dd>
    </dl>
    <form id="maturityForm">
      <label>Actual Amount Received at Maturity (₹)
        <input type="number" id="matAmount" min="1" step="0.01" value="${expectedMaturity.toFixed(2)}" required>
      </label>
      <p class="muted" id="matDiffNote"></p>
      <label>Date Received
        <input type="date" id="matDate" value="${today}" required>
      </label>
      <button class="btn gold" type="submit">Confirm Maturity Received</button>
      <p class="success" id="maturityFormMsg"></p>
    </form>
  `;

  const matAmountInput = document.getElementById('matAmount');
  const diffNote = document.getElementById('matDiffNote');
  const updateDiffNote = () => {
    const entered = parseFloat(matAmountInput.value);
    if (isNaN(entered)) { diffNote.textContent = ''; return; }
    const diff = entered - expectedMaturity;
    const pct = (diff / expectedMaturity) * 100;
    if (Math.abs(pct) < 0.5) {
      diffNote.className = 'muted';
      diffNote.textContent = 'Matches the expected calculated amount.';
    } else {
      diffNote.className = 'error';
      diffNote.textContent = `⚠ ${diff > 0 ? '+' : ''}${formatMoney(diff)} (${pct.toFixed(2)}%) different from the calculated expected amount — double-check this figure against the bank's actual credit before confirming.`;
    }
  };
  matAmountInput.addEventListener('input', updateDiffNote);
  updateDiffNote();

  document.getElementById('maturityForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = document.getElementById('maturityFormMsg');
    msg.className = 'success';
    try {
      const payload = {
        maturity_amount: parseFloat(matAmountInput.value),
        maturity_received_date: new Date(document.getElementById('matDate').value).toISOString()
      };
      const res = await api(`/deposits/${fundId}/mature`, { method: 'POST', body: JSON.stringify(payload) });
      msg.textContent = `${res.message} Interest earned: ${formatMoney(res.interest_earned)}.`;
      loadDeposits();
      loadDashboard();
    } catch (err) {
      msg.className = 'error'; msg.textContent = err.message;
    }
  });
  modal.hidden = false;
}
