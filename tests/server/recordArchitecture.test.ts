import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { RECORD_KINDS, MOVABLE_TABLES, isDrawnFromWork, recordKindOf, type TimelineItem } from '../../shared/recordKinds.ts';
import { RECORD_TABLE_NAMES, purgeDeleted } from '../../server/services/records.ts';
import { moveProblem } from '../../server/services/recordMoves.ts';
import { placeHold, releaseHold, runDisposition, saveSchedule } from '../../server/services/retention.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { openDatabase, migrationHistory, SCHEMA_VERSION } from '../../server/db/index.ts';
import { listZip } from '../../server/lib/zip.ts';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { REDACTED } from '../../shared/constants.ts';

/**
 * Task 9: each record kind keeps its own store (ADR-0015). An Activity sits on the timeline beside awards, training,
 * counselings and goals, and never stands in for one. An entry that was really an award or a course moves, by its
 * owner only, with its lineage kept and an undo; nothing moves on an upgrade.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
/** The Marine whose entries move. */
let rivera: { token: string; id: string };
/** An SNCO: reads and corrects shared records, counsels. */
let nguyen: { token: string; id: string };
/** A fire team leader: counsels and recommends awards, but cannot correct others' records. */
let diaz: { token: string; id: string };
/** Marines of G8 whose candidates and timeline are checked whole. */
let okafor: { token: string; id: string };
let lopez: { token: string; id: string };
/** In no unit at all. */
let outsider: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;

