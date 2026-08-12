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
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','bank')),
  bank_name TEXT,          -- only for role = bank
  full_name TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','awarded','cancelled')),
  awarded_bank_id INTEGER,
  awarded_rate REAL,
  awarded_at TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (awarded_bank_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_id INTEGER NOT NULL,
  bank_id INTEGER NOT NULL,
  interest_rate REAL NOT NULL,         -- % p.a. quoted by the bank
  remarks TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fund_id, bank_id),
  FOREIGN KEY (fund_id) REFERENCES funds(id) ON DELETE CASCADE,
  FOREIGN KEY (bank_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
