import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { audit, auditListedRecords, orgAuditClause, orgAuditWhere, recentChainCheck, verifyAuditChain } from '../../server/services/audit.ts';
import { auditRows, type AuditTrail } from '../../server/services/auditQuery.ts';
import { buildPersonalExport, buildPersonalExportZip, personalAuditTrail, PERSONAL_AUDIT_MAX } from '../../server/services/personalExport.ts';
import { auditAppendOnlyTriggers, openDatabase } from '../../server/db/index.ts';
import { readZip } from '../../server/lib/zip.ts';

/**
 * The audit trails at scale (ADR-0032): the platform's, a Unit Instance's, a unit's access log and a Marine's
 * own. Showing the chain's state does not walk the whole log on every page; the explicit check always does. The action
 * list and a Unit Instance's entries are read from indexes. Every access log pages back to its oldest entry, and an
 * export that holds less than the whole trail says so.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person;
let marine: Person;
let g1lead: Person;
const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (on: TestApp, username: string) => (await on.login(username)).body.token as string;

/** Runs fn while noting the SQL of every statement prepared on `on`'s database. */
async function preparing<T>(on: TestApp, fn: () => T | Promise<T>): Promise<{ result: T; sql: string[] }> {
  const db = on.ctx.db;
  const prepare = db.prepare;
  const sql: string[] = [];
  db.prepare = ((text: string) => { sql.push(text); return prepare.call(db, text); }) as typeof db.prepare;
  try { return { result: await fn(), sql }; } finally { db.prepare = prepare; }
}
/** The chain walk: the one statement that reads every entry of the log in order. */
const isChainWalk = (sql: string) => /^SELECT .+ FROM audit_log ORDER BY seq$/.test(sql);
const plan = (on: TestApp, sql: string, ...params: unknown[]) =>
  (on.ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  marine = await app.register('scalemarine');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = await login(app, 'scalemarine');
  g1lead = await app.register('scaleg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login(app, 'scaleg1lead');
});
after(async () => { await app.close(); });

test('AUD-1: pages that show the chain share one check a minute; the integrity check walks the chain every time', async () => {
  const explicit = await preparing(app, async () => [await get(op.token, '/api/platform/integrity'), await get(op.token, '/api/platform/integrity')]);
  assert.ok(explicit.result.every((r) => r.status === 200 && r.body.audit.ok === true));
  assert.equal(explicit.sql.filter(isChainWalk).length, 2, 'each integrity check is a fresh walk of the chain');

  // Within the minute after it, nothing that only shows the chain's state walks it again: filters applied one after
  // another, the overview, the health report and a Unit Instance's trail.
  const shown = await preparing(app, async () => ({
    first: await get(op.token, '/api/platform/audit?q=a'),
    second: await get(op.token, '/api/platform/audit?q=b'),
    overview: await get(op.token, '/api/platform/overview'),
    operations: await get(op.token, '/api/platform/operations'),
    instance: await get(op.token, '/api/orgs/G8/audit'),
  }));
  assert.equal(shown.sql.filter(isChainWalk).length, 0, 'no walk of the chain');
  const { first, second, overview, operations, instance } = shown.result;
  assert.equal(first.body.chain.ok, true);
  assert.equal(second.body.chain.ok, true);
  assert.equal(overview.body.audit.ok, true);
  assert.equal(operations.body.health.checks.find((c: { id: string }) => c.id === 'audit_chain').status, 'ok');
  assert.deepEqual(Object.keys(instance.body.chain).sort(), ['count', 'ok'], 'a Unit Instance hears whether it holds and its own count, nothing of the service');
  assert.equal(instance.body.chain.ok, true);
  assert.ok(first.body.chain.checkedAt, 'the trail says when the chain was checked');

  // A minute on, the next page walks it once, and the one after shares that answer again.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  try {
    const later = await preparing(app, () => [recentChainCheck(app.ctx), recentChainCheck(app.ctx)]);
    assert.equal(later.sql.filter(isChainWalk).length, 1);
    assert.ok(later.result.every((c) => c.ok));
  } finally { mock.timers.reset(); }
  // Fresh again for the tests after this one.
  verifyAuditChain(app.ctx);
});

