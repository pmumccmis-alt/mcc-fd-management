require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

function seedDemoData() {
  const masterUsername = process.env.MASTER_USERNAME || 'mcc_master';
  const masterPassword = process.env.MASTER_PASSWORD || 'ChangeMe@12345';
  const masterOfficerId = process.env.MASTER_OFFICER_ID || 'MCC-MASTER-001';
  const masterMobile = process.env.MASTER_MOBILE || '9999999999';

  // 1. Seed Master User
  let masterId;
  let master = db.prepare('SELECT id FROM users WHERE username = ?').get(masterUsername);
  if (!master) {
    const hash = bcrypt.hashSync(masterPassword, 12);
    const info = db.prepare(`
      INSERT INTO users (username, officer_id, password_hash, role, full_name, mobile_number, is_active)
      VALUES (?, ?, ?, 'master', 'MCC Fund Master Administrator', ?, 1)
    `).run(masterUsername, masterOfficerId, hash, masterMobile);
    masterId = info.lastInsertRowid;
    console.log(`Created MASTER account: ${masterUsername}`);
  } else {
    masterId = master.id;
    console.log(`Master user "${masterUsername}" already exists.`);
  }

  // Use a transaction for bulk inserts
  const insertMany = db.transaction(() => {
    // 2. Create Variety Demo Banks
    const bankIds = [];
    const defaultBankPasswordHash = bcrypt.hashSync('Password@123', 12);
    const bankDetails = [
      { user: 'sbi_bank', name: 'State Bank of India', mobile: '9123456781' },
      { user: 'hdfc_bank', name: 'HDFC Bank', mobile: '9123456782' },
      { user: 'icici_bank', name: 'ICICI Bank', mobile: '9123456783' },
      { user: 'pnb_bank', name: 'Punjab National Bank', mobile: '9123456784' },
      { user: 'axis_bank', name: 'Axis Bank', mobile: '9123456785' },
      { user: 'boi_bank', name: 'Bank of India', mobile: '9123456786' }
    ];

    for (const b of bankDetails) {
      let bank = db.prepare('SELECT id FROM users WHERE username = ?').get(b.user);
      if (!bank) {
        const info = db.prepare(`
          INSERT INTO users (username, password_hash, role, bank_name, full_name, mobile_number, is_active, created_by)
          VALUES (?, ?, 'bank', ?, ?, ?, 1, ?)
        `).run(b.user, defaultBankPasswordHash, b.name, `${b.name} Treasury Desk`, b.mobile, masterId);
        bankIds.push(info.lastInsertRowid);
      } else {
        bankIds.push(bank.id);
      }
    }
    console.log(`Ensured diverse demo bank accounts exist.`);

    // 3. Create 50 Demo Funds Across Diverse Months, Years & Statuses
    const departments = [
      'Water Supply Fund', 
      'Sanitation Cess', 
      'Road Infrastructure', 
      'Public Health Wing', 
      'Street Lighting Division',
      'Solid Waste Management',
      'Storm Water Drainage'
    ];

    const statuses = ['open', 'open', 'result_declared', 'awarded', 'awarded', 'cancelled'];
    
    // Array of different months and years to distribute creation dates
    const datePool = [
      { year: '2025', month: '03', day: '10' },
      { year: '2025', month: '05', day: '14' },
      { year: '2025', month: '08', day: '22' },
      { year: '2025', month: '11', 'day': '05' },
      { year: '2026', month: '01', day: '12' },
      { year: '2026', month: '02', day: '18' },
      { year: '2026', month: '03', day: '25' },
      { year: '2026', month: '04', day: '08' },
      { year: '2026', month: '05', day: '19' },
      { year: '2026', month: '06', day: '24' },
      { year: '2026', month: '07', day: '11' },
      { year: '2026', month: '08', day: '02' }
    ];

    for (let i = 1; i <= 50; i++) {
      const refNo = `MCC/FD/2026/${String(i).padStart(3, '0')}`;
      const existingFund = db.prepare('SELECT id FROM funds WHERE reference_no = ?').get(refNo);

      let fundId;
      const status = statuses[i % statuses.length];
      
      // Pick a distributed date from the pool
      const targetDate = datePool[i % datePool.length];
      const createdAt = `${targetDate.year}-${targetDate.month}-${targetDate.day}T10:00:00`;
      const bidDeadline = `${targetDate.year}-${targetDate.month}-28T17:00:00`;

      const title = `Municipal Fund Allocation Scheme #${i}`;
      const dept = departments[i % departments.length];
      const amount = parseFloat((500000 + (i * 350000.50) % 45000000).toFixed(2));
      
      const tenures = [30, 60, 90, 180, 365, 730];
      const tenureDays = tenures[i % tenures.length];

      let winningBankId = null;
      let winningRate = null;
      let awardedBankId = null;
      let awardedRate = null;
      let awardedAt = null;

      if (status === 'awarded' || status === 'result_declared') {
        winningBankId = bankIds[i % bankIds.length];
        winningRate = parseFloat((7.0 + ((i % 15) / 10)).toFixed(2));
      }
      if (status === 'awarded') {
        awardedBankId = winningBankId;
        awardedRate = winningRate;
        awardedAt = `${targetDate.year}-${targetDate.month}-25T18:30:00`;
      }

      if (!existingFund) {
        const fundInfo = db.prepare(`
          INSERT INTO funds (
            reference_no, title, department, details, amount, tenure_days, 
            bid_deadline, status, result_bank_id, result_rate, result_declared_at, 
            awarded_bank_id, awarded_rate, awarded_at, awarded_by, created_at, created_by
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          refNo, title, dept, `Detailed financial specifications for tranche ${i}.`, amount, tenureDays, 
          bidDeadline, status, winningBankId, winningRate, winningRate ? bidDeadline : null, 
          awardedBankId, awardedRate, awardedAt, awardedBankId ? masterId : null, createdAt, masterId
        );
        
        fundId = fundInfo.lastInsertRowid;
      } else {
        fundId = existingFund.id;
        db.prepare(`
          UPDATE funds SET status = ?, result_bank_id = ?, result_rate = ?, awarded_bank_id = ?, awarded_rate = ?, created_at = ? 
          WHERE id = ?
        `).run(status, winningBankId, winningRate, awardedBankId, awardedRate, createdAt, fundId);
      }

      // Add competitive quotes from banks
      for (let j = 0; j < 3; j++) {
        const bankId = bankIds[(i + j) % bankIds.length];
        const rate = parseFloat((6.25 + ((i * 7 + j * 13) % 200) / 100).toFixed(2));
        
        try {
          db.prepare(`
            INSERT OR IGNORE INTO quotes (fund_id, bank_id, interest_rate, remarks)
            VALUES (?, ?, ?, ?)
          `).run(fundId, bankId, rate, `Competitive corporate rate quote submitted for index batch ${i}.`);
        } catch (e) {
          // Ignore unique constraints
        }
      }
    }
    console.log(`Successfully populated 50 funds spread across multiple months and years.`);
  });

  insertMany();
  console.log('Multi-month timestamp database seeding completed successfully!');
}

seedDemoData();