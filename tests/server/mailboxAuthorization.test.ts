import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { startApp, type TestApp } from './helpers.ts';
import { loadConfig } from '../../server/config.ts';
import { encryptSecret } from '../../server/lib/crypto.ts';
import { sessionDigest } from '../../server/auth/sessions.ts';

const CLIENT_ID = '00000000-1111-2222-3333-444444444444';
let ms: { url: string; close: () => void; seen: Array<{ method: string; path: string; auth?: string; form?: URLSearchParams }> };
let challenge = '';
/** When set, the next delta page waits for it: Microsoft answering slowly while access changes in Vantage. */
let holdDelta: { reached: () => void; release: Promise<void> } | null = null;
let app: TestApp;
let op: { token: string; id: string };
let peer: { token: string; id: string };

function microsoft(): Promise<typeof ms> {
  const seen: typeof ms.seen = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const path = req.url || '';
      const form = req.method === 'POST' ? new URLSearchParams(data) : undefined;
      seen.push({ method: req.method || '', path, auth: req.headers.authorization, form });
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (path.endsWith('/oauth2/v2.0/token')) {
        if (form!.get('client_secret') !== 'shh-secret') return json(401, { error: 'invalid_client' });
        if (form!.get('grant_type') === 'authorization_code') {
          const verifier = form!.get('code_verifier') || '';
          if (createHash('sha256').update(verifier).digest('base64url') !== challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
          const code = form!.get('code');
          const scope = code === 'broad'
            ? 'https://graph.microsoft.us/Mail.ReadWrite https://graph.microsoft.us/User.Read'
            : 'https://graph.microsoft.us/Mail.Read https://graph.microsoft.us/User.Read';
          const tid = Buffer.from(JSON.stringify({ tid: 'tenant-dod-1' })).toString('base64url');
          return json(200, { access_token: code === 'other' ? 'at-other' : 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope, id_token: `x.${tid}.y` });
        }
        if (form!.get('grant_type') === 'refresh_token') {
          if (form!.get('refresh_token') === 'revoked') return json(400, { error: 'invalid_grant', error_description: 'AADSTS50173: The provided grant has expired due to it being revoked.' });
          return json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: 'https://graph.microsoft.us/Mail.Read' });
        }
      }
      if (path.startsWith('/v1.0/me?')) {
        if (req.headers.authorization === 'Bearer at-1') return json(200, { id: 'acct-1', mail: 'Analyst@Example.mil' });
        if (req.headers.authorization === 'Bearer at-other') return json(200, { id: 'acct-9', mail: 'someone.else@example.mil' });
        return json(401, {});
      }
      if (path.startsWith('/v1.0/me/messages/delta')) {
        if (!['Bearer at-1', 'Bearer at-2'].includes(String(req.headers.authorization))) return json(401, {});
        const hold = holdDelta;
        holdDelta = null;
        const answer = () => json(200, {
          value: [{ id: `m-${seen.length}`, conversationId: 'conv-1', subject: 'MIPR acceptance', receivedDateTime: '2026-09-20T12:00:00Z', from: { emailAddress: { address: 'rco@example.mil' } }, body: { contentType: 'text', content: 'Signed 448-2 attached.' } }],
          '@odata.deltaLink': `${ms.url}/v1.0/me/messages/delta?token=next`,
        });
        if (!hold) return answer();
        hold.reached();
        return void hold.release.then(answer);
      }
      json(404, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close(), seen })));
}

before(async () => {
  ms = await microsoft();
  app = await startApp({ VANTAGE_M365_CLIENT_ID: CLIENT_ID, VANTAGE_M365_CLIENT_SECRET: 'shh-secret', VANTAGE_M365_TEST_ENDPOINT: ms.url });
  op = await app.setupOperator();
  peer = await app.register('peer');
});
after(async () => { await app.close(); ms.close(); });

const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });

