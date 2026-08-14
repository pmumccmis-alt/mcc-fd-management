const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { declareOverdueResults } = require('../services/scheduler');

const router = express.Router();

// Any read that depends on "is the deadline over yet" first runs the same check the
// background scheduler runs, so results never look stale even if the interval hasn't ticked.
router.use((req, res, next) => { declareOverdueResults(); next(); });

function generateReferenceNo() {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM funds WHERE reference_no LIKE ?`).get(`MCC/FD/${year}/%`);
  const seq = String((row.c || 0) + 1).padStart(4, '0');
  return `MCC/FD/${year}/${seq}`;
}

// ---------- CREATE FUND (master or admin/officer) ----------
router.post('/',
  authenticate,
  requireRole('master', 'admin'),
  body('title').trim().notEmpty(),
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be a positive number.'),
  body('tenure_days').isInt({ gt: 0 }).withMessage('Tenure (days) must be a positive integer.'),
  body('bid_deadline').isISO8601().withMessage('bid_deadline must be a valid date/time.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    if (new Date(req.body.bid_deadline).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'Bid deadline must be in the future.' });
    }

    const { title, department, details, amount, tenure_days, bid_deadline } = req.body;
    const reference_no = generateReferenceNo();

    const result = db.prepare(`
      INSERT INTO funds (reference_no, title, department, details, amount, tenure_days, bid_deadline, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).run(reference_no, title, department || null, details || null, amount, tenure_days, bid_deadline, req.user.id);

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'CREATE_FUND', `Created fund ${reference_no}: ${title} (Rs. ${amount})`);

    res.status(201).json({ id: result.lastInsertRowid, reference_no });
  }
);

// ---------- LIST FUNDS (supports filters for the dashboard/table) ----------
// Query params: status, department, bank_id, date_from, date_to (filter on created_at), q (title search)
router.get('/', authenticate, (req, res) => {
  const { status, department, bank_id, date_from, date_to, q } = req.query;
  const clauses = [];
  const params = [];

  if (req.user.role === 'bank') {
    clauses.push(`(f.status = 'open' OR f.id IN (SELECT fund_id FROM quotes WHERE bank_id = ?))`);
    params.push(req.user.id);
  }
  if (status) { clauses.push('f.status = ?'); params.push(status); }
  if (department) { clauses.push('f.department = ?'); params.push(department); }
  if (bank_id && req.user.role !== 'bank') { clauses.push('f.awarded_bank_id = ?'); params.push(bank_id); }
  if (date_from) { clauses.push('date(f.created_at) >= date(?)'); params.push(date_from); }
  if (date_to) { clauses.push('date(f.created_at) <= date(?)'); params.push(date_to); }
  if (q) { clauses.push('f.title LIKE ?'); params.push(`%${q}%`); }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const selectExtra = req.user.role === 'bank'
    ? `(SELECT interest_rate FROM quotes q WHERE q.fund_id = f.id AND q.bank_id = ?) AS my_rate`
    : `(SELECT COUNT(*) FROM quotes q WHERE q.fund_id = f.id) AS quote_count`;

  const sql = `
    SELECT f.*, ub.bank_name AS awarded_bank_name, rb.bank_name AS result_bank_name, ${selectExtra}
    FROM funds f
    LEFT JOIN users ub ON ub.id = f.awarded_bank_id
    LEFT JOIN users rb ON rb.id = f.result_bank_id
    ${where}
    ORDER BY f.created_at DESC
  `;

  const finalParams = req.user.role === 'bank' ? [req.user.id, ...params] : params;
  const funds = db.prepare(sql).all(...finalParams);
  res.json(funds);
});