async function made(token: string, table: string, body: Record<string, unknown>) {
  const res = await post(token, `/api/records/${table}`, body);
  assert.equal(res.status, 201, `${table}: ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
const entry = (token: string, body: Record<string, unknown>) => made(token, 'activities', body);
const rowOf = (table: string, id: string) => app.ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, any> | undefined;
const lineageOf = (...ids: string[]) => app.ctx.db.prepare(`SELECT * FROM record_lineage WHERE from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`)
  .all(JSON.stringify(ids), JSON.stringify(ids)) as Array<Record<string, any>>;
const move = (token: string, table: string, id: string, body: Record<string, unknown>) => post(token, `/api/records/${table}/${id}/move`, body);
const undo = (token: string, table: string, id: string) => post(token, `/api/records/${table}/${id}/undo-move`);
const longAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  app.ctx.runtime.attachmentsEnabled = true;
  rivera = await app.register('rivera');
  nguyen = await app.register('nguyen', { rank_id: 'SSgt', last_name: 'Nguyen' });
  diaz = await app.register('diaz', { rank_id: 'Sgt', last_name: 'Diaz' });
  okafor = await app.register('okafor');
  lopez = await app.register('lopez');
  outsider = await app.register('outsider');
  await enroll(app, op.token, 'G8', rivera.id);
  await enroll(app, op.token, 'G8', nguyen.id, 'snco');
  await enroll(app, op.token, 'G8', diaz.id, 'fire-team-leader');
  await enroll(app, op.token, 'G8', okafor.id);
  await enroll(app, op.token, 'G8', lopez.id);
  // Enrollment revokes sessions so the new authority is picked up.
  for (const [name, who] of [['rivera', rivera], ['nguyen', nguyen], ['diaz', diaz], ['okafor', okafor], ['lopez', lopez]] as const) who.token = await login(name);
});
after(async () => { await app.close(); });

// ---------------------------------------------------------------------------------------------------------------------
// The registry

test('the registry: one entry per key, and every store it names is a table in the schema', () => {
  const keys = RECORD_KINDS.map((k) => k.key);
  assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);
  const tables = new Set((app.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name));
  for (const kind of RECORD_KINDS) {
    if (kind.store) assert.ok(tables.has(kind.store.table), `${kind.key} lives in ${kind.store.table}, which the schema does not have`);
    else assert.ok(kind.plannedIn, `${kind.key} has no store, so it names the Task that builds it`);
  }
  // Only work a person did is an Activity, and only the Activity kind is stored in activities.
  assert.deepEqual(RECORD_KINDS.filter((k) => k.activity).map((k) => k.key), ['activity']);
  assert.deepEqual(RECORD_KINDS.filter((k) => k.store?.table === 'activities').map((k) => k.key), ['activity']);
  // The record types an entry moves between are each some kind's store.
  for (const table of MOVABLE_TABLES) assert.ok(RECORD_KINDS.some((k) => k.store?.table === table), `${table} is a movable table no kind names`);
});

test('the registry names the store of every record type the records API serves', () => {
  const named = new Set(RECORD_KINDS.map((k) => k.store?.table).filter(Boolean));
  const missing = RECORD_TABLE_NAMES.filter((t) => !named.has(t));
  assert.deepEqual(missing, [], `record tables no kind names: ${missing.join(', ')}`);
});

test('the registry: every timeline kind with a store is read from a table the timeline reads', () => {
  const timelineTables: Array<TimelineItem['table']> = ['activities', 'trainings', 'awards', 'counselings', 'goals'];
  for (const kind of RECORD_KINDS.filter((k) => k.timeline && k.store)) {
    assert.ok((timelineTables as string[]).includes(kind.store!.table), `${kind.key} is on the timeline, but the timeline does not read ${kind.store!.table}`);
  }
  // The timeline's kinds without a store are the ones it says are coming.
  assert.deepEqual(RECORD_KINDS.filter((k) => k.timeline && !k.store).map((k) => k.key), ['duty']);
});

// ---------------------------------------------------------------------------------------------------------------------
// The classifier

test('the classifier reads an award received or training completed, and leaves work done for others an Activity', async (t) => {
  type Expected = { kind: 'award'; type: string; name?: string | null } | { kind: 'training'; type: string } | null;
  const cases: Array<[string, Expected, { todo?: string }?]> = [
    // Awards received.
    ['Received the Navy and Marine Corps Achievement Medal', { kind: 'award', type: 'personal_award', name: 'Navy and Marine Corps Achievement Medal' }],
    ['Awarded a NAM', { kind: 'award', type: 'personal_award', name: 'Navy and Marine Corps Achievement Medal' }],
    ['Meritorious mast from the CO', { kind: 'award', type: 'meritorious_mast' }],
    ['Received a meritorious mast from the CO', { kind: 'award', type: 'meritorious_mast', name: 'Meritorious Mast' }],
    ['Was presented a Certificate of Commendation', { kind: 'award', type: 'certificate', name: 'Certificate of Commendation' }],
    ['Received a Letter of Appreciation from the CG', { kind: 'award', type: 'loa', name: 'Letter of Appreciation' }],
    ['Received the Meritorious Unit Commendation', { kind: 'award', type: 'unit_award', name: 'Meritorious Unit Commendation' }],
    ['Coined by the Sergeant Major', { kind: 'award', type: 'coin', name: null }],
    // Training completed.
    ['Completed Corporals Course', { kind: 'training', type: 'pme' }],
    ['Finished MarineNet course X', { kind: 'training', type: 'course' }],
    ['Earned Security+ certification', { kind: 'training', type: 'certification' }],
    ['Completed Sergeants Course', { kind: 'training', type: 'pme' }],
    ['Completed bachelor’s degree in accounting', { kind: 'training', type: 'education' }],
    // Work, which stays an Activity.
    ['Drafted 3 award packages for my Marines', null],
    ['Processed a NAM for LCpl Diaz', null],
    ['Presented the NAM to LCpl Diaz', null],
    ['Taught MCMAP to 12 Marines', null],
    ['Fired rifle qualification', null],
    ['Completed rifle qualification at the range', null],
    ['Passed the PFT with a 285', null],
    ['Reconciled LOA lines', null],
    ['Reconciled 40 LOA lines for FY26', null],
    ['', null],
  ];
  for (const [text, expected, opts] of cases) {
    await t.test(JSON.stringify(text), { todo: opts?.todo }, () => {
      const reading = recordKindOf(text);
      if (!expected) { assert.equal(reading, null, `${text} stays an activity: ${JSON.stringify(reading)}`); return; }
      assert.ok(reading, `${text} reads as ${expected.kind}`);
      assert.equal(reading.kind, expected.kind);
      assert.equal(reading.type, expected.type);
      if (expected.kind === 'award' && 'name' in expected) assert.equal((reading as { name: string | null }).name, expected.name);
      assert.ok(reading.why.length > 0, 'it says why');
    });
  }
  assert.equal(recordKindOf(null), null);
  assert.equal(recordKindOf(undefined), null);
});

test('what is drawn from a financial case is told by its fingerprint', () => {
  for (const fp of ['work:item-1', 'case:DOC-42', 'draft:abc']) assert.equal(isDrawnFromWork(fp), true, fp);
  for (const fp of ['3f9a0c', '', null, undefined, 42, 'works:x']) assert.equal(isDrawnFromWork(fp), false, String(fp));
});

// ---------------------------------------------------------------------------------------------------------------------
// Moves

/** The entry the move, lineage and undo tests share, and where it went. */
const nam: { source?: Record<string, any>; awardId?: string } = {};

test('an owner moves an activity to Awards: fields map, it takes a new id, its files and comments follow, the old row goes, and lineage keeps it', async () => {
  const source = await entry(rivera.token, {
    title: 'Received the Navy and Marine Corps Achievement Medal', date: '2026-05-01', result: 'For FY25 budget execution', quantity: 1, dollar_amount: 2500,
    visibility: 'unit', unit_id: 'G8', evidence_links: [{ label: 'citation', url: 'https://example.mil/c/1' }],
  });
  nam.source = source;
  const file = await app.call('POST', `/api/records/activities/${source.id}/attachments`, { token: rivera.token, raw: Buffer.from('NAM citation'), headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'citation.txt' } });
  assert.equal(file.status, 201, JSON.stringify(file.body));
  assert.equal((await post(rivera.token, `/api/records/activities/${source.id}/comments`, { body: 'Citation attached.' })).status, 201);
  assert.equal((await post(nguyen.token, `/api/records/activities/${source.id}/comments`, { body: 'Well earned.' })).status, 201);

  const moved = await move(rivera.token, 'activities', source.id, { to: 'awards', reason: 'This was my NAM, not work I did.', version: source.version });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(moved.body.table, 'awards');
  assert.notEqual(moved.body.id, source.id, 'it takes a new id in its new type');
  assert.equal(typeof moved.body.lineage_id, 'string');
  nam.awardId = moved.body.id;

  const award = moved.body.record;
  assert.equal(award.id, moved.body.id);
  assert.equal(award.name, 'Navy and Marine Corps Achievement Medal');
  assert.equal(award.type, 'personal_award');
  assert.equal(award.status, 'presented');
  assert.equal(award.date, '2026-05-01');
  assert.equal(award.presented_at, '2026-05-01');
  assert.match(award.notes, /For FY25 budget execution/);
  assert.match(award.notes, /https:\/\/example\.mil\/c\/1/, 'evidence links carry into the notes');
  assert.equal(award.user_id, rivera.id);
  assert.equal(award.unit_id, 'G8');
  assert.equal(award.visibility, 'unit');
  assert.equal(award.recorded_by, rivera.id, 'an award its owner moves in is their own');
  assert.equal(award.created_at, source.created_at, 'it keeps when it was first recorded');

  // The activity is gone from Activities, not hidden.
  assert.equal(rowOf('activities', source.id), undefined);
  assert.equal((await get(rivera.token, `/api/records/activities/${source.id}`)).status, 404);
  assert.ok(!(await get(rivera.token, '/api/records/activities')).body.some((r: any) => r.id === source.id));
  assert.ok((await get(rivera.token, '/api/records/awards')).body.some((r: any) => r.id === award.id));

  // Its file and both comments, whoever added them, went with it.
  const files = await get(rivera.token, `/api/records/awards/${award.id}/attachments`);
  assert.deepEqual(files.body.attachments.map((f: any) => f.original_name), ['citation.txt']);
  const comments = await get(rivera.token, `/api/records/awards/${award.id}/comments`);
  assert.deepEqual(comments.body.comments.map((c: any) => c.body).sort(), ['Citation attached.', 'Well earned.']);
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE record_table = 'activities' AND record_id = ?").get(source.id) as { n: number }).n, 0);
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE record_table = 'activities' AND record_id = ?").get(source.id) as { n: number }).n, 0);

  // The lineage keeps the row whole, including what Awards has no field for.
  const [lineage, ...more] = lineageOf(source.id);
  assert.equal(more.length, 0);
  assert.equal(lineage.id, moved.body.lineage_id);
  assert.deepEqual({ ...lineage, snapshot: undefined, at: undefined }, {
    id: moved.body.lineage_id, user_id: rivera.id, unit_id: 'G8', from_table: 'activities', from_id: source.id, to_table: 'awards', to_id: award.id,
    snapshot: undefined, method: 'move', reason: 'This was my NAM, not work I did.', moved_by: rivera.id, at: undefined,
  });
  const snapshot = JSON.parse(lineage.snapshot);
  assert.equal(snapshot.id, source.id);
  assert.equal(snapshot.title, source.title);
  assert.equal(snapshot.result, 'For FY25 budget execution');
  assert.equal(snapshot.dollar_amount, 2500, 'a dollar value Awards cannot hold is kept in the snapshot');
  assert.equal(snapshot.version, source.version);

  // The trail of either id says where the entry went or came from.
  const trail = app.ctx.db.prepare("SELECT entity, entity_id, detail, actor_id FROM audit_log WHERE action = 'record_moved' AND entity_id IN (?, ?) ORDER BY seq").all(source.id, award.id) as Array<Record<string, string>>;
  assert.deepEqual(trail.map((r) => ({ ...r })), [
    { entity: 'activities', entity_id: source.id, detail: `to awards ${award.id}`, actor_id: rivera.id },
    { entity: 'awards', entity_id: award.id, detail: `from activities ${source.id}`, actor_id: rivera.id },
  ]);
});

test('lineage: its owner sees what it said before and why; a leader who reads the entry sees only that it moved', async () => {
  assert.ok(nam.awardId, 'the move test ran');
  const path = `/api/records/awards/${nam.awardId}/lineage`;
  const mine = await get(rivera.token, path);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.moves.length, 1);
  const [m] = mine.body.moves;
  assert.equal(m.method, 'move');
  assert.equal(m.from_table, 'activities');
  assert.equal(m.from_id, nam.source!.id);
  assert.equal(m.to_id, nam.awardId);
  assert.equal(m.by_owner, true);
  assert.equal(m.reason, 'This was my NAM, not work I did.');
  assert.equal(m.before.title, nam.source!.title);
  assert.equal(m.before.dollar_amount, 2500);
  assert.deepEqual(mine.body.undo, { from_table: 'activities' });

  // The SNCO and the unit leader read the shared award, so they see the move, and nothing it said before.
  for (const reader of [nguyen, op]) {
    const theirs = await get(reader.token, path);
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.body.moves.length, 1);
    assert.equal(theirs.body.moves[0].by_owner, true);
    assert.ok(!('before' in theirs.body.moves[0]), 'what it said before is its owner’s only');
    assert.ok(!('reason' in theirs.body.moves[0]), 'and so is why it moved');
    assert.equal(theirs.body.undo, null, 'a reader is never offered the undo');
    assert.doesNotMatch(JSON.stringify(theirs.body), /2500|FY25 budget execution/);
  }
  // Someone who cannot read the entry cannot read its lineage.
  assert.equal((await get(outsider.token, path)).status, 403);
  assert.equal((await get(rivera.token, `/api/records/goals/${nam.awardId}/lineage`)).status, 404, 'only movable types have lineage');

  // A private entry's moves are its owner's alone.
  const own = await entry(rivera.token, { title: 'Completed MCI course 0300', date: '2026-03-03', visibility: 'private' });
  const moved = await move(rivera.token, 'activities', own.id, { to: 'trainings' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal((await get(nguyen.token, `/api/records/trainings/${moved.body.id}/lineage`)).status, 403);
});

test('undo puts the entry back under its first id, as it was, with its files and comments; a second undo is refused', async () => {
  assert.ok(nam.awardId && nam.source, 'the move test ran');
  const source = nam.source;
  const snapshot = JSON.parse(lineageOf(source.id)[0].snapshot);

  const undone = await undo(rivera.token, 'awards', nam.awardId);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  assert.equal(undone.body.table, 'activities');
  assert.equal(undone.body.id, source.id, 'it comes back under its original id');

  const restored = rowOf('activities', source.id)!;
  for (const field of ['user_id', 'unit_id', 'visibility', 'date', 'title', 'result', 'quantity', 'dollar_amount', 'evidence_links', 'fingerprint', 'status', 'notes', 'created_at']) {
    assert.deepEqual(restored[field], snapshot[field], `${field} is as it was`);
  }
  assert.equal(restored.version, snapshot.version + 1, 'a client holding the old version sees it changed');
  assert.equal(restored.deleted_at, null);
  assert.ok(restored.kind_confirmed_at, 'moved back, it is work its owner says they did, and is not offered again');
  assert.equal(undone.body.record.title, source.title);
  assert.equal(rowOf('awards', nam.awardId), undefined, 'the award it became is gone');

  const files = await get(rivera.token, `/api/records/activities/${source.id}/attachments`);
  assert.deepEqual(files.body.attachments.map((f: any) => f.original_name), ['citation.txt']);
  const comments = await get(rivera.token, `/api/records/activities/${source.id}/comments`);
  assert.equal(comments.body.comments.length, 2);

  const chain = lineageOf(source.id);
  assert.deepEqual(chain.map((l) => [l.method, l.from_table, l.from_id, l.to_table, l.to_id]), [
    ['move', 'activities', source.id, 'awards', nam.awardId],
    ['undo', 'awards', nam.awardId, 'activities', source.id],
  ]);
  assert.equal(JSON.parse(chain[1].snapshot).name, 'Navy and Marine Corps Achievement Medal', 'the undo keeps the award as it stood');
  const trail = app.ctx.db.prepare("SELECT entity, entity_id FROM audit_log WHERE action = 'record_move_undone' AND entity_id IN (?, ?) ORDER BY seq").all(source.id, nam.awardId) as Array<Record<string, string>>;
  assert.deepEqual(trail.map((r) => [r.entity, r.entity_id]), [['awards', nam.awardId], ['activities', source.id]]);

  // Newest first, and nothing left to undo.
  const lineage = await get(rivera.token, `/api/records/activities/${source.id}/lineage`);
  assert.deepEqual(lineage.body.moves.map((m: any) => m.method), ['undo', 'move']);
  assert.equal(lineage.body.undo, null);
  const again = await undo(rivera.token, 'activities', source.id);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.code, 'nothing_to_undo');
  assert.equal((await undo(rivera.token, 'awards', nam.awardId)).status, 404, 'the award is gone, so there is nothing there to undo');
  assert.equal(lineageOf(source.id).length, 2);
});

test('an owner moves an activity to Training with corrections, and training to Activities', async () => {
  const source = await entry(rivera.token, {
    title: 'Completed Corporals Course', date: '2026-04-10', quantity: 80, unit_label: 'hours', organization: 'Marine Corps University', status: 'completed', notes: 'Distinguished graduate',
  });
  // Corrections take only the new type's own fields: no one moves an entry onto someone else.
  const moved = await move(rivera.token, 'activities', source.id, { to: 'trainings', fields: { hours: 76, user_id: op.id, unit_id: null, bogus: 1 } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(moved.body.table, 'trainings');
  assert.notEqual(moved.body.id, source.id);
  const training = moved.body.record;
  assert.equal(training.title, 'Completed Corporals Course');
  assert.equal(training.type, 'pme');
  assert.equal(training.hours, 76, 'the owner’s correction wins over the mapped 80');
  assert.equal(training.provider, 'Marine Corps University');
  assert.equal(training.status, 'completed');
  assert.equal(training.date, '2026-04-10');
  assert.match(training.notes, /Distinguished graduate/);
  assert.equal(training.user_id, rivera.id);
  assert.equal(training.unit_id, source.unit_id);
  assert.equal(training.visibility, source.visibility);
  assert.equal(rowOf('activities', source.id), undefined);
  assert.equal(lineageOf(source.id)[0].to_table, 'trainings');
  // And back, under its own id.
  const back = await undo(rivera.token, 'trainings', training.id);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.id, source.id);
  assert.equal(rowOf('activities', source.id)!.quantity, 80);
  assert.equal(rowOf('trainings', training.id), undefined);

  // Training that was work the Marine did becomes an activity, fingerprinted as one and not offered back.
  const course = await made(rivera.token, 'trainings', { title: 'Fiscal law refresher', date: '2026-02-02', hours: 4, provider: 'NAVSUP', status: 'completed' });
  const asWork = await move(rivera.token, 'trainings', course.id, { to: 'activities' });
  assert.equal(asWork.status, 201, JSON.stringify(asWork.body));
  const act = asWork.body.record;
  assert.equal(act.title, 'Fiscal law refresher');
  assert.equal(act.category, 'Training & PME');
  assert.equal(act.quantity, 4);
  assert.equal(act.unit_label, 'hours');
  assert.equal(act.organization, 'NAVSUP');
  assert.equal(act.status, 'completed');
  const stored = rowOf('activities', act.id)!;
  assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(stored.kind_confirmed_at);
});

test('only the owner moves an entry, and only one that is theirs alone', async () => {
  const shared = await entry(rivera.token, { title: 'Earned Security+ certification', date: '2026-02-14', visibility: 'unit', unit_id: 'G8' });
  const refused = async (token: string, table: string, id: string, body: Record<string, unknown>, status: number, code?: string) => {
    const res = await move(token, table, id, body);
    assert.equal(res.status, status, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
    if (code) assert.equal(res.body.code, code);
    return res;
  };

  // Not the owner, whatever their authority over the unit; someone who cannot even read it is refused as opening it is.
  for (const other of [nguyen, op, diaz]) await refused(other.token, 'activities', shared.id, { to: 'trainings' }, 403, 'owner_only');
  await refused(outsider.token, 'activities', shared.id, { to: 'trainings' }, 403, 'forbidden');
  // A stale version, the same type, or a type nothing moves to or from.
  await refused(rivera.token, 'activities', shared.id, { to: 'trainings', version: shared.version + 5 }, 409, 'stale');
  await refused(rivera.token, 'activities', shared.id, { to: 'activities' }, 400);
  await refused(rivera.token, 'activities', shared.id, { to: 'goals' }, 400);
  await refused(rivera.token, 'activities', shared.id, {}, 400);
  const goal = await made(rivera.token, 'goals', { title: 'Read 12 books', metric: 'manual', target_value: 12 });
  await refused(rivera.token, 'goals', goal.id, { to: 'activities' }, 404);
  await refused(rivera.token, 'activities', 'no-such-id', { to: 'awards' }, 404);

  // Frozen when a membership ended.
  const frozen = await entry(rivera.token, { title: 'Completed Fiscal Law course', date: '2026-01-05', visibility: 'unit', unit_id: 'G8' });
  app.ctx.db.prepare('UPDATE activities SET frozen_at = ? WHERE id = ?').run(new Date().toISOString(), frozen.id);
  await refused(rivera.token, 'activities', frozen.id, { to: 'trainings' }, 403, 'frozen');

  // In the recycle bin: it is not there to move until restored.
  const binned = await entry(rivera.token, { title: 'Completed Sergeants Course', date: '2026-01-06' });
  assert.equal((await del(rivera.token, `/api/records/activities/${binned.id}`)).status, 200);
  await refused(rivera.token, 'activities', binned.id, { to: 'trainings' }, 403, 'deleted');
  const binnedRow = rowOf('activities', binned.id)!;
  assert.ok(binnedRow.deleted_at, 'it stays in the bin');
  assert.equal(moveProblem(app.ctx, rivera.id, 'activities', binnedRow as never)?.code, 'deleted');

  // Drawn from a financial case: by its fingerprint, or by a draft that still points at it.
  for (const prefix of ['work:', 'case:', 'draft:']) {
    const fromWork = await entry(rivera.token, { title: `Earned a certificate ${prefix}`, date: '2026-01-07' });
    app.ctx.db.prepare('UPDATE activities SET fingerprint = ? WHERE id = ?').run(`${prefix}item-${fromWork.id}`, fromWork.id);
    await refused(rivera.token, 'activities', fromWork.id, { to: 'trainings' }, 403, 'drawn_from_work');
  }
  const drafted = await entry(rivera.token, { title: 'Completed DTS approver course', date: '2026-01-08' });
  const at = new Date().toISOString();
  app.ctx.db.prepare("INSERT INTO record_drafts (id, user_id, title, activity_id, created_at, updated_at) VALUES (?, ?, 'Drafted from a case', ?, ?, ?)").run(`draft-${drafted.id}`, rivera.id, drafted.id, at, at);
  await refused(rivera.token, 'activities', drafted.id, { to: 'trainings' }, 403, 'drawn_from_work');

  // A legal hold, on the person, on the record type, or on the whole Unit Instance.
  for (const hold of [{ scope: 'user', subject_id: rivera.id }, { scope: 'record_type', record_type: 'activities' }, { scope: 'instance' }] as const) {
    const placed = placeHold(app.ctx, 'G8', { ...hold, reason: 'IG inquiry 2026-21' }, op.id);
    try {
      await refused(rivera.token, 'activities', shared.id, { to: 'trainings' }, 403, 'legal_hold');
    } finally { releaseHold(app.ctx, 'G8', placed.id, op.id); }
  }

  // None of it moved anything.
  for (const id of [shared.id, frozen.id, binned.id, drafted.id]) {
    assert.ok(rowOf('activities', id), `${id} is still an activity`);
    assert.equal(lineageOf(id).length, 0, `${id} has no lineage`);
  }

  // With every hold released it moves, and a hold placed after the move stops the undo.
  const moved = await move(rivera.token, 'activities', shared.id, { to: 'trainings', version: shared.version });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const placed = placeHold(app.ctx, 'G8', { scope: 'user', subject_id: rivera.id, reason: 'Personnel action' }, op.id);
  try {
    const held = await undo(rivera.token, 'trainings', moved.body.id);
    assert.equal(held.status, 403, JSON.stringify(held.body));
    assert.equal(held.body.code, 'legal_hold');
    assert.equal((await get(rivera.token, `/api/records/trainings/${moved.body.id}/lineage`)).body.undo, null, 'nor is it offered');
  } finally { releaseHold(app.ctx, 'G8', placed.id, op.id); }
  // Nor does anyone but its owner undo it.
  const notTheirs = await undo(nguyen.token, 'trainings', moved.body.id);
  assert.equal(notTheirs.status, 403);
  assert.equal(notTheirs.body.code, 'owner_only');
  assert.equal((await undo(rivera.token, 'trainings', moved.body.id)).status, 200);
});

// ---------------------------------------------------------------------------------------------------------------------
// Who owns an award

test('a leader’s award recommendation is the recorder’s and the chain’s to change, never its subject’s', async () => {
  const rec = await made(diaz.token, 'awards', { user_id: rivera.id, name: 'Navy and Marine Corps Commendation Medal', type: 'personal_award', status: 'recommended', date: '2026-06-01' });
  assert.equal(rec.user_id, rivera.id);
  assert.equal(rec.recorded_by, diaz.id, 'it keeps who recommended it');
  assert.equal(rec.visibility, 'unit');
  assert.equal(rec.unit_id, 'G8');

  // The Marine it is about reads it, with who recorded it, and cannot change, delete or move it.
  const listed = (await get(rivera.token, '/api/records/awards')).body.find((r: any) => r.id === rec.id);
  assert.ok(listed, 'the Marine sees the award recommended for them');
  assert.equal(listed.recorder_name, 'Sgt Diaz');
  const edit = await put(rivera.token, `/api/records/awards/${rec.id}`, { status: 'approved', version: rec.version });
  assert.equal(edit.status, 403, JSON.stringify(edit.body));
  assert.equal((await del(rivera.token, `/api/records/awards/${rec.id}`)).status, 403);
  const moved = await move(rivera.token, 'awards', rec.id, { to: 'activities' });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.code, 'recorded_by_other');
  assert.equal(rowOf('awards', rec.id)!.status, 'recommended');
  assert.equal(moveProblem(app.ctx, rivera.id, 'awards', rowOf('awards', rec.id) as never)?.code, 'recorded_by_other');

  // Its recorder changes it, while they counsel in its unit, without the right to correct others' records.
  const recorderEdit = await put(diaz.token, `/api/records/awards/${rec.id}`, { status: 'submitted', submitted_at: '2026-06-05', version: rec.version });
  assert.equal(recorderEdit.status, 200, JSON.stringify(recorderEdit.body));
  assert.equal(recorderEdit.body.status, 'submitted');
  const edited = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'edit' AND entity = 'awards' AND entity_id = ? ORDER BY seq DESC LIMIT 1").get(rec.id) as { detail: string };
  assert.match(edited.detail, /^recorder edit/);
  const theirList = (await get(diaz.token, '/api/records/awards')).body.find((r: any) => r.id === rec.id);
  assert.ok(theirList);
  assert.equal(theirList.recorder_name, undefined, 'the recorder is not told their own name');
  // A leader who corrects shared records still may.
  const managerEdit = await put(nguyen.token, `/api/records/awards/${rec.id}`, { approving_authority: 'CG, MARFORRES', version: recorderEdit.body.version });
  assert.equal(managerEdit.status, 200, JSON.stringify(managerEdit.body));
  // Without Counsel members in the unit, the recorder no longer may.
  const role = app.ctx.db.prepare("SELECT * FROM member_roles WHERE user_id = ? AND role_id = 'G8:fire-team-leader'").get(diaz.id) as Record<string, unknown>;
  assert.ok(role);
  app.ctx.db.prepare("DELETE FROM member_roles WHERE user_id = ? AND role_id = 'G8:fire-team-leader'").run(diaz.id);
  try {
    assert.equal((await put(diaz.token, `/api/records/awards/${rec.id}`, { notes: 'After the role ended', version: managerEdit.body.version })).status, 403);
  } finally {
    app.ctx.db.prepare('INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(role.user_id, role.role_id, role.unit_id, role.granted_by, role.created_at);
  }

  // An award the Marine enters is theirs: recorded by them, editable and movable by them, with no recorder named.
  const own = await made(rivera.token, 'awards', { name: 'Certificate of Commendation', type: 'certificate', status: 'presented', date: '2026-03-20' });
  assert.equal(own.recorded_by, rivera.id);
  const ownEdit = await put(rivera.token, `/api/records/awards/${own.id}`, { notes: 'From the CG', version: own.version });
  assert.equal(ownEdit.status, 200, JSON.stringify(ownEdit.body));
  assert.equal((await get(rivera.token, '/api/records/awards')).body.find((r: any) => r.id === own.id).recorder_name, undefined);
  const ownMove = await move(rivera.token, 'awards', own.id, { to: 'activities' });
  assert.equal(ownMove.status, 201, JSON.stringify(ownMove.body));
  assert.equal(ownMove.body.record.category, 'Recognition');
  assert.equal(ownMove.body.record.status, 'completed');
  assert.equal((await undo(rivera.token, 'activities', ownMove.body.id)).status, 200);
  assert.equal(rowOf('awards', own.id)!.recorded_by, rivera.id, 'undone, it is still the Marine’s own');
});

// ---------------------------------------------------------------------------------------------------------------------
// Move candidates

test('move candidates are read when asked: what reads like an award or a course, less what may not move or its owner kept', async () => {
  const course = await entry(okafor.token, { title: 'Completed Sergeants Course', date: '2026-05-10' });
  const loa = await entry(okafor.token, { title: 'Received a Letter of Appreciation from the CG', date: '2026-05-11', visibility: 'unit', unit_id: 'G8' });
  const work = await entry(okafor.token, { title: 'Reconciled 40 LOA lines for FY26', date: '2026-05-12' });
  const fromWork = await entry(okafor.token, { title: 'Completed Fiscal Law course', date: '2026-05-13' });
  app.ctx.db.prepare('UPDATE activities SET fingerprint = ? WHERE id = ?').run(`case:DOC-${fromWork.id}`, fromWork.id);
  const drafted = await entry(okafor.token, { title: 'Completed DTS approver course', date: '2026-05-13' });
  const at = new Date().toISOString();
  app.ctx.db.prepare("INSERT INTO record_drafts (id, user_id, title, activity_id, created_at, updated_at) VALUES (?, ?, 'Drafted from a case', ?, ?, ?)").run(`draft-${drafted.id}`, okafor.id, drafted.id, at, at);
  const frozen = await entry(okafor.token, { title: 'Completed MCI course 0300', date: '2026-05-14', visibility: 'unit', unit_id: 'G8' });
  app.ctx.db.prepare('UPDATE activities SET frozen_at = ? WHERE id = ?').run(new Date().toISOString(), frozen.id);
  const binned = await entry(okafor.token, { title: 'Completed Corporals Course', date: '2026-05-15' });
  await del(okafor.token, `/api/records/activities/${binned.id}`);
  const kept = await entry(okafor.token, { title: 'Earned Security+ certification', date: '2026-05-16' });

  // Keeping one as an activity is its owner's say alone.
  const notTheirs = await post(nguyen.token, `/api/records/activities/${kept.id}/keep`);
  assert.equal(notTheirs.status, 403, JSON.stringify(notTheirs.body));
  assert.equal(notTheirs.body.code, 'forbidden', 'a private entry: not theirs to open, let alone to keep');
  assert.equal(rowOf('activities', kept.id)!.kind_confirmed_at, null);
  assert.equal((await post(okafor.token, '/api/records/activities/no-such-id/keep')).status, 404);
  const keep = await post(okafor.token, `/api/records/activities/${kept.id}/keep`);
  assert.equal(keep.status, 200, JSON.stringify(keep.body));
  assert.deepEqual(keep.body, { ok: true, id: kept.id });
  const confirmed = rowOf('activities', kept.id)!.kind_confirmed_at;
  assert.ok(confirmed);
  assert.equal((await post(okafor.token, `/api/records/activities/${kept.id}/keep`)).status, 200);
  assert.equal(rowOf('activities', kept.id)!.kind_confirmed_at, confirmed, 'keeping it again keeps the first answer');

  const before = { activities: (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, lineage: (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n };
  const res = await get(okafor.token, '/api/record/move-candidates');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.candidates.map((c: any) => c.id).sort(), [course.id, loa.id].sort());
  assert.equal(res.body.total, 2);
  const byId = Object.fromEntries(res.body.candidates.map((c: any) => [c.id, c]));
  assert.equal(byId[course.id].to, 'trainings');
  assert.equal(byId[course.id].reading.kind, 'training');
  assert.equal(byId[course.id].reading.type, 'pme');
  assert.equal(byId[course.id].title, 'Completed Sergeants Course');
  assert.equal(byId[course.id].date, '2026-05-10');
  assert.equal(byId[loa.id].to, 'awards');
  assert.equal(byId[loa.id].reading.kind, 'award');
  assert.equal(byId[loa.id].reading.type, 'loa');
  assert.deepEqual(res.body.candidates.map((c: any) => c.date), ['2026-05-11', '2026-05-10'], 'newest first');
  // Reading them moves nothing.
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, before.activities);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n, before.lineage);

  // Worked out each time from the words as they are now.
  const reworded = await put(okafor.token, `/api/records/activities/${work.id}`, { title: 'Received the Navy and Marine Corps Commendation Medal', version: work.version });
  assert.equal(reworded.status, 200, JSON.stringify(reworded.body));
  const after = await get(okafor.token, '/api/record/move-candidates');
  assert.deepEqual(after.body.candidates.map((c: any) => c.id).sort(), [course.id, loa.id, work.id].sort());
  assert.equal(after.body.candidates.find((c: any) => c.id === work.id).reading.name, 'Navy and Marine Corps Commendation Medal');

  // Only the person's own, and none while a hold covers them.
  for (const other of [nguyen, op, rivera]) {
    const theirs = await get(other.token, '/api/record/move-candidates');
    assert.equal(theirs.status, 200);
    assert.ok(!theirs.body.candidates.some((c: any) => [course.id, loa.id, work.id].includes(c.id)), 'another person’s entries are never offered');
  }
  const hold = placeHold(app.ctx, 'G8', { scope: 'user', subject_id: okafor.id, reason: 'Pending board action' }, op.id);
  try {
    assert.deepEqual((await get(okafor.token, '/api/record/move-candidates')).body, { candidates: [], total: 0 });
  } finally { releaseHold(app.ctx, 'G8', hold.id, op.id); }

  // A candidate moved is no longer one.
  const moved = await move(okafor.token, 'activities', loa.id, { to: 'awards' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(moved.body.record.type, 'loa');
  assert.equal(moved.body.record.name, 'Letter of Appreciation');
  assert.deepEqual((await get(okafor.token, '/api/record/move-candidates')).body.candidates.map((c: any) => c.id).sort(), [course.id, work.id].sort());
});

test('an import keeps every row as an activity and counts the ones that read like an award or training', async () => {
  const before = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM awards WHERE user_id = ?').get(rivera.id) as { n: number }).n;
  const res = await post(rivera.token, '/api/records/activities/import', { rows: [
    { title: 'Received a Certificate of Commendation', date: '2026-07-01' },
    { title: 'Completed MarineNet course Fiscal Law', date: '2026-07-02' },
    { title: 'Reconciled 12 ULOs', date: '2026-07-03', quantity: 12 },
  ] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.created, 3, 'nothing is diverted on the way in');
  assert.equal(res.body.elsewhere, 2);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM awards WHERE user_id = ?').get(rivera.id) as { n: number }).n, before);
});

// ---------------------------------------------------------------------------------------------------------------------
// The timeline

test('the timeline: the person’s own records of every kind, newest first, windowed and limited, and never stored', async () => {
  const items: Record<string, string> = {};
  items.activity = (await entry(lopez.token, { title: 'Reconciled 12 ULOs', date: '2026-03-01', visibility: 'unit', unit_id: 'G8' })).id;
  items.pme = (await made(lopez.token, 'trainings', { title: 'Sergeants Course', type: 'pme', date: '2026-02-01', status: 'completed' })).id;
  items.training = (await made(lopez.token, 'trainings', { title: 'Fiscal Law', type: 'course', date: '2026-04-01', provider: 'NAVSUP' })).id;
  items.certification = (await made(lopez.token, 'trainings', { title: 'Security+', type: 'certification', date: '2026-01-10' })).id;
  items.education = (await made(lopez.token, 'trainings', { title: 'BS Accounting', type: 'education', date: '2025-12-15' })).id;
  items.qualification = (await made(lopez.token, 'trainings', { title: 'Certifying officer', type: 'qualification', date: '2025-11-01' })).id;
  items.award = (await made(lopez.token, 'awards', { name: 'Navy and Marine Corps Achievement Medal', type: 'personal_award', status: 'presented', date: '2026-05-01', presented_at: '2026-05-20' })).id;
  items.recognition = (await made(lopez.token, 'awards', { name: 'Meritorious Mast', type: 'meritorious_mast', status: 'presented', date: '2025-10-20' })).id;
  items.counseling = (await made(nguyen.token, 'counselings', { user_id: lopez.id, type: 'monthly', date: '2026-06-01', summary: 'Solid month.', visibility: 'unit' })).id;
  items.goal = (await made(lopez.token, 'goals', { title: 'Close 50 ULOs', metric: 'manual', target_value: 50, status: 'achieved', period_end: '2026-06-30' })).id;
  // Not on it: a binned entry, a goal not yet achieved.
  const binned = await entry(lopez.token, { title: 'Binned entry', date: '2026-03-02' });
  await del(lopez.token, `/api/records/activities/${binned.id}`);
  const open = await made(lopez.token, 'goals', { title: 'Close 100 ULOs', metric: 'manual', target_value: 100, period_end: '2026-12-31' });
  // Another Marine's entry, shared with the same unit, which a leader reading the timeline could read elsewhere.
  const shared = await entry(okafor.token, { title: 'Okafor shared entry', date: '2026-03-15', visibility: 'unit', unit_id: 'G8' });

  const snapshot = () => {
    const tables = (app.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
    const counts = Object.fromEntries(tables.map((t) => [t, (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
    const rows = Object.fromEntries(['activities', 'trainings', 'awards', 'counselings', 'goals', 'record_lineage'].map((t) => [t, app.ctx.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
    return JSON.stringify({ counts, rows });
  };
  const unchanged = snapshot();

  const res = await get(lopez.token, '/api/record/timeline');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const timeline = res.body as { items: TimelineItem[]; counts: Record<string, number>; total: number; truncated: boolean; pending: unknown[] };
  assert.deepEqual(timeline.items.map((i) => i.id).sort(), Object.values(items).sort(), 'exactly the person’s own records, each once');
  assert.ok(!timeline.items.some((i) => [binned.id, open.id, shared.id].includes(i.id)));
  // Every timeline kind with a store is one the timeline returns, read from that kind's store.
  const storedKinds = RECORD_KINDS.filter((k) => k.timeline && k.store);
  assert.deepEqual([...new Set(timeline.items.map((i) => i.kind))].sort(), storedKinds.map((k) => k.key).sort());
  for (const item of timeline.items) {
    assert.equal(item.id, items[item.kind], `${item.kind} is the ${item.kind} made for it`);
    assert.equal(item.table, storedKinds.find((k) => k.key === item.kind)!.store!.table, `${item.kind} comes from its own store`);
    assert.equal(rowOf(item.table, item.id)!.user_id, lopez.id);
    assert.equal(item.from_work, false);
    assert.ok(item.href.includes(encodeURIComponent(item.id)) || item.table === 'goals', item.href);
  }
  assert.equal(timeline.items.find((i) => i.kind === 'activity')!.href, `/records/${items.activity}`);
  assert.equal(timeline.items.find((i) => i.kind === 'award')!.href, `/career/awards?open=${items.award}`);
  assert.equal(timeline.items.find((i) => i.kind === 'pme')!.href, `/career/training?open=${items.pme}`);
  assert.equal(timeline.items.find((i) => i.kind === 'counseling')!.href, `/career/counseling?open=${items.counseling}`);
  assert.equal(timeline.items.find((i) => i.kind === 'award')!.date, '2026-05-20', 'an award is dated when it was presented');
  const dates = timeline.items.map((i) => i.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  assert.equal(timeline.items[0].id, items.goal);
  assert.equal(timeline.total, Object.keys(items).length);
  assert.equal(timeline.truncated, false);
  assert.deepEqual(timeline.counts, Object.fromEntries(storedKinds.map((k) => [k.key, 1])));
  assert.deepEqual(timeline.pending, [{ key: 'duty', label: 'Duty', plannedIn: 'Task 17' }]);

  // A window by day, both ends kept.
  const windowed = await get(lopez.token, '/api/record/timeline?from=2026-02-01&to=2026-04-01');
  assert.equal(windowed.status, 200, JSON.stringify(windowed.body));
  assert.deepEqual(windowed.body.items.map((i: TimelineItem) => i.id), [items.training, items.activity, items.pme]);
  assert.equal(windowed.body.total, 3);
  assert.deepEqual(windowed.body.counts, { activity: 1, pme: 1, training: 1 });
  assert.deepEqual((await get(lopez.token, '/api/record/timeline?from=2026-06-02')).body.items.map((i: TimelineItem) => i.id), [items.goal]);
  // A limit takes the newest, and says there is more.
  const limited = await get(lopez.token, '/api/record/timeline?limit=3');
  assert.deepEqual(limited.body.items.map((i: TimelineItem) => i.id), timeline.items.slice(0, 3).map((i) => i.id));
  assert.equal(limited.body.total, timeline.total);
  assert.equal(limited.body.truncated, true);
  assert.equal((await get(lopez.token, '/api/record/timeline?limit=0')).body.items.length, timeline.total, 'a nonsense limit falls back to the default');
  for (const bad of ['from=2026-13-40x', 'to=yesterday', 'from=2026-05-01&to=2026-04-01']) {
    assert.equal((await get(lopez.token, `/api/record/timeline?${bad}`)).status, 400, bad);
  }

  // A leader who reads both Marines' shared entries sees only their own records on their own timeline.
  const leaders = await get(nguyen.token, '/api/record/timeline');
  assert.equal(leaders.status, 200);
  assert.ok(!leaders.body.items.some((i: TimelineItem) => [...Object.values(items), shared.id].includes(i.id)), 'never another person’s records');
  for (const item of leaders.body.items as TimelineItem[]) {
    const owner = rowOf(item.table, item.id)!;
    assert.ok(owner.user_id === nguyen.id || owner.assignee_id === nguyen.id, `${item.table} ${item.id} is not the leader’s own`);
  }
  assert.equal((await get(outsider.token, '/api/record/timeline')).body.total, 0);
  assert.equal((await app.call('GET', '/api/record/timeline')).status, 401);

  assert.equal(snapshot(), unchanged, 'reading the timeline wrote nothing anywhere');
});

test('an activity drawn from a financial case is marked as such on the timeline', async () => {
  const drawn = await entry(lopez.token, { title: 'Cleared an unmatched disbursement', date: '2025-09-01' });
  app.ctx.db.prepare('UPDATE activities SET fingerprint = ? WHERE id = ?').run(`work:item-${drawn.id}`, drawn.id);
  const res = await get(lopez.token, '/api/record/timeline?to=2025-09-30');
  const item = res.body.items.find((i: TimelineItem) => i.id === drawn.id);
  assert.ok(item);
  assert.equal(item.from_work, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// Migration 023

function atVersion(version: number, seed: (db: Database.Database) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-migrate-'));
  const path = join(dir, 'vantage.db');
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
  seed(db);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('023 keeps who entered each award, from its create entry or else its owner, and moves no activity', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(22, (db) => {
    // The shape at 22: no lineage, no recorder on an award, no kept-as-activity on an entry.
    db.exec('DROP TABLE record_lineage');
    db.exec('ALTER TABLE awards DROP COLUMN recorded_by');
    db.exec('ALTER TABLE activities DROP COLUMN kind_confirmed_at');
    db.pragma('foreign_keys = OFF');
    const user = db.prepare('INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    user.run('u-marine', 'marine', 'x', 'Pat', 'Doe', at, at);
    user.run('u-lead', 'leader', 'x', 'Lea', 'Der', at, at);
    db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES ('G8', 'G8', 'G-8', 'active', 'G8', '{}', ?, ?)").run(at, at);
    db.prepare("INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES ('G8', 'G8', 'G-8 Comptroller', NULL, 'G8', ?)").run(at);
    const award = db.prepare("INSERT INTO awards (id, user_id, unit_id, visibility, name, type, status, created_at, updated_at) VALUES (?, 'u-marine', 'G8', ?, ?, 'personal_award', ?, ?, ?)");
    award.run('a-recommended', 'unit', 'Navy and Marine Corps Commendation Medal', 'recommended', at, at);
    award.run('a-own', 'private', 'Certificate of Commendation', 'presented', at, at);
    award.run('a-self', 'private', 'Letter of Appreciation', 'presented', at, at);
    award.run('a-hidden', 'private', 'Navy Unit Commendation', 'recommended', at, at);
    const entryOf = db.prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, subject_id, unit_id, at, entry_hash) VALUES (?, ?, 'create', 'awards', ?, ?, 'G8', ?, 'h')");
    // The leader recommended one; the Marine entered another; the third was seeded with no entry at all.
    entryOf.run('e1', 'u-lead', 'a-recommended', 'u-marine', at);
    entryOf.run('e2', 'u-marine', 'a-self', null, at);
    // A recommendation its Marine has since made private, as they could before 023, is not handed back to the leader.
    entryOf.run('e4', 'u-lead', 'a-hidden', 'u-marine', at);
    // An edit by someone else is not who entered it.
    db.prepare("INSERT INTO audit_log (id, actor_id, action, entity, entity_id, at, entry_hash) VALUES ('e3', 'u-lead', 'edit', 'awards', 'a-own', ?, 'h')").run(at);
    const act = db.prepare("INSERT INTO activities (id, user_id, unit_id, visibility, date, title, fingerprint, created_at, updated_at) VALUES (?, 'u-marine', 'G8', 'unit', ?, ?, ?, ?, ?)");
    // Two read like an award and a course; nothing moves them on the upgrade.
    act.run('act-award', '2026-05-01', 'Received the Navy and Marine Corps Achievement Medal', 'fp-1', at, at);
    act.run('act-course', '2026-05-02', 'Completed Corporals Course', 'fp-2', at, at);
    act.run('act-work', '2026-05-03', 'Reconciled 40 LOA lines', 'work:item-1', at, at);
  });
  try {
    const db = openDatabase(path);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    assert.ok(migrationHistory(db).some((m) => m.id === 23 && m.name === '023_record_lineage'), 'the migration is in the history');
    const recorder = (id: string) => (db.prepare('SELECT recorded_by FROM awards WHERE id = ?').get(id) as { recorded_by: string | null }).recorded_by;
    assert.equal(recorder('a-recommended'), 'u-lead', 'a recommendation keeps the leader who entered it');
    assert.equal(recorder('a-self'), 'u-marine');
    assert.equal(recorder('a-own'), 'u-marine', 'an award no create entry names is its owner’s own');
    assert.equal(recorder('a-hidden'), 'u-marine', 'a private award is its owner’s, whoever entered it');
    assert.deepEqual(db.prepare('SELECT id, title, fingerprint, kind_confirmed_at, deleted_at FROM activities ORDER BY id').all().map((r) => ({ ...(r as object) })), [
      { id: 'act-award', title: 'Received the Navy and Marine Corps Achievement Medal', fingerprint: 'fp-1', kind_confirmed_at: null, deleted_at: null },
      { id: 'act-course', title: 'Completed Corporals Course', fingerprint: 'fp-2', kind_confirmed_at: null, deleted_at: null },
      { id: 'act-work', title: 'Reconciled 40 LOA lines', fingerprint: 'work:item-1', kind_confirmed_at: null, deleted_at: null },
    ], 'every activity is still an activity, as it was');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM awards').get() as { n: number }).n, 4, 'and no award was made from one');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM trainings').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n, 0);
    const lineageColumns = (db.prepare('PRAGMA table_info(record_lineage)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(lineageColumns, ['id', 'user_id', 'unit_id', 'from_table', 'from_id', 'to_table', 'to_id', 'snapshot', 'method', 'reason', 'moved_by', 'at']);
    db.close();

    // A second boot changes nothing.
    const again = openDatabase(path);
    assert.deepEqual(again.prepare('SELECT id, recorded_by FROM awards ORDER BY id').all().map((r) => ({ ...(r as object) })), [
      { id: 'a-hidden', recorded_by: 'u-marine' }, { id: 'a-own', recorded_by: 'u-marine' }, { id: 'a-recommended', recorded_by: 'u-lead' }, { id: 'a-self', recorded_by: 'u-marine' },
    ]);
    assert.equal(migrationHistory(again).filter((m) => m.id === 23).length, 1);
    again.close();
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Exports and destruction

test('lineage travels in the instance archive, an undo works where it lands, and an archive from before 023 gets its recorders', async () => {
  // A move not yet undone, to undo on the other side.
  const pending = await entry(rivera.token, { title: 'Received a Letter of Appreciation from the CO', date: '2026-08-01', visibility: 'unit', unit_id: 'G8' });
  const moved = await move(rivera.token, 'activities', pending.id, { to: 'awards', reason: 'An LOA I received' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const recommended = await made(diaz.token, 'awards', { user_id: rivera.id, name: 'Navy and Marine Corps Achievement Medal', status: 'recommended', date: '2026-08-02' });

  type Archive = Parameters<typeof importInstance>[1] & { tables: Record<string, Array<Record<string, unknown>>> };
  const archive = JSON.parse(JSON.stringify(exportInstance(app.ctx))) as Archive;
  const lineage = app.ctx.db.prepare('SELECT * FROM record_lineage ORDER BY id').all() as Array<Record<string, unknown>>;
  assert.ok(lineage.length >= 5, 'earlier tests left moves behind');
  assert.deepEqual([...archive.tables.record_lineage].sort((a, b) => String(a.id).localeCompare(String(b.id))), lineage, 'every lineage row, whole');

  const fresh = await startApp();
  try {
    const freshOp = await fresh.setupOperator();
    importInstance(fresh.ctx, archive, freshOp.id);
    assert.deepEqual(fresh.ctx.db.prepare('SELECT * FROM record_lineage ORDER BY id').all(), lineage, 'it comes back as it was');
    assert.equal((fresh.ctx.db.prepare('SELECT recorded_by FROM awards WHERE id = ?').get(recommended.id) as { recorded_by: string }).recorded_by, diaz.id);
    const token = (await fresh.login('rivera')).body.token as string;
    assert.ok(token, 'the Marine signs in on the new host');
    const back = await fresh.call('POST', `/api/records/awards/${moved.body.id}/undo-move`, { token });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.id, pending.id, 'the undo works on the host the archive moved to');
    assert.equal((fresh.ctx.db.prepare('SELECT title FROM activities WHERE id = ?').get(pending.id) as { title: string }).title, pending.title);
  } finally { await fresh.close(); }

  // An archive written before 023: no award names who entered it. The create entries in its trail do.
  const legacy = structuredClone(archive);
  legacy.tables.awards = legacy.tables.awards.map(({ recorded_by: _r, ...rest }) => rest);
  const older = await startApp();
  try {
    const olderOp = await older.setupOperator();
    importInstance(older.ctx, legacy, olderOp.id);
    const recorder = (id: string) => (older.ctx.db.prepare('SELECT recorded_by FROM awards WHERE id = ?').get(id) as { recorded_by: string | null }).recorded_by;
    assert.equal(recorder(recommended.id), diaz.id, 'the leader’s recommendation is theirs again');
    assert.equal(recorder(moved.body.id), rivera.id, 'an award no create entry names is its owner’s');
    const unrecorded = older.ctx.db.prepare('SELECT COUNT(*) AS n FROM awards WHERE recorded_by IS NULL').get() as { n: number };
    assert.equal(unrecorded.n, 0);
  } finally { await older.close(); }
});

test('the personal export carries the person’s own moves, with what each entry said before', async () => {
  const mine = app.ctx.db.prepare('SELECT id FROM record_lineage WHERE user_id = ? ORDER BY id').all(rivera.id) as Array<{ id: string }>;
  const others = app.ctx.db.prepare('SELECT id FROM record_lineage WHERE user_id <> ?').all(rivera.id) as Array<{ id: string }>;
  assert.ok(mine.length > 0 && others.length > 0, 'both Rivera and Okafor have moved entries');
  const json = await get(rivera.token, '/api/me/export?format=json');
  assert.equal(json.status, 200, JSON.stringify(json.body).slice(0, 300));
  const moves = json.body.record_moves as Array<Record<string, any>>;
  assert.deepEqual(moves.map((m) => m.id).sort(), mine.map((m) => m.id));
  assert.ok(moves.every((m) => m.user_id === rivera.id));
  assert.ok(moves.some((m) => JSON.parse(m.snapshot).title === 'Received the Navy and Marine Corps Achievement Medal'));
  assert.equal(json.body.counts.record_moves, mine.length);
  const zip = await app.call('GET', '/api/me/export?format=zip', { token: rivera.token, binary: true });
  assert.equal(zip.status, 200);
  assert.ok(listZip(zip.buffer as Buffer).includes('record-moves.csv'));
});

test('destroying a moved record takes its whole lineage chain with it, and nothing else', async () => {
  const source = await entry(rivera.token, { title: 'Received a Certificate of Commendation from the CO', date: '2026-08-10' });
  const toAward = await move(rivera.token, 'activities', source.id, { to: 'awards' });
  assert.equal(toAward.status, 201, JSON.stringify(toAward.body));
  assert.equal((await undo(rivera.token, 'awards', toAward.body.id)).status, 200);
  const toTraining = await move(rivera.token, 'activities', source.id, { to: 'trainings' });
  assert.equal(toTraining.status, 201, JSON.stringify(toTraining.body));
  const chain = lineageOf(source.id, toAward.body.id, toTraining.body.id);
  assert.equal(chain.length, 3);
  const others = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n - chain.length;
  assert.ok(others > 0);

  // In the bin past the purge window, it is destroyed, and the rows that held what it said before go with it.
  assert.equal((await del(rivera.token, `/api/records/trainings/${toTraining.body.id}`)).status, 200);
  app.ctx.db.prepare('UPDATE trainings SET deleted_at = ? WHERE id = ?').run(longAgo(40), toTraining.body.id);
  assert.equal(app.ctx.db.prepare('SELECT 1 FROM legal_holds WHERE released_at IS NULL').get(), undefined, 'no hold is open');
  const purged = purgeDeleted(app.ctx);
  assert.ok(purged.records >= 1, JSON.stringify(purged));
  assert.equal(rowOf('trainings', toTraining.body.id), undefined);
  assert.deepEqual(lineageOf(source.id, toAward.body.id, toTraining.body.id), [], 'the whole chain is gone');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n, others, 'every other entry keeps its lineage');
  assert.doesNotMatch(JSON.stringify(app.ctx.db.prepare('SELECT snapshot FROM record_lineage').all()), /Certificate of Commendation from the CO/);
});

// ---------------------------------------------------------------------------------------------------------------------
// What a moved entry keeps, and what goes when its record does

test('a moved entry’s comments stay in view on Training, keeping one is recorded, and one award reads as the list does', async () => {
  // Comments carried to Training are read and written there.
  const course = await entry(rivera.token, { title: 'Completed Fiscal Law course', date: '2026-03-02' });
  assert.equal((await post(rivera.token, `/api/records/activities/${course.id}/comments`, { body: 'Certificate in the shared drive.' })).status, 201);
  const moved = await move(rivera.token, 'activities', course.id, { to: 'trainings' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const comments = await get(rivera.token, `/api/records/trainings/${moved.body.id}/comments`);
  assert.equal(comments.status, 200, JSON.stringify(comments.body));
  assert.deepEqual(comments.body.comments.map((c: any) => c.body), ['Certificate in the shared drive.']);
  assert.equal((await post(rivera.token, `/api/records/trainings/${moved.body.id}/comments`, { body: 'Hours confirmed.' })).status, 201);

  // Keeping an entry as an activity is the owner's say, written to the trail once.
  const kept = await entry(rivera.token, { title: 'Received a challenge coin from the SgtMaj', date: '2026-03-03' });
  for (let i = 0; i < 2; i++) assert.equal((await post(rivera.token, `/api/records/activities/${kept.id}/keep`)).status, 200);
  const trail = app.ctx.db.prepare("SELECT actor_id FROM audit_log WHERE action = 'record_kind_confirmed' AND entity = 'activities' AND entity_id = ?").all(kept.id) as Array<{ actor_id: string }>;
  assert.deepEqual(trail.map((t) => t.actor_id), [rivera.id]);

  // An award opened on its own names who recorded it, as the list does.
  const rec = await made(nguyen.token, 'awards', { user_id: rivera.id, name: 'Certificate of Commendation', type: 'certificate', status: 'recommended', date: '2026-03-04' });
  const opened = await get(rivera.token, `/api/records/awards/${rec.id}`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.recorder_name, 'SSgt Nguyen');
  assert.equal((await get(nguyen.token, `/api/records/awards/${rec.id}`)).body.recorder_name, undefined, 'its recorder is not told their own name');

  // A counseling the Marine noted for themselves waits on nobody's acknowledgement.
  const note = await made(rivera.token, 'counselings', { date: '2026-03-05', type: 'event', summary: 'Notes from my own career conversation' });
  const item = (await get(rivera.token, '/api/record/timeline')).body.items.find((i: TimelineItem) => i.id === note.id);
  assert.ok(item, 'the note is on the timeline');
  assert.equal(item.status, null);
});

test('anonymizing a moved record takes what it said before the move with it', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const date = new Date(Date.now() - 900 * 86_400_000).toISOString().slice(0, 10);
    const made = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Completed Fiscal Law course', result: 'Spoke with Capt Ruiz about my orders', date, visibility: 'unit', unit_id: 'G8' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const moved = await fresh.call('POST', `/api/records/activities/${made.body.id}/move`, { token: owner.token, body: { to: 'trainings' } });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    const lineage = () => (fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage WHERE to_id = ? OR from_id = ?').get(moved.body.id, moved.body.id) as { n: number }).n;
    assert.equal(lineage(), 1);

    saveSchedule(fresh.ctx, 'G8', { record_type: 'trainings', retain_days: 365, disposition: 'anonymize', enabled: true }, owner.id);
    runDisposition(fresh.ctx, { orgId: 'G8', dryRun: false, actorId: owner.id });
    const row = fresh.ctx.db.prepare('SELECT title, notes FROM trainings WHERE id = ?').get(moved.body.id) as { title: string; notes: string | null };
    assert.notEqual(row.title, 'Completed Fiscal Law course', 'the training itself is anonymized');
    assert.equal(lineage(), 0, 'and the snapshot of the activity it was is gone with it');
    const snapshots = fresh.ctx.db.prepare("SELECT COUNT(*) AS n FROM record_lineage WHERE snapshot LIKE '%Capt Ruiz%'").get() as { n: number };
    assert.equal(snapshots.n, 0);
  } finally { await fresh.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Edges: a file mid-scan, a file twice, corrections, a stale project, holds, the timeline's filter, provenance, imports

test('a file still being scanned when its entry moves is refused, not stored against an entry that is gone', async () => {
  // A scanner that answers only when told to, so the move lands while the upload waits on it.
  const sockets: Socket[] = [];
  let heard!: () => void;
  const streamed = new Promise<void>((resolve) => { heard = resolve; });
  const scanner = createServer({ allowHalfOpen: true }, (socket) => { sockets.push(socket); socket.on('data', () => undefined); socket.on('end', () => heard()); });
  await new Promise<void>((resolve) => scanner.listen(0, '127.0.0.1', () => resolve()));
  const intake = app.ctx.config.intake;
  const was = intake.clamd;
  intake.clamd = `tcp://127.0.0.1:${(scanner.address() as AddressInfo).port}`;
  try {
    const source = await entry(rivera.token, { title: 'Received a Letter of Appreciation from the XO', date: '2026-06-01' });
    const upload = app.call('POST', `/api/records/activities/${source.id}/attachments`, { token: rivera.token, raw: Buffer.from('LOA scan'), headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'loa.txt' } });
    await streamed;
    const moved = await move(rivera.token, 'activities', source.id, { to: 'awards' });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    for (const socket of sockets) socket.end('stream: OK\0');
    const res = await upload;
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'record_moved');
    const stored = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE record_id IN (?, ?)').get(source.id, moved.body.id) as { n: number };
    assert.equal(stored.n, 0, 'nothing was stored on either side');
  } finally {
    intake.clamd = was;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => scanner.close(() => resolve()));
  }
});

