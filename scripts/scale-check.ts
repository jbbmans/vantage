/**
 * How big can one Vantage instance get before it stops feeling instant?
 *
 * "SQLite does not scale" is true of the wrong deployment and false of the right one, and the
 * difference is a number nobody had measured. This seeds a database the size of a real command and
 * times the queries that actually run on the hot paths, so the deployment model can be argued from
 * evidence instead of instinct.
 *
 *   npx tsx scripts/scale-check.ts            # a 250-person command, the common case
 *   USERS=2000 RECORDS=400 npx tsx scripts/scale-check.ts
 *
 * Run it against a scratch file, never a real database: it writes a lot of rows.
 */
import { openDatabase } from '../server/db/index.ts';
import { newId } from '../server/lib/ids.ts';
import { rmSync } from 'node:fs';

const USERS = Number(process.env.USERS || 250);
const RECORDS_PER_USER = Number(process.env.RECORDS || 300);
const PATH = process.env.SCALE_DB || '/tmp/vantage-scale.db';
const CATEGORIES = ['Fiscal & Financial', 'Training & Education', 'Readiness', 'Administration'];
const AREAS = ['MOS / Mission Accomplishment', 'Leadership', 'Individual Character'];

for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${PATH}${suffix}`); } catch {} }
const db = openDatabase(PATH);
const at = new Date().toISOString();

console.log(`Seeding ${USERS.toLocaleString()} people x ${RECORDS_PER_USER} records = ${(USERS * RECORDS_PER_USER).toLocaleString()} rows`);
const seedStart = Date.now();

db.exec('BEGIN');
db.prepare("INSERT OR IGNORE INTO units (id, code, name, short_name, created_at) VALUES ('G8','G8','G-8 Comptroller','G8',?)").run(at);
const insertUser = db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, rank_id, edipi, created_at, updated_at)
                               VALUES (?, ?, 'x', ?, ?, 'Cpl', ?, ?, ?)`);
const insertMember = db.prepare("INSERT INTO unit_members (unit_id, user_id, billet, is_primary, joined_at) VALUES ('G8', ?, 'Analyst', 1, ?)");
const insertActivity = db.prepare(`INSERT INTO activities (id, user_id, unit_id, date, title, category, eval_area, quantity, unit_label, dollar_amount, dollar_type, result, organization, status, visibility, created_at, updated_at, version)
                                   VALUES (?, ?, 'G8', ?, ?, ?, ?, ?, 'items', ?, 'reviewed', 'cleared', 'G-8', 'completed', ?, ?, ?, 1)`);

const userIds: string[] = [];
for (let u = 0; u < USERS; u += 1) {
  const id = newId();
  userIds.push(id);
  insertUser.run(id, `user${u}`, `First${u}`, `Last${u}`, String(1000000000 + u), at, at);
  insertMember.run(id, at);
  for (let r = 0; r < RECORDS_PER_USER; r += 1) {
    const daysBack = (r * 3) % 1460;
    const date = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
    insertActivity.run(newId(), id, date, `Reconciled ${r} obligations for record ${r}`, CATEGORIES[r % 4], AREAS[r % 3],
      (r % 50) + 1, ((r * 137) % 100000) / 10, r % 3 === 0 ? 'unit' : 'private', at, at);
  }
  if (u % 50 === 49) { db.exec('COMMIT'); db.exec('BEGIN'); }
}
db.exec('COMMIT');
db.exec('ANALYZE');

const seedSeconds = ((Date.now() - seedStart) / 1000).toFixed(1);
const bytes = (db.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get() as { n: number }).n;
console.log(`Seeded in ${seedSeconds}s. Database is ${(bytes / 1e6).toFixed(1)} MB.\n`);

const me = userIds[Math.floor(userIds.length / 2)];
const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);

