const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// ---------- LIST (with filters) ----------
// Master/Admin: see every deposit. Bank: sees only its own awarded funds' deposit records.
router.get('/', authenticate, (req, res) => {
  const { status, department, bank_id, date_from, date_to } = req.query;
  const clauses = [];
  const params = [];

  if (req.user.role === 'bank') { clauses.push('d.bank_id = ?'); params.push(req.user.id); }
  if (status) { clauses.push('d.status = ?'); params.push(status); }
  if (department) { clauses.push('f.department = ?'); params.push(department); }
  if (bank_id && req.user.role !== 'bank') { clauses.push('d.bank_id = ?'); params.push(bank_id); }
  if (date_from) { clauses.push('date(COALESCE(d.deposit_date, d.created_at)) >= date(?)'); params.push(date_from); }
  if (date_to) { clauses.push('date(COALESCE(d.deposit_date, d.created_at)) <= date(?)'); params.push(date_to); }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      d.*,
      f.reference_no, f.title, f.department, f.amount AS awarded_amount,
      u.bank_name,
      (d.maturity_amount IS NOT NULL) AS has_matured,
      (d.status = 'active' AND date(d.maturity_date) <= date('now')) AS maturity_due
    FROM fd_deposits d
    JOIN funds f ON f.id = d.fund_id
    JOIN users u ON u.id = d.bank_id
    ${where}
    ORDER BY d.created_at DESC
  `).all(...params);

  res.json(rows);
});

// ---------- SUMMARY KPIs ----------
router.get('/summary', authenticate, (req, res) => {
  const scopeClause = req.user.role === 'bank' ? 'WHERE d.bank_id = ?' : '';
  const scopeParams = req.user.role === 'bank' ? [req.user.id] : [];

  const kpis = db.prepare(`
    SELECT
      COUNT(*) AS total_deposits,
      COUNT(CASE WHEN d.status = 'pending_deposit' THEN 1 END) AS pending_deposit_count,
      COUNT(CASE WHEN d.status = 'active' THEN 1 END) AS active_count,
      COUNT(CASE WHEN d.status = 'active' AND date(d.maturity_date) <= date('now') THEN 1 END) AS maturity_due_count,
      COUNT(CASE WHEN d.status = 'matured' THEN 1 END) AS matured_count,
      COALESCE(SUM(CASE WHEN d.status IN ('active','matured') THEN d.deposit_amount ELSE 0 END), 0) AS total_deposited,
      COALESCE(SUM(CASE WHEN d.status = 'matured' THEN d.maturity_amount ELSE 0 END), 0) AS total_matured_amount,
      COALESCE(SUM(CASE WHEN d.status = 'matured' THEN d.maturity_amount - d.deposit_amount ELSE 0 END), 0) AS total_interest_earned
    FROM fd_deposits d
    ${scopeClause}
  `).get(...scopeParams);

  res.json(kpis);
});

// ---------- EXPORT TO EXCEL (master/admin) ----------
// NOTE: defined before /:fundId routes so Express doesn't treat "export" as a fundId.
router.get('/export/excel', authenticate, requireRole('master', 'admin'), (req, res) => {
  const XLSX = require('xlsx');
  const { status, department, bank_id, date_from, date_to } = req.query;
  const clauses = [];
  const params = [];
  if (status) { clauses.push('d.status = ?'); params.push(status); }
  if (department) { clauses.push('f.department = ?'); params.push(department); }
  if (bank_id) { clauses.push('d.bank_id = ?'); params.push(bank_id); }
  if (date_from) { clauses.push('date(COALESCE(d.deposit_date, d.created_at)) >= date(?)'); params.push(date_from); }
  if (date_to) { clauses.push('date(COALESCE(d.deposit_date, d.created_at)) <= date(?)'); params.push(date_to); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      f.reference_no AS "Reference No.",
      f.title AS "Title",
      f.department AS "Department",
      u.bank_name AS "Bank",
      d.fd_rate AS "FD Rate (%)",
      d.tenure_days AS "Tenure (days)",
      d.status AS "Status",
      d.deposit_amount AS "Amount Deposited (Rs.)",
      d.deposit_date AS "Deposit Date",
      d.maturity_date AS "Maturity Date",
      d.maturity_amount AS "Maturity Amount Received (Rs.)",
      d.maturity_received_date AS "Maturity Received Date",
      (d.maturity_amount - d.deposit_amount) AS "Interest Earned (Rs.)"
    FROM fd_deposits d
    JOIN funds f ON f.id = d.fund_id
    JOIN users u ON u.id = d.bank_id
    ${where}
    ORDER BY d.created_at DESC
  `).all(...params);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 24 }, { wch: 10 }, { wch: 12 },
    { wch: 16 }, { wch: 20 }, { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 18 }, { wch: 18 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'FD Deposits');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `MCC_FD_Deposits_${new Date().toISOString().slice(0, 10)}.xlsx`;

  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'EXPORT_DEPOSITS_EXCEL', `Exported ${rows.length} FD deposit record(s) to Excel`);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ---------- MARK AS DEPOSITED (master/admin) ----------
