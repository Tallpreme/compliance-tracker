// Reminder logic shared by the HTTP endpoint and the daily cron script.
// Email is NOT sent here: the log is the system of record until SMTP is
// configured (see README). The log records who would have been emailed.
function daysUntil(dateStr, todayStr) {
  const toMidnight = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMidnight(dateStr) - toMidnight(todayStr)) / 86400000);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run the reminder check for one company (or all companies if companyId is null).
 * For each item, creates a log row for each reminder type that is due today:
 * 30 / 14 / 7 / 1 days before due, plus 'overdue' once per day while overdue.
 * Idempotent for a given day: a (item, type, date) row is only created once.
 * Returns { checked, created, logs }.
 */
function runReminderCheck(db, companyId = null) {
  const today = todayStr();
  const items = companyId
    ? db.prepare('SELECT * FROM items WHERE company_id = ?').all(companyId)
    : db.prepare('SELECT * FROM items').all();
  const companies = companyId
    ? [companyId]
    : db.prepare('SELECT DISTINCT company_id FROM items').all().map((r) => r.company_id);

  const recipientsByCompany = {};
  for (const cid of companies) {
    const users = db.prepare('SELECT email FROM users WHERE company_id = ?').all(cid);
    recipientsByCompany[cid] = users.map((u) => u.email).join(', ');
  }

  const exists = db.prepare(
    "SELECT id FROM reminder_log WHERE item_id = ? AND reminder_type = ? AND date(created_at) = date('now')"
  );
  const insert = db.prepare(
    `INSERT INTO reminder_log (company_id, item_id, item_name, due_date, days_until_due, reminder_type, recipient_emails)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  let created = 0;
  const logs = [];
  for (const item of items) {
    const days = daysUntil(item.due_date, today);
    let type = null;
    if (days === 30) type = '30-day';
    else if (days === 14) type = '14-day';
    else if (days === 7) type = '7-day';
    else if (days === 1) type = '1-day';
    else if (days < 0) type = 'overdue';
    if (!type) continue;
    if (exists.get(item.id, type)) continue; // already logged today
    const info = insert.run(
      item.company_id, item.id, item.name, item.due_date, days, type,
      recipientsByCompany[item.company_id] || ''
    );
    created++;
    logs.push({ id: info.lastInsertRowid, item_name: item.name, due_date: item.due_date, days_until_due: days, reminder_type: type });
  }
  return { checked: items.length, created, logs, date: today };
}

module.exports = { runReminderCheck, daysUntil, todayStr };