/** The queries a person actually waits on. */
const QUERIES: Array<[string, () => unknown]> = [
  ['dashboard: my totals this year', () =>
    db.prepare(`SELECT COUNT(*) AS outcomes, SUM(dollar_amount) AS dollars, SUM(quantity) AS quantity
                FROM activities WHERE user_id = ? AND date >= ? AND deleted_at IS NULL`).get(me, yearAgo)],
  ['dashboard: monthly trend', () =>
    db.prepare(`SELECT substr(date, 1, 7) AS month, COUNT(*) AS n, SUM(dollar_amount) AS dollars
                FROM activities WHERE user_id = ? AND date >= ? AND deleted_at IS NULL GROUP BY month ORDER BY month`).all(me, yearAgo)],
  ['records: first page, newest first', () =>
    db.prepare(`SELECT * FROM activities WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 50`).all(me)],
  ['records: filtered by category and period', () =>
    db.prepare(`SELECT * FROM activities WHERE user_id = ? AND category = ? AND date >= ? AND deleted_at IS NULL ORDER BY date DESC LIMIT 50`).all(me, CATEGORIES[0], yearAgo)],
  ['records: text search', () =>
    db.prepare(`SELECT * FROM activities WHERE user_id = ? AND deleted_at IS NULL AND (title LIKE ? OR result LIKE ?) ORDER BY date DESC LIMIT 50`).all(me, '%obligations 42%', '%obligations 42%')],
  ['team dashboard: the whole unit, shared only', () =>
    db.prepare(`SELECT COUNT(*) AS outcomes, SUM(dollar_amount) AS dollars FROM activities
                WHERE unit_id = 'G8' AND visibility = 'unit' AND date >= ? AND deleted_at IS NULL`).get(yearAgo)],
  ['team dashboard: per person rollup', () =>
    db.prepare(`SELECT user_id, COUNT(*) AS n, SUM(dollar_amount) AS dollars FROM activities
                WHERE unit_id = 'G8' AND visibility = 'unit' AND date >= ? AND deleted_at IS NULL
                GROUP BY user_id ORDER BY dollars DESC LIMIT 50`).all(yearAgo)],
  ['team dashboard: composition by area', () =>
    db.prepare(`SELECT eval_area, COUNT(*) AS n FROM activities
                WHERE unit_id = 'G8' AND visibility = 'unit' AND date >= ? AND deleted_at IS NULL GROUP BY eval_area`).all(yearAgo)],
  ['retention: what is eligible for disposition', () =>
    db.prepare(`SELECT COUNT(*) AS n FROM activities WHERE date IS NOT NULL AND date < ?`).get(yearAgo)],
  ['write: one new record', () =>
    insertActivity.run(newId(), me, '2026-09-14', 'Timed insert', CATEGORIES[0], AREAS[0], 1, 1, 'private', at, at)],
];

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

console.log('query                                        p50       p95       max');
console.log('-'.repeat(74));
let worst = 0;
for (const [label, run] of QUERIES) {
  for (let i = 0; i < 3; i += 1) run();                       // warm the page cache
  const timings: number[] = [];
  for (let i = 0; i < 40; i += 1) { const t = performance.now(); run(); timings.push(performance.now() - t); }
  timings.sort((a, b) => a - b);
  const p50 = percentile(timings, 0.5); const p95 = percentile(timings, 0.95); const max = timings.at(-1)!;
  worst = Math.max(worst, p95);
  const flag = p95 > 100 ? '  <-- SLOW' : p95 > 25 ? '  <-- watch' : '';
  console.log(`${label.padEnd(44)} ${p50.toFixed(2).padStart(7)}ms ${p95.toFixed(2).padStart(7)}ms ${max.toFixed(2).padStart(7)}ms${flag}`);
}

console.log('-'.repeat(74));
console.log(`\n${USERS.toLocaleString()} people, ${(USERS * RECORDS_PER_USER).toLocaleString()} records, ${(bytes / 1e6).toFixed(1)} MB, worst p95 ${worst.toFixed(1)}ms.`);
console.log(worst > 100
  ? 'A query is over 100ms. This instance size needs an index or a different store.'
  : 'Every hot query is inside 100ms. An instance this size is comfortable on SQLite.');
db.close();