router.post('/:fundId/deposit',
  authenticate,
  requireRole('master', 'admin'),
  body('deposit_amount').isFloat({ gt: 0 }).withMessage('Deposit amount must be a positive number.'),
  body('deposit_date').isISO8601().withMessage('A valid deposit date is required.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const deposit = db.prepare('SELECT * FROM fd_deposits WHERE fund_id = ?').get(req.params.fundId);
    if (!deposit) return res.status(404).json({ error: 'This fund has not been awarded yet — nothing to deposit.' });
    if (deposit.status !== 'pending_deposit') return res.status(400).json({ error: `This deposit is already marked as ${deposit.status}.` });

    const { deposit_amount, deposit_date } = req.body;
    const maturity_date = addDays(deposit_date, deposit.tenure_days);

    db.prepare(`
      UPDATE fd_deposits
      SET deposit_amount = ?, deposit_date = ?, maturity_date = ?, status = 'active', deposited_by = ?
      WHERE id = ?
    `).run(deposit_amount, deposit_date, maturity_date, req.user.id, deposit.id);

    const fund = db.prepare('SELECT reference_no FROM funds WHERE id = ?').get(deposit.fund_id);
    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'FD_DEPOSITED', `Recorded deposit of Rs. ${deposit_amount} for fund ${fund.reference_no}; matures ${maturity_date.slice(0, 10)}`);

    res.json({ message: 'Deposit recorded. Maturity date calculated automatically.', maturity_date });
  }
);

// ---------- RECORD MATURITY (master/admin) ----------
router.post('/:fundId/mature',
  authenticate,
  requireRole('master', 'admin'),
  body('maturity_amount').isFloat({ gt: 0 }).withMessage('Maturity amount must be a positive number.'),
  body('maturity_received_date').isISO8601().withMessage('A valid received date is required.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const deposit = db.prepare('SELECT * FROM fd_deposits WHERE fund_id = ?').get(req.params.fundId);
    if (!deposit) return res.status(404).json({ error: 'Deposit record not found.' });
    if (deposit.status !== 'active') return res.status(400).json({ error: 'This FD must be marked as deposited before its maturity can be recorded.' });

    const { maturity_amount, maturity_received_date } = req.body;

    db.prepare(`
      UPDATE fd_deposits
      SET maturity_amount = ?, maturity_received_date = ?, status = 'matured', matured_by = ?
      WHERE id = ?
    `).run(maturity_amount, maturity_received_date, req.user.id, deposit.id);

    const fund = db.prepare('SELECT reference_no FROM funds WHERE id = ?').get(deposit.fund_id);
    const interest = (maturity_amount - deposit.deposit_amount).toFixed(2);
    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'FD_MATURED', `Recorded maturity of Rs. ${maturity_amount} for fund ${fund.reference_no} (interest earned: Rs. ${interest})`);

    res.json({ message: 'Maturity recorded.', interest_earned: Number(interest) });
  }
);

module.exports = router;
