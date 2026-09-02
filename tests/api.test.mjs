import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-test-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';

process.env.VANTAGE_OPERATOR = 'boletz';

const { app, db } = await import('../server/index.js');
const { seedTestUnits } = await import('./helpers/seed-test-units.mjs');
seedTestUnits(db);

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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {  }
  return { status: res.status, body: json };
};

const callRaw = async (method, path, { token, body, filename, contentType } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(filename ? { 'x-vantage-filename': encodeURIComponent(filename) } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    body,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = bytes.length ? JSON.parse(bytes.toString('utf8')) : null; } catch {  }
  return { status: res.status, body: json, bytes, headers: res.headers };
};

const login = async (username, password) => {
  const res = await call('POST', '/api/login', { body: { username, password } });
  return res.body?.token;
};

await call('POST', '/api/setup', {
  body: {
    username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927',
    first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', mos: '3451',
    unit_code: 'MFR', billet_title: 'Accounting Chief',
  },
});

const adminToken = await login('boletz', 'cobalt-orbit-velvet-anchor-927');
const me = (await call('GET', '/api/me', { token: adminToken })).body;

await call('POST', '/api/org/units/G8-FMRAC/claim', {
  token: adminToken, body: { owner_user_id: me.user.id, template_id: 'default' },
});

await call('POST', '/api/team', {
  token: adminToken,
  body: {
    username: 'rivera', password: 'a-different-long-passphrase',
    first_name: 'Raul', last_name: 'Rivera', rank_id: 'LCpl', mos: '3451',
    unit_id: 'G8-FMRAC', billet_id: 'financial-management-resource-analyst',
  },
});

await call('POST', '/api/team', {
  token: adminToken,
  body: {
    username: 'nguyen', password: 'yet-another-long-passphrase',
    first_name: 'Thanh', last_name: 'Nguyen', rank_id: 'Sgt', mos: '0311',
    unit_id: 'MFR',
  },
});

const nguyenId = (await call('GET', '/api/team', { token: adminToken })).body.roster
  .find((r) => r.last_name === 'Nguyen' && r.first_name === 'Thanh').id;
await call('POST', '/api/org/units/CLR-4/claim', {
  token: adminToken, body: { owner_user_id: nguyenId, template_id: 'default' },
});

let riveraToken = await login('rivera', 'a-different-long-passphrase');
const nguyenToken = await login('nguyen', 'yet-another-long-passphrase');
const rivera = (await call('GET', '/api/me', { token: riveraToken })).body;
const nguyen = (await call('GET', '/api/me', { token: nguyenToken })).body;

await test('setup refuses to run twice', async () => {
  const res = await call('POST', '/api/setup', { body: { username: 'x', password: 'yyyyyyyyyy' } });
  assert.equal(res.status, 409);
});

await test('bad password is rejected', async () => {
  const res = await call('POST', '/api/login', { body: { username: 'boletz', password: 'wrong' } });
  assert.equal(res.status, 401);
});

await test('unknown user and wrong password give the same answer', async () => {
  const a = await call('POST', '/api/login', { body: { username: 'boletz', password: 'wrong' } });
  const b = await call('POST', '/api/login', { body: { username: 'ghost', password: 'wrong' } });
  assert.equal(a.status, b.status);
  assert.equal(a.body.error, b.body.error);
});

await test('no token means no data', async () => {
  const res = await call('GET', '/api/activities');
  assert.equal(res.status, 401);
});

await test('self-registration creates an unattached personal-only identity', async () => {
  const created = await call('POST', '/api/register', {
    body: {
      username: 'selfservice', password: 'a-personal-long-passphrase',
      first_name: 'Avery', last_name: 'Stone', rank_id: 'PFC', mos: '0111',
    },
  });
  assert.equal(created.status, 201);
  const token = await login('selfservice', 'a-personal-long-passphrase');
  const mine = await call('GET', '/api/me', { token });
  assert.deepEqual(mine.body.unitIds, []);
  const orgView = await call('GET', '/api/org', { token });
  assert.deepEqual(orgView.body.units, []);
  const activity = await call('POST', '/api/activities', {
    token, body: { title: 'Personal onboarding note', date: '2026-08-01' },
  });
  assert.equal(activity.body.visibility, 'personal');
  assert.equal(activity.body.unit_id, null);
});

