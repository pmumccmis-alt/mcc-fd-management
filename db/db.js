const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const dbFile = process.env.DB_FILE || path.join(__dirname, 'fd_management.sqlite');
const db = new Database(dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- SCHEMA ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  officer_id TEXT UNIQUE,              -- only for role = master/admin: their Officer ID
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('master','admin','bank')),
  bank_name TEXT,          -- only for role = bank
  full_name TEXT,
  mobile_number TEXT,      -- 10-digit mobile used for OTP login
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,      -- who created this account (master creates admins, admin/master creates banks)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  otp_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS funds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_no TEXT UNIQUE NOT NULL,   -- e.g. MCC/FD/2026/001
  title TEXT NOT NULL,                 -- short description of the fund
  department TEXT,                     -- e.g. "Water Supply Fund", "Sanitation Cess"
  details TEXT,                        -- free-text details / purpose / scheme
  amount REAL NOT NULL,                -- unutilized amount available for FD
  tenure_days INTEGER NOT NULL,        -- period for which FD is to be placed
  bid_deadline TEXT NOT NULL,          -- ISO datetime - last time banks can quote
  -- open -> result_declared (automatic, at bid_deadline) -> awarded (officer/master confirms) ; or -> cancelled
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','result_declared','awarded','cancelled')),
  result_bank_id INTEGER,      -- H1 bank, computed automatically when the deadline passes
  result_rate REAL,
  result_declared_at TEXT,
  awarded_bank_id INTEGER,     -- final confirmed award (defaults to result_bank_id, officer/master can override)
  awarded_rate REAL,
  awarded_at TEXT,
  awarded_by INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (result_bank_id) REFERENCES users(id),
  FOREIGN KEY (awarded_bank_id) REFERENCES users(id),
  FOREIGN KEY (awarded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id INTEGER NOT NULL,
  bank_id INTEGER NOT NULL,
  interest_rate REAL NOT NULL,         -- % p.a. quoted by the bank
  remarks TEXT,
  consent_declared INTEGER NOT NULL DEFAULT 0,  -- bank ticked "I hereby declare this quote is correct"
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fund_id, bank_id),
  FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE,
  FOREIGN KEY (bank_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS fd_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id INTEGER UNIQUE NOT NULL,      -- one deposit record per awarded fund
  bank_id INTEGER NOT NULL,             -- snapshot of the awarded bank
  fd_rate REAL NOT NULL,                -- snapshot of the awarded rate
  tenure_days INTEGER NOT NULL,         -- snapshot of the tenure
  deposit_amount REAL,                  -- actual amount handed to the bank (set when marked deposited)
  deposit_date TEXT,                    -- date the money was actually deposited
  maturity_date TEXT,                   -- computed as deposit_date + tenure_days once deposited
  maturity_amount REAL,                 -- actual amount received back at maturity (set when recorded)
  maturity_received_date TEXT,          -- date the matured amount was actually received
  status TEXT NOT NULL DEFAULT 'pending_deposit' CHECK(status IN ('pending_deposit','active','matured')),
  deposited_by INTEGER,
  matured_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (fund_id) REFERENCES funds(id),
  FOREIGN KEY (bank_id) REFERENCES users(id),
  FOREIGN KEY (deposited_by) REFERENCES users(id),
  FOREIGN KEY (matured_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- Lightweight migration for databases created by an earlier version of this app ----------
// (Safe to run every startup: each ALTER is wrapped so it's ignored if the column already exists.)
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
try {
  ensureColumn('users', 'officer_id', 'TEXT');
  ensureColumn('users', 'mobile_number', 'TEXT');
  ensureColumn('users', 'created_by', 'INTEGER');
  ensureColumn('funds', 'result_bank_id', 'INTEGER');
  ensureColumn('funds', 'result_rate', 'REAL');
  ensureColumn('funds', 'result_declared_at', 'TEXT');
  ensureColumn('funds', 'awarded_by', 'INTEGER');
  ensureColumn('quotes', 'consent_declared', 'INTEGER NOT NULL DEFAULT 0');
} catch (e) {
  console.warn('Schema migration check skipped an item:', e.message);
}

module.exports = db;
