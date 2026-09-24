import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../server/config.ts';
import { forwardPending, pseudonym } from '../../server/services/posthog.ts';
import { startApp } from './helpers.ts';

/**
 * PostHog sees the synthetic demo or nothing, and from the demo it sees only what the event catalog
 * declares: named screens and procedure steps, never what anybody typed, a document number, a
 * record, or an id that could be joined back to a person.
 */

const baseEnv = { NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_EMAIL_PROVIDER: 'none' } as Record<string, string>;
const KEY = 'phc_SyntheticTestProjectKey123';
const DEMO = { VANTAGE_ACCESS_MODE: 'demo', VANTAGE_POSTHOG_KEY: KEY, VANTAGE_POSTHOG_HOST: 'https://posthog.example.test' };
const H = { 'x-vantage-client': '1' };
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('PostHog is off by default, refused outside the synthetic demo, and needs an https host', () => {
  assert.equal(loadConfig({ ...baseEnv } as NodeJS.ProcessEnv).posthog, null);
  assert.equal(loadConfig({ ...baseEnv, VANTAGE_ACCESS_MODE: 'demo' } as NodeJS.ProcessEnv).posthog, null);
  assert.throws(() => loadConfig({ ...baseEnv, VANTAGE_POSTHOG_KEY: KEY } as NodeJS.ProcessEnv), /only accepted with VANTAGE_ACCESS_MODE=demo/);
  assert.throws(() => loadConfig({ ...baseEnv, ...DEMO, VANTAGE_POSTHOG_HOST: 'http://posthog.example.test' } as NodeJS.ProcessEnv), /https/);
  assert.throws(() => loadConfig({ ...baseEnv, ...DEMO, VANTAGE_POSTHOG_KEY: 'not a key!' } as NodeJS.ProcessEnv), /does not look like/);
  const on = loadConfig({ ...baseEnv, VANTAGE_ACCESS_MODE: 'demo', VANTAGE_POSTHOG_KEY: KEY } as NodeJS.ProcessEnv).posthog;
  assert.deepEqual(on, { key: KEY, host: 'https://us.i.posthog.com' });
});

