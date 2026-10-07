import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { addMember, moveMember, mayEnrollDirectly } from '../../server/services/org.ts';
import { scopeFor } from '../../server/authz/scope.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { instanceBoundaryTriggers, instanceBoundaryViolations, metaGet } from '../../server/db/index.ts';

/**
 * Task 2: the Unit Instance is a backend security boundary (ADR-0008). Unit A cannot read, write, export, report on
 * or link to Unit B's data, whatever identifiers are put in the request, and not even for the person who serves in
 * both: G8 is one Unit Instance, G1 another, and Reyes is enrolled in each with authority in each.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
/** G1's owner: everything in the second Unit Instance belongs to them. */
let g1lead: { token: string; id: string };
/** In both instances, leading a team in each: the path a cross-instance attempt would really take. */
let reyes: { token: string; id: string };
/** A Marine of G8 only, and one of G1 only. */
let g8marine: { token: string; id: string };
let g1marine: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;

/** Ids of records each side owns, made once so every test can try to reach across with them. */
const g8: Record<string, string> = {};
const g1: Record<string, string> = {};

before(async () => {
  app = await startApp();
  op = await app.setupOperator();

  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');

  // A team under each command, so a leader has somewhere below them in both instances.
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  assert.equal((await post(g1lead.token, '/api/org/units', { name: 'G1 Manpower', short_name: 'MANPOWER', code: 'manpower', parent_id: 'G1' })).status, 201);

  reyes = await app.register('reyes');
  await enroll(app, op.token, 'G8', reyes.id, 'sncoic');
  await enroll(app, g1lead.token, 'G1', reyes.id, 'sncoic');
  reyes.token = await login('reyes');

  g8marine = await app.register('g8marine');
  await enroll(app, op.token, 'FISCAL', g8marine.id);
  g8marine.token = await login('g8marine');

  g1marine = await app.register('g1marine');
  await enroll(app, g1lead.token, 'MANPOWER', g1marine.id);
  g1marine.token = await login('g1marine');

  const made = async (token: string, path: string, body: unknown) => {
    const res = await post(token, path, body);
    assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };

  // G8's data, shared with G8.
  g8.activity = await made(g8marine.token, '/api/records/activities', { title: 'G8 reconciled 12 ULOs', date: '2026-09-01', visibility: 'unit', unit_id: 'FISCAL' });
  g8.project = await made(op.token, '/api/records/projects', { name: 'G8 year-end close', visibility: 'unit', unit_id: 'FISCAL' });
  g8.work = await made(op.token, '/api/work/items', { title: 'G8 unliquidated obligation', unit_id: 'FISCAL', visibility: 'unit' });
  g8.contact = await made(g8marine.token, '/api/correspondence/contacts', { name: 'G8 vendor', visibility: 'unit', unit_id: 'FISCAL' });
  g8.thread = await made(g8marine.token, '/api/correspondence/threads', { subject: 'G8 invoice query', visibility: 'unit', unit_id: 'FISCAL' });

  // G1's data, shared with G1.
  g1.activity = await made(g1marine.token, '/api/records/activities', { title: 'G1 processed 40 orders', date: '2026-09-02', visibility: 'unit', unit_id: 'MANPOWER' });
  g1.project = await made(g1lead.token, '/api/records/projects', { name: 'G1 drill weekend', visibility: 'unit', unit_id: 'MANPOWER' });
  g1.work = await made(g1lead.token, '/api/work/items', { title: 'G1 pay inquiry', unit_id: 'MANPOWER', visibility: 'unit' });
  g1.contact = await made(g1marine.token, '/api/correspondence/contacts', { name: 'G1 vendor', visibility: 'unit', unit_id: 'MANPOWER' });
  g1.thread = await made(g1marine.token, '/api/correspondence/threads', { subject: 'G1 pay query', visibility: 'unit', unit_id: 'MANPOWER' });
});
after(async () => { await app.close(); });

test('a Unit A user cannot retrieve Unit B personnel', async () => {
  // The roster a G8 Marine is served names nobody from G1, and G1's own ids open nothing for them.
  const team = await get(g8marine.token, '/api/org/team');
  assert.equal(team.status, 200, JSON.stringify(team.body));
  assert.doesNotMatch(JSON.stringify(team.body), /G1marine|MANPOWER/, 'a G8 roster carries no G1 member and no G1 unit');
  assert.equal((await get(g8marine.token, `/api/org/team/${g1marine.id}`)).status, 403);
  assert.equal((await get(g8marine.token, `/api/me/readiness/${g1marine.id}`)).status, 403);
  // A platform owner holds no authority inside an instance, so neither its roster nor its directory answers them.
  assert.equal((await get(op.token, '/api/org/directory?unit_id=MANPOWER&q=g1')).status, 403);
  assert.equal((await get(op.token, `/api/org/team/${g1marine.id}`)).status, 403);
});

test('a Unit A Unit Manager cannot change Unit B', async () => {
  // Reyes manages members in G8 and in G1, which is exactly what a move across the boundary would need.
  const scope = scopeFor(app.ctx, { id: reyes.id });
  assert.throws(
    () => moveMember(app.ctx, { id: reyes.id } as never, scope, g8marine.id, 'FISCAL', 'MANPOWER'),
    /another Unit Instance/,
    'a Marine cannot be moved from one Unit Instance to another',
  );
  const moved = await post(reyes.token, `/api/org/units/FISCAL/members/${g8marine.id}/move`, { to: 'MANPOWER', entries: 'move' });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.code, 'cross_instance');
  assert.ok(app.ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(g8marine.id, 'FISCAL'), 'they are still in G8');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND unit_id = ?').get(g8marine.id, 'MANPOWER') as { n: number }).n, 0, 'and their entries did not follow');

  // Enrolling directly reaches only people led in the destination's own instance.
  assert.equal(mayEnrollDirectly(app.ctx, { id: reyes.id } as never, scope, g8marine.id, 'FISCAL'), true);
  assert.equal(mayEnrollDirectly(app.ctx, { id: reyes.id } as never, scope, g8marine.id, 'MANPOWER'), false, 'leading them in G8 is no claim on them in G1');
  const enrolled = await post(reyes.token, '/api/org/units/MANPOWER/members', { user_id: g8marine.id });
  assert.equal(enrolled.status, 403);
  assert.equal(enrolled.body.code, 'invite_required');
  const directory = await get(reyes.token, '/api/org/directory?unit_id=MANPOWER&q=g8');
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.body.results, [], 'nor are they offered in the other instance’s directory');

  // The structure of the other instance: a G8 Marine, and the platform itself, change nothing there.
  assert.equal((await put(g8marine.token, '/api/org/units/MANPOWER', { name: 'Renamed from G8' })).status, 403);
  assert.equal((await get(g8marine.token, '/api/orgs/G1/overview')).status, 404);
  assert.equal((await post(op.token, '/api/org/units', { name: 'Smuggled team', code: 'smuggled', parent_id: 'MANPOWER' })).status, 403);
  assert.equal((await post(op.token, `/api/org/units/MANPOWER/members/${g1marine.id}/move`, { to: 'G8' })).status, 403);
});

