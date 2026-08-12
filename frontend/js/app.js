const API = '/api';

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

// ---------- View switching ----------
function showView(name) {
  document.getElementById('loginView').hidden = name !== 'login';
  document.getElementById('adminView').hidden = name !== 'admin';
  document.getElementById('bankView').hidden = name !== 'bank';
  document.getElementById('sessionBox').hidden = name === 'login';
}

function renderSessionBox() {
  const user = getUser();
  if (!user) return;
  const label = user.role === 'admin'
    ? `${user.full_name || user.username} · MCC Admin`
    : `${user.bank_name || user.username} · Bank User`;
  document.getElementById('whoami').textContent = label;
}

// ---------- Formatting ----------
function formatMoney(n) {
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
  return `<span class="badge ${status}">${status}</span>`;
}

// ---------- Boot ----------
window.addEventListener('DOMContentLoaded', () => {
  const user = getUser();
  if (user && getToken()) {
    renderSessionBox();
    if (user.role === 'admin') { showView('admin'); loadFunds(); loadBanks(); }
    else { showView('bank'); loadBankFunds(); }
  } else {
    showView('login');
  }
  wireEvents();
});

function wireEvents() {
  document.getElementById('loginForm').addEventListener('submit', onLogin);
  document.getElementById('logoutBtn').addEventListener('click', () => {
    clearSession();
    showView('login');
  });

  // Admin tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('refreshFundsBtn').addEventListener('click', loadFunds);
  document.getElementById('newFundForm').addEventListener('submit', onCreateFund);
  document.getElementById('newBankForm').addEventListener('submit', onCreateBank);

  document.getElementById('closeFundModal').addEventListener('click', () => { document.getElementById('fundModal').hidden = true; });
  document.getElementById('closeQuoteModal').addEventListener('click', () => { document.getElementById('quoteModal').hidden = true; });
}

// ---------- Login ----------
async function onLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    setSession(data.token, data.user);
    renderSessionBox();
    if (data.user.role === 'admin') { showView('admin'); loadFunds(); loadBanks(); }
    else { showView('bank'); loadBankFunds(); }
  } catch (err) {
    errEl.textContent = err.message;
  }
}

/* =========================================================
   ADMIN: FUNDS
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
    tbody.innerHTML = funds.map(f => `
      <tr>
        <td class="mono">${f.reference_no}</td>
        <td>${escapeHtml(f.title)}</td>
        <td class="mono">${formatMoney(f.amount)}</td>
        <td>${tenureLabel(f.tenure_days)}</td>
        <td>${formatDate(f.bid_deadline)}</td>
        <td>${badge(f.status)}</td>
        <td>${f.quote_count}</td>
        <td>${f.status === 'awarded' ? `<span class="mono">${f.awarded_rate}%</span><br><small>${escapeHtml(f.awarded_bank_name || '')}</small>` : '—'}</td>
        <td><button class="btn small outline" data-id="${f.id}">Manage</button></td>
      </tr>
    `).join('');
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
  msg.textContent = '';
  msg.className = 'success';
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
    msg.textContent = `Fund ${res.reference_no} published. Banks can now submit rate quotations.`;
    e.target.reset();
    loadFunds();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
}

async function openFundModal(id) {
  const modal = document.getElementById('fundModal');
  const content = document.getElementById('fundModalContent');
  content.innerHTML = 'Loading…';
  modal.hidden = false;

  try {
    const [fund, quotes] = await Promise.all([api(`/funds/${id}`), api(`/funds/${id}/quotes`)]);
    renderFundModal(fund, quotes);
  } catch (err) {
    content.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

function renderFundModal(fund, quotes) {
  const content = document.getElementById('fundModalContent');
  const sorted = [...quotes].sort((a, b) => b.interest_rate - a.interest_rate || new Date(a.submitted_at) - new Date(b.submitted_at));
  const h1 = sorted[0];

  const quoteListHtml = sorted.length
    ? `<ul class="rank-list">` + sorted.map((q, i) => `
        <li class="${i === 0 ? 'h1' : ''}">
          <span>${escapeHtml(q.bank_name)} ${i === 0 ? '<span class="h1-tag">H1</span>' : ''}</span>
          <span class="rate">${q.interest_rate}%</span>
        </li>`).join('') + `</ul>`
    : `<p class="muted">No quotations received yet.</p>`;

  let actionsHtml = '';
  if (fund.status === 'open') {
    actionsHtml = `<button class="btn primary" id="closeBidBtn">Close Bidding</button>
                    <button class="btn danger" id="cancelFundBtn">Cancel Fund</button>`;
  } else if (fund.status === 'closed') {
    actionsHtml = `${h1 ? `<button class="btn gold" id="awardH1Btn">Award to H1 (${escapeHtml(h1.bank_name)} @ ${h1.interest_rate}%)</button>` : '<p class="muted">No quotes to award.</p>'}
                    <button class="btn danger" id="cancelFundBtn">Cancel Fund</button>`;
  } else if (fund.status === 'awarded') {
    actionsHtml = `<p class="success">Awarded to <strong>${escapeHtml(fund.awarded_bank_name)}</strong> at <strong>${fund.awarded_rate}%</strong> on ${formatDate(fund.awarded_at)}.</p>`;
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

  const closeBidBtn = document.getElementById('closeBidBtn');
  if (closeBidBtn) closeBidBtn.addEventListener('click', async () => {
    if (!confirm('Close bidding for this fund? Banks will no longer be able to submit or revise quotes.')) return;
    try { await api(`/funds/${fund.id}/close`, { method: 'POST' }); await openFundModal(fund.id); loadFunds(); }
    catch (err) { errEl().textContent = err.message; }
  });

  const cancelBtn = document.getElementById('cancelFundBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', async () => {
    if (!confirm('Cancel this fund entry? This cannot be undone.')) return;
    try { await api(`/funds/${fund.id}/cancel`, { method: 'POST' }); document.getElementById('fundModal').hidden = true; loadFunds(); }
    catch (err) { errEl().textContent = err.message; }
  });

  const awardBtn = document.getElementById('awardH1Btn');
  if (awardBtn) awardBtn.addEventListener('click', async () => {
    if (!confirm(`Award this FD to ${h1.bank_name} at ${h1.interest_rate}%? This finalizes the decision.`)) return;
    try { await api(`/funds/${fund.id}/award`, { method: 'POST', body: JSON.stringify({}) }); await openFundModal(fund.id); loadFunds(); }
    catch (err) { errEl().textContent = err.message; }
  });
}

/* =========================================================
   ADMIN: BANKS
   ========================================================= */
