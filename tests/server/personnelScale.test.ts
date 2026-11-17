import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { scopeFor, can, positionIn, isUnitOwner, detailUnitsFor, unitTree, subtreeIds, PERMISSIONS, type Scope } from '../../server/authz/scope.ts';
import { personnelRoster } from '../../server/services/personnelRecords.ts';

/**
 * Personnel lists at the size of a command: the roster, the team list, the enroll search, the console's
 * members and a Marine's page. Each decides who and what the reader may see for every row exactly as it did one row at a
 * time, reads a fixed number of statements however many rows there are, cuts a long list only after deciding what the
 * reader may see, and says when it has cut one.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let boss: Person; let g1lead: Person; let rich: Person;
const readers: Record<string, string> = {};
const at = new Date().toISOString();
let n = 0;

const db = () => app.ctx.db;
const addUser = (last: string, first: string, active = 1) => {
  const id = `pt-${++n}`;
  db().prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, rank_id, active, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, 'LCpl', ?, ?, ?)`).run(id, `pt${n}`, first, last, active, at, at);
  return id;
};
const addOrg = (id: string) => db().prepare('INSERT INTO organizations (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, id.toLowerCase(), id, 'active', at, at);
const addUnit = (id: string, orgId: string, parent: string | null, owner: string | null = null, active = 1) =>
  db().prepare('INSERT INTO units (id, code, name, parent_id, owner_user_id, active, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, id, id, parent, owner, active, at, orgId);
const join = (userId: string, unitId: string, primary = 0) => db().prepare('INSERT OR IGNORE INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES (?, ?, ?, ?)').run(userId, unitId, primary, at);
const role = (id: string, unitId: string, position: number, permissions: number) => db().prepare('INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, unitId, id, id, permissions, position, at);
const grant = (userId: string, roleId: string, unitId: string) => db().prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, roleId, unitId, op.id, at);
const get = (token: string, path: string) => app.call('GET', path, { token });

const TEAMS = ['G8', 'S1', 'S2', 'P1a', 'P1b', 'P2a'];
/** A mix of the people a roster holds: in one team or two, peers and seniors of the readers, deactivated, in an archived team, in another Unit Instance too. */
function seedMembers(count: number) {
  db().transaction(() => {
    for (let i = 0; i < count; i++) {
      const k = n + 1;
      const id = addUser(`Last${String(k).padStart(5, '0')}`, `First${k % 37}`, k % 11 === 0 ? 0 : 1);
      join(id, k % 19 === 0 ? 'X' : TEAMS[k % TEAMS.length]!, 1);
      if (k % 7 === 0) join(id, 'G8');
      if (k % 13 === 0) { join(id, 'S1'); grant(id, 'S1:peer', 'S1'); }
      if (k % 17 === 0) { join(id, 'S1'); grant(id, 'S1:senior', 'S1'); }
      if (k % 23 === 0) { join(id, 'G8'); grant(id, 'G8:nco', 'G8'); }
      if (k % 29 === 0) join(id, 'G1');
      if (k % 31 === 0) { join(id, 'P1a'); grant(id, 'P1a:snco', 'P1a'); }
    }
  })();
}

