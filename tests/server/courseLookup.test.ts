import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { pruneStagedCatalogs } from '../../server/services/courseCatalog.ts';
import { runDisposition, saveSchedule } from '../../server/services/retention.ts';
import { standing } from '../../server/services/reportCenter.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { writeWorkbook } from '../../server/lib/workbook.ts';
import { verifiedValues } from '../../shared/courses.ts';

/**
 * Course lookup (Task 22, ADR-0029): a course code on a training is looked up only in the current catalog of an approved
 * source a Vantage Administrator registered with its authorization. Vantage fetches nothing. A value is verified only when
 * it is what that catalog lists, worked out by the server on every write; anything else filled in is manual. Sources are
 * never edited, catalogs are staged before they are applied, and every step is audited.
 */

type Who = { token: string; id: string };
let app: TestApp;
let op: Who & { unitId: string };
let admin: Who;
let support: Who;
let auditor: Who;
let marine: Who;
let other: Who;
let g1lead: Who;
let source = '';

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const entries = (action: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<Record<string, any>>;
const stage = (token: string, id: string, data: string | Buffer, filename = 'catalog.csv', asOf = '2026-10-01', type = 'text/csv') =>
  app.call('POST', `/api/platform/course-sources/${id}/import?as_of=${asOf}`, { token, raw: Buffer.isBuffer(data) ? data : Buffer.from(data), headers: { 'content-type': type, 'x-filename': filename } });
const lookup = (token: string, code: string) => get(token, `/api/courses/lookup?code=${encodeURIComponent(code)}`);
const training = (id: string) => app.ctx.db.prepare('SELECT course_code, ceus, course_entry_id, course_verified, course_verified_at FROM trainings WHERE id = ?').get(id) as Record<string, any>;
const verified = (id: string) => JSON.parse(training(id).course_verified ?? 'null') as string[] | null;

const SOURCE = { name: 'MarineNet course catalog', authority: 'TECOM, College of Distance Education and Training', approval_reference: 'G-8 memo 1500 of 2026-09-30', approved_by: 'Comptroller, G-8', approved_on: '2026-09-30' };
/** A title row above the headers, header names as the source writes them, a bad row, a clashing pair and an identical repeat. */
const CATALOG = [
  'MarineNet catalog extract,,,,,,',
  'Course Number,Course Title,School,Contact Hours,CEU,Course Type,Prerequisites,Eligible Ranks,Notes to self',
  'CDET 8010,Sergeants Course Distance Education Program,CDET,40,4,PME,Corporal or above,Cpl-Sgt,ignored',
  'FIN-201,Fiscal Law Fundamentals,Defense Financial Management,12.5,1.2,Professional,,,',
  'FIN-201,Fiscal Law Fundamentals,Defense Financial Management,12.5,1.2,Professional,,,',
  'DUP 1,First wording,CDET,1,,,,,',
  'DUP-1,Second wording,CDET,1,,,,,',
  ',No code here,CDET,1,,,,,',
  'BAD 1,Bad hours,CDET,lots,,,,,',
  '',
].join('\r\n');

async function staffMember(username: string, role: 'admin' | 'support' | 'auditor'): Promise<Who> {
  const person = await app.register(username);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  const granted = await post(op.token, '/api/platform/staff', { user_id: person.id, role });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  return { id: person.id, token: await login(username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  admin = await staffMember('courseadmin', 'admin');
  support = await staffMember('coursesupport', 'support');
  auditor = await staffMember('courseauditor', 'auditor');
  marine = await app.register('coursemarine'); await enroll(app, op.token, 'G8', marine.id); marine.token = await login('coursemarine');
  other = await app.register('courseother'); await enroll(app, op.token, 'G8', other.id); other.token = await login('courseother');
  g1lead = await app.register('courseg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('courseg1lead');
});
after(async () => { await app.close(); });

test('before any source, a lookup answers nothing and a training is manual', async () => {
  const res = await lookup(marine.token, 'cdet 8010');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { code: 'CDET 8010', sources: 0, matches: [] });
  assert.equal((await app.call('GET', '/api/courses/lookup?code=CDET')).status, 401, 'signed in only');
  assert.equal((await lookup(marine.token, '  ')).status, 400);
  const t = await post(marine.token, '/api/records/trainings', { title: 'Sergeants Course', date: '2026-03-01', course_code: ' cdet  8010 ', ceus: 4 });
  assert.equal(t.status, 201, JSON.stringify(t.body));
  assert.deepEqual(training(t.body.id), { course_code: 'CDET 8010', ceus: 4, course_entry_id: null, course_verified: null, course_verified_at: null });
  assert.equal(t.body.course, undefined);
  assert.equal((await post(marine.token, '/api/records/trainings', { title: 'x', course_code: '---' })).status, 400, 'a code has letters or digits');
  assert.equal((await post(marine.token, '/api/records/trainings', { title: 'x', ceus: 1001 })).status, 400);
});

test('only Vantage Administrators with Service settings register a source, with its authorization; nobody edits one', async () => {
  for (const who of [support, auditor, marine, g1lead]) assert.equal((await post(who.token, '/api/platform/course-sources', SOURCE)).status, 403);
  assert.equal((await get(auditor.token, '/api/platform/course-sources')).status, 200, 'Vantage staff who view the service read them');
  assert.equal((await get(marine.token, '/api/platform/course-sources')).status, 403);
  const missing = await post(op.token, '/api/platform/course-sources', { ...SOURCE, approval_reference: '  ' });
  assert.equal(missing.status, 400);
  assert.ok(missing.body.fieldErrors.approval_reference);
  assert.equal((await post(op.token, '/api/platform/course-sources', { ...SOURCE, approved_on: '2099-01-01' })).status, 400, 'not approved on a later day');
  const made = await post(op.token, '/api/platform/course-sources', SOURCE);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  source = made.body.id;
  assert.equal(made.body.recorded_by_name.includes('Boletz'), true);
  assert.equal(made.body.current, null);
  assert.equal((await post(admin.token, '/api/platform/course-sources', { ...SOURCE, name: 'marinenet COURSE catalog' })).status, 409, 'two sources in use never share a name');
  assert.equal(entries('course_source_registered').length, 1);
  assert.match(entries('course_source_registered')[0].detail, /G-8 memo 1500/);
  const told = app.ctx.db.prepare("SELECT title FROM notifications WHERE user_id = ? AND action_url = '/admin/courses'").all(admin.id) as Array<{ title: string }>;
  assert.equal(told.length, 1, 'the other Vantage Administrators who hold Service settings are told');
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND action_url = '/admin/courses'").get(op.id) as { n: number }).n, 0, 'not the one who did it');
  assert.throws(() => app.ctx.db.prepare("UPDATE course_sources SET approval_reference = 'other' WHERE id = ?").run(source), /never changed/);
  assert.throws(() => app.ctx.db.prepare('DELETE FROM course_sources WHERE id = ?').run(source), /never removed/);
});

test('a catalog file is read, scanned and counted, answers nothing until it is applied, and only the file shown is applied', async () => {
  assert.equal((await stage(support.token, source, CATALOG)).status, 403);
  assert.equal((await stage(op.token, source, CATALOG, 'catalog.csv', '2099-01-01')).status, 400, 'not as of a later day');
  assert.equal((await stage(op.token, source, Buffer.from('SQLite format 3\u0000 the whole service'), 'catalog.csv')).body.code, 'infrastructure_file');
  assert.equal((await stage(op.token, source, Buffer.from([0x43, 0x6f, 0x64, 0x65, 0x0a, 0xff, 0xfe, 0x41]), 'catalog.csv')).status, 400, 'not UTF-8 text');
  assert.equal((await stage(op.token, source, 'Code,Hours\nA1,2\n')).body.code, 'no_catalog_columns');
  assert.equal((await stage(op.token, source, 'Course Code,Name\n,No code\n')).body.code, 'empty_catalog');

  const staged = await stage(op.token, source, CATALOG);
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  const load = staged.body.staged;
  assert.equal(load.status, 'staged');
  assert.equal(load.courses, 2, 'CDET 8010 and FIN-201 once; the clashing pair and the bad rows are left out');
  const p = load.preview;
  assert.deepEqual({ rows: p.rows, courses: p.courses, left_out: p.left_out, added: p.added, changed: p.changed, removed: p.removed }, { rows: 7, courses: 2, left_out: 4, added: 2, changed: 0, removed: 0 });
  assert.deepEqual(p.columns, { code: 'Course Number', name: 'Course Title', provider: 'School', hours: 'Contact Hours', ceus: 'CEU', category: 'Course Type', requirements: 'Prerequisites', ranks: 'Eligible Ranks' });
  assert.deepEqual(p.ignored_columns, ['Notes to self']);
  assert.deepEqual(p.problems.map((x: { line: number; reason: string }) => [x.line, x.reason.split(' ').slice(0, 3).join(' ')]), [
    [6, 'This course code'], [7, 'This course code'], [8, 'No course code.'], [9, 'The hours are'],
  ]);
  assert.equal(entries('course_catalog_staged').length, 1);
  assert.equal((await lookup(marine.token, 'CDET8010')).body.matches.length, 0, 'a staged catalog answers nothing');
  assert.equal((await lookup(marine.token, 'CDET8010')).body.sources, 0);

  const browse = await get(auditor.token, `/api/platform/course-sources/${source}/loads/${load.id}/entries?q=fiscal`);
  assert.equal(browse.status, 200);
  assert.deepEqual(browse.body.entries.map((e: { code: string }) => e.code), ['FIN-201']);
  assert.equal((await get(auditor.token, `/api/platform/course-sources/${source}/loads/${load.id}/entries?q=cdet-8010`)).body.total, 1, 'a code is found as letters and digits');

  assert.equal((await post(op.token, `/api/platform/course-sources/${source}/loads/${load.id}/apply`, { file_sha256: 'a'.repeat(64) })).body.code, 'catalog_changed');
  assert.equal((await post(auditor.token, `/api/platform/course-sources/${source}/loads/${load.id}/apply`, { file_sha256: load.file_sha256 })).status, 403);
  const applied = await post(op.token, `/api/platform/course-sources/${source}/loads/${load.id}/apply`, { file_sha256: load.file_sha256 });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.current.id, load.id);
  assert.equal(applied.body.staged, null);
  assert.equal((await post(op.token, `/api/platform/course-sources/${source}/loads/${load.id}/apply`, { file_sha256: load.file_sha256 })).body.code, 'catalog_closed', 'once');
  assert.equal(entries('course_catalog_applied').length, 1);

  const found = await lookup(marine.token, 'cdet-8010');
  assert.equal(found.body.sources, 1);
  assert.equal(found.body.matches.length, 1);
  const m = found.body.matches[0];
  assert.deepEqual({ code: m.code, name: m.name, provider: m.provider, hours: m.hours, ceus: m.ceus, category: m.category, requirements: m.requirements, ranks: m.ranks, as_of: m.as_of },
    { code: 'CDET 8010', name: 'Sergeants Course Distance Education Program', provider: 'CDET', hours: 40, ceus: 4, category: 'PME', requirements: 'Corporal or above', ranks: 'Cpl-Sgt', as_of: '2026-10-01' });
  assert.equal(m.source.name, SOURCE.name);
  assert.throws(() => app.ctx.db.prepare("UPDATE course_catalog_entries SET hours = 1 WHERE id = ?").run(m.entry_id), /never changed/);
  assert.throws(() => app.ctx.db.prepare('DELETE FROM course_catalog_entries WHERE id = ?').run(m.entry_id), /kept/);
});

test('a training is verified only where it is what the catalog lists; nothing a request sends says so', async () => {
  const exact = await post(marine.token, '/api/records/trainings', {
    title: 'Sergeants Course Distance Education Program', date: '2026-04-01', course_code: 'cdet 8010', provider: 'CDET', hours: 40, ceus: 4,
    // What the server works out is never taken from the request.
    course_entry_id: 'forged', course_verified: ['code', 'title', 'provider', 'hours', 'ceus'], course_verified_at: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(exact.status, 201, JSON.stringify(exact.body));
  assert.deepEqual(verified(exact.body.id), ['code', 'title', 'provider', 'hours', 'ceus']);
  assert.notEqual(training(exact.body.id).course_entry_id, 'forged');
  assert.notEqual(training(exact.body.id).course_verified_at, '2020-01-01T00:00:00.000Z');
  assert.equal(exact.body.course.entry.source.name, SOURCE.name);
  assert.equal(exact.body.course.entry.superseded, false);

  const partly = await post(marine.token, '/api/records/trainings', { title: 'sergeants course distance education program', date: '2026-04-02', course_code: 'CDET-8010', provider: 'MarineNet', hours: 38 });
  assert.deepEqual(verified(partly.body.id), ['code'], 'case is the source’s; another provider or other hours are manual');
  const forged = await post(marine.token, '/api/records/trainings', { title: 'Something else', course_verified: ['title'] });
  assert.deepEqual(training(forged.body.id), { course_code: null, ceus: null, course_entry_id: null, course_verified: null, course_verified_at: null });

  // The form shows the rule the server stores.
  assert.deepEqual(verifiedValues({ course_code: 'cdet8010', title: 'Sergeants Course Distance Education Program', hours: '40' }, { code: 'CDET 8010', name: 'Sergeants Course Distance Education Program', provider: 'CDET', hours: 40, ceus: 4 }), ['code', 'title', 'hours']);

  // An edit that changes nothing a catalog checks keeps what was verified, and when.
  const at = training(exact.body.id).course_verified_at;
  const notes = await put(marine.token, `/api/records/trainings/${exact.body.id}`, { ...exact.body, notes: 'Graduated with honors.' });
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
  assert.equal(training(exact.body.id).course_verified_at, at);
  // One that changes the hours is checked again.
  const hours = await put(marine.token, `/api/records/trainings/${exact.body.id}`, { ...notes.body, hours: 41 });
  assert.equal(hours.status, 200);
  assert.deepEqual(verified(exact.body.id), ['code', 'title', 'provider', 'ceus']);
  // A course code typed before the catalog was loaded is checked the next time its training is saved.
  const early = (app.ctx.db.prepare("SELECT id FROM trainings WHERE user_id = ? AND title = 'Sergeants Course'").get(marine.id) as { id: string }).id;
  const row = (await get(marine.token, `/api/records/trainings/${early}`)).body;
  assert.equal(row.course, undefined);
  await put(marine.token, `/api/records/trainings/${early}`, { ...row, notes: 'Saved again.' });
  assert.deepEqual(verified(early), ['code', 'ceus']);
  assert.equal((await get(marine.token, `/api/records/trainings/${early}`)).body.course.verified.join(), 'code,ceus');
  // Clearing the code clears what was verified.
  const cleared = await put(marine.token, `/api/records/trainings/${partly.body.id}`, { ...partly.body, course_code: '' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(training(partly.body.id), { course_code: null, ceus: null, course_entry_id: null, course_verified: null, course_verified_at: null });
});

test('a later catalog replaces the one in use, which is kept; what was verified against it still says so', async () => {
  const before = (await get(marine.token, '/api/records/trainings')).body.find((t: { title: string }) => t.title === 'Sergeants Course Distance Education Program');
  const next = await stage(admin.token, source, 'Course Code,Name,Provider,Hours,CEUs\nCDET 8010,Sergeants Course Distance Education Program,CDET,42,4\nNEW-1,New course,TECOM,3,\n', 'catalog-2.csv', '2026-11-01');
  assert.equal(next.status, 201, JSON.stringify(next.body));
  const p = next.body.staged.preview;
  assert.deepEqual({ added: p.added, changed: p.changed, unchanged: p.unchanged, removed: p.removed }, { added: 1, changed: 1, unchanged: 0, removed: 1 }, 'FIN-201 is no longer listed');
  // Loading again replaces a file waiting to be applied; the one it replaces is discarded and what it listed goes.
  const again = await stage(admin.token, source, 'Course Code,Name,Provider,Hours,CEUs\nCDET 8010,Sergeants Course Distance Education Program,CDET,42,4\nNEW-1,New course,TECOM,3,\n', 'catalog-2b.csv', '2026-11-01');
  assert.equal((app.ctx.db.prepare('SELECT status FROM course_catalog_loads WHERE id = ?').get(next.body.staged.id) as { status: string }).status, 'discarded');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM course_catalog_entries WHERE load_id = ?').get(next.body.staged.id) as { n: number }).n, 0);
  const applied = await post(admin.token, `/api/platform/course-sources/${source}/loads/${again.body.staged.id}/apply`, { file_sha256: again.body.staged.file_sha256 });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.history.length, 1, 'the catalog it replaced is kept');
  assert.equal(applied.body.history[0].status, 'superseded');
  assert.equal((await lookup(marine.token, 'FIN201')).body.matches.length, 0);
  assert.equal((await lookup(marine.token, 'CDET 8010')).body.matches[0].hours, 42);
  const after = (await get(marine.token, '/api/records/trainings')).body.find((t: { id: string }) => t.id === before.id);
  assert.equal(after.course.entry.superseded, true);
  assert.equal(after.course.entry.hours, 40, 'it still says what the source said when it was checked');
  assert.equal(after.course.verified_at, before.course.verified_at);
  // The old catalog can still be browsed.
  assert.equal((await get(auditor.token, `/api/platform/course-sources/${source}/loads/${applied.body.history[0].id}/entries`)).body.total, 2);
});

test('a discarded or stale file answers nothing and keeps nothing it listed', async () => {
  const staged = await stage(op.token, source, 'Course Code,Name\nGONE-1,Never applied\n', 'gone.csv', '2026-11-02');
  const id = staged.body.staged.id;
  assert.equal((await post(support.token, `/api/platform/course-sources/${source}/loads/${id}/discard`)).status, 403);
  const discarded = await post(op.token, `/api/platform/course-sources/${source}/loads/${id}/discard`);
  assert.equal(discarded.status, 200);
  assert.equal(discarded.body.staged, null);
  assert.equal((await get(op.token, `/api/platform/course-sources/${source}/loads/${id}/entries`)).status, 404);
  assert.equal(entries('course_catalog_discarded').length, 1);
  // One left waiting past its time is discarded by the hourly prune.
  const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
  app.ctx.db.prepare("INSERT INTO course_catalog_loads (id, source_id, status, as_of, file_name, file_sha256, byte_size, entry_count, preview, staged_by, staged_at) VALUES ('stale', ?, 'staged', '2026-11-01', 'stale.csv', ?, 10, 1, '{}', ?, ?)").run(source, 'b'.repeat(64), op.id, old);
  app.ctx.db.prepare("INSERT INTO course_catalog_entries (id, load_id, line, code, code_key, name) VALUES ('stale-e', 'stale', 2, 'STALE', 'STALE', 'Stale')").run();
  assert.equal((await post(op.token, `/api/platform/course-sources/${source}/loads/stale/apply`, { file_sha256: 'b'.repeat(64) })).body.code, 'catalog_expired');
  assert.equal(pruneStagedCatalogs(app.ctx), 1);
  assert.equal((app.ctx.db.prepare("SELECT status FROM course_catalog_loads WHERE id = 'stale'").get() as { status: string }).status, 'discarded');
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM course_catalog_entries WHERE load_id = 'stale'").get() as { n: number }).n, 0);
});

test('moving an activity to Training, importing and exporting: the server checks the course, never the file', async () => {
  const activity = await post(marine.token, '/api/records/activities', { title: 'New course', date: '2026-05-01', category: 'training', value_type: 'count', quantity: 1 });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const moved = await post(marine.token, `/api/records/activities/${activity.body.id}/move`, { to: 'trainings', fields: { course_code: 'new 1', provider: 'TECOM', hours: 3 } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.deepEqual(verified(moved.body.id), ['code', 'title', 'provider', 'hours']);

  const csv = 'Title,Date,Course Code,CEUs,Hours,Provider,Verified,Verified Against\nNew course,2026-06-01,NEW-1,,3,TECOM,Title,Forged\nMy own course,2026-06-02,NOPE 9,1,2,Base,Course code; Title; Hours,Forged\n';
  const staged = await app.call('POST', '/api/me/imports', { token: other.token, raw: Buffer.from(csv), headers: { 'content-type': 'text/csv', 'x-filename': 'training.csv' } });
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 400));
  const done = await post(other.token, `/api/me/imports/${staged.body.id}/commit`, { expected: { new: staged.body.counts.new, update: staged.body.counts.update } });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 400));
  const mine = app.ctx.db.prepare('SELECT id, title FROM trainings WHERE user_id = ? ORDER BY date').all(other.id) as Array<{ id: string; title: string }>;
  assert.deepEqual(mine.map((t) => [t.title, verified(t.id)]), [['New course', ['code', 'title', 'provider', 'hours']], ['My own course', null]], 'verified as the catalog says, whatever the file says');

  const exported = await get(other.token, '/api/me/export?format=csv&sections=trainings');
  assert.equal(exported.status, 200, exported.text.slice(0, 300));
  const lines = exported.text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const h of ['Course Code', 'CEUs', 'Verified', 'Verified Against']) assert.ok(lines[0].includes(`"${h}"`), `${h} in ${lines[0]}`);
  const row = lines.find((l) => l.includes('New course'))!;
  assert.match(row, /Course code; Title; Provider; Hours/);
  assert.match(row, /MarineNet course catalog \(TECOM, College of Distance Education and Training\), catalog as of 2026-11-01/);
  // The sheet back in, with its code as a person retypes it: nothing changed, so nothing is updated.
  const retyped = exported.text.replace('"NEW-1"', '"new-1"');
  assert.notEqual(retyped, exported.text);
  const again = await app.call('POST', '/api/me/imports', { token: other.token, raw: Buffer.from(retyped), headers: { 'content-type': 'text/csv', 'x-filename': 'training.csv' } });
  assert.equal(again.status, 201, JSON.stringify(again.body).slice(0, 400));
  assert.equal(again.body.counts.update, 0, JSON.stringify(again.body.rows.map((r: { outcome: string; reason: string | null }) => [r.outcome, r.reason])));
  const json = await get(other.token, '/api/me/export?format=json&sections=trainings');
  const t = json.body.records.trainings.find((x: { title: string }) => x.title === 'New course');
  assert.equal(t.course.entry.code, 'NEW-1');
});

test('withdrawing a source: its catalog verifies nothing new, and what it verified says it was withdrawn', async () => {
  const kept = app.ctx.db.prepare("SELECT id FROM trainings WHERE user_id = ? AND course_entry_id IS NOT NULL LIMIT 1").get(marine.id) as { id: string };
  assert.equal((await post(support.token, `/api/platform/course-sources/${source}/withdraw`, { reason: 'x' })).status, 403);
  assert.equal((await post(op.token, `/api/platform/course-sources/${source}/withdraw`, { reason: ' ' })).status, 400);
  const staged = await stage(op.token, source, 'Course Code,Name\nW-1,Waiting\n', 'waiting.csv', '2026-11-03');
  const out = await post(op.token, `/api/platform/course-sources/${source}/withdraw`, { reason: 'The approval was rescinded.' });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.body.withdrawn_at);
  assert.equal(out.body.staged, null, 'a file waiting to be applied is discarded');
  assert.equal((app.ctx.db.prepare('SELECT status FROM course_catalog_loads WHERE id = ?').get(staged.body.staged.id) as { status: string }).status, 'discarded');
  assert.equal((await post(op.token, `/api/platform/course-sources/${source}/withdraw`, { reason: 'again' })).body.code, 'source_withdrawn');
  assert.equal(entries('course_source_withdrawn').length, 1);
  assert.deepEqual((await lookup(marine.token, 'CDET 8010')).body, { code: 'CDET 8010', sources: 0, matches: [] });
  const row = (await get(marine.token, `/api/records/trainings/${kept.id}`)).body;
  assert.equal(row.course.entry.withdrawn_reason, 'The approval was rescinded.');
  assert.ok(row.course.verified.includes('code'), 'what was verified while it was approved stays verified');
  const fresh = await post(marine.token, '/api/records/trainings', { title: 'Sergeants Course Distance Education Program', course_code: 'CDET 8010' });
  assert.equal(training(fresh.body.id).course_entry_id, null, 'manual now');
  assert.equal((await stage(op.token, source, 'Course Code,Name\nW-2,Too late\n')).body.code, 'source_withdrawn');
  // The name is free again for a source registered with a new approval.
  assert.equal((await post(op.token, '/api/platform/course-sources', { ...SOURCE, approval_reference: 'G-8 memo 1500 of 2026-11-14' })).status, 201);
});

