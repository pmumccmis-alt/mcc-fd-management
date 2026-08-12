const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// Slow down brute-force login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' }
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, bank_name: user.bank_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

// ---------- LOGIN ----------
router.post('/login',
  loginLimiter,
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Username and password are required.' });

    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(user.id, 'LOGIN', `User ${user.username} logged in`);

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, bank_name: user.bank_name, full_name: user.full_name }
    });
  }
);

// ---------- CURRENT USER ----------
router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, role, bank_name, full_name FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json(user);
});

// ---------- CHANGE OWN PASSWORD ----------
router.post('/change-password',
  authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!bcrypt.compareSync(req.body.currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hash = bcrypt.hashSync(req.body.newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    res.json({ message: 'Password updated successfully.' });
  }
);

// ---------- ADMIN: CREATE BANK ACCOUNT ----------
router.post('/banks',
  authenticate,
  requireRole('admin'),
  body('username').trim().isLength({ min: 4 }),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('bank_name').trim().notEmpty(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, password, bank_name, full_name } = req.body;
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already exists.' });

    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, bank_name, full_name, is_active)
      VALUES (?, ?, 'bank', ?, ?, 1)
    `).run(username, hash, bank_name, full_name || null);

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'CREATE_BANK_USER', `Created bank user ${username} (${bank_name})`);

    res.status(201).json({ id: result.lastInsertRowid, username, bank_name });
  }
);

// ---------- ADMIN: LIST BANKS ----------
router.get('/banks', authenticate, requireRole('admin'), (req, res) => {
  const banks = db.prepare(`
    SELECT id, username, bank_name, full_name, is_active, created_at
    FROM users WHERE role = 'bank' ORDER BY bank_name
  `).all();
  res.json(banks);
});

// ---------- ADMIN: ACTIVATE / DEACTIVATE BANK ----------
router.patch('/banks/:id/status',
  authenticate,
  requireRole('admin'),
  body('is_active').isBoolean(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const bank = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'bank'`).get(req.params.id);
    if (!bank) return res.status(404).json({ error: 'Bank user not found.' });

    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(req.body.is_active ? 1 : 0, bank.id);
    res.json({ message: 'Bank status updated.' });
  }
);

module.exports = router;