/** Every statement run while `fn` runs, with what it was given. */
async function capture(fn: () => unknown): Promise<Array<{ sql: string; args: unknown[] }>> {
  const d = db();
  const prepare = d.prepare;
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  d.prepare = ((sql: string) => {
    const stmt = prepare.call(d, sql);
    const methods = stmt as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const m of ['all', 'get', 'run', 'iterate']) {
      const original = methods[m]!.bind(stmt);
      methods[m] = (...args: unknown[]) => { seen.push({ sql, args }); return original(...args); };
    }
    return stmt;
  }) as typeof d.prepare;
  try { await fn(); } finally { d.prepare = prepare; }
  return seen;
}
const plan = (sql: string, args: unknown[]) => (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail);

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  assert.equal((db().prepare("SELECT org_id FROM units WHERE id = 'G8'").get() as { org_id: string }).org_id, 'G8');
  boss = await app.register('bossman');
  g1lead = await app.register('gonelead');
  rich = await app.register('richrecord');
  addOrg('G1');
  db().transaction(() => {
    addUnit('S1', 'G8', 'G8'); addUnit('S2', 'G8', 'G8'); addUnit('P1a', 'G8', 'S1'); addUnit('P1b', 'G8', 'S1'); addUnit('P2a', 'G8', 'S2'); addUnit('X', 'G8', 'G8', null, 0);
    addUnit('G1', 'G1', null, g1lead.id); addUnit('G1b', 'G1', 'G1', boss.id);
    role('S1:boss', 'S1', 60, PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL | PERMISSIONS.MANAGE_MEMBERS);
    role('S1:peer', 'S1', 60, PERMISSIONS.VIEW_UNIT);
    role('S1:senior', 'S1', 80, PERMISSIONS.VIEW_UNIT);
    role('P1a:snco', 'P1a', 40, PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL);
    role('P1b:chief', 'P1b', 70, PERMISSIONS.VIEW_UNIT);
    join(g1lead.id, 'G1', 1);
    join(boss.id, 'S1', 1); grant(boss.id, 'S1:boss', 'S1'); join(boss.id, 'G1b');
    join(rich.id, 'P1a', 1);
    readers.op = op.id;
    readers.boss = boss.id;
    readers.mgr = addUser('Manager', 'Uma'); join(readers.mgr, 'G8', 1);
    db().prepare("INSERT INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES ('G8', ?, 'admin', ?, ?)").run(readers.mgr, op.id, at);
    readers.snco = addUser('Snco', 'Sam'); join(readers.snco, 'P1a', 1); grant(readers.snco, 'P1a:snco', 'P1a');
    readers.plt = addUser('Platoon', 'Pat'); join(readers.plt, 'P1b', 1); db().prepare("UPDATE units SET owner_user_id = ? WHERE id = 'P1b'").run(readers.plt);
    readers.plain = addUser('Plain', 'Pia'); join(readers.plain, 'P2a', 1);
    // A leader of record who has left the team leads nothing.
    const absent = addUser('Absent', 'Abe'); db().prepare("UPDATE units SET owner_user_id = ? WHERE id = 'P2a'").run(absent);
  })();
  seedMembers(300);
});
after(async () => { await app?.close(); });