async function callback(token: string, query: Record<string, string>) {
  const res = await fetch(`${app.base}/api/correspondence/connectors/callback?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') || '' };
}

async function begin(label: string) {
  const connector = (await post(op.token, '/api/correspondence/connectors', { cloud: 'usgovdod', account_label: label })).body;
  const started = await post(op.token, `/api/correspondence/connectors/${connector.id}/authorize`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const url = new URL(started.body.url);
  challenge = url.searchParams.get('code_challenge') || '';
  return { connector, url, state: url.searchParams.get('state')! };
}

test('without an application registered, the product says mailbox sign-in is unavailable', async () => {
  const bare = await startApp();
  try {
    const owner = await bare.setupOperator();
    const list = await bare.call('GET', '/api/correspondence/connectors', { token: owner.token });
    assert.equal(list.body.availability.available, false);
    assert.match(list.body.availability.reason, /Entra application/);
    const made = (await bare.call('POST', '/api/correspondence/connectors', { token: owner.token, body: { cloud: 'global', account_label: 'a@b.mil' } })).body;
    const start = await bare.call('POST', `/api/correspondence/connectors/${made.id}/authorize`, { token: owner.token, body: {} });
    assert.equal(start.status, 409);
    assert.equal(start.body.code, 'mailbox_unconfigured');
  } finally { await bare.close(); }
});

test('the sign-in goes to the connector’s own cloud with PKCE, read-only scopes and the mailbox as a hint', async () => {
  const { url, state } = await begin('analyst@example.mil');
  assert.equal(url.origin + url.pathname, `${ms.url}/organizations/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:5173/api/correspondence/connectors/callback');
  assert.equal(url.searchParams.get('login_hint'), 'analyst@example.mil');
  assert.deepEqual(url.searchParams.get('scope')!.split(' ').sort(), ['https://dod-graph.microsoft.us/Mail.Read', 'https://dod-graph.microsoft.us/User.Read', 'offline_access']);
  assert.ok(state.length >= 40);
  const stored = app.ctx.db.prepare('SELECT * FROM connector_auth_states').all() as any[];
  assert.ok(stored.every((r) => r.state_hash !== state && !r.verifier_enc.includes(state)), 'neither the state nor the verifier is stored in the clear');
});

test('only the person who started a sign-in can finish it, once', async () => {
  const { connector, state } = await begin('analyst@example.mil');
  const stolen = await callback(peer.token, { code: 'good', state });
  assert.equal(stolen.status, 303);
  assert.match(stolen.location, /mailbox=failed&reason=authorization_state_invalid/);
  const unsigned = await fetch(`${app.base}/api/correspondence/connectors/callback?code=good&state=${state}`, { redirect: 'manual' });
  assert.match(unsigned.headers.get('location') || '', /mailbox=signed_out/);

  const done = await callback(op.token, { code: 'good', state });
  assert.match(done.location, new RegExp(`mailbox=connected&connector=${connector.id}`));
  const row = app.ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(connector.id) as any;
  assert.equal(row.status, 'connected');
  assert.equal(row.account_address, 'analyst@example.mil');
  assert.equal(row.tenant_id, 'tenant-dod-1');
  assert.ok(row.access_token_enc && !row.access_token_enc.includes('at-1'), 'tokens are encrypted at rest');
  assert.ok(row.refresh_token_enc && !row.refresh_token_enc.includes('rt-1'));

  const replay = await callback(op.token, { code: 'good', state });
  assert.match(replay.location, /authorization_state_invalid/, 'a state is single use');
  const view = (await app.call('GET', '/api/correspondence/connectors', { token: op.token })).body.connectors.find((c: any) => c.id === connector.id);
  assert.equal(view.account_address, 'analyst@example.mil');
  assert.equal('access_token_enc' in view, false, 'the public view never carries a token');
});

test('a different account, or a grant broader than read, connects nothing', async () => {
  const wrong = await begin('analyst@example.mil');
  const res = await callback(op.token, { code: 'other', state: wrong.state });
  assert.match(res.location, /authorization_wrong_account/);
  let row = app.ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(wrong.connector.id) as any;
  assert.equal(row.status, 'needs_authorization');
  assert.equal(row.access_token_enc, null);
  assert.match(row.last_error, /someone\.else@example\.mil.*analyst@example\.mil/);

  const broad = await begin('analyst@example.mil');
  assert.match((await callback(op.token, { code: 'broad', state: broad.state })).location, /authorization_too_broad/);
  row = app.ctx.db.prepare('SELECT * FROM connectors WHERE id = ?').get(broad.connector.id) as any;
  assert.equal(row.access_token_enc, null);

  const declined = await begin('analyst@example.mil');
  assert.match((await callback(op.token, { error: 'access_denied', error_description: 'The user declined.', state: declined.state })).location, /authorization_declined/);
  row = app.ctx.db.prepare('SELECT last_error FROM connectors WHERE id = ?').get(declined.connector.id) as any;
  assert.match(row.last_error, /declined/);
});

