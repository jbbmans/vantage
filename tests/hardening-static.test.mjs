import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const index = read('server/index.js');
const auth = read('server/auth.js');
const lifecycle = read('server/lifecycle.js');
const dbSource = read('server/db.js');
const permissions = read('server/permissions.js');
const instance = read('server/instance.js');
const api = read('src/lib/api.js');
const store = read('src/store/useStore.js');
const drafts = read('src/lib/drafts.js');
const sheets = read('src/lib/sheets.js');
const delimited = read('src/lib/delimited.js');
const pkg = JSON.parse(read('package.json'));
const { passwordProblem } = await import('../server/passwordPolicy.js');
const { hashPassword, verifyPassword, sessionDigest } = await import('../server/auth.js');

const checks = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
  console.log(`  ok    ${name}`);
};

check('production login does not return a JavaScript-readable session token', () => {
  assert.ok(index.includes("process.env.VANTAGE_TEST === '1'"));
  assert.ok(!/res\.json\(\s*\{\s*token\b/.test(index));
  assert.ok(!/authorization\s*:\s*`Bearer/.test(api));
});

check('test-only bearer authentication is rejected in production', () => {
  assert.ok(index.includes("if (PRODUCTION && process.env.VANTAGE_TEST === '1')"));
});

check('every explicit authenticated mutation retains the CSRF-capable auth middleware', () => {
  const exempt = new Set(['/api/setup', '/api/register', '/api/login', '/api/auth/cac-piv']);
  for (const line of index.split('\n')) {
    const match = line.match(/app\.(post|put|delete)\('([^']+)'/);
    if (!match || exempt.has(match[2])) continue;
    assert.ok(line.includes(', auth,'), `missing auth middleware: ${line.trim()}`);
  }
});

check('session credentials are digested before SQLite lookup and storage', () => {
  assert.ok(auth.includes('const digest = sessionDigest(token)'));
  assert.ok(auth.includes('digest, userId'));
  assert.ok(auth.includes('.get(digest)'));
  assert.match(sessionDigest('raw-browser-credential'), /^[a-f0-9]{64}$/);
  assert.notEqual(sessionDigest('raw-browser-credential'), 'raw-browser-credential');
});

check('every account-wide lifecycle route requires the Instance Operator', () => {
  for (const suffix of ['deactivate', 'reactivate', 'password', 'logout']) {
    assert.match(index, new RegExp(`app\\.post\\('/api/team/:id/${suffix}', auth, operatorGate\\(db\\)`));
  }
  assert.match(index, /app\.get\('\/api\/team\/:id\/access', auth, operatorGate\(db\)/);
  assert.ok(lifecycle.includes('canAdministerAccount(db, actor, target)'));
});

check('operator identity cannot be minted through a case-variant username', () => {
  assert.ok(dbSource.includes('username       TEXT NOT NULL COLLATE NOCASE UNIQUE'));
  assert.ok(dbSource.includes('idx_users_username_nocase'));
  assert.ok(index.includes('normalizeUsername(username)'));
  assert.ok(index.includes('username = ? COLLATE NOCASE'));
  assert.ok(instance.includes('VANTAGE_OPERATOR_ID'));
  assert.match(index, /app\.post\('\/api\/team', auth, operatorGate\(db\)/);
});

check('role grants are unit-consistent after migration and at the database boundary', () => {
  assert.ok(dbSource.includes('009_canonical_usernames_and_role_unit_integrity'));
  assert.ok(dbSource.includes('member_roles_unit_match_insert'));
  assert.ok(dbSource.includes('role and grant unit mismatch'));
  assert.ok(permissions.includes('r.unit_id = mr.unit_id'));
});

check('top-level organization creation is not self-service', () => {
  const route = index.slice(index.indexOf("app.post('/api/org/units'"), index.indexOf("app.put('/api/org/units"));
  assert.ok(route.includes('isInstanceOperator(req.user)'));
  assert.ok(route.includes('isBootstrapOperator(db, req.user)'));
  assert.ok(route.includes("code: 'not_operator'"));
});

check('member detail reads require unit visibility in an authorized shared unit', () => {
  const route = index.slice(index.indexOf("app.get('/api/team/:id'"), index.indexOf("app.post('/api/team'"));
  assert.ok(route.includes("visibility = 'unit'"));
  assert.ok(route.includes('detailUnits'));
  assert.ok(!route.includes("visibility <> 'private'"));
});

check('record updates write visibility and unit as one validated pair', () => {
  assert.ok(index.includes("sets.push('visibility = ?', 'unit_id = ?')"));
  assert.ok(index.includes("const finalUnit = finalVisibility === 'personal' ? null : requestedUnit"));
});

check('former members cannot mutate shared originating-unit records', () => {
  assert.ok(permissions.includes("return Boolean(row.unit_id && isMember(db, user.id, row.unit_id))"));
  assert.ok(dbSource.includes("frozen_reason = 'membership removed from originating unit'"));
  assert.ok(lifecycle.includes('freezeMemberUnitRecords(targetId, oldUnit)'));
});

check('unit-shared reads require VIEW_RECORDS and roster projections are bounded', () => {
  const visibility = permissions.slice(permissions.indexOf('export function visibilityClause'), permissions.indexOf('/** Can this user act'));
  assert.ok(visibility.includes('scopeUnitIds'));
  assert.ok(!visibility.includes('unitIds'));
  assert.ok(index.includes('sharedAssignment?.get(row.id, ...allowedUnits)'));
  assert.ok(index.includes('row.username = null'));
});

check('membership changes require independent authority and revoke affected sessions', () => {
  assert.ok(index.includes("code: 'self_membership_change'"));
  assert.ok(index.includes("code: 'hierarchy'"));
  assert.ok(index.includes('revokePrivilegeSessions([userId])'));
  assert.ok(lifecycle.includes('invalidateUserSessions(db, targetId)'));
});

check('browser state and sensitive drafts are cleared at identity boundaries', () => {
  assert.ok(store.includes('function clearUserState()'));
  assert.ok(store.includes("identity.user.id !== nextIdentity?.user?.id"));
  assert.ok(api.includes('clearSensitiveDrafts()'));
  assert.ok(drafts.includes("const PREFIX = 'vantage.draft.'"));
  assert.ok(!/catch\s*\{\s*\/\* already gone \*\//.test(api));
});

check('the vulnerable XLSX parser is absent and CSV export neutralizes formulas', () => {
  assert.equal(pkg.dependencies.xlsx, undefined);
  assert.ok(!/import\(['"]xlsx['"]\)/.test(sheets));
  assert.ok(delimited.includes('[=+\\-@]'));
  assert.ok(delimited.includes('MAX_IMPORT_ROWS = 500'));
});

check('production first-run setup needs a deployment secret', () => {
  assert.ok(index.includes('VANTAGE_SETUP_TOKEN'));
  assert.ok(index.includes('timingSafeEqual'));
});

check('single-factor local passwords use the 15-character floor and a blocklist', () => {
  assert.match(passwordProblem('too-short'), /15/);
  assert.match(passwordProblem('correct-horse-battery-staple'), /common|predictable/);
  assert.match(passwordProblem('passwordpassword1'), /common|predictable/);
  assert.match(passwordProblem('marinecorps2026'), /common|predictable/);
  assert.equal(passwordProblem('cobalt-orbit-velvet-anchor-927'), null);
  const stored = hashPassword('cobalt-orbit-velvet-anchor-927');
  assert.equal(verifyPassword('cobalt-orbit-velvet-anchor-927', stored), true);
  assert.equal(verifyPassword('cobalt-orbit-velvet-anchor-928', stored), false);
});

check('sensitive API responses are explicitly non-cacheable', () => {
  assert.ok(index.includes("'Cache-Control', 'no-store, max-age=0'"));
});

console.log(`\n${checks.length}/${checks.length} hardening invariants hold`);
