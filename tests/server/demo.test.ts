import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../server/config.ts';
import { createContext } from '../../server/app.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';
import { purgeExpired } from '../../server/services/demo.ts';
import { startApp, type TestApp } from './helpers.ts';

/**
 * The synthetic demo opens without a sign-in form. These tests hold the lines that make that safe:
 * it cannot run in production or on real data, visitors cannot reach each other, protected APIs
 * still require a session, and a workspace is removed whole.
 */

const DEMO = { VANTAGE_ACCESS_MODE: 'demo' };
const H = { 'x-vantage-client': '1' };
const baseEnv = { NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_EMAIL_PROVIDER: 'none' } as Record<string, string>;

async function start(app: TestApp) {
  const r = await app.call('POST', '/api/demo/start', { headers: H });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const token = r.body.token as string;
  const me = (await app.call('GET', '/api/me', { token })).body;
  return { token, me };
}

test('demo mode is refused in production and alongside anything that reaches real people or networks', () => {
  const bad: Array<Record<string, string>> = [
    { ...DEMO, NODE_ENV: 'production', VANTAGE_SECRET: 'x'.repeat(40), VANTAGE_SETUP_TOKEN: 'y'.repeat(30), VANTAGE_PUBLIC_URL: 'https://demo.example.com' },
    { ...baseEnv, ...DEMO, CAC_MODE: 'proxy', CAC_PROXY_SECRET: 'z'.repeat(40) },
    { ...baseEnv, ...DEMO, VANTAGE_AI_ENABLED: 'true' },
    { ...baseEnv, ...DEMO, VANTAGE_EMAIL_PROVIDER: 'smtp' },
    { ...baseEnv, ...DEMO, VANTAGE_MARADMIN_ENABLED: 'true' },
    { ...baseEnv, VANTAGE_ACCESS_MODE: 'anonymous' },
  ];
  for (const env of bad) assert.throws(() => loadConfig(env as NodeJS.ProcessEnv), Error, JSON.stringify(env));
  assert.equal(loadConfig({ ...baseEnv, ...DEMO } as NodeJS.ProcessEnv).accessMode, 'demo');
  assert.equal(loadConfig({ ...baseEnv } as NodeJS.ProcessEnv).accessMode, 'accounts', 'accounts is the default');
});

test('a demo server refuses a database with real accounts, and an accounts server refuses a demo database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-demo-'));
  try {
    const realPath = join(dir, 'real.db');
    const real = await startApp({ VANTAGE_DB: realPath });
    await real.setupOperator();
    await real.close();
    assert.throws(() => createContext(loadConfig({ ...baseEnv, ...DEMO, VANTAGE_DB: realPath } as NodeJS.ProcessEnv)), /holds real accounts/);

    const demoPath = join(dir, 'demo.db');
    const demo = createContext(loadConfig({ ...baseEnv, ...DEMO, VANTAGE_DB: demoPath } as NodeJS.ProcessEnv));
    demo.db.close();
    assert.throws(() => createContext(loadConfig({ ...baseEnv, VANTAGE_DB: demoPath } as NodeJS.ProcessEnv)), /created for the synthetic demo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('on an accounts instance the demo does not exist', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.call('POST', '/api/demo/start', { headers: H })).status, 404);
    assert.equal((await app.call('GET', '/api/demo/status')).status, 404);
    assert.equal((await app.call('GET', '/api/auth/setup')).body.accessMode, 'accounts');
  } finally { await app.close(); }
});