test('AUD-1: a rewrite the integrity check finds shows on every page that shows the chain, at once', async () => {
  const victim = app.ctx.db.prepare("SELECT seq, id, detail FROM audit_log WHERE action = 'setup'").get() as { seq: number; id: string; detail: string | null };
  const total = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  app.ctx.db.exec('DROP TRIGGER audit_log_no_update');
  try {
    app.ctx.db.prepare("UPDATE audit_log SET detail = 'rewritten' WHERE seq = ?").run(victim.seq);
    const check = await get(op.token, '/api/platform/integrity');
    assert.equal(check.body.audit.ok, false);
    assert.match(check.body.audit.reason, new RegExp(victim.id), 'the integrity check names the entry');
    assert.ok(check.body.audit.count >= total, 'and counts every entry the log holds, as it always has');
    assert.equal((await get(op.token, '/api/platform/audit')).body.chain.ok, false, 'the trail says so without waiting out the minute');
    const instance = (await get(op.token, '/api/orgs/G8/audit')).body.chain;
    assert.equal(instance.ok, false);
    assert.doesNotMatch(String(instance.reason), new RegExp(victim.id), 'a Unit Instance is not told which entry, which may be another’s');
  } finally {
    app.ctx.db.prepare('UPDATE audit_log SET detail = ? WHERE seq = ?').run(victim.detail, victim.seq);
    auditAppendOnlyTriggers(app.ctx.db);
  }
  assert.equal(verifyAuditChain(app.ctx).ok, true, 'put back as it was');
  assert.equal((await get(op.token, '/api/platform/audit')).body.chain.ok, true);
});

test('AUD-2: the action list comes with the unfiltered first page only, from the index, and never crosses Unit Instances', async () => {
  audit(app.ctx, { actor_id: op.id, action: 'scale_g8_probe', category: 'unit', entity: 'test', org_id: 'G8' });
  const g8 = await get(op.token, '/api/orgs/G8/audit');
  assert.ok(g8.body.actions.includes('scale_g8_probe'));
  assert.ok(!(await get(g1lead.token, '/api/orgs/G1/audit')).body.actions.includes('scale_g8_probe'), 'G-1’s list never holds what only G-8 did');
  for (const filter of ['action=scale_g8_probe', 'q=probe', 'category=unit', 'from=2020-01-01&to=2021-12-31', 'from=2098-01-01&to=2099-01-01', 'unit=G8', `before=${g8.body.rows[0].seq}`]) {
    const res = await get(op.token, `/api/orgs/G8/audit?${filter}`);
    assert.equal(res.status, 200, filter);
    assert.equal(res.body.actions, null, `${filter}: a filtered page carries no action list`);
  }
  const platform = await get(op.token, '/api/platform/audit');
  assert.ok(platform.body.actions.includes('login'));
  assert.ok(!platform.body.actions.includes('scale_g8_probe'), 'nor the platform’s');
  assert.equal((await get(op.token, '/api/platform/audit?action=login')).body.actions, null);

  // The list is kept for a minute, and what was done a moment ago is already in it, in its place, without a full read.
  audit(app.ctx, { actor_id: op.id, action: 'scale_a_probe', category: 'unit', entity: 'test', org_id: 'G8' });
  const again = await preparing(app, () => get(op.token, '/api/orgs/G8/audit'));
  assert.ok(again.result.body.actions.includes('scale_a_probe'));
  assert.deepEqual(again.result.body.actions, [...again.result.body.actions].sort());
  assert.equal(again.sql.filter((s) => s.startsWith('SELECT DISTINCT al.action FROM audit_log al WHERE')).length, 0, 'no full read within the minute');
  assert.ok(!(await get(g1lead.token, '/api/orgs/G1/audit')).body.actions.includes('scale_a_probe'));

  const actions = plan(app, 'SELECT DISTINCT al.action FROM audit_log al WHERE al.org_id IS NULL AND al.unit_id IS NULL ORDER BY al.action');
  assert.match(actions, /COVERING INDEX idx_audit_trail_action/);
  assert.doesNotMatch(actions, /TEMP B-TREE/);
  const instance = plan(app, 'SELECT DISTINCT al.action FROM audit_log al WHERE al.org_id = ? ORDER BY al.action', 'G8');
  assert.match(instance, /COVERING INDEX idx_audit_trail_action \(org_id=\?\)/);
});