test('sync uses the stored sign-in, renews it when it runs out, and asks again when Microsoft refuses', async () => {
  const { connector, state } = await begin('analyst@example.mil');
  await callback(op.token, { code: 'good', state });
  const synced = await post(op.token, `/api/correspondence/connectors/${connector.id}/sync`, { visibility: 'private' });
  assert.equal(synced.status, 200, JSON.stringify(synced.body));
  assert.equal(synced.body.stored, 1);
  const deltaCall = ms.seen.filter((s) => s.path.startsWith('/v1.0/me/messages/delta')).at(-1)!;
  assert.equal(deltaCall.auth, 'Bearer at-1');
  const ignored = await app.call('POST', `/api/correspondence/connectors/${connector.id}/sync`, { token: op.token, body: {}, headers: { 'x-graph-access-token': 'at-forged' } });
  assert.equal(ignored.status, 200);
  assert.notEqual(ms.seen.filter((s) => s.path.startsWith('/v1.0/me/messages/delta')).at(-1)!.auth, 'Bearer at-forged', 'a token in the request is never used');

  app.ctx.db.prepare('UPDATE connectors SET token_expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), connector.id);
  const renewed = await post(op.token, `/api/correspondence/connectors/${connector.id}/sync`, {});
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(ms.seen.filter((s) => s.path.startsWith('/v1.0/me/messages/delta')).at(-1)!.auth, 'Bearer at-2', 'the renewed token is used');
  const refreshCall = ms.seen.filter((s) => s.form?.get('grant_type') === 'refresh_token').at(-1)!;
  assert.equal(refreshCall.form!.get('refresh_token'), 'rt-1');

  app.ctx.db.prepare('UPDATE connectors SET token_expires_at = ?, refresh_token_enc = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), encryptSecret(app.ctx.config.secret, 'revoked'), connector.id);
  const refused = await post(op.token, `/api/correspondence/connectors/${connector.id}/sync`, {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'connector_reauthorize');
  const row = app.ctx.db.prepare('SELECT status, last_error, access_token_enc, refresh_token_enc FROM connectors WHERE id = ?').get(connector.id) as any;
  assert.equal(row.status, 'needs_authorization');
  assert.match(row.last_error, /revoked/);
  assert.equal(row.access_token_enc, null);
  assert.equal(row.refresh_token_enc, null);
});

test('a sync stores nothing from a page Microsoft answers after the session ended or the reader left the unit, and the mailbox keeps its place', async () => {
  const { connector, state } = await begin('analyst@example.mil');
  await callback(op.token, { code: 'good', state });
  const threads = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE connector_id = ?').get(connector.id) as { n: number }).n;
  const place = () => ({ ...(app.ctx.db.prepare('SELECT status, delta_token, last_error FROM connectors WHERE id = ?').get(connector.id) as object) });
  const syncedAudits = () => (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sync_mailbox' AND entity_id = ?").get(connector.id) as { n: number }).n;
  /** A sync on `token` held at Microsoft's first page while `meanwhile` runs. */
  const heldSync = async (token: string, body: Record<string, unknown>, meanwhile: () => unknown, id: string = connector.id) => {
    let reached!: () => void;
    const there = new Promise<void>((r) => { reached = r; });
    let release!: () => void;
    holdDelta = { reached, release: new Promise<void>((r) => { release = r; }) };
    const pending = post(token, `/api/correspondence/connectors/${id}/sync`, body);
    await Promise.race([there, pending.then((r) => { throw new Error(`the sync answered ${r.status} before reaching Microsoft: ${JSON.stringify(r.body)}`); })]);
    await meanwhile();
    release();
    return pending;
  };
  const before = { threads: threads(), place: place(), audits: syncedAudits() };

  // The session that asked is ended while Microsoft answers.
  const second = await app.login('boletz');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const ended = await heldSync(second.body.token, { visibility: 'private' }, () => {
    app.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(second.body.token));
  });
  assert.equal(ended.status, 401, JSON.stringify(ended.body));

  // The reader leaves the unit the threads were to be shared with, still signed in.
  const seat = app.ctx.db.prepare('SELECT * FROM unit_members WHERE user_id = ? AND unit_id = ?').get(op.id, 'G8') as Record<string, unknown>;
  const left = await heldSync(op.token, { visibility: 'unit', unit_id: 'G8' }, () => {
    app.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(op.id, 'G8');
  });
  const cols = Object.keys(seat);
  app.ctx.db.prepare(`INSERT INTO unit_members (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => seat[c] as never));
  assert.equal(left.status, 403, JSON.stringify(left.body));

  assert.equal(threads(), before.threads, 'nothing from the held page is stored');
  assert.deepEqual(place(), before.place, 'the mailbox is not marked failing and keeps its place');
  assert.equal(syncedAudits(), before.audits, 'no sync is audited');

  // Controls: the same syncs with nothing changed store the page.
  const fine = await heldSync(op.token, { visibility: 'unit', unit_id: 'G8' }, () => {});
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal(threads(), before.threads + 1);

  // The person disconnects the mailbox, or removes it, while Microsoft answers: the page is not stored, and the
  // mailbox stays disconnected (or gone) rather than being marked connected again by the sync that was running.
  for (const end of ['disconnect', 'remove'] as const) {
    const other = await begin('analyst@example.mil');
    await callback(op.token, { code: 'good', state: other.state });
    const storedFor = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE connector_id = ?').get(other.connector.id) as { n: number }).n;
    const audits = (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sync_mailbox' AND entity_id = ?").get(other.connector.id) as { n: number }).n;
    const ended = await heldSync(op.token, { visibility: 'private' }, () => (end === 'disconnect'
      ? post(op.token, `/api/correspondence/connectors/${other.connector.id}/disconnect`)
      : app.call('DELETE', `/api/correspondence/connectors/${other.connector.id}`, { token: op.token })), other.connector.id);
    assert.equal(ended.status, 409, `${end}: ${JSON.stringify(ended.body)}`);
    assert.equal(ended.body.code, 'connector_not_authorized');
    assert.equal(storedFor(), 0, `${end}: nothing from the page is stored`);
    const row = app.ctx.db.prepare('SELECT status, delta_token, access_token_enc FROM connectors WHERE id = ?').get(other.connector.id) as Record<string, unknown> | undefined;
    if (end === 'disconnect') assert.deepEqual({ ...row }, { status: 'disconnected', delta_token: null, access_token_enc: null });
    else assert.equal(row, undefined);
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sync_mailbox' AND entity_id = ?").get(other.connector.id) as { n: number }).n, audits);
  }
});

test('disconnecting destroys the tokens at once and says where to withdraw consent', async () => {
  const { connector, state } = await begin('analyst@example.mil');
  await callback(op.token, { code: 'good', state });
  assert.equal((await post(peer.token, `/api/correspondence/connectors/${connector.id}/disconnect`)).status, 403);
  const res = await post(op.token, `/api/correspondence/connectors/${connector.id}/disconnect`);
  assert.equal(res.status, 200);
  assert.equal(res.body.connector.status, 'disconnected');
  assert.equal(res.body.revoke_consent_at, 'https://myapps.microsoft.us');
  const row = app.ctx.db.prepare('SELECT access_token_enc, refresh_token_enc, delta_token FROM connectors WHERE id = ?').get(connector.id) as any;
  assert.deepEqual({ ...row }, { access_token_enc: null, refresh_token_enc: null, delta_token: null });
});

test('the stand-in endpoint is refused outside the test suite, and a bad registration refuses to start', () => {
  const base = { NODE_ENV: 'development', VANTAGE_DB: ':memory:', VANTAGE_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv;
  assert.throws(() => loadConfig({ ...base, VANTAGE_M365_TEST_ENDPOINT: 'http://127.0.0.1:1' }), /test suite only/);
  assert.throws(() => loadConfig({ ...base, VANTAGE_M365_CLIENT_ID: 'not-a-guid', VANTAGE_M365_CLIENT_SECRET: 'x' }), /GUID/);
  assert.throws(() => loadConfig({ ...base, VANTAGE_M365_CLIENT_ID: CLIENT_ID }), /CLIENT_SECRET is required/);
  assert.throws(() => loadConfig({ ...base, VANTAGE_ACCESS_MODE: 'demo', VANTAGE_M365_CLIENT_ID: CLIENT_ID, VANTAGE_M365_CLIENT_SECRET: 'x' }), /reads no mailboxes/);
});