test('a visitor lands on a synthetic Marine with no form, and sign-in routes are closed', async () => {
  const app = await startApp(DEMO);
  try {
    const setup = (await app.call('GET', '/api/auth/setup')).body;
    assert.equal(setup.accessMode, 'demo');
    assert.equal(setup.needsSetup, false);
    assert.equal((await app.call('POST', '/api/demo/start')).status, 403, 'the CSRF header is still required');

    const { token, me } = await start(app);
    assert.equal(me.user.first_name, 'Jordan');
    assert.equal(me.user.last_name, 'Avery');
    assert.equal(Boolean(me.user.is_operator), false, 'a demo persona is never an operator');

    for (const path of ['/api/auth/login', '/api/auth/register', '/api/auth/setup', '/api/auth/forgot']) {
      const r = await app.call('POST', path, { body: { username: 'x', password: 'y' } });
      assert.equal(r.status, 403, path);
      assert.equal(r.body.code, 'demo_mode', path);
    }
    assert.equal((await app.call('GET', '/api/admin/overview', { token })).status, 403);
    assert.equal((await app.call('POST', '/api/org/units', { token, body: { name: 'Escape' } })).status, 403);
    assert.equal((await app.call('GET', '/api/org/directory', { token })).status, 403);

    // Removing the sign-in form did not remove authorization: no session, no data.
    assert.equal((await app.call('GET', '/api/work/items')).status, 401);
    assert.equal((await app.call('GET', '/api/record/summary')).status, 401);
    assert.equal((await app.call('GET', '/api/me')).status, 401);
  } finally { await app.close(); }
});

test('the synthetic section tells the intended story, and counts shared documents once', async () => {
  const app = await startApp(DEMO);
  try {
    const { token } = await start(app);
    const summary = (await app.call('GET', '/api/record/summary', { token })).body;
    assert.equal(summary.contributions.documents_researched, 39);
    assert.equal(summary.assigned.total, 1, 'Avery holds one item in research');

    const leader = await app.call('POST', '/api/demo/persona', { token, headers: H, body: { persona: 'leader' } });
    assert.equal(leader.status, 200, JSON.stringify(leader.body));
    const lead = leader.body.token as string;
    const me = (await app.call('GET', '/api/me', { token: lead })).body;
    assert.equal(me.user.last_name, 'Diaz');
    assert.equal((await app.call('GET', '/api/me', { token })).status, 401, 'the previous persona’s session ended');

    const unit = me.memberships[0].unit_id;
    const w = (await app.call('GET', `/api/work/workload?unit_id=${unit}`, { token: lead })).body;
    const counts = w.members.map((m: any) => m.documents_researched).sort((a: number, b: number) => a - b);
    assert.deepEqual(counts, [0, 0, 0, 0, 27, 30, 39], 'Brooks and Nguyen record none; the lead and the administrator research none');
    assert.equal(w.section.documents_researched, 81);
    assert.equal(w.section.unassigned, 12);
    assert.equal(w.section.blocked, 1);
    assert.equal(w.section.by_waiting.posting.count, 2);
  } finally { await app.close(); }
});

test('the flagship 2-Way UMT walks through to the reference arithmetic', async () => {
  const app = await startApp(DEMO);
  try {
    const { token } = await start(app);
    const list = (await app.call('GET', '/api/work/items?q=SYN-26-P-0047', { token })).body.items;
    assert.equal(list.length, 1);
    const id = list[0].id;
    assert.equal(list[0].claimed_by, null, 'the walkthrough starts from an unclaimed item');
    assert.equal((await app.call('POST', `/api/work/items/${id}/claim`, { token, headers: H, body: {} })).status, 200);
    for (const body of [
      { kind: 'observation', field: 'current_award', amount: '$91,250.00', system: 'DAI' },
      { kind: 'observation', field: 'invoice_amount', amount: '$45,000.00', reference: 'SYN-INV-0047-1', system: 'DAI' },
      { kind: 'observation', field: 'invoice_amount', amount: '$44,725.00', reference: 'SYN-INV-0047-2', system: 'DAI' },
    ]) assert.equal((await app.call('POST', `/api/work/items/${id}/entries`, { token, headers: H, body })).status, 201);
    const calc = await app.call('POST', `/api/work/items/${id}/calculate`, { token, headers: H });
    const body = JSON.parse(calc.body.body);
    assert.equal(body.umt_amount_cents, 430_000, 'the UMT amount came from the imported sheet');
    assert.equal(body.inputs.find((i: any) => i.field === 'umt_amount').source, 'source_file');
    assert.equal(body.adjustment_cents, 277_500);
    assert.equal(body.target_award_cents, 9_402_500);
  } finally { await app.close(); }
});