test('AUD-3: a Unit Instance without older entries is read by org_id alone, with the same rows as the wider predicate', async () => {
  for (let i = 0; i < 5; i++) audit(app.ctx, { actor_id: g1lead.id, action: 'view_roster', entity: 'unit', unit_id: 'G1' });
  const own = orgAuditWhere(app.ctx, 'G1');
  assert.deepEqual(own, { where: 'al.org_id = ?', params: ['G1'] });
  const narrow: AuditTrail = { ...own };
  const wide: AuditTrail = { where: orgAuditClause('al'), params: ['G1', 'G1'] };
  assert.deepEqual(auditRows(app.ctx, narrow, {}, 1000), auditRows(app.ctx, wide, {}, 1000));
  assert.deepEqual(auditRows(app.ctx, narrow, { q: 'roster' }, 1000), auditRows(app.ctx, wide, { q: 'roster' }, 1000));

  // The route uses it, and pages as before.
  const seen = await preparing(app, () => get(g1lead.token, '/api/orgs/G1/audit?limit=2'));
  const page = seen.result.body;
  assert.equal(page.rows.length, 2);
  assert.equal(page.next, page.rows[1].seq);
  const expected = auditRows(app.ctx, wide, {}, 3).map((r) => r.seq);
  assert.deepEqual(page.rows.map((r: { seq: number }) => r.seq), expected.slice(0, 2));
  const list = seen.sql.find((s) => s.startsWith('SELECT al.seq, al.id') && s.includes('al.org_id = ?'))!;
  assert.ok(list, 'the list reads by org_id alone');
  assert.doesNotMatch(list, /org_id IS NULL/);
  const listPlan = plan(app, list, 'G1', 3);
  assert.match(listPlan, /idx_audit_org/);
  assert.doesNotMatch(listPlan, /SCAN al\b/);
  const probe = seen.sql.find((s) => s.startsWith('SELECT 1 FROM audit_log al WHERE al.org_id IS NULL'))!;
  assert.match(plan(app, probe, 'G1'), /COVERING INDEX idx_audit_trail_action \(org_id=\? AND unit_id=\?\)/, 'the question costs one index probe per unit');

  // Isolation holds as it did: G-1 never sees G-8’s entries, and a unit of G-8 is not a filter in G-1.
  assert.ok((await get(g1lead.token, '/api/orgs/G1/audit?limit=1000')).body.rows.every((r: { org_id: string | null }) => r.org_id === 'G1'));
  assert.equal((await get(g1lead.token, '/api/orgs/G1/audit?unit=G8')).status, 404);
  assert.equal((await get(g1lead.token, '/api/orgs/G8/audit')).status, 404);
});

test('AUD-3: an entry written before its unit joined the Unit Instance is still in the instance’s trail', async () => {
  const other = await startApp();
  try {
    const lead = await other.setupOperator();
    assert.equal(orgAuditWhere(other.ctx, 'G8').where, 'al.org_id = ?');
    // As the database holds an entry from before Unit Instances: a unit of G-8, and no organization.
    other.ctx.db.prepare("INSERT INTO audit_log (id, actor_id, action, entity, unit_id, at, entry_hash) VALUES ('legacy-g8', ?, 'view_personnel', 'user', 'G8', ?, 'x')").run(lead.id, '2024-01-01T00:00:00.000Z');
    assert.equal(orgAuditWhere(other.ctx, 'G8').where, orgAuditClause('al'), 'asked again on every read, never remembered');
    const trail = await other.call('GET', '/api/orgs/G8/audit?limit=1000', { token: lead.token });
    assert.equal(trail.status, 200);
    assert.ok(trail.body.rows.some((r: { id: string }) => r.id === 'legacy-g8'));
    assert.ok(trail.body.actions.includes('view_personnel'));
  } finally { await other.close(); }
});

