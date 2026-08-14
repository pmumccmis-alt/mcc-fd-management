const express = require('express');
const db = require('../db/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { declareOverdueResults } = require('../services/scheduler');

const router = express.Router();

router.use((req, res, next) => { declareOverdueResults(); next(); });

// GET /api/dashboard/stats?date_from=&date_to=&status=&department=&bank_id=
// Master/admin get org-wide stats. Bank users get stats scoped to their own participation.
router.get('/stats', authenticate, (req, res) => {
  const { date_from, date_to, status, department, bank_id } = req.query;
  const isBank = req.user.role === 'bank';

  const clauses = [];
  const params = [];
  if (date_from) { clauses.push('date(f.created_at) >= date(?)'); params.push(date_from); }
  if (date_to) { clauses.push('date(f.created_at) <= date(?)'); params.push(date_to); }
  if (status) { clauses.push('f.status = ?'); params.push(status); }
  if (department) { clauses.push('f.department = ?'); params.push(department); }
  if (!isBank && bank_id) { clauses.push('f.awarded_bank_id = ?'); params.push(bank_id); }
  if (isBank) { clauses.push('f.id IN (SELECT fund_id FROM quotes WHERE bank_id = ?)'); params.push(req.user.id); }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  // ---- KPI cards ----
  const kpis = db.prepare(`
    SELECT
      COUNT(*) AS total_funds,
      COALESCE(SUM(f.amount), 0) AS total_amount,
      COALESCE(SUM(CASE WHEN f.status = 'awarded' THEN f.amount ELSE 0 END), 0) AS awarded_amount,
      COUNT(CASE WHEN f.status = 'open' THEN 1 END) AS open_count,
      COUNT(CASE WHEN f.status = 'result_declared' THEN 1 END) AS result_declared_count,
      COUNT(CASE WHEN f.status = 'awarded' THEN 1 END) AS awarded_count,
      COUNT(CASE WHEN f.status = 'cancelled' THEN 1 END) AS cancelled_count,
      ROUND(AVG(CASE WHEN f.awarded_rate IS NOT NULL THEN f.awarded_rate END), 3) AS avg_awarded_rate
    FROM funds f ${where}
  `).get(...params);

  // ---- Funds by status (pie/doughnut chart) ----
  const byStatus = db.prepare(`
    SELECT f.status, COUNT(*) AS count, COALESCE(SUM(f.amount),0) AS amount
    FROM funds f ${where}
    GROUP BY f.status
  `).all(...params);

  // ---- Funds & amount by month (trend line/bar chart) ----
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', f.created_at) AS month, COUNT(*) AS count, COALESCE(SUM(f.amount),0) AS amount
    FROM funds f ${where}
    GROUP BY month ORDER BY month
  `).all(...params);

  // ---- Amount by department (bar chart) ----
  const byDepartment = db.prepare(`
    SELECT COALESCE(NULLIF(f.department,''), 'Unspecified') AS department, COUNT(*) AS count, COALESCE(SUM(f.amount),0) AS amount
    FROM funds f ${where}
    GROUP BY department ORDER BY amount DESC
  `).all(...params);

  // ---- Average awarded rate by tenure bucket (bar chart) ----
  const byTenure = db.prepare(`
    SELECT
      CASE
        WHEN f.tenure_days <= 90 THEN '0-3 months'
        WHEN f.tenure_days <= 180 THEN '3-6 months'
        WHEN f.tenure_days <= 365 THEN '6-12 months'
        ELSE '12+ months'
      END AS bucket,
      COUNT(*) AS count,
      ROUND(AVG(f.awarded_rate), 3) AS avg_rate
    FROM funds f ${where.length ? where + " AND f.awarded_rate IS NOT NULL" : "WHERE f.awarded_rate IS NOT NULL"}
    GROUP BY bucket
  `).all(...params);

  // ---- Bank participation: quotes submitted per bank (bar chart, master/admin only) ----
  let byBank = [];
  if (!isBank) {
    const fundIdsSubquery = `SELECT f.id FROM funds f ${where}`;
    byBank = db.prepare(`
      SELECT u.bank_name, COUNT(q.id) AS quote_count,
        COUNT(CASE WHEN f2.awarded_bank_id = u.id THEN 1 END) AS wins
      FROM quotes q
      JOIN users u ON u.id = q.bank_id
      JOIN funds f2 ON f2.id = q.fund_id
      WHERE q.fund_id IN (${fundIdsSubquery})
      GROUP BY u.id ORDER BY quote_count DESC
    `).all(...params);
  }

  res.json({ kpis, byStatus, byMonth, byDepartment, byTenure, byBank });
});

module.exports = router;
