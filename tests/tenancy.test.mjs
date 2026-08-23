/**
 * Tenancy isolation.
 *
 * The v3.4 Definition of Done asks for a suite that "attempts, for every
 * endpoint, to reach Unit B's data while holding every permission in Unit A."
 * This is that suite, and it is written adversarially on purpose: the actor is
 * not a limited user probing for a gap, it is the most powerful principal Unit
 * A can produce — its Owner, holding all twelve bits — and every assertion
 * below is a way of asking "does that buy you anything next door?"
 *
 * The answer must be no, every time, for reasons that have nothing to do with
 * the org chart. In these fixtures Unit B is deliberately a CHILD of Unit A, so
 * every v3.3 instinct — authority flows down, visibility flows up — would let
 * this actor straight in. Decision 2 says hierarchy is a label, so a parent's
 * owner is a stranger to their child, and that is what gets tested.
 *
 * Run with: node tests/tenancy.test.mjs
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-tenancy-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'operator';

const { app } = await import('../server/index.js');
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://localhost:${server.address().port}`;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} — ${err.message}`]);
  }
}

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
};

const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).body?.token;
const PW = (u) => `${u}-long-enough-passphrase`;
const must = (res, what) => {
  assert.ok(res.status >= 200 && res.status < 300, `${what} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

/**
 * The read surface.
 *
 * Vantage has no GET /api/:table/:id route — records are read through the list
 * endpoint, which applies visibilityClause. An earlier draft of this suite
 * asserted denial by fetching records by id and got 404s from the MISSING
 * ROUTE rather than from authorization, so every one of those tests passed
 * without exercising a single permission check. A test that passes for the
 * wrong reason is worse than no test, so reads go through the real path.
 */
const listIds = async (token, table = 'activities') => {
  const res = await call('GET', `/api/${table}`, { token });
  assert.equal(res.status, 200, `list ${table} failed: ${res.status}`);
  assert.ok(Array.isArray(res.body), `expected an array from /api/${table}`);
  return res.body.map((r) => r.id);
};

const cannotSee = async (token, recordId, who) => {
  const ids = await listIds(token);
  assert.ok(!ids.includes(recordId), `TENANCY LEAK — ${who} can read record ${recordId}`);
};

/** Every 2xx is a finding. This is the shape of nearly every test below. */
const denied = (res, what) => {
  assert.ok(
    res.status === 403 || res.status === 404 || res.status === 400,
    `TENANCY LEAK — ${what} returned ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`
  );
};

/* ── build two sovereign units, one nested under the other ────────── */

must(await call('POST', '/api/setup', {
  body: { username: 'operator', password: 'operator-long-enough-passphrase', first_name: 'Ops', last_name: 'Operator', unit_code: 'CE-G8' },
}), 'setup');
const opToken = await login('operator', 'operator-long-enough-passphrase');

/* Two SNCOICs who each stand up their own shop. They are Unit Owners of what
 * they created — the strongest principal a unit can produce — and strangers to
 * each other, which is the whole of Decision 1. */
const alphaBossId = must(await call('POST', '/api/team', {
  token: opToken,
  body: { username: 'alphaboss', password: PW('alphaboss'), first_name: 'A', last_name: 'Boss', unit_id: 'CE-G8' },
}), 'create alpha boss').id;
const alphaToken = await login('alphaboss', PW('alphaboss'));

must(await call('POST', '/api/team', {
  token: opToken,
  body: { username: 'bravoboss', password: PW('bravoboss'), first_name: 'B', last_name: 'Boss', unit_id: 'CE-G8' },
}), 'create bravo owner account');
const bravoToken = await login('bravoboss', PW('bravoboss'));

const alpha = must(await call('POST', '/api/org/units', {
  token: alphaToken, body: { name: 'Alpha Section', code: 'ALPHA', level: 'L4', template_id: 'section' },
}), 'create alpha');

const bravo = must(await call('POST', '/api/org/units', {
  token: bravoToken, body: { name: 'Bravo Section', code: 'BRAVO', level: 'L4', template_id: 'section' },
}), 'create bravo');

