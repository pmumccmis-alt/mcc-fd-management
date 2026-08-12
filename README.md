# MCC FD Fund Management System

A web application for **Municipal Corporation Chandigarh** to manage unutilized funds that are
placed as Fixed Deposits (FD) with banks through a transparent, competitive rate-quotation
process (reverse e-auction), and to automatically identify **H1** — the bank offering the
**highest** interest rate.

## How it works

1. **Admin (MCC finance official)** enters a fund: amount, purpose/details, tenure (period),
   and a bid submission deadline. This publishes the fund to all empanelled banks.
2. **Banks** (each given a login by the admin) view open funds and submit their FD interest
   rate quotation before the deadline. They can revise their quote any number of times while
   bidding is open.
3. **Admin** closes bidding once the deadline is reached (or manually). The system ranks all
   quotes and highlights **H1** (highest rate).
4. **Admin** reviews and awards the FD — by default to H1, though the admin can select a
   different bank if H1 needs to be disqualified for a documented reason (e.g. did not meet
   eligibility criteria). Every award is logged.
5. A running **audit log** records logins, fund creation, quote submissions, bid closures and
   awards for accountability.

## Tech stack

- **Backend:** Node.js + Express, REST JSON API
- **Database:** SQLite (file-based, via `better-sqlite3`) — no separate DB server to install.
  Can be swapped for PostgreSQL/MySQL later without changing the frontend.
- **Frontend:** Plain HTML/CSS/JavaScript (no build step required), served by the same
  Express server
- **Auth:** JWT bearer tokens, passwords hashed with bcrypt

## Project structure

```
fd-management-system/
├── backend/
│   ├── server.js          # Express app entry point
│   ├── db/
│   │   ├── db.js          # SQLite connection + schema
│   │   └── seed.js        # Creates the first admin account
│   ├── routes/
│   │   ├── auth.js        # Login, admin bank-account management
│   │   ├── funds.js       # Fund CRUD, close bidding, H1, award
│   │   └── quotes.js      # Bank rate-quote submission
│   ├── middleware/auth.js # JWT verification + role checks
│   ├── package.json
│   └── .env.example
└── frontend/
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## Setup

Requires **Node.js 18+**.

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and set:
- `JWT_SECRET` — a long random string (required; the server refuses to start without it)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — credentials for the first admin account

Create the database and the first admin login:

```bash
npm run seed
```

Start the server (serves both the API and the web frontend):

```bash
npm start
```

Visit **http://localhost:4000** and sign in with the admin credentials you set in `.env`.
**Change the admin password immediately after first login** (via the "change password" API
endpoint, `POST /api/auth/change-password` — wire this into the UI or call it directly if you
need it right away).

The admin can then create a login for each empanelled bank under the **Empanelled Banks** tab.

## Security notes (read before deploying)

This app implements baseline security practices, but a few things need attention before it
handles real public funds in production:

- **Run it behind HTTPS.** Put it behind a reverse proxy (Nginx/Apache) with a valid TLS
  certificate, or a cloud load balancer that terminates TLS. Never expose this over plain HTTP.
- **JWT secret:** use a long, random `JWT_SECRET` and keep `.env` out of version control
  (already covered by `.gitignore`).
- **Passwords:** hashed with bcrypt (cost factor 12); never stored in plain text. Enforce a
  strong password policy for bank accounts when you create them.
- **Rate limiting** is applied to login (10 attempts / 15 min) and the general API
  (300 requests / 15 min per IP) to reduce brute-force and abuse risk.
- **Input validation** via `express-validator` on all write endpoints; SQL queries use
  parameterized statements (`better-sqlite3` prepared statements) throughout — no string-built
  SQL, so the app is not vulnerable to SQL injection through these inputs.
- **CORS** is currently wide open (`cors()`), which is fine when the frontend is served from
  the same origin as the API (the default setup here). If you split the frontend onto a
  different domain, restrict `cors()` to that specific origin in `server.js`.
- **Audit trail:** every login, fund creation, quote, bid closure and award is written to the
  `audit_log` table for later review — don't delete this table in production.
- **Backups:** the SQLite file at `backend/db/fd_management.sqlite` is the entire database.
  Back it up on a regular schedule (e.g. a nightly copy to secure storage). For higher
  concurrency or multi-server deployment, migrate to PostgreSQL.
- **Token storage:** the frontend currently stores the JWT in `localStorage` for simplicity.
  For a stricter production posture, consider moving to an httpOnly, Secure session cookie
  issued by the server instead — this avoids any exposure to token theft via XSS.
- This is a working baseline you should have reviewed by your organization's IT/security team
  before go-live, given it will hold data about public funds.

## API summary

| Method | Endpoint                          | Role  | Purpose                                  |
|--------|------------------------------------|-------|-------------------------------------------|
| POST   | /api/auth/login                    | any   | Sign in, get JWT                         |
| GET    | /api/auth/me                       | any   | Current user info                        |
| POST   | /api/auth/change-password          | any   | Change own password                      |
| POST   | /api/auth/banks                    | admin | Create a bank login                      |
| GET    | /api/auth/banks                    | admin | List bank accounts                       |
| PATCH  | /api/auth/banks/:id/status         | admin | Activate/deactivate a bank                |
| POST   | /api/funds                         | admin | Create a new FD fund entry               |
| GET    | /api/funds                         | any   | List funds (scoped by role)              |
| GET    | /api/funds/:id                     | any   | Fund details                             |
| GET    | /api/funds/:id/quotes              | any   | Quotes for a fund (scoped by role)       |
| POST   | /api/funds/:id/close               | admin | Close bidding                            |
| GET    | /api/funds/:id/h1                  | admin | View the current highest-rate quote      |
| POST   | /api/funds/:id/award                | admin | Award the FD (defaults to H1)            |
| POST   | /api/funds/:id/cancel               | admin | Cancel a fund entry                      |
| POST   | /api/quotes/:fundId                | bank  | Submit or revise a rate quote            |

## Notes on the H1 rule

H1 = the quote with the **highest** `interest_rate` for that fund. Ties are broken by
whichever quote was **submitted earliest**. The admin always makes the final award decision —
the system never auto-awards — so there is a human checkpoint before public money is committed.