// ---------- DISTINCT DEPARTMENTS (for filter dropdown) ----------
router.get('/meta/departments', authenticate, (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT department FROM funds WHERE department IS NOT NULL AND department != '' ORDER BY department`).all();
  res.json(rows.map(r => r.department));
});

// ---------- EXPORT TO EXCEL (master/admin) ----------
// Respects the same filters as GET /funds (status, department, bank_id, date_from, date_to, q)
// and includes full result/award detail (bank, rate, amount, dates) for every fund.
// NOTE: this must be defined BEFORE GET /:id, otherwise Express would treat "export" as an :id.
router.get('/export/excel', authenticate, requireRole('master', 'admin'), (req, res) => {
  const XLSX = require('xlsx');
  const { status, department, bank_id, date_from, date_to, q } = req.query;
  const clauses = [];
  const params = [];
  if (status) { clauses.push('f.status = ?'); params.push(status); }
  if (department) { clauses.push('f.department = ?'); params.push(department); }
  if (bank_id) { clauses.push('f.awarded_bank_id = ?'); params.push(bank_id); }
  if (date_from) { clauses.push('date(f.created_at) >= date(?)'); params.push(date_from); }
  if (date_to) { clauses.push('date(f.created_at) <= date(?)'); params.push(date_to); }
  if (q) { clauses.push('f.title LIKE ?'); params.push(`%${q}%`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      f.reference_no AS "Reference No.",
      f.title AS "Title",
      f.department AS "Department",
      f.amount AS "Amount (Rs.)",
      f.tenure_days AS "Tenure (days)",
      f.bid_deadline AS "Bid Deadline",
      f.status AS "Status",
      rb.bank_name AS "H1 / Result Bank",
      f.result_rate AS "H1 Rate (%)",
      f.result_declared_at AS "Result Declared At",
      ab.bank_name AS "Awarded Bank",
      f.awarded_rate AS "Awarded Rate (%)",
      f.awarded_at AS "Awarded At",
      officer.full_name AS "Awarded By",
      creator.full_name AS "Created By",
      f.created_at AS "Created At",
      f.details AS "Details"
    FROM funds f
    LEFT JOIN users rb ON rb.id = f.result_bank_id
    LEFT JOIN users ab ON ab.id = f.awarded_bank_id
    LEFT JOIN users officer ON officer.id = f.awarded_by
    LEFT JOIN users creator ON creator.id = f.created_by
    ${where}
    ORDER BY f.created_at DESC
  `).all(...params);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 18 },
    { wch: 16 }, { wch: 24 }, { wch: 10 }, { wch: 18 }, { wch: 24 }, { wch: 12 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 30 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'FD Funds');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = `MCC_FD_Funds_${new Date().toISOString().slice(0, 10)}.xlsx`;

  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'EXPORT_EXCEL', `Exported ${rows.length} fund record(s) to Excel`);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ---------- GET SINGLE FUND ----------
router.get('/:id', authenticate, (req, res) => {
  const fund = db.prepare(`
    SELECT f.*, ub.bank_name AS awarded_bank_name, rb.bank_name AS result_bank_name
    FROM funds f
    LEFT JOIN users ub ON ub.id = f.awarded_bank_id
    LEFT JOIN users rb ON rb.id = f.result_bank_id
    WHERE f.id = ?
  `).get(req.params.id);

  if (!fund) return res.status(404).json({ error: 'Fund not found.' });

  if (req.user.role === 'bank' && fund.status === 'open') {
    // visible to all banks while open
  } else if (req.user.role === 'bank') {
    const mine = db.prepare('SELECT id FROM quotes WHERE fund_id = ? AND bank_id = ?').get(fund.id, req.user.id);
    if (!mine) return res.status(403).json({ error: 'This fund is not visible to you.' });
  }

  res.json(fund);
});