test('a workbook catalog is read from its first sheet with the columns, and the course code meets a training requirement', async () => {
  const wb = await post(op.token, '/api/platform/course-sources', { ...SOURCE, name: 'CDET catalog', authority: 'CDET' });
  assert.equal(wb.status, 201);
  const book = writeWorkbook([{ name: 'Readme', rows: [['Exported for Vantage']] }, { name: 'Courses', rows: [['Course ID', 'Title', 'Hours'], ['MCI 0100', 'Marine Corps Common Skills', 20]] }]);
  const staged = await stage(op.token, wb.body.id, book, 'cdet.xlsx', '2026-11-01', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.staged.preview.sheet, 'Courses');
  assert.equal(staged.body.staged.courses, 1);
  // Numbers as a workbook computes them or a person writes them; a long sheet that is not the catalog is not read.
  const raw = Array.from({ length: 20_020 }, (_, i) => [`R${i}`, 'x']);
  const mixed = writeWorkbook([{ name: 'Courses', rows: [['Course ID', 'Title', 'Hours', 'CEUs'], ['MCI 0200', 'Long course', '1,200', '2.333333333'], ['MCI 0300', 'Short course', '.5', '']] }, { name: 'Raw', rows: raw }]);
  const nums = await post(op.token, '/api/platform/course-sources', { ...SOURCE, name: 'Numbers catalog', authority: 'TECOM' });
  const numbered = await stage(op.token, nums.body.id, mixed, 'numbers.xlsx', '2026-11-01', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(numbered.status, 201, JSON.stringify(numbered.body).slice(0, 300));
  const listed = (await get(op.token, `/api/platform/course-sources/${nums.body.id}/loads/${numbered.body.staged.id}/entries`)).body.entries as Array<{ code: string; hours: number; ceus: number | null }>;
  assert.deepEqual(listed.map((e) => [e.code, e.hours, e.ceus]), [['MCI 0200', 1200, 2.3333], ['MCI 0300', 0.5, null]]);
  assert.equal((await post(op.token, `/api/platform/course-sources/${nums.body.id}/loads/${numbered.body.staged.id}/discard`)).status, 200);
  // A tab-separated extract with a title line above its headers.
  const tsv = await post(op.token, '/api/platform/course-sources', { ...SOURCE, name: 'TSV catalog', authority: 'TECOM' });
  const tab = await stage(op.token, tsv.body.id, 'TECOM extract, November\nCourse Code\tCourse Title\tHours\nT-1\tFirst, with a comma\t2\nT-2\tSecond\t\n', 'extract.tsv', '2026-11-01', 'text/tab-separated-values');
  assert.equal(tab.status, 201, JSON.stringify(tab.body));
  assert.equal(tab.body.staged.courses, 2);
  assert.equal((await get(op.token, `/api/platform/course-sources/${tsv.body.id}/loads/${tab.body.staged.id}/entries?q=T-1`)).body.entries[0].name, 'First, with a comma');
  assert.equal((await post(op.token, `/api/platform/course-sources/${tsv.body.id}/loads/${tab.body.staged.id}/discard`)).status, 200);

  const req = { id: 'r', title: 'Common Skills', type: 'annual', course_code: 'MCI-0100', interval_months: null, unit_id: null };
  const done = (title: string, course_code: string | null) => ({ user_id: 'u', title, status: 'completed', date: '2026-03-01', end_date: null, course_code });
  assert.equal(standing(req, [done('Something else entirely', 'mci 0100')], '2026-11-01').status, 'met', 'by the course code the training names');
  assert.equal(standing(req, [done('Something else entirely', 'MCI 0101')], '2026-11-01').status, 'missing');
});

test('anonymizing a training under a retention schedule leaves nothing that says what its title was', async () => {
  const shared = await post(marine.token, '/api/records/trainings', { title: 'Old shared course', date: '2010-01-04', course_code: 'MCI 0100', visibility: 'unit', unit_id: 'G8' });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  // Verified against the CDET catalog's code alone (it is staged, not applied): set it as a write against it would.
  const cdet = app.ctx.db.prepare("SELECT l.id, l.file_sha256, l.source_id FROM course_catalog_loads l JOIN course_sources s ON s.id = l.source_id WHERE s.name = 'CDET catalog'").get() as { id: string; file_sha256: string; source_id: string };
  assert.equal((await post(op.token, `/api/platform/course-sources/${cdet.source_id}/loads/${cdet.id}/apply`, { file_sha256: cdet.file_sha256 })).status, 200);
  await put(marine.token, `/api/records/trainings/${shared.body.id}`, { ...shared.body, title: 'Marine Corps Common Skills', hours: 20 });
  assert.deepEqual(verified(shared.body.id), ['code', 'title', 'hours']);
  saveSchedule(app.ctx, 'G8', { record_type: 'trainings', retain_days: 3650, disposition: 'anonymize', enabled: true, authority: 'Unit SOP' }, op.id);
  runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
  const after = app.ctx.db.prepare('SELECT title, course_code, hours, course_entry_id, course_verified, course_verified_at FROM trainings WHERE id = ?').get(shared.body.id) as Record<string, any>;
  assert.match(after.title, /redacted/);
  assert.equal(after.course_code, 'MCI 0100', 'a course code counts a course, not a Marine');
  assert.equal(after.hours, 20);
  assert.deepEqual([after.course_entry_id, after.course_verified, after.course_verified_at], [null, null, null], 'no listing shows its name beside the redacted title');
  assert.equal((await get(marine.token, `/api/records/trainings/${shared.body.id}`)).body.course, undefined);
});

test('an instance archive loads into a fresh host whose operator registered a source, and its catalogs stay kept', async () => {
  const fresh = await startApp();
  try {
    const freshOp = await fresh.setupOperator();
    const made = await fresh.call('POST', '/api/platform/course-sources', { token: freshOp.token, body: { ...SOURCE, name: 'Put on file before the restore' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const staged = await fresh.call('POST', `/api/platform/course-sources/${made.body.id}/import?as_of=2026-10-01`, { token: freshOp.token, raw: Buffer.from('Course Code,Name\nX-1,Here first\n'), headers: { 'content-type': 'text/csv', 'x-filename': 'c.csv' } });
    assert.equal((await fresh.call('POST', `/api/platform/course-sources/${made.body.id}/loads/${staged.body.staged.id}/apply`, { token: freshOp.token, body: { file_sha256: staged.body.staged.file_sha256 } })).status, 200);
    const triggers = fresh.ctx.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all();
    const archive = JSON.parse(JSON.stringify(exportInstance(app.ctx))) as Parameters<typeof importInstance>[1] & { tables: Record<string, unknown[]> };
    assert.ok(archive.tables.course_catalog_entries.length > 0);
    importInstance(fresh.ctx, archive, freshOp.id);
    const names = (fresh.ctx.db.prepare('SELECT name FROM course_sources ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);
    assert.deepEqual(names, (app.ctx.db.prepare('SELECT name FROM course_sources ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name), 'the archive’s sources replace the host’s');
    assert.equal((fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM course_catalog_entries').get() as { n: number }).n, (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM course_catalog_entries').get() as { n: number }).n);
    // The triggers are back: what an applied catalog lists is kept.
    const kept = fresh.ctx.db.prepare("SELECT e.id FROM course_catalog_entries e JOIN course_catalog_loads l ON l.id = e.load_id WHERE l.status = 'current' LIMIT 1").get() as { id: string };
    assert.throws(() => fresh.ctx.db.prepare('DELETE FROM course_catalog_entries WHERE id = ?').run(kept.id), /kept/);
    assert.throws(() => fresh.ctx.db.prepare('DELETE FROM course_sources').run(), /never removed/);
    // Every trigger the host had is back, as it was.
    assert.deepEqual(fresh.ctx.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all(), triggers);
  } finally { await fresh.close(); }
});
