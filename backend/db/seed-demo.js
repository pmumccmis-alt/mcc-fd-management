/**
 * DEMO DATA SEED SCRIPT
 * ----------------------
 * Populates the database with realistic, INTERNALLY CONSISTENT demo data so every chart,
 * filter, and export on the dashboard has something meaningful to show.
 *
 * Unlike hand-typed dummy data, this script never invents an "awarded rate" that doesn't
 * match a real submitted quote — it always computes H1 the same way the live app does
 * (highest quoted rate, ties broken by earliest submission) and awards accordingly. That's
 * what guarantees you'll never see a mismatch like "Awarded to Bank X at 7.2%" when Bank X's
 * own quote was actually 6.39%.
 *
 * USAGE:
 *   1. Place this file at backend/db/seed-demo.js
 *   2. Run once from the backend/ folder:  node db/seed-demo.js
 *   3. Safe to re-run — it skips creating banks/officers that already exist, and always
 *      adds a fresh batch of demo funds so you can run it again for more test data.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

const MASTER_ID = (() => {
  const master = db.prepare(`SELECT id FROM users WHERE role = 'master' LIMIT 1`).get();
  if (!master) {
    console.error('No master account found. Run `node db/seed.js` first to create one.');
    process.exit(1);
  }
  return master.id;
})();

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randBetween(min, max) { return Math.random() * (max - min) + min; }
function isoDaysFromNow(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
function isoDateStr(d) { return d.toISOString().slice(0, 10); }

// ---------- 1. Ensure a set of demo banks exist ----------
const DEMO_BANKS = [
  { username: 'demo_sbi', bank_name: 'State Bank of India', mobile: '9810000001' },
  { username: 'demo_pnb', bank_name: 'Punjab National Bank', mobile: '9810000002' },
  { username: 'demo_icici', bank_name: 'ICICI Bank', mobile: '9810000003' },
  { username: 'demo_hdfc', bank_name: 'HDFC Bank', mobile: '9810000004' },
  { username: 'demo_axis', bank_name: 'Axis Bank', mobile: '9810000005' },
  { username: 'demo_bob', bank_name: 'Bank of Baroda', mobile: '9810000006' }
];
const bankIds = [];
for (const b of DEMO_BANKS) {
  let row = db.prepare('SELECT id FROM users WHERE username = ?').get(b.username);
  if (!row) {
    const hash = bcrypt.hashSync('DemoPass@123', 10);
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, bank_name, mobile_number, is_active, created_by)
      VALUES (?, ?, 'bank', ?, ?, 1, ?)
    `).run(b.username, hash, b.bank_name, b.mobile, MASTER_ID);
    row = { id: result.lastInsertRowid };
    console.log(`Created demo bank: ${b.bank_name} (login: ${b.username} / DemoPass@123)`);
  }
  bankIds.push(row.id);
}

// ---------- 2. Ensure a couple of demo officers exist ----------
const DEMO_OFFICERS = [
  { username: 'demo_officer1', officer_id: 'MCC-DEMO-001', full_name: 'Anita Sharma', mobile: '9820000001' },
  { username: 'demo_officer2', officer_id: 'MCC-DEMO-002', full_name: 'Rajesh Kumar', mobile: '9820000002' }
];
const officerIds = [MASTER_ID];
for (const o of DEMO_OFFICERS) {
  let row = db.prepare('SELECT id FROM users WHERE username = ?').get(o.username);
  if (!row) {
    const hash = bcrypt.hashSync('DemoPass@123', 10);
    const result = db.prepare(`
      INSERT INTO users (username, officer_id, password_hash, role, full_name, mobile_number, is_active, created_by)
      VALUES (?, ?, ?, 'admin', ?, ?, 1, ?)
    `).run(o.username, o.officer_id, hash, o.full_name, o.mobile, MASTER_ID);
    row = { id: result.lastInsertRowid };
    console.log(`Created demo officer: ${o.full_name} (login: ${o.username} / DemoPass@123)`);
  }
  officerIds.push(row.id);
}

// ---------- 3. Generate demo funds, each with real quotes -> real H1 -> real award ----------
const DEPARTMENTS = ['Water Supply', 'Roads Infrastructure', 'Public Health', 'Sanitation', 'Education Development'];
const TENURES = [90, 180, 365, 730];

function nextReferenceNo() {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM funds WHERE reference_no LIKE ?`).get(`MCC/FD/${year}/%`);
  return `MCC/FD/${year}/${String((row.c || 0) + 1).padStart(4, '0')}`;
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

const PLAN = [
  // { daysAgoCreated, daysUntilDeadline (negative = already passed), outcome }
  ...Array.from({ length: 5 }, () => ({ createdDaysAgo: randInt(60, 150), deadlineOffset: -randInt(5, 40), outcome: 'awarded_matured' })),
  ...Array.from({ length: 4 }, () => ({ createdDaysAgo: randInt(20, 55), deadlineOffset: -randInt(2, 15), outcome: 'awarded_active' })),
  ...Array.from({ length: 3 }, () => ({ createdDaysAgo: randInt(5, 20), deadlineOffset: -randInt(1, 4), outcome: 'result_declared' })),
  ...Array.from({ length: 4 }, () => ({ createdDaysAgo: randInt(0, 5), deadlineOffset: randInt(3, 20), outcome: 'open' })),
  ...Array.from({ length: 2 }, () => ({ createdDaysAgo: randInt(10, 30), deadlineOffset: -randInt(1, 10), outcome: 'cancelled' }))
];
function randInt(min, max) { return Math.floor(randBetween(min, max + 1)); }

let created = 0;
for (const plan of PLAN) {
  const department = pick(DEPARTMENTS);
  const tenure_days = pick(TENURES);
  const amount = Math.round(randBetween(1000000, 95000000) / 10000) * 10000; // round to nearest 10k
  const createdAt = isoDaysFromNow(-plan.createdDaysAgo);
  const bidDeadline = isoDaysFromNow(plan.deadlineOffset);
  const officer = pick(officerIds);
  const reference_no = nextReferenceNo();

  const result = db.prepare(`
    INSERT INTO funds (reference_no, title, department, details, amount, tenure_days, bid_deadline, status, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(
    reference_no,
    `${department} Fund Allocation`,
    department,
    `Demo data — unutilized ${department.toLowerCase()} funds for FD placement.`,
    amount, tenure_days, bidDeadline, officer, createdAt
  );
  const fundId = result.lastInsertRowid;

  if (plan.outcome === 'cancelled') {
    db.prepare(`UPDATE funds SET status = 'cancelled' WHERE id = ?`).run(fundId);
    created++;
    continue;
  }

  // Every non-cancelled fund gets 2-4 real bank quotes with genuinely different rates
  const quotingBanks = [...bankIds].sort(() => Math.random() - 0.5).slice(0, randInt(2, 4));
  const quotes = [];
  for (const bankId of quotingBanks) {
    const rate = Math.round(randBetween(6.2, 8.4) * 100) / 100;
    const submittedAt = isoDaysFromNow(-plan.createdDaysAgo + randInt(0, Math.max(1, Math.abs(plan.deadlineOffset))));
    db.prepare(`
      INSERT INTO quotes (fund_id, bank_id, interest_rate, consent_declared, submitted_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(fundId, bankId, rate, submittedAt, submittedAt);
    quotes.push({ bankId, rate, submittedAt });
  }

  if (plan.outcome === 'open') {
    created++;
    continue; // still open, no result yet — exactly like a real open fund
  }

  // Compute H1 exactly the way the live app's scheduler does: highest rate, ties -> earliest submission
  quotes.sort((a, b) => b.rate - a.rate || new Date(a.submittedAt) - new Date(b.submittedAt));
  const h1 = quotes[0];
  const resultDeclaredAt = bidDeadline; // declared right at the deadline, same as the real scheduler

  db.prepare(`
    UPDATE funds SET status = 'result_declared', result_bank_id = ?, result_rate = ?, result_declared_at = ?
    WHERE id = ?
  `).run(h1.bankId, h1.rate, resultDeclaredAt, fundId);

  if (plan.outcome === 'result_declared') {
    created++;
    continue;
  }

  // Award — always to the real H1, same as clicking "Award to H1" in the UI
  const awardedAt = addDays(resultDeclaredAt, randInt(1, 3));
  db.prepare(`
    UPDATE funds SET status = 'awarded', awarded_bank_id = ?, awarded_rate = ?, awarded_at = ?, awarded_by = ?
    WHERE id = ?
  `).run(h1.bankId, h1.rate, awardedAt, officer, fundId);

  db.prepare(`
    INSERT INTO fd_deposits (fund_id, bank_id, fd_rate, tenure_days, status)
    VALUES (?, ?, ?, ?, 'pending_deposit')
  `).run(fundId, h1.bankId, h1.rate, tenure_days);

  if (plan.outcome === 'awarded_active' || plan.outcome === 'awarded_matured') {
    const depositDate = addDays(awardedAt, randInt(1, 5));
    const maturityDate = addDays(depositDate, tenure_days);
    db.prepare(`
      UPDATE fd_deposits SET deposit_amount = ?, deposit_date = ?, maturity_date = ?, status = 'active', deposited_by = ?
      WHERE fund_id = ?
    `).run(amount, depositDate, maturityDate, officer, fundId);
  }

  if (plan.outcome === 'awarded_matured') {
    // Simple-interest expected amount, same formula the live UI shows as a reference
    const expected = amount * (1 + (h1.rate / 100) * (tenure_days / 365));
    const actual = Math.round(expected * randBetween(0.995, 1.0)); // banks sometimes round down slightly
    const maturityReceivedDate = isoDateStr(new Date()); // received "today" for demo purposes
    db.prepare(`
      UPDATE fd_deposits SET maturity_amount = ?, maturity_received_date = ?, status = 'matured', matured_by = ?
      WHERE fund_id = ?
    `).run(actual, maturityReceivedDate, officer, fundId);
  }

  created++;
}

console.log(`\nDemo data seeded: ${created} funds created (mix of open / result declared / awarded / matured / cancelled).`);
console.log(`Log in as Master (or an Officer/Bank login above) to explore the dashboard, funds, and deposits tabs.`);
console.log(`Re-run this script any time to add another batch of demo funds.`);
