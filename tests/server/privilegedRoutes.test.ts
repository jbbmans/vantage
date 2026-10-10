import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';
import { DOWNLOAD_PATH, NOT_BULK, PRIVILEGED_ROUTERS, PRIVILEGED_ROUTES, type PrivilegedRoute } from '../../server/authz/privilegedRoutes.ts';
import { AUDIT_CATEGORIES, auditCategoryOf } from '../../shared/auditCatalog.ts';
import { ORG_PERMISSION_LIST, ORG_ROLES, PERMISSIONS, PLATFORM_PERMISSION_LIST } from '../../shared/permissions.ts';

/**
 * The privileged route inventory (ADR-0013) against the routers it describes: every change on the administration routers
 * and every bulk download is listed, nothing listed is gone, each names the permission and step-up the source applies and
 * audit actions the catalogue knows. Then every listed route is called as people who must not reach it, and nothing
 * changes.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

interface SourceRoute { method: string; path: string; routePath: string; file: string; router: string; text: string; stepUp: boolean }

/** Where each router is mounted, read from server/app.ts. */
function mounts(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of read('server/app.ts').matchAll(/app\.use\('([^']+)',\s*(\w+Router)\)/g)) out.set(m[2], m[1]);
  return out;
}

/**
 * Every route the routers declare. A route's text runs from its declaration to the next statement at the left margin,
 * which is how every router here is laid out, so it holds the route's guards and its handler and nothing after them.
 */
function sourceRoutes(): SourceRoute[] {
  const mounted = mounts();
  const out: SourceRoute[] = [];
  for (const name of readdirSync(join(ROOT, 'server/routes')).filter((f) => f.endsWith('.ts'))) {
    const file = `server/routes/${name}`;
    const src = read(file);
    for (const [, router] of src.matchAll(/export const (\w+) = Router\(\)/g)) {
      const mount = mounted.get(router);
      if (!mount) continue;
      // Step-up a router applies to everything declared after it, under a path or everywhere.
      const sudo = [...src.matchAll(new RegExp(`\\b${router}\\.use\\(([^\\n]*)`, 'g'))]
        .filter((m) => m[1].includes('requireSudo'))
        .map((m) => ({ at: m.index!, prefix: /^\s*'([^']*)'/.exec(m[1])?.[1] ?? '' }));
      for (const m of src.matchAll(new RegExp(`\\b${router}\\.(get|post|put|patch|delete)\\(\\s*'([^']*)'`, 'g'))) {
        const rest = src.slice(m.index!);
        const end = rest.slice(1).search(/\n(?=[^\s})\]])/);
        const text = end < 0 ? rest : rest.slice(0, end + 1);
        const routePath = m[2];
        const stepUp = /\brequireSudo\b/.test(text.split('wrap(')[0])
          || sudo.some((u) => u.at < m.index! && (!u.prefix || u.prefix === '/' || routePath === u.prefix || routePath.startsWith(`${u.prefix}/`)));
        out.push({ method: m[1].toUpperCase(), path: `${mount === '/' ? '' : mount}${routePath === '/' && mount !== '/' ? '' : routePath}`, routePath, file, router, text, stepUp });
      }
    }
  }
  return out;
}

const SOURCE = sourceRoutes();
const bySource = new Map(SOURCE.map((r) => [key(r), r]));
const sourceOf = (r: PrivilegedRoute) => bySource.get(key(r))!;

const sorted = (list: string[]) => [...list].sort();
function sameSet(actual: string[], expected: string[], what: string) {
  const missing = expected.filter((k) => !actual.includes(k));
  const stale = actual.filter((k) => !expected.includes(k));
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] }, `${what}: missing from server/authz/privilegedRoutes.ts, or listed there but not in the routers`);
}

test('the inventory covers the routers where server/app.ts mounts them', () => {
  const mounted = mounts();
  for (const r of PRIVILEGED_ROUTERS) {
    assert.equal(mounted.get(r.router), r.mount, `${r.router} is mounted at ${r.mount}`);
    assert.match(read(r.file), new RegExp(`export const ${r.router} = Router\\(\\)`), `${r.file} declares ${r.router}`);
  }
  assert.ok(SOURCE.length > 100, 'the scan reads the routers');
});

