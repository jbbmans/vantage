import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApp, enroll, today, PASSWORD, type TestApp } from './helpers.ts';
import { PLATFORM_ROLES, type PlatformRole } from '../../shared/permissions.ts';
import { openDatabase, metaSet, SCHEMA_VERSION, MIGRATION_CATALOG } from '../../server/db/index.ts';
import { loadRuntime, startSchedulers } from '../../server/app.ts';
import { backupHistory, recordBackup } from '../../server/services/backupLog.ts';
import { backupStatus, clearJobs, healthReport, jobStatus, migrationStatus, recordRelease, releaseHistory, trackedJob, versionStatus } from '../../server/services/operations.ts';
import { signInHealth } from '../../server/services/signInHealth.ts';
import { audit } from '../../server/services/audit.ts';
import type { AppContext } from '../../server/context.ts';

/**
 * The Vantage Administrator console's operations (Task 5, ADR-0011): health, build, schema and migrations, backups,
 * scheduled jobs, sign-in health, feature flags, controlled maintenance and the platform audit trail. Each is for the
 * staff roles that hold its permission, and none of it shows what a Unit Instance keeps.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let marine: Person;
const staff: Partial<Record<PlatformRole, Person>> = {};
const MARKER = 'ZEBRA-QUARTZ-4471';
const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;

async function staffMember(on: TestApp, owner: string, username: string, role: PlatformRole) {
  const person = await on.register(username);
  on.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  const granted = await on.call('POST', '/api/platform/staff', { token: owner, body: { user_id: person.id, role } });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  on.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  return { id: person.id, token: (await on.login(username)).body.token as string };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  staff.owner = op;
  staff.admin = await staffMember(app, op.token, 'vadmin', 'admin');
  staff.support = await staffMember(app, op.token, 'vsupport', 'support');
  staff.auditor = await staffMember(app, op.token, 'vauditor', 'auditor');
  marine = await app.register('opsmarine');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = await login('opsmarine');
});
after(async () => { await app.close(); });

test('every staff role opens the operations pages it may, and no Unit Manager or Marine opens any', async () => {
  const routes: Array<[string, string]> = [['/operations', 'platform.view'], ['/sign-in-health', 'platform.view'], ['/flags', 'platform.view'], ['/maintenance', 'platform.view'], ['/audit/export?format=json', 'platform.audit']];
  for (const role of Object.keys(staff) as PlatformRole[]) {
    for (const [path, needs] of routes) {
      const allowed = PLATFORM_ROLES[role].permissions.includes(needs as never);
      assert.equal((await get(staff[role]!.token, `/api/platform${path}`)).status, allowed ? 200 : 403, `${PLATFORM_ROLES[role].label} ${path}`);
    }
  }
  for (const [path] of routes) {
    const res = await get(marine.token, `/api/platform${path}`);
    assert.equal(res.status, 403, path);
    assert.equal(res.body.code, 'not_staff');
  }
  // Controlled maintenance is its own permission: Vantage Administrators hold it, support and auditors do not.
  assert.ok(PLATFORM_ROLES.admin.permissions.includes('platform.maintenance'));
  for (const role of ['support', 'auditor'] as const) {
    assert.equal((await post(staff[role]!.token, '/api/platform/maintenance', { enabled: true, reason: 'Trying to close the service' })).status, 403, role);
    assert.equal((await post(staff[role]!.token, '/api/platform/maintenance/tasks/database_check')).status, 403, role);
  }
});

test('the operations report covers health, build, schema, backups and jobs', async () => {
  const res = await get(op.token, '/api/platform/operations');
  assert.equal(res.status, 200);
  const { health, version, schema, backups, jobs } = res.body;
  assert.ok(['ok', 'warn', 'fail'].includes(health.status));
  const ids = health.checks.map((c: { id: string }) => c.id);
  for (const id of ['database', 'schema', 'audit_chain', 'audit_forwarding', 'backup', 'email', 'jobs']) assert.ok(ids.includes(id), id);
  assert.equal(health.checks.find((c: { id: string }) => c.id === 'audit_chain').status, 'ok');
  assert.equal(health.checks.find((c: { id: string }) => c.id === 'jobs').status, 'warn', 'the test server starts no scheduled jobs, and the check says so');
  assert.match(version.version, /^\d+\.\d+/);
  assert.ok(version.build);
  assert.equal(version.releases.length, 1, 'this database has served one build');
  assert.equal(schema.state, 'current');
  assert.equal(schema.database, SCHEMA_VERSION);
  assert.equal(schema.catalog.length, MIGRATION_CATALOG.length);
  assert.ok(schema.catalog.every((m: { applied: boolean; run: unknown }) => m.applied && m.run), 'a fresh database ran, and recorded, every migration');
  assert.equal(schema.historySince.schema, 0);
  assert.equal(backups.state, 'never');
  assert.deepEqual(jobs, []);
  // The overview carries the summary and points at this page.
  const overview = await get(op.token, '/api/platform/overview');
  assert.ok(overview.body.health.attention.some((c: { id: string }) => c.id === 'backup'), 'no backup is something to look at');
});

test('a database ahead of the build is flagged, and an older one records the migrations it ran', async () => {
  metaSet(app.ctx.db, 'schema_version', String(SCHEMA_VERSION + 1));
  try {
    const res = await get(op.token, '/api/platform/operations');
    assert.equal(res.body.schema.state, 'ahead');
    assert.equal(res.body.health.checks.find((c: { id: string }) => c.id === 'schema').status, 'warn');
  } finally { metaSet(app.ctx.db, 'schema_version', String(SCHEMA_VERSION)); }

  const dir = mkdtempSync(join(tmpdir(), 'vantage-ops-'));
  try {
    const path = join(dir, 'vantage.db');
    const seed = openDatabase(path);
    seed.prepare("UPDATE meta SET value = '17' WHERE key = 'schema_version'").run();
    seed.prepare("DELETE FROM meta WHERE key IN ('migration_history', 'migration_history_since')").run();
    seed.close();
    const db = openDatabase(path);
    const status = migrationStatus({ db } as AppContext);
    assert.equal(status.state, 'current');
    assert.deepEqual(status.historySince && status.historySince.schema, 17, 'the history says from which schema it was kept');
    const ran = status.catalog.filter((m) => m.run).map((m) => m.id);
    assert.deepEqual(ran, MIGRATION_CATALOG.filter((m) => m.id > 17).map((m) => m.id));
    assert.ok(status.catalog.filter((m) => m.id <= 17).every((m) => m.applied && !m.run), 'older migrations are applied, from before the history');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_action'").get(), '019 adds the audit action index');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backups taken on the server and through the browser are recorded, and an old one goes stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-backup-'));
  const path = join(dir, 'vantage.db');
  const fileApp = await startApp({ VANTAGE_DB: path });
  try {
    const owner = await fileApp.setupOperator();
    // npm run backup: the copy is made, and the live database records it.
    const dest = join(dir, 'copy.db');
    execFileSync(process.execPath, ['scripts/backup.ts', dest], { env: { ...process.env, VANTAGE_DB: path }, stdio: 'pipe' });
    assert.ok(statSync(dest).size > 0);
    const server = backupHistory(fileApp.ctx.db).at(-1)!;
    assert.equal(server.method, 'server');
    assert.equal(server.file, 'copy.db');
    assert.equal(server.by, null, 'whoever ran the script is not known to Vantage');
    assert.equal(backupStatus(fileApp.ctx).state, 'fresh');
    assert.equal(backupStatus(fileApp.ctx, Date.now() + 8 * 24 * 3_600_000).state, 'stale', 'a week and a day later it is overdue');

    // A download from the console is recorded with who took it; only those who hold backups or read the trail see the name.
    const download = await fileApp.call('GET', '/api/platform/backup', { token: owner.token, binary: true });
    assert.equal(download.status, 200);
    const ops = await fileApp.call('GET', '/api/platform/operations', { token: owner.token });
    assert.equal(ops.body.backups.last.method, 'browser');
    assert.equal(ops.body.backups.last.by, 'John Boletz');
    assert.equal(ops.body.backups.history.length, 2);
    const support = await staffMember(fileApp, owner.token, 'filesupport', 'support');
    const seen = await fileApp.call('GET', '/api/platform/operations', { token: support.token });
    assert.equal(seen.body.backups.last.by, null);
    assert.ok(seen.body.backups.history.every((b: { by: string | null }) => b.by === null));

    // Compacting needs a file and maintenance mode.
    assert.equal((await fileApp.call('POST', '/api/platform/maintenance/tasks/vacuum', { token: owner.token })).body.code, 'maintenance_required');
    assert.equal((await fileApp.call('POST', '/api/platform/maintenance', { token: owner.token, body: { enabled: true, reason: 'Compacting the database file' } })).status, 200);
    const vacuum = await fileApp.call('POST', '/api/platform/maintenance/tasks/vacuum', { token: owner.token });
    assert.equal(vacuum.status, 200);
    assert.equal(vacuum.body.ok, true);
    assert.match(vacuum.body.summary, /KB/);
    assert.equal((await fileApp.call('POST', '/api/platform/maintenance', { token: owner.token, body: { enabled: false } })).status, 200);
  } finally { await fileApp.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('controlled maintenance takes a reason, tells everyone else what and until when, and audits every step', async () => {
  const start = (token: string, body: Record<string, unknown>) => post(token, '/api/platform/maintenance', { enabled: true, ...body });
  assert.equal((await start(op.token, {})).status, 400, 'a reason is required');
  assert.equal((await start(op.token, { reason: 'short' })).status, 400, 'and says something');
  assert.equal((await start(op.token, { reason: 'Restoring last night’s backup', until: new Date(Date.now() - 60_000).toISOString() })).status, 400, 'an end in the past');
  assert.equal((await start(op.token, { reason: 'Restoring last night’s backup', until: new Date(Date.now() + 8 * 24 * 3_600_000).toISOString() })).status, 400, 'an end more than a week out');
  const turnedOn = await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { maintenance: true } });
  assert.equal(turnedOn.status, 400, 'settings no longer switch maintenance');
  assert.equal(turnedOn.body.code, 'use_maintenance');
  assert.equal(app.ctx.runtime.maintenance, false);

  const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const reason = `Restoring the database after a disk fault ${MARKER}`;
  const started = await start(staff.admin!.token, { reason, message: 'Vantage is being restored', until });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.maintenance, true);
  assert.equal(started.body.window.reason, reason);
  assert.equal(started.body.window.startedByName, 'Vadmin Marine');
  assert.equal((await start(op.token, { reason: 'Starting a second window' })).body.code, 'maintenance_on');

  // Everyone else is stopped with the message and the expected end; never the reason.
  const refused = await get(marine.token, '/api/records/activities');
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, 'maintenance');
  assert.match(refused.body.error, /^Vantage is being restored\. It is expected to end by /);
  const setup = await app.call('GET', '/api/auth/setup');
  assert.equal(setup.body.maintenance, true);
  assert.match(setup.body.maintenanceNotice.message, /Vantage is being restored/);
  assert.equal(setup.body.maintenanceNotice.until, until);
  assert.ok(!setup.text.includes(MARKER), 'the reason stays with Vantage staff');
  assert.equal((await get(op.token, '/api/records/activities')).status, 200, 'Vantage staff keep working');
  // The other staff are told; the one who started it is not.
  const told = (id: string) => app.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE '%closed Vantage for maintenance'").get(id) as { n: number };
  assert.equal(told(op.id).n, 1);
  assert.equal(told(staff.support!.id).n, 1);
  assert.equal(told(staff.admin!.id).n, 0);
  // Support and auditors see it, and cannot end it.
  const seen = await get(staff.support!.token, '/api/platform/maintenance');
  assert.equal(seen.body.maintenance, true);
  assert.equal(seen.body.window.reason, reason);
  assert.equal((await post(staff.support!.token, '/api/platform/maintenance', { enabled: false })).status, 403);

  const ended = await post(op.token, '/api/platform/maintenance', { enabled: false, note: 'Restore verified' });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.maintenance, false);
  assert.equal(ended.body.window, null);
  assert.equal((await get(marine.token, '/api/records/activities')).status, 200);
  const steps = app.ctx.db.prepare("SELECT action, detail FROM audit_log WHERE action IN ('maintenance_on', 'maintenance_off') ORDER BY seq").all() as Array<{ action: string; detail: string }>;
  assert.deepEqual(steps.map((s) => s.action), ['maintenance_on', 'maintenance_off']);
  assert.equal(steps[0].detail, `${reason}; expected end ${until}`);
  assert.match(steps[1].detail, /^after \d+ min; Restore verified$/);
  // Ending it again changes and records nothing.
  assert.equal((await post(op.token, '/api/platform/maintenance', { enabled: false })).status, 200);
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'maintenance_off'").get() as { n: number }).n, 1);
  // A window left behind in a saved runtime with maintenance off is dropped when it loads.
  metaSet(app.ctx.db, 'runtime', JSON.stringify({ ...app.ctx.runtime, maintenance: false, maintenanceWindow: started.body.window }));
  assert.equal(loadRuntime(app.ctx.db, app.ctx.config).maintenanceWindow, null);
  app.ctx.saveRuntime();
});

test('database tasks are an allowlist, and each run is audited', async () => {
  const before = (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'maintenance_task'").get() as { n: number }).n;
  const tasks = ['database_check', 'foreign_keys', 'checkpoint', 'optimize', 'prune_sessions', 'verify_integrity'];
  for (const task of tasks) {
    const res = await post(staff.admin!.token, `/api/platform/maintenance/tasks/${task}`);
    assert.equal(res.status, 200, `${task}: ${JSON.stringify(res.body)}`);
    assert.equal(typeof res.body.summary, 'string');
  }
  assert.equal((await post(op.token, '/api/platform/maintenance/tasks/database_check')).body.ok, true);
  assert.equal((await post(op.token, '/api/platform/maintenance/tasks/verify_integrity')).body.ok, true);
  for (const bad of ['drop_tables', '__proto__', 'constructor']) {
    const res = await post(op.token, `/api/platform/maintenance/tasks/${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.code, 'unknown_task');
  }
  const after = (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'maintenance_task'").get() as { n: number }).n;
  assert.equal(after - before, tasks.length + 2);
  const state = await get(op.token, '/api/platform/maintenance');
  assert.ok(state.body.history.some((h: { action: string; task: string }) => h.action === 'maintenance_task' && h.task === 'verify_integrity'));
});

test('feature flags say who changed them; a locked flag cannot be turned on and deployment flags are read-only', async () => {
  const res = await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { attachmentsEnabled: false } });
  assert.equal(res.status, 200);
  const change = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'edit_configuration' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
  assert.equal(change.detail, 'attachmentsEnabled: true → false', 'the trail keeps the value before and after');
  const flags = (await get(staff.auditor!.token, '/api/platform/flags')).body;
  const attachments = flags.runtime.find((f: { key: string }) => f.key === 'attachmentsEnabled');
  assert.equal(attachments.on, false);
  assert.equal(attachments.changedBy, 'John Boletz');
  assert.ok(flags.runtime.find((f: { key: string }) => f.key === 'aiEnabled').blockedBy, 'AI cannot run without a model key');
  assert.ok(flags.environment.some((f: { key: string }) => f.key === 'browserBackups'));
  assert.equal((await app.call('PUT', '/api/platform/runtime', { token: staff.auditor!.token, body: { attachmentsEnabled: true } })).status, 403, 'auditors read flags and change none');
  await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { attachmentsEnabled: true } });

  const mcen = await startApp({ VANTAGE_DEPLOYMENT_PROFILE: 'mcen', VANTAGE_SELF_REGISTRATION: '' });
  try {
    const setup = await mcen.call('POST', '/api/auth/setup', { headers: { 'x-vantage-consent': '1' }, body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' } });
    const report = (await mcen.call('GET', '/api/platform/flags', { token: setup.body.token })).body;
    for (const key of ['selfRegistration', 'selfServiceUnits']) {
      const flag = report.runtime.find((f: { key: string }) => f.key === key);
      assert.equal(flag.on, false, key);
      assert.match(flag.blockedBy, /On MCEN/, key);
    }
    assert.equal(report.environment.find((f: { key: string }) => f.key === 'publicSite').on, false);
    assert.equal(report.environment.find((f: { key: string }) => f.key === 'consentBanner').value, 'dod');
  } finally { await mcen.close(); }
});

test('sign-in health reads the revocation lists and CAs from their files, and fails an expired list', async () => {
  const fixtures = join(import.meta.dirname, '..', 'fixtures', 'cac-crl');
  const cac = await startApp({ CAC_MODE: 'direct', CAC_CA_BUNDLE: join(fixtures, 'ca.pem'), CAC_CRL_DIR: join(fixtures, 'crls') });
  try {
    const owner = await cac.setupOperator();
    const now = (await cac.call('GET', '/api/platform/sign-in-health', { token: owner.token })).body;
    assert.equal(now.cac.mode, 'direct');
    assert.equal(now.cac.crls.length, 1);
    assert.equal(now.cac.crls[0].issuer, 'Vantage Test CA');
    assert.equal(now.cac.crls[0].nextUpdate, '2046-09-27T03:21:22.000Z');
    assert.equal(now.cac.crls[0].status, 'ok');
    assert.equal(now.cac.cas[0].status, 'ok');
    assert.equal(now.checks.find((c: { id: string }) => c.id === 'cac_crl').status, 'ok');
    assert.equal(now.last24h.signIns.password, 1, 'the setup sign-in is counted by method');

    const soon = signInHealth(cac.ctx, Date.parse('2046-09-26T12:00:00Z'));
    assert.equal(soon.checks.find((c) => c.id === 'cac_crl')!.status, 'warn', 'a list within two days of its next update');
    const later = signInHealth(cac.ctx, Date.parse('2046-10-01T00:00:00Z'));
    assert.equal(later.checks.find((c) => c.id === 'cac_crl')!.status, 'fail', 'an expired list refuses every card it covers');
    assert.equal(later.checks.find((c) => c.id === 'cac_ca')!.status, 'fail', 'and so does an expired CA');
    assert.equal(healthReport(cac.ctx, Date.parse('2046-10-01T00:00:00Z')).status, 'fail', 'the service health carries it');
  } finally { await cac.close(); }

  // Lockouts and refusals are counted; nobody is named.
  await app.register('lockme');
  for (let i = 0; i < 3; i++) await app.login('lockme', 'not-the-password-at-all');
  const report = (await get(staff.support!.token, '/api/platform/sign-in-health')).body;
  assert.equal(report.last24h.lockouts, 1);
  assert.equal(report.lockout.lockedNow, 1);
  assert.equal(report.cac.mode, 'off');
  const text = JSON.stringify(report);
  for (const name of ['lockme', 'opsmarine', 'boletz', 'vadmin']) assert.ok(!text.includes(name), `${name} is not named`);
  assert.equal((await post(op.token, '/api/platform/sign-in-health/oidc-check')).body.code, 'oidc_off');
});

test('the platform audit trail filters, pages and exports on the server, and an export is itself audited', async () => {
  const first = (await get(staff.auditor!.token, '/api/platform/audit?limit=3')).body;
  assert.equal(first.rows.length, 3);
  assert.ok(first.chain.ok);
  assert.ok(first.actions.includes('login'));
  assert.equal(first.next, first.rows[2].seq);
  const second = (await get(staff.auditor!.token, `/api/platform/audit?limit=3&before=${first.next}`)).body;
  assert.ok(second.rows.every((r: { seq: number }) => r.seq < first.next), 'the next page is older');
  assert.equal(second.chain, null, 'the chain is verified on the first page only');
  assert.ok((await get(staff.auditor!.token, '/api/platform/audit?action=login')).body.rows.every((r: { action: string }) => r.action === 'login'));
  assert.ok((await get(staff.auditor!.token, '/api/platform/audit?q=maintenance')).body.rows.some((r: { action: string }) => r.action === 'maintenance_on'));
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  assert.equal((await get(staff.auditor!.token, `/api/platform/audit?from=${tomorrow}`)).body.rows.length, 0);
  assert.equal((await get(staff.auditor!.token, '/api/platform/audit?from=2026-13-45x')).status, 400);
  // Nothing an organization does internally is in the platform trail.
  assert.ok((await get(staff.auditor!.token, '/api/platform/audit?limit=1000')).body.rows.every((r: { org_id: string | null; unit_id: string | null }) => !r.org_id && !r.unit_id));

  // A cell a spreadsheet would run is written as text.
  audit(app.ctx, { actor_id: op.id, action: 'export_probe', entity: 'platform', detail: '=HYPERLINK("http://example.invalid","x")' });
  const csv = await get(staff.auditor!.token, '/api/platform/audit/export?format=csv&action=export_probe');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  assert.match(csv.headers.get('content-disposition') || '', /attachment; filename="vantage-platform-audit-/);
  const [header, row] = csv.text.trim().split('\r\n');
  assert.equal(header, '"seq","at","action","actor_username","actor_id","subject_username","subject_id","entity","entity_id","detail","ip","prev_hash","entry_hash"');
  assert.match(row, /,"'=HYPERLINK\(""http:\/\/example\.invalid"",""x""\)",/);
  const exported = app.ctx.db.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'platform_audit_exported' ORDER BY seq DESC LIMIT 1").get() as { actor_id: string; detail: string };
  assert.equal(exported.actor_id, staff.auditor!.id);
  assert.equal(exported.detail, '1 rows as csv; action=export_probe');
  const json = await get(staff.auditor!.token, '/api/platform/audit/export?format=json&action=export_probe');
  assert.equal(json.body.rows.length, 1);
  assert.equal((await get(staff.support!.token, '/api/platform/audit/export')).status, 403);
});

test('scheduled jobs are tracked: each run, each failure, and a job that stops running', async () => {
  const ctx = app.ctx;
  clearJobs(ctx);
  let fail = true;
  const run = trackedJob(ctx, 'probe', 'Probe job', 60_000, () => { if (fail) throw new Error('disk on fire'); });
  const warn = console.warn; console.warn = () => {};
  try { await run(); } finally { console.warn = warn; }
  let [job] = jobStatus(ctx);
  assert.equal(job.failures, 1);
  assert.equal(job.lastError, 'disk on fire');
  assert.equal(job.status, 'warn');
  fail = false;
  await run();
  [job] = jobStatus(ctx);
  assert.equal(job.runs, 2);
  assert.equal(job.consecutiveFailures, 0);
  assert.equal(job.status, 'ok');
  assert.equal(jobStatus(ctx, Date.now() + 5 * 60_000)[0].overdue, true, 'a job twice its interval late is overdue');
  clearJobs(ctx);

  const stop = startSchedulers(ctx);
  try {
    const names = jobStatus(ctx).map((j) => j.name);
    for (const name of ['sessions', 'expiries', 'mail_retry', 'case_anchor']) assert.ok(names.includes(name), name);
    assert.equal(healthReport(ctx).checks.find((c) => c.id === 'jobs')!.status, 'ok');
  } finally { stop(); clearJobs(ctx); }
});

test('each new build is recorded once in the release history', () => {
  const ctx = app.ctx;
  const before = releaseHistory(ctx).length;
  recordRelease(ctx, { build: 'build-a', client: null });
  recordRelease(ctx, { build: 'build-a', client: null });
  recordRelease(ctx, { build: 'build-b', client: 'client-b' });
  const history = releaseHistory(ctx);
  assert.equal(history.length, before + 2);
  assert.deepEqual(history.slice(-2).map((r) => r.build), ['build-a', 'build-b']);
  assert.equal(versionStatus(ctx).build, 'build-b');
  assert.equal(versionStatus(ctx).releases[0].build, 'build-b', 'newest first');
});

test('the overview names who was emailed only to staff who run email', async () => {
  app.ctx.db.prepare("INSERT INTO email_log (id, user_id, to_address, kind, subject, status, created_at) VALUES ('mail-probe', NULL, 'someone@example.mil', 'invite', 'Invitation', 'sent', ?)").run(new Date().toISOString());
  assert.ok((await get(op.token, '/api/platform/overview')).body.email.recent.some((m: { to_address: string }) => m.to_address === 'someone@example.mil'));
  for (const role of ['support', 'auditor'] as const) assert.deepEqual((await get(staff[role]!.token, '/api/platform/overview')).body.email.recent, [], role);
});

test('no operations page shows what a Unit Instance keeps', async () => {
  const created = await post(marine.token, '/api/records/activities', { title: `Reconciled ${MARKER} accounts`, notes: `Private notes ${MARKER}`, visibility: 'unit', date: today() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await post(marine.token, '/api/records/activities', { title: `My own ${MARKER}`, visibility: 'private', date: today() });
  // The reason given for an earlier maintenance window is the only place the marker belongs in the platform's views.
  for (const path of ['/overview', '/operations', '/sign-in-health', '/flags', '/audit?limit=1000', '/audit/export?format=json', '/orgs', '/staff', '/access']) {
    const res = await get(op.token, `/api/platform${path}`);
    assert.equal(res.status, 200, path);
    const text = res.text.replace(new RegExp(`Restoring the database after a disk fault ${MARKER}`, 'g'), '');
    assert.ok(!text.includes(MARKER), `${path} shows nothing a Unit Instance keeps`);
  }
});

test('the backup history lives in the database it describes, and keeps the last twenty', () => {
  // scripts/backup.ts records with the database helpers alone, without starting the application.
  const dir = mkdtempSync(join(tmpdir(), 'vantage-backuplog-'));
  try {
    const path = join(dir, 'vantage.db');
    openDatabase(path).close();
    const db = new Database(path);
    for (let i = 0; i < 25; i++) recordBackup(db, { method: 'server', bytes: i, by: null, file: `copy-${i}.db` });
    assert.equal(backupHistory(db).length, 20);
    assert.equal(backupHistory(db).at(-1)!.file, 'copy-24.db');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
