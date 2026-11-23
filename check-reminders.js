/**
 * Daily reminder check for all companies.
 * Usage:  npm run check-reminders
 * Run it from cron (or a Render/Railway cron job) once a day, e.g. 07:00.
 * It only writes reminder_log rows — email is not sent until SMTP is
 * configured (see README). The log is the system of record until then.
 */
const db = require('../db');
const { runReminderCheck } = require('../reminders');

const result = runReminderCheck(db, null);
console.log(`[${result.date}] Reminder check: ${result.checked} items checked, ${result.created} new reminder log(s).`);
for (const l of result.logs) {
  console.log(`  - ${l.reminder_type}: ${l.item_name} (due ${l.due_date}, ${l.days_until_due} days)`);
}