test('a primary unit in one instance is not taken by enrollment in another', () => {
  const primaryOf = (userId: string) => (app.ctx.db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ? AND is_primary = 1').get(userId) as { unit_id: string } | undefined)?.unit_id;
  const before = primaryOf(g8marine.id);
  assert.equal(before, 'FISCAL');
  addMember(app.ctx, g8marine.id, 'MANPOWER', { primary: true });
  assert.equal(primaryOf(g8marine.id), before, 'the other instance cannot claim their primary unit');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM unit_members WHERE user_id = ? AND is_primary = 1').get(g8marine.id) as { n: number }).n, 1, 'and they keep exactly one');
  app.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(g8marine.id, 'MANPOWER');
  app.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(g8marine.id, 'MANPOWER');
});

test('IDs cannot be manipulated to cross boundaries', async () => {
  // Real ids from G1, put straight into a G8 Marine's requests. Reading, writing and deleting are all refused.
  for (const path of [
    `/api/records/activities/${g1.activity}`,
    `/api/records/projects/${g1.project}`,
    `/api/work/items/${g1.work}`,
    `/api/correspondence/threads/${g1.thread}`,
    `/api/correspondence/contacts`,
  ]) {
    const res = await get(g8marine.token, path);
    if (path.endsWith('contacts')) { assert.doesNotMatch(JSON.stringify(res.body), /G1 vendor/, 'G1’s contacts are not listed in G8'); continue; }
    assert.ok([403, 404].includes(res.status), `${path} is not readable from the other instance (got ${res.status})`);
  }
  assert.equal((await put(g8marine.token, `/api/records/activities/${g1.activity}`, { title: 'Rewritten from G8' })).status, 403);
  assert.ok([403, 404].includes((await post(g8marine.token, `/api/records/activities/${g1.activity}/comments`, { body: 'From G8' })).status));
  assert.ok([403, 404].includes((await get(g8marine.token, `/api/records/activities/${g1.activity}/attachments`)).status));
  assert.equal((await del(g8marine.token, `/api/records/activities/${g1.activity}`)).status, 403);
  assert.ok([403, 404].includes((await post(g8marine.token, `/api/work/items/${g1.work}/claim`)).status), 'nor is G1’s work claimable from G8');

  // A cross-instance reference by id, tried by the one person who holds authority on both sides: an entry here filed
  // under a project there, and work here on a project there.
  const filed = await post(reyes.token, '/api/records/activities', { title: 'Filed across', date: '2026-09-03', visibility: 'unit', unit_id: 'G8', project_id: g1.project });
  assert.ok([400, 403].includes(filed.status), `a project from the other instance is refused (got ${filed.status})`);
  const work = await post(reyes.token, '/api/work/items', { title: 'Work across', unit_id: 'G8', visibility: 'unit', project_id: g1.project });
  assert.ok([400, 403].includes(work.status), `so is work filed under it (got ${work.status})`);
  const task = await post(reyes.token, '/api/records/tasks', { title: 'Task across', visibility: 'unit', unit_id: 'G8', project_id: g1.project });
  assert.ok([400, 403].includes(task.status), `and a task under it (got ${task.status})`);
});

test('nobody else’s record can be moved into another Unit Instance', async () => {
  // Reyes may correct a G8 Marine's shared entry as a record manager, and holds sharing rights in G1 as well. A record
  // manager never changes where another Marine's entry is shared, in one instance or across two.
  const across = await put(reyes.token, `/api/records/activities/${g8.activity}`, { unit_id: 'MANPOWER', visibility: 'unit' });
  assert.equal(across.status, 403, JSON.stringify(across.body));
  assert.equal(across.body.code, 'scope_owner_only');
  const row = app.ctx.db.prepare('SELECT unit_id FROM activities WHERE id = ?').get(g8.activity) as { unit_id: string };
  assert.equal(row.unit_id, 'FISCAL', 'the entry stayed where its author put it');

  // A counselor may re-place a counseling they wrote, but not into another Unit Instance: that refusal is the boundary's.
  const counseling = await post(reyes.token, '/api/records/counselings', { user_id: g8marine.id, date: '2026-09-06', type: 'quarterly', summary: 'Quarterly counseling in G8.', unit_id: 'FISCAL', visibility: 'unit' });
  assert.equal(counseling.status, 201, JSON.stringify(counseling.body));
  const moved = await put(reyes.token, `/api/records/counselings/${counseling.body.id}`, { unit_id: 'MANPOWER', visibility: 'unit' });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.code, 'cross_instance');
  assert.equal((app.ctx.db.prepare('SELECT unit_id FROM counselings WHERE id = ?').get(counseling.body.id) as { unit_id: string }).unit_id, 'FISCAL');

  // And a G8 Marine cannot place their own entry in a G1 unit at all: they hold nothing there.
  assert.equal((await put(g8marine.token, `/api/records/activities/${g8.activity}`, { unit_id: 'MANPOWER', visibility: 'unit' })).status, 403);
});

