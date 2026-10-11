import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { loadConfig } from '../../server/config.ts';
import { createContext, startSchedulers } from '../../server/app.ts';
import { anchorAuditChainIfChanged, auditHead, lastAuditAnchor, verifyAuditChain } from '../../server/services/audit.ts';
import { clearJobs, jobStatus, recordRelease } from '../../server/services/operations.ts';
import { auditAppendOnlyTriggers, metaGet, metaSet, MIGRATION_CATALOG, SCHEMA_VERSION } from '../../server/db/index.ts';
import { totpCode } from '../../server/auth/totp.ts';
import type { AppContext } from '../../server/context.ts';

/**
 * What the audit trail covers (ADR-0013, Task 7): the chain's head anchored and checked against a copy kept off the
 * host, and the entries the spec asks for: deployments, migrations, owners named in the configuration, failed sign-ins,
 * refusals at the administration routes, counseling amendments, role changes and restores.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let marine: Person;
let support: Person;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const last = (action: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action) as Record<string, any> | undefined;
const count = (action: string) => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n;
const sudo = async (token: string) => assert.equal((await post(token, '/api/auth/sudo', { password: PASSWORD })).status, 200);

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  marine = await app.register('covmarine');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = (await app.login('covmarine')).body.token;
  const person = await app.register('covsupport');
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  assert.equal((await post(op.token, '/api/platform/staff', { user_id: person.id, role: 'support' })).status, 201);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  support = { id: person.id, token: (await app.login('covsupport')).body.token };
});
after(async () => { await app.close(); });

// ——— C. The external anchor ———

test('anchoring writes the chain’s head into the chain, and the integrity view shows it', async () => {
  const head = auditHead(app.ctx)!;
  const res = await post(op.token, '/api/platform/integrity/anchor');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.cases >= 0, 'the case histories are anchored as before');
  assert.equal(typeof res.body.audit.hash, 'string');
  assert.ok(res.body.audit.seq > head.seq, 'the anchor covers the request entry written just before it');
  const entry = last('audit_chain_anchored')!;
  assert.equal(entry.category, 'enterprise');
  assert.equal(entry.actor_id, op.id);
  assert.equal(entry.detail, `head seq ${res.body.audit.seq}, hash ${res.body.audit.hash}, ${res.body.audit.count} entries`);
  const anchored = app.ctx.db.prepare('SELECT entry_hash FROM audit_log WHERE seq = ?').get(res.body.audit.seq) as { entry_hash: string };
  assert.equal(anchored.entry_hash, res.body.audit.hash, 'the anchor names an entry the chain holds');

  const view = await get(op.token, '/api/platform/integrity');
  assert.equal(view.status, 200);
  assert.equal(view.body.audit.ok, true);
  assert.equal(view.body.head.seq, entry.seq, 'the head is now the anchor itself');
  assert.equal(view.body.head.count, view.body.audit.count);
  assert.deepEqual(
    { seq: view.body.lastAnchor.seq, hash: view.body.lastAnchor.hash, count: view.body.lastAnchor.count, by: view.body.lastAnchor.by },
    { seq: res.body.audit.seq, hash: res.body.audit.hash, count: res.body.audit.count, by: 'John Boletz' },
  );
});

test('the daily anchor runs only when something was written since the last one, and is a scheduled job', () => {
  const before = count('audit_chain_anchored');
  anchorAuditChainIfChanged(app.ctx);
  assert.equal(count('audit_chain_anchored'), before, 'nothing new since the last anchor: nothing written');
  recordRelease(app.ctx, { build: 'anchor-probe-build', client: null });
  const head = anchorAuditChainIfChanged(app.ctx);
  assert.ok(head);
  assert.equal(count('audit_chain_anchored'), before + 1);
  assert.equal(last('audit_chain_anchored')!.actor_id, null, 'the scheduled anchor has no actor');
  assert.equal(lastAuditAnchor(app.ctx)!.seq, head!.seq);

  clearJobs(app.ctx);
  const stop = startSchedulers(app.ctx);
  try { assert.ok(jobStatus(app.ctx).some((j) => j.name === 'audit_anchor')); } finally { stop(); clearJobs(app.ctx); }
});

test('a kept anchor is checked against the chain; every check is audited and a failed one tells the Lead Vantage Administrators', async () => {
  const anchor = lastAuditAnchor(app.ctx)!;
  const notices = () => (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'An audit anchor check failed'").get(op.id) as { n: number }).n;

  const good = await post(op.token, '/api/platform/integrity/verify', { seq: anchor.seq, entry_hash: anchor.hash.toUpperCase() });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  assert.equal(good.body.ok, true);
  assert.equal(good.body.entry, 'match');
  assert.equal(good.body.chain.ok, true);
  assert.match(last('audit_anchor_verified')!.detail, /the entry matches; chain intact/);
  assert.equal(last('audit_anchor_verified')!.category, 'enterprise');
  assert.equal(notices(), 0);

  const different = await post(op.token, '/api/platform/integrity/verify', { seq: anchor.seq, entry_hash: 'f'.repeat(64) });
  assert.equal(different.body.ok, false);
  assert.equal(different.body.entry, 'different');
  assert.match(last('audit_anchor_verified')!.detail, /a different hash/);
  assert.equal(notices(), 1);

  const missing = await post(op.token, '/api/platform/integrity/verify', { seq: 9_999_999, entry_hash: anchor.hash });
  assert.equal(missing.body.entry, 'missing');
  assert.equal(missing.body.ok, false);
  assert.equal(notices(), 2);

  for (const body of [{ seq: anchor.seq, entry_hash: 'not-a-hash' }, { seq: 0, entry_hash: anchor.hash }, { entry_hash: anchor.hash }]) {
    assert.equal((await post(op.token, '/api/platform/integrity/verify', body)).status, 400, JSON.stringify(body));
  }
  // Checking needs the platform audit trail's permission; support does not hold it.
  await sudo(support.token);
  assert.equal((await post(support.token, '/api/platform/integrity/verify', { seq: anchor.seq, entry_hash: anchor.hash })).status, 403);

  // An entry rewritten by somebody holding the database: the anchor still matches its own entry, the chain does not.
  const victim = app.ctx.db.prepare("SELECT seq, detail FROM audit_log WHERE action = 'setup'").get() as { seq: number; detail: string | null };
  app.ctx.db.exec('DROP TRIGGER audit_log_no_update');
  try {
    app.ctx.db.prepare("UPDATE audit_log SET detail = 'rewritten' WHERE seq = ?").run(victim.seq);
    const broken = await post(op.token, '/api/platform/integrity/verify', { seq: anchor.seq, entry_hash: anchor.hash });
    assert.equal(broken.body.entry, 'match');
    assert.equal(broken.body.chain.ok, false);
    assert.equal(broken.body.ok, false);
    assert.equal(notices(), 3);
    assert.match(last('audit_anchor_verified')!.detail, /chain broken/);
  } finally {
    app.ctx.db.prepare('UPDATE audit_log SET detail = ? WHERE seq = ?').run(victim.detail, victim.seq);
    auditAppendOnlyTriggers(app.ctx.db);
  }
  assert.equal(verifyAuditChain(app.ctx).ok, true, 'put back as it was');
});

test('an anchor goes off the host like every entry', async () => {
  const lines: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on('data', (c) => lines.push(c.toString('utf8'))); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const forwarded = await startApp({ VANTAGE_AUDIT_SYSLOG: `tcp://127.0.0.1:${(server.address() as { port: number }).port}` });
  try {
    const owner = await forwarded.setupOperator();
    const res = await forwarded.call('POST', '/api/platform/integrity/anchor', { token: owner.token });
    assert.equal(res.status, 200);
    const end = Date.now() + 3000;
    while (!lines.join('').includes('"action":"audit_chain_anchored"') && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    const text = lines.join('');
    assert.ok(text.includes(`head seq ${res.body.audit.seq}, hash ${res.body.audit.hash}`), 'the collector holds the anchored head');
    assert.ok(text.includes('"category":"enterprise"'));
  } finally {
    await forwarded.close();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ——— D. Coverage ———

test('a new release is audited once, and a restart of the same one is not', () => {
  const before = count('release_deployed');
  recordRelease(app.ctx, { build: 'coverage-build-1', client: 'client-1' });
  recordRelease(app.ctx, { build: 'coverage-build-1', client: 'client-1' });
  assert.equal(count('release_deployed'), before + 1);
  const entry = last('release_deployed')!;
  assert.equal(entry.category, 'enterprise');
  assert.match(entry.detail, /build coverage-build-1, client client-1; replaces .* build anchor-probe-build/);
  recordRelease(app.ctx, { build: 'coverage-build-2', client: null });
  assert.equal(count('release_deployed'), before + 2);
  // The test server's own start recorded the first release this database knows.
  assert.match((app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'release_deployed' ORDER BY seq LIMIT 1").get() as { detail: string }).detail, /the first release this database records/);
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-coverage-'));
  return { path: join(dir, 'vantage.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const contextFor = (path: string, env: Record<string, string> = {}) => createContext(loadConfig({
  NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: path, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_PUBLIC_URL: 'http://localhost:5173',
  VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', ...env,
} as NodeJS.ProcessEnv));
const migrated = (ctx: AppContext) => ctx.db.prepare("SELECT entity_id, detail, category FROM audit_log WHERE action = 'schema_migrated' ORDER BY seq").all() as Array<{ entity_id: string; detail: string; category: string }>;

test('a new database says which schema it was created at; each migration after is audited once, and restarts add nothing', () => {
  const file = scratch();
  try {
    const first = contextFor(file.path);
    assert.deepEqual(migrated(first).map((m) => m.entity_id), [String(SCHEMA_VERSION)]);
    assert.match(migrated(first)[0].detail, new RegExp(`^database created at schema ${SCHEMA_VERSION} \\(${MIGRATION_CATALOG.at(-1)!.name}\\)`));
    assert.equal(migrated(first)[0].category, 'enterprise');
    assert.equal(metaGet(first.db, 'migration_audited_through'), String(SCHEMA_VERSION));
    first.db.close();

    const restarted = contextFor(file.path);
    assert.equal(migrated(restarted).length, 1, 'a restart migrates nothing and audits nothing');
    // As a database a schema-20 build ran, before migrations were audited: 021 runs again on the next start.
    metaSet(restarted.db, 'schema_version', '20');
    restarted.db.prepare("DELETE FROM meta WHERE key = 'migration_audited_through'").run();
    restarted.db.close();

    const upgraded = contextFor(file.path);
    const entries = migrated(upgraded);
    assert.equal(entries.length, 2);
    assert.equal(entries[1].entity_id, '21');
    assert.match(entries[1].detail, /^021_audit_categories_and_append_only: schema 20 to 21 at \S+ in \d+ ms under /);
    assert.equal(metaGet(upgraded.db, 'migration_audited_through'), String(SCHEMA_VERSION));
    assert.equal(verifyAuditChain(upgraded).ok, true);
    upgraded.db.close();

    const again = contextFor(file.path);
    assert.equal(migrated(again).length, 2, 'audited once');
    again.db.close();
  } finally { file.done(); }
});

test('a database an older build left below schema 20 has every migration this start runs audited, not only 021', () => {
  for (const from of [18, 19]) {
    const file = scratch();
    try {
      const first = contextFor(file.path);
      // As a database a schema-18 or 19 build ran: it audited nothing, and its history says nothing of this build.
      metaSet(first.db, 'schema_version', String(from));
      first.db.prepare("DELETE FROM meta WHERE key IN ('migration_audited_through', 'migration_history')").run();
      first.db.close();

      const upgraded = contextFor(file.path);
      const entries = migrated(upgraded).slice(1);
      const ran = MIGRATION_CATALOG.filter((m) => m.id > from);
      assert.deepEqual(entries.map((e) => e.entity_id), ran.map((m) => String(m.id)), `from schema ${from}`);
      for (const [i, m] of ran.entries()) assert.match(entries[i].detail, new RegExp(`^${m.name}: schema ${m.id - 1} to ${m.id} at \\S+ in \\d+ ms under `));
      assert.equal(metaGet(upgraded.db, 'migration_audited_through'), String(SCHEMA_VERSION));
      assert.equal(verifyAuditChain(upgraded).ok, true);
      upgraded.db.close();
    } finally { file.done(); }
  }
});

test('an owner named in VANTAGE_PLATFORM_OWNERS is audited when the grant is made, not on every start', () => {
  const file = scratch();
  try {
    const first = contextFor(file.path);
    first.db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('owner-1', 'casey', '', 'Casey', 'Ward', '2026-10-01', '2026-10-01')").run();
    first.db.close();
    const named = contextFor(file.path, { VANTAGE_PLATFORM_OWNERS: 'Casey' });
    const entries = named.db.prepare("SELECT subject_id, actor_id, detail, category FROM audit_log WHERE action = 'platform_owner_configured'").all() as Array<Record<string, string | null>>;
    assert.deepEqual(entries, [{ subject_id: 'owner-1', actor_id: null, detail: 'casey is Lead Vantage Administrator (owner): named in VANTAGE_PLATFORM_OWNERS', category: 'enterprise' }]);
    assert.ok(named.db.prepare("SELECT 1 FROM platform_roles WHERE user_id = 'owner-1' AND role = 'owner'").get());
    named.db.close();
    const again = contextFor(file.path, { VANTAGE_PLATFORM_OWNERS: 'casey' });
    assert.equal((again.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'platform_owner_configured'").get() as { n: number }).n, 1);
    again.db.close();
  } finally { file.done(); }
});

test('a failed sign-in is audited against the account, and a name that matches none is recorded without it', async () => {
  const wrong = await app.login('covmarine', 'not-the-password-at-all');
  assert.equal(wrong.status, 401);
  const entry = last('login_failed')!;
  assert.deepEqual([entry.subject_id, entry.actor_id, entry.detail, entry.category], [marine.id, null, 'password', 'user']);
  assert.ok(entry.ip);

  const before = count('login_failed');
  const unknown = await app.login('nobody-by-this-name', 'whatever-they-typed');
  assert.equal(unknown.status, 401);
  assert.equal(count('login_failed'), before + 1);
  const anon = last('login_failed')!;
  assert.equal(anon.subject_id, null);
  assert.equal(anon.detail, 'password; no account has that name');
  assert.ok(!JSON.stringify(anon).includes('nobody-by-this-name'), 'the name typed is not recorded');
  assert.ok(!JSON.stringify(anon).includes('whatever-they-typed'));

  // A wrong second factor.
  const person = await app.register('covtotp');
  await sudo(person.token);
  const start = await post(person.token, '/api/me/mfa/totp/start');
  assert.equal((await post(person.token, '/api/me/mfa/totp/confirm', { code: totpCode(start.body.secret, Math.floor(Date.now() / 30000)) })).status, 200);
  const challenge = (await app.login('covtotp')).body.challenge;
  assert.equal((await app.call('POST', '/api/auth/login/mfa', { body: { challenge, code: '000000' } })).status, 401);
  const factor = last('login_failed')!;
  assert.deepEqual([factor.subject_id, factor.detail], [person.id, 'second factor']);
});

test('a refusal at the administration routes is audited once in ten minutes, never for a step-up or a 401', async () => {
  const denials = () => app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'access_denied' AND actor_id = ? ORDER BY seq").all(marine.id) as Array<Record<string, any>>;
  // Not signed in: 401, nothing written.
  assert.equal((await app.call('GET', '/api/platform/overview')).status, 401);
  // A Unit Auditor whose password confirmation from signing in has lapsed is asked to confirm it: a step-up, not a denial.
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: marine.id, role: 'auditor' })).status, 201);
  const auditor = (await app.login('covmarine')).body.token as string;
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL WHERE user_id = ?').run(marine.id);
  assert.equal((await get(auditor, '/api/orgs/G8/overview')).body.code, 'sudo_required');
  assert.equal(denials().length, 0);

  // The Vantage Administrator console: enterprise administration.
  const platform = await get(auditor, '/api/platform/overview');
  assert.equal(platform.status, 403);
  assert.equal((await get(auditor, '/api/platform/overview')).status, 403);
  let rows = denials();
  assert.equal(rows.length, 1, 'the same refusal again within ten minutes is not written twice');
  assert.equal(rows[0].category, 'enterprise');
  assert.equal(rows[0].detail, 'GET /api/platform/*: not_staff (/api/platform/overview)', 'the console’s own guard: its mount, and the address asked for');
  assert.equal(rows[0].org_id, null);

  // A Unit Instance's routes: unit administration, in that instance's trail too. A Unit Auditor changes no settings.
  await sudo(auditor);
  const instance = await app.call('PATCH', '/api/orgs/G8', { token: auditor, body: { name: 'Renamed by an auditor' } });
  assert.equal(instance.status, 403, JSON.stringify(instance.body));
  rows = denials();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].category, 'unit');
  assert.equal(rows[1].org_id, 'G8');
  assert.equal(rows[1].detail, 'PATCH /api/orgs/:orgId: org_permission', 'the route as declared, not the address with its ids');

  // A unit's routes.
  const role = await post(auditor, '/api/org/roles', { unit_id: 'G8', name: 'Shadow admin', position: 90, permissions: 1 });
  assert.equal(role.status, 403, JSON.stringify(role.body));
  rows = denials();
  assert.equal(rows.length, 3);
  assert.equal(rows[2].category, 'unit');
  assert.match(rows[2].detail, /^POST \/api\/org\/roles: /);
  assert.equal(verifyAuditChain(app.ctx).ok, true);
  assert.equal((await app.call('DELETE', `/api/orgs/G8/roles/${marine.id}/auditor`, { token: op.token })).status, 200);
  marine.token = (await app.login('covmarine')).body.token;
});

test('made-up addresses under a console’s own guard are one refusal, not one each, and the address is cut short', async () => {
  const prober = await app.register('covprober');
  const probes = () => (app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'access_denied' AND actor_id = ? ORDER BY seq").all(prober.id) as Array<{ detail: string }>).map((r) => r.detail);
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await get(prober.token, `/api/platform/x${i}${'a'.repeat(900)}`)).status, 403);
    assert.equal((await post(prober.token, `/api/platform/y${i}`)).status, 403);
  }
  const rows = probes();
  assert.equal(rows.length, 2, 'once per method in ten minutes, whatever the address');
  assert.equal(rows[0], `GET /api/platform/*: not_staff (/api/platform/x0${'a'.repeat(120 - '/api/platform/x0'.length)})`);
  assert.equal(rows[1], 'POST /api/platform/*: not_staff (/api/platform/y0)');
});

test('amending a counseling names the fields that changed, never what they say', async () => {
  const created = await post(op.token, '/api/records/counselings', { user_id: marine.id, type: 'monthly', date: '2026-09-01', summary: 'Solid month.', visibility: 'unit', unit_id: 'G8' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const edited = await app.call('PUT', `/api/records/counselings/${created.body.id}`, { token: op.token, body: { summary: 'SECRET-REVISION', goals_set: 'Lead the close-out', type: 'monthly' } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const entry = last('counseling_amended')!;
  assert.equal(entry.entity_id, created.body.id);
  assert.equal(entry.subject_id, marine.id);
  assert.equal(entry.category, 'user');
  assert.equal(entry.detail, 'counselor edit; changed: summary, goals_set', 'only the fields that changed, by name');
  assert.ok(!app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'edit' AND entity_id = ?").get(created.body.id), 'not the generic edit');
  assert.ok(!(app.ctx.db.prepare('SELECT detail FROM audit_log').all() as Array<{ detail: string | null }>).some((r) => r.detail?.includes('SECRET-REVISION')));
});

test('a unit role edit names the permissions added and removed; Unit Instance roles are named by key', async () => {
  const created = await post(op.token, '/api/org/roles', { unit_id: 'G8', name: 'Clerk', position: 20, permissions: 0 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(last('create_role')!.detail, /^Clerk; position 20; permissions: none$/);
  const res = await app.call('PUT', `/api/org/roles/${encodeURIComponent(created.body.id)}`, { token: op.token, body: { name: 'Senior clerk', position: 25, permissions: 1 | 2 } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const widened = last('edit_role')!.detail as string;
  assert.match(widened, /^Senior clerk; permissions added: \w+, \w+; removed: none; other changes: name \(was Clerk\), position 20 to 25; sessions revoked: \d+$/);
  await app.call('PUT', `/api/org/roles/${encodeURIComponent(created.body.id)}`, { token: op.token, body: { permissions: 2 } });
  assert.match(last('edit_role')!.detail, /^Senior clerk; permissions added: none; removed: \w+; other changes: none;/);

  const granted = await post(op.token, '/api/orgs/G8/roles', { user_id: marine.id, role: 'auditor' });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  assert.equal(last('org_role_granted')!.detail, 'auditor');
  assert.equal((await app.call('DELETE', `/api/orgs/G8/roles/${marine.id}/auditor`, { token: op.token })).status, 200);
  assert.equal(last('org_role_revoked')!.detail, 'auditor');
});

test('a restore names who ran it: the actor when the archive holds their account, by name when it does not', async () => {
  const archive = (await get(op.token, '/api/platform/export')).body;
  for (const keepImporter of [false, true]) {
    const fresh = await startApp();
    try {
      const importer = await fresh.setupOperator();
      const copy = structuredClone(archive);
      if (keepImporter) {
        const row = fresh.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(importer.id) as Record<string, unknown>;
        copy.tables.users.push({ ...row, username: 'restorer', email: null });
      }
      const res = await fresh.call('POST', '/api/platform/import', { token: importer.token, body: copy });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const entry = fresh.ctx.db.prepare("SELECT actor_id, detail, category FROM audit_log WHERE action = 'instance_import'").get() as { actor_id: string | null; detail: string; category: string };
      assert.equal(entry.category, 'enterprise');
      if (keepImporter) {
        assert.equal(entry.actor_id, importer.id);
        assert.match(entry.detail, new RegExp(`^by boletz \\(${importer.id}\\);`));
      } else {
        assert.equal(entry.actor_id, null);
        assert.match(entry.detail, new RegExp(`^by boletz \\(${importer.id}\\), whose account the archive does not hold;`));
      }
      assert.equal(verifyAuditChain(fresh.ctx).ok, true);
    } finally { await fresh.close(); }
  }
});

test('revoking an invitation is audited, as making one is', async () => {
  const invite = await post(op.token, '/api/org/units/G8/invites', { first_name: 'Pat', last_name: 'Doe' });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  assert.equal((await app.call('DELETE', `/api/org/invites/${invite.body.id}`, { token: op.token })).status, 200);
  const entry = last('invite_revoked')!;
  assert.deepEqual([entry.actor_id, entry.entity_id, entry.unit_id, entry.org_id, entry.category], [op.id, invite.body.id, 'G8', 'G8', 'unit']);
});