test('visitors cannot see or touch each other’s workspaces', async () => {
  const app = await startApp(DEMO);
  try {
    const a = await start(app);
    const b = await start(app);
    assert.notEqual(a.me.memberships[0].unit_id, b.me.memberships[0].unit_id);
    const aItems = (await app.call('GET', '/api/work/items', { token: a.token })).body.items;
    const bItems = (await app.call('GET', '/api/work/items', { token: b.token })).body.items;
    const aIds = new Set(aItems.map((i: any) => i.id));
    assert.ok(!bItems.some((i: any) => aIds.has(i.id)), 'no item appears in both');
    const target = aItems[0].id;
    assert.equal((await app.call('GET', `/api/work/items/${target}`, { token: b.token })).status, 403);
    assert.equal((await app.call('POST', `/api/work/items/${target}/claim`, { token: b.token, headers: H, body: {} })).status, 403);
    const mine = bItems.find((i: any) => !i.claimed_by && i.state === 'open');
    await app.call('POST', `/api/work/items/${mine.id}/claim`, { token: b.token, headers: H, body: {} });
    const handoff = await app.call('POST', `/api/work/items/${mine.id}/handoff`, { token: b.token, headers: H, body: { to_user_id: a.me.user.id, note: 'over the wall' } });
    assert.equal(handoff.status, 400, 'work cannot be handed across workspaces');
    const search = (await app.call('GET', '/api/search?q=SYN', { token: b.token })).body;
    assert.ok(!JSON.stringify(search).includes(target));
  } finally { await app.close(); }
});

test('reset and expiry remove a workspace whole and leave the audit chain intact', async () => {
  const app = await startApp({ ...DEMO, VANTAGE_DEMO_MAX_WORKSPACES: '2' });
  try {
    const a = await start(app);
    const oldUsers = app.ctx.db.prepare('SELECT id FROM users WHERE demo_workspace_id IS NOT NULL').all().map((r: any) => r.id);
    const oldUnit = a.me.memberships[0].unit_id;
    const reset = await app.call('POST', '/api/demo/reset', { token: a.token, headers: H });
    assert.equal(reset.status, 200);

    const tables = app.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name as string);
    for (const table of tables) {
      const cols = app.ctx.db.prepare(`PRAGMA table_info("${table}")`).all().map((c: any) => c.name as string);
      for (const col of cols.filter((c) => /(^|_)(user_id|actor_id|subject_id|owner_id|claimed_by|assignee_id|author_id|uploaded_by|owner_user_id|persona_user_id|leader_user_id)$/.test(c) || c === 'unit_id')) {
        const hits = app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${col}" IN (${[...oldUsers, oldUnit].map(() => '?').join(',')})`).get(...oldUsers, oldUnit) as { n: number };
        assert.equal(hits.n, 0, `${table}.${col} still references the removed workspace`);
      }
    }
    assert.deepEqual(app.ctx.db.pragma('foreign_key_check'), []);
    assert.equal(verifyAuditChain(app.ctx).ok, true, 'the demo audit chain is resealed after removal');

    // Capacity is stated, not silently exceeded.
    await start(app);
    const full = await app.call('POST', '/api/demo/start', { headers: H });
    assert.equal(full.status, 503);
    assert.equal(full.body.code, 'demo_full');

    // Expiry.
    app.ctx.db.prepare("UPDATE demo_workspaces SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal(purgeExpired(app.ctx), 2);
    assert.equal((await app.call('GET', '/api/me', { token: reset.body.token })).status, 401);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0);
  } finally { await app.close(); }
});