test('a Unit A report cannot contain Unit B records', async () => {
  const report = await get(reyes.token, `/api/reports?user_id=${g8marine.id}&unit_id=FISCAL&period=all`);
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.doesNotMatch(JSON.stringify(report.body), /G1 processed 40 orders/, 'a G8 report carries no G1 entry');
  // A G8 Marine's report cannot be drawn against a G1 unit, and the G1 Marine is not theirs to report on.
  assert.equal((await get(reyes.token, `/api/reports?user_id=${g8marine.id}&unit_id=MANPOWER&period=all`)).status, 403);
  assert.equal((await get(g8marine.token, `/api/reports?user_id=${g1marine.id}&unit_id=MANPOWER&period=all`)).status, 403);
  assert.equal((await get(g8marine.token, '/api/metrics?unit_id=MANPOWER&period=all')).status, 403);
  assert.equal((await get(g8marine.token, '/api/org/units/MANPOWER/dashboard')).status, 403);

  // The dashboards and metrics each instance does serve carry only its own entries.
  const dash = await get(op.token, '/api/org/units/G8/dashboard');
  assert.equal(dash.status, 200, JSON.stringify(dash.body));
  assert.doesNotMatch(JSON.stringify(dash.body), /G1 processed 40 orders|G1 pay inquiry/, 'a G8 dashboard counts nothing from G1');
  const metrics = await get(g1lead.token, '/api/metrics?unit_id=MANPOWER&period=all');
  assert.equal(metrics.status, 200);
  assert.doesNotMatch(JSON.stringify(metrics.body), /G8 reconciled 12 ULOs/);
});

test('a Unit A export cannot contain Unit B data', async () => {
  const csv = await get(reyes.token, `/api/reports/csv?user_id=${g8marine.id}&unit_id=FISCAL&period=all`);
  assert.equal(csv.status, 200, csv.text.slice(0, 200));
  assert.match(csv.text, /G8 reconciled 12 ULOs/);
  assert.doesNotMatch(csv.text, /G1 processed 40 orders/, 'a G8 export carries no G1 entry');
  assert.equal((await get(g8marine.token, `/api/reports/csv?user_id=${g1marine.id}&unit_id=MANPOWER&period=all`)).status, 403);
  assert.equal((await get(reyes.token, `/api/reports/csv?user_id=${g8marine.id}&unit_id=MANPOWER&period=all`)).status, 403);

  const unitExport = await get(op.token, '/api/org/units/G8/export');
  assert.equal(unitExport.status, 200);
  const text = JSON.stringify(unitExport.body);
  assert.match(text, /G8 reconciled 12 ULOs/);
  assert.doesNotMatch(text, /G1 processed 40 orders|G1 drill weekend|G1 pay inquiry/, 'a Unit Instance exports only itself');
  assert.equal((await get(op.token, '/api/org/units/MANPOWER/export')).status, 403);
});