await test('public configuration exposes capabilities but no deployment secrets', async () => {
  const res = await call('GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.ui.palette, 'ocean-light');
  assert.equal(res.body.auth.self_registration, true);
  assert.equal(JSON.stringify(res.body).includes('VANTAGE_SETUP_TOKEN'), false);
  assert.equal(JSON.stringify(res.body).includes('VANTAGE_CAC_PROXY_SECRET'), false);
});

await test('rank requests notify an authorized reviewer and update the requester after approval', async () => {
  const requested = await call('POST', '/api/rank-requests', {
    token: riveraToken,
    body: { rank_id: 'Cpl', reason: 'Promotion effective this month.' },
  });
  assert.equal(requested.status, 200, requested.body?.error);

  const reviewQueue = await call('GET', '/api/rank-requests', { token: adminToken });
  assert.ok(reviewQueue.body.review.some((row) => row.id === requested.body.id));

  const reviewerNotifications = await call('GET', '/api/notifications', { token: adminToken });
  assert.ok(reviewerNotifications.body.rows.some((row) => row.kind === 'rank_request'));

  const approved = await call('PUT', `/api/rank-requests/${requested.body.id}`, {
    token: adminToken,
    body: { status: 'approved', note: 'Verified.' },
  });
  assert.equal(approved.status, 200, approved.body?.error);

  const updatedIdentity = await call('GET', '/api/me', { token: riveraToken });
  assert.equal(updatedIdentity.body.user.rank.abbr, 'Cpl');

  const requesterNotifications = await call('GET', '/api/notifications', { token: riveraToken });
  const decisionNotice = requesterNotifications.body.rows.find((row) => row.title === 'Rank request approved');
  assert.ok(decisionNotice);
  assert.match(decisionNotice.message, /Cpl/);
  assert.ok(requesterNotifications.body.unread >= 1);

  const marked = await call('PUT', `/api/notifications/${decisionNotice.id}/read`, { token: riveraToken });
  assert.equal(marked.status, 200);
  const readBack = await call('GET', '/api/notifications', { token: riveraToken });
  assert.ok(readBack.body.rows.find((row) => row.id === decisionNotice.id)?.read_at);
});

await test('authorized leaders can edit member profile fields directly', async () => {
  const changed = await call('PUT', `/api/team/${rivera.user.id}/profile`, {
    token: adminToken,
    body: { rank_id: 'Cpl', mos: '3451', email: 'raul.rivera@example.mil', eas: '2029-09-30' },
  });
  assert.equal(changed.status, 200, changed.body?.error);
  const detail = await call('GET', `/api/team/${rivera.user.id}`, { token: adminToken });
  assert.equal(detail.body.person.email, 'raul.rivera@example.mil');
  assert.equal(detail.body.person.eas, '2029-09-30');
});

await test('the Instance Operator can directly correct their own rank', async () => {
  const changed = await call('PUT', `/api/team/${me.user.id}/profile`, {
    token: adminToken,
    body: { rank_id: 'Sgt' },
  });
  assert.equal(changed.status, 200, changed.body?.error);
  assert.ok(changed.body.changed.includes('rank_id'));

  const identity = await call('GET', '/api/me', { token: adminToken });
  assert.equal(identity.body.user.rank.abbr, 'Sgt');

  const restored = await call('PUT', `/api/team/${me.user.id}/profile`, {
    token: adminToken,
    body: { rank_id: 'Cpl' },
  });
  assert.equal(restored.status, 200, restored.body?.error);
});

await test('combined member management is atomic when assignment validation fails', async () => {
  const assignmentCount = () => db.prepare(
    'SELECT COUNT(*) AS count FROM assignments WHERE user_id = ? AND is_primary = 1'
  ).get(rivera.user.id).count;
  const assignmentRows = () => db.prepare('SELECT * FROM assignments WHERE user_id = ?').all(rivera.user.id);
  assert.equal(assignmentCount(), 1, JSON.stringify(assignmentRows()));
  const refused = await call('PUT', `/api/team/${rivera.user.id}/manage`, {
    token: adminToken,
    body: {
      rank_id: 'Cpl', mos: '3451', email: 'should-not-save@example.mil', eas: '2029-09-30',
      unit_id: 'NO-SUCH-UNIT', billet_id: 'financial-management-resource-analyst', role_id: '',
    },
  });
  assert.equal(refused.status, 400);
  assert.equal(assignmentCount(), 1, JSON.stringify(assignmentRows()));
  const unchanged = await call('GET', `/api/team/${rivera.user.id}`, { token: adminToken });
  assert.equal(unchanged.body.person.email, 'raul.rivera@example.mil');

  const managed = await call('PUT', `/api/team/${rivera.user.id}/manage`, {
    token: adminToken,
    body: {
      rank_id: 'Cpl', mos: '3451', email: 'raul.rivera+managed@example.mil', eas: '2029-09-30',
      unit_id: 'G8-FMRAC', billet_id: 'financial-management-resource-analyst', role_id: '',
    },
  });
  assert.equal(managed.status, 200, managed.body?.error);
  assert.equal(assignmentCount(), 1, JSON.stringify(assignmentRows()));
  assert.ok(managed.body.changed.includes('email'));
  const changed = await call('GET', `/api/team/${rivera.user.id}`, { token: adminToken });
  assert.equal(changed.body.person.email, 'raul.rivera+managed@example.mil');
});

await test('Marines cannot bypass the rank request workflow or edit another unit', async () => {
  const selfEdit = await call('PUT', `/api/team/${rivera.user.id}/profile`, {
    token: riveraToken,
    body: { rank_id: 'Sgt' },
  });
  assert.equal(selfEdit.status, 400);

  const crossUnit = await call('PUT', `/api/team/${rivera.user.id}/profile`, {
    token: nguyenToken,
    body: { rank_id: 'Sgt' },
  });
  assert.equal(crossUnit.status, 403);
});

await test('only the Instance Operator can apply allow-listed runtime configuration', async () => {
  const refused = await call('PUT', '/api/admin/config', {
    token: riveraToken,
    body: { ui: { default_theme: 'dark' } },
  });
  assert.equal(refused.status, 403);

  const saved = await call('PUT', '/api/admin/config', {
    token: adminToken,
    body: {
      ui: { default_theme: 'dark' },
      limits: { max_guest_days: 45 },
      attachments: { enabled: true, max_bytes: 5 * 1024 * 1024, max_per_record: 8 },
      auth: { self_registration: true },
      experience_metrics: { enabled: true },
    },
  });
  assert.equal(saved.status, 200, saved.body?.error);
  assert.equal(saved.body.ui.default_theme, 'dark');
  assert.equal(saved.body.limits.max_guest_days, 45);
  assert.equal(saved.body.attachments.max_per_record, 8);

  const unknown = await call('PUT', '/api/admin/config', {
    token: adminToken,
    body: { storage: { database_path: '/tmp/not-allowed.db' } },
  });
  assert.equal(unknown.status, 400);

  const restored = await call('PUT', '/api/admin/config', {
    token: adminToken,
    body: {
      ui: { default_theme: 'light' },
      limits: { max_guest_days: 30 },
      attachments: { enabled: true, max_bytes: 10 * 1024 * 1024, max_per_record: 10 },
      auth: { self_registration: true },
      experience_metrics: { enabled: true },
    },
  });
  assert.equal(restored.status, 200);
});

await test('experience metrics retain aggregate allow-listed counts only', async () => {
  assert.equal((await call('POST', '/api/experience', {
    token: adminToken, body: { event: 'quick_log_saved' },
  })).status, 204);
  assert.equal((await call('POST', '/api/experience', {
    token: adminToken, body: { event: 'record_text:secret' },
  })).status, 400);
  const summary = await call('GET', '/api/admin/experience?days=30', { token: adminToken });
  assert.equal(summary.status, 200);
  assert.ok(summary.body.rows.some((row) => row.event === 'quick_log_saved' && row.count >= 1));
  const serialized = JSON.stringify(summary.body.rows);
  assert.equal(serialized.includes(adminToken), false);
  assert.equal(serialized.includes('actor_id'), false);
});

await test('logout invalidates the session immediately', async () => {
  const token = await login('nguyen', 'yet-another-long-passphrase');
  assert.equal((await call('GET', '/api/me', { token })).status, 200);
  await call('POST', '/api/logout', { token });
  assert.equal((await call('GET', '/api/me', { token })).status, 401);
});

await test('short passwords are refused at creation', async () => {
  const res = await call('POST', '/api/team', {
    token: adminToken,
    body: { username: 'weak', password: 'short', first_name: 'A', last_name: 'B', unit_id: 'MFR' },
  });
  assert.equal(res.status, 400);
});

await test('org reference data loads', async () => {
  const res = await call('GET', '/api/org', { token: adminToken });
  assert.ok(res.body.ranks.length >= 27, 'ranks');
  assert.ok(res.body.billets.length >= 30, 'billets');
  assert.ok(res.body.units.length >= 4, 'MFR plus the explicit authorization-test fixtures');
  assert.ok(res.body.units.some((u) => u.code === 'G8-FMRAC'));
  assert.ok(res.body.billets.some((b) => b.title === 'Fire Team Leader'));
});

await test('rank tiers cover enlisted, warrant and officer', async () => {
  const { ranks } = (await call('GET', '/api/org', { token: adminToken })).body;
  for (const tier of ['enlisted', 'nco', 'snco', 'warrant', 'officer']) {
    assert.ok(ranks.some((r) => r.tier === tier), `missing tier ${tier}`);
  }
});

await test('a unit leader sees Marines in subordinate units', async () => {
  const res = await call('GET', '/api/team', { token: adminToken });
  const names = res.body.roster.map((r) => r.last_name);
  assert.ok(names.includes('Rivera'), 'G-8 lead should see FMRAC Marine');
});

await test('a member sees only themselves', async () => {
  const res = await call('GET', '/api/team', { token: riveraToken });
  assert.equal(res.body.roster.length, 1, JSON.stringify(res.body.roster));
  assert.equal(res.body.roster[0].last_name, 'Rivera');
  assert.equal(res.body.canLead, false);
});

await test('a subordinate cannot open their leader record', async () => {
  const res = await call('GET', `/api/team/${me.user.id}`, { token: riveraToken });
  assert.equal(res.status, 403);
});

await test('a leader in another MSC cannot reach into this chain', async () => {
  const token = await login('nguyen', 'yet-another-long-passphrase');
  const res = await call('GET', `/api/team/${rivera.user.id}`, { token });
  assert.equal(res.status, 403);
});

await test('a leader can open a subordinate record', async () => {
  const res = await call('GET', `/api/team/${rivera.user.id}`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.body.person.last_name, 'Rivera');
});

await test('opening a subordinate record writes an audit row', async () => {
  await call('GET', `/api/team/${rivera.user.id}`, { token: adminToken });
  const res = await call('GET', '/api/audit', { token: riveraToken });
  assert.ok(res.body.some((r) => r.action === 'view_member'), 'Rivera should see who read his record');
});

await test('a leader opening a member record does not receive private entries', async () => {
  await call('POST', '/api/activities', {
    token: riveraToken,
    body: { title: 'Private counseling note', date: '2026-08-11', visibility: 'private' },
  });
  await call('POST', '/api/activities', {
    token: riveraToken,
    body: { title: 'Shared fiscal work', date: '2026-08-12', visibility: 'unit', unit_id: 'G8-FMRAC' },
  });
  const res = await call('GET', `/api/team/${rivera.user.id}`, { token: adminToken });
  const titles = res.body.activities.map((a) => a.title);
  assert.ok(titles.includes('Shared fiscal work'), 'shared work should be visible');
  assert.ok(!titles.includes('Private counseling note'), 'PRIVACY LEAK: private entry exposed to leader');
});

await test('a Marine opening their own record sees everything including private', async () => {
  const res = await call('GET', `/api/team/${rivera.user.id}`, { token: riveraToken });
  const titles = res.body.activities.map((a) => a.title);
  assert.ok(titles.includes('Private counseling note'), 'own private entry should be visible to self');
});

await test('a member cannot add Marines', async () => {
  const res = await call('POST', '/api/team', {
    token: riveraToken,
    body: { username: 'sneak', password: 'a-long-enough-passphrase', first_name: 'S', last_name: 'T', unit_id: 'MFR' },
  });
  assert.equal(res.status, 403);
});

await test('no install ships a global role; a claimed unit gets its own copies', async () => {
  const res = await call('GET', '/api/roles', { token: adminToken });
  const roles = res.body.roles;
  assert.ok(roles.length > 0, 'the owner should see their own units\' roles');
  assert.ok(roles.every((r) => r.unit_id), 'every role must belong to a unit');


  for (const unit of ['MFR', 'G8-FMRAC']) {
    assert.ok(roles.some((r) => r.unit_id === unit && r.template_key === 'sncoic'), `${unit} has no SNCOIC copy`);
  }
  const ceg8 = roles.find((r) => r.unit_id === 'MFR' && r.template_key === 'marine');
  const fmrac = roles.find((r) => r.unit_id === 'G8-FMRAC' && r.template_key === 'marine');
  assert.notEqual(ceg8.id, fmrac.id, 'two units must not share a role row');
});

await test('a unit may edit and delete its own template-derived roles', async () => {
  const edit = await call('PUT', '/api/roles/MFR:sncoic', { token: adminToken, body: { name: 'Section Chief' } });
  assert.equal(edit.status, 200, `expected the owner to rename their own role, got ${edit.status}`);
  assert.equal(edit.body.name, 'Section Chief');

  const del = await call('DELETE', '/api/roles/MFR:nco', { token: adminToken });
  assert.equal(del.status, 200, `expected the owner to delete their own role, got ${del.status}`);
});

await test('editing one unit\'s role leaves the other unit\'s copy untouched', async () => {


  const before = (await call('GET', '/api/roles', { token: adminToken })).body.roles
    .find((r) => r.unit_id === 'G8-FMRAC' && r.template_key === 'sncoic');
  assert.equal(before.name, 'SNCOIC', 'the FMRAC copy should be unchanged by the MFR rename above');
});

await test('a member cannot create roles', async () => {
  const res = await call('POST', '/api/roles', {
    token: riveraToken,
    body: { name: 'Self Promotion', position: 1, permissions: 2048, unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
});

await test('nobody can create a role at or above their own position', async () => {

  await call('POST', `/api/team/${rivera.user.id}/roles`, {
    token: adminToken,
    body: { role_id: 'G8-FMRAC:sncoic', unit_id: 'G8-FMRAC' },
  });
  riveraToken = await login('rivera', 'a-different-long-passphrase');
  const token = await login('rivera', 'a-different-long-passphrase');
  const res = await call('POST', '/api/roles', {
    token,
    body: { name: 'Above Me', position: 95, permissions: 1, unit_id: 'G8-FMRAC' },
  });
  assert.ok([403, 400].includes(res.status), `expected refusal, got ${res.status}`);
});

await test('PRIVILEGE ESCALATION: cannot grant a permission you do not hold', async () => {
  const token = await login('rivera', 'a-different-long-passphrase');


  const res = await call('POST', '/api/roles', {
    token,
    body: { name: 'Sneaky Admin', position: 1, permissions: 2048, unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403, 'a non-owner must not mint an administrator role');
});

await test('a leader cannot hand out a role at or above their own', async () => {
  const token = await login('rivera', 'a-different-long-passphrase');
  const res = await call('POST', `/api/team/${rivera.user.id}/roles`, {
    token,
    body: { role_id: 'G8-FMRAC:unit-leader', unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
});

await test('a role reaches the unit it was granted in', async () => {
  const res = await call('GET', '/api/team', { token: adminToken });
  assert.ok(res.body.roster.some((r) => r.last_name === 'Rivera'), 'owner of G8-FMRAC should see its Marine');
});

await test('a role reaches nowhere else, whatever the org chart says', async () => {
  const token = await login('nguyen', 'yet-another-long-passphrase');
  const res = await call('GET', '/api/team', { token });
  assert.ok(!res.body.roster.some((r) => r.last_name === 'Rivera'), 'CLR-4 owner must not see a G-8 Marine');
});

await test('roster visibility does not imply record access', async () => {



  const viewer = await call('POST', '/api/roles', {
    token: adminToken,
    body: { name: 'Training NCO', unit_id: 'G8-FMRAC', position: 15, permissions: 1 | 2 | 16 },
  });
  await call('POST', '/api/team', {
    token: adminToken,
    body: {
      username: 'trainer', password: 'trainer-long-enough-passphrase',
      first_name: 'Pat', last_name: 'Trainer', rank_id: 'Sgt',
      unit_id: 'G8-FMRAC', role_id: viewer.body.id,
    },
  });
  const token = await login('trainer', 'trainer-long-enough-passphrase');
  const roster = await call('GET', '/api/team', { token });
  assert.ok(roster.body.roster.some((r) => r.last_name === 'Rivera'), 'should see them on the roster');
  const detail = await call('GET', `/api/team/${rivera.user.id}`, { token });
  assert.equal(detail.status, 403, 'must not be able to open the record');
});

await test('a member cannot create units', async () => {
  const res = await call('POST', '/api/org/units', {
    token: riveraToken,
    body: { name: 'Shadow Team', echelon: 'fire_team', parent_id: 'MFR' },
  });
  assert.equal(res.status, 403);
});

await test('a section head creates a unit beneath their own', async () => {
  const res = await call('POST', '/api/org/units', {
    token: adminToken,
    body: { name: 'Audit Support Cell', short_name: 'ASC', echelon: 'fire_team', parent_id: 'MFR' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.parent_id, 'MFR');
});

await test('a new unit inherits the cascade from above', async () => {
  await call('POST', '/api/team', {
    token: adminToken,
    body: {
      username: 'newbie', password: 'newbie-long-enough-passphrase',
      first_name: 'Sam', last_name: 'Newbie', rank_id: 'PFC', unit_id: 'AUDIT-SUPPORT-CELL',
    },
  });
  const res = await call('GET', '/api/team', { token: adminToken });
  assert.ok(res.body.roster.some((r) => r.last_name === 'Newbie'), 'section head should see into a unit they just made');
});

await test('a unit with Marines still assigned cannot be archived', async () => {
  const res = await call('DELETE', '/api/org/units/AUDIT-SUPPORT-CELL', { token: adminToken });
  assert.equal(res.status, 400);
});

await test('readiness saves and reads back', async () => {
  await call('PUT', '/api/readiness', {
    token: riveraToken,
    body: { pft_score: 285, cft_score: 262, mcmap_belt: 'Grey', rifle_qual: 'Sharpshooter', ceus: 22 },
  });
  const res = await call('GET', '/api/readiness', { token: riveraToken });
  assert.equal(res.body.pft_score, 285);
  assert.equal(res.body.mcmap_belt, 'Grey');
});

await test('readiness of another Marine needs VIEW_MEMBER_DETAIL', async () => {
  const token = await login('trainer', 'trainer-long-enough-passphrase');
  const res = await call('GET', `/api/readiness/${rivera.user.id}`, { token });
  assert.equal(res.status, 403);
});

await test('preferences round-trip and merge shallowly', async () => {
  await call('PUT', '/api/prefs', {
    token: riveraToken,
    body: { dashboard: { hidden: ['goals'], collapsed: ['tape'] } },
  });
  await call('PUT', '/api/prefs', { token: riveraToken, body: { fitrep: { periodEnd: '2026-09-30' } } });
  const res = await call('GET', '/api/prefs', { token: riveraToken });
  assert.deepEqual(res.body.dashboard.hidden, ['goals'], 'first key must survive the second write');
  assert.equal(res.body.fitrep.periodEnd, '2026-09-30');
});

await test('preferences are per-user, not shared', async () => {
  const other = await call('GET', '/api/prefs', { token: adminToken });
  assert.ok(!other.body.fitrep, "one Marine's prefs must not appear on another's account");
});

await test('oversized preferences are refused', async () => {
  const res = await call('PUT', '/api/prefs', {
    token: riveraToken,
    body: { junk: 'x'.repeat(40_000) },
  });
  assert.equal(res.status, 400);
});

await test('an old-shape database gains the new columns on boot', async () => {


  const { getDb } = await import('../server/db.js');
  const live = getDb();
  const cols = live.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const col of ['pft_score', 'mcmap_belt', 'prefs', 'cmd_leadership']) {
    assert.ok(cols.includes(col), `users.${col} should exist after migrate()`);
  }
});

await test('health check reports the database is answering', async () => {
  const res = await call('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, '3.7.0');
  assert.ok(res.body.build);
});

await test('security headers are set', async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.match(res.headers.get('content-security-policy') || '', /connect-src 'self'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('x-vantage-build'));
  assert.equal(res.headers.get('x-vantage-product'), 'Vantage');
});

await test('private records stay private from the chain of command', async () => {
  await call('POST', '/api/activities', {
    token: riveraToken,
    body: { title: 'Private note to self', date: '2026-08-01', visibility: 'private' },
  });
  const leaderView = await call('GET', '/api/activities', { token: adminToken });
  assert.ok(!leaderView.body.some((a) => a.title === 'Private note to self'));
});

await test('unit-visible records are readable by the unit that holds them', async () => {
  await call('POST', '/api/activities', {
    token: riveraToken,
    body: {
      title: 'Reconciled 12 ULOs', date: '2026-08-02', dollar_amount: 44000,
      dollar_type: 'reconciled', quantity: 12, unit_label: 'ULOs',
      jepes_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8-FMRAC',
    },
  });
  const leaderView = await call('GET', '/api/activities', { token: adminToken });
  assert.ok(leaderView.body.some((a) => a.title === 'Reconciled 12 ULOs'));
});

await test('recognition source and goal measurement unit round-trip without being dropped', async () => {
  const recognition = await call('POST', '/api/recognitions', {
    token: riveraToken,
    body: {
      title: 'Letter of appreciation', date: '2026-08-03', type: 'loa',
      from_whom: 'Commanding Officer', visibility: 'private', unit_id: 'G8-FMRAC',
    },
  });
  assert.equal(recognition.status, 200);
  assert.equal(recognition.body.from_whom, 'Commanding Officer');

  const goal = await call('POST', '/api/goals', {
    token: riveraToken,
    body: {
      title: 'Close aged ULOs', target_value: 30, unit_label: 'ULOs',
      type: 'performance', status: 'active', visibility: 'private', unit_id: 'G8-FMRAC',
    },
  });
  assert.equal(goal.status, 200);
  assert.equal(goal.body.unit_label, 'ULOs');
});

await test('an outside leader sees neither', async () => {
  const token = await login('nguyen', 'yet-another-long-passphrase');
  const res = await call('GET', '/api/activities', { token });
  assert.ok(!res.body.some((a) => a.title === 'Reconciled 12 ULOs'));
  assert.ok(!res.body.some((a) => a.title === 'Private note to self'));
});

await test('a member cannot share a task to a unit they are not in', async () => {
  const res = await call('POST', '/api/tasks', {
    token: riveraToken,
    body: { title: 'Unauthorised broadcast', visibility: 'unit', unit_id: 'MFR' },
  });
  assert.equal(res.status, 403);
});

await test('a leader can push a task to a unit they hold', async () => {
  const res = await call('POST', '/api/tasks', {
    token: adminToken,
    body: { title: 'Close out FY execution', visibility: 'unit', unit_id: 'G8-FMRAC', priority: 'high' },
  });
  assert.equal(res.status, 200);
  const subordinate = await call('GET', '/api/tasks', { token: riveraToken });
  assert.ok(subordinate.body.some((t) => t.title === 'Close out FY execution'), 'FMRAC Marine should see it');
});

await test('a task posted to the parent unit does NOT reach the child unit', async () => {


  const res = await call('POST', '/api/tasks', {
    token: adminToken,
    body: { title: 'Parent-only tasking', visibility: 'unit', unit_id: 'MFR' },
  });
  assert.equal(res.status, 200);
  const subordinate = await call('GET', '/api/tasks', { token: riveraToken });
  assert.ok(
    !subordinate.body.some((t) => t.title === 'Parent-only tasking'),
    'a MFR task must not reach a G8-FMRAC Marine — that is the cascade v3.4 removed'
  );
});

await test('a shared unit goal reaches that unit', async () => {
  await call('POST', '/api/goals', {
    token: adminToken,
    body: { title: 'Zero aged ULOs by 30 SEP', target_value: 0, visibility: 'unit', unit_id: 'G8-FMRAC' },
  });
  const res = await call('GET', '/api/goals', { token: riveraToken });
  assert.ok(res.body.some((g) => g.title === 'Zero aged ULOs by 30 SEP'));
});

await test('unit-scoped sharing does not leak sideways', async () => {
  const token = await login('nguyen', 'yet-another-long-passphrase');
  const res = await call('GET', '/api/goals', { token });
  assert.ok(!res.body.some((g) => g.title === 'Zero aged ULOs by 30 SEP'));
});

await test('a Marine cannot edit a record outside their reach', async () => {
  const leaderActivity = await call('POST', '/api/activities', {
    token: adminToken,
    body: { title: 'Leader only entry', date: '2026-08-03', visibility: 'private' },
  });
  const res = await call('PUT', `/api/activities/${leaderActivity.body.id}`, {
    token: riveraToken,
    body: { title: 'Tampered' },
  });
  assert.ok([403, 404].includes(res.status), `expected refusal, got ${res.status}`);
});

await test('delete is soft and reversible', async () => {
  const created = await call('POST', '/api/activities', {
    token: riveraToken,
    body: { title: 'Deletable entry', date: '2026-08-04' },
  });
  await call('DELETE', `/api/activities/${created.body.id}`, { token: riveraToken });

  let list = await call('GET', '/api/activities', { token: riveraToken });
  assert.ok(!list.body.some((a) => a.id === created.body.id), 'should be hidden after delete');

  await call('POST', `/api/activities/${created.body.id}/restore`, { token: riveraToken });
  list = await call('GET', '/api/activities', { token: riveraToken });
  assert.ok(list.body.some((a) => a.id === created.body.id), 'should come back after restore');
});

await test('bulk import lands under the importing user', async () => {
  const res = await call('POST', '/api/activities/bulk', {
    token: riveraToken,
    body: { rows: [{ title: 'Imported A', date: '2026-07-01' }, { title: 'Imported B', date: '2026-07-02' }] },
  });
  assert.equal(res.body.created, 2);
  const list = await call('GET', '/api/activities', { token: riveraToken });
  assert.ok(list.body.filter((a) => a.title.startsWith('Imported ')).length === 2);
});

await test('optional supporting links survive the JSON round trip', async () => {
  const created = await call('POST', '/api/activities', {
    token: adminToken,
    body: {
      title: 'With evidence', date: '2026-08-05',
      evidence_links: [{ label: 'ULO report', url: 'https://example.invalid/x' }],
    },
  });
  assert.equal(created.body.evidence_links[0].label, 'ULO report');
});

await test('optional attachments are sniffed, authorized, downloadable, and soft-deleted', async () => {
  const activity = await call('POST', '/api/activities', {
    token: riveraToken,
    body: { title: 'Attachment boundary', date: '2026-08-12', visibility: 'unit', unit_id: 'G8-FMRAC' },
  });
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const upload = await callRaw('POST', `/api/activities/${activity.body.id}/attachments`, {
    token: riveraToken, body: pdf, filename: 'ULO support.pdf', contentType: 'application/pdf',
  });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.original_name, 'ULO support.pdf');

  const managerList = await call('GET', `/api/activities/${activity.body.id}/attachments`, { token: adminToken });
  assert.equal(managerList.body.attachments.length, 1);
  const download = await callRaw(
    'GET', `/api/activities/${activity.body.id}/attachments/${upload.body.id}`, { token: adminToken }
  );
  assert.equal(download.status, 200);
  assert.deepEqual(download.bytes, pdf);
  assert.match(download.headers.get('content-disposition'), /^attachment;/);

  const outsider = await call('GET', `/api/activities/${activity.body.id}/attachments`, { token: nguyenToken });
  assert.equal(outsider.status, 403);
  const removed = await call(
    'DELETE', `/api/activities/${activity.body.id}/attachments/${upload.body.id}`, { token: riveraToken }
  );
  assert.equal(removed.status, 200);
  const after = await call('GET', `/api/activities/${activity.body.id}/attachments`, { token: riveraToken });
  assert.equal(after.body.attachments.length, 0);
});

server.close();
try { rmSync(DB, { force: true }); rmSync(`${DB}-wal`, { force: true }); rmSync(`${DB}-shm`, { force: true }); } catch {  }

const failed = results.filter(([s]) => s === 'FAIL');
for (const [status, name] of results) {
  console.log(`  ${status === 'PASS' ? 'ok  ' : 'FAIL'}  ${name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