/** The roster as it was decided before, one Marine at a time, each with their own scope and their own reads. */
function referenceRoster(scope: Scope, actorId: string, unitId: string) {
  const ctx = app.ctx;
  const sees = (u: string) => can(scope, PERMISSIONS.VIEW_RECORDS, u) || can(scope, PERMISSIONS.MANAGE_MEMBERS, u);
  if (!sees(unitId)) return null;
  const orgId = (db().prepare('SELECT org_id FROM units WHERE id = ?').get(unitId) as { org_id: string }).org_id;
  const tree = unitTree(ctx);
  const inView = subtreeIds(ctx, unitId, tree).filter(sees);
  const depth = (id: string) => { let d = 0; let p = tree.parent.get(id) ?? null; while (p) { d++; p = tree.parent.get(p) ?? null; } return d; };
  const people = db().prepare('SELECT DISTINCT u.id, u.active FROM users u JOIN unit_members um ON um.user_id = u.id WHERE um.unit_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(inView)) as Array<{ id: string; active: number }>;
  const out = new Map<string, { active: boolean; candidates: string[]; manageAt: (u: string) => boolean; canOpenRecords: boolean; seen: string[] }>();
  for (const p of people) {
    const mine = db().prepare('SELECT um.unit_id, un.org_id FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.active = 1 AND um.user_id = ?').all(p.id) as Array<{ unit_id: string; org_id: string }>;
    const inside = mine.map((m) => m.unit_id).filter((u) => inView.includes(u));
    if (!inside.length) continue;
    const deepest = Math.max(...inside.map(depth));
    const self = p.id === actorId;
    const target = scopeFor(ctx, { id: p.id });
    out.set(p.id, {
      active: Boolean(p.active),
      candidates: inside.filter((u) => depth(u) === deepest),
      manageAt: (u) => !self && can(scope, PERMISSIONS.MANAGE_MEMBERS, u) && (isUnitOwner(ctx, actorId, u) || positionIn(target, u) < positionIn(scope, u)),
      canOpenRecords: self || (Boolean(p.active) && detailUnitsFor(ctx, scope, p.id).length > 0),
      seen: mine.filter((m) => m.org_id === orgId && sees(m.unit_id)).map((m) => m.unit_id).sort(),
    });
  }
  return out;
}

test('the roster decides who is on it and what the reader may do about each exactly as per-row checks do', () => {
  let rowsChecked = 0; let managed = 0; let opened = 0; let hidden = 0;
  for (const [name, actorId] of Object.entries(readers)) {
    const scope = scopeFor(app.ctx, { id: actorId });
    for (const unitId of ['G8', 'S1', 'P1a', 'P1b', 'S2']) {
      const ref = referenceRoster(scope, actorId, unitId);
      if (!ref) { assert.throws(() => personnelRoster(app.ctx, scope, actorId, unitId), /cannot see/, `${name} ${unitId}`); continue; }
      const { rows } = personnelRoster(app.ctx, scope, actorId, unitId);
      const listed = new Map(rows.map((r) => [r.id, r]));
      assert.equal(listed.size, rows.length, 'each Marine once');
      for (const [id, want] of ref) {
        const row = listed.get(id);
        const where = `${name} reading ${unitId}, row ${id}`;
        if (!row) {
          assert.equal(want.active, false, `${where}: only a deactivated account is left off`);
          assert.ok(want.candidates.some((u) => !want.manageAt(u)), `${where}: left off only by someone who cannot manage it`);
          hidden++;
          continue;
        }
        rowsChecked++;
        assert.ok(want.candidates.includes(row.assignment.unit_id), `${where}: listed on their own team`);
        assert.equal(row.canManage, want.manageAt(row.assignment.unit_id), `${where}: canManage`);
        assert.equal(row.assignment.canManage, row.canManage, `${where}: the assignment says the same`);
        assert.equal(row.canOpenRecords, want.canOpenRecords, `${where}: canOpenRecords`);
        assert.equal('status' in row, row.canManage || row.self, `${where}: account status only to those who manage it`);
        if (!want.active) assert.ok(row.canManage, `${where}: a deactivated account only for those who manage it`);
        assert.deepEqual([...row.unit_ids].sort(), want.seen, `${where}: the units the reader sees them in, in this Unit Instance only`);
        if (row.canManage) managed++;
        if (row.canOpenRecords) opened++;
      }
      for (const r of rows) assert.ok(ref.has(r.id), `${name} reading ${unitId}: ${r.id} is someone the reader sees there`);
    }
  }
  // The fixture exercises every answer, so agreement means something.
  assert.ok(rowsChecked > 1000 && managed > 100 && opened > 100 && hidden >= 5, `${rowsChecked} rows, ${managed} managed, ${opened} opened, ${hidden} hidden`);
  assert.ok(rowsChecked - managed > 100 && rowsChecked - opened > 100);
});

test('the roster route answers as the service does, and a Marine in two Unit Instances shows only this one', async () => {
  const res = await get(op.token, '/api/org/units/G8/personnel');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const service = personnelRoster(app.ctx, scopeFor(app.ctx, { id: op.id }), op.id, 'G8');
  assert.deepEqual(res.body.rows.map((r: { id: string }) => r.id), service.rows.map((r) => r.id));
  const dual = db().prepare("SELECT um.user_id FROM unit_members um WHERE um.unit_id = 'G1' AND um.user_id LIKE 'pt-%' LIMIT 1").get() as { user_id: string };
  const row = res.body.rows.find((r: { id: string }) => r.id === dual.user_id);
  assert.ok(row && !row.unit_ids.includes('G1'));
});

/** /api/org/team as one reader, checked row by row against that reader's own per-person reads. */
async function checkTeam(token: string, readerId: string) {
  const res = await get(token, '/api/org/team');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const scope = scopeFor(app.ctx, { id: readerId });
  const allowed = new Set(scope.readableUnitIds);
  for (const p of res.body.roster as Array<{ id: string; canOpen: boolean; memberships: Array<{ unit_id: string }>; roles: Array<{ id: string; unit_id: string }> }>) {
    const self = p.id === readerId;
    assert.equal(p.canOpen, self || detailUnitsFor(app.ctx, scope, p.id).length > 0, `canOpen ${p.id}`);
    const units = (db().prepare('SELECT um.unit_id FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND u.active = 1').all(p.id) as Array<{ unit_id: string }>)
      .map((m) => m.unit_id).filter((u) => self || allowed.has(u)).sort();
    assert.deepEqual(p.memberships.map((m) => m.unit_id).sort(), units, `memberships ${p.id}`);
    const roles = (db().prepare('SELECT mr.role_id AS id, mr.unit_id FROM member_roles mr WHERE mr.user_id = ? AND (mr.expires_at IS NULL OR mr.expires_at > ?)').all(p.id, new Date().toISOString()) as Array<{ id: string; unit_id: string }>)
      .filter((r) => allowed.has(r.unit_id)).map((r) => `${r.id}@${r.unit_id}`).sort();
    assert.deepEqual(p.roles.map((r) => `${r.id}@${r.unit_id}`).sort(), roles, `roles ${p.id}`);
  }
  return res.body.roster as Array<{ id: string; memberships: Array<{ unit_id: string }> }>;
}

test('the team list gives each person what per-person reads give, and another Unit Instance’s reader learns nothing of this one', async () => {
  const mine = await checkTeam(op.token, op.id);
  assert.ok(mine.length > 250);
  const theirs = await checkTeam(g1lead.token, g1lead.id);
  const g8 = new Set((db().prepare("SELECT id FROM units WHERE org_id = 'G8'").all() as Array<{ id: string }>).map((u) => u.id));
  assert.ok(theirs.length > 5, 'the G-1 leader sees their own people');
  for (const p of theirs) assert.ok(p.memberships.every((m) => !g8.has(m.unit_id)), `${p.id} shows no G-8 unit to the G-1 leader`);
  const onlyG8 = db().prepare("SELECT um.user_id FROM unit_members um WHERE um.unit_id = 'P2a' AND um.user_id NOT IN (SELECT user_id FROM unit_members WHERE unit_id IN ('G1', 'G1b')) LIMIT 1").get() as { user_id: string };
  assert.ok(!theirs.some((p) => p.id === onlyG8.user_id), 'and nobody who serves only in G-8');
});

test('id lists go in as one JSON value: the team list plans as searches by person and takes any number of ids', async () => {
  const seen = await capture(() => get(op.token, '/api/org/team'));
  const lists = seen.filter((s) => s.sql.includes('json_each') && /FROM (users|unit_members|member_roles)\b/.test(s.sql) && s.args.some((a) => typeof a === 'string' && a.startsWith('["')));
  assert.ok(lists.length >= 3, `${lists.length} statements read by id list`);
  for (const s of lists) {
    const steps = plan(s.sql, s.args);
    assert.ok(!steps.some((d) => /^SCAN (u|um|mr|users|unit_members|member_roles)\b(?! USING COVERING INDEX)/.test(d) && !/USING (COVERING )?INDEX/.test(d)), `${s.sql}\n${steps.join('\n')}`);
    // Past SQLite's limit on bound values, which a list of placeholders would have hit.
    const many = JSON.stringify(Array.from({ length: 33_000 }, (_, i) => `nobody-${i}`));
    assert.doesNotThrow(() => db().prepare(s.sql).all(...s.args.map((a) => (typeof a === 'string' && a.startsWith('["') ? many : a))));
  }
});

test('the enroll search decides who may be enrolled before it cuts the list, and says when there are more', async () => {
  db().transaction(() => {
    // Sixty seniors of the searcher come first by name; the one Marine they may enroll comes after them.
    for (let i = 0; i < 60; i++) { const id = addUser('Smith', `A${String(i).padStart(2, '0')}`); join(id, 'P1b', 1); grant(id, 'P1b:chief', 'P1b'); }
    join(addUser('Smythe', 'Sam'), 'P1b', 1);
    // In a unit of another Unit Instance the searcher also leads: never offered for a G-8 team.
    join(addUser('Smyth', 'Sol'), 'G1b', 1);
    for (let i = 0; i < 12; i++) join(addUser('Brown', `B${String(i).padStart(2, '0')}`), 'P1b', 1);
    for (let i = 0; i < 505; i++) { const id = addUser('Taylor', `T${String(i).padStart(3, '0')}`); join(id, 'P1b', 1); grant(id, 'P1b:chief', 'P1b'); }
    join(addUser('Tayloz', 'Tim'), 'P1b', 1);
  })();
  const search = (q: string, unit = 'P1a') => get(boss.token, `/api/org/directory?unit_id=${unit}&q=${q}`);

  const sm = await search('sm');
  assert.equal(sm.status, 200, JSON.stringify(sm.body));
  assert.deepEqual(sm.body.results.map((r: { last_name: string }) => r.last_name), ['Smythe'], 'found past sixty who may not be enrolled; nobody from another Unit Instance');
  assert.equal(sm.body.more, false);

  const brown = await search('brown');
  assert.equal(brown.body.results.length, 10);
  assert.deepEqual(brown.body.results.map((r: { first_name: string }) => r.first_name), Array.from({ length: 10 }, (_, i) => `B${String(i).padStart(2, '0')}`), 'in name order');
  assert.equal(brown.body.more, true, 'a full page that leaves people out says so');

  const taylor = await search('tay');
  assert.deepEqual(taylor.body.results, []);
  assert.equal(taylor.body.more, true, 'a search that reads its limit without reaching everyone says there may be more');

  const nobody = await search('zz');
  assert.deepEqual(nobody.body, { results: [], more: false });
  // The rule is the one the enroll itself applies: whoever is offered can be enrolled directly.
  const smythe = sm.body.results[0].id;
  const enrolled = await app.call('POST', '/api/org/units/P1a/members', { token: boss.token, body: { user_id: smythe, role_id: null } });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const senior = (db().prepare("SELECT id FROM users WHERE last_name = 'Smith' LIMIT 1").get() as { id: string }).id;
  assert.equal((await app.call('POST', '/api/org/units/P1a/members', { token: boss.token, body: { user_id: senior, role_id: null } })).body.code, 'invite_required');
});

test('the supervisor search says when it stopped at its limit, and offers nobody from another Unit Instance', async () => {
  const smiths = await get(boss.token, '/api/org/units/P1a/supervisor-candidates?q=smith');
  assert.equal(smiths.status, 200, JSON.stringify(smiths.body));
  assert.equal(smiths.body.results.length, 10);
  assert.equal(smiths.body.more, true, 'sixty match: ten are offered, and it says there are more');
  const one = await get(boss.token, '/api/org/units/P1a/supervisor-candidates?q=smythe');
  assert.deepEqual([one.body.results.map((r: { last_name: string }) => r.last_name), one.body.more], [['Smythe'], false]);
  assert.deepEqual((await get(boss.token, '/api/org/units/P1a/supervisor-candidates?q=smyth')).body.results.map((r: { last_name: string }) => r.last_name), ['Smythe'], 'not the Smyth of G-1');
  assert.deepEqual((await get(boss.token, '/api/org/units/P1a/supervisor-candidates?q=s')).body, { results: [], more: false }, 'two letters at least');
});

test('a Marine’s page lists at most its limit of each record, newest first, says how many there are, and leaves out what it does not show', async () => {
  const day = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  db().transaction(() => {
    const insert = db().prepare("INSERT INTO activities (id, user_id, unit_id, visibility, date, title, notes, evidence_links, created_at, updated_at) VALUES (?, ?, 'P1a', ?, ?, ?, 'private words', '[\"https://example.mil/x\"]', ?, ?)");
    for (let i = 0; i < 600; i++) insert.run(`act-${i}`, rich.id, 'unit', day(i), `Shared ${i}`, at, at);
    for (let i = 0; i < 5; i++) insert.run(`own-${i}`, rich.id, 'private', day(700 + i), `Own ${i}`, at, at);
    db().prepare("INSERT INTO awards (id, user_id, unit_id, visibility, date, name, citation, created_at, updated_at) VALUES ('aw-1', ?, 'P1a', 'unit', '2025-05-01', 'NAM', 'For words', ?, ?)").run(rich.id, at, at);
    const counsel = db().prepare("INSERT INTO counselings (id, user_id, unit_id, visibility, date, type, summary, stage, created_at, updated_at) VALUES (?, ?, 'P1a', 'unit', ?, 'monthly', 'Fine', ?, ?, ?)");
    for (let i = 0; i < 3; i++) counsel.run(`cs-${i}`, rich.id, day(i), 'final', at, at);
    counsel.run('cs-draft', rich.id, day(9), 'draft', at, at);
    // Goals list in the order they were set; a cut keeps the newest, as every other list here does.
    const goal = db().prepare("INSERT INTO goals (id, user_id, unit_id, visibility, title, created_at, updated_at) VALUES (?, ?, 'P1a', 'unit', ?, ?, ?)");
    for (let i = 0; i < 520; i++) goal.run(`goal-${String(i).padStart(3, '0')}`, rich.id, `Goal ${i}`, `${day(i)}T00:00:00.000Z`, at);
  })();
  const theirs = await get(op.token, `/api/org/team/${rich.id}`);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const b = theirs.body;
  assert.equal(b.listLimit, 500);
  assert.equal(b.activities.length, 500);
  assert.equal(b.counts.activities, 600, 'the count is of every shared activity, not of the list');
  assert.equal(b.activities[0].date, day(599), 'newest first');
  assert.equal(b.activities.at(-1).date, day(100), 'the oldest are the ones left out');
  assert.ok(b.activities.every((a: { visibility: string }) => a.visibility === 'unit'), 'never a private entry');
  for (const key of ['notes', 'evidence_links', 'fingerprint']) assert.ok(!(key in b.activities[0]), `no ${key} in the list`);
  assert.equal(b.awards.length, 1);
  assert.ok(!('citation' in b.awards[0]));
  assert.equal(b.counts.awards, 1);
  assert.equal(b.counts.counselings, 3, 'a draft not the reader’s is neither listed nor counted');
  assert.equal(b.counselings.length, 3);
  assert.deepEqual([b.counts.trainings, b.counts.duties, b.counts.goals, b.counts.tasks], [0, 0, 520, 0]);
  assert.equal(b.goals.length, 500);
  assert.equal(b.goals[0].id, 'goal-020', 'the oldest goals are the ones left out');
  assert.equal(b.goals.at(-1).id, 'goal-519', 'the newest is kept, last, in the order goals were set');

  const own = await get(rich.token, `/api/org/team/${rich.id}`);
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.counts.activities, 605, 'one’s own page counts one’s private entries too');
  assert.equal(own.body.activities.length, 500);
  assert.equal(own.body.activities[0].date, day(704));
});

