const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

function generateReferenceNo() {
  const year = new Date().getFullYear();
  const row = db.prepare(`SELECT COUNT(*) AS c FROM funds WHERE reference_no LIKE ?`).get(`MCC/FD/${year}/%`);
  const seq = String((row.c || 0) + 1).padStart(4, '0');
  return `MCC/FD/${year}/${seq}`;
}

// ---------- CREATE FUND (admin) ----------
router.post('/',
  authenticate,
  requireRole('admin'),
  body('title').trim().notEmpty(),
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be a positive number.'),
  body('tenure_days').isInt({ gt: 0 }).withMessage('Tenure (days) must be a positive integer.'),
  body('bid_deadline').isISO8601().withMessage('bid_deadline must be a valid date/time.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

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

// ---------- LIST FUNDS ----------
// Admin: sees everything. Bank: sees open funds + any fund they've quoted on / been awarded.
router.get('/', authenticate, (req, res) => {
  let funds;
  if (req.user.role === 'admin') {
    funds = db.prepare(`
      SELECT f.*, u.bank_name AS awarded_bank_name,
        (SELECT COUNT(*) FROM quotes q WHERE q.fund_id = f.id) AS quote_count
      FROM funds f
      LEFT JOIN users u ON u.id = f.awarded_bank_id
      ORDER BY f.created_at DESC
    `).all();
  } else {
    funds = db.prepare(`
      SELECT f.*, u.bank_name AS awarded_bank_name,
        (SELECT interest_rate FROM quotes q WHERE q.fund_id = f.id AND q.bank_id = ?) AS my_rate
      FROM funds f
      LEFT JOIN users u ON u.id = f.awarded_bank_id
      WHERE f.status = 'open'
         OR f.id IN (SELECT fund_id FROM quotes WHERE bank_id = ?)
      ORDER BY f.created_at DESC
    `).all(req.user.id, req.user.id);
  }
  res.json(funds);
});

// ---------- GET SINGLE FUND ----------
router.get('/:id', authenticate, (req, res) => {
  const fund = db.prepare(`
    SELECT f.*, u.bank_name AS awarded_bank_name
    FROM funds f LEFT JOIN users u ON u.id = f.awarded_bank_id
    WHERE f.id = ?
  `).get(req.params.id);

  if (!fund) return res.status(404).json({ error: 'Fund not found.' });

  if (req.user.role === 'bank' && fund.status !== 'open') {
    const mine = db.prepare('SELECT id FROM quotes WHERE fund_id = ? AND bank_id = ?').get(fund.id, req.user.id);
    if (!mine) return res.status(403).json({ error: 'This fund is not visible to you.' });
  }

  res.json(fund);
});

// ---------- GET QUOTES FOR A FUND ----------
// Admin: sees all bank quotes (for evaluation). Bank: sees only its own quote.
router.get('/:id/quotes', authenticate, (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });

  if (req.user.role === 'admin') {
    const quotes = db.prepare(`
      SELECT q.*, u.bank_name, u.username
      FROM quotes q JOIN users u ON u.id = q.bank_id
      WHERE q.fund_id = ?
      ORDER BY q.interest_rate DESC, q.submitted_at ASC
    `).all(fund.id);
    return res.json(quotes);
  }

  const quote = db.prepare(`
    SELECT q.* FROM quotes q WHERE q.fund_id = ? AND q.bank_id = ?
  `).get(fund.id, req.user.id);
  res.json(quote ? [quote] : []);
});

// ---------- CLOSE BIDDING (admin) ----------
// Locks the fund from further quotes. Does not award automatically -
// admin reviews H1 and explicitly awards, so there is always a human decision in the loop.
router.post('/:id/close', authenticate, requireRole('admin'), (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  if (fund.status !== 'open') return res.status(400).json({ error: `Fund is already ${fund.status}.` });

  db.prepare(`UPDATE funds SET status = 'closed' WHERE id = ?`).run(fund.id);
  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'CLOSE_FUND', `Closed bidding for fund ${fund.reference_no}`);

  res.json({ message: 'Bidding closed.' });
});

// ---------- H1 (highest rate) FOR A FUND (admin) ----------
router.get('/:id/h1', authenticate, requireRole('admin'), (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });

  const h1 = db.prepare(`
    SELECT q.*, u.bank_name, u.username
    FROM quotes q JOIN users u ON u.id = q.bank_id
    WHERE q.fund_id = ?
    ORDER BY q.interest_rate DESC, q.submitted_at ASC
    LIMIT 1
  `).get(fund.id);

  if (!h1) return res.status(404).json({ error: 'No quotes have been submitted for this fund yet.' });
  res.json(h1);
});

// ---------- AWARD FUND (admin) ----------
// Defaults to awarding the H1 (highest-rate) bank; admin may override with a specific bank_id
// (e.g. if the H1 bank is disqualified), but the H1 rate is always shown for transparency.
router.post('/:id/award',
  authenticate,
  requireRole('admin'),
  (req, res) => {
    const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
    if (!fund) return res.status(404).json({ error: 'Fund not found.' });
    if (fund.status === 'awarded') return res.status(400).json({ error: 'Fund is already awarded.' });
    if (fund.status === 'open') return res.status(400).json({ error: 'Close bidding before awarding.' });

    let winningQuote;
    if (req.body.bank_id) {
      winningQuote = db.prepare('SELECT * FROM quotes WHERE fund_id = ? AND bank_id = ?').get(fund.id, req.body.bank_id);
      if (!winningQuote) return res.status(400).json({ error: 'Selected bank has not submitted a quote for this fund.' });
    } else {
      winningQuote = db.prepare(`
        SELECT * FROM quotes WHERE fund_id = ? ORDER BY interest_rate DESC, submitted_at ASC LIMIT 1
      `).get(fund.id);
      if (!winningQuote) return res.status(400).json({ error: 'No quotes available to award.' });
    }

    db.prepare(`
      UPDATE funds SET status = 'awarded', awarded_bank_id = ?, awarded_rate = ?, awarded_at = datetime('now')
      WHERE id = ?
    `).run(winningQuote.bank_id, winningQuote.interest_rate, fund.id);

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'AWARD_FUND', `Awarded fund ${fund.reference_no} to bank_id=${winningQuote.bank_id} at ${winningQuote.interest_rate}%`);

    res.json({ message: 'Fund awarded.', bank_id: winningQuote.bank_id, interest_rate: winningQuote.interest_rate });
  }
);

// ---------- CANCEL FUND (admin) ----------
router.post('/:id/cancel', authenticate, requireRole('admin'), (req, res) => {
  const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.id);
  if (!fund) return res.status(404).json({ error: 'Fund not found.' });
  if (fund.status === 'awarded') return res.status(400).json({ error: 'Cannot cancel an already-awarded fund.' });

  db.prepare(`UPDATE funds SET status = 'cancelled' WHERE id = ?`).run(fund.id);
  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'CANCEL_FUND', `Cancelled fund ${fund.reference_no}`);
  res.json({ message: 'Fund cancelled.' });
});

module.exports = router;