test('every change on the administration routers is listed, and nothing listed is gone', () => {
  const routers = new Set<string>(PRIVILEGED_ROUTERS.filter((r) => r.changes).map((r) => r.router));
  const changes = SOURCE.filter((r) => routers.has(r.router) && r.method !== 'GET').map(key);
  assert.equal(new Set(changes).size, changes.length, 'no route is declared twice');
  sameSet(PRIVILEGED_ROUTES.filter((r) => r.kind === 'change').map(key), changes, 'changes');
  for (const r of PRIVILEGED_ROUTES.filter((x) => x.kind === 'change')) assert.notEqual(r.method, 'GET', `${key(r)} is a change`);
});

test('every bulk download is listed, wherever it is mounted, and every excused one still exists', () => {
  const downloads = SOURCE.filter((r) => r.method === 'GET' && DOWNLOAD_PATH.test(r.path)).map(key);
  const excused = NOT_BULK.map(key);
  for (const k of excused) assert.ok(downloads.includes(k), `${k} is excused from the inventory but is not a download route any more`);
  sameSet(PRIVILEGED_ROUTES.filter((r) => r.kind === 'bulk').map(key), downloads.filter((k) => !excused.includes(k)), 'bulk downloads');
  for (const r of PRIVILEGED_ROUTES.filter((x) => x.kind === 'bulk')) assert.equal(r.method, 'GET', `${key(r)} is a download`);
  assert.equal(new Set(PRIVILEGED_ROUTES.map(key)).size, PRIVILEGED_ROUTES.length, 'no route is listed twice');
});

test('each entry names the permission and step-up the source applies', () => {
  const known = new Set<string>([
    ...PLATFORM_PERMISSION_LIST.map((p) => p.key), ...ORG_PERMISSION_LIST.map((p) => p.key), ...Object.keys(PERMISSIONS), 'unit_leader', 'self',
  ]);
  for (const r of PRIVILEGED_ROUTES) {
    const src = sourceOf(r);
    assert.ok(src, `${key(r)} is declared`);
    assert.ok(r.permission.length, `${key(r)} names who may call it`);
    for (const p of r.permission) assert.ok(known.has(p), `${key(r)}: ${p} is a permission`);
    assert.equal(r.stepUp, src.stepUp, `${key(r)}: step-up ${src.stepUp ? 'applies' : 'does not apply'} in ${src.file}`);
    // The console routers name their permission on the route itself: the entry says the same.
    const platform = /requirePlatform\('([^']+)'\)/.exec(src.text);
    if (src.router === 'platformRouter') assert.deepEqual(r.permission, [platform?.[1]], `${key(r)} requires ${platform?.[1]}`);
    const inOrg = /\binOrg\(([^)]*)\)/.exec(src.text);
    if (src.router === 'orgsRouter') assert.deepEqual(sorted([...r.permission]), sorted([...inOrg![1].matchAll(/'([^']+)'/g)].map((m) => m[1])), `${key(r)} requires ${inOrg?.[1]}`);
  }
  // Nothing on the administration routers is open to a person's own say, but joining with a code they hold.
  const selfOnly = PRIVILEGED_ROUTES.filter((r) => r.kind === 'change' && r.permission.includes('self')).map(key);
  assert.deepEqual(selfOnly, ['POST /api/org/join-codes/:code/join']);
});

test('every audit action listed is catalogued, and every action a route writes itself is listed', () => {
  for (const r of PRIVILEGED_ROUTES) {
    assert.ok(r.audit.length || r.note, `${key(r)} writes nothing to the audit trail; say why in its note`);
    for (const a of r.audit) {
      assert.ok(auditCategoryOf(a.action), `${key(r)}: ${a.action} is not in shared/auditCatalog.ts`);
      assert.ok(a.category && (AUDIT_CATEGORIES as readonly string[]).includes(a.category), `${key(r)}: ${a.action} has a category`);
    }
    assert.equal(new Set(r.audit.map((a) => a.action)).size, r.audit.length, `${key(r)} lists each action once`);
    // The literal actions in the route's own handler; those its services write are listed from reading them.
    const written = [...sourceOf(r).text.matchAll(/\baction:\s*([^\n]*?)(?=,\s*[a-z_]+\s*:)/g)].flatMap((m) => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]));
    for (const action of written) assert.ok(r.audit.some((a) => a.action === action), `${key(r)} writes ${action}, which its entry does not list`);
  }
  // The console's own callers seal what the Unit Instance routes write as unit administration as enterprise administration.
  const platformUnlock = PRIVILEGED_ROUTES.find((r) => key(r) === 'POST /api/platform/accounts/:userId/unlock')!;
  assert.deepEqual(platformUnlock.audit, [{ action: 'account_unlock', category: 'enterprise' }]);
  const orgUnlock = PRIVILEGED_ROUTES.find((r) => key(r) === 'POST /api/orgs/:orgId/members/:userId/unlock')!;
  assert.deepEqual(orgUnlock.audit, [{ action: 'account_unlock', category: 'unit' }]);
});

