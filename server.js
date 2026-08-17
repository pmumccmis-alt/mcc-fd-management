require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./backend/routes/auth');
const fundRoutes = require('./backend/routes/funds');
const quoteRoutes = require('./backend/routes/quotes');
const dashboardRoutes = require('./backend/routes/dashboard');
const depositRoutes = require('./backend/routes/deposits');
const { startScheduler } = require('./backend/services/scheduler');

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Copy .env.example to .env and set a strong secret before starting the server.');
  process.exit(1);
}

const app = express();

app.use(helmet());
app.use(cors()); // In production, restrict this to the actual frontend origin.
app.use(express.json({ limit: '100kb' }));

// General API rate limiting (login has its own stricter limiter)
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

app.use('/api/auth', authRoutes);
app.use('/api/funds', fundRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/deposits', depositRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Serve the frontend (static files) so the whole app can run from a single process.
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`MCC FD Management System backend running on http://localhost:${PORT}`);
  startScheduler();
  console.log('Auto result-declaration scheduler started (checks every 30s for funds past their bid deadline).');
});
