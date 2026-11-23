/**
 * Seed script: loads the 12-row sample CSV into a demo company.
 * Usage:  npm run seed
 * Demo login: demo@example.com / Demo1234!  (DEMO ONLY — change/delete before real use)
 * The demo company is clearly named "Demo HVAC Co (Sample Data — fictional)".
 * All sample names/serials are fictional demo data, not real people.
 * Safe to re-run: it deletes any previous demo company first.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db');

const SAMPLE = path.join(__dirname, '..', '..', 'your_files', 'compliance-tracker-sample.csv');
const DEMO_EMAIL = process.env.DEMO_EMAIL || 'demo@example.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo1234!';
const DEMO_COMPANY = 'Demo HVAC Co (Sample Data — fictional)';

function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
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

if (!fs.existsSync(SAMPLE)) {
  console.error(`Sample CSV not found: ${SAMPLE}`);
  process.exit(1);
}

// Remove previous demo company (cascade deletes its users/items/reminders)
const prev = db.prepare('SELECT id FROM companies WHERE name = ?').get(DEMO_COMPANY);
if (prev) db.prepare('DELETE FROM companies WHERE id = ?').run(prev.id);

const company = db.prepare('INSERT INTO companies (name) VALUES (?)').run(DEMO_COMPANY);
const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
db.prepare('INSERT INTO users (company_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)')
  .run(company.lastInsertRowid, 'Demo Owner', DEMO_EMAIL.toLowerCase(), hash, 'owner');

const rows = parseCsv(fs.readFileSync(SAMPLE, 'utf8').replace(/^\uFEFF/, ''));
const header = rows[0].map((h) => h.trim().toLowerCase());
const idx = (col) => header.indexOf(col);
const insert = db.prepare(
  `INSERT INTO items (company_id, name, category, type, serial, location, owner, due_date, last_completed, interval_value, interval_unit, notes)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
let imported = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const get = (col) => (idx(col) >= 0 ? (r[idx(col)] || '').trim() : '');
  if (!get('name') || !/^\d{4}-\d{2}-\d{2}$/.test(get('due_date'))) continue;
  insert.run(company.lastInsertRowid, get('name'),
    ['equipment', 'vehicle', 'certificate'].includes(get('category')) ? get('category') : 'equipment',
    get('type'), get('serial'), get('location'), get('owner'), get('due_date'), get('last_completed'),
    Number(get('interval_value')) || 12,
    ['days', 'weeks', 'months', 'years'].includes(get('interval_unit')) ? get('interval_unit') : 'months',
    get('notes'));
  imported++;
}
console.log(`Seeded demo company "${DEMO_COMPANY}" with ${imported} items.`);
console.log(`Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}  (demo only — delete this company before real use)`);
console.log('On 2026-11-23 the dashboard should read 3 overdue / 3 due in 7 days / 3 due in 8–30 days / 3 OK.');