test('a Marine’s trainings and awards and the latest roster sync are read by their indexes, in order, with no sort', async () => {
  for (const token of [op.token, rich.token]) {
    const seen = await capture(() => get(token, `/api/org/team/${rich.id}`));
    for (const [table, index] of [['trainings', 'idx_trainings_user_date'], ['awards', 'idx_awards_user_date']] as const) {
      const list = seen.find((s) => s.sql.includes(`FROM ${table} WHERE`) && !s.sql.includes('COUNT('));
      assert.ok(list, `the page reads ${table}`);
      const steps = plan(list.sql, list.args);
      assert.ok(steps.some((d) => d.includes(index)), `${table}: ${steps.join(' | ')}`);
      assert.ok(!steps.some((d) => d.includes('TEMP B-TREE')), `${table} is not sorted in memory: ${steps.join(' | ')}`);
    }
  }
  const overview = await capture(() => get(op.token, '/api/orgs/G8/overview'));
  const sync = overview.find((s) => s.sql.includes('FROM personnel_sync_runs'));
  assert.ok(sync, 'the overview reads the latest sync');
  const steps = plan(sync.sql, sync.args);
  assert.ok(steps.some((d) => d.includes('idx_sync_runs_org')), steps.join(' | '));
  assert.ok(!steps.some((d) => d.includes('TEMP B-TREE') || /^SCAN personnel_sync_runs$/.test(d)), steps.join(' | '));
});

