import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-matrix-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'boletz';

const { app, db } = await import('../server/index.js');
const { seedTestUnits } = await import('./helpers/seed-test-units.mjs');
seedTestUnits(db);

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://localhost:${server.address().port}`;

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {  }
  return { status: res.status, body: json };
};
const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).body?.token;
const PW = (u) => `${u}-long-enough-passphrase`;
const must = (res, what) => {
  assert.ok(res.status >= 200 && res.status < 300, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

must(await call('POST', '/api/setup', {
  body: { username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927', first_name: 'J', last_name: 'B', rank_id: 'Cpl', unit_code: 'MFR' },
}), 'setup');
const adminTok = await login('boletz', 'cobalt-orbit-velvet-anchor-927');

const createdIds = new Map();

const mk = async (token, username, unit_id, role_id = null, rank_id = 'LCpl') => {
  let result;
  if (token === adminTok) {
    result = must(await call('POST', '/api/team', {
      token,
      body: { username, password: PW(username), first_name: 'M', last_name: username, rank_id, mos: '3451', unit_id, role_id },
    }), `create ${username}`);
  } else {
    must(await call('POST', '/api/register', {
      body: { username, password: PW(username), first_name: 'M', last_name: username, rank_id, mos: '3451' },
    }), `register ${username}`);
    const found = must(await call('GET', `/api/directory?unit_id=${encodeURIComponent(unit_id)}&q=${encodeURIComponent(username)}`, { token }), `find ${username}`)
      .results.find((row) => row.username === username);
    assert.ok(found, `directory missing ${username}`);
    must(await call('POST', `/api/org/units/${unit_id}/members`, {
      token, body: { user_id: found.id, role_id },
    }), `attach ${username}`);
    result = { id: found.id };
  }
  createdIds.set(username, result.id);
  return result;
};

const claim = async (unitId, ownerUsername, ownerId) => {
  must(await call('POST', `/api/org/units/${unitId}/claim`, {
    token: adminTok, body: { owner_user_id: ownerId, template_id: 'default' },
  }), `claim ${unitId} for ${ownerUsername}`);
};

await mk(adminTok, 'hayes', 'MFR', 'MFR:sncoic', 'GySgt');

const nguyenId = (await mk(adminTok, 'nguyen', 'MFR', null, 'Sgt')).id;
const budgetBossId = (await mk(adminTok, 'budgetboss', 'MFR', null, 'SSgt')).id;
const clrLeadId = (await mk(adminTok, 'clrlead', 'MFR', null, 'GySgt')).id;

await claim('G8-FMRAC', 'nguyen', nguyenId);
await claim('G8-BUDGET', 'budgetboss', budgetBossId);
await claim('CLR-4', 'clrlead', clrLeadId);

const tokNguyen = await login('nguyen', PW('nguyen'));
const tokBudget = await login('budgetboss', PW('budgetboss'));
const tokClr = await login('clrlead', PW('clrlead'));

await mk(tokNguyen, 'ohara', 'G8-FMRAC', 'G8-FMRAC:fire-team-leader', 'Cpl');
await mk(tokNguyen, 'rivera', 'G8-FMRAC');

await mk(tokNguyen, 'probe', 'G8-FMRAC');
await mk(tokBudget, 'kramer', 'G8-BUDGET');
await mk(tokClr, 'zed', 'CLR-4');

const id = (u) => {
  const found = createdIds.get(u);
  assert.ok(found, `fixture missing ${u}`);
  return found;
};

const tok = {
  admin: adminTok,
  sectionHead: await login('hayes', PW('hayes')),
  ncoic: tokNguyen,
  ftl: await login('ohara', PW('ohara')),
  marine: await login('rivera', PW('rivera')),
  clrLead: tokClr,
};

const ownerTokenFor = { 'G8-FMRAC': tokNguyen, 'G8-BUDGET': tokBudget, 'CLR-4': tokClr, 'MFR': adminTok };

let seq = 0;
const ACTIONS = {
  readMember: (t, target) => call('GET', `/api/team/${id(target)}`, { token: t }),


  createShared: (t, unit) => call('POST', '/api/activities', {
    token: t, body: { title: `Matrix ${seq += 1}`, date: '2026-08-10', visibility: 'unit', unit_id: unit },
  }),

  manageMember: (t, target) => call('POST', `/api/team/${id(target)}/logout`, { token: t }),


  grantRole: async (t, [target, unit]) => {
    const roleId = `${unit}:nco`;
    const res = await call('POST', `/api/team/${id(target)}/roles`, { token: t, body: { role_id: roleId, unit_id: unit } });
    if (res.status >= 200 && res.status < 300) {
      await call('DELETE', `/api/team/${id(target)}/roles/${roleId}?unit_id=${unit}`, { token: ownerTokenFor[unit] });
    }
    return res;
  },

  unitAudit: (t, unit) => call('GET', `/api/audit/unit?unit_id=${unit}`, { token: t }),
  exportUnit: (t, unit) => call('GET', `/api/export?unit_id=${unit}`, { token: t }),

  createSubUnit: (t, parent) => call('POST', '/api/org/units', {
    token: t, body: { name: `Matrix Cell ${seq += 1}`, code: `MX${seq}`, echelon: 'fire_team', parent_id: parent },
  }),


  createTopLevelUnit: (t) => call('POST', '/api/org/units', {
    token: t, body: { name: `Sovereign Shop ${seq += 1}`, code: `SOV${seq}`, level: 'L4' },
  }),
};

const ROWS = [

  ['marine', 'readMember', 'rivera', 'self', 'allow'],
  ['marine', 'readMember', 'kramer', 'other unit', 'deny'],
  ['marine', 'readMember', 'ohara', 'own unit, no permission', 'deny'],
  ['ftl', 'readMember', 'rivera', 'own unit', 'allow'],
  ['ftl', 'readMember', 'kramer', 'other unit', 'deny'],
  ['ftl', 'readMember', 'hayes', 'parent unit', 'deny'],
  ['ncoic', 'readMember', 'rivera', 'own unit', 'allow'],
  ['ncoic', 'readMember', 'kramer', 'other unit', 'deny'],
  ['sectionHead', 'readMember', 'kramer', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'readMember', 'zed', 'unrelated unit', 'deny'],
  ['clrLead', 'readMember', 'rivera', 'unrelated unit', 'deny'],
  ['admin', 'readMember', 'zed', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],


  ['marine', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['marine', 'createShared', 'G8-BUDGET', 'other unit', 'deny'],
  ['ftl', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['ftl', 'createShared', 'G8-BUDGET', 'other unit', 'deny'],
  ['ncoic', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['ncoic', 'createShared', 'G8-BUDGET', 'other unit', 'deny'],
  ['sectionHead', 'createShared', 'G8-BUDGET', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'createShared', 'CLR-4', 'unrelated unit', 'deny'],
  ['admin', 'createShared', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],


  ['marine', 'manageMember', 'kramer', 'no permission', 'deny'],
  ['ftl', 'manageMember', 'rivera', 'own unit, no MANAGE_MEMBERS', 'deny'],
  ['ncoic', 'manageMember', 'probe', 'own unit manager, not operator', 'deny', 'allow — global-account finding'],
  ['ncoic', 'manageMember', 'kramer', 'other unit', 'deny'],
  ['sectionHead', 'manageMember', 'kramer', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['clrLead', 'manageMember', 'rivera', 'unrelated unit', 'deny'],
  ['admin', 'manageMember', 'zed', 'Instance Operator recovery action', 'allow'],


  ['marine', 'grantRole', ['kramer', 'G8-BUDGET'], 'no permission', 'deny'],
  ['ftl', 'grantRole', ['rivera', 'G8-FMRAC'], 'own unit, no MANAGE_ROLES', 'deny'],
  ['ncoic', 'grantRole', ['rivera', 'G8-FMRAC'], 'own unit, is owner', 'allow'],
  ['sectionHead', 'grantRole', ['rivera', 'G8-FMRAC'], 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'grantRole', ['zed', 'CLR-4'], 'unrelated unit', 'deny'],
  ['clrLead', 'grantRole', ['zed', 'CLR-4'], 'own unit, is owner', 'allow'],
  ['clrLead', 'grantRole', ['rivera', 'G8-FMRAC'], 'unrelated unit', 'deny'],
  ['admin', 'grantRole', ['zed', 'CLR-4'], 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],


  ['marine', 'unitAudit', 'G8-FMRAC', 'no VIEW_AUDIT', 'deny'],
  ['ncoic', 'unitAudit', 'G8-FMRAC', 'own unit', 'allow'],
  ['ncoic', 'unitAudit', 'G8-BUDGET', 'other unit', 'deny'],
  ['sectionHead', 'unitAudit', 'G8-BUDGET', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'unitAudit', 'MFR', 'own unit', 'allow'],
  ['admin', 'unitAudit', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],


  ['marine', 'exportUnit', 'G8-FMRAC', 'no EXPORT_DATA', 'deny'],
  ['ftl', 'exportUnit', 'G8-FMRAC', 'no EXPORT_DATA', 'deny'],
  ['sectionHead', 'exportUnit', 'MFR', 'own unit', 'allow'],
  ['sectionHead', 'exportUnit', 'G8-BUDGET', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['admin', 'exportUnit', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],


  ['marine', 'createSubUnit', 'G8-FMRAC', 'no MANAGE_UNITS', 'deny'],
  ['ftl', 'createSubUnit', 'G8-FMRAC', 'no MANAGE_UNITS', 'deny'],
  ['sectionHead', 'createSubUnit', 'MFR', 'own unit', 'allow'],
  ['sectionHead', 'createSubUnit', 'CLR-4', 'unrelated unit', 'deny'],
  ['admin', 'createSubUnit', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],


  ['marine', 'createTopLevelUnit', null, 'no roles anywhere', 'deny', 'allow — unrestricted creation finding'],
  ['ftl', 'createTopLevelUnit', null, 'NCO elsewhere', 'deny', 'allow — unrestricted creation finding'],
  ['clrLead', 'createTopLevelUnit', null, 'owner elsewhere', 'deny', 'allow — unrestricted creation finding'],
  ['admin', 'createTopLevelUnit', null, 'Instance Operator', 'allow'],
];

let pass = 0;
const failures = [];
let rewritten = 0;

for (const [actor, action, arg, relation, expected, was] of ROWS) {
  const res = await ACTIONS[action](tok[actor], arg);
  const allowed = res.status >= 200 && res.status < 300;
  const ok = expected === 'allow' ? allowed : !allowed;
  if (was) rewritten += 1;

  const label = `${actor.padEnd(11)} ${action.padEnd(18)} ${String(Array.isArray(arg) ? arg.join('@') : (arg ?? '—')).padEnd(14)} ${relation.padEnd(30)} → ${expected}${was ? `   [was ${was}]` : ''}`;
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else {
    failures.push(`${label} (got ${res.status}${res.body?.error ? `: ${res.body.error}` : ''})`);
    console.log(`  FAIL  ${label} (got ${res.status}${res.body?.error ? `: ${res.body.error}` : ''})`);
  }
}

server.close();
for (const s of ['', '-wal', '-shm']) rmSync(DB + s, { force: true });

console.log(`\n${pass}/${ROWS.length} matrix rows hold`);
console.log(`${rewritten} rows carry a v3.3 expectation that was deliberately reversed.`);
assert.equal(failures.length, 0, `matrix rows failed:\n${failures.join('\n')}`);
process.exit(0);
