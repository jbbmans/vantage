import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-incidents-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'operator';

const { app, db } = await import('../server/index.js');
const { addMember, grantRole } = await import('../server/db.js');

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

const register = async (username, firstName = username) => {
  const password = `${username}-long-enough-passphrase-927`;
  const response = await call('POST', '/api/register', {
    body: { username, password, first_name: firstName, last_name: 'Tester' },
  });
  assert.equal(response.status, 201, response.body?.error);
  const token = await login(username, password);
  const identity = await call('GET', '/api/me', { token });
  return { id: identity.body.user.id, token };
};

try {
  const setup = await call('POST', '/api/setup', {
    body: {
      username: 'operator', password: 'operator-long-enough-passphrase-927',
      first_name: 'Ops', last_name: 'Operator', unit_code: 'MFR',
    },
  });
  assert.equal(setup.status, 200, setup.body?.error);
  const operatorToken = await login('operator', 'operator-long-enough-passphrase-927');
  const operatorIdentity = await call('GET', '/api/me', { token: operatorToken });
  const operatorId = operatorIdentity.body.user.id;
  const reporter = await register('reporter', 'Report');
  const leader = await register('unitleader', 'Unit');

  const leaderRole = db.prepare("SELECT id FROM roles WHERE unit_id = 'MFR' AND name = 'Unit Leader'").get();
  assert.ok(leaderRole?.id);
  addMember(leader.id, 'MFR');
  grantRole(leader.id, leaderRole.id, 'MFR', operatorId);

  const invalid = await call('POST', '/api/security-incidents', {
    token: reporter.token,
    body: { category: 'not-valid', severity: 'urgent', title: '', description: '' },
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'validation');

  const description = 'A crafted value appears to bypass the expected validation boundary. Reproduction details stay confidential.';
  const submitted = await call('POST', '/api/security-incidents', {
    token: reporter.token,
    body: {
      category: 'vulnerability', severity: 'high', title: 'Validation boundary concern', description,
      affected_area: 'Quick Log', observed_at: '2026-09-01T15:30:00.000Z',
    },
  });
  assert.equal(submitted.status, 201, submitted.body?.error);
  assert.equal(submitted.body.status, 'submitted');
  const incidentId = submitted.body.id;

  const mine = await call('GET', '/api/security-incidents', { token: reporter.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.incidents.map((row) => row.id), [incidentId]);
  assert.equal(mine.body.incidents[0].description, description);

  const leaderMine = await call('GET', '/api/security-incidents', { token: leader.token });
  assert.equal(leaderMine.status, 200);
  assert.deepEqual(leaderMine.body.incidents, []);
  const leaderQueue = await call('GET', '/api/admin/security-incidents', { token: leader.token });
  assert.equal(leaderQueue.status, 403, 'unit leadership must not grant access to the instance security queue');

  const queue = await call('GET', '/api/admin/security-incidents', { token: operatorToken });
  assert.equal(queue.status, 200);
  assert.equal(queue.body.incidents[0].id, incidentId);
  assert.equal(queue.body.incidents[0].reporter_username, 'reporter');

  const acknowledged = await call('PUT', `/api/admin/security-incidents/${incidentId}`, {
    token: operatorToken,
    body: { status: 'acknowledged', note: 'Report received. Initial containment review started.', visible_to_reporter: true },
  });
  assert.equal(acknowledged.status, 200, acknowledged.body?.error);
  assert.equal(acknowledged.body.status, 'acknowledged');

  const internal = await call('PUT', `/api/admin/security-incidents/${incidentId}`, {
    token: operatorToken,
    body: { status: 'acknowledged', note: 'Internal reproduction environment prepared.', visible_to_reporter: false },
  });
  assert.equal(internal.status, 200, internal.body?.error);

  const reporterView = await call('GET', '/api/security-incidents', { token: reporter.token });
  assert.equal(reporterView.body.incidents[0].status, 'acknowledged');
  const reporterEvents = reporterView.body.incidents[0].events;
  assert.ok(reporterEvents.some((event) => event.message?.includes('Report received')));
  assert.ok(!reporterEvents.some((event) => event.message?.includes('Internal reproduction')));

  const followUp = await call('POST', `/api/security-incidents/${incidentId}/follow-up`, {
    token: reporter.token,
    body: { message: 'The behavior also occurs from the mobile layout.' },
  });
  assert.equal(followUp.status, 201, followUp.body?.error);

  const operatorView = await call('GET', '/api/admin/security-incidents', { token: operatorToken });
  const operatorEvents = operatorView.body.incidents[0].events;
  assert.ok(operatorEvents.some((event) => event.message?.includes('Internal reproduction')));
  assert.ok(operatorEvents.some((event) => event.message?.includes('mobile layout')));

  const badTransition = await call('PUT', `/api/admin/security-incidents/${incidentId}`, {
    token: operatorToken,
    body: { status: 'submitted', note: 'Attempt invalid transition.', visible_to_reporter: false },
  });
  assert.equal(badTransition.status, 409);
  const closed = await call('PUT', `/api/admin/security-incidents/${incidentId}`, {
    token: operatorToken,
    body: { status: 'closed', note: 'Synthetic case closed.', visible_to_reporter: true },
  });
  assert.equal(closed.status, 200);
  const reopened = await call('PUT', `/api/admin/security-incidents/${incidentId}`, {
    token: operatorToken,
    body: { status: 'investigating', note: 'New evidence requires another review.', visible_to_reporter: true },
  });
  assert.equal(reopened.status, 200);
  assert.equal(db.prepare('SELECT resolved_at FROM security_incidents WHERE id = ?').get(incidentId).resolved_at, null);

  assert.equal((await call('DELETE', `/api/security-incidents/${incidentId}`, { token: reporter.token })).status, 404);
  assert.equal((await call('PUT', `/api/security-incidents/${incidentId}`, {
    token: reporter.token, body: { status: 'closed' },
  })).status, 404);

  const auditRows = db.prepare(
    "SELECT action, detail FROM audit_log WHERE entity = 'security_incident' AND entity_id = ? ORDER BY rowid"
  ).all(incidentId);
  assert.ok(auditRows.some((row) => row.action === 'security_incident_submitted'));
  assert.ok(auditRows.some((row) => row.action === 'security_incident_status_changed'));
  assert.equal(JSON.stringify(auditRows).includes(description), false, 'sensitive report content must not enter the general audit detail');

  const notifications = db.prepare(
    "SELECT user_id, title, message FROM notifications WHERE kind = 'security_incident' ORDER BY created_at"
  ).all();
  assert.ok(notifications.some((row) => row.user_id === operatorId));
  assert.ok(notifications.some((row) => row.user_id === reporter.id && row.title.includes('acknowledged')));
  assert.equal(JSON.stringify(notifications).includes(description), false);

  const rateUser = await register('rateuser', 'Rate');
  let limited;
  for (let index = 0; index < 6; index += 1) {
    limited = await call('POST', '/api/security-incidents', {
      token: rateUser.token,
      body: {
        category: 'other', severity: 'informational', title: `Rate report ${index}`,
        description: 'Submission rate boundary check.',
      },
    });
  }
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM security_incidents WHERE reporter_id = ?').get(reporter.id).n, 1);
  console.log('  ok    confidential incident disclosure lifecycle and access boundary');
} finally {
  server.close();
  db.close();
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
}
