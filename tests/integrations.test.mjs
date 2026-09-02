import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-integration-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'operator';
process.env.VANTAGE_INTEGRATIONS_ENABLED = '1';
process.env.VANTAGE_INTEGRATION_REQUESTS_PER_15_MINUTES = '30';

const { app, db } = await import('../server/index.js');
const { seedTestUnits } = await import('./helpers/seed-test-units.mjs');
seedTestUnits(db);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://localhost:${server.address().port}`;

async function call(method, path, { token, body } = {}) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, body: payload, headers: response.headers };
}

const login = async (username, password) => (
  await call('POST', '/api/login', { body: { username, password } })
).body?.token;

try {
  await call('POST', '/api/setup', {
    body: {
      username: 'operator', password: 'operator-long-enough-passphrase-927',
      first_name: 'Ops', last_name: 'Operator', unit_code: 'MFR',
    },
  });
  const operatorToken = await login('operator', 'operator-long-enough-passphrase-927');
  const identity = (await call('GET', '/api/me', { token: operatorToken })).body;
  await call('POST', '/api/org/units/G8-FMRAC/claim', {
    token: operatorToken,
    body: { owner_user_id: identity.user.id, template_id: 'default' },
  });

  const shared = await call('POST', '/api/activities', {
    token: operatorToken,
    body: {
      unit_id: 'G8-FMRAC', visibility: 'unit', date: '2026-08-20', title: 'Unit reconciliation',
      category: 'Fiscal & Financial', quantity: 5, unit_label: 'actions', dollar_amount: 1200,
      dollar_type: 'obligated', notes: 'never export this note', evidence_links: ['https://example.invalid/private'],
    },
  });
  assert.equal(shared.status, 200, shared.body?.error);
  await call('POST', '/api/activities', {
    token: operatorToken,
    body: {
      unit_id: 'G8-FMRAC', visibility: 'private', date: '2026-08-21', title: 'Private counseling note',
      quantity: 99, dollar_amount: 99000,
    },
  });
  await call('POST', '/api/activities', {
    token: operatorToken,
    body: {
      unit_id: 'MFR', visibility: 'unit', date: '2026-08-22', title: 'Other unit record',
      quantity: 77, dollar_amount: 77000,
    },
  });

  const issued = await call('POST', '/api/admin/integrations', {
    token: operatorToken,
    body: { name: 'Approved G-8 reader', unit_id: 'G8-FMRAC', expires_in_days: 90 },
  });
  assert.equal(issued.status, 201, issued.body?.error);
  const apiToken = issued.body.token;
  assert.match(apiToken, /^vnt_int_/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_clients WHERE token_hash = ?').get(apiToken).n, 0);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM integration_clients WHERE id = ?').get(issued.body.id)).includes(apiToken), false);

  const listed = await call('GET', '/api/admin/integrations', { token: operatorToken });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.clients.length, 1);
  assert.equal('token' in listed.body.clients[0], false);
  assert.equal(listed.body.clients[0].unit_id, 'G8-FMRAC');

  const root = await call('GET', '/api/integrations/v1', { token: apiToken });
  assert.equal(root.status, 200, root.body?.error);
  assert.equal(root.body.unit_id, 'G8-FMRAC');
  assert.equal(root.body.scope, 'unit.shared.read');

  const wrongUnit = await call('GET', '/api/integrations/v1/units/MFR/activities', { token: apiToken });
  assert.equal(wrongUnit.status, 404);

  const activities = await call('GET', '/api/integrations/v1/units/G8-FMRAC/activities?limit=1', { token: apiToken });
  assert.equal(activities.status, 200, activities.body?.error);
  assert.deepEqual(activities.body.data.map((row) => row.title), ['Unit reconciliation']);
  assert.equal(activities.body.data[0].action_amount, 5);
  assert.equal(activities.body.data[0].transaction_value, 1200);
  assert.equal('notes' in activities.body.data[0], false);
  assert.equal('evidence_links' in activities.body.data[0], false);
  assert.equal('visibility' in activities.body.data[0], false);

  const summary = await call(
    'GET', '/api/integrations/v1/units/G8-FMRAC/summary?from=2026-08-01&to=2026-08-31', { token: apiToken }
  );
  assert.equal(summary.status, 200, summary.body?.error);
  assert.equal(summary.body.totals.entries, 1);
  assert.equal(summary.body.totals.action_amount, 5);
  assert.equal(summary.body.totals.transaction_value, 1200);
  assert.deepEqual(summary.body.dollar_types.map((row) => row.dollar_type), ['obligated']);

  const badCursor = await call(
    'GET', '/api/integrations/v1/units/G8-FMRAC/activities?cursor=not-a-cursor', { token: apiToken }
  );
  assert.equal(badCursor.status, 400);
  const badDate = await call(
    'GET', '/api/integrations/v1/units/G8-FMRAC/summary?from=2026-02-30&to=2026-03-01', { token: apiToken }
  );
  assert.equal(badDate.status, 400);

  const invalid = await call('GET', '/api/integrations/v1', { token: 'vnt_int_AAAAAAAAAAAA_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers.get('www-authenticate') || '', /Bearer/);

  db.prepare('UPDATE integration_clients SET expires_at = ? WHERE id = ?')
    .run('2020-01-01T00:00:00.000Z', issued.body.id);
  const expired = await call('GET', '/api/integrations/v1', { token: apiToken });
  assert.equal(expired.status, 401);
  db.prepare('UPDATE integration_clients SET expires_at = ? WHERE id = ?')
    .run('2099-01-01T00:00:00.000Z', issued.body.id);

  const revoked = await call('DELETE', `/api/admin/integrations/${issued.body.id}`, { token: operatorToken });
  assert.equal(revoked.status, 200, revoked.body?.error);
  const afterRevoke = await call('GET', '/api/integrations/v1', { token: apiToken });
  assert.equal(afterRevoke.status, 401);

  const auditRows = db.prepare(
    `SELECT action FROM audit_log WHERE entity = 'integration_client' AND entity_id = ? ORDER BY at`
  ).all(issued.body.id).map((row) => row.action);
  assert.ok(auditRows.includes('integration_client_created'));
  assert.ok(auditRows.includes('integration_api_read'));
  assert.ok(auditRows.includes('integration_client_revoked'));

  const ordinary = await call('POST', '/api/register', {
    body: {
      username: 'ordinary', password: 'ordinary-long-enough-passphrase-927',
      first_name: 'Ordinary', last_name: 'User',
    },
  });
  assert.equal(ordinary.status, 201, ordinary.body?.error);
  const ordinaryToken = await login('ordinary', 'ordinary-long-enough-passphrase-927');
  const deniedAdmin = await call('GET', '/api/admin/integrations', { token: ordinaryToken });
  assert.equal(deniedAdmin.status, 403);

  const rateClient = await call('POST', '/api/admin/integrations', {
    token: operatorToken,
    body: { name: 'Rate-limit reader', unit_id: 'G8-FMRAC', expires_in_days: 1 },
  });
  assert.equal(rateClient.status, 201, rateClient.body?.error);
  let limited;
  for (let index = 0; index < 31; index += 1) {
    limited = await call('GET', '/api/integrations/v1', { token: rateClient.body.token });
  }
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  console.log('  ok    exact-unit read-only enterprise integration API');
} finally {
  server.close();
  db.close();
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
}