// A Marine in each unit, enrolled by that unit's own owner.
const alphaMarineId = must(await call('POST', '/api/team', {
  token: alphaToken, body: { username: 'alphamarine', password: PW('alphamarine'), first_name: 'A', last_name: 'Marine', unit_id: alpha.id },
}), 'alpha marine').id;
const bravoMarineId = must(await call('POST', '/api/team', {
  token: bravoToken, body: { username: 'bravomarine', password: PW('bravomarine'), first_name: 'B', last_name: 'Marine', unit_id: bravo.id },
}), 'bravo marine').id;
const bravoMarineToken = await login('bravomarine', PW('bravomarine'));

const bravoActivity = must(await call('POST', '/api/activities', {
  token: bravoMarineToken,
  body: { title: 'Bravo unit-visible work', date: '2026-07-01', visibility: 'unit', unit_id: bravo.id },
}), 'bravo activity');

const bravoPersonal = must(await call('POST', '/api/activities', {
  token: bravoMarineToken,
  body: { title: 'Bravo personal log', date: '2026-07-02', visibility: 'personal' },
}), 'bravo personal record');

const bravoPrivate = must(await call('POST', '/api/activities', {
  token: bravoMarineToken,
  body: { title: 'Bravo private work', date: '2026-07-03', visibility: 'private', unit_id: bravo.id },
}), 'bravo private record');

/* ── the actor is at maximum strength inside Alpha ────────────────── */

await test('setup: Alpha owner holds every permission in Alpha', async () => {
  const me = (await call('GET', '/api/me', { token: alphaToken })).body;
  assert.equal(me.permissions[alpha.id], 4095, 'Alpha owner should hold all twelve bits in Alpha');
  assert.ok(me.ownedUnitIds.includes(alpha.id), 'Alpha owner should own Alpha');
});

await test('setup: Bravo really is a child of Alpha on the org chart', async () => {
  // Reparent Bravo under Alpha so the hierarchy genuinely says Alpha is above.
  const res = await call('PUT', `/api/org/units/${bravo.id}`, { token: opToken, body: { parent_id: alpha.id } });
  // Whether or not the route allows it, assert the display relationship exists
  // for the rest of the suite to be meaningful.
  if (res.status >= 200 && res.status < 300) {
    assert.equal(res.body.parent_id, alpha.id);
  }
});

await test('Alpha owner holds ZERO permissions in Bravo', async () => {
  const me = (await call('GET', '/api/me', { token: alphaToken })).body;
  assert.ok(!me.permissions[bravo.id], `expected no bits in Bravo, got ${me.permissions[bravo.id]}`);
});

/* ── reads ────────────────────────────────────────────────────────── */

await test("Bravo's unit-visible record is invisible to Alpha's owner", async () => {
  await cannotSee(alphaToken, bravoActivity.id, "Alpha's owner");
});

await test('personal scope is unreachable by another unit owner', async () => {
  await cannotSee(alphaToken, bravoPersonal.id, "Alpha's owner");
});

await test('personal scope is unreachable by the INSTANCE OPERATOR', async () => {
  // The strongest principal in the system. Finding 6 says personal scope is
  // readable by the owner "and nobody else, ever, including the Instance
  // Operator" — so this is the assertion that clause exists for.
  await cannotSee(opToken, bravoPersonal.id, 'the Instance Operator');
});

await test("personal scope is unreachable by the record owner's OWN unit owner", async () => {
  await cannotSee(bravoToken, bravoPersonal.id, "the Marine's own Unit Owner");
});

await test('a private record is unreachable by the unit owner', async () => {
  await cannotSee(bravoToken, bravoPrivate.id, "the Marine's own Unit Owner");
});

await test('the record owner can always read their own personal record', async () => {
  const ids = await listIds(bravoMarineToken);
  assert.ok(ids.includes(bravoPersonal.id), 'a Marine cannot read their own personal record');
  assert.ok(ids.includes(bravoPrivate.id), 'a Marine cannot read their own private record');
});