test('AUD-7: a Marine’s access log and a unit’s page back with before and next to the oldest entry', async () => {
  for (let i = 0; i < 7; i++) audit(app.ctx, { actor_id: op.id, action: 'view_personnel', entity: 'user', entity_id: marine.id, subject_id: marine.id, unit_id: 'G8' });
  audit(app.ctx, { actor_id: marine.id, action: 'view_record', entity: 'activities', subject_id: marine.id, unit_id: 'G8' });
  const expected = (app.ctx.db.prepare('SELECT seq FROM audit_log WHERE subject_id = ? AND actor_id <> ? ORDER BY seq DESC').all(marine.id, marine.id) as Array<{ seq: number }>).map((r) => r.seq);
  assert.ok(expected.length >= 7);

  const pages: Array<{ rows: Array<{ seq: number }>; next: number | null }> = [];
  let before: number | null = null;
  const seen = await preparing(app, async () => {
    do {
      const res = await get(marine.token, `/api/me/audit?limit=3${before ? `&before=${before}` : ''}`);
      assert.equal(res.status, 200);
      pages.push(res.body);
      before = res.body.next;
    } while (before && pages.length < 20);
  });
  assert.ok(pages.slice(0, -1).every((p) => p.rows.length === 3 && p.next === p.rows[2].seq));
  assert.equal(pages.at(-1)!.next, null, 'the last page says there is nothing older');
  assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.seq)), expected, 'every entry about them by someone else, once, newest first');
  const mine = seen.sql.find((s) => s.includes('WHERE al.subject_id = ? AND al.actor_id <> ? AND al.seq < ?'))!;
  assert.match(plan(app, mine, marine.id, marine.id, 1e9, 4), /idx_audit_subject \(subject_id=\? AND seq<\?\)/);
  assert.equal((await get(marine.token, '/api/me/audit')).body.rows.length, expected.length, 'a hundred to a page by default');
  for (const bad of ['limit=0', 'limit=1001', 'limit=x', 'before=-1', 'before=x']) assert.equal((await get(marine.token, `/api/me/audit?${bad}`)).status, 400, bad);

  // The unit's access log: what the reader may read is decided before any entry is read.
  const unitExpected = (app.ctx.db.prepare("SELECT seq FROM audit_log WHERE unit_id = 'G8' ORDER BY seq DESC").all() as Array<{ seq: number }>).map((r) => r.seq);
  const unitPages: Array<{ rows: Array<{ seq: number; actor_first: string | null }>; next: number | null; unit_id: string }> = [];
  before = null;
  do {
    const res = await get(op.token, `/api/org/units/G8/audit?limit=50${before ? `&before=${before}` : ''}`);
    assert.equal(res.status, 200);
    unitPages.push(res.body);
    before = res.body.next;
  } while (before && unitPages.length < 100);
  assert.equal(unitPages[0].unit_id, 'G8');
  assert.deepEqual(unitPages.flatMap((p) => p.rows.map((r) => r.seq)), unitExpected);
  assert.equal(unitPages.at(-1)!.next, null);
  assert.ok(unitPages[0].rows.some((r) => r.actor_first === 'John'), 'each entry names who did it');
  const refused = await preparing(app, () => get(marine.token, '/api/org/units/G8/audit?limit=5&before=999999'));
  assert.equal(refused.result.status, 403);
  assert.ok(!refused.sql.some((s) => s.includes('FROM audit_log al LEFT JOIN users act')), 'refused before a single entry is read');
  assert.equal((await get(op.token, '/api/org/units/G8/audit?limit=0')).status, 400);
  const unitSql = 'SELECT al.seq FROM audit_log al WHERE al.unit_id = ? AND al.seq < ? ORDER BY al.seq DESC LIMIT ?';
  assert.match(plan(app, unitSql, 'G8', 1e9, 51), /idx_audit_unit \(unit_id=\? AND seq<\?\)/);
});

test('AUD-8: the personal export reads its trail newest first from two indexes, and says when it holds less than all of it', async () => {
  const everything = (app.ctx.db.prepare('SELECT id FROM audit_log WHERE actor_id = ? OR subject_id = ? ORDER BY seq DESC').all(op.id, op.id) as Array<{ id: string }>).map((r) => r.id);
  const whole = personalAuditTrail(app.ctx, op.id, everything.length + 10);
  assert.equal(whole.cut, null);
  assert.deepEqual(whole.rows.map((r) => r.id), everything, 'the same entries the one query gave, in the same order');
  assert.ok(!('seq' in whole.rows[0]), 'and the same columns');

  const cut = personalAuditTrail(app.ctx, op.id, 5);
  assert.deepEqual(cut.rows.map((r) => r.id), everything.slice(0, 5));
  assert.deepEqual({ kept: cut.cut!.kept, total: cut.cut!.total }, { kept: 5, total: everything.length });
  assert.equal(cut.cut!.oldest_at, cut.rows[4].at);

  const seen = await preparing(app, () => personalAuditTrail(app.ctx, op.id, 5));
  const merged = seen.sql.find((s) => s.includes('UNION ALL'))!;
  const merging = plan(app, merged, { me: op.id, limit: 6 });
  assert.match(merging, /idx_audit_actor/);
  assert.match(merging, /idx_audit_subject/);
  assert.doesNotMatch(merging, /TEMP B-TREE|SCAN al\b/);

  // A draft counseling stays out of the Marine's trail, as before (ADR-0027).
  assert.equal(buildPersonalExport(app.ctx, marine.id).audit_trail_cut, null);
  assert.equal(PERSONAL_AUDIT_MAX, 20_000);
});