test('an undo brings its files back even when the same file sits on the entry it returns to', async () => {
  const source = await entry(rivera.token, { title: 'Received a Certificate of Appreciation from the CO', date: '2026-06-02' });
  const up = await app.call('POST', `/api/records/activities/${source.id}/attachments`, { token: rivera.token, raw: Buffer.from('COA scan'), headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'coa.txt' } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const moved = await move(rivera.token, 'activities', source.id, { to: 'awards' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  // The same file under the id the entry left, as an upload that finished during the move once could leave it.
  const file = app.ctx.db.prepare("SELECT * FROM attachments WHERE record_table = 'awards' AND record_id = ?").get(moved.body.id) as Record<string, any>;
  app.ctx.db.prepare(`INSERT INTO attachments (id, record_table, record_id, uploaded_by, unit_id, original_name, mime_type, size_bytes, sha256, content, created_at)
                      VALUES ('file-twice', 'activities', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(source.id, rivera.id, file.unit_id, file.original_name, file.mime_type, file.size_bytes, file.sha256, file.content, file.created_at);
  const back = await undo(rivera.token, 'awards', moved.body.id);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const files = await get(rivera.token, `/api/records/activities/${source.id}/attachments`);
  assert.deepEqual(files.body.attachments.map((f: any) => f.original_name), ['coa.txt'], 'one copy in view');
  const all = app.ctx.db.prepare("SELECT deleted_at FROM attachments WHERE record_table = 'activities' AND record_id = ?").all(source.id) as Array<{ deleted_at: string | null }>;
  assert.equal(all.length, 2);
  assert.equal(all.filter((f) => f.deleted_at).length, 1, 'the other copy is in the bin, not lost');
});

test('a correction on a move sets neither a project nor a value type, and clearing a required field keeps what the move gives it', async () => {
  const theirs = await made(okafor.token, 'projects', { name: 'Okafor’s own tracker' });
  const award = await made(rivera.token, 'awards', { name: 'Letter of Appreciation', type: 'loa', status: 'presented', date: '2026-06-03' });
  const moved = await move(rivera.token, 'awards', award.id, { to: 'activities', fields: { project_id: theirs.id, dollar_type: 'not-a-type', status: null, title: 'LOA from the CO' } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const row = rowOf('activities', moved.body.id)!;
  assert.deepEqual([row.title, row.project_id, row.dollar_type, row.status], ['LOA from the CO', null, null, 'completed']);

  const course = await entry(rivera.token, { title: 'Completed Fiscal Law course', date: '2026-06-04' });
  const toTraining = await move(rivera.token, 'activities', course.id, { to: 'trainings', fields: { status: '', hours: 4 } });
  assert.equal(toTraining.status, 201, JSON.stringify(toTraining.body));
  const training = rowOf('trainings', toTraining.body.id)!;
  assert.deepEqual([training.status, training.hours], ['completed', 4]);
});

test('an award named from what an activity says keeps the activity’s own words', async () => {
  const source = await entry(rivera.token, { title: 'Received the NAM from the CO for the FY26 close-out', date: '2026-06-05', result: 'end of tour' });
  const moved = await move(rivera.token, 'activities', source.id, { to: 'awards' });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const award = rowOf('awards', moved.body.id)!;
  assert.equal(award.name, 'Navy and Marine Corps Achievement Medal');
  assert.equal(award.notes, 'Received the NAM from the CO for the FY26 close-out\n\nend of tour');
});

test('an undo keeps an entry’s project only while its owner may still file under it', async () => {
  const project = await made(rivera.token, 'projects', { name: 'FY26 close-out' });
  const gone = await made(rivera.token, 'projects', { name: 'Retired tracker' });
  const keeps = await entry(rivera.token, { title: 'Received a coin from the CO for the close-out', date: '2026-06-06', project_id: project.id });
  const loses = await entry(rivera.token, { title: 'Received a coin from the XO for the tracker', date: '2026-06-07', project_id: gone.id });
  const first = await move(rivera.token, 'activities', keeps.id, { to: 'awards' });
  const second = await move(rivera.token, 'activities', loses.id, { to: 'awards' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal((await del(rivera.token, `/api/records/projects/${gone.id}`)).status, 200);
  assert.equal((await undo(rivera.token, 'awards', first.body.id)).status, 200);
  assert.equal((await undo(rivera.token, 'awards', second.body.id)).status, 200);
  assert.equal(rowOf('activities', keeps.id)!.project_id, project.id);
  assert.equal(rowOf('activities', loses.id)!.project_id, null, 'a project in the bin is not filed under again');
});

test('a recommendation’s recorder changes it only while it is shared, and an anonymized one no longer names them', async () => {
  const rec = await made(diaz.token, 'awards', { user_id: okafor.id, name: 'Certificate of Commendation', type: 'certificate', status: 'recommended', date: '2026-06-08' });
  assert.equal(rowOf('awards', rec.id)!.visibility, 'unit');
  assert.equal((await put(diaz.token, `/api/records/awards/${rec.id}`, { citation: 'For superior performance.' })).status, 200);
  // Private now, as a recommendation could be made before 023: its recorder no longer reaches it.
  app.ctx.db.prepare("UPDATE awards SET visibility = 'private' WHERE id = ?").run(rec.id);
  assert.equal((await put(diaz.token, `/api/records/awards/${rec.id}`, { status: 'submitted' })).status, 403);
  app.ctx.db.prepare("UPDATE awards SET visibility = 'unit' WHERE id = ?").run(rec.id);

  assert.equal((await get(okafor.token, `/api/records/awards/${rec.id}`)).body.recorder_name, 'Sgt Diaz');
  app.ctx.db.prepare('UPDATE awards SET citation = ?, notes = ?, recommending_official = ?, approving_authority = ? WHERE id = ?').run(REDACTED, REDACTED, REDACTED, REDACTED, rec.id);
  assert.equal((await get(okafor.token, `/api/records/awards/${rec.id}`)).body.recorder_name, undefined);
  const listed = (await get(okafor.token, '/api/records/awards')).body.find((a: any) => a.id === rec.id);
  assert.ok(listed);
  assert.equal(listed.recorder_name, undefined, 'nor does the list');
});

test('a legal hold over a type an entry has been keeps its lineage when the record goes, and the purge after release lets it go', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const call = (method: string, path: string, body?: unknown) => fresh.call(method, path, { token: owner.token, body });
    const source = await call('POST', '/api/records/activities', { title: 'Received a Certificate of Appreciation from the CO', date: '2026-05-01' });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    const moved = await call('POST', `/api/records/activities/${source.body.id}/move`, { to: 'awards' });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    const lineage = () => (fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage WHERE to_id = ? OR from_id = ?').get(moved.body.id, moved.body.id) as { n: number }).n;
    const hold = placeHold(fresh.ctx, 'G8', { scope: 'record_type', record_type: 'activities', reason: 'Audit of activity entries' }, owner.id);

    assert.equal((await call('DELETE', `/api/records/awards/${moved.body.id}`)).status, 200);
    fresh.ctx.db.prepare('UPDATE awards SET deleted_at = ? WHERE id = ?').run(longAgo(40), moved.body.id);
    purgeDeleted(fresh.ctx);
    assert.equal(fresh.ctx.db.prepare('SELECT 1 FROM awards WHERE id = ?').get(moved.body.id), undefined, 'awards are not held: the award goes');
    assert.equal(lineage(), 1, 'what it said as an activity, a held type, stays');

    purgeDeleted(fresh.ctx);
    assert.equal(lineage(), 1, 'and stays while the hold stands');
    releaseHold(fresh.ctx, 'G8', hold.id, owner.id);
    purgeDeleted(fresh.ctx);
    assert.equal(lineage(), 0, 'released, nothing holds it, and no record is left for it to belong to');
  } finally { await fresh.close(); }
});

test('the purge leaves the lineage of an entry that still stands', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Completed Corporals Course', date: '2026-05-02' } });
    const moved = await fresh.call('POST', `/api/records/activities/${source.body.id}/move`, { token: owner.token, body: { to: 'trainings' } });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    purgeDeleted(fresh.ctx);
    assert.equal((fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n, 1);
  } finally { await fresh.close(); }
});

test('the timeline filters a kind on the server, keeps every kind’s count, and takes a whole number for its limit', async () => {
  for (const [name, date] of [['Letter of Appreciation', '2026-06-10'], ['Certificate of Commendation', '2026-06-11']]) {
    await made(lopez.token, 'awards', { name, type: 'personal_award', status: 'presented', date });
  }
  const all = await get(lopez.token, '/api/record/timeline');
  const awards = all.body.counts.award as number;
  assert.ok(awards >= 3, JSON.stringify(all.body.counts));

  const one = await get(lopez.token, '/api/record/timeline?kind=award&limit=1');
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(one.body.items.map((i: TimelineItem) => i.kind), ['award']);
  assert.deepEqual(one.body.counts, all.body.counts, 'the filters still count every kind');
  assert.equal(one.body.truncated, true, 'one of several awards shown');

  const kind = await get(lopez.token, '/api/record/timeline?kind=award');
  assert.equal(kind.body.items.length, awards);
  assert.ok(kind.body.items.every((i: TimelineItem) => i.kind === 'award'));
  assert.equal(kind.body.truncated, false);

  const fractional = await get(lopez.token, '/api/record/timeline?limit=2.5');
  assert.equal(fractional.status, 200, JSON.stringify(fractional.body));
  assert.equal(fractional.body.items.length, 2);
});

test('an edited entry drawn from a financial case keeps saying so, by edit or by import', async () => {
  const drawn = await entry(rivera.token, { title: 'Reconciled 40 LOA lines', date: '2026-05-05' });
  app.ctx.db.prepare("UPDATE activities SET fingerprint = 'work:item-provenance' WHERE id = ?").run(drawn.id);
  const edited = await put(rivera.token, `/api/records/activities/${drawn.id}`, { title: 'Reconciled 42 LOA lines' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(rowOf('activities', drawn.id)!.fingerprint, 'work:item-provenance');
  const imported = await post(rivera.token, '/api/records/activities/import', { rows: [{ id: drawn.id, title: 'Reconciled 44 LOA lines', date: '2026-05-05' }] });
  assert.equal(imported.body.updated, 1, JSON.stringify(imported.body));
  assert.equal(rowOf('activities', drawn.id)!.fingerprint, 'work:item-provenance');
  // An ordinary entry's fingerprint follows what it says.
  const plain = await entry(rivera.token, { title: 'Reconciled 10 ULOs', date: '2026-05-06' });
  const before = rowOf('activities', plain.id)!.fingerprint;
  await put(rivera.token, `/api/records/activities/${plain.id}`, { title: 'Reconciled 11 ULOs' });
  assert.notEqual(rowOf('activities', plain.id)!.fingerprint, before);
});

test('an import counts only the rows it put in that will be offered for a move', async () => {
  const kept = await entry(rivera.token, { title: 'Received a challenge coin from the CO', date: '2026-04-04' });
  assert.equal((await post(rivera.token, `/api/records/activities/${kept.id}/keep`)).status, 200);
  await entry(rivera.token, { title: 'Completed MarineNet course Ethics', date: '2026-04-05' });
  const res = await post(rivera.token, '/api/records/activities/import', { rows: [
    { id: kept.id, title: 'Received a challenge coin from the CO', date: '2026-04-04', result: 'for the audit' },
    { title: 'Completed MarineNet course Ethics', date: '2026-04-05' },
    { title: 'Received a Certificate of Appreciation from the XO', date: '2026-04-06' },
  ] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual([res.body.created, res.body.updated, res.body.duplicates], [1, 1, 1]);
  assert.equal(res.body.elsewhere, 1, 'not the entry kept as an activity, nor the duplicate skipped');
});

test('an entry saved as kept is not offered for a move', async () => {
  const kept = await entry(okafor.token, { title: 'Received a challenge coin from the Sergeant Major', date: '2026-04-07', kind_confirmed: true });
  assert.ok(rowOf('activities', kept.id)!.kind_confirmed_at);
  const offered = await get(okafor.token, '/api/record/move-candidates');
  assert.equal(offered.status, 200);
  assert.ok(!offered.body.candidates.some((c: { id: string }) => c.id === kept.id));
});
