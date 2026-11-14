import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { expireFormDrafts, SOURCE_LIMIT } from '../../server/services/drafts.ts';
import { placeHold, releaseHold } from '../../server/services/retention.ts';
import { DRAFT_KEPT_DAYS, DRAFT_LIMIT } from '../../shared/drafts.ts';
import { buildPersonalExport } from '../../server/services/personalExport.ts';
import { UMT_2WAY } from '../../shared/procedures.ts';

/**
 * Drafts (Task 23, ADR-0030). A draft lives with its own kind. The forms people save to finish later are their author's
 * alone, checked loosely when saved and properly when sent through their own form's route, which removes the draft in the
 * same transaction. One about a Marine is saved only by someone who may act for them, and is nowhere the Marine looks.
 * Drafts lists every kind, for the person asking only, and stores nothing.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let rivera: Person; let diaz: Person; let chen: Person; let alpha: Person; let charlie: Person; let g1lead: Person; let g1member: Person;
const call = (method: string, token: string, path: string, body?: unknown) => app.call(method, path, { token, body });
const get = (token: string, path: string) => call('GET', token, path);
const post = (token: string, path: string, body: unknown = {}) => call('POST', token, path, body);
const put = (token: string, path: string, body: unknown = {}) => call('PUT', token, path, body);
const db = () => app.ctx.db;
const login = async (username: string) => (await app.login(username)).body.token as string;
const audits = (action: string) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<Record<string, any>>;
const draftRow = (id: string) => db().prepare('SELECT * FROM form_drafts WHERE id = ?').get(id) as Record<string, any> | undefined;
const save = (who: Person, body: unknown) => post(who.token, '/api/drafts/forms', body);
const send = (who: Person, path: string, draft: { id: string; version: number }, body: unknown) => post(who.token, `${path}?draft=${draft.id}&draft_version=${draft.version}`, body);

async function person(username: string, unitId?: string, roleKey?: string, profile?: Record<string, string>): Promise<Person> {
  const p = await app.register(username, profile);
  if (unitId) await enroll(app, op.token, unitId, p.id, roleKey);
  return { id: p.id, token: await login(username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  rivera = await person('rivera', 'G8', undefined, { rank_id: 'Cpl', last_name: 'Rivera' });
  diaz = await person('diaz', 'G8', 'fire-team-leader', { rank_id: 'Sgt', last_name: 'Diaz' });
  chen = await person('chen', 'G8');
  alpha = await person('alpha', 'G8');
  charlie = await person('charlie', 'G8', 'nco');
  g1lead = await person('gonelead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('gonelead');
  g1member = await person('gonemember');
  await enroll(app, g1lead.token, 'G1', g1member.id);
});
after(async () => { await app.close(); });

test('a saved form is its author’s alone: anyone else is told there is no such draft', async () => {
  const made = await save(chen, { kind: 'goal', payload: { title: 'Finish the fiscal law course', description: 'By the end of the quarter', type: 'qualitative', smuggled: 'x', visibility: 'private' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.title, 'Finish the fiscal law course', 'its title is what its author wrote');
  assert.equal(made.body.payload.smuggled, undefined, 'only the form’s own fields are kept');
  assert.equal(made.body.can_submit, true);
  assert.ok(made.body.kept_until > made.body.updated_at);

  for (const who of [op, diaz, rivera]) {
    assert.equal((await get(who.token, `/api/drafts/forms/${made.body.id}`)).status, 404);
    assert.equal((await put(who.token, `/api/drafts/forms/${made.body.id}`, { payload: { title: 'mine' }, version: 1 })).status, 404);
    assert.equal((await call('DELETE', who.token, `/api/drafts/forms/${made.body.id}`)).status, 404);
    assert.equal((await send(who, '/api/records/goals', made.body, { title: 'mine' })).status, 404, 'nor sent by anyone else');
    const theirs = (await get(who.token, '/api/drafts')).body;
    assert.ok(!theirs.items.some((d: any) => d.id === made.body.id), 'nor listed for them');
  }
  assert.ok(draftRow(made.body.id), 'and it is still there');

  // Saved, never a record: nothing that counts or lists goals sees it.
  const goals = (await get(chen.token, '/api/records/goals')).body;
  assert.ok(Array.isArray(goals), JSON.stringify(goals));
  assert.ok(!goals.some((g: any) => g.title === 'Finish the fiscal law course'));
  const audit = audits('save_draft').at(-1)!;
  assert.equal(audit.entity, 'form_drafts');
  assert.equal(audit.subject_id, null);

  // Saved again over the version read; an older version is refused with the newer one.
  const again = await put(chen.token, `/api/drafts/forms/${made.body.id}`, { payload: { title: 'Finish fiscal law', type: 'qualitative' }, version: 1 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.version, 2);
  const stale = await put(chen.token, `/api/drafts/forms/${made.body.id}`, { payload: { title: 'Older window' }, version: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  assert.equal(stale.body.current.payload.title, 'Finish fiscal law');
});

test('a form is kept loosely but within bounds, and an empty one is not kept', async () => {
  assert.equal((await save(chen, { kind: 'task', payload: { title: '' } })).status, 400, 'nothing filled in');
  assert.equal((await save(chen, { kind: 'task', payload: { visibility: 'unit', unit_id: 'G8' } })).status, 400, 'a placement is not content');
  const long = await save(chen, { kind: 'task', payload: { title: 'x', notes: 'y'.repeat(8001) } });
  assert.equal(long.status, 400);
  assert.ok(long.body.fieldErrors?.notes);
  assert.equal((await save(chen, { kind: 'task', payload: { title: { nested: true } } })).status, 400, 'a value, not an object');
  const big = await save(chen, { kind: 'training', payload: { title: 'x', notes: 'é'.repeat(7000), provider: 'é'.repeat(7000), status: 'é'.repeat(7000) } });
  assert.equal(big.status, 400);
  assert.equal(big.body.code, 'draft_too_large');
  assert.equal((await save(chen, { kind: 'counseling', payload: { summary: 'x' } })).status, 400, 'a counseling drafts in itself');
  assert.equal((await save(chen, { kind: 'goal', subject_id: rivera.id, payload: { title: 'x' } })).status, 400, 'only two kinds are about someone else');
  // A draft names no one by an id it carries: a task's assignee is the form's, checked when it is sent.
  const assigned = await save(chen, { kind: 'task', payload: { title: 'Ask the G1', assignee_id: g1member.id, visibility: 'unit', unit_id: 'G1' } });
  assert.equal(assigned.status, 201);
  // Their name is "LCpl Gonemember Marine" (helpers.register); neither it nor their unit is looked up.
  assert.doesNotMatch(JSON.stringify(assigned.body), /gonemember|MARFORRES G-1/i, 'no name or place is looked up for an id in the form');
  assert.doesNotMatch(JSON.stringify((await get(chen.token, '/api/drafts')).body), /gonemember|MARFORRES G-1/i, 'nor in Drafts');
  const refused = await send(chen, '/api/records/tasks', assigned.body, { title: 'Ask the G1', assignee_id: g1member.id, visibility: 'unit', unit_id: 'G1' });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(draftRow(assigned.body.id), 'a refused send leaves the draft as it was');
});

test('sent through its own form’s route, a draft becomes the record and is gone, once', async () => {
  const draft = (await save(chen, { kind: 'training', payload: { title: 'Cyber Awareness', date: '2026-01-05', hours: 1 } })).body;
  const before = (db().prepare('SELECT COUNT(*) AS n FROM trainings WHERE user_id = ?').get(chen.id) as { n: number }).n;
  assert.equal((await post(chen.token, `/api/records/trainings?draft=${draft.id}`, { title: 'Cyber Awareness', date: '2026-01-05', hours: 1 })).status, 400, 'the version read is required');
  const wrongKind = await send(chen, '/api/records/goals', draft, { title: 'Cyber Awareness', type: 'qualitative' });
  assert.equal(wrongKind.status, 409);
  assert.equal(wrongKind.body.code, 'draft_mismatch');
  const older = await send(chen, '/api/records/trainings', { id: draft.id, version: 7 }, { title: 'Cyber Awareness', date: '2026-01-05', hours: 1 });
  assert.equal(older.status, 409);
  assert.equal(older.body.code, 'draft_changed');
  const invalid = await send(chen, '/api/records/trainings', draft, { title: '', date: 'not a day' });
  assert.equal(invalid.status, 400);
  assert.equal((db().prepare('SELECT COUNT(*) AS n FROM trainings WHERE user_id = ?').get(chen.id) as { n: number }).n, before, 'nothing was created');
  assert.ok(draftRow(draft.id), 'and the draft is as it was');

  const sent = await send(chen, '/api/records/trainings', draft, { title: 'Cyber Awareness', date: '2026-01-05', hours: 1 });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(draftRow(draft.id), undefined, 'the record is the only copy');
  const created = audits('create').at(-1)!;
  assert.equal(created.entity_id, sent.body.id);
  assert.equal(created.detail, 'from saved form');
  const twice = await send(chen, '/api/records/trainings', draft, { title: 'Cyber Awareness', date: '2026-01-05', hours: 1 });
  assert.equal(twice.status, 404, 'a second send finds no draft');
  assert.equal(twice.body.code, 'draft_gone', 'and says so, as it says of a draft that is not yours');
  assert.equal((db().prepare('SELECT COUNT(*) AS n FROM trainings WHERE user_id = ?').get(chen.id) as { n: number }).n, before + 1, 'and creates nothing');
  assert.equal((await post(chen.token, '/api/records/activities?draft=x&draft_version=1', { title: 'x', date: '2026-01-01' })).status, 400, 'no draft is kept for that kind');
});

test('a leader’s award recommendation draft is theirs alone, and nowhere its Marine looks until it is sent', async () => {
  assert.equal((await save(chen, { kind: 'award', subject_id: rivera.id, payload: { name: 'NAM' } })).status, 403, 'a peer cannot recommend');
  assert.equal((await save(diaz, { kind: 'award', subject_id: g1member.id, payload: { name: 'NAM' } })).status, 403, 'nor anyone for a Marine of another Unit Instance');
  const made = await save(diaz, { kind: 'award', subject_id: rivera.id, unit_id: 'G8', payload: { name: 'Navy and Marine Corps Achievement Medal', type: 'personal_award', status: 'recommended', citation: 'For superior performance as fiscal clerk.' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.subject_id, rivera.id);
  assert.equal(made.body.unit_id, 'G8');
  assert.match(made.body.subject_label, /^Cpl .*Rivera$/, 'named as they were when it was saved');
  assert.equal(audits('save_draft').at(-1)!.subject_id, null, 'its Marine’s trail does not carry it');

  // Rivera sees nothing of it: no draft, no award, no notification, no count.
  assert.equal((await get(rivera.token, `/api/drafts/forms/${made.body.id}`)).status, 404);
  assert.ok(!(await get(rivera.token, '/api/drafts')).body.items.some((d: any) => d.id === made.body.id));
  assert.equal((db().prepare('SELECT COUNT(*) AS n FROM awards WHERE user_id = ?').get(rivera.id) as { n: number }).n, 0);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'award'").get(rivera.id) as { n: number }).n, 0);
  const exported = buildPersonalExport(app.ctx, rivera.id) as Record<string, any>;
  assert.ok(!JSON.stringify(exported).includes('superior performance as fiscal clerk'), 'nor in their export');
  const leaders = buildPersonalExport(app.ctx, diaz.id) as Record<string, any>;
  assert.ok(!JSON.stringify(leaders.saved_drafts).includes('superior performance'), 'nor in the leader’s own: it stays with its Marine’s unit');

  const listed = (await get(diaz.token, '/api/drafts')).body.items.find((d: any) => d.id === made.body.id);
  assert.equal(listed.kind, 'award');
  assert.equal(listed.href, `/team/${rivera.id}?draft=${made.body.id}`);
  assert.equal(listed.readers, 'Only you');

  // Sent to another Marine, or another unit, it is refused; sent as saved, the Marine is told.
  assert.equal((await send(diaz, '/api/records/awards', made.body, { user_id: alpha.id, unit_id: 'G8', name: 'NAM', type: 'personal_award', status: 'recommended' })).status, 409);
  assert.equal((await send(diaz, '/api/records/awards', made.body, { user_id: rivera.id, unit_id: 'NOPE', name: 'NAM', type: 'personal_award', status: 'recommended' })).status, 409);
  const sent = await send(diaz, '/api/records/awards', made.body, { user_id: rivera.id, unit_id: 'G8', name: 'Navy and Marine Corps Achievement Medal', type: 'personal_award', status: 'recommended', citation: 'For superior performance as fiscal clerk.' });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.user_id, rivera.id);
  assert.equal(sent.body.unit_id, 'G8');
  assert.equal(draftRow(made.body.id), undefined);
  assert.equal((db().prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'award'").get(rivera.id) as { n: number }).n, 1);
});

test('a personnel change draft is saved only by someone who may make it, keeps what it changes from, and is made by the Marine’s own route', async () => {
  const body = { kind: 'personnel_change', subject_id: alpha.id, unit_id: 'G8', payload: { changes: { billet: 'Fiscal Clerk', assignment_start: '2026-10-01', reason: 'PCS orders' }, supervisor_label: 'whatever the form says' } };
  assert.equal((await save(charlie, body)).status, 403, 'an NCO does not manage members');
  const denied = audits('access_denied').filter((a) => a.actor_id === charlie.id);
  assert.ok(denied.some((a) => String(a.detail).startsWith('POST /api/drafts/forms')), 'and the refusal is in the trail, as one on the route that makes the change is');
  assert.equal((await save(alpha, { ...body, subject_id: alpha.id })).status, 403, 'nor anyone their own');
  assert.equal((await save(g1lead, { ...body, unit_id: 'G1' })).status, 404, 'not a member there');
  assert.equal((await save(op, { ...body, payload: { changes: { reason: 'only a reason' } } })).status, 400, 'a change changes something');
  const made = await save(op, body);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.title, 'Assignment change: billet, assignment dates');
  assert.deepEqual(made.body.payload.was, { billet: null, assignment_start: null }, 'what it held when saved, from the record, not the form');
  assert.equal(made.body.payload.supervisor_label, 'whatever the form says');

  // Sent for another Marine or unit, it is refused; sent as saved, the change is made and the draft is gone.
  assert.equal((await call('PUT', op.token, `/api/org/units/G8/members/${rivera.id}?draft=${made.body.id}&draft_version=1`, { billet: 'Fiscal Clerk' })).status, 409);
  const changed = await call('PUT', op.token, `/api/org/units/G8/members/${alpha.id}?draft=${made.body.id}&draft_version=1`, { billet: 'Fiscal Clerk', assignment_start: '2026-10-01', reason: 'PCS orders' });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.changed.sort(), ['assignment_start', 'billet']);
  assert.equal(draftRow(made.body.id), undefined);
  assert.match(String(audits('edit_membership').at(-1)!.detail), /from saved form/);

  // Saved again later, it says what the assignment holds now.
  const next = await save(op, { ...body, payload: { changes: { billet: 'Lead Clerk' } } });
  assert.deepEqual(next.body.payload.was, { billet: 'Fiscal Clerk' });
});

test('a draft whose author can no longer act for its Marine stays theirs to read and discard, and cannot be sent', async () => {
  const lead = await person('lostlead', 'G8', 'fire-team-leader');
  const made = (await save(lead, { kind: 'award', subject_id: rivera.id, unit_id: 'G8', payload: { name: 'Letter of Appreciation' } })).body;
  db().prepare("DELETE FROM member_roles WHERE user_id = ? AND unit_id = 'G8'").run(lead.id);
  const read = await get(lead.token, `/api/drafts/forms/${made.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.can_submit, false);
  assert.equal(read.body.payload.name, 'Letter of Appreciation', 'what they wrote stays theirs to read');
  assert.match(read.body.blocked, /no longer/);
  assert.ok(!/G8|rivera/i.test(read.body.blocked), 'the reason names no unit and no whereabouts');
  const listed = (await get(lead.token, '/api/drafts')).body.items.find((d: any) => d.id === made.id);
  assert.equal(listed.can_submit, false);
  const update = await put(lead.token, `/api/drafts/forms/${made.id}`, { payload: { name: 'Letter' }, version: made.version });
  assert.equal(update.status, 403);
  assert.equal(update.body.code, 'draft_authority');
  assert.equal((await send(lead, '/api/records/awards', made, { user_id: rivera.id, unit_id: 'G8', name: 'Letter of Appreciation' })).status, 403);
  assert.equal((await call('DELETE', lead.token, `/api/drafts/forms/${made.id}`)).status, 204);
  assert.equal(draftRow(made.id), undefined);
});

test('Drafts lists every kind of draft of the person asking, from where each is kept, and none someone else is writing about them', async () => {
  const counseling = await post(diaz.token, '/api/records/counselings', { user_id: rivera.id, type: 'event', date: '2026-10-01', summary: 'Drafted, not shared.', stage: 'draft', visibility: 'unit', unit_id: 'G8' });
  assert.equal(counseling.status, 201, JSON.stringify(counseling.body));
  const shared = await post(diaz.token, '/api/records/counselings', { user_id: rivera.id, type: 'monthly', date: '2026-10-02', summary: 'Shared for review.', stage: 'review', visibility: 'unit', unit_id: 'G8' });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  const report = await post(diaz.token, '/api/studio/reports', { title: 'Q3 JEPES package', period_start: '2026-07-01', period_end: '2026-09-30' });
  assert.equal(report.status, 201, JSON.stringify(report.body));
  const thread = await post(diaz.token, '/api/correspondence/threads', { subject: 'Reply to DFAS on the PCS claim', visibility: 'private' });
  assert.equal(thread.status, 201, JSON.stringify(thread.body));
  const goal = (await save(diaz, { kind: 'goal', payload: { title: 'Close ten cases', type: 'qualitative' } })).body;

  const mine = (await get(diaz.token, '/api/drafts')).body;
  const byKey = new Map(mine.items.map((d: any) => [d.key, d]));
  const c = byKey.get(`counseling:${counseling.body.id}`) as any;
  assert.equal(c.href, `/career/counseling?open=${counseling.body.id}`);
  assert.equal(c.readers, 'Only you');
  assert.match((byKey.get(`counseling:${shared.body.id}`) as any).readers, /^Shared with .* to review$/);
  const r = byKey.get(`report:${report.body.id}`) as any;
  assert.equal(r.href, `/reports?open=${report.body.id}`);
  assert.match(r.title, /not saved yet/);
  assert.equal((byKey.get(`correspondence:${thread.body.id}`) as any).href, `/work/correspondence?thread=${thread.body.id}`);
  assert.equal((byKey.get(`form:${goal.id}`) as any).href, `/goals?draft=${goal.id}`);
  assert.ok(mine.counts.counseling >= 2 && mine.counts.report >= 1 && mine.counts.correspondence >= 1 && mine.counts.goal >= 1);
  assert.equal(mine.total, mine.items.length);
  assert.equal((byKey.get(`counseling:${shared.body.id}`) as any).waiting, false, 'shared to review, it waits on the Marine');
  assert.equal(c.waiting, true);
  assert.equal(mine.waiting, mine.items.filter((d: any) => d.waiting).length);
  // A report package nobody has worked on for a month is listed and not counted.
  db().prepare('UPDATE report_drafts SET updated_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', report.body.id);
  const later = (await get(diaz.token, '/api/drafts')).body;
  assert.equal(later.items.find((d: any) => d.id === report.body.id).waiting, false);
  assert.equal(later.waiting, mine.waiting - 1);
  const sorted = [...mine.items].sort((a: any, b: any) => b.updated_at.localeCompare(a.updated_at));
  assert.deepEqual(mine.items.map((d: any) => d.key), sorted.map((d: any) => d.key), 'newest first');
  const summary = (await get(diaz.token, '/api/record/summary')).body;
  assert.equal(summary.personal.open_drafts, later.waiting, 'the record overview counts what the menu counts');

  // The Marine they are about sees none of them as their drafts.
  const riveras = (await get(rivera.token, '/api/drafts')).body;
  assert.ok(!riveras.items.some((d: any) => [counseling.body.id, shared.body.id].includes(d.id)));

  // A thread made by bringing in a message someone sent is not a draft.
  db().prepare("INSERT INTO thread_messages (id, thread_id, direction, source, to_emails, cc_emails, created_at) VALUES ('in-1', ?, 'inbound', 'eml', '[]', '[]', ?)").run(thread.body.id, new Date().toISOString());
  assert.ok(!(await get(diaz.token, '/api/drafts')).body.items.some((d: any) => d.id === thread.body.id));
});

test('a saved form is removed 90 days after it was last saved, unless a legal hold keeps it; discarded while held, it is hidden until released', async () => {
  const old = new Date(Date.now() - (DRAFT_KEPT_DAYS + 1) * 86_400_000).toISOString();
  const mine = (await save(chen, { kind: 'task', payload: { title: 'Stale task' } })).body;
  const about = (await save(diaz, { kind: 'award', subject_id: rivera.id, unit_id: 'G8', payload: { name: 'Stale award' } })).body;
  const fresh = (await save(chen, { kind: 'task', payload: { title: 'Fresh task' } })).body;
  db().prepare('UPDATE form_drafts SET updated_at = ? WHERE id IN (?, ?)').run(old, mine.id, about.id);

  // A hold on the Marine keeps the draft about them; one on the instance keeps every one.
  const onRivera = placeHold(app.ctx, 'G8', { scope: 'user', subject_id: rivera.id, reason: 'IG inquiry' }, op.id);
  try {
    expireFormDrafts(app.ctx);
    assert.equal(draftRow(mine.id), undefined, 'the unheld one is gone');
    assert.ok(draftRow(about.id), 'the one about the held Marine is kept');
    // Discarded while held, it leaves its author's drafts but is kept.
    assert.equal((await call('DELETE', diaz.token, `/api/drafts/forms/${about.id}`)).status, 204);
    assert.ok(draftRow(about.id)?.deleted_at, 'hidden, not removed');
    assert.equal((await get(diaz.token, `/api/drafts/forms/${about.id}`)).status, 404);
    expireFormDrafts(app.ctx);
    assert.ok(draftRow(about.id));
  } finally { releaseHold(app.ctx, 'G8', onRivera.id, op.id); }
  const removed = expireFormDrafts(app.ctx);
  assert.ok(removed >= 1);
  assert.equal(draftRow(about.id), undefined, 'removed once the hold is released');
  assert.ok(draftRow(fresh.id), 'a recent one stays');
  const run = db().prepare("SELECT * FROM disposition_runs WHERE record_type = 'form_drafts' ORDER BY at DESC LIMIT 1").get() as Record<string, any>;
  assert.ok(run, 'each run is recorded');
  assert.ok(audits('drafts_expired').length >= 1);

  db().prepare('UPDATE form_drafts SET updated_at = ? WHERE id = ?').run(old, fresh.id);
  const instance = placeHold(app.ctx, 'G8', { scope: 'instance', reason: 'Litigation' }, op.id);
  try {
    assert.equal(expireFormDrafts(app.ctx), 0);
    assert.ok(draftRow(fresh.id), 'an instance-wide hold keeps every one');
  } finally { releaseHold(app.ctx, 'G8', instance.id, op.id); }
  // So does a hold on saved forms as a kind, which the holds console offers.
  const onForms = placeHold(app.ctx, 'G8', { scope: 'record_type', record_type: 'form_drafts', reason: 'Records inquiry' }, op.id);
  try {
    assert.equal(expireFormDrafts(app.ctx), 0);
    assert.ok(draftRow(fresh.id), 'a hold on saved forms keeps every one');
    assert.equal((await call('DELETE', chen.token, `/api/drafts/forms/${fresh.id}`)).status, 204);
    assert.ok(draftRow(fresh.id)?.deleted_at, 'discarded while held, it is hidden, not removed');
  } finally { releaseHold(app.ctx, 'G8', onForms.id, op.id); }
  expireFormDrafts(app.ctx);
  assert.equal(draftRow(fresh.id), undefined, 'removed once the hold is released');
  const listed = await get(op.token, '/api/orgs/G8/retention');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.ok(listed.body.holdableTypes.includes('form_drafts'), 'the holds console offers it');
});

test('a person keeps at most so many saved forms', async () => {
  const quota = await person('quota');
  const at = new Date().toISOString();
  const insert = db().prepare("INSERT INTO form_drafts (id, user_id, kind, title, payload, created_at, updated_at) VALUES (?, ?, 'task', 'Filler', '{}', ?, ?)");
  db().transaction(() => { for (let i = 0; i < DRAFT_LIMIT; i++) insert.run(`q-${i}`, quota.id, at, at); })();
  const over = await save(quota, { kind: 'task', payload: { title: 'One more' } });
  assert.equal(over.status, 409);
  assert.equal(over.body.code, 'draft_quota');
  db().prepare('DELETE FROM form_drafts WHERE user_id = ?').run(quota.id);
});

test('an entry kept in the record is changed there, not in its draft', async () => {
  const at = new Date().toISOString();
  db().prepare("INSERT INTO activities (id, user_id, unit_id, visibility, date, title, created_at, updated_at) VALUES ('kept-act', ?, 'G8', 'private', '2026-01-02', 'Kept', ?, ?)").run(chen.id, at, at);
  db().prepare("INSERT INTO record_drafts (id, user_id, title, facts, wording, activity_id, created_at, updated_at) VALUES ('kept-draft', ?, 'Kept', '[]', 'Kept wording', 'kept-act', ?, ?)").run(chen.id, at, at);
  const edited = await put(chen.token, '/api/record/drafts/kept-draft', { wording: 'Changed after keeping' });
  assert.equal(edited.status, 409);
  assert.equal(edited.body.code, 'already_recorded');
  assert.ok(!(await get(chen.token, '/api/drafts')).body.items.some((d: any) => d.id === 'kept-draft'), 'kept, it is a record, not a draft');
});

test('the author’s export carries their own saved forms', async () => {
  const draft = (await save(alpha, { kind: 'goal', payload: { title: 'Pass the PFT', type: 'qualitative' } })).body;
  const out = buildPersonalExport(app.ctx, alpha.id) as Record<string, any>;
  const kept = out.saved_drafts.find((d: any) => d.id === draft.id);
  assert.equal(kept.payload.title, 'Pass the PFT');
  assert.equal(out.counts.saved_drafts, out.saved_drafts.length);
});

test('an entry from work is drawn once per case, and only from a case its author can still open', async () => {
  const worker = await person('drafter', 'G8');
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT', reference: 'SYN-DR-1' });
  const id = made.body.id as string;
  await post(op.token, `/api/work/items/${id}/procedure`, { key: UMT_2WAY.key });
  assert.equal((await post(worker.token, `/api/work/items/${id}/claim`)).status, 200);
  await post(worker.token, `/api/work/items/${id}/entries`, { kind: 'observation', field: 'current_award', amount: '91250', system: 'DAI' });
  const first = await post(worker.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await post(worker.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(again.body.id, first.body.id, 'asked again, it is the draft already started, not a second copy');
  assert.equal((db().prepare('SELECT COUNT(*) AS n FROM record_drafts WHERE user_id = ? AND work_item_id = ?').get(worker.id, id) as { n: number }).n, 1);

  // Once they leave the case's unit, its title and who else worked on it are not theirs to read.
  assert.equal((await call('DELETE', op.token, `/api/org/units/G8/members/${worker.id}`)).status, 200);
  worker.token = await login('drafter');
  const gone = await post(worker.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(gone.status, 404, 'the same answer as for a case that does not exist');
  assert.equal((await post(worker.token, '/api/record/drafts/from-work', { work_item_id: 'no-such-case' })).status, 404);
  assert.ok((await get(worker.token, '/api/drafts')).body.items.some((d: any) => d.id === first.body.id), 'the entry they already drew is still theirs');
});

test('past the newest of a kind that are listed, the count still counts every draft, and the page says there are more', async () => {
  const many = await person('manydrafts');
  const at = new Date().toISOString();
  const insert = db().prepare("INSERT INTO record_drafts (id, user_id, title, facts, wording, created_at, updated_at) VALUES (?, ?, 'Entry', '[]', 'Wording', ?, ?)");
  db().transaction(() => { for (let i = 0; i < SOURCE_LIMIT + 5; i++) insert.run(`many-${i}`, many.id, at, at); })();
  await save(many, { kind: 'goal', payload: { title: 'One goal' } });
  const listed = (await get(many.token, '/api/drafts')).body;
  assert.equal(listed.items.filter((d: any) => d.source === 'entry').length, SOURCE_LIMIT, 'the newest of a kind are listed');
  assert.equal(listed.more, true);
  assert.equal(listed.waiting, SOURCE_LIMIT + 6, 'every one waiting is counted, listed or not');
  const summary = (await get(many.token, '/api/record/summary')).body;
  assert.equal(summary.personal.open_drafts, listed.waiting, 'the same as the record overview');
  assert.equal((await get(chen.token, '/api/drafts')).body.more, false);
  db().prepare('DELETE FROM record_drafts WHERE user_id = ?').run(many.id);
});

test('a recommendation drafted in one unit is sent to that unit, whatever unit its form named', async () => {
  const unit = await post(op.token, '/api/org/units', { name: 'Alpha Co', short_name: 'ALPHA', code: 'alpha', parent_id: 'G8' });
  assert.equal(unit.status, 201, JSON.stringify(unit.body));
  const leader = await person('placeleader', 'G8');
  await enroll(app, op.token, unit.body.id, leader.id, 'fire-team-leader');
  leader.token = await login('placeleader');
  const marine = await person('placemarine', unit.body.id);
  // The form's unit list is the leader's own units, so it can name one where they may not counsel this Marine.
  const made = await save(leader, { kind: 'award', subject_id: marine.id, unit_id: 'G8', payload: { name: 'NAM', type: 'personal_award', status: 'recommended', visibility: 'unit', unit_id: 'G8' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.unit_id, unit.body.id, 'placed where its author may counsel the Marine');
  assert.equal(made.body.payload.unit_id, unit.body.id, 'and its form says so');
  const again = await put(leader.token, `/api/drafts/forms/${made.body.id}`, { payload: { ...made.body.payload, unit_id: 'G8', citation: 'For superior performance.' }, version: made.body.version });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.unit_id, unit.body.id);
  assert.equal(again.body.payload.unit_id, unit.body.id, 'its unit was fixed when it was created');
  const sent = await send(leader, '/api/records/awards', again.body, { ...again.body.payload, user_id: marine.id });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.unit_id, unit.body.id);
  assert.equal(draftRow(made.body.id), undefined);
});

test('a person with exactly as many saved forms as are listed is not told there are more', async () => {
  const full = await person('fulldrafts');
  const at = new Date().toISOString();
  const insert = db().prepare("INSERT INTO form_drafts (id, user_id, kind, title, payload, created_at, updated_at) VALUES (?, ?, 'task', 'Filler', '{}', ?, ?)");
  db().transaction(() => { for (let i = 0; i < DRAFT_LIMIT; i++) insert.run(`full-${i}`, full.id, at, at); })();
  assert.equal(DRAFT_LIMIT, SOURCE_LIMIT, 'the quota and the list are the same size');
  const listed = (await get(full.token, '/api/drafts')).body;
  assert.equal(listed.items.length, DRAFT_LIMIT);
  assert.equal(listed.saved, DRAFT_LIMIT);
  assert.equal(listed.more, false, 'every one is listed');
  db().prepare('DELETE FROM form_drafts WHERE user_id = ?').run(full.id);
});
