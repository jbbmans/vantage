import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { writeWorkbook, readWorkbook } from '../../server/lib/workbook.ts';
import { listZip, readZip } from '../../server/lib/zip.ts';
import { pruneStagedImports } from '../../server/services/recordImport.ts';

/**
 * Task 13 (ADR-0019): a person's records go out and come back by what they are. An award stays an award, a course a
 * course, a counseling a counseling; duty is listed and left out, never turned into Activities; nothing a file says
 * places a record in another Unit Instance or names a record here that is not the importer's own.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let marine: { token: string; id: string };
let other: { token: string; id: string };
let g1lead: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const upload = (token: string, data: Buffer | string, filename: string, type = 'application/octet-stream') =>
  app.call('POST', '/api/me/imports', { token, raw: Buffer.from(data), headers: { 'content-type': type, 'x-filename': filename } });
const commit = (token: string, id: string, body: unknown = {}) => post(token, `/api/me/imports/${id}/commit`, body);
const login = async (username: string) => (await app.login(username)).body.token as string;
const rows = (userId: string, table: string) => app.ctx.db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid`).all(userId) as Array<Record<string, any>>;
const entries = (action: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<Record<string, any>>;
const expected = (review: { counts: { new: number; update: number } }) => ({ expected: { new: review.counts.new, update: review.counts.update } });
const status = (id: string) => (app.ctx.db.prepare('SELECT status FROM record_imports WHERE id = ?').get(id) as { status: string }).status;

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  marine = await app.register('mercer');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = await login('mercer');
  other = await app.register('okafor');
  await enroll(app, op.token, 'G8', other.id);
  other.token = await login('okafor');
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');
});
after(async () => { await app.close(); });

test('a workbook comes in by record type: awards stay awards, courses training, duty is listed and never becomes an Activity', async () => {
  const book = writeWorkbook([
    { name: 'Awards', rows: [['Name', 'Type', 'Status', 'Date', 'Approved'], ['Navy and Marine Corps Achievement Medal', 'Personal', 'approved', '2026-05-01', '05/20/2026']] },
    { name: 'Education', rows: [['Title', 'Date', 'Provider'], ['Bachelor of Science, Accounting', '2025-12-15', 'UMGC']] },
    { name: 'Certifications', rows: [['Title', 'Date'], ['Network+', '2026-02-01']] },
    { name: 'Volunteer', rows: [['Title', 'Date', 'Quantity', 'Unit'], ['Food bank shift', '2026-04-12', 4, 'hours']] },
    { name: 'Duty', rows: [['Date', 'Duty', 'Hours'], ['2026-03-01', 'Officer of the Day', 24], ['2026-03-08', 'Staff Duty NCO', 24]] },
    { name: 'Log', rows: [['Title', 'Date'], ['Received the Navy Achievement Medal at formation', '2026-06-02'], ['Reconciled 40 ULOs', '2026-06-01']] },
    { name: 'Everything else', rows: [['Record Type', 'Title', 'Name', 'Date'], ['Award', '', 'Certificate of Commendation', '2026-01-10'], ['Course', 'Fiscal Law', '', '2026-01-20'], ['Activity', 'Closed out FY25', '', '2025-10-01'], ['Watch', 'Barracks duty', '', '2026-02-02'], ['Spaceship', 'Nothing', '', '2026-01-01']] },
  ]);
  const staged = await upload(marine.token, book, 'my records.xlsx');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 400));
  const review = staged.body;
  assert.equal(review.source, 'xlsx');
  const sheet = (name: string) => review.sheets.find((s: { name: string }) => s.name === name);
  assert.deepEqual([sheet('Awards').table, sheet('Education').table, sheet('Volunteer').table, sheet('Duty').table, sheet('Log').table, sheet('Everything else').table], ['awards', 'trainings', 'activities', 'duty', 'activities', 'record_type']);
  assert.equal(review.counts.not_imported, 3, 'two duty rows and a watch');
  assert.equal(review.counts.problem, 1, 'the unknown record type');
  assert.match(review.rows.find((r: { outcome: string }) => r.outcome === 'problem').reason, /Spaceship/);
  assert.ok(review.notImported.some((n: { key: string; count: number }) => n.key === 'duty' && n.count === 3));
  // The log entry that reads like an award is offered as one and stays an Activity until its owner says so (ADR-0015).
  const medal = review.rows.find((r: { title: string }) => r.title.startsWith('Received the Navy'));
  assert.equal(medal.as, 'activities');
  assert.equal(medal.suggestion?.to, 'awards');
  assert.equal(entries('create').filter((e) => e.actor_id === marine.id).length, 0, 'the review wrote nothing');
  assert.equal(rows(marine.id, 'awards').length, 0);

  const done = await commit(marine.token, review.id, expected(review));
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 400));
  assert.equal(done.body.status, 'imported');
  const awards = rows(marine.id, 'awards');
  assert.deepEqual(awards.map((a) => a.name).sort(), ['Certificate of Commendation', 'Navy and Marine Corps Achievement Medal']);
  const nam = awards.find((a) => a.name.startsWith('Navy'))!;
  assert.deepEqual([nam.type, nam.status, nam.approved_at], ['personal_award', 'approved', '2026-05-20']);
  const trainings = rows(marine.id, 'trainings');
  assert.equal(trainings.find((t) => t.title.startsWith('Bachelor'))?.type, 'education');
  assert.equal(trainings.find((t) => t.title === 'Network+')?.type, 'certification', 'the sheet says what it is when the title does not');
  assert.ok(trainings.some((t) => t.title === 'Fiscal Law'));
  const activities = rows(marine.id, 'activities');
  assert.deepEqual(activities.map((a) => a.title).sort(), ['Closed out FY25', 'Food bank shift', 'Received the Navy Achievement Medal at formation', 'Reconciled 40 ULOs']);
  assert.equal(activities.find((a) => a.title === 'Food bank shift')?.category, 'Volunteer Service');
  assert.ok(!activities.some((a) => /duty|watch/i.test(a.title)), 'duty never becomes an Activity');
  const trail = entries('record_import_committed').at(-1)!;
  assert.equal(trail.actor_id, marine.id);
  assert.match(trail.detail, /2 awards/);
  assert.equal(entries('create').filter((e) => e.actor_id === marine.id && e.detail === `import ${review.id}`).length, 9);

  // The same file again: everything is already here, and nothing goes in twice.
  const again = await upload(marine.token, book, 'my records.xlsx');
  assert.equal(again.body.counts.new, 0, JSON.stringify(again.body.rows.filter((r: { outcome: string }) => r.outcome === 'new').map((r: { title: string }) => r.title)));
  assert.equal(again.body.counts.duplicate, 9);
  // A Record Type Vantage does not know is read as what the person says the row is.
  const unknown = again.body.rows.find((r: { outcome: string }) => r.outcome === 'problem');
  const said = await put(marine.token, `/api/me/imports/${again.body.id}`, { rows: { [unknown.ref]: { as: 'tasks' } } });
  assert.equal(said.status, 200, JSON.stringify(said.body).slice(0, 300));
  assert.equal(said.body.counts.problem, 0);
  assert.deepEqual(said.body.rows.filter((r: { outcome: string }) => r.outcome === 'new').map((r: { as: string; title: string }) => [r.as, r.title]), [['tasks', 'Nothing']]);
  assert.equal((await app.call('DELETE', `/api/me/imports/${again.body.id}`, { token: marine.token })).status, 200);
  assert.equal(status(again.body.id), 'cancelled');
});

test('a CSV routes by its name or its headers, takes corrections and "import as", and a review that changed stops the import', async () => {
  const awardsCsv = 'Award Name,Award Type,Date Awarded,Status\nLetter of Appreciation,loa,2026-03-03,presented\nGood Conduct Medal,personal,03/32/2026,presented\n';
  const staged = await upload(other.token, awardsCsv, 'vantage-okafor-awards-2026-10-28.csv', 'text/csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.sheets[0].table, 'awards');
  const bad = staged.body.rows.find((r: { outcome: string }) => r.outcome === 'problem');
  assert.match(bad.reason, /Date/);
  // Correct the date; the review runs again and the row goes in.
  const fix = { rows: { [bad.ref]: { fix: { date: '2026-03-31' } } } };
  const fixed = await put(other.token, `/api/me/imports/${staged.body.id}`, fix);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.counts.new, 2);
  // What the person confirmed is what goes in: a count that no longer matches stops it, and nothing is written.
  const stale = await commit(other.token, staged.body.id, { ...fix, expected: { new: 5, update: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'import_changed');
  assert.equal(rows(other.id, 'awards').length, 0);
  assert.equal(status(staged.body.id), 'staged', 'still waiting');
  const ok = await commit(other.token, staged.body.id, { ...fix, expected: { new: 2, update: 0 } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(rows(other.id, 'awards').map((a) => [a.name, a.type, a.date]), [['Letter of Appreciation', 'loa', '2026-03-03'], ['Good Conduct Medal', 'personal_award', '2026-03-31']]);

  // Headers alone: a sheet of courses with no telling name.
  const courses = await upload(other.token, 'Course Title,Training Type,Credit Hours,Provider,Date\nMarineNet Fiscal Law,course,8,MarineNet,2026-02-02\n', 'export (3).csv', 'text/csv');
  assert.equal(courses.body.sheets[0].table, 'trainings');
  assert.equal(courses.body.sheets[0].routedBy, 'headers');
  // The person says a row is something else: it goes in as that, carried across as a move would carry it.
  const row = courses.body.rows[0];
  const moved = await commit(other.token, courses.body.id, { rows: { [row.ref]: { as: 'activities' } } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(rows(other.id, 'trainings').length, 0);
  assert.equal(rows(other.id, 'activities').find((a) => a.title === 'MarineNet Fiscal Law')?.date, '2026-02-02');
});

test('a spreadsheet Vantage ID updates only the importer’s own record, and undo puts it back', async () => {
  const mine = (await post(marine.token, '/api/records/trainings', { title: 'Cyber Awareness', date: '2026-01-05', hours: 1 })).body;
  const theirs = (await post(other.token, '/api/records/trainings', { title: 'Their course', date: '2026-01-06', hours: 2 })).body;
  const csv = `Vantage ID,Title,Date,Hours\n${mine.id},Cyber Awareness Challenge,2026-01-05,2\n${theirs.id},Their course (mine now),2026-01-06,9\n`;
  const staged = await upload(marine.token, csv, 'training.csv', 'text/csv');
  const [update, cross] = staged.body.rows;
  assert.equal(update.outcome, 'update', JSON.stringify(update));
  assert.match(update.reason, /title, hours/);
  assert.equal(cross.outcome, 'new', 'another Marine’s id names nothing of the importer’s: it is a new record of theirs');
  const done = await commit(marine.token, staged.body.id, expected(staged.body));
  assert.equal(done.status, 200);
  assert.deepEqual({ ...app.ctx.db.prepare('SELECT title, hours FROM trainings WHERE id = ?').get(mine.id) as object }, { title: 'Cyber Awareness Challenge', hours: 2 });
  assert.deepEqual({ ...app.ctx.db.prepare('SELECT title, hours, user_id FROM trainings WHERE id = ?').get(theirs.id) as object }, { title: 'Their course', hours: 2, user_id: other.id });
  const copy = rows(marine.id, 'trainings').find((t) => t.title === 'Their course (mine now)')!;
  assert.notEqual(copy.id, theirs.id, 'an id in a file is never the id a record takes');

  const undone = await post(marine.token, `/api/me/imports/${staged.body.id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.status, 'undone');
  assert.deepEqual(undone.body.results.undone, { removed: 1, restored: 1, kept: 0 });
  assert.equal((app.ctx.db.prepare('SELECT title FROM trainings WHERE id = ?').get(mine.id) as { title: string }).title, 'Cyber Awareness');
  assert.ok((app.ctx.db.prepare('SELECT deleted_at FROM trainings WHERE id = ?').get(copy.id) as { deleted_at: string | null }).deleted_at, 'what it created is in the recycle bin');
  assert.equal((await post(marine.token, `/api/me/imports/${staged.body.id}/undo`)).status, 409, 'once');
  assert.equal(entries('record_import_undone').length, 1);
});

test('an import never reaches another person’s import, another Unit Instance, or a backup', async () => {
  const staged = await upload(marine.token, 'Title,Date\nShared entry,2026-07-01\n', 'mine.csv', 'text/csv');
  // Another person cannot read, change, import or cancel it.
  assert.equal((await get(other.token, `/api/me/imports/${staged.body.id}`)).status, 404);
  assert.equal((await put(other.token, `/api/me/imports/${staged.body.id}`, {})).status, 404);
  assert.equal((await commit(other.token, staged.body.id)).status, 404);
  assert.equal((await app.call('DELETE', `/api/me/imports/${staged.body.id}`, { token: other.token })).status, 404);
  assert.ok(!(await get(other.token, '/api/me/imports')).body.imports.some((i: { id: string }) => i.id === staged.body.id));
  await app.call('DELETE', `/api/me/imports/${staged.body.id}`, { token: marine.token });

  // A file names its own keys: one readiness has not is listed as nothing, and never reaches the database.
  const odd = await upload(marine.token, JSON.stringify({ format: 'vantage-personal/1', readiness: { constructor: 1, toString: 'x', pft_score: 250 }, records: {} }), 'odd.json', 'application/json');
  assert.equal(odd.status, 201, JSON.stringify(odd.body).slice(0, 300));
  assert.deepEqual(odd.body.profile.changes.map((c: { field: string }) => c.field), ['pft_score']);
  await app.call('DELETE', `/api/me/imports/${odd.body.id}`, { token: marine.token });

  // A record placed in another Unit Instance's unit comes in private, in the importer's own unit.
  const csv = 'Title,Date,Visibility,Unit ID\nInto G1,2026-07-02,unit,G1\nInto nowhere,2026-07-03,unit,NOPE\nIn G8,2026-07-04,unit,G8\n';
  const placed = await upload(marine.token, csv, 'placement.csv', 'text/csv');
  const by = (title: string) => placed.body.rows.find((r: { title: string }) => r.title === title);
  assert.equal(by('Into G1').placement, 'private', JSON.stringify(by('Into G1')));
  assert.equal(by('Into nowhere').placement, 'private');
  assert.equal(by('In G8').placement, 'kept');
  assert.equal((await commit(marine.token, placed.body.id, expected(placed.body))).status, 200);
  const landed = Object.fromEntries(rows(marine.id, 'activities').filter((a) => /^In/.test(a.title)).map((a) => [a.title, [a.visibility, a.unit_id]]));
  assert.deepEqual(landed, { 'Into G1': ['private', 'G8'], 'Into nowhere': ['private', 'G8'], 'In G8': ['unit', 'G8'] });
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM activities WHERE unit_id = 'G1'").get() as { n: number }).n, 0, 'nothing reached G1');

  // Choosing "private" brings everything in private.
  const privately = await upload(marine.token, 'Title,Date,Visibility,Unit ID\nKept to myself,2026-07-05,unit,G8\n', 'private.csv', 'text/csv');
  assert.equal((await put(marine.token, `/api/me/imports/${privately.body.id}`, { placement: 'private' })).body.placement, 'private');
  assert.equal((await commit(marine.token, privately.body.id, { placement: 'private' })).status, 200);
  assert.equal(rows(marine.id, 'activities').find((a) => a.title === 'Kept to myself')?.visibility, 'private');

  // Backups and the other exports are refused for what they are, before anything is kept.
  const count = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_imports').get() as { n: number }).n;
  const kept = count();
  const sqlite = Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(200)]);
  for (const [data, code] of [
    [sqlite, 'infrastructure_file'],
    [JSON.stringify({ format: 'vantage-instance/1', tables: {} }), 'infrastructure_file'],
    [JSON.stringify({ format: 'vantage-unit-configuration/1', billets: [] }), 'wrong_export'],
    [JSON.stringify({ format: 'vantage-organization/1' }), 'wrong_export'],
  ] as Array<[Buffer | string, string]>) {
    const res = await upload(marine.token, data, 'backup.db', 'application/json');
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.code, code);
  }
  assert.equal((await upload(marine.token, '', 'empty.csv')).status, 400);
  assert.equal(count(), kept, 'nothing refused is kept');
});

test('exports: selective, workbook and one category, and a record download keeps the record’s read rule', async () => {
  const sel = await get(marine.token, '/api/me/export?format=json&sections=awards,trainings');
  assert.equal(sel.status, 200, JSON.stringify(sel.body).slice(0, 300));
  assert.deepEqual(Object.keys(sel.body.records).sort(), ['awards', 'trainings']);
  assert.ok(!('audit_trail' in sel.body) && !('profile' in sel.body), 'only what was chosen');
  assert.equal(sel.body.owner.username, 'mercer');
  assert.equal((await get(marine.token, '/api/me/export?format=json&sections=awards,nope')).body.code, 'unknown_section');

  const education = await get(marine.token, '/api/me/export?format=json&sections=education');
  assert.ok(education.body.records.trainings.length && education.body.records.trainings.every((t: { type: string }) => t.type === 'education'), 'a category is its kind of training only');

  const book = await app.call('GET', '/api/me/export?format=xlsx', { token: marine.token, binary: true });
  assert.equal(book.status, 200);
  assert.match(book.headers.get('content-type') ?? '', /spreadsheetml/);
  const sheets = readWorkbook(book.buffer!).sheets;
  for (const name of ['Profile', 'Activities', 'Awards', 'Training', 'About']) assert.ok(sheets.some((s) => s.name === name), `workbook lacks ${name}: ${sheets.map((s) => s.name).join(', ')}`);
  assert.ok(sheets.find((s) => s.name === 'Awards')!.rows.some((r) => r.includes('Navy and Marine Corps Achievement Medal')));

  const csv = await get(marine.token, '/api/me/export?format=csv&sections=awards');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /^\uFEFF?"Vantage ID","Name","Type","Status"/);
  assert.equal((await get(marine.token, '/api/me/export?format=csv&sections=awards,trainings')).body.code, 'csv_one_category');
  assert.ok(entries('export_personal').some((e) => e.actor_id === marine.id && /^xlsx;/.test(e.detail)));

  // An export holds only the exporter's own records, never a shared one of someone else's they can read.
  await post(other.token, '/api/records/activities', { title: 'Okafor shared entry', date: '2026-07-10', visibility: 'unit', unit_id: 'G8' });
  const opExport = await get(op.token, '/api/me/export?format=json');
  assert.equal(opExport.status, 200);
  assert.ok(!JSON.stringify(opExport.body.records).includes('Okafor shared entry'));

  // A record downloads as JSON, CSV or a ZIP, for whoever may read it, and no one else.
  const award = rows(marine.id, 'awards')[0];
  const privateOne = (await post(marine.token, '/api/records/activities', { title: 'Private note to self', date: '2026-07-11' })).body;
  const json = await get(marine.token, `/api/records/awards/${award.id}/export`);
  assert.equal(json.status, 200);
  assert.equal(json.body.format, 'vantage-record/1');
  assert.equal(json.body.record.name, award.name);
  const zip = await app.call('GET', `/api/records/awards/${award.id}/export?format=zip`, { token: marine.token, binary: true });
  assert.deepEqual(listZip(zip.buffer!).sort(), ['record.csv', 'record.json']);
  assert.notEqual((await get(other.token, `/api/records/activities/${privateOne.id}/export`)).status, 200, 'a private record is its owner’s');
  assert.notEqual((await get(g1lead.token, `/api/records/awards/${award.id}/export`)).status, 200, 'another Unit Instance never reads it');
  const shared = rows(other.id, 'activities').find((a) => a.title === 'Okafor shared entry')!;
  assert.equal((await get(op.token, `/api/records/activities/${shared.id}/export?format=csv`)).status, 200, 'their leader reads a shared one, so may download it');
  assert.ok(entries('export_record').some((e) => e.actor_id === op.id && e.subject_id === other.id));
  // A record download comes back in as one record of the importer's own.
  const back = await upload(other.token, JSON.stringify(json.body), 'vantage-award.json', 'application/json');
  assert.equal(back.status, 201, JSON.stringify(back.body));
  assert.deepEqual(back.body.rows.map((r: { as: string; outcome: string }) => [r.as, r.outcome]), [['awards', 'new']]);
  assert.ok(back.body.notes.some((n: string) => /not yours/.test(n)) || back.body.exported?.username == null);
  await app.call('DELETE', `/api/me/imports/${back.body.id}`, { token: other.token });
});

test('a waiting import is released after its time, and one waits at a time', async () => {
  const first = await upload(other.token, 'Title,Date\nOne,2026-07-01\n', 'one.csv', 'text/csv');
  const second = await upload(other.token, 'Title,Date\nTwo,2026-07-01\n', 'two.csv', 'text/csv');
  assert.equal(status(first.body.id), 'cancelled');
  app.ctx.db.prepare("UPDATE record_imports SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(second.body.id);
  assert.equal(pruneStagedImports(app.ctx), 1);
  assert.deepEqual({ ...app.ctx.db.prepare('SELECT status, content FROM record_imports WHERE id = ?').get(second.body.id) as object }, { status: 'expired', content: null });
  assert.equal((await commit(other.token, second.body.id)).status, 409);
});

test('§14 round trip: a representative account, exported and imported into a clean Vantage, comes back as it was', async () => {
  // A leader records a counseling and recommends an award for the Marine, so both carry someone else's word.
  const project = (await post(marine.token, '/api/records/projects', { name: 'FY26 close-out', start_date: '2026-08-01', status: 'active' })).body;
  assert.ok(project.id, JSON.stringify(project));
  await post(marine.token, '/api/records/tasks', { title: 'Reconcile obligations', due_date: '2026-09-15', project_id: project.id });
  const linked = (await post(marine.token, '/api/records/activities', { title: 'Cleared 30 ULOs', date: '2026-08-20', end_date: '2026-08-22', quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled', project_id: project.id, visibility: 'unit', unit_id: 'G8', evidence_links: [{ label: 'ticket', url: 'https://example.mil/t/1' }] })).body;
  assert.ok(linked.id, JSON.stringify(linked));
  assert.equal((await post(marine.token, '/api/records/trainings', { title: 'Sergeants Course', type: 'pme', date: '2026-03-01', end_date: '2026-04-15', status: 'completed', hours: 240 })).status, 201);
  assert.equal((await post(marine.token, '/api/records/trainings', { title: 'CDFM', type: 'certification', date: '2026-05-01', ongoing: true, status: 'in_progress' })).status, 201);
  assert.equal((await post(marine.token, '/api/records/awards', { name: 'Navy Commendation Medal', type: 'personal_award', status: 'submitted', period_start: '2025-01-01', date: '2026-06-30', submitted_at: '2026-07-01' })).status, 201);
  const rec = await post(op.token, '/api/records/awards', { name: 'Meritorious Mast', type: 'meritorious_mast', status: 'recommended', user_id: marine.id, date: '2026-07-15' });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  const counsel = await post(op.token, '/api/records/counselings', { user_id: marine.id, summary: 'Quarterly: strong fiscal work', type: 'quarterly', date: '2026-07-01', strengths: 'Accuracy', follow_up_date: '2026-10-01' });
  assert.equal(counsel.status, 201, JSON.stringify(counsel.body));
  assert.equal((await post(marine.token, '/api/records/goals', { title: 'Reconcile 100 ULOs', metric: 'manual', target_value: 100, current_value: 30, unit_label: 'ULOs', period_end: '2026-12-31' })).status, 201);
  assert.equal((await post(marine.token, '/api/record/career/steps', { title: 'Complete Associate degree', category: 'education', status: 'in_progress', due_date: '2027-05-01' })).status, 201);
  assert.equal((await put(marine.token, '/api/record/career/profile', { military_goal: 'Make SSgt', civilian_interests: 'Federal budget analyst' })).status, 200);
  assert.equal((await put(marine.token, '/api/me/readiness', { pft_score: 270, cft_score: 285, rifle_qual: 'Expert' })).status, 200);
  const attached = await app.call('POST', `/api/records/activities/${linked.id}/attachments`, { token: marine.token, raw: Buffer.from('%PDF-1.4\n% proof of work\n%%EOF\n'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'proof.pdf' } });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  // An FM work entry drawn from a financial case keeps saying so.
  app.ctx.db.prepare("UPDATE activities SET fingerprint = 'work:case-123:close' WHERE id = ?").run(linked.id);

  const exported = await app.call('GET', '/api/me/export?format=zip', { token: marine.token, binary: true });
  assert.equal(exported.status, 200);
  const original = JSON.parse(readZip(exported.buffer!).get('vantage-export.json')!.toString('utf8'));

  // A clean Vantage: a new service, the same person signing up again.
  const clean = await startApp();
  try {
    const cop = await clean.setupOperator();
    const me = await clean.register('mercer', { first_name: 'Mercer', last_name: 'Marine' });
    await enroll(clean, cop.token, 'G8', me.id);
    const token = (await clean.login('mercer')).body.token as string;
    const staged = await clean.call('POST', '/api/me/imports', { token, raw: exported.buffer!, headers: { 'content-type': 'application/zip', 'x-filename': 'vantage-mercer.zip' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 500));
    assert.equal(staged.body.source, 'vantage_zip');
    assert.equal(staged.body.counts.problem, 0, JSON.stringify(staged.body.rows.filter((x: { outcome: string }) => x.outcome === 'problem')));
    assert.ok(staged.body.notImported.some((n: { key: string }) => n.key === 'memberships'), JSON.stringify(staged.body.notImported));
    const done = await clean.call('POST', `/api/me/imports/${staged.body.id}/commit`, { token, body: { profile: 'fill', ...expected(staged.body) } });
    assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 500));

    const there = (table: string) => clean.ctx.db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`).all(me.id) as Array<Record<string, any>>;
    const live = (table: string) => (original.records[table] as Array<Record<string, any>>).filter((x) => !x.deleted_at && x.user_id === original.profile.id);
    for (const table of ['activities', 'awards', 'trainings', 'counselings', 'goals', 'projects', 'tasks']) assert.equal(there(table).length, live(table).length, `${table}: ${there(table).length} came back of ${live(table).length}`);
    // No record changed type, and nothing became an extra Activity.
    assert.deepEqual(there('activities').map((x) => x.title).sort(), live('activities').map((x) => x.title).sort());
    const award = there('awards').find((x) => x.name === 'Navy Commendation Medal')!;
    assert.deepEqual([award.status, award.period_start, award.date, award.submitted_at], ['submitted', '2025-01-01', '2026-06-30', '2026-07-01'], 'approval state and period');
    const mast = there('awards').find((x) => x.name === 'Meritorious Mast')!;
    assert.equal(mast.status, 'recommended');
    assert.match(mast.recommending_official, /Boletz/, 'who recommended it, by name');
    const pme = there('trainings').find((x) => x.title === 'Sergeants Course')!;
    assert.deepEqual([pme.type, pme.date, pme.end_date, pme.hours], ['pme', '2026-03-01', '2026-04-15', 240]);
    const cert = there('trainings').find((x) => x.title === 'CDFM')!;
    assert.deepEqual([cert.ongoing, cert.end_date, cert.status], [1, null, 'in_progress'], 'still going');
    const c = there('counselings')[0];
    assert.deepEqual([c.type, c.date, c.follow_up_date, c.strengths], ['quarterly', '2026-07-01', '2026-10-01', 'Accuracy']);
    assert.match(c.counselor_name, /Boletz/, 'the counselor, by name, as the file says');
    const cleared = there('activities').find((x) => x.title === 'Cleared 30 ULOs')!;
    assert.deepEqual([cleared.date, cleared.end_date, cleared.quantity, cleared.dollar_amount], ['2026-08-20', '2026-08-22', 30, 1118.38]);
    assert.match(cleared.fingerprint, /^work:import:/, 'still FM work drawn from a case, under its own mark');
    assert.equal(JSON.parse(cleared.evidence_links)[0].url, 'https://example.mil/t/1');
    const back = there('projects')[0];
    assert.equal(cleared.project_id, back.id, 'its project link comes back to the project that came back');
    assert.equal(there('tasks')[0].project_id, back.id);
    assert.deepEqual([cleared.visibility, cleared.unit_id], ['unit', 'G8'], 'shared where it was, in the unit the person serves in here');
    const files = clean.ctx.db.prepare('SELECT * FROM attachments WHERE record_id = ? AND deleted_at IS NULL').all(cleared.id) as Array<Record<string, any>>;
    assert.equal(files.length, 1, JSON.stringify(done.body.attachments));
    assert.equal(files[0].original_name, 'proof.pdf');
    assert.equal(files[0].sha256, original.attachments.find((a: { original_name: string }) => a.original_name === 'proof.pdf').sha256);
    const steps = clean.ctx.db.prepare('SELECT * FROM career_steps WHERE user_id = ?').all(me.id) as Array<Record<string, any>>;
    assert.deepEqual(steps.map((s) => [s.title, s.category, s.status, s.due_date]), [['Complete Associate degree', 'education', 'in_progress', '2027-05-01']]);
    assert.equal((clean.ctx.db.prepare('SELECT military_goal FROM career_profiles WHERE user_id = ?').get(me.id) as { military_goal: string }).military_goal, 'Make SSgt');
    assert.deepEqual({ ...clean.ctx.db.prepare('SELECT pft_score, cft_score, rifle_qual FROM readiness WHERE user_id = ?').get(me.id) as object }, { pft_score: 270, cft_score: 285, rifle_qual: 'Expert' });
    // The record page says where an imported record came from, and by whose word.
    const page = await clean.call('GET', `/api/records/counselings/${c.id}`, { token });
    assert.match(page.body.imported?.author ?? '', /Boletz/);

    // Importing the same export again adds nothing.
    const twice = await clean.call('POST', '/api/me/imports', { token, raw: exported.buffer!, headers: { 'content-type': 'application/zip', 'x-filename': 'vantage-mercer.zip' } });
    assert.equal(twice.body.counts.new, 0, JSON.stringify(twice.body.rows.filter((x: { outcome: string }) => x.outcome === 'new').map((x: { title: string; as: string }) => `${x.as}:${x.title}`)));
  } finally { await clean.close(); }
});

test('an undo puts back links and preferences, "Only me" holds for updates, a ZIP after its JSON brings the files, and a typed goal survives a spreadsheet', async () => {
  const me = await app.register('reyes');
  await enroll(app, op.token, 'G8', me.id);
  me.token = await login('reyes');

  // A spreadsheet changes a shared entry's links, brought in "only me"; the undo puts both back as they were.
  const entry = (await post(me.token, '/api/records/activities', { title: 'Audit prep', date: '2026-05-05', visibility: 'unit', unit_id: 'G8', evidence_links: [{ label: 'ticket', url: 'https://example.mil/t/9' }] })).body;
  assert.ok(entry.id, JSON.stringify(entry));
  const staged = await upload(me.token, `Vantage ID,Title,Date,Evidence Links\n${entry.id},Audit prep,2026-05-05,https://example.mil/t/10\n`, 'links.csv', 'text/csv');
  assert.equal(staged.body.rows[0].outcome, 'update', JSON.stringify(staged.body.rows[0]));
  const privately = await put(me.token, `/api/me/imports/${staged.body.id}`, { placement: 'private' });
  assert.match(privately.body.rows[0].reason, /visibility/, 'the review says it stops being shared');
  assert.equal((await commit(me.token, staged.body.id, { placement: 'private', ...expected(privately.body) })).status, 200);
  const stored = () => app.ctx.db.prepare('SELECT visibility, evidence_links FROM activities WHERE id = ?').get(entry.id) as { visibility: string; evidence_links: string };
  assert.equal(stored().visibility, 'private');
  assert.match(stored().evidence_links, /t\/10/);
  const undone = await post(me.token, `/api/me/imports/${staged.body.id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body).slice(0, 300));
  assert.deepEqual(undone.body.results.undone, { removed: 0, restored: 1, kept: 0 });
  assert.equal(stored().visibility, 'unit');
  assert.equal(JSON.parse(stored().evidence_links)[0].url, 'https://example.mil/t/9');

  // Preferences a file fills go back on undo.
  const prefs = () => String((app.ctx.db.prepare('SELECT prefs FROM users WHERE id = ?').get(me.id) as { prefs: string | null }).prefs ?? '');
  const was = prefs();
  const file = await upload(me.token, JSON.stringify({ format: 'vantage-personal/1', profile: { id: me.id, username: 'reyes', prefs: { theme: 'dark', density: 'compact' } }, records: {} }), 'prefs.json', 'application/json');
  assert.ok(file.body.profile.changes.some((c: { field: string }) => c.field === 'prefs'), JSON.stringify(file.body.profile));
  assert.equal((await commit(me.token, file.body.id, expected(file.body))).status, 200);
  assert.match(prefs(), /"theme":"dark"/);
  assert.equal((await post(me.token, `/api/me/imports/${file.body.id}/undo`)).status, 200);
  assert.equal(prefs(), was);

  // A typed goal keeps how it measures progress through a spreadsheet.
  const goal = await post(me.token, '/api/records/goals', { title: 'Fewer open discrepancies', status: 'active', visibility: 'private', period_start: '2026-01-01', period_end: '2026-12-31', metric_id: 'quantity:discrepancy', direction: 'decrease', baseline_value: 40, target_value: 10, aggregation: 'latest', filters: { category: 'Audit' }, unit_label: 'discrepancies' });
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  const sheet = await get(me.token, '/api/me/export?format=csv&sections=goals');
  assert.equal(sheet.status, 200);
  const goals = await upload(other.token, sheet.text, 'vantage-reyes-goals-2026-10-28.csv', 'text/csv');
  assert.equal(goals.body.counts.problem, 0, JSON.stringify(goals.body.rows.filter((r: { outcome: string }) => r.outcome === 'problem')));
  assert.equal((await commit(other.token, goals.body.id, expected(goals.body))).status, 200);
  const copy = rows(other.id, 'goals').find((g) => g.title === 'Fewer open discrepancies')!;
  assert.deepEqual([copy.metric_id, copy.direction, copy.baseline_value, copy.aggregation, JSON.parse(copy.filters).category], ['quantity:discrepancy', 'decrease', 40, 'latest', 'Audit']);

  // A JSON restore first, its ZIP after: the files go onto the records the JSON brought in, not into new ones.
  const award = (await post(me.token, '/api/records/awards', { name: 'Certificate of Appreciation', type: 'certificate', status: 'presented', date: '2026-04-04' })).body;
  const attached = await app.call('POST', `/api/records/awards/${award.id}/attachments`, { token: me.token, raw: Buffer.from('%PDF-1.4\n% the certificate\n%%EOF\n'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'certificate.pdf' } });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  const json = await get(me.token, '/api/me/export?format=json&sections=awards');
  const zip = await app.call('GET', '/api/me/export?format=zip&sections=awards,attachments', { token: me.token, binary: true });
  const first = await upload(other.token, JSON.stringify(json.body), 'reyes.json', 'application/json');
  assert.equal((await commit(other.token, first.body.id, expected(first.body))).status, 200);
  const restored = rows(other.id, 'awards').find((a) => a.name === 'Certificate of Appreciation')!;
  const then = await upload(other.token, zip.buffer!, 'reyes.zip', 'application/zip');
  assert.equal(then.body.counts.new, 0, 'nothing comes in twice');
  assert.equal(then.body.attachments.included, 1, JSON.stringify(then.body.attachments));
  assert.equal((await commit(other.token, then.body.id, expected(then.body))).status, 200);
  const files = app.ctx.db.prepare("SELECT original_name FROM attachments WHERE record_table = 'awards' AND record_id = ? AND deleted_at IS NULL").all(restored.id) as Array<{ original_name: string }>;
  assert.deepEqual(files.map((f) => f.original_name), ['certificate.pdf']);
});

test('a unit configuration carries its duty scoring versions, with their dates and withdrawals, into a Unit Instance that has none', async () => {
  assert.equal((await post(op.token, '/api/orgs/G8/duty-types/standard')).status, 200);
  const types = (await get(op.token, '/api/orgs/G8/configuration')).body.dutyTypes as Array<{ id: string; code: string; active: number | boolean }>;
  const [first, second] = types.filter((d) => d.active);
  assert.ok(first && second, JSON.stringify(types).slice(0, 200));
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const v1 = await post(op.token, '/api/orgs/G8/duty-scoring', { effective_from: day(2), note: 'First policy', rules: [{ duty_type_id: first.id, method: 'fixed', points: 2 }], multipliers: [], combine: 'highest' });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));
  const v2 = await post(op.token, '/api/orgs/G8/duty-scoring', { effective_from: day(9), note: 'Longer duty counts more', rules: [{ duty_type_id: first.id, method: 'fixed', points: 3 }, { duty_type_id: second.id, method: 'bands', bands: [{ from_hours: 0, points: 1 }, { from_hours: 8, points: 2 }] }], multipliers: [], combine: 'highest' });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal((await post(op.token, `/api/orgs/G8/duty-scoring/${v2.body.id}/withdraw`)).status, 200);

  const file = (await get(op.token, '/api/orgs/G8/configuration/export')).body;
  assert.deepEqual(file.scoringPolicies.map((p: { version: number; withdrawn_at: string | null }) => [p.version, Boolean(p.withdrawn_at)]), [[1, false], [2, true]]);
  assert.equal(file.scoringPolicies[1].rules[1].duty_code, second.code);

  const plan = await post(g1lead.token, '/api/orgs/G1/configuration/import', file);
  assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 300));
  assert.deepEqual(plan.body.lines.filter((l: { kind: string }) => l.kind === 'scoring_policy').map((l: { outcome: string }) => l.outcome), ['add', 'add']);
  assert.equal((await post(g1lead.token, '/api/orgs/G1/configuration/import?apply=1', file)).status, 200);
  const versions = (await get(g1lead.token, '/api/orgs/G1/configuration')).body.scoring.policies as Array<Record<string, any>>;
  assert.deepEqual(versions.map((p) => [p.version, p.effective_from, Boolean(p.withdrawn_at), p.note]).sort(), [[1, day(2), false, 'First policy'], [2, day(9), true, 'Longer duty counts more']]);
  const g1types = new Map((app.ctx.db.prepare("SELECT id, code FROM duty_types WHERE org_id = 'G1'").all() as Array<{ id: string; code: string }>).map((d) => [d.id, d.code]));
  const loaded = versions.find((p) => p.version === 2)!;
  assert.deepEqual(loaded.rules.map((x: { duty_type_id: string }) => g1types.get(x.duty_type_id)), [first.code, second.code], 'rules name G1’s own duty types, never G8’s');
  // Loaded once: an instance with its own history keeps it.
  const again = await post(g1lead.token, '/api/orgs/G1/configuration/import', file);
  assert.ok(again.body.lines.filter((l: { kind: string }) => l.kind === 'scoring_policy').every((l: { outcome: string; reason: string }) => l.outcome === 'skip' && /own scoring versions/.test(l.reason)));
});
