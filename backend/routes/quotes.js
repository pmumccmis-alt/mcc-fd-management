const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- SUBMIT OR UPDATE A QUOTE (bank only) ----------
// Banks may revise their quote any number of times up until the bid deadline / bidding closes.
router.post('/:fundId',
  authenticate,
  requireRole('bank'),
  body('interest_rate').isFloat({ gt: 0, lt: 100 }).withMessage('Interest rate must be a realistic percentage.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const fund = db.prepare('SELECT * FROM funds WHERE id = ?').get(req.params.fundId);
    if (!fund) return res.status(404).json({ error: 'Fund not found.' });
    if (fund.status !== 'open') return res.status(400).json({ error: 'Bidding is not open for this fund.' });
    if (new Date(fund.bid_deadline).getTime() < Date.now()) {
      return res.status(400).json({ error: 'The bid deadline for this fund has passed.' });
    }

    const { interest_rate, remarks } = req.body;
    const existing = db.prepare('SELECT * FROM quotes WHERE fund_id = ? AND bank_id = ?').get(fund.id, req.user.id);

    if (existing) {
      db.prepare(`
        UPDATE quotes SET interest_rate = ?, remarks = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(interest_rate, remarks || null, existing.id);
    } else {
      db.prepare(`
        INSERT INTO quotes (fund_id, bank_id, interest_rate, remarks)
        VALUES (?, ?, ?, ?)
      `).run(fund.id, req.user.id, interest_rate, remarks || null);
    }

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'SUBMIT_QUOTE', `Quoted ${interest_rate}% on fund ${fund.reference_no}`);

    res.json({ message: existing ? 'Quote updated.' : 'Quote submitted.' });
  }
);

module.exports = router;
