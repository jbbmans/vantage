/**
 * Permission matrix (v3.3 finding 39, rewritten for v3.4).
 *
 * One table, read like the roadmap wrote it: role × unit relationship ×
 * action → allow/deny. The other suites attack specific mechanisms; this one
 * pins the whole grid, so a permission change that widens or narrows anyone's
 * reach fails loudly with the exact row that moved.
 *
 * ── What changed, and why the old rows are still here ──────────────
 *
 * v3.3's matrix encoded the model v3.4 removes. Rows like
 * "Section Head / own subtree / manage / allow" and "admin / anywhere / allow"
 * were correct then and are leaks now.
 *
 * The Regression Debt section is explicit that a security test must not be
 * deleted to make it pass, so every row whose expectation flipped carries its
 * v3.3 assertion inline as `was:` with the finding that changed it. That is
 * deliberate: a bare "deny" tells a future reader what the system does, while
 * "deny — was allow under finding 2" tells them it USED to do the opposite and
 * somebody decided otherwise. If a later change flips one back, the diff shows
 * a v3.3 expectation being restored, which is exactly the moment to stop.
 *
 * The two flips, in one sentence each:
 *
 *   Finding 2 — hierarchy conveys nothing. Every "own subtree → allow" row
 *   becomes deny. A section head reaches their own unit and no other.
 *
 *   Finding 4 — there is no cross-tenant superuser. Every "anywhere → allow"
 *   row becomes deny. The account that bootstrapped the install owns the unit
 *   it was created in, and is a stranger everywhere else.
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
process.env.VANTAGE_OPERATOR = 'boletz';

const { app } = await import('../server/index.js');

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
const must = (res, what) => {
  assert.ok(res.status >= 200 && res.status < 300, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

/* ── world ────────────────────────────────────────────────────────── */
/*
 * Four sovereign units. The org chart still says CE-G8 sits above G8-FMRAC and
 * G8-BUDGET, and that CLR-4 is elsewhere entirely — the fixture keeps that
 * shape precisely so the matrix can prove it buys nobody anything.
 *
 * Each unit has its own Owner and its own copied role set. Roles are addressed
 * as `${unitId}:${templateKey}`, which is what copyTemplateInto writes, and is
 * itself a useful assertion: if role ids were still global these would collide.
 */

