require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

function seedAdmin() {
  const username = process.env.ADMIN_USERNAME || 'mcc_admin';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe@12345';

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`Admin user "${username}" already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, is_active)
    VALUES (?, ?, 'admin', 'MCC Fund Administrator', 1)
  `).run(username, hash);

  console.log(`Created admin user "${username}". Please log in and change the password immediately (or set a new ADMIN_PASSWORD before re-seeding a fresh DB).`);
}

seedAdmin();
