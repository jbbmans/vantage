/**
 * Permission matrix (v3.3 finding 39).
 *
 * One table, read like the roadmap wrote it: role × unit relationship ×
 * action → allow/deny. The other suites attack specific mechanisms; this one
 * pins the whole grid, so a future permission change that widens or narrows
 * anyone's reach fails loudly with the exact row that moved.
 *
 * Run with: node tests/matrix.test.mjs
 */

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-matrix-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';

const { app } = await import('../server/index.js');
const { PERMISSIONS: P } = await import('../server/roles.js');

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
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json };
};
const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).body?.token;
const PW = (u) => `${u}-long-enough-passphrase`;

/* ── world ────────────────────────────────────────────────────────── */

await call('POST', '/api/setup', {
  body: { username: 'boletz', password: 'correct-horse-battery-staple', first_name: 'J', last_name: 'B', rank_id: 'Cpl', unit_code: 'CE-G8' },
});
const adminTok = await login('boletz', 'correct-horse-battery-staple');

const mk = (username, unit_id, role_id = null, rank_id = 'LCpl') =>
  call('POST', '/api/team', {
    token: adminTok,
    body: { username, password: PW(username), first_name: 'M', last_name: username, rank_id, mos: '3451', unit_id, role_id },
  });

for (const args of [
  ['hayes', 'CE-G8', 'section-head', 'GySgt'],
  ['nguyen', 'G8-FMRAC', 'ncoic', 'Sgt'],
  ['ohara', 'G8-FMRAC', 'fire-team-leader', 'Cpl'],
  ['rivera', 'G8-FMRAC'],
  ['kramer', 'G8-BUDGET'],
  ['zed', 'CLR-4'],
  ['clrlead', 'CLR-4', 'section-head', 'GySgt'],
]) {
  const res = await mk(...args);
  assert.equal(res.status, 200, `fixture ${args[0]}: ${res.status} ${JSON.stringify(res.body)}`);
}

const roster = (await call('GET', '/api/team', { token: adminTok })).body.roster;
const id = (u) => roster.find((r) => r.username === u).id;

// An org-wide, low, harmless role for the grant rows.
const wide = (await call('POST', '/api/roles', {
  token: adminTok, body: { name: 'Wide Viewer', position: 1, permissions: P.VIEW_UNIT },
})).body;

const tok = {
  admin: adminTok,
  sectionHead: await login('hayes', PW('hayes')),
  ncoic: await login('nguyen', PW('nguyen')),
  ftl: await login('ohara', PW('ohara')),
  marine: await login('rivera', PW('rivera')),
  clrLead: await login('clrlead', PW('clrlead')),
};

/* ── actions ──────────────────────────────────────────────────────── */

let seq = 0;
const ACTIONS = {
  readMember: (t, target) => call('GET', `/api/team/${id(target)}`, { token: t }),
  createShared: (t, unit) => call('POST', '/api/activities', {
    token: t, body: { title: `Matrix ${seq += 1}`, date: '2026-08-10', visibility: 'chain', unit_id: unit },
  }),
  manageMember: (t, target) => call('POST', `/api/team/${id(target)}/logout`, { token: t }),
  grantRole: async (t, [target, unit]) => {
    const res = await call('POST', `/api/team/${id(target)}/roles`, { token: t, body: { role_id: wide.id, unit_id: unit } });
    if (res.status === 200) await call('DELETE', `/api/team/${id(target)}/roles/${wide.id}?unit_id=${unit}`, { token: adminTok });
    return res;
  },
  unitAudit: (t, unit) => call('GET', `/api/audit/unit?unit_id=${unit}`, { token: t }),
  exportUnit: (t, unit) => call('GET', `/api/export?unit_id=${unit}`, { token: t }),
  createUnit: (t, parent) => call('POST', '/api/org/units', {
    token: t, body: { name: `Matrix Cell ${seq += 1}`, short_name: `MX${seq}`, echelon: 'fire_team', parent_id: parent },
  }),
};

/* ── the matrix ───────────────────────────────────────────────────── */
// [actor, action, argument, relationship, expected]

