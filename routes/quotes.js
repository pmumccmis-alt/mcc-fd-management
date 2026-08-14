const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- SUBMIT A QUOTE (bank only) — ONE-TIME ONLY, NOT REVISABLE ----------
// This is a final, binding quote, not a bid that can be revised. Each bank gets exactly one
// submission per fund. Once submitted, it is locked — this is enforced here at the API level,
// not just hidden in the UI, so it cannot be bypassed by calling the endpoint directly.
// A quote also cannot be submitted without ticking the declaration checkbox ("I hereby declare
// this quote is correct and binding").
router.post('/:fundId',
  authenticate,
  requireRole('bank'),
  body('interest_rate').isFloat({ gt: 0, lt: 100 }).withMessage('Interest rate must be a realistic percentage.'),
  body('declaration').custom(value => value === true || value === 'true')
    .withMessage('You must tick the declaration checkbox confirming this quote is correct before submitting.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.fundId);
    if (!fund) return res.status(404).json({ error: 'Fund not found.' });
    if (fund.status !== 'open') return res.status(400).json({ error: 'Quote submission is not open for this fund.' });
    if (new Date(fund.bid_deadline).getTime() < Date.now()) {
      return res.status(400).json({ error: 'The quote submission deadline for this fund has passed.' });
    }

    const existing = db.prepare('SELECT id FROM quotes WHERE fund_id = ? AND bank_id = ?').get(fund.id, req.user.id);
    if (existing) {
      return res.status(400).json({ error: 'You have already submitted a quote for this fund. Quotes are final and cannot be resubmitted or revised.' });
    }

    const { interest_rate, remarks } = req.body;
    db.prepare(`
      INSERT INTO quotes (fund_id, bank_id, interest_rate, remarks, consent_declared)
      VALUES (?, ?, ?, ?, 1)
    `).run(fund.id, req.user.id, interest_rate, remarks || null);

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'SUBMIT_QUOTE', `Quoted ${interest_rate}% on fund ${fund.reference_no} (declaration confirmed, final)`);

    res.json({ message: 'Quote submitted. This is final and cannot be changed.' });
  }
);

module.exports = router;