// ---------- GET QUOTES FOR A FUND ----------
// Sealed-bid rule: while a fund is still 'open' (before the deadline), submitted rates are
// confidential — only MASTER can view them, to prevent an Officer from seeing rates and
// steering the outcome before the deadline auto-declares the result. Once the result is
// declared (or the fund is awarded), Officers can see the full ranked list too, same as Master.
// Banks only ever see their own quote, never competitors' rates.
router.get('/:id/quotes', authenticate, (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });

  if (req.user.role === 'admin' && fund.status === 'open') {
    return res.status(403).json({
      error: 'Quotes are sealed until the bid deadline passes. Only the Master role can view live quotes before the result is declared.'
    });
  }

  if (req.user.role === 'master' || req.user.role === 'admin') {
    const quotes = db.prepare(`
      SELECT q.*, u.bank_name, u.username
      FROM quotes q JOIN users u ON u.id = q.bank_id
      WHERE q.fund_id = ?
      ORDER BY q.interest_rate DESC, q.submitted_at ASC
    `).all(fund.id);
    return res.json(quotes);
  }

  const quote = db.prepare(`SELECT q.* FROM quotes q WHERE q.fund_id = ? AND q.bank_id = ?`).get(fund.id, req.user.id);
  res.json(quote ? [quote] : []);
});

// NOTE: There is intentionally no manual "close bidding early" endpoint. Results are declared
// automatically — and only automatically — the moment bid_deadline passes (see
// services/scheduler.js). This keeps the sealed-bid process tamper-proof: no one, including
// Master, can force an early close to lock in a particular outcome.

// ---------- AWARD FUND (master/admin) ----------
// Defaults to the auto-declared H1. An officer/master may override with a specific bank_id
// (e.g. if H1 is disqualified) — always logged, and the original H1 result stays visible.
router.post('/:id/award', authenticate, requireRole('master', 'admin'), (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  if (fund.status === 'awarded') return res.status(400).json({ error: 'Fund is already awarded.' });
  if (fund.status === 'open') return res.status(400).json({ error: 'Result has not been declared yet — the fund becomes eligible for award automatically once its bid deadline passes.' });

  let winningQuote;
  if (req.body.bank_id) {
    winningQuote = db.prepare('SELECT * FROM quotes WHERE fund_id = ? AND bank_id = ?').get(fund.id, req.body.bank_id);
    if (!winningQuote) return res.status(400).json({ error: 'Selected bank has not submitted a quote for this fund.' });
  } else {
    if (!fund.result_bank_id) return res.status(400).json({ error: 'No quotes were received for this fund — nothing to award.' });
    winningQuote = { bank_id: fund.result_bank_id, interest_rate: fund.result_rate };
  }

  db.prepare(`
    UPDATE funds SET status = 'awarded', awarded_bank_id = ?, awarded_rate = ?, awarded_at = datetime('now'), awarded_by = ?
    WHERE id = ?
  `).run(winningQuote.bank_id, winningQuote.interest_rate, req.user.id, fund.id);

  // Start the deposit-to-maturity tracking record for this award — an Officer/Master will
  // record the actual deposit date/amount once the money is physically placed with the bank.
  db.prepare(`
    INSERT INTO fd_deposits (fund_id, bank_id, fd_rate, tenure_days, status)
    VALUES (?, ?, ?, ?, 'pending_deposit')
  `).run(fund.id, winningQuote.bank_id, winningQuote.interest_rate, fund.tenure_days);

  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'AWARD_FUND', `Awarded fund ${fund.reference_no} to bank_id=${winningQuote.bank_id} at ${winningQuote.interest_rate}%`);

  res.json({ message: 'Fund awarded.', bank_id: winningQuote.bank_id, interest_rate: winningQuote.interest_rate });
});

// ---------- CANCEL FUND (master/admin) ----------
router.post('/:id/cancel', authenticate, requireRole('master', 'admin'), (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  if (fund.status === 'awarded') return res.status(400).json({ error: 'Cannot cancel an already-awarded fund.' });

  db.prepare(`UPDATE funds SET status = 'cancelled' WHERE id = ?`).run(fund.id);
  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'CANCEL_FUND', `Cancelled fund ${fund.reference_no}`);
  res.json({ message: 'Fund cancelled.' });
});

module.exports = router;
