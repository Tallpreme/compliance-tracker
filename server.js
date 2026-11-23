/**
 * Compliance Tracker — standalone, multi-tenant server.
 * Stack: Node + Express + SQLite (built-in node:sqlite, Node 22.5+) + bcrypt + JWT.
 * Every data query is scoped by company_id from the JWT — a user can
 * only ever see/edit their own company's data.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./db');
const { runReminderCheck, daysUntil, todayStr } = require('./reminders');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('[WARN] JWT_SECRET not set — using dev default. Set a long random JWT_SECRET in production.');
}
const MAX_TEAM_SIZE = 3;
const PLAN_PRICE = '$49/mo';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function signToken(user) {
  return jwt.sign(
    { id: user.id, company_id: user.company_id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
}
function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the company owner can do this' });
  next();
}
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}
function addInterval(dateStr, value, unit) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (unit === 'days') dt.setUTCDate(dt.getUTCDate() + value);
  else if (unit === 'weeks') dt.setUTCDate(dt.getUTCDate() + value * 7);
  else if (unit === 'months') dt.setUTCMonth(dt.getUTCMonth() + value);
  else if (unit === 'years') dt.setUTCFullYear(dt.getUTCFullYear() + value);
  else throw new Error('Invalid interval_unit');
  return dt.toISOString().slice(0, 10);
}
function urgency(days) {
  if (days < 0) return 'overdue';
  if (days <= 7) return 'due7';
  if (days <= 30) return 'due30';
  return 'ok';
}
function itemWithDays(row) {
  const days = daysUntil(row.due_date, todayStr());
  return { ...row, days_remaining: days, urgency: urgency(days) };
}
// Minimal CSV parser: handles quoted fields and embedded commas.
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((v) => v.trim() !== '')) rows.push(row); }
  return rows;
}

// ---------- auth ----------
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password, company_name } = req.body || {};
  if (!name || !email || !password || !company_name) {
    return res.status(400).json({ error: 'Name, email, password and company name are required' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email)) {
    return res.status(400).json({ error: 'An account with this email already exists — please log in' });
  }
  const company = db.prepare('INSERT INTO companies (name) VALUES (?)').run(company_name.trim());
  const hash = bcrypt.hashSync(password, 10);
  const user = db.prepare(
    'INSERT INTO users (company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
  ).run(company.lastInsertRowid, name.trim(), email.trim().toLowerCase(), hash, 'owner');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.lastInsertRowid);
  res.status(201).json({ token: signToken(u), user: publicUser(u), company: { id: company.lastInsertRowid, name: company_name.trim() } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  const u = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(u.company_id);
  res.json({ token: signToken(u), user: publicUser(u), company });
});

function publicUser(u) {
  return { id: u.id, company_id: u.company_id, name: u.name, email: u.email, role: u.role };
}
app.get('/api/me', auth, (req, res) => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.user.company_id);
  res.json({ user: { id: req.user.id, company_id: req.user.company_id, name: req.user.name, email: req.user.email, role: req.user.role }, company });
});

// ---------- billing / settings (placeholder) ----------
app.get('/api/billing', auth, (req, res) => {
  // Generic payment link — works with any provider that gives a plain
  // checkout URL (Stripe Payment Link, Paystack Payment Link, Polar, ...).
  // PAYMENT_LINK takes precedence; STRIPE_PAYMENT_LINK is kept for
  // backwards compatibility with earlier deploys.
  // NOTE: Paddle Billing has no standalone hosted checkout URL — its
  // checkout opens via Paddle.js on your own site, so it cannot be
  // pasted here as a link. If you choose Paddle, that needs a small
  // Paddle.js integration (price ID + client token) instead.
  const paymentLink = process.env.PAYMENT_LINK || process.env.STRIPE_PAYMENT_LINK || null;
  const provider = process.env.PAYMENT_LINK
    ? 'payment link'
    : process.env.STRIPE_PAYMENT_LINK ? 'Stripe Payment Link' : null;
  res.json({
    plan: 'Compliance Tracker',
    price: PLAN_PRICE,
    price_note: 'per company, per month. Up to 3 team users included.',
    payment_link: paymentLink,
    provider,
    // Backwards-compatible field for earlier clients.
    stripe_payment_link: process.env.STRIPE_PAYMENT_LINK || null,
    status: paymentLink ? 'configured' : 'not-configured',
  });
});

// ---------- team (owner only to add/remove, max 3 users per company) ----------
app.get('/api/team', auth, (req, res) => {
  const members = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE company_id = ? ORDER BY created_at')
    .all(req.user.company_id);
  res.json({ members, limit: MAX_TEAM_SIZE });
});

app.post('/api/team', auth, requireOwner, (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM users WHERE company_id = ?').get(req.user.company_id).c;
  if (count >= MAX_TEAM_SIZE) return res.status(400).json({ error: `Team limit reached — ${MAX_TEAM_SIZE} users per company on the $49/mo plan` });
  if (db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email)) {
    return res.status(400).json({ error: 'That email already has an account' });
  }
  // Owner sets an initial password, or one is generated and returned once
  // so the owner can share it securely with the new member.
  let tempPassword = null;
  let pw = password;
  if (!pw || pw.length < 8) {
    tempPassword = Math.random().toString(36).slice(2, 10) + 'A1!';
    pw = tempPassword;
  }
  const hash = bcrypt.hashSync(pw, 10);
  const r = db.prepare('INSERT INTO users (company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.company_id, name.trim(), email.trim().toLowerCase(), hash, 'member');
  const member = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ member, temp_password: tempPassword });
});

app.delete('/api/team/:id', auth, requireOwner, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot remove yourself' });
  const r = db.prepare('DELETE FROM users WHERE id = ? AND company_id = ?').run(id, req.user.company_id);
  if (!r.changes) return res.status(404).json({ error: 'Team member not found' });
  res.json({ ok: true });
});

// ---------- items ----------
const ITEM_FIELDS = ['name', 'category', 'type', 'serial', 'location', 'owner', 'due_date', 'last_completed', 'interval_value', 'interval_unit', 'notes'];

function validateItem(body) {
  if (!body.name || !String(body.name).trim()) return 'Name is required';
  if (!isValidDate(body.due_date)) return 'due_date must be YYYY-MM-DD';
  if (body.interval_unit && !['days', 'weeks', 'months', 'years'].includes(body.interval_unit)) return 'interval_unit must be days, weeks, months or years';
  if (body.category && !['equipment', 'vehicle', 'certificate'].includes(body.category)) return 'category must be equipment, vehicle or certificate';
  return null;
}

app.get('/api/items', auth, (req, res) => {
  // Multi-tenant isolation: company_id is ALWAYS forced from the JWT.
  let rows = db.prepare('SELECT * FROM items WHERE company_id = ?').all(req.user.company_id);
  let out = rows.map(itemWithDays);
  const { urgency: u, category, search } = req.query;
  if (u) out = out.filter((x) => x.urgency === u);
  if (category) out = out.filter((x) => x.category === category);
  if (search) {
    const q = String(search).toLowerCase();
    out = out.filter((x) => [x.name, x.type, x.serial, x.location, x.owner, x.notes].join(' ').toLowerCase().includes(q));
  }
  out.sort((a, b) => a.days_remaining - b.days_remaining);
  res.json({ items: out });
});

app.post('/api/items', auth, (req, res) => {
  const err = validateItem(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const r = db.prepare(
    `INSERT INTO items (company_id, name, category, type, serial, location, owner, due_date, last_completed, interval_value, interval_unit, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.user.company_id, b.name.trim(), b.category || 'equipment', b.type || '', b.serial || '', b.location || '', b.owner || '',
    b.due_date, b.last_completed || '', Number(b.interval_value) || 12, b.interval_unit || 'months', b.notes || '');
  res.status(201).json({ item: itemWithDays(db.prepare('SELECT * FROM items WHERE id = ?').get(r.lastInsertRowid)) });
});

const CSV_HEADER = 'name,category,type,serial,location,owner,due_date,last_completed,interval_value,interval_unit,notes';
// NOTE: this must be defined BEFORE /api/items/:id, or Express would treat
// "template" as an item id and return 404.
app.get('/api/items/template', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="compliance-template.csv"');
  res.send(CSV_HEADER + '\nDigital Manifold Gauge Set,equipment,Calibration,DMG-5520,Warehouse - Bay 1,Sarah Chen,2026-11-24,2025-11-24,12,months,\n');
});

app.get('/api/items/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!row) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: itemWithDays(row) });
});

app.put('/api/items/:id', auth, (req, res) => {
  const err = validateItem(req.body || {});
  if (err) return res.status(400).json({ error: err });
  const b = req.body;
  const r = db.prepare(
    `UPDATE items SET name=?, category=?, type=?, serial=?, location=?, owner=?, due_date=?, last_completed=?, interval_value=?, interval_unit=?, notes=?, updated_at=datetime('now')
     WHERE id=? AND company_id=?`
  ).run(b.name.trim(), b.category || 'equipment', b.type || '', b.serial || '', b.location || '', b.owner || '',
    b.due_date, b.last_completed || '', Number(b.interval_value) || 12, b.interval_unit || 'months', b.notes || '', req.params.id, req.user.company_id);
  if (!r.changes) return res.status(404).json({ error: 'Item not found' });
  res.json({ item: itemWithDays(db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id)) });
});

app.delete('/api/items/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (row && row.certificate_path) { try { fs.unlinkSync(row.certificate_path); } catch {} }
  const r = db.prepare('DELETE FROM items WHERE id = ? AND company_id = ?').run(req.params.id, req.user.company_id);
  if (!r.changes) return res.status(404).json({ error: 'Item not found' });
  res.json({ ok: true });
});

app.post('/api/items/:id/renew', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!row) return res.status(404).json({ error: 'Item not found' });
  let newDue;
  if (req.body && req.body.new_due_date) {
    if (!isValidDate(req.body.new_due_date)) return res.status(400).json({ error: 'new_due_date must be YYYY-MM-DD' });
    newDue = req.body.new_due_date;
  } else {
    newDue = addInterval(row.due_date, Number(row.interval_value) || 12, row.interval_unit);
  }
  db.prepare("UPDATE items SET due_date=?, last_completed=?, updated_at=datetime('now') WHERE id=? AND company_id=?")
    .run(newDue, todayStr(), row.id, req.user.company_id);
  res.json({ item: itemWithDays(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id)) });
});

// ---------- dashboard ----------
app.get('/api/dashboard', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM items WHERE company_id = ?').all(req.user.company_id).map(itemWithDays);
  const counts = {
    overdue: rows.filter((x) => x.urgency === 'overdue').length,
    due7: rows.filter((x) => x.urgency === 'due7').length,
    due30: rows.filter((x) => x.urgency === 'due30').length,
    ok: rows.filter((x) => x.urgency === 'ok').length,
    total: rows.length,
  };
  rows.sort((a, b) => a.days_remaining - b.days_remaining);
  res.json({ counts, items: rows });
});

// ---------- certificate upload / download ----------
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF or image files (JPG/PNG/WebP) are allowed'), ok);
  },
});
app.post('/api/items/:id/certificate', auth, upload.single('certificate'), (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!row) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Item not found' }); }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (row.certificate_path) { try { fs.unlinkSync(row.certificate_path); } catch {} }
  db.prepare('UPDATE items SET certificate_path=?, certificate_name=? WHERE id=? AND company_id=?')
    .run(req.file.path, req.file.originalname, row.id, req.user.company_id);
  res.json({ item: itemWithDays(db.prepare('SELECT * FROM items WHERE id = ?').get(row.id)) });
});
app.get('/api/items/:id/certificate', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ? AND company_id = ?').get(req.params.id, req.user.company_id);
  if (!row || !row.certificate_path || !fs.existsSync(row.certificate_path)) return res.status(404).json({ error: 'No certificate on file' });
  res.download(row.certificate_path, row.certificate_name || 'certificate');
});

// ---------- CSV import / template ----------
const csvUpload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/items/import', auth, csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });
  const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  if (!rows.length) return res.status(400).json({ error: 'CSV is empty' });
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const required = ['name', 'due_date'];
  if (!required.every((c) => header.includes(c))) {
    return res.status(400).json({ error: `CSV header must include at least: ${CSV_HEADER}` });
  }
  const idx = (col) => header.indexOf(col);
  const insert = db.prepare(
    `INSERT INTO items (company_id, name, category, type, serial, location, owner, due_date, last_completed, interval_value, interval_unit, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let imported = 0;
  const skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (col) => (idx(col) >= 0 ? (r[idx(col)] || '').trim() : '');
    const name = get('name'), due = get('due_date');
    if (!name || !isValidDate(due)) { skipped.push({ row: i + 1, reason: !name ? 'missing name' : 'invalid due_date (use YYYY-MM-DD)' }); continue; }
    const category = ['equipment', 'vehicle', 'certificate'].includes(get('category')) ? get('category') : 'equipment';
    const unit = ['days', 'weeks', 'months', 'years'].includes(get('interval_unit')) ? get('interval_unit') : 'months';
    insert.run(req.user.company_id, name, category, get('type'), get('serial'), get('location'), get('owner'), due,
      get('last_completed'), Number(get('interval_value')) || 12, unit, get('notes'));
    imported++;
  }
  res.json({ imported, skipped: skipped.length, skipped_rows: skipped });
});

// ---------- reminders ----------
app.post('/api/reminders/run', auth, (req, res) => {
  const result = runReminderCheck(db, req.user.company_id);
  res.json({ ...result, note: 'Reminders are logged in-app. Actual email delivery requires SMTP configuration — see README. The log is the system of record until then.' });
});
app.get('/api/reminders', auth, (req, res) => {
  const logs = db.prepare('SELECT * FROM reminder_log WHERE company_id = ? ORDER BY created_at DESC LIMIT 200').all(req.user.company_id);
  res.json({ reminders: logs });
});

// ---------- misc ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, date: todayStr() }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Multer / upload errors
app.use((err, _req, res, _next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Compliance Tracker running on http://localhost:${PORT}`));
}
module.exports = app;
