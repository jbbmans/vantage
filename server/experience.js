/** Privacy-preserving, first-party product signals. No user or record keys. */
export const EXPERIENCE_EVENTS = new Set([
  'page_command',
  'page_records',
  'page_work',
  'page_career',
  'page_team',
  'page_reports',
  'page_settings',
  'quick_log_opened',
  'quick_log_saved',
  'import_completed',
  'attachment_uploaded',
]);

export function recordExperience(db, event, day = new Date().toISOString().slice(0, 10)) {
  if (!EXPERIENCE_EVENTS.has(event)) return false;
  db.prepare(
    `INSERT INTO ux_daily_metrics (day, event, count) VALUES (?, ?, 1)
     ON CONFLICT(day, event) DO UPDATE SET count = count + 1`
  ).run(day, event);
  return true;
}
