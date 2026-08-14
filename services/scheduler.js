const db = require('../db/db');

/**
 * Runs periodically. For every fund still 'open' whose bid_deadline has passed:
 *   1. Determine H1 = highest interest_rate quote (ties broken by earliest submission).
 *   2. Move the fund straight to 'result_declared' and record the H1 bank/rate.
 * This happens automatically — no admin action needed — so the result is declared
 * the moment the clock runs out. An officer/master still has to explicitly confirm
 * the final "award" (see funds.js /:id/award), so a human always signs off before the
 * FD is actually placed, but the H1 result itself is time-locked and cannot be
 * delayed or influenced after the deadline.
 */
function declareOverdueResults() {
  const overdue = db.prepare(`
    SELECT * FROM funds WHERE status = 'open' AND datetime(bid_deadline) <= datetime('now')
  `).all();

  for (const fund of overdue) {
    const h1 = db.prepare(`
      SELECT * FROM quotes WHERE fund_id = ?
      ORDER BY interest_rate DESC, submitted_at ASC LIMIT 1
    `).get(fund.id);

    if (h1) {
      db.prepare(`
        UPDATE funds
        SET status = 'result_declared', result_bank_id = ?, result_rate = ?, result_declared_at = datetime('now')
        WHERE id = ?
      `).run(h1.bank_id, h1.interest_rate, fund.id);

      db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (NULL, ?, ?)')
        .run('AUTO_RESULT_DECLARED', `Fund ${fund.reference_no}: deadline passed, H1 = bank_id ${h1.bank_id} @ ${h1.interest_rate}%`);
    } else {
      db.prepare(`UPDATE funds SET status = 'result_declared', result_declared_at = datetime('now') WHERE id = ?`).run(fund.id);
      db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (NULL, ?, ?)')
        .run('AUTO_RESULT_DECLARED', `Fund ${fund.reference_no}: deadline passed with no quotes received.`);
    }
  }

  if (overdue.length) {
    console.log(`[scheduler] Declared results for ${overdue.length} fund(s) whose deadline passed.`);
  }
}

function startScheduler() {
  declareOverdueResults();
  setInterval(declareOverdueResults, 30 * 1000);
}

module.exports = { startScheduler, declareOverdueResults };
