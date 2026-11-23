/**
 * Integration tests for the standalone Compliance Tracker.
 * Usage: npm test
 * Starts the server on a temp SQLite DB (port 3123), then exercises the
 * API with plain fetch. Exits 0 if all checks pass, 1 otherwise.
 * No test framework needed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `ct-test-${Date.now()}.db`);
process.env.DATABASE_PATH = TEST_DB;
process.env.JWT_SECRET = 'test-secret-do-not-use-in-production';
process.env.PORT = '3123';
const BASE = 'http://127.0.0.1:3123';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${detail}`); }
}
async function req(p, { token, method = 'GET', body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method, headers, body: payload });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const sampleCsv = fs.readFileSync(
  path.join(__dirname, '..', '..', 'your_files', 'compliance-tracker-sample.csv')
);

async function main() {
  const app = require('../server');
  const server = app.listen(3123, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  try {
    console.log('— auth & signup —');
    const a = await req('/api/auth/signup', { method: 'POST', body: { name: 'Alice Owner', email: 'alice@acme-hvac.test', password: 'Password123', company_name: 'Acme HVAC' } });
    check('signup company A returns 201 + token', a.status === 201 && !!a.json.token, JSON.stringify(a.json));
    const tokenA = a.json.token;
    const b = await req('/api/auth/signup', { method: 'POST', body: { name: 'Bob Owner', email: 'bob@beta-electrical.test', password: 'Password123', company_name: 'Beta Electrical' } });
    check('signup company B returns 201 + token', b.status === 201 && !!b.json.token);
    const tokenB = b.json.token;
    const dup = await req('/api/auth/signup', { method: 'POST', body: { name: 'Alice 2', email: 'alice@acme-hvac.test', password: 'Password123', company_name: 'Other' } });
    check('duplicate email rejected', dup.status === 400);
    const badLogin = await req('/api/auth/login', { method: 'POST', body: { email: 'alice@acme-hvac.test', password: 'wrongpass' } });
    check('wrong password rejected', badLogin.status === 401);
    const login = await req('/api/auth/login', { method: 'POST', body: { email: 'alice@acme-hvac.test', password: 'Password123' } });
    check('login works', login.status === 200 && !!login.json.token);
    const noAuth = await req('/api/items');
    check('items without token rejected', noAuth.status === 401);

    console.log('— items CRUD —');
    const created = await req('/api/items', { token: tokenA, method: 'POST', body: { name: 'Test Gauge', category: 'equipment', type: 'Calibration', serial: 'TG-1', location: 'Van 1', owner: 'Alice', due_date: '2026-11-24', last_completed: '2025-11-24', interval_value: 12, interval_unit: 'months' } });
    check('create item', created.status === 201 && created.json.item.days_remaining === 1, JSON.stringify(created.json));
    const itemId = created.json.item.id;

    console.log('— CSV import (sample file) —');
    const form = new FormData();
    form.append('file', new Blob([sampleCsv], { type: 'text/csv' }), 'sample.csv');
    const imp = await req('/api/items/import', { token: tokenA, method: 'POST', form });
    check('import sample: 12 imported, 0 skipped', imp.status === 200 && imp.json.imported === 12 && imp.json.skipped === 0, JSON.stringify(imp.json));

    console.log('— dashboard counts (2026-11-23) —');
    const dash = await req('/api/dashboard', { token: tokenA });
    // 1 hand-created item (due 2026-11-24) + 12 sample rows:
    // overdue 3, due7 4 (3 sample + hand-created), due30 3, ok 3, total 13
    check('dashboard total = 13', dash.json.counts.total === 13, JSON.stringify(dash.json.counts));
    check('dashboard overdue = 3', dash.json.counts.overdue === 3, JSON.stringify(dash.json.counts));
    check('dashboard due7 = 4', dash.json.counts.due7 === 4, JSON.stringify(dash.json.counts));
    check('dashboard due30 = 3', dash.json.counts.due30 === 3, JSON.stringify(dash.json.counts));
    check('dashboard ok = 3', dash.json.counts.ok === 3, JSON.stringify(dash.json.counts));

    console.log('— renew —');
    const renewed = await req(`/api/items/${itemId}/renew`, { token: tokenA, method: 'POST', body: {} });
    check('renew rolls due date forward 12 months (2026-11-24 → 2027-11-24)', renewed.status === 200 && renewed.json.item.due_date === '2027-11-24', JSON.stringify(renewed.json));

    console.log('— reminders —');
    const rem = await req('/api/reminders/run', { token: tokenA, method: 'POST', body: {} });
    check('reminder check runs', rem.status === 200 && typeof rem.json.checked === 'number', JSON.stringify(rem.json));
    const remList = await req('/api/reminders', { token: tokenA });
    check('reminder log readable', remList.status === 200 && Array.isArray(remList.json.reminders));

    console.log('— team (max 3) —');
    const t1 = await req('/api/team', { token: tokenA, method: 'POST', body: { name: 'Teammate One', email: 'one@acme-hvac.test', password: 'Password123' } });
    check('add team member 2', t1.status === 201);
    const t2 = await req('/api/team', { token: tokenA, method: 'POST', body: { name: 'Teammate Two', email: 'two@acme-hvac.test', password: 'Password123' } });
    check('add team member 3', t2.status === 201);
    const t3 = await req('/api/team', { token: tokenA, method: 'POST', body: { name: 'Teammate Three', email: 'three@acme-hvac.test', password: 'Password123' } });
    check('4th team member rejected (limit 3)', t3.status === 400, JSON.stringify(t3.json));
    const memberLogin = await req('/api/auth/login', { method: 'POST', body: { email: 'one@acme-hvac.test', password: 'Password123' } });
    check('team member can log in', memberLogin.status === 200);

    console.log('— multi-tenant isolation (Company A vs Company B) —');
    const bList = await req('/api/items', { token: tokenB });
    check('Company B list is empty (cannot see A items)', bList.status === 200 && bList.json.items.length === 0, JSON.stringify(bList.json));
    const bDash = await req('/api/dashboard', { token: tokenB });
    check('Company B dashboard total = 0', bDash.json.counts.total === 0);
    const bGet = await req(`/api/items/${itemId}`, { token: tokenB });
    check("Company B GET Company A item → 404", bGet.status === 404);
    const bPut = await req(`/api/items/${itemId}`, { token: tokenB, method: 'PUT', body: { name: 'Hijacked', due_date: '2027-01-01' } });
    check("Company B PUT Company A item → 404", bPut.status === 404);
    const bDel = await req(`/api/items/${itemId}`, { token: tokenB, method: 'DELETE' });
    check("Company B DELETE Company A item → 404", bDel.status === 404);
    const aGet = await req(`/api/items/${itemId}`, { token: tokenA });
    check('Company A item still exists after B attempts', aGet.status === 200 && aGet.json.item.name === 'Test Gauge');
    const bRem = await req('/api/reminders', { token: tokenB });
    check("Company B sees no reminders", bRem.status === 200 && bRem.json.reminders.length === 0);

    console.log('— billing placeholder —');
    const bill = await req('/api/billing', { token: tokenA });
    check('billing shows $49/mo plan', bill.status === 200 && bill.json.price === '$49/mo', JSON.stringify(bill.json));
  } finally {
    server.close();
    try { fs.unlinkSync(TEST_DB); } catch {}
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