test('the console lists a Unit Instance’s members a page at a time, in order, nobody twice or left out, and nobody from elsewhere', async () => {
  addOrg('G2');
  const ids: string[] = [op.id];
  db().transaction(() => {
    addUnit('G2', 'G2', null, op.id); addUnit('G2a', 'G2', 'G2');
    join(op.id, 'G2');
    db().prepare("INSERT INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES ('G2', ?, 'owner', ?, ?)").run(op.id, op.id, at);
    // Names that sort differently by case, people with the same name, and deactivated accounts, which come last.
    const names = ['mcadams', 'McBride', 'MCCALL', 'Able', 'able', 'Zed'];
    for (let i = 0; i < 500; i++) {
      const id = addUser(i < 60 ? names[i % names.length]! : `Member${String(i).padStart(3, '0')}`, i % 9 === 0 ? 'same' : `F${i}`, i % 41 === 0 ? 0 : 1);
      join(id, i < 5 ? 'G2a' : 'G2', 1);
      ids.push(id);
    }
  })();
  const reference = (db().prepare(`SELECT u.id FROM users u WHERE u.id IN (SELECT value FROM json_each(?))
    ORDER BY u.active DESC, u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE, u.id`).all(JSON.stringify(ids)) as Array<{ id: string }>).map((r) => r.id);
  assert.equal(reference.length, 501);

  const first = await get(op.token, '/api/orgs/G2/members');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.members.length, 500);
  assert.equal(first.body.more, true);
  assert.equal(typeof first.body.next, 'string');
  const second = await get(op.token, `/api/orgs/G2/members?cursor=${first.body.next}`);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual([second.body.members.length, second.body.more, second.body.next], [1, false, null]);
  assert.deepEqual([...first.body.members, ...second.body.members].map((m: { id: string }) => m.id), reference, 'every member once, in the list’s order');

  const walked: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const page: { body: { members: Array<{ id: string; units: Array<{ unit_id: string }> }>; more: boolean; next: string | null } } = await get(op.token, `/api/orgs/G2/members?limit=37${cursor ? `&cursor=${cursor}` : ''}`);
    walked.push(...page.body.members.map((m) => m.id));
    for (const m of page.body.members) assert.ok(m.units.every((u) => u.unit_id === 'G2' || u.unit_id === 'G2a'), 'only this Unit Instance’s units');
    if (!page.body.more) break;
    cursor = page.body.next;
  }
  assert.deepEqual(walked, reference, 'small pages walk the same list');

  const team = await get(op.token, '/api/orgs/G2/members?unit=G2a');
  assert.equal(team.body.members.length, 5, 'one of its units');
  assert.equal(team.body.more, false);
  assert.deepEqual((await get(op.token, '/api/orgs/G2/members?unit=G8')).body.members, [], 'a unit of another Unit Instance matches nobody');
  const found = await get(op.token, '/api/orgs/G2/members?q=mcb');
  assert.ok(found.body.members.length >= 10 && found.body.members.every((m: { last_name: string }) => m.last_name === 'McBride'));

  const bad = await get(op.token, '/api/orgs/G2/members?cursor=not-a-page');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad_cursor');

  const exported = await get(op.token, '/api/orgs/G2/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.members.length, 501, 'the export leaves nobody out');
  const csv = await get(op.token, '/api/orgs/G2/roster.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.trim().split('\n').length > 501, 'nor does the roster file');
});