async function loadBanks() {
  const tbody = document.querySelector('#banksTable tbody');
  tbody.innerHTML = `<tr><td colspan="4">Loading…</td></tr>`;
  try {
    const banks = await api('/auth/banks');
    if (!banks.length) {
      tbody.innerHTML = `<tr><td colspan="4">No banks added yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = banks.map(b => `
      <tr>
        <td>${escapeHtml(b.bank_name)}</td>
        <td class="mono">${escapeHtml(b.username)}</td>
        <td>${b.is_active ? badge('open') : badge('cancelled')}</td>
        <td><button class="btn small outline" data-id="${b.id}" data-active="${b.is_active}">${b.is_active ? 'Deactivate' : 'Activate'}</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('button[data-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active === '1' ? false : true;
        try { await api(`/auth/banks/${btn.dataset.id}/status`, { method: 'PATCH', body: JSON.stringify({ is_active: newActive }) }); loadBanks(); }
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
  msg.className = 'success';
  msg.textContent = '';
  try {
    const payload = {
      bank_name: document.getElementById('bankName').value.trim(),
      username: document.getElementById('bankUsername').value.trim(),
      password: document.getElementById('bankPassword').value
    };
    await api('/auth/banks', { method: 'POST', body: JSON.stringify(payload) });
    msg.textContent = `Login created for ${payload.bank_name}. Share the username/password with the bank securely.`;
    e.target.reset();
    loadBanks();
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
}

/* =========================================================
   BANK USER: VIEW OPEN FUNDS + SUBMIT QUOTES
   ========================================================= */
async function loadBankFunds() {
  const tbody = document.querySelector('#bankFundsTable tbody');
  tbody.innerHTML = `<tr><td colspan="8">Loading…</td></tr>`;
  try {
    const funds = await api('/funds');
    if (!funds.length) {
      tbody.innerHTML = `<tr><td colspan="8">No open fund requirements at the moment.</td></tr>`;
      return;
    }
    tbody.innerHTML = funds.map(f => {
      let result = '—';
      if (f.status === 'awarded') {
        result = f.awarded_bank_name ? `<span class="badge awarded">awarded</span>` : '—';
      }
      const canQuote = f.status === 'open' && new Date(f.bid_deadline).getTime() > Date.now();
      return `
        <tr>
          <td class="mono">${f.reference_no}</td>
          <td>${escapeHtml(f.title)}</td>
          <td class="mono">${formatMoney(f.amount)}</td>
          <td>${tenureLabel(f.tenure_days)}</td>
          <td>${formatDate(f.bid_deadline)}</td>
          <td>${badge(f.status)}</td>
          <td>${f.my_rate != null ? `<span class="mono">${f.my_rate}%</span>` : '<span class="muted">Not quoted</span>'}</td>
          <td>${canQuote ? `<button class="btn small outline" data-id="${f.id}">${f.my_rate != null ? 'Revise Quote' : 'Submit Quote'}</button>` : result}</td>
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
        <dt>Bid Deadline</dt><dd>${formatDate(fund.bid_deadline)}</dd>
        <dt>Details</dt><dd>${escapeHtml(fund.details || '—')}</dd>
      </dl>
      <form id="quoteForm">
        <label>FD Interest Rate Offered (% p.a.)
          <input type="number" id="quoteRate" min="0.01" max="99" step="0.01" required>
        </label>
        <label>Remarks (optional)
          <textarea id="quoteRemarks" rows="2"></textarea>
        </label>
        <button class="btn primary" type="submit">Submit Quote</button>
        <p class="success" id="quoteMsg"></p>
      </form>
    `;
    document.getElementById('quoteForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('quoteMsg');
      msg.className = 'success';
      try {
        const payload = {
          interest_rate: parseFloat(document.getElementById('quoteRate').value),
          remarks: document.getElementById('quoteRemarks').value.trim()
        };
        const res = await api(`/quotes/${fundId}`, { method: 'POST', body: JSON.stringify(payload) });
        msg.textContent = res.message;
        loadBankFunds();
      } catch (err) {
        msg.className = 'error';
        msg.textContent = err.message;
      }
    });
  } catch (err) {
    content.innerHTML = `<p class="error">${err.message}</p>`;
  }
}

// ---------- Utils ----------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
