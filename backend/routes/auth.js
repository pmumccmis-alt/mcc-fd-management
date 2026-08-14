const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { issueOtp, verifyOtp } = require('../services/otp');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' }
});
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many OTP attempts. Please try again in a few minutes.' }
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, bank_name: user.bank_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function maskMobile(mobile) {
  if (!mobile || mobile.length < 4) return '••••••';
  return `••••••${mobile.slice(-4)}`;
}

// ---------- STEP 1: USERNAME + PASSWORD -> triggers OTP ----------
router.post('/login',
  loginLimiter,
  body('username').trim().notEmpty(),
  body('password').notEmpty(),
  async (req, res) => {
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
    if (!user.mobile_number) {
      return res.status(400).json({ error: 'No mobile number is on file for this account. Contact your administrator to add one before you can sign in.' });
    }

    const otpResult = await issueOtp(user.id, user.mobile_number, 'login');

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(user.id, 'LOGIN_OTP_SENT', `OTP sent to ${maskMobile(user.mobile_number)} for ${user.username}`);

    res.json({
      otpRequired: true,
      userId: user.id,
      maskedMobile: maskMobile(user.mobile_number),
      expiresInMinutes: otpResult.expiresInMinutes,
      devOtp: otpResult.devOtp // only present when OTP_DEV_MODE=true — see services/otp.js
    });
  }
);

// ---------- STEP 2: VERIFY OTP -> issues JWT ----------
router.post('/verify-otp',
  otpLimiter,
  body('userId').isInt(),
  body('otp').trim().isLength({ min: 6, max: 6 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'A valid 6-digit OTP is required.' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.body.userId);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid session. Please log in again.' });

    const result = verifyOtp(user.id, req.body.otp, 'login');
    if (!result.ok) return res.status(401).json({ error: result.error });

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(user.id, 'LOGIN_SUCCESS', `User ${user.username} completed OTP login`);

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, bank_name: user.bank_name, full_name: user.full_name, officer_id: user.officer_id }
    });
  }
);

// ---------- RESEND OTP ----------
router.post('/resend-otp', otpLimiter, body('userId').isInt(), async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.body.userId);
  if (!user || !user.is_active) return res.status(401).json({ error: 'Invalid session. Please log in again.' });

  const otpResult = await issueOtp(user.id, user.mobile_number, 'login');
  res.json({ expiresInMinutes: otpResult.expiresInMinutes, devOtp: otpResult.devOtp });
});

// ---------- CURRENT USER ----------
router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, username, role, bank_name, full_name, officer_id, mobile_number FROM users WHERE id = ?').get(req.user.id);
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

// =====================================================================
// MASTER: CREATE / MANAGE OFFICER (ADMIN) ACCOUNTS
// =====================================================================
router.post('/officers',
  authenticate,
  requireRole('master'),
  body('username').trim().isLength({ min: 4 }),
  body('officer_id').trim().notEmpty().withMessage('Officer ID is required.'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('full_name').trim().notEmpty(),
  body('mobile_number').trim().matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit mobile number.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, officer_id, password, full_name, mobile_number } = req.body;
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR officer_id = ?').get(username, officer_id);
    if (existing) return res.status(409).json({ error: 'Username or Officer ID already exists.' });

    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`
      INSERT INTO users (username, officer_id, password_hash, role, full_name, mobile_number, is_active, created_by)
      VALUES (?, ?, ?, 'admin', ?, ?, 1, ?)
    `).run(username, officer_id, hash, full_name, mobile_number, req.user.id);

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'CREATE_OFFICER', `Created officer/admin account ${username} (Officer ID: ${officer_id})`);

    res.status(201).json({ id: result.lastInsertRowid, username, officer_id });
  }
);

router.get('/officers', authenticate, requireRole('master'), (req, res) => {
  const officers = db.prepare(`
    SELECT id, username, officer_id, full_name, mobile_number, is_active, created_at
    FROM users WHERE role = 'admin' ORDER BY created_at DESC
  `).all();
  res.json(officers);
});

router.patch('/officers/:id/status',
  authenticate,
  requireRole('master'),
  body('is_active').isBoolean(),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const officer = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'admin'`).get(req.params.id);
    if (!officer) return res.status(404).json({ error: 'Officer account not found.' });

    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(req.body.is_active ? 1 : 0, officer.id);
    res.json({ message: 'Officer account status updated.' });
  }
);

// =====================================================================
// MASTER + ADMIN: CREATE / MANAGE BANK ACCOUNTS
// =====================================================================
router.post('/banks',
  authenticate,
  requireRole('master', 'admin'),
  body('username').trim().isLength({ min: 4 }),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.'),
  body('bank_name').trim().notEmpty(),
  body('mobile_number').trim().matches(/^[6-9]\d{9}$/).withMessage('Enter a valid 10-digit mobile number.'),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { username, password, bank_name, full_name, mobile_number } = req.body;
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already exists.' });

    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, bank_name, full_name, mobile_number, is_active, created_by)
      VALUES (?, ?, 'bank', ?, ?, ?, 1, ?)
    `).run(username, hash, bank_name, full_name || null, mobile_number, req.user.id);

    db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(req.user.id, 'CREATE_BANK_USER', `Created bank user ${username} (${bank_name})`);

    res.status(201).json({ id: result.lastInsertRowid, username, bank_name });
  }
);

router.get('/banks', authenticate, requireRole('master', 'admin'), (req, res) => {
  const banks = db.prepare(`
    SELECT id, username, bank_name, full_name, mobile_number, is_active, created_at
    FROM users WHERE role = 'bank' ORDER BY bank_name
  `).all();
  res.json(banks);
});

router.patch('/banks/:id/status',
  authenticate,
  requireRole('master', 'admin'),
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
