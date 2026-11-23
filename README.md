# Compliance Tracker — Standalone Version

A real, deployable B2B SaaS for small HVAC / electrical contractors in the US.
Clients sign up, create their own company workspace, and track equipment
calibration dates, safety inspections, and certificate expirations — with
reminders before anything goes overdue.

**This is not the Muse prototype.** That prototype (slug `compliance-tracker`)
is single-company and private to Prince. This code is a separate, multi-tenant
app you can host, put on your own domain, and sell at **$49/mo per company**.

## What it does

- **Signup / login** (email + password, bcrypt-hashed, JWT sessions).
  On signup a user creates a company. Every user belongs to exactly one company.
- **Multi-tenant isolation** — every item, team and reminder query is forced
  to `company_id` from the JWT. Company A can never see Company B's data
  (verified by the test suite — see below).
- **Team** — the company owner can add up to 3 team users total (name + email).
  If no password is given, a temporary one is generated and shown once.
  Team members log in and see only their own company.
- **Items CRUD** — equipment / vehicle / certificate, with name, category,
  type, serial, location, owner, due date, last completed, recurring
  interval (days / weeks / months / years), and notes.
- **Dashboard** — counts for Overdue / Due in 7 days / Due in 8–30 days / OK,
  list sorted by days remaining, filter by urgency / category / search.
- **Renew** — mark renewed: due date rolls forward by the interval, or enter
  a new date from the certificate.
- **Certificate upload** — PDF or photo (JPG/PNG/WebP, max 10 MB) per item,
  view / download it from the item.
- **CSV import** — same header as the sample file:
  `name,category,type,serial,location,owner,due_date,last_completed,interval_value,interval_unit,notes`
  Returns an imported / skipped count with reasons. A template is downloadable
  from the app (`GET /api/items/template`).
- **Reminders** — logged at 30 / 14 / 7 / 1 days before due, plus an overdue
  alert, addressed to the team's emails. "Run reminder check now" button in
  the app, plus a daily script (`npm run check-reminders`). **Email is not
  sent yet** — the in-app reminder log is the system of record until SMTP is
  configured (see below).
- **Billing placeholder** — Settings → Billing shows the $49/mo plan and a
  payment link if `PAYMENT_LINK` is set (any provider with a plain
  checkout URL, e.g. Stripe or Paystack). No secret keys are stored.
  **Stripe from Nigeria:** a standard Stripe account cannot receive
  payouts to a Nigerian bank account (Nigeria is Stripe Extended
  Network), so do not plan Step 6 on Stripe unless you already have a
  US entity / US Stripe account. Paddle (merchant of record, 5% + 50¢ —
  $2.95 on $49, monthly payout by the 15th, $100 minimum, ~$15 SWIFT
  fee) does pay out to Nigeria, but Paddle Billing has no standalone
  checkout link — it needs a Paddle.js integration, not a pasted link.
  For the first pilots, deploy first and take payment by manual invoice
  / bank transfer, or a Paystack Payment Link (3.9% + ₦100 on
  international cards, settles in naira).

## Run locally

```bash
cd compliance-tracker-standalone
npm install
cp .env.example .env   # then edit JWT_SECRET to a long random string
npm start
# open http://localhost:3000
```

Default port is `3000` (override with `PORT` in `.env`).
Data is stored in SQLite at `compliance.db` (override with `DATABASE_PATH`).

### Try it with sample data

```bash
npm run seed
# Demo login: demo@example.com / Demo1234!   (demo only — delete this
# company before real use; all sample names/serials are fictional)
```

The seed loads the 12-row sample CSV into a company called
"Demo HVAC Co (Sample Data — fictional)". On 2026-11-23 its dashboard reads
**3 overdue / 3 due in 7 days / 3 due in 8–30 days / 3 OK**.
Re-running `npm run seed` resets the demo company.

### Tests

```bash
npm test
```

The test suite starts the server on a temporary database and checks:
signup for two different companies, login, item creation, CSV import of the
sample file, dashboard counts, renew rolling the date forward, and — most
importantly — that Company A cannot list, read, update, or delete Company B's
items (all return 404).

## How a client signs up and gets their own workspace

1. Client goes to your deployed URL (e.g. `https://tracker.yourdomain.com`).
2. They click **"New here? Create a company account"**, enter their name,
   company name, email, and a password.
3. That creates a brand-new company workspace, empty, visible only to them.
4. The owner adds up to 2 more team members under Company & Team.
5. They add items by hand or import their spreadsheet via **Import CSV**
   (template available in the app).
6. Reminders are logged daily; the owner checks the Reminders tab.

You (the seller) do **not** need to create accounts for them — signup is
self-serve. For a founding pilot, you can still import their spreadsheet
for them after they sign up, using their login or by asking for the CSV.

## Deploy — primary path: Render (free tier)

This is the simplest free-tier path. You need a GitHub account and a Render
account (both free).

1. **Push this folder to GitHub.**
   ```bash
   git init && git add . && git commit -m "Compliance Tracker v1"
   # create an empty repo on GitHub, then:
   git remote add origin https://github.com/YOURNAME/compliance-tracker.git
   git push -u origin main
   ```
   `.gitignore` already excludes `node_modules/`, `compliance.db`, `.env`,
   and uploaded certificates — do not commit those.