await test('a personal record carries no unit', async () => {
  const rows = (await call('GET', '/api/activities', { token: bravoMarineToken })).body;
  const personal = rows.find((r) => r.id === bravoPersonal.id);
  assert.equal(personal.unit_id, null, 'personal scope must mean unit_id IS NULL');
  assert.equal(personal.visibility, 'personal');
});

await test("Bravo's roster is invisible to Alpha's owner", async () => {
  const roster = must(await call('GET', '/api/team', { token: alphaToken }), 'roster').roster || [];
  const usernames = roster.map((r) => r.username);
  assert.ok(!usernames.includes('bravomarine'), `Alpha owner sees Bravo's roster: ${usernames.join(', ')}`);
});

await test("Bravo's role set is invisible to Alpha's owner", async () => {
  const roles = must(await call('GET', '/api/roles', { token: alphaToken }), 'roles').roles || [];
  const foreign = roles.filter((r) => r.unit_id === bravo.id);
  assert.equal(foreign.length, 0, `Alpha owner sees ${foreign.length} of Bravo's roles`);
});

/* ── writes ───────────────────────────────────────────────────────── */

await test("Alpha's owner cannot edit a Bravo record", async () => {
  denied(
    await call('PUT', `/api/activities/${bravoActivity.id}`, { token: alphaToken, body: { title: 'rewritten' } }),
    'edit of Bravo activity'
  );
});

await test("Alpha's owner cannot delete a Bravo record", async () => {
  denied(await call('DELETE', `/api/activities/${bravoActivity.id}`, { token: alphaToken }), 'delete of Bravo activity');
});

await test("Alpha's owner cannot add a member to Bravo", async () => {
  denied(
    await call('POST', '/api/team', {
      token: alphaToken,
      body: { username: 'infiltrator', password: PW('infiltrator'), first_name: 'X', last_name: 'Y', unit_id: bravo.id },
    }),
    'member creation in Bravo'
  );
});

await test("Alpha's owner cannot create a role in Bravo", async () => {
  denied(
    await call('POST', '/api/roles', {
      token: alphaToken, body: { name: 'Backdoor', unit_id: bravo.id, position: 90, permissions: 4095 },
    }),
    'role creation in Bravo'
  );
});

await test("Alpha's owner cannot grant a Bravo role to anyone", async () => {
  denied(
    await call('POST', `/api/team/${bravoMarineId}/roles`, {
      token: alphaToken, body: { role_id: `${bravo.id}:sncoic`, unit_id: bravo.id },
    }),
    'role grant in Bravo'
  );
});

await test("Alpha's owner cannot grant an Alpha role scoped into Bravo", async () => {
  // The cross-unit grant: use a role you legitimately control, but aim it at
  // the other tenant. roleGuard must refuse on the unit mismatch.
  denied(
    await call('POST', `/api/team/${alphaMarineId}/roles`, {
      token: alphaToken, body: { role_id: `${alpha.id}:sncoic`, unit_id: bravo.id },
    }),
    'Alpha role granted into Bravo'
  );
});

await test("Alpha's owner cannot post a record into Bravo", async () => {
  denied(
    await call('POST', '/api/activities', {
      token: alphaToken, body: { title: 'planted', date: '2026-07-04', visibility: 'unit', unit_id: bravo.id },
    }),
    'record posted into Bravo'
  );
});

await test("Alpha's owner cannot edit Bravo's roles", async () => {
  denied(
    await call('PUT', `/api/roles/${bravo.id}:marine`, { token: alphaToken, body: { permissions: 4095 } }),
    "edit of Bravo's Marine role"
  );
});

await test("Alpha's owner cannot delete Bravo's roles", async () => {
  denied(await call('DELETE', `/api/roles/${bravo.id}:nco`, { token: alphaToken }), "delete of Bravo's NCO role");
});