// ——— Runtime: people who must not reach these routes are refused, and nothing changes ———

let app: TestApp;
let op: { token: string; id: string };
let member: { token: string; id: string };
let auditor: { token: string; id: string };
const ids: Record<string, string> = {};

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  member = await app.register('rifleman');
  await enroll(app, op.token, 'G8', member.id);
  auditor = await app.register('inspector');
  await enroll(app, op.token, 'G8', auditor.id);
  const granted = await app.call('POST', '/api/orgs/G8/roles', { token: op.token, body: { user_id: auditor.id, role: 'auditor' } });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  // Things the unit routes look up before they decide, so each refusal is the authority check and not a missing row.
  const invite = await app.call('POST', '/api/org/units/G8/invites', { token: op.token, body: { first_name: 'Pending', last_name: 'Invitee' } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  ids.invite = invite.body.id;
  const code = await app.call('POST', '/api/org/units/G8/join-codes', { token: op.token, body: {} });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  ids.joinCode = code.body.id;
  // Enrolling and granting a role end the sessions they had; a fresh sign-in has confirmed it is them, as step-up asks.
  for (const [who, username] of [[member, 'rifleman'], [auditor, 'inspector']] as const) {
    const signedIn = await app.login(username);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    who.token = signedIn.body.token;
    assert.equal((await app.call('POST', '/api/auth/sudo', { token: who.token, body: { password: PASSWORD } })).status, 200);
  }
});

after(async () => { await app?.close(); });

/** The route's path with real ids where the unit routes look one up before deciding, and placeholders elsewhere. */
function urlFor(r: PrivilegedRoute): string {
  const params: Record<string, string> = {
    orgId: 'G8', unitId: 'G8', userId: op.id, roleId: 'G8:nco', role: 'admin', task: 'optimize', code: 'NOCODE',
    inviteId: ids.joinCode, id: r.path === '/api/org/invites/:id' ? ids.invite : 'none',
  };
  const path = r.path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? 'none'));
  // A report on somebody else: one's own is one's own to take.
  return r.permission.includes('self') && r.permission.length > 1 ? `${path}?user_id=${op.id}` : path;
}

/** Bodies that pass each unit route's validation, so the refusal is the authority check rather than a 400. */
const bodies = (): Record<string, unknown> => ({
  'POST /api/org/units': { name: 'Sweep Section', parent_id: 'G8' },
  'PUT /api/org/units/:unitId': { name: 'Renamed' },
  'POST /api/org/units/:unitId/owner': { user_id: op.id },
  'POST /api/org/units/:unitId/members': { user_id: op.id },
  'PUT /api/org/units/:unitId/members/:userId': { billet: 'Clerk' },
  'POST /api/org/units/:unitId/message': { subject: 'Formation', body: 'Formation at 0700.' },
  'POST /api/org/units/:unitId/members/:userId/move': { to: 'G8-ELSEWHERE' },
  'POST /api/org/units/:unitId/invites': { first_name: 'New', last_name: 'Join' },
  'POST /api/org/roles': { unit_id: 'G8', name: 'Sweep Role', position: 1, permissions: 0 },
  'PUT /api/org/roles/:roleId': { name: 'NCO' },
  'POST /api/org/team/:userId/roles': { role_id: 'G8:nco', unit_id: 'G8' },
  'PUT /api/org/team/:userId/profile': { first_name: 'Changed' },
  'POST /api/org/units/:unitId/join-codes': {},
});

/**
 * Everything the database holds but the record of the refusals themselves: the audit trail and its sealed head, the
 * authorization_denied product event each 403 counts, and the sessions, which note when they were last used.
 */
