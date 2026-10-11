import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, type TestApp } from './helpers.ts';
import { loadConfig } from '../../server/config.ts';
import { createContext } from '../../server/app.ts';
import { audit, verifyAuditChain } from '../../server/services/audit.ts';
import { auditAppendOnlyTriggers } from '../../server/db/index.ts';
import {
  AUDIT_ACTION_FAMILIES, AUDIT_CATALOG, AUDIT_CATALOG_GROUPS, AUDIT_CATEGORIES, LEGACY_AUDIT_ACTIONS, auditActionsIn, auditCategoryOf,
} from '../../shared/auditCatalog.ts';

/**
 * The audit catalogue (ADR-0013): every action the server and the scripts write has a category, and the catalogue
 * names nothing that nothing writes. Then what a category does once it is written: sealed into the chain, filtered on
 * the server, and exported with each entry.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = join(dir, name);
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (/\.(ts|mjs)$/.test(name)) out.push(path);
    }
  };
  walk('server');
  walk('scripts');
  return out;
}

/** The text from `open` (just past an opening bracket) to its matching close, skipping strings and template literals. */
function balanced(src: string, open: number): string {
  let depth = 1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(src, i); continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!depth) return src.slice(open, i); }
  }
  throw new Error('unbalanced');
}

/** The index of the quote that closes the string starting at `start`, through any `${…}` a template holds. */
function skipString(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (quote === '`' && src[i] === '$' && src[i + 1] === '{') { i += 2 + balanced(src, i + 2).length; continue; }
    if (src[i] === quote) return i;
  }
  throw new Error('unterminated string');
}

/** The value of the `action` property in an object literal's text: its expression up to the next top-level comma, or 'action' when shorthand. */
function actionExpression(body: string): string | null {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\'' || c === '"' || c === '`') { i = skipString(body, i); continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && body.startsWith('action', i) && /^(?:|.*,)$/s.test(body.slice(0, i).trimEnd()) && !/[\w$]/.test(body[i + 6] ?? '')) {
      let j = i + 6;
      while (/\s/.test(body[j] ?? '')) j++;
      if (body[j] === ',' || j >= body.length) return 'action';
      if (body[j] !== ':') continue;
      let k = j + 1; let d = 0;
      for (; k < body.length; k++) {
        const ch = body[k];
        if (ch === '\'' || ch === '"' || ch === '`') { k = skipString(body, k); continue; }
        if (ch === '{' || ch === '(' || ch === '[') d++;
        else if (ch === '}' || ch === ')' || ch === ']') d--;
        else if (ch === ',' && d === 0) break;
      }
      return body.slice(j + 1, k).trim();
    }
  }
  return null;
}

interface Site { file: string; line: number; expression: string }

/** Every call to audit() in the server and the scripts, with the expression its action is. */
function auditSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sources()) {
    const src = read(file);
    for (const m of src.matchAll(/\baudit\(\s*([\w.]+)\s*,\s*/g)) {
      const at = m.index! + m[0].length;
      const line = src.slice(0, m.index).split('\n').length;
      assert.equal(src[at], '{', `${file}:${line} passes audit() an entry the scan cannot read; write it as an object literal`);
      const expression = actionExpression(balanced(src, at + 1));
      assert.ok(expression, `${file}:${line} writes an audit entry with no action`);
      sites.push({ file, line, expression });
    }
  }
  return sites;
}