const ROWS = [
  // read member detail
  ['marine', 'readMember', 'rivera', 'self', 'allow'],
  ['marine', 'readMember', 'kramer', 'sibling unit', 'deny'],
  ['marine', 'readMember', 'ohara', 'own unit, no permission', 'deny'],
  ['ftl', 'readMember', 'rivera', 'own team', 'allow'],
  ['ftl', 'readMember', 'kramer', 'sibling unit', 'deny'],
  ['ftl', 'readMember', 'hayes', 'upward', 'deny'],
  ['ncoic', 'readMember', 'rivera', 'own unit', 'allow'],
  ['ncoic', 'readMember', 'kramer', 'sibling unit', 'deny'],
  ['sectionHead', 'readMember', 'kramer', 'own subtree', 'allow'],
  ['sectionHead', 'readMember', 'zed', 'outside subtree', 'deny'],
  ['clrLead', 'readMember', 'rivera', 'outside subtree', 'deny'],
  ['admin', 'readMember', 'zed', 'anywhere', 'allow'],

  // create a shared (chain) record in a unit
  ['marine', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['marine', 'createShared', 'G8-BUDGET', 'sibling unit', 'deny'],
  ['ftl', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['ftl', 'createShared', 'G8-BUDGET', 'sibling unit', 'deny'],
  ['ncoic', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['ncoic', 'createShared', 'G8-BUDGET', 'sibling unit', 'deny'],
  ['sectionHead', 'createShared', 'G8-BUDGET', 'own subtree', 'allow'],
  ['sectionHead', 'createShared', 'CLR-4', 'outside subtree', 'deny'],
  ['admin', 'createShared', 'CLR-4', 'anywhere', 'allow'],

  // manage a member (non-destructive probe: force sign-out)
  ['marine', 'manageMember', 'kramer', 'no permission', 'deny'],
  ['ftl', 'manageMember', 'rivera', 'own team, no MANAGE_MEMBERS', 'deny'],
  ['ncoic', 'manageMember', 'rivera', 'own unit', 'allow'],
  ['ncoic', 'manageMember', 'kramer', 'sibling unit', 'deny'],
  ['sectionHead', 'manageMember', 'kramer', 'own subtree', 'allow'],
  ['clrLead', 'manageMember', 'rivera', 'outside subtree', 'deny'],
  ['admin', 'manageMember', 'zed', 'anywhere', 'allow'],

  // grant a role
  ['marine', 'grantRole', ['kramer', 'G8-BUDGET'], 'no permission', 'deny'],
  ['ncoic', 'grantRole', ['rivera', 'G8-FMRAC'], 'no MANAGE_ROLES', 'deny'],
  ['sectionHead', 'grantRole', ['rivera', 'G8-FMRAC'], 'own subtree', 'allow'],
  ['sectionHead', 'grantRole', ['zed', 'CLR-4'], 'outside subtree', 'deny'],
  ['clrLead', 'grantRole', ['zed', 'CLR-4'], 'own subtree', 'allow'],
  ['clrLead', 'grantRole', ['rivera', 'G8-FMRAC'], 'outside subtree', 'deny'],
  ['admin', 'grantRole', ['zed', 'CLR-4'], 'anywhere', 'allow'],

  // unit audit log
  ['marine', 'unitAudit', 'G8-FMRAC', 'no VIEW_AUDIT', 'deny'],
  ['ncoic', 'unitAudit', 'G8-FMRAC', 'own unit', 'allow'],
  ['ncoic', 'unitAudit', 'G8-BUDGET', 'sibling unit', 'deny'],
  ['sectionHead', 'unitAudit', 'G8-BUDGET', 'own subtree', 'allow'],
  ['sectionHead', 'unitAudit', 'CLR-4', 'outside subtree', 'deny'],
  ['admin', 'unitAudit', 'CLR-4', 'anywhere', 'allow'],

  // server-side export
  ['marine', 'exportUnit', 'G8-FMRAC', 'no EXPORT_DATA', 'deny'],
  ['ncoic', 'exportUnit', 'G8-FMRAC', 'no EXPORT_DATA', 'deny'],
  ['sectionHead', 'exportUnit', 'CE-G8', 'own subtree', 'allow'],
  ['sectionHead', 'exportUnit', 'CLR-4', 'outside subtree', 'deny'],
  ['admin', 'exportUnit', 'CLR-4', 'anywhere', 'allow'],

  // unit creation
  ['marine', 'createUnit', 'G8-FMRAC', 'no MANAGE_UNITS', 'deny'],
  ['ncoic', 'createUnit', 'G8-FMRAC', 'no MANAGE_UNITS', 'deny'],
  ['sectionHead', 'createUnit', 'CE-G8', 'own subtree', 'allow'],
  ['sectionHead', 'createUnit', 'CLR-4', 'outside subtree', 'deny'],
  ['admin', 'createUnit', 'CLR-4', 'anywhere', 'allow'],
];

/* ── run ──────────────────────────────────────────────────────────── */

let pass = 0;
const failures = [];
for (const [actor, action, arg, relation, expected] of ROWS) {
  const res = await ACTIONS[action](tok[actor], arg);
  const allowed = res.status >= 200 && res.status < 300;
  const ok = expected === 'allow' ? allowed : !allowed;
  const label = `${actor.padEnd(11)} ${action.padEnd(13)} ${String(Array.isArray(arg) ? arg.join('@') : arg).padEnd(18)} ${relation.padEnd(28)} → expect ${expected}`;
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else {
    failures.push(label);
    console.log(`  FAIL  ${label} (got ${res.status}${res.body?.error ? `: ${res.body.error}` : ''})`);
  }
}

server.close();
try { rmSync(DB, { force: true }); rmSync(`${DB}-wal`, { force: true }); rmSync(`${DB}-shm`, { force: true }); } catch { /* ignore */ }

console.log(`\n${pass}/${ROWS.length} matrix rows hold`);
assert.equal(failures.length, 0, `matrix rows failed:\n${failures.join('\n')}`);
process.exit(0);