test('file downloads enforce record and unit authorization', async () => {
  app.ctx.runtime.attachmentsEnabled = true;
  const upload = await app.call('POST', `/api/records/activities/${g1.activity}/attachments`, {
    token: g1marine.token, raw: Buffer.from('G1 supporting document'), headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'g1-evidence.txt' },
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const attachmentId = (upload.body.attachment?.id ?? upload.body.id) as string;

  // The file is reached through its record, so a Marine of the other instance cannot list it or fetch it by id.
  for (const token of [g8marine.token]) {
    assert.ok([403, 404].includes((await get(token, `/api/records/activities/${g1.activity}/attachments`)).status));
    assert.ok([403, 404].includes((await get(token, `/api/records/activities/${g1.activity}/attachments/${attachmentId}`)).status));
    // Nor by hanging the other instance's attachment id off a record of their own.
    assert.ok([403, 404].includes((await get(token, `/api/records/activities/${g8.activity}/attachments/${attachmentId}`)).status));
  }
  const own = await app.call('GET', `/api/records/activities/${g1.activity}/attachments/${attachmentId}`, { token: g1marine.token, binary: true });
  assert.equal(own.status, 200, 'its own instance still downloads it');
});

test('an import cannot inject records into another Unit Instance', async () => {
  // A shared upload belongs to the unit it was shared with: it cannot be imported into the other instance.
  const uploaded = await app.call('POST', '/api/work/sources', {
    token: g1marine.token, raw: Buffer.from('document,amount\nG1-1,100\n'),
    headers: { 'content-type': 'text/csv', 'x-filename': 'g1.csv', 'x-visibility': 'unit', 'x-unit-id': 'MANPOWER' },
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  const sourceId = (uploaded.body.source?.id ?? uploaded.body.id) as string;

  // Reyes can read the sheet through G1 and import into G8, so only the boundary stands between the two.
  const plan = { source_file_id: sourceId, sheet_name: 'g1.csv', header_row: 1, mapping: { document: 'title' }, key_columns: ['document'], unit_id: 'G8', visibility: 'unit' };
  const preview = await post(reyes.token, '/api/work/imports/preview', plan);
  assert.equal(preview.status, 403, JSON.stringify(preview.body));
  assert.equal(preview.body.code, 'cross_instance');
  const run = await post(reyes.token, '/api/work/imports', plan);
  assert.equal(run.status, 403, JSON.stringify(run.body));
  assert.equal(run.body.code, 'cross_instance');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_items WHERE unit_id = ? AND title = ?').get('G8', 'G1-1') as { n: number }).n, 0);
  const home = await post(reyes.token, '/api/work/imports/preview', { ...plan, unit_id: 'G1' });
  assert.equal(home.status, 200, `the same plan imports into the sheet’s own instance: ${JSON.stringify(home.body)}`);

  // An activity import names its own unit, and a unit of the other instance is refused.
  const activityImport = await post(g8marine.token, '/api/records/activities/import', { rows: [{ title: 'Imported across', date: '2026-09-04', visibility: 'unit', unit_id: 'MANPOWER' }] });
  assert.equal(activityImport.status, 403, JSON.stringify(activityImport.body));
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE title = ?').get('Imported across') as { n: number }).n, 0);
});

test('correspondence and work cannot be linked across Unit Instances', async () => {
  // Everything here is Reyes's own or open to Reyes, on one side or the other, so the boundary is all that refuses it.
  const made = async (path: string, body: unknown) => {
    const res = await post(reyes.token, path, body);
    assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const thread = await made('/api/correspondence/threads', { subject: 'Reyes G8 query', visibility: 'unit', unit_id: 'G8' });
  const work = await made('/api/work/items', { title: 'Reyes G1 follow-up', unit_id: 'G1', visibility: 'unit' });
  const contact = await made('/api/correspondence/contacts', { name: 'Reyes G1 vendor', visibility: 'unit', unit_id: 'G1' });

  // The service refuses each one itself, before the engine would (whose refusal reads "would join records").
  const linked = await post(reyes.token, `/api/correspondence/threads/${thread}/links`, { work_item_id: work });
  assert.equal(linked.status, 403, JSON.stringify(linked.body));
  assert.equal(linked.body.code, 'cross_instance');
  assert.match(linked.body.error, /That work belongs to another Unit Instance/);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM thread_links WHERE thread_id = ?').get(thread) as { n: number }).n, 0);

  // A thread here cannot name a contact there.
  const named = await post(reyes.token, '/api/correspondence/threads', { subject: 'Across', visibility: 'unit', unit_id: 'G8', contact_id: contact });
  assert.equal(named.status, 403, JSON.stringify(named.body));
  assert.equal(named.body.code, 'cross_instance');
  assert.match(named.body.error, /That contact belongs to another Unit Instance/);
  // And a leader in both instances cannot move a G8 Marine's shared contact into G1, where only its author could take it.
  const moved = await put(reyes.token, `/api/correspondence/contacts/${g8.contact}`, { name: 'G8 vendor', visibility: 'unit', unit_id: 'G1' });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.code, 'cross_instance');
  assert.equal((app.ctx.db.prepare('SELECT unit_id FROM contacts WHERE id = ?').get(g8.contact) as { unit_id: string }).unit_id, 'FISCAL');

  // A link written straight into the database is refused by the engine itself.
  assert.throws(
    () => app.ctx.db.prepare('INSERT INTO thread_links (id, thread_id, work_item_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('forced-link', g8.thread, g1.work, reyes.id, new Date().toISOString()),
    /cross_instance: correspondence and work in different Unit Instances/,
    'the database refuses a cross-instance link',
  );
});

test('a report draft cannot cite records from another Unit Instance', async () => {
  // Reyes writes a G8 report about themselves, then tries to cite a G1 entry of their own.
  const mine = await post(reyes.token, '/api/records/activities', { title: 'Reyes worked G1 manpower', date: '2026-09-05', visibility: 'unit', unit_id: 'G1' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const draft = await post(reyes.token, '/api/studio/reports', { title: 'G8 input', period_start: '2026-07-01', period_end: '2026-09-30', unit_id: 'G8', visibility: 'unit', subject_id: reyes.id });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));

  const opened = await get(reyes.token, `/api/studio/reports/${draft.body.id}`);
  assert.equal(opened.status, 200);
  assert.doesNotMatch(JSON.stringify(opened.body.sources), /Reyes worked G1 manpower/, 'a G8 report is not offered a G1 entry');

  const saved = await post(reyes.token, `/api/studio/reports/${draft.body.id}/revisions`, {
    sections: [{ heading: 'Performance', body: 'Carried G1 work into a G8 report.' }],
    sources: [{ table: 'activities', id: mine.body.id, version: 1 }],
  });
  assert.equal(saved.status, 403, JSON.stringify(saved.body));
  assert.equal(saved.body.code, 'cross_instance');
});

test('audit events cannot be silently rewritten, and an instance reads only its own trail', async () => {
  const chain = await get(op.token, '/api/platform/integrity');
  assert.equal(chain.status, 200);
  assert.equal(chain.body.audit.ok, true, JSON.stringify(chain.body.audit));

  const trail = await get(g1lead.token, '/api/orgs/G1/audit');
  assert.equal(trail.status, 200, JSON.stringify(trail.body));
  const units = new Set((trail.body.rows as Array<{ unit_id: string | null }>).map((e) => e.unit_id).filter(Boolean));
  for (const unit of units) assert.ok(['G1', 'MANPOWER'].includes(unit as string), `G1’s trail holds only its own units, found ${unit}`);
  assert.equal((await get(g1lead.token, '/api/orgs/G8/audit')).status, 404, 'and never another instance’s');

  // An entry edited in place breaks the chain, which is what "cannot be silently rewritten" means.
  const target = app.ctx.db.prepare("SELECT id FROM audit_log WHERE action = 'create' ORDER BY seq LIMIT 1").get() as { id: string };
  app.ctx.db.prepare("UPDATE audit_log SET detail = 'rewritten' WHERE id = ?").run(target.id);
  const after = await get(op.token, '/api/platform/integrity');
  assert.equal(after.body.audit.ok, false, 'the chain reports the rewrite');
  assert.match(String(after.body.audit.reason), new RegExp(target.id));
});

test('the database keeps the boundary when code is bypassed', () => {
  // The second line of defence (ADR-0008): statements that cross the boundary are refused by the engine itself.
  assert.throws(() => app.ctx.db.prepare('UPDATE units SET org_id = ? WHERE id = ?').run('G1', 'FISCAL'), /cross_instance: a unit cannot change Unit Instance/);
  assert.throws(() => app.ctx.db.prepare('UPDATE units SET parent_id = ? WHERE id = ?').run('MANPOWER', 'FISCAL'), /another organization/); // units_stay_in_org, from migration 015
  assert.throws(() => app.ctx.db.prepare('UPDATE activities SET project_id = ? WHERE id = ?').run(g1.project, g8.activity), /cross_instance: a project in another Unit Instance/);
  assert.throws(() => app.ctx.db.prepare('UPDATE work_items SET project_id = ? WHERE id = ?').run(g1.project, g8.work), /cross_instance: a project in another Unit Instance/);
  assert.throws(() => app.ctx.db.prepare('UPDATE threads SET contact_id = ? WHERE id = ?').run(g1.contact, g8.thread), /cross_instance: a contact in another Unit Instance/);
  assert.equal((app.ctx.db.prepare('SELECT org_id FROM units WHERE id = ?').get('FISCAL') as { org_id: string }).org_id, 'G8');
});

// ——— Ways across that the code and security reviews of this task found, each closed and proved here. ———

/** A Marine serving in both instances, made when a test first needs one. */
let dual: { token: string; id: string } | undefined;
async function dualMarine() {
  if (dual) return dual;
  const made = await app.register('dual');
  await enroll(app, op.token, 'FISCAL', made.id);
  await enroll(app, g1lead.token, 'MANPOWER', made.id);
  made.token = await login('dual');
  dual = made;
  return made;
}

test('a project cannot move out from under work filed in another Unit Instance, in one step or two', async () => {
  const project = await post(reyes.token, '/api/records/projects', { name: 'Reyes shared close-out', visibility: 'unit', unit_id: 'G8' });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const path = `/api/records/projects/${project.body.id}`;
  const filed = await post(op.token, '/api/records/activities', { title: 'G8 entry under the close-out', date: '2026-09-07', visibility: 'unit', unit_id: 'G8', project_id: project.body.id });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));

  const across = await put(reyes.token, path, { unit_id: 'G1', visibility: 'unit' });
  assert.equal(across.status, 403, JSON.stringify(across.body));
  assert.equal(across.body.code, 'cross_instance', JSON.stringify(across.body));
  // Through no unit is no way round: out of every unit is the owner's call, into G1 afterwards still is not.
  assert.equal((await put(reyes.token, path, { unit_id: null, visibility: 'private' })).status, 200);
  assert.equal((await put(reyes.token, path, { unit_id: 'G1', visibility: 'unit' })).status, 403);
  assert.equal((await put(reyes.token, path, { unit_id: 'G8', visibility: 'unit' })).status, 200, 'back where its work is, it goes');
  assert.throws(() => app.ctx.db.prepare('UPDATE projects SET unit_id = ? WHERE id = ?').run('G1', project.body.id), /cross_instance: work in another Unit Instance is filed under this project/);

  // Unplaced work counts too: it is its owner's, and G8's owner serves in no unit of G1.
  const tracker = await post(reyes.token, '/api/records/projects', { name: 'Reyes G8 tracker', visibility: 'unit', unit_id: 'G8' });
  assert.equal(tracker.status, 201, JSON.stringify(tracker.body));
  const unplaced = await post(op.token, '/api/work/items', { title: 'Op private follow-up', visibility: 'private', project_id: tracker.body.id });
  assert.equal(unplaced.status, 201, JSON.stringify(unplaced.body));
  assert.equal(unplaced.body.unit_id ?? unplaced.body.item?.unit_id ?? null, null);
  const away = await put(reyes.token, `/api/records/projects/${tracker.body.id}`, { unit_id: 'G1', visibility: 'unit' });
  assert.equal(away.status, 403, JSON.stringify(away.body));
  assert.equal(away.body.code, 'cross_instance');
  // Had it got there some other way, the link would still not show a project its holder can no longer read.
  app.ctx.db.prepare('UPDATE projects SET unit_id = ? WHERE id = ?').run('G1', tracker.body.id);
  try {
    const detail = await get(op.token, `/api/work/items/${unplaced.body.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.project, null);
    const listed = await get(op.token, '/api/work/items');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const item = (listed.body.items as Array<{ id: string; project_name: string | null }>).find((i) => i.id === unplaced.body.id);
    assert.ok(item, 'their own work is still listed');
    assert.equal(item.project_name, null);
  } finally {
    app.ctx.db.prepare('UPDATE projects SET unit_id = ? WHERE id = ?').run('G8', tracker.body.id);
  }
  assert.equal((await get(op.token, `/api/work/items/${unplaced.body.id}`)).body.project?.name, 'Reyes G8 tracker', 'back where they read it, it is named');

  // A contact stays where the correspondence that names it is, even when its own author moves it.
  const contact = await post(reyes.token, '/api/correspondence/contacts', { name: 'Reyes vendor', visibility: 'unit', unit_id: 'G8' });
  assert.equal(contact.status, 201, JSON.stringify(contact.body));
  const thread = await post(reyes.token, '/api/correspondence/threads', { subject: 'Vendor follow-up', visibility: 'unit', unit_id: 'G8', contact_id: contact.body.id });
  assert.equal(thread.status, 201, JSON.stringify(thread.body));
  const moved = await put(reyes.token, `/api/correspondence/contacts/${contact.body.id}`, { name: 'Reyes vendor', visibility: 'unit', unit_id: 'G1' });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.code, 'cross_instance');
});

test('a counselor cannot carry a counseling across by taking it out of every unit first', async () => {
  const counseling = await post(reyes.token, '/api/records/counselings', { user_id: g8marine.id, date: '2026-09-07', type: 'quarterly', summary: 'Second quarterly counseling in G8.', unit_id: 'FISCAL', visibility: 'unit' });
  assert.equal(counseling.status, 201, JSON.stringify(counseling.body));
  const path = `/api/records/counselings/${counseling.body.id}`;
  const out = await put(reyes.token, path, { unit_id: null, visibility: 'private' });
  assert.equal(out.status, 403, JSON.stringify(out.body));
  assert.equal(out.body.code, 'scope_owner_only');
  assert.equal((await put(reyes.token, path, { unit_id: 'MANPOWER', visibility: 'unit' })).status, 403);
  assert.equal((app.ctx.db.prepare('SELECT unit_id FROM counselings WHERE id = ?').get(counseling.body.id) as { unit_id: string }).unit_id, 'FISCAL');
  // Inside the instance it was written in, the counselor still re-places it.
  assert.equal((await put(reyes.token, path, { unit_id: 'G8', visibility: 'unit' })).status, 200);
});

test('an owner moving their own record across carries no one else’s comments, and both trails record the move', async () => {
  const commented = await post(reyes.token, '/api/records/activities', { title: 'Reyes reviewed the G8 close-out', date: '2026-09-08', visibility: 'unit', unit_id: 'G8' });
  assert.equal(commented.status, 201, JSON.stringify(commented.body));
  const path = `/api/records/activities/${commented.body.id}`;
  const note = await post(op.token, `${path}/comments`, { body: 'G8 commander note on the close-out.' });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const across = await put(reyes.token, path, { unit_id: 'G1', visibility: 'unit' });
  assert.equal(across.status, 403, JSON.stringify(across.body));
  assert.equal(across.body.code, 'cross_instance');
  // Re-importing the entry by its id is the same move, and is refused the same way.
  const reimport = () => post(reyes.token, '/api/records/activities/import', { rows: [{ id: commented.body.id, title: 'Reyes reviewed the G8 close-out', date: '2026-09-08', visibility: 'unit', unit_id: 'G1' }] });
  const imported = await reimport();
  assert.equal(imported.status, 403, JSON.stringify(imported.body));
  assert.equal(imported.body.code, 'cross_instance');
  assert.equal((await put(reyes.token, path, { unit_id: null, visibility: 'private' })).status, 200, 'their own record may leave every unit');
  assert.equal((await put(reyes.token, path, { unit_id: 'G1', visibility: 'unit' })).status, 403, 'but the G8 comment still cannot follow it into G1');
  assert.equal((await reimport()).status, 403, 'by import either');
  assert.equal((app.ctx.db.prepare('SELECT unit_id FROM activities WHERE id = ?').get(commented.body.id) as { unit_id: string | null }).unit_id, null);
  assert.doesNotMatch(JSON.stringify((await get(g1lead.token, `${path}/comments`)).body), /commander note/);

  // With nothing of anyone else's on it, their own record goes, and each trail says so without naming the other side.
  const plain = await post(reyes.token, '/api/records/activities', { title: 'Reyes drafted a G8 memo', date: '2026-09-08', visibility: 'unit', unit_id: 'G8' });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  assert.equal((await put(reyes.token, `/api/records/activities/${plain.body.id}`, { unit_id: 'G1', visibility: 'unit' })).status, 200);
  const trail = app.ctx.db.prepare("SELECT org_id, detail FROM audit_log WHERE entity_id = ? AND action = 'edit' ORDER BY seq").all(plain.body.id) as Array<{ org_id: string; detail: string }>;
  assert.deepEqual(trail.map((t) => [t.org_id, t.detail]), [['G1', 'author edit; moved in from another Unit Instance'], ['G8', 'author edit; moved out to another Unit Instance']]);

  // Moved by import, it is written in both trails the same way.
  const logged = await post(reyes.token, '/api/records/activities', { title: 'Reyes logged a G8 review', date: '2026-09-08', visibility: 'unit', unit_id: 'G8' });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
  const viaImport = await post(reyes.token, '/api/records/activities/import', { rows: [{ id: logged.body.id, title: 'Reyes logged a G8 review', date: '2026-09-08', visibility: 'unit', unit_id: 'G1' }] });
  assert.equal(viaImport.status, 200, JSON.stringify(viaImport.body));
  assert.equal(viaImport.body.updated, 1);
  const imported2 = app.ctx.db.prepare("SELECT org_id, detail FROM audit_log WHERE entity_id = ? AND action = 'edit' ORDER BY seq").all(logged.body.id) as Array<{ org_id: string; detail: string }>;
  assert.deepEqual(imported2.map((t) => [t.org_id, t.detail]), [['G1', 'import; moved in from another Unit Instance'], ['G8', 'import; moved out to another Unit Instance']]);
});

test('a file goes only where it was added, whoever added it and wherever they serve now', async () => {
  app.ctx.runtime.attachmentsEnabled = true;
  const d = await dualMarine();
  const entry = await post(d.token, '/api/records/activities', { title: 'Dual balanced the G8 ULO ledger', date: '2026-09-10', visibility: 'unit', unit_id: 'FISCAL' });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const path = `/api/records/activities/${entry.body.id}`;
  const attach = (token: string, name: string, text: string) => app.call('POST', `${path}/attachments`, {
    token, raw: Buffer.from(text), headers: { 'content-type': 'text/plain', 'x-vantage-filename': name },
  });

  // Reyes serves in G1 as well, so where Reyes serves says nothing about where this file was added: in G8.
  const ledger = await attach(reyes.token, 'g8-ledger.txt', 'G8 ONLY: ledger of unliquidated obligations');
  assert.equal(ledger.status, 201, JSON.stringify(ledger.body));
  // A leader who added evidence here and has since left every unit.
  const pcs = await app.register('pcs');
  await enroll(app, op.token, 'FISCAL', pcs.id, 'sncoic');
  const evidence = await attach((await login('pcs')), 'g8-evidence.txt', 'G8 evidence from a leader who has since left');
  assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
  assert.equal((await del(op.token, `/api/org/units/FISCAL/members/${pcs.id}`)).status, 200);

  const across = await put(d.token, path, { unit_id: 'MANPOWER', visibility: 'unit' });
  assert.equal(across.status, 403, JSON.stringify(across.body));
  assert.equal(across.body.code, 'cross_instance');
  assert.equal((await put(d.token, path, { unit_id: null, visibility: 'private' })).status, 200);
  const twoSteps = await put(d.token, path, { unit_id: 'MANPOWER', visibility: 'unit' });
  assert.equal(twoSteps.status, 403, JSON.stringify(twoSteps.body));
  assert.equal(twoSteps.body.code, 'cross_instance');
  // Back in the instance both files were added in, it goes: the leader who left is not taken for one from elsewhere.
  const home = await put(d.token, path, { unit_id: 'FISCAL', visibility: 'unit' });
  assert.equal(home.status, 200, JSON.stringify(home.body));

  // With one Unit Instance, a record in no unit came from nowhere else, even with a file that predates where files say.
  const single = await startApp();
  try {
    const owner = await single.setupOperator();
    assert.equal((await single.call('POST', '/api/org/units', { token: owner.token, body: { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' } })).status, 201);
    const marine = await single.register('marine');
    await enroll(single, owner.token, 'FISCAL', marine.id);
    const lead = await single.register('lead');
    await enroll(single, owner.token, 'FISCAL', lead.id, 'sncoic');
    single.ctx.runtime.attachmentsEnabled = true;
    const made = await single.call('POST', '/api/records/activities', { token: marine.token, body: { title: 'Shared, then private', date: '2026-09-10', visibility: 'unit', unit_id: 'FISCAL' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const at = `/api/records/activities/${made.body.id}`;
    const leadToken = (await single.login('lead')).body.token as string;
    assert.equal((await single.call('POST', `${at}/attachments`, { token: leadToken, raw: Buffer.from('evidence'), headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'e.txt' } })).status, 201);
    single.ctx.db.prepare('UPDATE attachments SET unit_id = NULL WHERE record_id = ?').run(made.body.id);
    assert.equal((await single.call('DELETE', `/api/org/units/FISCAL/members/${lead.id}`, { token: owner.token })).status, 200);
    assert.equal((await single.call('PUT', at, { token: marine.token, body: { unit_id: null, visibility: 'private' } })).status, 200);
    const back = await single.call('PUT', at, { token: marine.token, body: { unit_id: 'FISCAL', visibility: 'unit' } });
    assert.equal(back.status, 200, JSON.stringify(back.body));
  } finally { await single.close(); }
});

test('a report about another Marine speaks for one Unit Instance, and its target falls back only inside one', async () => {
  const d = await dualMarine();
  const inG8 = await post(d.token, '/api/records/activities', { title: 'Dual balanced the G8 ledger', date: '2026-09-09', visibility: 'unit', unit_id: 'FISCAL' });
  const inG1 = await post(d.token, '/api/records/activities', { title: 'Dual audited G1 orders', date: '2026-09-09', visibility: 'unit', unit_id: 'MANPOWER' });
  assert.equal(inG8.status, 201, JSON.stringify(inG8.body));
  assert.equal(inG1.status, 201, JSON.stringify(inG1.body));

  // Placed in no unit, a report on Dual still cannot join what G8 and G1 each hold on them.
  const draft = await post(reyes.token, '/api/studio/reports', { title: 'Dual, both commands', period_start: '2026-07-01', period_end: '2026-09-30', subject_id: d.id });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const save = (ids: string[]) => post(reyes.token, `/api/studio/reports/${draft.body.id}/revisions`, {
    sections: [{ heading: 'Performance', body: 'Their work.' }],
    sources: ids.map((id) => ({ table: 'activities', id, version: 1 })),
  });
  const both = await save([inG8.body.id, inG1.body.id]);
  assert.equal(both.status, 403, JSON.stringify(both.body));
  assert.equal(both.body.code, 'cross_instance');
  assert.ok([200, 201].includes((await save([inG1.body.id])).status), 'one instance’s records make a report');

  // Asked for against G1, a report on Dual falls back to the G1 team Reyes leads them in: not G8's figures, not a refusal.
  const fallback = await get(reyes.token, `/api/reports?user_id=${d.id}&unit_id=G1&period=all`);
  assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
  assert.doesNotMatch(JSON.stringify(fallback.body), /Dual balanced the G8 ledger/);
  // G8's owner leads Dual only in G8, so a G1 unit is refused rather than answered with G8's figures.
  const refused = await get(op.token, `/api/reports?user_id=${d.id}&unit_id=MANPOWER&period=all`);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'cross_instance');
});

test('a leader in one Unit Instance is not told where else a Marine serves', async () => {
  const d = await dualMarine();
  const seen = await get(op.token, `/api/org/team/${d.id}`);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.doesNotMatch(JSON.stringify(seen.body), /MANPOWER|G1 Manpower/);

  // Dual's primary unit sits in G1. G8's owner cannot take it, and the refusal does not say where it is.
  const primaryOf = () => (app.ctx.db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ? AND is_primary = 1').get(d.id) as { unit_id: string }).unit_id;
  const home = primaryOf();
  app.ctx.db.prepare('UPDATE unit_members SET is_primary = CASE WHEN unit_id = ? THEN 1 ELSE 0 END WHERE user_id = ?').run('MANPOWER', d.id);
  try {
    const taken = await put(op.token, `/api/org/units/FISCAL/members/${d.id}`, { primary: true });
    assert.equal(taken.status, 403, JSON.stringify(taken.body));
    assert.notEqual(taken.body.code, 'cross_instance');
    assert.doesNotMatch(JSON.stringify(taken.body), /Unit Instance|MANPOWER|G1/);
    assert.equal(primaryOf(), 'MANPOWER');
  } finally {
    app.ctx.db.prepare('UPDATE unit_members SET is_primary = CASE WHEN unit_id = ? THEN 1 ELSE 0 END WHERE user_id = ?').run(home, d.id);
  }

  // Nor does a move say whether two units belong together to someone who manages neither of them.
  assert.throws(
    () => moveMember(app.ctx, { id: g8marine.id } as never, scopeFor(app.ctx, { id: g8marine.id }), g1marine.id, 'FISCAL', 'MANPOWER'),
    (error: { code?: string }) => error.code === 'forbidden',
  );
});

test('an archive restores as its instance was kept: crossings in it are counted, and the boundary holds from then on', async () => {
  type Archive = { tables: Record<string, Array<Record<string, unknown>>> };
  // A task is restored after the project it names, and an activity before it, so the engine alone would see only one.
  const task = await post(op.token, '/api/records/tasks', { title: 'G8 task in the archive', visibility: 'unit', unit_id: 'G8' });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  app.ctx.runtime.attachmentsEnabled = true;
  const file = await app.call('POST', `/api/records/activities/${g8.activity}/attachments`, {
    token: g8marine.token, raw: Buffer.from('G8 receipt'), headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'g8-receipt.txt' },
  });
  assert.equal(file.status, 201, JSON.stringify(file.body));
  const archive = JSON.parse(JSON.stringify(exportInstance(app.ctx))) as Archive;
  const restore = async (a: Archive, check: (db: TestApp['ctx']['db']) => void) => {
    const fresh = await startApp();
    try {
      const freshOp = await fresh.setupOperator();
      const counts = importInstance(fresh.ctx, a as never, freshOp.id);
      assert.ok(counts.activities > 0 && counts.projects > 0, JSON.stringify(counts));
      check(fresh.ctx.db);
    } finally { await fresh.close(); }
  };
  const crossingsOf = (db: TestApp['ctx']['db']) => (JSON.parse(metaGet(db, 'instance_boundary_violations') ?? '{}') as { found?: Record<string, number> }).found;
  const holds = (db: TestApp['ctx']['db']) => assert.throws(
    () => db.prepare('UPDATE work_items SET project_id = ? WHERE id = ?').run(g1.project, g8.work),
    /cross_instance: a project in another Unit Instance/, 'the boundary is kept from the moment the archive is in',
  );

  const crossed = structuredClone(archive);
  crossed.tables.activities.find((a) => a.id === g8.activity)!.project_id = g1.project;
  crossed.tables.tasks.find((t) => t.id === task.body.id)!.project_id = g1.project;
  await restore(crossed, (db) => {
    assert.deepEqual(crossingsOf(db), { activities_project: 1, tasks_project: 1 }, 'what it brought across is counted');
    assert.equal((db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task.body.id) as { project_id: string }).project_id, g1.project, 'and kept, not lost');
    const entry = db.prepare("SELECT detail FROM audit_log WHERE action = 'instance_import'").get() as { detail: string };
    assert.match(entry.detail, /joined across Unit Instances: \{"activities_project":1,"tasks_project":1\}/);
    holds(db);
  });

  // An archive from before organizations: none in it, child units listed before their parents, and files that do not say
  // where they were added. G8 and G1 are both top units in it, so they found two instances on the way in.
  const legacy = structuredClone(crossed);
  for (const table of ['organizations', 'org_roles', 'platform_roles', 'access_grants']) delete legacy.tables[table];
  legacy.tables.units = legacy.tables.units.map((u): Record<string, unknown> => ({ ...u, org_id: null })).sort((a, b) => Number(!a.parent_id) - Number(!b.parent_id));
  legacy.tables.attachments = legacy.tables.attachments.map(({ unit_id: _unit, ...rest }) => rest);
  await restore(legacy, (db) => {
    assert.deepEqual(db.prepare('SELECT id FROM organizations ORDER BY id').all().map((o) => (o as { id: string }).id), ['G1', 'G8']);
    assert.deepEqual(crossingsOf(db), { activities_project: 1, tasks_project: 1 });
    const unplaced = db.prepare('SELECT COUNT(*) AS n FROM attachments f JOIN activities r ON r.id = f.record_id WHERE f.unit_id IS NOT r.unit_id').get() as { n: number };
    assert.equal(unplaced.n, 0, 'each file takes the unit its record sits in');
    holds(db);
  });

  // With nothing across, nothing is counted.
  await restore(archive, (db) => {
    assert.equal(metaGet(db, 'instance_boundary_violations'), null);
    holds(db);
  });
});

test('a crossing made before the boundary was kept is counted, can still be edited, and the engine’s refusal reads as one', async () => {
  // Made the way a database from before migration 016 could hold it: with the triggers out of the way.
  const task = await post(op.token, '/api/records/tasks', { title: 'G8 task filed before 016', visibility: 'unit', unit_id: 'G8' });
  assert.equal(task.status, 201, JSON.stringify(task.body));
  for (const trigger of ['tasks_project_same_org_insert', 'tasks_project_same_org_update']) app.ctx.db.exec(`DROP TRIGGER ${trigger}`);
  app.ctx.db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(g1.project, task.body.id);
  instanceBoundaryTriggers(app.ctx.db);
  try {
    assert.deepEqual(instanceBoundaryViolations(app.ctx.db), { tasks_project: 1 });
    // Its owner can still work on it: sending back the link it already has is not a new crossing.
    const edited = await put(op.token, `/api/records/tasks/${task.body.id}`, { title: 'G8 task, renamed', project_id: g1.project });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    // G1's project cannot move, even inside G1, while G8 work hangs off it. Only the engine sees that, and its refusal is
    // answered as a refusal and written to the audit trail with who asked, not as a server error.
    const moved = await put(g1lead.token, `/api/records/projects/${g1.project}`, { unit_id: 'G1', visibility: 'unit' });
    assert.equal(moved.status, 403, JSON.stringify(moved.body));
    assert.equal(moved.body.code, 'cross_instance');
    const refusal = app.ctx.db.prepare("SELECT actor_id FROM audit_log WHERE action = 'cross_instance_refused' ORDER BY seq DESC LIMIT 1").get() as { actor_id: string };
    assert.equal(refusal.actor_id, g1lead.id);
  } finally {
    app.ctx.db.prepare('UPDATE tasks SET project_id = NULL WHERE id = ?').run(task.body.id);
  }
  assert.deepEqual(instanceBoundaryViolations(app.ctx.db), {});
});

test('a personnel feed gives back the primary unit it moved, and never reaches staff who sit in none of its units', async () => {
  const other = await startApp();
  try {
    const owner = await other.setupOperator();
    const lead = await other.register('lead');
    assert.equal((await other.call('POST', '/api/platform/orgs', { token: owner.token, body: { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id } })).status, 201);
    const leadToken = (await other.login('lead')).body.token as string;
    assert.equal((await other.call('POST', '/api/org/units', { token: owner.token, body: { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' } })).status, 201);
    assert.equal((await other.call('POST', '/api/org/units', { token: leadToken, body: { name: 'G1 Manpower', short_name: 'MANPOWER', code: 'manpower', parent_id: 'G1' } })).status, 201);
    const both = await other.register('both');
    await enroll(other, owner.token, 'FISCAL', both.id);
    await enroll(other, leadToken, 'MANPOWER', both.id);
    const staff = await other.register('staff');
    other.ctx.db.prepare('UPDATE users SET edipi = ? WHERE id = ?').run('1111111111', both.id);
    other.ctx.db.prepare('UPDATE users SET edipi = ? WHERE id = ?').run('2222222222', staff.id);
    other.ctx.db.prepare("INSERT INTO platform_roles (user_id, role, created_at) VALUES (?, 'support', ?)").run(staff.id, new Date().toISOString());

    const primary = () => (other.ctx.db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ? AND is_primary = 1').get(both.id) as { unit_id: string } | undefined)?.unit_id;
    const sync = async (...rows: string[]) => {
      const res = await other.call('POST', '/api/orgs/G8/personnel/sync?source=MCTFS&apply=1&confirm_separations=1', {
        token: owner.token, raw: Buffer.from(['DoD ID,Last,First,MI,Grade,PMOS,EAS,RUC,Status', ...rows].join('\n')), headers: { 'content-type': 'text/plain' },
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    };
    const BOTH = '1111111111,Both,Dana,,Sgt,3451,2027-06-30,G8,Active';
    const FILLER = '3333333333,Filler,Fay,,Cpl,3451,2027-06-30,G8,Active';

    assert.equal(primary(), 'FISCAL');
    await sync(BOTH, FILLER);
    await sync(FILLER);
    assert.equal(primary(), 'MANPOWER', 'leaving G8 moves the primary unit to the unit they still hold');
    await sync(BOTH, FILLER);
    assert.equal(primary(), 'FISCAL', 'back on G8’s roster, G8 gives back the primary unit its own extract moved');

    // Staff who run the service and sit in no unit are no organization's to rename or turn off.
    await sync(BOTH, FILLER, '2222222222,Taken,Over,,Pvt,0311,2026-01-01,G8,Separated');
    const after = other.ctx.db.prepare('SELECT last_name, active FROM users WHERE id = ?').get(staff.id) as { last_name: string; active: number };
    assert.equal(after.active, 1);
    assert.notEqual(after.last_name, 'Taken');
  } finally { await other.close(); }
});

test('one Unit Instance cannot re-key the sign-in of an account that serves in another', async () => {
  // Re-pointing Reyes's EDIPI would let G8's administrator sign in with a CAC as a leader of G1.
  const relink = await post(op.token, '/api/orgs/G8/personnel/link', { user_id: reyes.id, edipi: '5555555555' });
  assert.equal(relink.status, 403, JSON.stringify(relink.body));
  assert.equal(relink.body.code, 'cross_instance');
  assert.equal((app.ctx.db.prepare('SELECT edipi FROM users WHERE id = ?').get(reyes.id) as { edipi: string | null }).edipi, null);
  // A Marine of G8 alone is G8's to link, and the sessions opened under the old key end with the change.
  const linked = await post(op.token, '/api/orgs/G8/personnel/link', { user_id: g8marine.id, edipi: '5555555555' });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal((await get(g8marine.token, '/api/me')).status, 401);
  g8marine.token = await login('g8marine');
});