const literals = (expression: string) => [...expression.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
/** A literal, or a choice between literals (`a ? 'x' : 'y'`): nothing built. */
const isLiteralChoice = (expression: string) => !expression.includes('`') && literals(expression).length > 0
  && expression.replace(/'[a-z0-9_]+'/g, '').replace(/[\w.$!=&|()\s]+/g, '').replace(/[?:]/g, '') === '';

/** Where an action is built rather than written out, and the family of the catalogue that spells it out. */
const BUILT: Array<{ file: string; expression: string; family: keyof typeof AUDIT_ACTION_FAMILIES }> = [
  { file: 'server/routes/auth.ts', expression: 'action', family: 'sign_in' },
  { file: 'server/services/access.ts', expression: 'action', family: 'vantage_access' },
  { file: 'server/services/organizations.ts', expression: "`organization_${status === 'active' ? 'restored' : status}`", family: 'organization_status' },
  { file: 'server/services/unitConfig.ts', expression: '`${kind}_${action}`', family: 'unit_configuration' },
];

/** Each family as its source builds it, read from that source, so a family that falls out of step with it fails here. */
function familiesFromSource(): Record<keyof typeof AUDIT_ACTION_FAMILIES, string[]> {
  const auth = read('server/routes/auth.ts');
  const demo = read('server/routes/demo.ts');
  const signIn = new Set<string>([auth.match(/method: string, action = '([a-z_]+)'\)/)![1]]);
  for (const src of [auth, demo]) {
    for (const m of src.matchAll(/finishSignIn\(req, res, \w+, '[^']*'(?:, '([a-z_]+)')?\)/g)) signIn.add(m[1] ?? 'login');
    for (const m of src.matchAll(/openSession\(req, res, \w+, '[^']*', '([a-z_]+)'/g)) signIn.add(m[1]);
  }

  const access = read('server/services/access.ts');
  const vantage = new Set<string>();
  for (const m of access.matchAll(/record\(ctx, [^,]+, g, ([^\n]+?), (?:null|`|note|'unanswered)/g)) {
    if (m[1].includes('${status}')) {
      const status = access.match(/const status = (by === 'org' \? [^;]+);/)![1];
      // The values it can take, not the ones it is compared with: each literal that follows a ? or a :.
      for (const s of status.matchAll(/[?:]\s*'([a-z_]+)'/g)) vantage.add(`vantage_access_${s[1]}`);
    } else for (const a of literals(m[1])) vantage.add(a);
  }

  const orgs = read('server/services/organizations.ts');
  const statuses = literals(orgs.match(/status: ('active' \| [^;]+);/)![1]);
  const organization = statuses.map((s) => `organization_${s === 'active' ? 'restored' : s}`);

  const config = read('server/services/unitConfig.ts');
  const kinds = literals(config.match(/type Kind = ([^;]+);/)![1]);
  const steps = [...config.match(/const lifecycle = [^\n]+\n[^\n]+/)![0].matchAll(/'([a-z]+)' as const/g)].map((m) => m[1]);
  const unitConfiguration = kinds.flatMap((k) => steps.map((s) => `${k}_${s}`));

  return { sign_in: [...signIn], vantage_access: [...vantage], organization_status: organization, unit_configuration: unitConfiguration };
}

/** Every action the server and the scripts write. */
function writtenActions(): Set<string> {
  const written = new Set<string>();
  const families = familiesFromSource();
  for (const site of auditSites()) {
    if (isLiteralChoice(site.expression)) { for (const a of literals(site.expression)) written.add(a); continue; }
    const built = BUILT.find((b) => b.file === site.file && b.expression === site.expression);
    assert.ok(built, `${site.file}:${site.line} builds its audit action (${site.expression}); spell the family out in AUDIT_ACTION_FAMILIES and BUILT here`);
    for (const a of families[built.family]) written.add(a);
  }
  return written;
}

test('every action the server and the scripts write is catalogued, and the catalogue names nothing that nothing writes', () => {
  const written = writtenActions();
  assert.ok(written.size > 150, `the scan found the trail's actions (${written.size})`);
  const missing = [...written].filter((a) => !Object.hasOwn(AUDIT_CATALOG, a)).sort();
  assert.deepEqual(missing, [], 'add these to shared/auditCatalog.ts with their category');
  const unused = Object.keys(AUDIT_CATALOG).filter((a) => !written.has(a)).sort();
  assert.deepEqual(unused, [], 'nothing writes these: remove them, or move them to LEGACY_AUDIT_ACTIONS if old entries carry them');
  for (const a of Object.keys(LEGACY_AUDIT_ACTIONS)) {
    assert.ok(!written.has(a) && !Object.hasOwn(AUDIT_CATALOG, a), `${a} is written today, so it belongs in the catalogue, not among the legacy actions`);
  }
});

test('instance-operator grants an older build wrote read as enterprise administration, so the category filter finds them', () => {
  for (const action of ['grant_operator', 'revoke_operator']) {
    assert.equal(auditCategoryOf(action), 'enterprise', action);
    assert.ok(auditActionsIn('enterprise').includes(action), `${action} is matched by the Enterprise administration filter`);
    assert.ok(!auditActionsIn('unit').includes(action) && !auditActionsIn('user').includes(action));
  }
});

test('each family in the catalogue is the one its source builds', () => {
  const families = familiesFromSource();
  for (const [family, actions] of Object.entries(AUDIT_ACTION_FAMILIES)) {
    assert.deepEqual([...actions].sort(), [...families[family as keyof typeof families]].sort(), `${family} matches what its source writes`);
  }
});

test('an action has exactly one category, and every entry is written through audit()', () => {
  const seen = new Map<string, string>();
  for (const [category, actions] of Object.entries(AUDIT_CATALOG_GROUPS)) {
    for (const a of actions) {
      assert.ok(!seen.has(a), `${a} is listed under both ${seen.get(a)} and ${category}`);
      seen.set(a, category);
    }
  }
  assert.equal(seen.size, Object.keys(AUDIT_CATALOG).length);
  for (const category of AUDIT_CATEGORIES) assert.ok(auditActionsIn(category).length > 10, `${category} holds actions`);
  assert.equal(auditCategoryOf('temporary_password'), 'enterprise');
  assert.equal(auditCategoryOf('grant_role'), 'unit');
  assert.equal(auditCategoryOf('view_record'), 'user');
  assert.equal(auditCategoryOf('deactivate_member'), 'unit', 'an action only older entries carry still reads in a category');
  assert.equal(auditCategoryOf('no_such_action'), null);
  for (const file of sources()) {
    if (file === join('server', 'services', 'audit.ts')) continue;
    assert.doesNotMatch(read(file), /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+audit_log/i, `${file} writes to the audit log without audit()`);
  }
});

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => {
  app = await startApp();
  op = await app.setupOperator();
});
after(async () => { await app?.close(); });

const entry = (action: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action) as Record<string, unknown> & { seq: number };

test('an entry seals its category: the catalogue’s, or the one its caller names', async () => {
  audit(app.ctx, { actor_id: op.id, action: 'grant_role', unit_id: 'G8', detail: 'probe' });
  assert.equal(entry('grant_role').category, 'unit');
  audit(app.ctx, { actor_id: op.id, action: 'force_logout', category: 'enterprise', subject_id: op.id });
  assert.equal(entry('force_logout').category, 'enterprise', 'a platform caller seals enterprise on an action units share');
  assert.throws(() => audit(app.ctx, { action: 'never_catalogued' }), /not in shared\/auditCatalog\.ts/, 'the test suite refuses an uncatalogued action');
  assert.equal(verifyAuditChain(app.ctx).ok, true);

  // The category is in the hash: one changed afterwards no longer matches the chain.
  const sealed = entry('grant_role');
  app.ctx.db.exec('DROP TRIGGER audit_log_no_update');
  try {
    app.ctx.db.prepare("UPDATE audit_log SET category = 'enterprise' WHERE seq = ?").run(sealed.seq);
    const broken = verifyAuditChain(app.ctx);
    assert.equal(broken.ok, false);
    assert.match(String(broken.reason), new RegExp(String(sealed.id)));
    app.ctx.db.prepare("UPDATE audit_log SET category = 'unit' WHERE seq = ?").run(sealed.seq);
  } finally { auditAppendOnlyTriggers(app.ctx.db); }
  assert.equal(verifyAuditChain(app.ctx).ok, true);
});

test('in service an uncatalogued action is still recorded, without a category, said once in the log, and still verifies', () => {
  const ctx = createContext(loadConfig({
    ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
    VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_PUBLIC_URL: 'http://localhost:5173', VANTAGE_OPERATOR: '',
  } as NodeJS.ProcessEnv));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    assert.equal(ctx.config.test, false);
    audit(ctx, { action: 'from_a_newer_build', detail: 'one' });
    audit(ctx, { action: 'from_a_newer_build', detail: 'two', org_id: 'G8' });
    audit(ctx, { action: 'setup' });
    // After the entry a new database writes at start-up, naming the schema it was created at.
    const rows = ctx.db.prepare("SELECT action, category FROM audit_log WHERE action <> 'schema_migrated' ORDER BY seq").all() as Array<{ action: string; category: string | null }>;
    assert.deepEqual(rows.map((r) => r.category), [null, null, 'enterprise']);
    assert.equal(warnings.filter((w) => w.includes('from_a_newer_build')).length, 1, 'warned once per action, not on every entry');
    // An entry with no category hashes as every entry did before categories, with or without an organization.
    assert.equal(verifyAuditChain(ctx).ok, true);
  } finally {
    console.warn = warn;
    ctx.db.close();
  }
});

test('both trails filter by category on the server, an entry from before categories reads in its action’s, and the files carry it', async () => {
  // An entry written before categories: no category stored. (Its hash does not matter here; the filter is what is tested.)
  const at = new Date().toISOString();
  const legacy = app.ctx.db.prepare(`INSERT INTO audit_log (id, actor_id, action, entity, at, entry_hash) VALUES (?, ?, 'edit_configuration', 'platform', ?, 'x')`);
  legacy.run('legacy-enterprise', op.id, at);
  app.ctx.db.prepare(`INSERT INTO audit_log (id, actor_id, action, org_id, at, entry_hash) VALUES ('legacy-unit', ?, 'grant_role', 'G8', ?, 'x')`).run(op.id, at);

  const platform = (query: string) => app.call('GET', `/api/platform/audit?limit=1000${query}`, { token: op.token });
  const all = await platform('');
  assert.equal(all.status, 200, JSON.stringify(all.body));
  for (const row of all.body.rows) assert.ok(row.category === null || AUDIT_CATEGORIES.includes(row.category), 'every entry carries its category');
  assert.equal(all.body.rows.find((r: { id: string }) => r.id === 'legacy-enterprise').category, 'enterprise', 'an older entry reads in its action’s category');

  const enterprise = await platform('&category=enterprise');
  assert.equal(enterprise.status, 200);
  assert.ok(enterprise.body.rows.length > 0);
  assert.ok(enterprise.body.rows.every((r: { category: string }) => r.category === 'enterprise'));
  assert.ok(enterprise.body.rows.some((r: { id: string }) => r.id === 'legacy-enterprise'));
  const user = await platform('&category=user');
  assert.ok(user.body.rows.every((r: { category: string }) => r.category === 'user'));
  assert.ok(!user.body.rows.some((r: { id: string }) => r.id === 'legacy-enterprise'));
  assert.equal((await platform('&category=everything')).status, 400, 'a category that does not exist is refused');

  const instance = (query: string) => app.call('GET', `/api/orgs/G8/audit?limit=1000${query}`, { token: op.token });
  const unit = await instance('&category=unit');
  assert.equal(unit.status, 200, JSON.stringify(unit.body));
  assert.ok(unit.body.rows.length > 0);
  assert.ok(unit.body.rows.every((r: { category: string }) => r.category === 'unit'));
  assert.ok(unit.body.rows.some((r: { id: string }) => r.id === 'legacy-unit'));
  assert.ok(!(await instance('&category=user')).body.rows.some((r: { id: string }) => r.id === 'legacy-unit'));

  const csv = await app.call('GET', '/api/platform/audit/export?format=csv&category=enterprise&action=edit_configuration', { token: op.token });
  assert.equal(csv.status, 200);
  const [header, ...lines] = csv.text.trim().split('\r\n');
  assert.equal(header.split(',')[3], '"category"');
  assert.ok(lines.length >= 1 && lines.every((l) => l.includes('"edit_configuration","enterprise"')));
  const exported = entry('platform_audit_exported');
  assert.match(String(exported.detail), /category=enterprise/, 'the export’s own entry names the filter it used');
  assert.equal(exported.category, 'enterprise');

  const orgCsv = await app.call('GET', '/api/orgs/G8/audit/export?format=csv&category=unit', { token: op.token });
  assert.equal(orgCsv.status, 200);
  assert.match(orgCsv.text.split('\r\n')[0], /^"seq","at","action","category",.*"entity_id","unit_id","detail"/);
  assert.equal(entry('organization_audit_exported').category, 'unit');
});