test('AUD-8, AUD-11: past the limits, the personal export says it was cut and a trail export is refused before a row is read', async () => {
  const big = await startApp();
  try {
    const lead = await big.setupOperator();
    // More entries than one trail export holds, all the operator's own sign-ins: written straight to the table, which
    // is quicker than sealing each, since nothing here verifies the chain.
    const insert = big.ctx.db.prepare("INSERT INTO audit_log (id, actor_id, action, at, entry_hash, category) VALUES (?, ?, 'login', ?, 'x', 'user')");
    big.ctx.db.transaction(() => { for (let i = 0; i < 50_001; i++) insert.run(`bulk-${i}`, lead.id, new Date(Date.parse('2025-01-01T00:00:00Z') + i * 1000).toISOString()); })();

    const refused = await preparing(big, () => big.call('GET', '/api/platform/audit/export?format=csv', { token: lead.token }));
    assert.equal(refused.result.status, 400);
    assert.equal(refused.result.body.code, 'export_too_large');
    assert.ok(refused.sql.some((s) => s.startsWith('SELECT COUNT(*) AS n FROM (SELECT 1 FROM audit_log al')), 'counted');
    assert.ok(!refused.sql.some((s) => s.startsWith('SELECT al.seq, al.id')), 'and refused before an entry is read');

    const archive = buildPersonalExport(big.ctx, lead.id, { attachments: false });
    assert.equal(archive.audit_trail.length, PERSONAL_AUDIT_MAX);
    assert.equal(archive.counts.audit_trail, PERSONAL_AUDIT_MAX);
    const total = (big.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? OR subject_id = ?').get(lead.id, lead.id) as { n: number }).n;
    assert.equal(archive.audit_trail_cut!.total, total);
    assert.equal(archive.audit_trail_cut!.kept, PERSONAL_AUDIT_MAX);
    const zip = readZip(buildPersonalExportZip(big.ctx, lead.id).buffer);
    const readme = zip.get('README.txt')!.toString('utf8');
    assert.match(readme, new RegExp(`newest 20,000 of the ${total.toLocaleString('en-US')} audit entries`));
    assert.match(JSON.parse(zip.get('vantage-export.json')!.toString('utf8')).audit_trail_cut.oldest_at, /^2025-01-01T/);
  } finally { await big.close(); }
});

test('AUD-11: a list page leaves out each entry’s seals; an exported file keeps them', async () => {
  const list = (await get(op.token, '/api/platform/audit?limit=5')).body.rows;
  assert.ok(list.length > 0);
  for (const r of list) {
    assert.ok(!('entry_hash' in r) && !('prev_hash' in r));
    assert.ok('seq' in r && 'action' in r && 'actor_id' in r && 'org_id' in r && 'category' in r);
  }
  const file = await get(op.token, '/api/platform/audit/export?format=json&action=login');
  assert.equal(file.status, 200);
  assert.match(file.body.rows[0].entry_hash, /^[0-9a-f]{64}$/);
});

test('AUD-13: the list-read throttle asks once per list, on the bounded range of idx_audit_action, whatever the statistics', async () => {
  const listed = [{ user_id: marine.id, unit_id: 'G8' }, { user_id: g1lead.id, unit_id: 'G1' }, { user_id: op.id, unit_id: 'G8' }, { user_id: marine.id, unit_id: 'G8' }];
  const count = () => (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'list_records' AND actor_id = ? AND entity = 'trainings'").get(op.id) as { n: number }).n;
  const start = count();
  const first = await preparing(app, () => auditListedRecords(app.ctx, op.id, 'trainings', listed));
  assert.equal(count() - start, 2, 'one entry for each other Marine and unit');
  const probes = first.sql.filter((s) => s.includes("action = 'list_records' AND at > ?"));
  assert.equal(probes.length, 1, 'one read for the whole list');
  const again = await preparing(app, () => auditListedRecords(app.ctx, op.id, 'trainings', listed));
  assert.equal(count() - start, 2, 'nothing again within five minutes');
  assert.ok(!again.sql.some((s) => s.startsWith('INSERT INTO audit_log')));

  const fresh = openDatabase(':memory:');
  try {
    const plain = (fresh.prepare(`EXPLAIN QUERY PLAN ${probes[0]}`).all(new Date().toISOString(), op.id, 'trainings') as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    assert.match(plain, /idx_audit_action \(action=\? AND at>\?\)/, 'with no statistics');
  } finally { fresh.close(); }
  app.ctx.db.exec('ANALYZE');
  assert.match(plan(app, probes[0], new Date().toISOString(), op.id, 'trainings'), /idx_audit_action \(action=\? AND at>\?\)/, 'and with them');
});