function fakePostHog() {
  const sent: Array<{ url: string; body: any }> = [];
  let failing = false;
  const send = (async (url: string | URL | Request, init?: RequestInit) => {
    if (failing) throw new Error('unreachable');
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch;
  return { sent, send, fail: (v: boolean) => { failing = v; } };
}

test('a visit is forwarded as named screens and steps, pseudonymous, with nothing anybody typed', async () => {
  const app = await startApp(DEMO);
  const posthog = fakePostHog();
  const state = { attempts: 0 };
  try {
    // Switching forwarding on starts from now.
    await forwardPending(app.ctx, state, posthog.send);

    const r = await app.call('POST', '/api/demo/start', { headers: H });
    const token = r.body.token as string;
    const me = (await app.call('GET', '/api/me', { token })).body;
    assert.equal(me.demo.measured_with, 'posthog', 'the visitor is told');
    const id = (await app.call('GET', '/api/work/items?q=SYN-26-P-0047', { token })).body.items[0].id;
    await app.call('POST', `/api/work/items/${id}/claim`, { token, headers: H, body: {} });
    for (const body of [
      { kind: 'observation', field: 'current_award', amount: '$91,250.00', system: 'DAI' },
      { kind: 'observation', field: 'invoice_amount', amount: '$45,000.00', reference: 'SYN-INV-0047-1', system: 'DAI' },
      { kind: 'observation', field: 'invoice_amount', amount: '$44,725.00', reference: 'SYN-INV-0047-2', system: 'DAI' },
      { kind: 'finding', text: 'PRIVATE-FINDING-TEXT about the vendor' },
    ]) assert.equal((await app.call('POST', `/api/work/items/${id}/entries`, { token, headers: H, body })).status, 201);
    assert.equal((await app.call('POST', `/api/work/items/${id}/calculate`, { token, headers: H })).status, 201);
    const blocked = await app.call('POST', `/api/work/items/${id}/stage`, { token, headers: H, body: { stage: 'blocked', reason: 'PRIVATE-FINDING-TEXT vendor has not answered' } });
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    await app.call('POST', `/api/work/items/${id}/stage`, { token, headers: H, body: { stage: 'researching' } });
    // A submission the control refuses is counted by its reason.
    const refused = await app.call('POST', `/api/work/items/${id}/entries`, { token, headers: H, body: { kind: 'action_submitted', step: 'submit_modification', reference: 'SYN-MOD-1' } });
    assert.equal(refused.status, 409);
    // A client event carrying something undeclared: only the declared surface survives.
    await app.call('POST', '/api/events', { token, headers: H, body: { events: [{ name: 'surface.viewed', properties: { surface: 'work_item', path: `/work/items/${id}`, note: 'PRIVATE-FINDING-TEXT' } }] } });
    const leader = await app.call('POST', '/api/demo/persona', { token, headers: H, body: { persona: 'leader' } });
    await app.call('POST', '/api/events', { token: leader.body.token, headers: H, body: { events: [{ name: 'surface.viewed', properties: { surface: 'workload' } }] } });

    const result = await forwardPending(app.ctx, state, posthog.send);
    assert.equal(result.failed, false);
    assert.equal(posthog.sent.length, 1);
    const { url, body } = posthog.sent[0];
    assert.equal(url, 'https://posthog.example.test/batch/');
    assert.equal(body.api_key, KEY);
    const names = body.batch.map((e: any) => e.event);
    for (const expected of ['demo.started', 'work.claimed', 'case.entry_recorded', 'case.calculated', 'case.stage_changed', 'case.control_refused', 'demo.persona_switched', '$pageview']) {
      assert.ok(names.includes(expected), `${expected} was forwarded (got ${names.join(', ')})`);
    }
    const moves = body.batch.filter((e: any) => e.event === 'case.stage_changed').map((e: any) => `${e.properties.from}>${e.properties.to}`);
    assert.deepEqual(moves, ['researching>blocked', 'blocked>researching'], 'stage moves carry the stage names and not the reason given');
    const calc = body.batch.find((e: any) => e.event === 'case.calculated');
    assert.deepEqual({ direction: calc.properties.direction, requires_review: calc.properties.requires_review }, { direction: 'upward', requires_review: false });
    const control = body.batch.find((e: any) => e.event === 'case.control_refused');
    assert.deepEqual({ reason: control.properties.reason, result: control.properties.result }, { reason: 'control_not_passed', result: 'none' });
    const views = body.batch.filter((e: any) => e.event === '$pageview');
    assert.deepEqual(views.map((e: any) => e.properties.$pathname), ['/work_item', '/workload']);
    assert.deepEqual(views.map((e: any) => e.properties.persona), ['marine', 'leader']);

    // One pseudonymous visitor across both personas, no person profiles, no GeoIP, a v7 session.
    const ws = app.ctx.db.prepare('SELECT demo_workspace_id AS w FROM users WHERE id = ?').get(me.user.id) as { w: string };
    const distinct = new Set(body.batch.map((e: any) => e.properties.distinct_id));
    assert.deepEqual([...distinct], [pseudonym(app.ctx.config.secret, ws.w)]);
    for (const e of body.batch) {
      assert.equal(e.properties.$process_person_profile, false);
      assert.equal(e.properties.$geoip_disable, true);
      assert.match(e.properties.$session_id, UUID_V7);
      assert.ok(e.timestamp);
    }

    // Nothing typed, no document or invoice numbers, no ids or names, no URL with an id in it.
    const wire = JSON.stringify(body);
    for (const secret of ['PRIVATE-FINDING-TEXT', 'SYN-26-P-0047', 'SYN-INV-0047', 'SYN-MOD-1', '91,250', id, me.user.id, ws.w, me.user.username, me.user.last_name, token, `/work/items/`]) {
      assert.ok(!wire.includes(secret), `the batch must not contain ${secret}`);
    }

    // Sent once: the next tick has nothing new.
    await forwardPending(app.ctx, state, posthog.send);
    assert.equal(posthog.sent.length, 1);
  } finally { await app.close(); }
});

test('an unreachable PostHog never gets in the way: retried a few times, then skipped', async () => {
  const app = await startApp(DEMO);
  const posthog = fakePostHog();
  const state = { attempts: 0 };
  try {
    await forwardPending(app.ctx, state, posthog.send);
    const r = await app.call('POST', '/api/demo/start', { headers: H });
    assert.equal(r.status, 200, 'the demo starts whatever PostHog is doing');
    posthog.fail(true);
    for (let i = 1; i <= 2; i++) {
      const res = await forwardPending(app.ctx, state, posthog.send);
      assert.deepEqual({ failed: res.failed, dropped: res.dropped }, { failed: true, dropped: 0 }, `attempt ${i} keeps the batch`);
    }
    const third = await forwardPending(app.ctx, state, posthog.send);
    assert.equal(third.failed, true);
    assert.ok(third.dropped > 0, 'the third failure skips the batch');
    posthog.fail(false);
    await forwardPending(app.ctx, state, posthog.send);
    assert.equal(posthog.sent.length, 0, 'a skipped batch is not sent late');
    // The events are still on this server.
    const kept = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM product_events WHERE name = 'demo.started'").get() as { n: number };
    assert.equal(kept.n, 1);
  } finally { await app.close(); }
});
