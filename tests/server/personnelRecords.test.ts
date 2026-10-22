import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { instanceBoundaryViolations } from '../../server/db/index.ts';
import { listZip } from '../../server/lib/zip.ts';

/**
 * Personnel records (Task 11, ADR-0017): one structured record per Marine, built from their account, their memberships
 * and a record per Unit Instance; its history written by the database whoever changes it; changed one Marine at a time
 * or in bulk, all or nothing, by those who manage members, never by the Marine for themselves; read by whoever sees the
 * Marine on a roster, with account status, history and record counts only for those entitled to them.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let alpha: Person; let bravo: Person; let charlie: Person; let delta: Person; let manager: Person;
let g1lead: Person; let g1member: Person;
let billetId: string; let g1BilletId: string;
const call = (method: string, token: string, path: string, body?: unknown) => app.call(method, path, { token, body });
const get = (token: string, path: string) => call('GET', token, path);
const post = (token: string, path: string, body: unknown = {}) => call('POST', token, path, body);
const put = (token: string, path: string, body: unknown = {}) => call('PUT', token, path, body);
const login = async (username: string) => (await app.login(username)).body.token as string;
const db = () => app.ctx.db;
const events = (userId: string, field?: string) => db().prepare(`SELECT * FROM personnel_events WHERE user_id = ? ${field ? 'AND field = ?' : ''} ORDER BY id`).all(...[userId, ...(field ? [field] : [])]) as Array<Record<string, any>>;
const member = (userId: string, unitId: string) => db().prepare('SELECT * FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId) as Record<string, any> | undefined;
const record = (userId: string, orgId = 'G8') => db().prepare('SELECT * FROM personnel_records WHERE user_id = ? AND org_id = ?').get(userId, orgId) as Record<string, any> | undefined;
const audits = (action: string) => db().prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<Record<string, any>>;

async function person(username: string, unitId?: string, roleKey?: string): Promise<Person> {
  const p = await app.register(username);
  if (unitId) await enroll(app, op.token, unitId, p.id, roleKey);
  return { id: p.id, token: await login(username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  for (const [name, short] of [['Budget Section', 'BUD'], ['Disbursing Section', 'DSB']]) {
    const made = await post(op.token, '/api/org/units', { name, short_name: short, echelon: 'section', parent_id: 'G8' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
  }
  const units = db().prepare("SELECT id, short_name FROM units WHERE short_name IN ('BUD', 'DSB')").all() as Array<{ id: string; short_name: string }>;
  const bud = units.find((u) => u.short_name === 'BUD')!.id;
  alpha = await person('alpha', 'G8');
  bravo = await person('bravo', bud);
  charlie = await person('charlie', 'G8', 'nco');
  delta = await person('delta', 'G8');
  manager = await person('umanager', 'G8');
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: manager.id, role: 'admin' })).status, 201);
  manager.token = await login('umanager');
  g1lead = await person('gonelead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('gonelead');
  g1member = await person('gonemember');
  await enroll(app, g1lead.token, 'G1', g1member.id);
  const billet = await post(op.token, '/api/orgs/G8/billets', { title: 'Disbursing Clerk', code: '3432' });
  assert.equal(billet.status, 201, JSON.stringify(billet.body));
  billetId = billet.body.id;
  const g1Billet = await post(g1lead.token, '/api/orgs/G1/billets', { title: 'Admin Clerk' });
  assert.equal(g1Billet.status, 201, JSON.stringify(g1Billet.body));
  g1BilletId = g1Billet.body.id;
});
after(async () => { await app.close(); });

test('a leader fills a billet from the list, dates the assignment, names a supervisor and a check-in, and the history says who, how and why', async () => {
  const res = await put(op.token, `/api/org/units/G8/members/${alpha.id}`, { billet_id: billetId, assignment_start: '2026-10-01', assignment_end: '2027-09-30', supervisor_id: charlie.id, checked_in_on: '2026-09-28', reason: 'PCS orders' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([...res.body.changed].sort(), ['assignment_end', 'assignment_start', 'billet', 'billet_id', 'checked_in', 'supervisor']);
  const m = member(alpha.id, 'G8')!;
  assert.equal(m.billet_id, billetId);
  assert.equal(m.billet, 'Disbursing Clerk', 'a billet from the list sets its title too');
  assert.equal(m.assignment_start, '2026-10-01');
  assert.equal(record(alpha.id)!.supervisor_id, charlie.id);

  const written = events(alpha.id).filter((e) => ['supervisor', 'checked_in', 'assignment_start', 'assignment_end'].includes(e.field));
  assert.equal(written.length, 4);
  for (const e of written) {
    assert.equal(e.actor_id, op.id); assert.equal(e.source, 'leader'); assert.equal(e.reason, 'PCS orders');
    assert.equal(e.org_id, 'G8');
  }
  assert.equal(written.find((e) => e.field === 'supervisor')!.to_value, charlie.id);
  const entry = audits('edit_membership').at(-1)!;
  assert.equal(entry.subject_id, alpha.id);
  assert.match(entry.detail, /billet/); assert.match(entry.detail, /PCS orders/);

  // Saving the same again changes nothing and writes no history.
  const before = events(alpha.id).length;
  const again = await put(op.token, `/api/org/units/G8/members/${alpha.id}`, { billet_id: billetId, supervisor_id: charlie.id });
  assert.deepEqual(again.body.changed, []);
  assert.equal(events(alpha.id).length, before);

  // A title typed in instead leaves the list.
  await put(op.token, `/api/org/units/G8/members/${delta.id}`, { billet_id: billetId });
  const typed = await put(op.token, `/api/org/units/G8/members/${delta.id}`, { billet: 'Acting Clerk' });
  assert.equal(typed.status, 200);
  assert.equal(member(delta.id, 'G8')!.billet_id, null);
  assert.equal(member(delta.id, 'G8')!.billet, 'Acting Clerk');
});

test('the record reads as one: assignments, team, supervisor, the chain above them, roles, account and history', async () => {
  const res = await get(op.token, `/api/org/team/${alpha.id}/personnel`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body;
  assert.equal(body.person.id, alpha.id);
  assert.equal(body.instances.length, 1);
  const inst = body.instances[0];
  assert.equal(inst.org_id, 'G8');
  assert.equal(inst.supervisor.id, charlie.id);
  assert.equal(inst.checked_in_on, '2026-09-28');
  assert.equal(inst.assignments[0].billet_id, billetId);
  assert.equal(inst.assignments[0].canManage, true);
  assert.deepEqual(inst.chain.map((p: any) => [p.id, p.relation]), [[charlie.id, 'supervisor'], [op.id, 'leader']], 'their supervisor, then the leader of their unit');
  assert.ok(inst.billets.some((b: any) => b.id === billetId), 'the list to choose a billet from, for one who may set it');
  assert.equal(body.account.status, 'active');
  assert.ok(body.history.events.some((e: any) => e.field === 'supervisor' && e.actor?.id === op.id && e.to_label?.includes('Charlie')));
  assert.ok(body.history.periods.length >= 1);
  assert.ok(body.records, 'the unit leader opens their records, so sees the counts');
  assert.equal(body.canOpenRecords, true);
  // Charlie sees that they supervise Alpha.
  const theirs = await get(op.token, `/api/org/team/${charlie.id}/personnel`);
  assert.deepEqual(theirs.body.instances[0].supervises.map((p: any) => p.id), [alpha.id]);
  // Opening someone else's personnel record is audited; one's own is not.
  assert.ok(audits('view_personnel').some((a) => a.subject_id === alpha.id && a.actor_id === op.id));
  const own = await get(alpha.token, `/api/org/team/${alpha.id}/personnel`);
  assert.equal(own.status, 200);
  assert.equal(own.body.self, true);
  assert.ok(own.body.account && own.body.history && own.body.records);
  assert.equal(own.body.instances[0].canManage, false, 'nobody manages their own record');
  assert.ok(!audits('view_personnel').some((a) => a.actor_id === alpha.id));
});

test('who may read what: a roster reader sees the record without account, history or counts; a Unit Manager manages it without the records', async () => {
  // Charlie (NCO: Read records, no member detail) sees Alpha on a roster.
  const nco = await get(charlie.token, `/api/org/team/${alpha.id}/personnel`);
  assert.equal(nco.status, 200, JSON.stringify(nco.body));
  assert.equal(nco.body.account, null);
  assert.equal(nco.body.history, null);
  assert.equal(nco.body.records, null);
  assert.equal(nco.body.canOpenRecords, false);
  assert.equal(nco.body.instances[0].canManage, false);
  assert.deepEqual(nco.body.instances[0].billets, [], 'no list to choose from for one who cannot set it');
  assert.equal((await put(charlie.token, `/api/org/units/G8/members/${alpha.id}`, { checked_in_on: '2026-01-01' })).status, 403);

  // A Unit Manager manages members without reading records (ADR-0010): account and history, no counts.
  const um = await get(manager.token, `/api/org/team/${alpha.id}/personnel`);
  assert.equal(um.status, 200, JSON.stringify(um.body));
  assert.ok(um.body.account);
  assert.ok(um.body.history);
  assert.equal(um.body.records, null);
  assert.equal(um.body.canOpenRecords, false);
  assert.equal(um.body.instances[0].canManage, true);
  assert.equal((await get(manager.token, `/api/org/team/${alpha.id}`)).status, 403, 'and their records stay closed to them');
  const set = await put(manager.token, `/api/org/units/G8/members/${alpha.id}`, { assignment_end: '2027-10-31' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  // They correct a rank too, which now takes managing the Marine rather than reading their records.
  const rank = await put(manager.token, `/api/org/team/${alpha.id}/profile`, { rank_id: 'Cpl' });
  assert.equal(rank.status, 200, JSON.stringify(rank.body));
  const changed = events(alpha.id, 'rank').at(-1)!;
  assert.equal(changed.to_value, 'Cpl'); assert.equal(changed.source, 'leader'); assert.equal(changed.actor_id, manager.id);
  assert.equal(changed.org_id, null, 'a rank is the person’s wherever they serve');

  // A plain member sees nobody's record but their own; another Unit Instance sees nothing of G8's Marines.
  assert.equal((await get(delta.token, `/api/org/team/${alpha.id}/personnel`)).status, 403);
  assert.equal((await get(g1lead.token, `/api/org/team/${alpha.id}/personnel`)).status, 403);
  assert.equal((await put(g1lead.token, `/api/org/units/G8/members/${alpha.id}`, { checked_in_on: '2026-01-01' })).status, 403);
  assert.equal((await get(op.token, '/api/org/team/no-such-person/personnel')).status, 404);
});

test('nobody changes their own assignment, nor that of someone at or above them', async () => {
  const own = await put(alpha.token, `/api/org/units/G8/members/${alpha.id}`, { supervisor_id: delta.id });
  assert.equal(own.status, 403);
  const mine = await put(manager.token, `/api/org/units/G8/members/${manager.id}`, { checked_in_on: '2026-10-01' });
  assert.equal(mine.status, 403); assert.equal(mine.body.code, 'self_membership_change');
  // A Unit Manager sits at the unit leader's position, not above it.
  const up = await put(manager.token, `/api/org/units/G8/members/${op.id}`, { checked_in_on: '2026-10-01' });
  assert.equal(up.status, 403); assert.equal(up.body.code, 'hierarchy');
  // A Marine may still type their own billet, as before; it carries no list link.
  const sncoic = await person('sncoic', 'G8', 'sncoic');
  const typed = await put(sncoic.token, `/api/org/units/G8/members/${sncoic.id}`, { billet: 'Admin Chief' });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.equal(events(sncoic.id).length, 0, 'a billet title is membership history, not a personnel event');
});

test('a supervisor is someone else in the same Unit Instance, and supervision never loops', async () => {
  const self = await put(op.token, `/api/org/units/G8/members/${delta.id}`, { supervisor_id: delta.id });
  assert.equal(self.status, 400); assert.equal(self.body.code, 'supervisor_self');
  const outside = await put(op.token, `/api/org/units/G8/members/${delta.id}`, { supervisor_id: g1member.id });
  assert.equal(outside.status, 400); assert.equal(outside.body.code, 'supervisor_outside');
  // Alpha answers to Charlie; Charlie cannot answer to Alpha, nor to anyone who answers to Alpha.
  assert.equal((await put(op.token, `/api/org/units/G8/members/${delta.id}`, { supervisor_id: alpha.id })).status, 200);
  const loop = await put(op.token, `/api/org/units/G8/members/${charlie.id}`, { supervisor_id: delta.id });
  assert.equal(loop.status, 400); assert.equal(loop.body.code, 'supervisor_cycle');
  const dates = await put(op.token, `/api/org/units/G8/members/${delta.id}`, { assignment_start: '2026-10-01', assignment_end: '2026-09-01' });
  assert.equal(dates.status, 400); assert.ok(dates.body.fieldErrors.assignment_end);
  const notDay = await put(op.token, `/api/org/units/G8/members/${delta.id}`, { checked_in_on: '2026-02-30' });
  assert.equal(notDay.status, 400);
  const otherBillet = await put(op.token, `/api/org/units/G8/members/${delta.id}`, { billet_id: g1BilletId });
  assert.equal(otherBillet.status, 400); assert.ok(otherBillet.body.fieldErrors.billet_id, 'a billet of another Unit Instance is not on this unit’s list');
  // However far up the loop would close: a chain of eleven supervisors above the one named.
  const chain: Person[] = [];
  for (let i = 0; i < 12; i++) chain.push(await person(`chain${i}`, 'G8'));
  const link = db().prepare("INSERT INTO personnel_records (org_id, user_id, supervisor_id, updated_at) VALUES ('G8', ?, ?, '2026-10-22T00:00:00Z')");
  for (let i = 1; i < chain.length; i++) link.run(chain[i].id, chain[i - 1].id);
  const far = await put(op.token, `/api/org/units/G8/members/${chain[0].id}`, { supervisor_id: chain[11].id });
  assert.equal(far.status, 400, JSON.stringify(far.body)); assert.equal(far.body.code, 'supervisor_cycle');
  // Candidates are members of this Unit Instance the reader can see, never the Marine themselves.
  const found = await get(op.token, `/api/org/units/G8/supervisor-candidates?q=ch&except=${delta.id}`);
  assert.equal(found.status, 200);
  assert.ok(found.body.results.some((p: any) => p.id === charlie.id));
  assert.ok(!(await get(op.token, '/api/org/units/G8/supervisor-candidates?q=gone')).body.results.length, 'nobody from another Unit Instance');
  assert.equal((await get(charlie.token, '/api/org/units/G8/supervisor-candidates?q=al')).status, 403);
});

test('responsibilities are added and ended by those who manage the Marine, never deleted, and grant nothing', async () => {
  const add = await post(op.token, `/api/org/units/G8/members/${delta.id}/responsibilities`, { title: 'Safety NCO', starts_on: '2026-10-01', reason: 'Appointment letter' });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  const twice = await post(op.token, `/api/org/units/G8/members/${delta.id}/responsibilities`, { title: 'safety nco' });
  assert.equal(twice.status, 409); assert.equal(twice.body.code, 'duplicate_responsibility');
  assert.equal((await post(delta.token, `/api/org/units/G8/members/${delta.id}/responsibilities`, { title: 'Voting Officer' })).status, 403);
  assert.equal((await post(charlie.token, `/api/org/units/G8/members/${delta.id}/responsibilities`, { title: 'Voting Officer' })).status, 403);
  const permissionsBefore = (await get(delta.token, '/api/me')).body.permissions;
  const read = await get(delta.token, `/api/org/team/${delta.id}/personnel`);
  assert.deepEqual(read.body.instances[0].responsibilities.map((r: any) => r.title), ['Safety NCO']);
  assert.deepEqual((await get(delta.token, '/api/me')).body.permissions, permissionsBefore);
  assert.ok(audits('add_responsibility').some((a) => a.subject_id === delta.id));

  assert.equal((await post(charlie.token, `/api/org/responsibilities/${add.body.id}/end`, {})).status, 403);
  assert.equal((await post(g1lead.token, `/api/org/responsibilities/${add.body.id}/end`, {})).status, 404, 'another Unit Instance does not learn it exists');
  const ended = await post(op.token, `/api/org/responsibilities/${add.body.id}/end`, { reason: 'Rotated' });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal((await post(op.token, `/api/org/responsibilities/${add.body.id}/end`, {})).status, 409);
  const row = db().prepare('SELECT * FROM personnel_responsibilities WHERE id = ?').get(add.body.id) as Record<string, any>;
  assert.ok(row.ended_at); assert.equal(row.ended_by, op.id);
  assert.ok(audits('end_responsibility').some((a) => a.entity_id === add.body.id));
  // An ended one stays in the history of those who may see it, and drops off the roster.
  assert.ok((await get(op.token, `/api/org/team/${delta.id}/personnel`)).body.instances[0].responsibilities.some((r: any) => r.ended_at));
  assert.ok(!(await get(charlie.token, `/api/org/team/${delta.id}/personnel`)).body.instances[0].responsibilities.length);
});

test('the personnel roster puts each Marine on their own team once, with status only for those the reader manages', async () => {
  const res = await get(op.token, '/api/org/units/G8/personnel');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = res.body.rows as Array<Record<string, any>>;
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'each Marine once');
  const b = rows.find((r) => r.id === bravo.id)!;
  assert.equal(b.team_label, 'BUD', 'on their own team beneath the unit');
  assert.equal(b.status, 'active');
  assert.equal(rows.find((r) => r.id === alpha.id)!.supervisor.id, charlie.id);
  assert.equal(res.body.canManage, true);
  assert.ok(audits('view_roster').some((a) => a.actor_id === op.id && /personnel/.test(a.detail)));

  const nco = await get(charlie.token, '/api/org/units/G8/personnel');
  assert.equal(nco.status, 200);
  assert.equal(nco.body.canManage, false);
  assert.ok(nco.body.rows.filter((r: any) => !r.self).every((r: any) => r.status === undefined), 'no account status for those they do not manage');
  assert.deepEqual(nco.body.billets, []);
  assert.equal((await get(manager.token, '/api/org/units/G8/personnel')).status, 200, 'a Unit Manager has the roster');
  assert.equal((await get(delta.token, '/api/org/units/G8/personnel')).status, 403);
  assert.equal((await get(g1lead.token, '/api/org/units/G8/personnel')).status, 403);
});

test('a bulk change is previewed, applied all or nothing, audited as one batch and row by row', async () => {
  const bud = db().prepare("SELECT id FROM units WHERE short_name = 'BUD'").pluck().get() as string;
  const items = [{ user_id: alpha.id, unit_id: 'G8' }, { user_id: bravo.id, unit_id: bud }];
  const preview = await post(op.token, '/api/org/units/G8/personnel/bulk', { items, action: 'checked_in', value: '2026-10-15', dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.applied, false); assert.equal(preview.body.refused, 0);
  assert.ok(preview.body.results.every((r: any) => r.ok && r.changed.includes('checked_in')));
  assert.equal(record(alpha.id)!.checked_in_on, '2026-09-28', 'a preview changes nothing');
  assert.equal(record(bravo.id), undefined);

  const applied = await post(op.token, '/api/org/units/G8/personnel/bulk', { items, action: 'checked_in', value: '2026-10-15', reason: 'Reorganization' });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.applied, true);
  const batch = applied.body.batch_id;
  assert.ok(batch);
  assert.equal(record(alpha.id)!.checked_in_on, '2026-10-15');
  assert.equal(record(bravo.id)!.checked_in_on, '2026-10-15');
  for (const id of [alpha.id, bravo.id]) {
    const e = events(id, 'checked_in').at(-1)!;
    assert.equal(e.batch_id, batch); assert.equal(e.reason, 'Reorganization'); assert.equal(e.actor_id, op.id);
  }
  assert.ok(audits('personnel_bulk').some((a) => a.detail.includes(batch)));
  assert.equal(audits('edit_membership').filter((a) => a.detail.includes(`bulk ${batch}`)).length, 2, 'each Marine as their single change');

  // One refused row and nothing is applied: here, the actor among the Marines they change.
  const mixed = await post(op.token, '/api/org/units/G8/personnel/bulk', { items: [{ user_id: delta.id, unit_id: 'G8' }, { user_id: op.id, unit_id: 'G8' }], action: 'assignment_end', value: '2027-12-31' });
  assert.equal(mixed.status, 409); assert.equal(mixed.body.code, 'bulk_refused'); assert.equal(mixed.body.refused, 1);
  assert.equal(mixed.body.results.find((r: any) => r.user_id === op.id).code, 'self_membership_change');
  assert.notEqual(member(delta.id, 'G8')!.assignment_end, '2027-12-31', 'the row that passed was rolled back with the one that did not');

  const twice = await post(op.token, '/api/org/units/G8/personnel/bulk', { items: [items[0], items[0]], action: 'checked_in', value: null });
  assert.equal(twice.status, 400); assert.equal(twice.body.code, 'duplicate_row');
  assert.equal((await post(op.token, '/api/org/units/G8/personnel/bulk', { items, action: 'checked_in', value: '15 Oct' })).status, 400);
  assert.equal((await post(charlie.token, '/api/org/units/G8/personnel/bulk', { items, action: 'checked_in', value: null })).status, 403);
  // The view bounds who is changed: Alpha is not in the Budget Section.
  const outside = await post(op.token, `/api/org/units/${bud}/personnel/bulk`, { items: [items[0]], action: 'checked_in', value: null });
  assert.equal(outside.status, 409); assert.equal(outside.body.results[0].code, 'outside_view');

  // A billet from the list, a responsibility, and a move, each as its single change would be.
  const billet = await post(op.token, '/api/org/units/G8/personnel/bulk', { items: [items[0]], action: 'billet', value: billetId });
  assert.equal(billet.status, 200, JSON.stringify(billet.body));
  const resp = await post(op.token, '/api/org/units/G8/personnel/bulk', { items, action: 'responsibility', value: 'Voting Assistance Officer' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal((db().prepare("SELECT COUNT(*) FROM personnel_responsibilities WHERE title = 'Voting Assistance Officer' AND ended_at IS NULL").pluck().get() as number), 2);
  const dsb = db().prepare("SELECT id FROM units WHERE short_name = 'DSB'").pluck().get() as string;
  const moved = await post(op.token, '/api/org/units/G8/personnel/bulk', { items: [items[1]], action: 'move', value: dsb });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.ok(member(bravo.id, dsb)); assert.equal(member(bravo.id, bud), undefined);
  assert.equal(record(bravo.id)!.checked_in_on, '2026-10-15', 'a move between teams keeps the record of the Unit Instance');
  assert.ok(audits('move_member').some((a) => a.subject_id === bravo.id && a.detail.includes('bulk')));
});

test('leaving the Unit Instance ends the record there: supervisor, check-in, responsibilities, and those they supervised', async () => {
  const echo = await person('echo', 'G8');
  const foxtrot = await person('foxtrot', 'G8');
  assert.equal((await put(op.token, `/api/org/units/G8/members/${echo.id}`, { supervisor_id: charlie.id, checked_in_on: '2026-08-01' })).status, 200);
  assert.equal((await put(op.token, `/api/org/units/G8/members/${foxtrot.id}`, { supervisor_id: echo.id })).status, 200);
  assert.equal((await post(op.token, `/api/org/units/G8/members/${echo.id}/responsibilities`, { title: 'Key Control Custodian' })).status, 201);
  const removed = await call('DELETE', op.token, `/api/org/units/G8/members/${echo.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.responsibilitiesEnded, 1);
  assert.equal(removed.body.supervisionsEnded, 1);
  assert.equal(record(echo.id)!.supervisor_id, null); assert.equal(record(echo.id)!.checked_in_on, null);
  assert.equal(record(foxtrot.id)!.supervisor_id, null);
  const left = db().prepare('SELECT * FROM personnel_responsibilities WHERE user_id = ?').get(echo.id) as Record<string, any>;
  assert.ok(left.ended_at); assert.equal(left.end_reason, 'left');
  assert.ok(events(echo.id, 'supervisor').some((e) => e.source === 'departure' && e.to_value === null));
  assert.ok(events(foxtrot.id, 'supervisor').some((e) => e.source === 'departure' && e.reason === 'Their supervisor left the Unit Instance'));
});

test('the history names every path that changes a personnel fact: the Marine, Vantage support, and a script', async () => {
  assert.equal((await put(delta.token, '/api/me/profile', { mos: '3451' })).status, 200);
  const mos = events(delta.id, 'mos').at(-1)!;
  assert.equal(mos.source, 'self'); assert.equal(mos.actor_id, delta.id);
  // Vantage support deactivates and reactivates an account; both are in the history, with the reason given.
  const golf = await person('golf', 'G8');
  const off = await post(op.token, `/api/platform/accounts/${golf.id}/deactivate`, { reason: 'Separated, awaiting the roster' });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await post(op.token, `/api/platform/accounts/${golf.id}/reactivate`)).status, 200);
  assert.deepEqual(events(golf.id, 'account').map((e) => [e.to_value, e.source, e.actor_id, e.reason]), [['deactivated', 'support', op.id, 'Separated, awaiting the roster'], ['active', 'support', op.id, null]]);
  // A change nobody names, made outside the service, is still in the history, without an actor.
  db().prepare("UPDATE users SET eas = '2030-01-01' WHERE id = ?").run(delta.id);
  const eas = events(delta.id, 'eas').at(-1)!;
  assert.equal(eas.to_value, '2030-01-01'); assert.equal(eas.actor_id, null); assert.equal(eas.source, null);
  // A leader reads the person's changes since they joined the leader's command, without the name of who made one.
  const seen = await get(op.token, `/api/org/team/${delta.id}/personnel`);
  const shown = seen.body.history.events.find((e: any) => e.field === 'mos');
  assert.ok(shown); assert.equal(shown.actor, null);
});

test('the database keeps a billet, a responsibility and a supervisor inside their Unit Instance', () => {
  assert.throws(() => db().prepare('UPDATE unit_members SET billet_id = ? WHERE user_id = ? AND unit_id = ?').run(g1BilletId, alpha.id, 'G8'), /cross_instance/);
  assert.throws(() => db().prepare("INSERT INTO personnel_records (org_id, user_id, supervisor_id, updated_at) VALUES ('G8', ?, ?, '2026-10-22T00:00:00Z')").run(delta.id, g1member.id), /cross_instance/);
  assert.throws(() => db().prepare("UPDATE personnel_records SET supervisor_id = ? WHERE user_id = ? AND org_id = 'G8'").run(g1member.id, alpha.id), /cross_instance/);
  assert.throws(() => db().prepare("INSERT INTO personnel_responsibilities (id, org_id, user_id, unit_id, title, created_at) VALUES ('r-x', 'G8', ?, 'G1', 'Across', '2026-10-22T00:00:00Z')").run(alpha.id), /cross_instance/);
  assert.throws(() => db().prepare('UPDATE unit_billets SET org_id = ? WHERE id = ?').run('G1', billetId), /cross_instance/, 'nor does a billet move instances under its holders');
  assert.deepEqual(Object.fromEntries(Object.entries(instanceBoundaryViolations(db())).filter(([, n]) => n)), {});
});

test('what the personnel feed sets, a leader cannot change either, and the feed’s changes are in the history', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const marine = await fresh.register('feedmarine');
    await enroll(fresh, owner.token, 'G8', marine.id);
    fresh.ctx.db.prepare("UPDATE users SET edipi = '9876543210', rank_id = 'PFC' WHERE id = ?").run(marine.id);
    const roster = 'DoD ID,Last,First,MI,Grade,PMOS,EAS,RUC,Status\n9876543210,Marine,Feedmarine,,LCpl,0311,2026-11-01,G8,Active';
    const synced = await fresh.call('POST', '/api/orgs/G8/personnel/sync?source=MCTFS&apply=1', { token: owner.token, raw: Buffer.from(roster), headers: { 'content-type': 'text/plain' } });
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    const rank = fresh.ctx.db.prepare("SELECT * FROM personnel_events WHERE user_id = ? AND field = 'rank' ORDER BY id DESC").get(marine.id) as Record<string, any>;
    assert.equal(rank.to_value, 'LCpl'); assert.equal(rank.source, 'feed'); assert.match(rank.reason, /MCTFS/);
    const refused = await fresh.call('PUT', `/api/org/team/${marine.id}/profile`, { token: owner.token, body: { rank_id: 'Cpl' } });
    assert.equal(refused.status, 400); assert.equal(refused.body.code, 'field_is_sourced');
    const record = await fresh.call('GET', `/api/org/team/${marine.id}/personnel`, { token: owner.token });
    assert.ok(record.body.sourced.includes('rank_id'));
    // The same value is not a change, so a form that sends every field back is not refused for it.
    assert.equal((await fresh.call('PUT', `/api/org/team/${marine.id}/profile`, { token: owner.token, body: { rank_id: 'LCpl', middle_initial: 'Q' } })).status, 200);

    // A separation the feed makes and a later extract undoes gives back what leadership had entered: the billet from the
    // list, the assignment dates, the supervisor and the check-in.
    const billet = await fresh.call('POST', '/api/orgs/G8/billets', { token: owner.token, body: { title: 'Rifleman' } });
    assert.equal(billet.status, 201, JSON.stringify(billet.body));
    const set = await fresh.call('PUT', `/api/org/units/G8/members/${marine.id}`, { token: owner.token, body: { billet_id: billet.body.id, assignment_start: '2026-06-01', assignment_end: '2028-05-31', supervisor_id: owner.id, checked_in_on: '2026-05-28' } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const extract = (status: string) => fresh.call('POST', '/api/orgs/G8/personnel/sync?source=MCTFS&apply=1&confirm_separations=1', {
      token: owner.token, raw: Buffer.from(`DoD ID,Last,First,MI,Grade,PMOS,EAS,RUC,Status\n9876543210,Marine,Feedmarine,Q,LCpl,0311,2026-11-01,G8,${status}`), headers: { 'content-type': 'text/plain' },
    });
    assert.equal((await extract('Separated')).status, 200);
    const membership = () => fresh.ctx.db.prepare("SELECT * FROM unit_members WHERE user_id = ? AND unit_id = 'G8'").get(marine.id) as Record<string, any> | undefined;
    const kept = () => fresh.ctx.db.prepare("SELECT * FROM personnel_records WHERE org_id = 'G8' AND user_id = ?").get(marine.id) as Record<string, any>;
    assert.equal(membership(), undefined);
    assert.equal(kept().supervisor_id, null);
    assert.equal((await extract('Active')).status, 200);
    const back = membership()!;
    assert.ok(back, 'back in the unit');
    assert.deepEqual([back.billet, back.billet_id, back.assignment_start, back.assignment_end], ['Rifleman', billet.body.id, '2026-06-01', '2028-05-31']);
    assert.deepEqual([kept().supervisor_id, kept().checked_in_on], [owner.id, '2026-05-28']);
    const restored = fresh.ctx.db.prepare("SELECT * FROM personnel_events WHERE user_id = ? AND field = 'supervisor' ORDER BY id DESC").get(marine.id) as Record<string, any>;
    assert.equal(restored.to_value, owner.id); assert.equal(restored.source, 'feed');
  } finally { await fresh.close(); }
});

test('a responsibility from a team the Marine has since left is ended by whoever manages them now', async () => {
  // Bravo was given Voting Assistance Officer in the Budget Section, then moved to Disbursing (the bulk test above).
  const read = await get(op.token, `/api/org/team/${bravo.id}/personnel`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const vao = read.body.instances[0].responsibilities.find((r: any) => r.title === 'Voting Assistance Officer');
  const bud = db().prepare("SELECT id FROM units WHERE short_name = 'BUD'").pluck().get() as string;
  assert.equal(vao.unit_id, bud);
  assert.ok(!member(bravo.id, bud), 'no longer in the unit the responsibility names');
  assert.equal(vao.canEnd, true, 'the End control is offered');
  // The move signed Bravo out, as a change of unit does.
  const own = await get(await login('bravo'), `/api/org/team/${bravo.id}/personnel`);
  assert.equal(own.body.instances[0].responsibilities.find((r: any) => r.id === vao.id).canEnd, false, 'not to the Marine');
  const ended = await post(op.token, `/api/org/responsibilities/${vao.id}/end`, {});
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
});

test('a deactivated account stays on the roster and record of those who manage it, marked so; a passkey counts as a second factor', async () => {
  const hotel = await person('hotel', 'G8');
  assert.equal((await post(op.token, `/api/platform/accounts/${hotel.id}/deactivate`, { reason: 'Awaiting separation orders' })).status, 200);
  const read = await get(op.token, `/api/org/team/${hotel.id}/personnel`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.account.status, 'deactivated');
  assert.equal(read.body.canOpenRecords, false, 'the records route serves active accounts only');
  assert.equal(read.body.records, null);
  const row = (await get(op.token, '/api/org/units/G8/personnel')).body.rows.find((r: any) => r.id === hotel.id);
  assert.equal(row?.status, 'deactivated');
  assert.equal(row.canOpenRecords, false);
  // To a reader who does not manage them, the account is gone, as everywhere else.
  assert.equal((await get(charlie.token, `/api/org/team/${hotel.id}/personnel`)).status, 404);
  assert.ok(!(await get(charlie.token, '/api/org/units/G8/personnel')).body.rows.some((r: any) => r.id === hotel.id));
  // Their manager can still change their assignment, and remove them.
  assert.equal((await put(op.token, `/api/org/units/G8/members/${hotel.id}`, { assignment_end: '2026-12-31' })).status, 200);

  assert.equal((await get(op.token, `/api/org/team/${delta.id}/personnel`)).body.account.mfa, false);
  db().prepare("INSERT INTO passkeys (id, user_id, public_key, name, created_at) VALUES ('pk-delta', ?, x'00', 'YubiKey', '2026-10-22T00:00:00Z')").run(delta.id);
  assert.equal((await get(op.token, `/api/org/team/${delta.id}/personnel`)).body.account.mfa, true);
});

test('the personal export carries the personnel record, its responsibilities and its history', async () => {
  const json = await get(alpha.token, '/api/me/export?format=json');
  assert.equal(json.status, 200, JSON.stringify(json.body).slice(0, 300));
  const archive = json.body;
  const g8 = archive.memberships.find((m: any) => m.unit_id === 'G8');
  assert.equal(g8.billet_id, billetId); assert.equal(g8.assignment_start, '2026-10-01');
  assert.deepEqual(archive.personnel.records.map((r: any) => [r.org_id, r.supervisor, r.checked_in_on]), [['G8', 'charlie', '2026-10-15']]);
  assert.ok(archive.personnel.responsibilities.some((r: any) => r.title === 'Voting Assistance Officer' && r.assigned_by === 'boletz'));
  assert.ok(archive.personnel.history.some((e: any) => e.field === 'supervisor' && e.actor === 'boletz' && e.reason === 'PCS orders'));
  assert.equal(archive.counts.personnel_history, archive.personnel.history.length);
  const zip = await app.call('GET', '/api/me/export?format=zip', { token: alpha.token, binary: true });
  assert.equal(zip.status, 200);
  const names = listZip(zip.buffer as Buffer);
  for (const name of ['personnel-records.csv', 'responsibilities.csv', 'personnel-history.csv']) assert.ok(names.includes(name), name);
});