must(await call('POST', '/api/setup', {
  body: { username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927', first_name: 'J', last_name: 'B', rank_id: 'Cpl', unit_code: 'CE-G8' },
}), 'setup');
const adminTok = await login('boletz', 'cobalt-orbit-velvet-anchor-927');

const createdIds = new Map();

/**
 * Create an identity, then attach it. Only the Instance Operator may create a
 * global account on somebody else's behalf; unit owners enroll an identity
 * that registered itself, which is the production onboarding flow.
 */
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

/** Operator claims a seeded unit for a named owner, giving it its own roles. */
const claim = async (unitId, ownerUsername, ownerId) => {
  must(await call('POST', `/api/org/units/${unitId}/claim`, {
    token: adminTok, body: { owner_user_id: ownerId, template_id: 'section' },
  }), `claim ${unitId} for ${ownerUsername}`);
};

// CE-G8: boletz owns it (bootstrap claimed it). hayes is its SNCOIC.
await mk(adminTok, 'hayes', 'CE-G8', 'CE-G8:sncoic', 'GySgt');

// The three other shops get their own owners.
const nguyenId = (await mk(adminTok, 'nguyen', 'CE-G8', null, 'Sgt')).id;
const budgetBossId = (await mk(adminTok, 'budgetboss', 'CE-G8', null, 'SSgt')).id;
const clrLeadId = (await mk(adminTok, 'clrlead', 'CE-G8', null, 'GySgt')).id;

await claim('G8-FMRAC', 'nguyen', nguyenId);
await claim('G8-BUDGET', 'budgetboss', budgetBossId);
await claim('CLR-4', 'clrlead', clrLeadId);

const tokNguyen = await login('nguyen', PW('nguyen'));
const tokBudget = await login('budgetboss', PW('budgetboss'));
const tokClr = await login('clrlead', PW('clrlead'));

// Members inside each shop, enrolled by that shop's own owner.
await mk(tokNguyen, 'ohara', 'G8-FMRAC', 'G8-FMRAC:nco', 'Cpl');
await mk(tokNguyen, 'rivera', 'G8-FMRAC');
/* A member who is never an actor. The manageMember probe forces a sign-out,
 * so aiming an ALLOW row at someone whose token later rows depend on makes the
 * matrix order-sensitive — a later row fails with 401 and looks like a
 * permission result when it is really a fixture artifact. Probes get their own
 * target. */
await mk(tokNguyen, 'probe', 'G8-FMRAC');
await mk(tokBudget, 'kramer', 'G8-BUDGET');
await mk(tokClr, 'zed', 'CLR-4');

const id = (u) => {
  const found = createdIds.get(u);
  assert.ok(found, `fixture missing ${u}`);
  return found;
};

const tok = {
  admin: adminTok,          // bootstrap account + Instance Operator, Owner of CE-G8
  sectionHead: await login('hayes', PW('hayes')),  // SNCOIC in CE-G8 only
  ncoic: tokNguyen,         // Owner of G8-FMRAC
  ftl: await login('ohara', PW('ohara')),          // NCO in G8-FMRAC
  marine: await login('rivera', PW('rivera')),     // Marine in G8-FMRAC
  clrLead: tokClr,          // Owner of CLR-4
};

const ownerTokenFor = { 'G8-FMRAC': tokNguyen, 'G8-BUDGET': tokBudget, 'CLR-4': tokClr, 'CE-G8': adminTok };

/* ── actions ──────────────────────────────────────────────────────── */

let seq = 0;
const ACTIONS = {
  readMember: (t, target) => call('GET', `/api/team/${id(target)}`, { token: t }),

  // was: visibility 'chain' — deleted in finding 3, so the shared tier is 'unit'
  createShared: (t, unit) => call('POST', '/api/activities', {
    token: t, body: { title: `Matrix ${seq += 1}`, date: '2026-08-10', visibility: 'unit', unit_id: unit },
  }),

  manageMember: (t, target) => call('POST', `/api/team/${id(target)}/logout`, { token: t }),

  /* Grants a role that BELONGS TO the target unit. In v3.3 this used one
   * org-wide "Wide Viewer" role for every row, which is no longer expressible
   * — roles.unit_id is NOT NULL (finding 1). */
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

  /* New in v3.4 (finding 5). v3.3 had no such row because the route refused
   * outright when parent_id was absent. */
  createTopLevelUnit: (t) => call('POST', '/api/org/units', {
    token: t, body: { name: `Sovereign Shop ${seq += 1}`, code: `SOV${seq}`, level: 'L4' },
  }),
};

/* ── the matrix ───────────────────────────────────────────────────── */
// [actor, action, argument, relationship, expected, was]

const ROWS = [
  /* read member detail */
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

  /* create a unit-visible record */
  ['marine', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['marine', 'createShared', 'G8-BUDGET', 'other unit', 'deny'],
  ['ftl', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['ftl', 'createShared', 'G8-BUDGET', 'other unit', 'deny'],
  ['ncoic', 'createShared', 'G8-FMRAC', 'own unit', 'allow'],
  ['ncoic', 'createShared', 'G8-BUDGET', 'other unit', 'deny'],
  ['sectionHead', 'createShared', 'G8-BUDGET', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'createShared', 'CLR-4', 'unrelated unit', 'deny'],
  ['admin', 'createShared', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],

  /* account-wide session control. Membership managers deliberately do NOT get
     this: the same account may belong to several sovereign units. */
  ['marine', 'manageMember', 'kramer', 'no permission', 'deny'],
  ['ftl', 'manageMember', 'rivera', 'own unit, no MANAGE_MEMBERS', 'deny'],
  ['ncoic', 'manageMember', 'probe', 'own unit manager, not operator', 'deny', 'allow — global-account finding'],
  ['ncoic', 'manageMember', 'kramer', 'other unit', 'deny'],
  ['sectionHead', 'manageMember', 'kramer', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['clrLead', 'manageMember', 'rivera', 'unrelated unit', 'deny'],
  ['admin', 'manageMember', 'zed', 'Instance Operator recovery action', 'allow'],

  /* grant a role */
  ['marine', 'grantRole', ['kramer', 'G8-BUDGET'], 'no permission', 'deny'],
  ['ftl', 'grantRole', ['rivera', 'G8-FMRAC'], 'own unit, no MANAGE_ROLES', 'deny'],
  ['ncoic', 'grantRole', ['rivera', 'G8-FMRAC'], 'own unit, is owner', 'allow'],
  ['sectionHead', 'grantRole', ['rivera', 'G8-FMRAC'], 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'grantRole', ['zed', 'CLR-4'], 'unrelated unit', 'deny'],
  ['clrLead', 'grantRole', ['zed', 'CLR-4'], 'own unit, is owner', 'allow'],
  ['clrLead', 'grantRole', ['rivera', 'G8-FMRAC'], 'unrelated unit', 'deny'],
  ['admin', 'grantRole', ['zed', 'CLR-4'], 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],

  /* unit audit log */
  ['marine', 'unitAudit', 'G8-FMRAC', 'no VIEW_AUDIT', 'deny'],
  ['ncoic', 'unitAudit', 'G8-FMRAC', 'own unit', 'allow'],
  ['ncoic', 'unitAudit', 'G8-BUDGET', 'other unit', 'deny'],
  ['sectionHead', 'unitAudit', 'G8-BUDGET', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['sectionHead', 'unitAudit', 'CE-G8', 'own unit', 'allow'],
  ['admin', 'unitAudit', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],

  /* server-side export */
  ['marine', 'exportUnit', 'G8-FMRAC', 'no EXPORT_DATA', 'deny'],
  ['ftl', 'exportUnit', 'G8-FMRAC', 'no EXPORT_DATA', 'deny'],
  ['sectionHead', 'exportUnit', 'CE-G8', 'own unit', 'allow'],
  ['sectionHead', 'exportUnit', 'G8-BUDGET', 'child unit', 'deny', 'allow (own subtree) — finding 2'],
  ['admin', 'exportUnit', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],

  /* sub-unit creation — still gated on MANAGE_UNITS in the named parent,
     because claiming to sit under someone is a statement about THEIR chart */
  ['marine', 'createSubUnit', 'G8-FMRAC', 'no MANAGE_UNITS', 'deny'],
  ['ftl', 'createSubUnit', 'G8-FMRAC', 'no MANAGE_UNITS', 'deny'],
  ['sectionHead', 'createSubUnit', 'CE-G8', 'own unit', 'allow'],
  ['sectionHead', 'createSubUnit', 'CLR-4', 'unrelated unit', 'deny'],
  ['admin', 'createSubUnit', 'CLR-4', 'unrelated unit', 'deny', 'allow (anywhere) — finding 4'],

  /* top-level organizations are instance inventory, not self-service tenants */
  ['marine', 'createTopLevelUnit', null, 'no roles anywhere', 'deny', 'allow — unrestricted creation finding'],
  ['ftl', 'createTopLevelUnit', null, 'NCO elsewhere', 'deny', 'allow — unrestricted creation finding'],
  ['clrLead', 'createTopLevelUnit', null, 'owner elsewhere', 'deny', 'allow — unrestricted creation finding'],
  ['admin', 'createTopLevelUnit', null, 'Instance Operator', 'allow'],
];

/* ── run ──────────────────────────────────────────────────────────── */

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
