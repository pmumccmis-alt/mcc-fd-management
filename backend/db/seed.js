require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

function seedMaster() {
  const username = process.env.MASTER_USERNAME || 'mcc_master';
  const password = process.env.MASTER_PASSWORD || 'ChangeMe@12345';
  const officerId = process.env.MASTER_OFFICER_ID || 'MCC-MASTER-001';
  const mobile = process.env.MASTER_MOBILE || '9999999999';

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`Master user "${username}" already exists. Skipping.`);
    return;
  }

  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`
    INSERT INTO users (username, officer_id, password_hash, role, full_name, mobile_number, is_active)
    VALUES (?, ?, ?, 'master', 'MCC Fund Master Administrator', ?, 1)
  `).run(username, officerId, hash, mobile);

  console.log(`Created MASTER account:`);
  console.log(`   Username : ${username}`);
  console.log(`   Officer ID: ${officerId}`);
  console.log(`   Mobile   : ${mobile} (used for OTP login)`);
  console.log(`Change this password immediately after first login, and set MASTER_MOBILE`);
  console.log(`in .env to a real mobile number before you configure a real SMS provider.`);
  console.log(``);
  console.log(`Reminder: set OTP_DEV_MODE=true in .env while testing locally so the OTP`);
  console.log(`is returned in the login API response (no SMS gateway needed for testing).`);
}

seedMaster();