2. **Create a Web Service on Render.**
   - Render dashboard → New → Web Service → connect the GitHub repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free.
   - Environment variables (Render → Environment):
     - `JWT_SECRET` = a long random string (generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
     - `PAYMENT_LINK` = your payment-link URL (optional — only when you
       have a provider that gives a plain checkout link; never paste a
       secret key. Leave unset for free pilots.)
     - Leave `PORT` unset — Render sets it for you. Leave `DATABASE_PATH`
       unset for now (see the warning below).

3. **Deploy.** Render builds and gives you a URL like
   `https://compliance-tracker-xxxx.onrender.com`. Open it, sign up, and
   test it.

4. **(Optional, recommended) Add a custom domain** in Render → Settings →
   Custom Domain, then point your DNS at it.

5. **Daily reminders:** in Render, add a Cron Job (same repo, free tier
   allows one) with command `npm run check-reminders`, schedule `0 7 * * *`
   (07:00 daily). It writes to the same database the web service uses
   **only if both share a persistent disk** — see the warning below.

### ⚠️ Important limitation on Render free tier

On the free tier the SQLite file lives on the web service's ephemeral disk:
**if the service restarts / redeploys, `compliance.db` and uploaded
certificates can be lost.** That is fine for a pilot, but before you take
real paying customers, do one of these:

- **(Recommended) Add a Render Persistent Disk** (paid, ~$0.25/GB/mo):
  mount it at the app folder and set `DATABASE_PATH` to a path on that
  disk, e.g. `/var/data/compliance.db`, and move uploads there too.
- **Or switch the database to Render PostgreSQL** (free tier available)
  and replace the SQLite layer with PostgreSQL — a bigger change, do it after
  your first 3 paying pilots prove the product.
- **Or deploy to a VPS** (e.g. Hetzner / DigitalOcean $5/mo) with
  `git pull && npm install && pm2 restart`, where the disk is persistent.

Do not sell the free-tier SQLite setup as "production-grade" to a client
without that disk — be honest that pilots run on it and paying customers
get the persistent-disk setup.

### Alternative hosts

- **Railway:** very similar to Render — New Project → deploy from GitHub,
  same build/start commands, same env vars, add a Volume for persistence.
- **VPS (any Linux server):** `git clone`, `npm install`, set `.env`,
  run with `pm2 start server.js` (or `systemd`), put Caddy/Nginx in front
  for HTTPS. Data persists on the server disk.

## Environment variables

| Variable | Required? | What it does |
|---|---|---|
| `JWT_SECRET` | **Yes, in production** | Signs login tokens. Long random string. Never commit it. |
| `PORT` | No (default 3000) | Port the server listens on. Render sets this itself. |
| `DATABASE_PATH` | No (default `./compliance.db`) | Where SQLite stores data. |
| `PAYMENT_LINK` | No | Any plain checkout-link URL (Stripe `https://buy.stripe.com/...` or Paystack Payment Link). Shown on the Billing page. No secret keys — never put one here. |
| `STRIPE_PAYMENT_LINK` | No | Legacy name for the same thing — still honoured if `PAYMENT_LINK` is empty. |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | No | Login for `npm run seed`. Defaults are `demo@example.com` / `Demo1234!` — demo only. |

## Reminders & email — what is real and what is not

- **Real now:** the daily check, the "Run reminder check now" button, and
  the reminder log (item, due date, days until due, type, recipient emails).
  The check is idempotent — one log row per item per reminder type per day.
- **Not yet:** sending actual emails. That needs SMTP (or a provider like
  Resend / SendGrid) and a small change in `reminders.js` to send each
  logged reminder. Until then, tell clients the in-app log is the record,
  and the owner should check it daily. This is stated in the app UI too.

## Project layout

```
compliance-tracker-standalone/
  server.js                 Express app: auth, items, team, CSV, uploads, reminders, billing
  db.js                     SQLite schema (companies, users, items, reminder_log)
  reminders.js              Reminder-check logic (shared by API + cron script)
  public/index.html         Single-page frontend (login/signup, dashboard, team, reminders, billing)
  scripts/seed.js           Loads the 12-row sample CSV into a demo company
  scripts/check-reminders.js  Daily reminder check (run from cron)
  test/test.js              Integration tests incl. multi-tenant isolation
  package.json  .env.example  .gitignore  README.md
  uploads/                  Certificate files (gitignored, created at runtime)
```

## What to do next (for Prince)

1. Run it locally, seed the demo, click through the dashboard.
2. Decide the domain name and the payment route for $49/mo (see Billing
   note above — Stripe does not pay out to Nigeria; Paddle needs
   Paddle.js, a plain link works for Stripe/Paystack).
3. Deploy to Render on the free tier (steps above) and test signup from a
   second browser / incognito window.
4. Use the validation pack (`compliance-tracker-validation.md`) to get your
   first 3 pilot contractors — offer 2 months free and import their CSV.
5. Before charging real money, add the persistent disk (Render) and, when
   you have paying pilots, wire real email sending in `reminders.js`.