const REFUSAL_RECORDS: Record<string, string> = { meta: "key <> 'audit_head'", product_events: "name <> 'security.authorization_denied'" };
function snapshot(): Record<string, string> {
  const tables = (app.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('audit_log', 'sessions') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, JSON.stringify(app.ctx.db.prepare(`SELECT * FROM "${t}"${REFUSAL_RECORDS[t] ? ` WHERE ${REFUSAL_RECORDS[t]}` : ''}`).all())]));
}
/** The tables whose rows differ from a snapshot. */
const changedSince = (then: Record<string, string>) => {
  const now = snapshot();
  return Object.keys({ ...then, ...now }).filter((t) => then[t] !== now[t]);
};
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;

async function sweep(token: string | undefined, expect: (r: PrivilegedRoute, res: { status: number; body: { error?: string; code?: string } | null }) => void, only: (r: PrivilegedRoute) => boolean = () => true) {
  resetLimiters();
  const routes = PRIVILEGED_ROUTES.filter(only);
  const BODIES = bodies();
  for (const r of routes) {
    const res = await app.call(r.method, urlFor(r), { token, body: r.method === 'GET' ? undefined : (BODIES[key(r)] ?? {}) });
    expect(r, res);
  }
  return routes.length;
}

test('without a session every listed route answers 401, and nothing changes', async () => {
  const before = snapshot();
  const seq = lastSeq();
  const n = await sweep(undefined, (r, res) => assert.equal(res.status, 401, `${key(r)} answered ${res.status} ${JSON.stringify(res.body)}`));
  assert.equal(n, PRIVILEGED_ROUTES.length);
  assert.deepEqual(changedSince(before), []);
  assert.equal(lastSeq(), seq, 'a 401 writes nothing to the audit trail');
});

/** Routes a person may call on their own account alone: refused only without a session, checked above. */
const ownOnly = (r: PrivilegedRoute) => r.permission.length === 1 && r.permission[0] === 'self';

test('an ordinary member is refused on every listed route, and nothing changes but the record of the refusals', async () => {
  const before = snapshot();
  const seq = lastSeq();
  const n = await sweep(member.token, (r, res) => {
    // A Unit Instance the member holds no role in is not found rather than forbidden: its console is not theirs to learn of.
    const hidden = r.path.startsWith('/api/orgs/:orgId') && res.status === 404 && res.body?.error === 'No such Unit Instance.';
    assert.ok(res.status === 403 || hidden, `${key(r)} answered ${res.status} ${JSON.stringify(res.body)}`);
    assert.notEqual(res.body?.code, 'sudo_required', `${key(r)} was refused for step-up, not for authority`);
  }, (r) => !ownOnly(r));
  assert.equal(n, PRIVILEGED_ROUTES.length - PRIVILEGED_ROUTES.filter(ownOnly).length);
  assert.deepEqual(changedSince(before), []);
  const written = app.ctx.db.prepare('SELECT action, category, detail FROM audit_log WHERE seq > ? ORDER BY seq').all(seq) as Array<{ action: string; category: string; detail: string }>;
  assert.ok(written.length, 'the refusals are in the audit trail');
  for (const e of written) assert.equal(e.action, 'access_denied', `only refusals are written: ${JSON.stringify(e)}`);
  assert.ok(written.some((e) => e.category === 'enterprise' && e.detail.startsWith('POST /api/platform/')), 'a refusal at the Vantage Administrator console is enterprise administration');
  assert.ok(written.some((e) => e.category === 'unit' && e.detail.startsWith('POST /api/org/')), 'a refusal at a unit route is unit administration');
});

test('a Unit Auditor, a read-only Unit Instance role, is refused on every route beyond it, and nothing changes', async () => {
  const theirs = new Set<string>(ORG_ROLES.auditor.permissions);
  const before = snapshot();
  const n = await sweep(auditor.token, (r, res) => {
    assert.equal(res.status, 403, `${key(r)} answered ${res.status} ${JSON.stringify(res.body)}`);
    assert.notEqual(res.body?.code, 'sudo_required', `${key(r)} was refused for step-up, not for authority`);
  }, (r) => !ownOnly(r) && !r.permission.some((p) => theirs.has(p)));
  // The one listed route a Unit Auditor holds: the Unit Instance's trail as a file.
  assert.deepEqual(PRIVILEGED_ROUTES.filter((r) => r.permission.some((p) => theirs.has(p))).map(key), ['GET /api/orgs/:orgId/audit/export']);
  assert.ok(n > 80);
  assert.deepEqual(changedSince(before), []);
});