test('the seeded history follows the procedure, and every seeded calculation matches a fresh recomputation', async () => {
  const app = await startApp(DEMO);
  try {
    await start(app);
    const { db } = app.ctx;
    const calcs = db.prepare("SELECT work_item_id, body FROM work_events WHERE kind = 'calculation'").all() as Array<{ work_item_id: string; body: string }>;
    assert.ok(calcs.length > 50);
    const { candidateAdjustment } = await import('../../shared/procedures.ts');
    const { eventsFor, toCaseEvent } = await import('../../server/services/cases.ts');
    for (const c of calcs) {
      const stored = JSON.parse(c.body);
      const fresh = candidateAdjustment(eventsFor(app.ctx, c.work_item_id).map(toCaseEvent));
      assert.ok(fresh.ok);
      if (!fresh.ok) continue;
      assert.equal(stored.adjustment_cents, fresh.adjustment_cents);
      assert.equal(stored.target_award_cents, fresh.target_award_cents);
      assert.deepEqual(stored.inputs.map((i: any) => i.event_id).sort(), fresh.inputs.map((i) => i.event_id).sort(), 'the seed cites the same events a recomputation would');
    }
    // An item waiting on verification is next asked to verify, not to redo research.
    const token = (await app.call('POST', '/api/demo/start', { headers: H })).body.token;
    const waitingOnVerification = (await app.call('GET', '/api/work/items?stage=verification_required', { token })).body.items[0];
    const detail = (await app.call('GET', `/api/work/items/${waitingOnVerification.id}`, { token })).body;
    assert.equal(detail.case.progress.next, 'verify_invoice');
  } finally { await app.close(); }
});

test('three personas, one for each access level, and levels change only inside the synthetic section', async () => {
  const app = await startApp(DEMO);
  try {
    const { token, me } = await start(app);
    assert.equal(me.accessLevel, 'personal');
    const unit = me.memberships[0].unit_id;
    // Every member sees the section: the roster and its totals.
    assert.equal((await app.call('GET', '/api/org/team', { token })).body.roster.length, 7);
    assert.equal((await app.call('GET', `/api/work/workload?unit_id=${unit}`, { token })).body.members.length, 0);

    const lead = (await app.call('POST', '/api/demo/persona', { token, headers: H, body: { persona: 'leader' } })).body.token as string;
    const asLead = (await app.call('GET', '/api/me', { token: lead })).body;
    assert.equal(asLead.accessLevel, 'leader');
    assert.equal(asLead.demo.workspace.persona, 'leader');

    const admin = (await app.call('POST', '/api/demo/persona', { token: lead, headers: H, body: { persona: 'admin' } })).body.token as string;
    const asAdmin = (await app.call('GET', '/api/me', { token: admin })).body;
    assert.equal(asAdmin.user.last_name, 'Reyes');
    assert.equal(asAdmin.accessLevel, 'administrator');
    assert.equal(asAdmin.demo.workspace.persona, 'admin');
    assert.equal(Boolean(asAdmin.user.is_operator), false, 'a team administrator, never the instance owner');

    const people = (await app.call('GET', '/api/people', { token: admin })).body;
    assert.equal(people.people.length, 7);
    assert.deepEqual([people.stats.personal, people.stats.leader, people.stats.administrator], [5, 1, 1]);
    const chen = people.people.find((p: any) => p.last_name === 'Chen');
    const up = await app.call('PUT', `/api/people/${chen.id}/teams/${unit}`, { token: admin, headers: H, body: { level: 'leader' } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    // Membership stays as seeded, and nothing reaches beyond the workspace.
    const add = await app.call('POST', `/api/people/${chen.id}/teams`, { token: admin, headers: H, body: { unit_id: unit } });
    assert.equal(add.status, 403);
    assert.equal(add.body.code, 'demo_mode');
    assert.equal((await app.call('DELETE', `/api/people/${chen.id}/teams/${unit}`, { token: admin, headers: H })).body.code, 'demo_mode');

    const other = await start(app);
    const theirs = (await app.call('GET', '/api/org/teams', { token: other.token })).body.teams;
    assert.deepEqual(theirs.map((t: any) => t.id), [other.me.memberships[0].unit_id], 'a visitor sees their own section, not another visitor’s');
    assert.equal((await app.call('PUT', `/api/people/${chen.id}/teams/${unit}`, { token: other.token, headers: H, body: { level: 'personal' } })).status, 403);
  } finally { await app.close(); }
});