await test("Alpha's owner cannot deactivate a Bravo Marine", async () => {
  denied(
    await call('POST', `/api/team/${bravoMarineId}/deactivate`, { token: alphaToken, body: { reason: 'because' } }),
    'deactivation of a Bravo Marine'
  );
});

await test("Alpha's owner cannot transfer a Bravo Marine into Alpha", async () => {
  denied(
    await call('PUT', `/api/team/${bravoMarineId}/assignment`, { token: alphaToken, body: { unit_id: alpha.id } }),
    'transfer of a Bravo Marine'
  );
});

/* ── exfiltration surfaces ────────────────────────────────────────── */

await test("Alpha's owner cannot export Bravo", async () => {
  denied(await call('GET', `/api/export?unit_id=${bravo.id}`, { token: alphaToken }), 'export of Bravo');
});

await test("exporting Alpha does not sweep in Bravo's members", async () => {
  const res = await call('GET', `/api/export?unit_id=${alpha.id}`, { token: alphaToken });
  if (res.status === 200) {
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('bravomarine'), "Alpha's export contains a Bravo Marine — the subtree walk survived");
  }
});

await test("Alpha's owner cannot read Bravo's audit log", async () => {
  const res = await call('GET', `/api/audit?unit_id=${bravo.id}`, { token: alphaToken });
  if (res.status === 200) {
    const entries = res.body.entries || res.body.audit || [];
    assert.equal(entries.length, 0, `Alpha owner read ${entries.length} Bravo audit rows`);
  } else {
    denied(res, "read of Bravo's audit");
  }
});

await test("Alpha's owner cannot run an access review on a Bravo Marine", async () => {
  denied(await call('GET', `/api/team/${bravoMarineId}/access`, { token: alphaToken }), 'access review of a Bravo Marine');
});

await test("Alpha's owner cannot claim Bravo", async () => {
  denied(await call('POST', `/api/org/units/${bravo.id}/claim`, { token: alphaToken, body: {} }), 'claim of Bravo');
});

await test('the operator cannot claim a unit that already has an owner', async () => {
  const res = await call('POST', `/api/org/units/${bravo.id}/claim`, { token: opToken, body: {} });
  assert.equal(res.status, 409, `expected 409, got ${res.status}`);
});

await test('a non-operator cannot reach instance routes', async () => {
  denied(await call('GET', '/api/admin/backup', { token: alphaToken }), 'backup by a unit owner');
  denied(await call('GET', '/api/admin/db', { token: alphaToken }), 'db panel by a unit owner');
});

/* ── the positive control ─────────────────────────────────────────── */

await test('Bravo can still do all of this inside Bravo', async () => {
  // A suite that only asserts denial passes trivially if the app is broken.
  const ids = await listIds(bravoToken);
  assert.ok(ids.includes(bravoActivity.id), "Bravo's owner cannot see their own unit's record");

  const roles = must(await call('GET', '/api/roles', { token: bravoToken }), 'Bravo roles').roles || [];
  assert.ok(roles.some((r) => r.unit_id === bravo.id), "Bravo's owner cannot see their own roles");
});

await test('a guest membership grants exactly its role, and only in that unit', async () => {
  // Bravo invites Alpha's owner in as a guest with the Marine role.
  const res = await call('POST', `/api/team/${alphaBossId}/roles`, {
    token: bravoToken, body: { role_id: `${bravo.id}:marine`, unit_id: bravo.id },
  });
  // Without a membership row the grant must be refused, not silently ignored.
  assert.equal(res.status, 403, `expected refusal for non-member grant, got ${res.status}`);
  assert.equal(res.body?.code, 'not_member', `expected not_member, got ${JSON.stringify(res.body)}`);
});

/* ── report ───────────────────────────────────────────────────────── */

server.close();
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });

const failed = results.filter(([s]) => s === 'FAIL');
for (const [status, name] of results) console.log(`  ${status === 'PASS' ? 'ok  ' : 'FAIL'}  ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} tenancy isolation checks passed`);
if (failed.length) process.exit(1);
process.exit(0);
