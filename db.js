const path = require('path');
// Built-in Node SQLite (Node 22.5+). No native build step, so `npm install`
// works in sandboxes and on free-tier hosts where better-sqlite3 / sqlite3
// fail to compile. API used here (prepare/run/get/all, lastInsertRowid,
// changes) matches better-sqlite3 for the calls in this app.
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'compliance.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'equipment',
  type TEXT DEFAULT '',
  serial TEXT DEFAULT '',
  location TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  due_date TEXT NOT NULL,
  last_completed TEXT DEFAULT '',
  interval_value INTEGER DEFAULT 12,
  interval_unit TEXT NOT NULL DEFAULT 'months',
  notes TEXT DEFAULT '',
  certificate_path TEXT DEFAULT '',
  certificate_name TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reminder_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  due_date TEXT NOT NULL,
  days_until_due INTEGER NOT NULL,
  reminder_type TEXT NOT NULL,
  recipient_emails TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_company ON items(company_id, due_date);
CREATE INDEX IF NOT EXISTS idx_reminders_company ON reminder_log(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
`);

module.exports = db;