test('the roster and the team list read the same number of statements for a team or a command of thousands', async (t) => {
  const scope = scopeFor(app.ctx, { id: op.id });
  const measure = async () => {
    let started = performance.now();
    const roster = await capture(() => personnelRoster(app.ctx, scope, op.id, 'G8'));
    const rosterMs = performance.now() - started;
    started = performance.now();
    const team = await capture(() => get(op.token, '/api/org/team'));
    return { roster: roster.length, team: team.length, rosterMs, teamMs: performance.now() - started, rows: personnelRoster(app.ctx, scope, op.id, 'G8').rows.length };
  };
  const small = await measure();
  seedMembers(3000);
  const large = await measure();
  t.diagnostic(`roster ${small.rows} rows: ${small.roster} statements, ${small.rosterMs.toFixed(0)} ms; ${large.rows} rows: ${large.roster} statements, ${large.rosterMs.toFixed(0)} ms`);
  t.diagnostic(`team list: ${small.team} statements, ${small.teamMs.toFixed(0)} ms; then ${large.team} statements, ${large.teamMs.toFixed(0)} ms`);
  assert.ok(large.rows > 3000);
  // A few reads are per Unit Instance or per unit tree (scopes); none is per row.
  assert.ok(small.roster <= 50, `the roster read ${small.roster} statements`);
  assert.equal(large.roster, small.roster, 'however many rows');
  assert.ok(small.team <= 60, `the team list read ${small.team} statements`);
  assert.equal(large.team, small.team, 'however many people');
});
