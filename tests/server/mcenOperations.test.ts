import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { PLATFORM_ROLES, ORG_ROLES, ORG_ROLE_KEYS, type PlatformRole, type OrgRole } from '../../shared/permissions.ts';
import { metaGet, metaSet, runMigrations, SCHEMA_VERSION } from '../../server/db/index.ts';
import { upgradeHistory } from '../../server/db/upgrades.ts';
import { auditUpgrades } from '../../server/services/recovery.ts';
import { instanceOperations } from '../../server/services/instanceOperations.ts';
import { recordBackup } from '../../server/services/backupLog.ts';
import { RESTORE_REVIEW_ACTIONS, restoreHistory } from '../../server/services/restoreLog.ts';
import { audit } from '../../server/services/audit.ts';
import { AUDIT_CATALOG } from '../../shared/auditCatalog.ts';
import { DATA_TRANSFERS, infrastructureBodyProblem, infrastructureFileProblem, dataExportProblem } from '../../shared/dataTransfer.ts';
import { VERSION } from '../../server/version.ts';

/**
 * MCEN operations (Task 8, ADR-0014): each Unit Instance's version, schema, last upgrade, upgrade status, health and
 * backup freshness; upgrades that count every Unit Instance's rows before and after; a restore that is privileged, done
 * on the host and audited; a database put back any other way noticed; features withheld from one Unit Instance; and
 * infrastructure backups kept apart from the data exports, which restore nothing.
 */

type Person = { token: string; id: string };
const SECRET = 'test-secret-test-secret-test-secret-1234';
let app: TestApp;
let op: Person & { unitId: string };
let marine: Person;
let g1lead: Person;
const staff: Partial<Record<PlatformRole, Person>> = {};
const org: Partial<Record<OrgRole, Person>> = {};
const call = (method: string, token: string, path: string, body?: unknown) => app.call(method, path, { token, body });
const get = (token: string, path: string) => call('GET', token, path);
const post = (token: string, path: string, body: unknown = {}) => call('POST', token, path, body);
const put = (token: string, path: string, body: unknown = {}) => call('PUT', token, path, body);
const login = async (on: TestApp, username: string) => (await on.login(username)).body.token as string;
const entries = (on: TestApp, action: string) => on.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<Record<string, any>>;
const notes = (on: TestApp, userId: string, url: string) => on.ctx.db.prepare('SELECT title, message, action_url FROM notifications WHERE user_id = ? AND action_url = ? ORDER BY created_at').all(userId, url) as Array<{ title: string; message: string }>;

async function staffMember(on: TestApp, owner: string, username: string, role: PlatformRole) {
  const person = await on.register(username);
  on.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  const granted = await on.call('POST', '/api/platform/staff', { token: owner, body: { user_id: person.id, role } });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  on.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  return { id: person.id, token: await login(on, username) };
}

async function orgRoleHolder(username: string, role: OrgRole) {
  const person = await app.register(username);
  await enroll(app, op.token, 'G8', person.id);
  const granted = await post(op.token, '/api/orgs/G8/roles', { user_id: person.id, role });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  return { id: person.id, token: await login(app, username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  staff.owner = op; org.owner = op;
  staff.admin = await staffMember(app, op.token, 'opsadmin', 'admin');
  staff.support = await staffMember(app, op.token, 'opssupport', 'support');
  staff.auditor = await staffMember(app, op.token, 'opsauditor', 'auditor');
  org.admin = await orgRoleHolder('opsum', 'admin');
  org.records = await orgRoleHolder('opsrec', 'records');
  org.auditor = await orgRoleHolder('opsaud', 'auditor');
  marine = await app.register('opsmarine2');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = await login(app, 'opsmarine2');
  g1lead = await app.register('opsg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login(app, 'opsg1lead');
});
after(async () => { await app.close(); });

const SERVICE_CHECKS = new Set(['service', 'status', 'leaders', 'upgrade', 'backup', 'email', 'restore']);

test('each Unit Instance’s operations: Vantage staff read every one, a Unit Instance’s roles read their own, nobody else any', async () => {
  for (const role of Object.keys(staff) as PlatformRole[]) {
    const res = await get(staff[role]!.token, '/api/platform/instances/operations');
    assert.equal(res.status, PLATFORM_ROLES[role].permissions.includes('platform.view') ? 200 : 403, PLATFORM_ROLES[role].label);
    // Restoring is Backups and recovery's: Lead Vantage Administrators only.
    assert.equal((await get(staff[role]!.token, '/api/platform/recovery')).status, PLATFORM_ROLES[role].permissions.includes('platform.data') ? 200 : 403, `${PLATFORM_ROLES[role].label} reads the restores`);
  }
  assert.equal((await get(marine.token, '/api/platform/instances/operations')).status, 403);
  assert.equal((await get(org.admin!.token, '/api/platform/instances/operations')).status, 403, 'a Unit Manager is not Vantage staff');

  const report = (await get(staff.auditor!.token, '/api/platform/instances/operations')).body;
  const ids = report.instances.map((i: { id: string }) => i.id);
  assert.ok(ids.includes('G8') && ids.includes('G1'));
  for (const instance of report.instances) {
    assert.equal(instance.version.version, VERSION);
    assert.deepEqual(instance.schema, { database: SCHEMA_VERSION, code: SCHEMA_VERSION, state: 'current' });
    assert.equal(instance.upgrade.state, 'current');
    assert.ok(['ok', 'warn', 'fail', 'info'].includes(instance.health.status));
    assert.ok(instance.health.checks.some((c: { id: string }) => c.id === 'service'));
  }
  assert.equal(report.summary.instances, report.instances.length);
  assert.equal(report.canReview, false, 'reviewing an upgrade takes Controlled maintenance');
  assert.equal((await get(staff.admin!.token, '/api/platform/instances/operations')).body.canReview, true);

  for (const role of ORG_ROLE_KEYS) {
    const mine = await get(org[role]!.token, '/api/orgs/G8/operations');
    assert.equal(mine.status, (ORG_ROLES[role].permissions as string[]).includes('org.view') ? 200 : 403, ORG_ROLES[role].label);
    assert.equal((await get(org[role]!.token, '/api/orgs/G1/operations')).status, 404, `${ORG_ROLES[role].label} in another Unit Instance`);
    // The service's own checks are Vantage staff's: a Unit Manager sees one status for it, and this Unit Instance's own.
    assert.ok(mine.body.health.checks.every((c: { id: string }) => SERVICE_CHECKS.has(c.id) || c.id.startsWith('flag_')), JSON.stringify(mine.body.health.checks));
  }
  assert.equal((await get(marine.token, '/api/orgs/G8/operations')).status, 404, 'a Marine holds no Unit Instance role');
});

test('backup freshness is each Unit Instance’s: whether the newest backup holds it, how old it is, and what it did since', async () => {
  const service = 'ok' as const;
  const g8 = () => instanceOperations(app.ctx, { service, orgId: 'G8' })[0];
  const seq = (app.ctx.db.prepare('SELECT MAX(seq) AS seq FROM audit_log').get() as { seq: number }).seq;
  recordBackup(app.ctx.db, { method: 'server', bytes: 4096, by: null, file: 'nightly.db', seq, audited: true });
  assert.equal(g8().backup.state, 'fresh');
  assert.equal(g8().backup.changesSince, 0);
  audit(app.ctx, { actor_id: op.id, action: 'grant_role', org_id: 'G8', detail: 'after the backup' });
  audit(app.ctx, { actor_id: op.id, action: 'grant_role', org_id: 'G8', detail: 'and again' });
  audit(app.ctx, { actor_id: op.id, action: 'grant_role', org_id: 'G1', detail: 'another Unit Instance' });
  assert.equal(g8().backup.changesSince, 2, 'only this Unit Instance’s entries since the backup');
  assert.ok(g8().health.checks.some((c) => c.id === 'backup' && c.status === 'ok' && /2 audited actions since/.test(c.summary)));
  const later = instanceOperations(app.ctx, { service, orgId: 'G8', at: Date.now() + 8 * 86_400_000 })[0];
  assert.equal(later.backup.state, 'stale', 'past VANTAGE_BACKUP_MAX_AGE_HOURS it is overdue');
  assert.equal(later.health.status, 'warn');

  // A Unit Instance created after the newest backup is in no backup yet.
  const lead = await app.register('opsg2lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-2', code: 'G2', owner_user_id: lead.id })).status, 201);
  const g2 = instanceOperations(app.ctx, { service, orgId: 'G2' })[0];
  assert.equal(g2.backup.state, 'not_yet');
  assert.equal(g2.backup.changesSince, null);
  assert.ok(g2.health.checks.some((c) => c.id === 'backup' && c.status === 'warn'));
  assert.equal(g2.upgrade.last, null, 'and it has been through no upgrade');
});

test('a schema upgrade counts every Unit Instance’s rows before and after; one that loses rows is audited, shown to both consoles and reviewed', async () => {
  for (const title of ['Budget Analyst', 'Budget Officer']) assert.equal((await post(org.admin!.token, '/api/orgs/G8/billets', { title })).status, 201);
  const before = upgradeHistory(app.ctx.db).length;
  // A migration that should not have, and does: it deletes one Unit Instance's billets.
  const record = runMigrations(app.ctx.db, [{ id: SCHEMA_VERSION, name: `${SCHEMA_VERSION}_test_drops_billets`, run: (db) => { db.prepare("DELETE FROM unit_billets WHERE org_id = 'G8'").run(); } }], SCHEMA_VERSION)!;
  assert.equal(record.status, 'changed');
  assert.ok(record.checked > 50, 'every table is counted');
  assert.deepEqual(record.service.map((c) => c.table), ['unit_billets']);
  assert.deepEqual(record.instances.map((i) => i.org_id), ['G8'], 'only the Unit Instance that lost rows');
  assert.equal(record.instances[0].changes[0].after, 0);
  assert.equal(upgradeHistory(app.ctx.db).length, before + 1);

  auditUpgrades(app.ctx);
  const lost = entries(app, 'upgrade_rows_lost');
  assert.equal(lost.length, 2, 'one for the service and one in the Unit Instance’s trail');
  assert.equal(lost[0].org_id, null);
  assert.match(lost[0].detail, /unit_billets 2 to 0/);
  assert.equal(lost[1].org_id, 'G8');
  assert.equal(lost[1].category, 'enterprise');
  auditUpgrades(app.ctx);
  assert.equal(entries(app, 'upgrade_rows_lost').length, 2, 'audited once');
  assert.equal(notes(app, staff.admin!.id, '/admin/instances').length, 1, 'Vantage staff are told');
  assert.equal(notes(app, op.id, '/console/operations').length, 1, 'and the Unit Instance’s Lead Unit Managers');
  assert.equal(notes(app, g1lead.id, '/console/operations').length, 0, 'not another Unit Instance’s');

  const mine = (await get(org.auditor!.token, '/api/orgs/G8/operations')).body;
  assert.equal(mine.upgrade.state, 'attention');
  assert.deepEqual(mine.upgrade.record.changes.map((c: { table: string }) => c.table), ['unit_billets']);
  assert.ok(mine.health.checks.some((c: { id: string; status: string }) => c.id === 'upgrade' && c.status === 'warn'));
  assert.equal((await get(g1lead.token, '/api/orgs/G1/operations')).body.upgrade.state, 'current', 'G-1 kept its rows');

  // Reviewing takes Controlled maintenance and says what was found.
  const path = `/api/platform/upgrades/${record.id}/review`;
  assert.equal((await post(staff.support!.token, path, { note: 'Looked at it and it is fine' })).status, 403);
  assert.equal((await post(staff.auditor!.token, path, { note: 'Looked at it and it is fine' })).status, 403);
  assert.equal((await post(org.admin!.token, path, { note: 'A Unit Manager reviewing it' })).status, 403);
  assert.equal((await post(staff.admin!.token, path, { note: 'short' })).status, 400);
  assert.equal((await post(staff.admin!.token, '/api/platform/upgrades/nope/review', { note: 'Looked at the counts' })).status, 404);
  const reviewed = await post(staff.admin!.token, path, { note: 'Restored the billets from the release notes' });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal((await post(staff.admin!.token, path, { note: 'Reviewing it a second time' })).status, 409);
  const review = entries(app, 'upgrade_reviewed');
  assert.deepEqual(review.map((e) => e.org_id), [null, 'G8'], 'in the platform trail and the Unit Instance’s');
  const after = (await get(org.admin!.token, '/api/orgs/G8/operations')).body;
  assert.equal(after.upgrade.state, 'current');
  assert.equal(after.upgrade.record.reviewed.byName, 'Opsadmin Marine');
  assert.equal(after.upgrade.record.reviewed.by, undefined, 'a Unit Manager sees who by name, never their account id');

  // A migration that declares the table it reshapes is not a loss.
  const reshaped = runMigrations(app.ctx.db, [{ id: SCHEMA_VERSION, name: `${SCHEMA_VERSION}_test_reshapes`, reshapes: ['unit_billets'], run: (db) => { db.prepare("DELETE FROM unit_billets WHERE org_id = 'G8'").run(); } }], SCHEMA_VERSION)!;
  assert.equal(reshaped.status, 'verified');
  // One that changes nothing is verified, audited as such, and has nothing to review.
  assert.equal((await post(org.admin!.token, '/api/orgs/G8/billets', { title: 'Comptroller' })).status, 201);
  const clean = runMigrations(app.ctx.db, [{ id: SCHEMA_VERSION, name: `${SCHEMA_VERSION}_test_noop`, run: () => {} }], SCHEMA_VERSION)!;
  assert.equal(clean.status, 'verified');
  auditUpgrades(app.ctx);
  assert.ok(entries(app, 'upgrade_verified').some((e) => /no table lost rows/.test(e.detail)));
  assert.equal((await post(staff.admin!.token, `/api/platform/upgrades/${clean.id}/review`, { note: 'Nothing to say about it' })).body.code, 'upgrade_verified');
});

test('a migration that fails is rolled back, recorded, audited and shown until reviewed', async () => {
  const at = metaGet(app.ctx.db, 'schema_version');
  assert.throws(() => runMigrations(app.ctx.db, [{ id: SCHEMA_VERSION + 1, name: `${SCHEMA_VERSION + 1}_test_breaks`, run: (db) => { db.exec("UPDATE units SET name = 'half done'"); throw new Error('no such column: imaginary'); } }], SCHEMA_VERSION), /imaginary/);
  assert.equal(metaGet(app.ctx.db, 'schema_version'), at, 'the schema stays where it was');
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM units WHERE name = 'half done'").get() as { n: number }).n, 0, 'and nothing it started is kept');
  const failed = upgradeHistory(app.ctx.db).at(-1)!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failed!.name, `${SCHEMA_VERSION + 1}_test_breaks`);
  auditUpgrades(app.ctx);
  assert.match(entries(app, 'upgrade_failed').at(-1)!.detail, /test_breaks failed .* rolled back; the database stayed at schema/);
  assert.equal((await get(op.token, '/api/orgs/G8/operations')).body.upgrade.state, 'failed');
  const report = (await get(staff.admin!.token, '/api/platform/instances/operations')).body;
  assert.equal(report.service.upgrades[0].id, failed.id, 'newest first');
  assert.equal((await post(staff.admin!.token, `/api/platform/upgrades/${failed.id}/review`, { note: 'Ran the previous build again; fixed in the next release' })).status, 200);
  assert.equal((await get(op.token, '/api/orgs/G8/operations')).body.upgrade.state, 'current');
});

test('migration 022 from schema 21: the instance flags table, a database id, and a verified upgrade audited at the start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-022-'));
  const path = join(dir, 'vantage.db');
  try {
    const first = await startApp({ VANTAGE_DB: path });
    await first.setupOperator();
    const id = metaGet(first.ctx.db, 'database_id');
    assert.match(id ?? '', /^[0-9a-f-]{36}$/, 'a new database is named');
    first.ctx.db.exec('DROP TABLE instance_feature_flags');
    metaSet(first.ctx.db, 'schema_version', '21');
    await first.close();

    const second = await startApp({ VANTAGE_DB: path });
    try {
      assert.equal(metaGet(second.ctx.db, 'schema_version'), String(SCHEMA_VERSION));
      assert.ok(second.ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance_feature_flags'").get());
      assert.equal(metaGet(second.ctx.db, 'database_id'), id, 'the name stays');
      const record = upgradeHistory(second.ctx.db).at(-1)!;
      assert.deepEqual([record.schema, record.status, record.audited], [{ from: 21, to: SCHEMA_VERSION }, 'verified', true]);
      assert.ok(record.migrations.includes(22));
      assert.equal(entries(second, 'upgrade_verified').length, 1);
    } finally { await second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Vantage Administrator withholds a feature from one Unit Instance, with a reason its Lead Unit Managers are told', async () => {
  const g8 = (flag: string) => `/api/platform/orgs/G8/features/${flag}`;
  assert.equal((await put(staff.support!.token, g8('attachments'), { withheld: true, reason: 'Support trying it' })).status, 403);
  assert.equal((await put(org.admin!.token, g8('attachments'), { withheld: true, reason: 'A Unit Manager trying it' })).status, 403);
  assert.equal((await put(staff.admin!.token, g8('attachments'), { withheld: true })).body.code, 'reason_required');
  assert.equal((await put(staff.admin!.token, g8('ai'), { withheld: true, reason: 'AI is service-wide only' })).status, 404, 'AI stays service-wide');
  assert.equal((await put(staff.admin!.token, '/api/platform/orgs/NOPE/features/attachments', { withheld: true, reason: 'No such Unit Instance' })).status, 404);

  // A record shared with G-8, and one of G-1's.
  const record = await post(marine.token, '/api/records/activities', { title: 'Attach the LOA', visibility: 'unit', unit_id: 'G8', date: '2026-07-01' });
  assert.equal(record.status, 201, JSON.stringify(record.body));
  const other = await post(g1lead.token, '/api/records/activities', { title: 'G-1 record', visibility: 'private', date: '2026-07-01' });
  assert.equal(other.status, 201);
  let n = 0;
  // A new file each time: the same one twice on a record is refused as a duplicate.
  const attach = (token: string, id: string) => app.call('POST', `/api/records/activities/${id}/attachments`, { token, raw: Buffer.from(`%PDF-1.4\n% ${(n += 1)}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': `loa-${n}.pdf` } });
  const first = await attach(marine.token, record.body.id);
  assert.equal(first.status, 201, `attachments run before: ${JSON.stringify(first.body)}`);

  const withheld = await put(staff.admin!.token, g8('attachments'), { withheld: true, reason: 'Paused while the records officer reviews a spillage' });
  assert.equal(withheld.status, 200, JSON.stringify(withheld.body));
  const entry = entries(app, 'instance_feature_withheld').at(-1)!;
  assert.equal(entry.org_id, 'G8');
  assert.match(entry.detail, /File attachments off for .*: Paused while/);
  assert.match(notes(app, op.id, '/console/operations').at(-1)!.title, /turned file attachments off/);

  const listed = await get(marine.token, `/api/records/activities/${record.body.id}/attachments`);
  assert.equal(listed.body.enabled, false);
  assert.equal(listed.body.attachments.length, 1, 'files already attached stay readable');
  const refused = await attach(marine.token, record.body.id);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'feature_withheld');
  assert.equal((await get(g1lead.token, `/api/records/activities/${other.body.id}/attachments`)).body.enabled, true, 'another Unit Instance keeps it');
  assert.equal((await attach(g1lead.token, other.body.id)).status, 201);

  const flags = (await get(staff.auditor!.token, '/api/platform/flags')).body.instances;
  assert.deepEqual(flags.withheld.map((w: { org_id: string; flag: string }) => `${w.org_id}:${w.flag}`), ['G8:attachments']);
  assert.deepEqual(flags.flags.map((f: { key: string }) => f.key), ['attachments', 'intake']);
  const mine = (await get(org.auditor!.token, '/api/orgs/G8/operations')).body;
  assert.equal(mine.flags[0].reason, 'Paused while the records officer reviews a spillage');
  assert.equal(mine.flags[0].set_by, undefined, 'the Unit Manager console names Vantage staff, never by account id');
  assert.ok(mine.health.checks.some((c: { id: string }) => c.id === 'flag_attachments'));

  // Spreadsheet intake, the same way.
  assert.equal((await put(staff.admin!.token, g8('intake'), { withheld: true, reason: 'Imports paused for the data call' })).status, 200);
  const upload = () => app.call('POST', '/api/work/sources', { token: op.token, raw: Buffer.from('Document,Description\nULO-1,Clear it\n'), headers: { 'content-type': 'text/csv', 'x-filename': 'work.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
  assert.equal((await upload()).body.code, 'feature_withheld');

  // Given back: the service's setting again, audited, and the Lead Unit Managers told.
  for (const flag of ['attachments', 'intake']) assert.equal((await put(staff.admin!.token, g8(flag), { withheld: false })).status, 200);
  assert.equal(entries(app, 'instance_feature_restored').length, 2);
  assert.match(entries(app, 'instance_feature_restored').at(-1)!.detail, /off since \d{4}-\d{2}-\d{2}: Imports paused/);
  assert.equal((await upload()).status, 201);
  assert.equal((await attach(marine.token, record.body.id)).status, 201);
  assert.equal((await put(staff.admin!.token, g8('intake'), { withheld: false })).status, 200, 'giving back what is not withheld changes nothing');
  assert.equal(entries(app, 'instance_feature_restored').length, 2);

  // Withholding never turns on what the service has off.
  assert.equal((await put(op.token, '/api/platform/runtime', { attachmentsEnabled: false })).status, 200);
  assert.equal((await get(g1lead.token, `/api/records/activities/${other.body.id}/attachments`)).body.enabled, false);
  assert.equal((await put(op.token, '/api/platform/runtime', { attachmentsEnabled: true })).status, 200);
});

test('no data import takes an infrastructure backup, and the service archive import takes no data export', async () => {
  const sqlite = Buffer.concat([Buffer.from('SQLite format 3\u0000'), Buffer.alloc(200)]);
  const archive = JSON.stringify({ format: 'vantage-instance/1', exported_at: '2026-10-01T00:00:00Z', tables: {} });
  assert.match(infrastructureFileProblem(sqlite)!, /database backup/);
  assert.match(infrastructureFileProblem(archive)!, /service archive/);
  assert.equal(infrastructureFileProblem('Name,Rank\nSmith,Cpl\n'), null);
  assert.equal(infrastructureFileProblem(Buffer.from('{"format":"vantage-unit-configuration/1"}')), null);
  assert.match(infrastructureBodyProblem({ format: 'vantage-instance/1' })!, /service archive/);
  assert.equal(infrastructureBodyProblem({ format: 'vantage-unit-configuration/1' }), null);
  assert.match(dataExportProblem({ format: 'vantage-personal/1' })!, /Personal export/);
  assert.equal(dataExportProblem({ format: 'vantage-instance/1' }), null);

  const refusals: Array<[string, () => Promise<{ status: number; body: any }>]> = [
    ['account roster', () => app.call('POST', '/api/orgs/G8/accounts/import', { token: op.token, raw: sqlite, headers: { 'content-type': 'application/octet-stream', 'x-vantage-filename': 'roster.xlsx' } })],
    ['personnel feed', () => app.call('POST', '/api/orgs/G8/personnel/sync', { token: op.token, raw: Buffer.from(archive), headers: { 'content-type': 'text/csv' } })],
    ['unit configuration', () => post(op.token, '/api/orgs/G8/configuration/import', JSON.parse(archive))],
    ['activities', () => post(marine.token, '/api/records/activities/import', { ...JSON.parse(archive), rows: [] })],
    ['spreadsheet intake', () => app.call('POST', '/api/work/sources', { token: op.token, raw: sqlite, headers: { 'content-type': 'text/csv', 'x-filename': 'vantage.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } })],
    ['saved email', () => app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw: sqlite, headers: { 'content-type': 'message/rfc822', 'x-unit-id': 'G8' } })],
  ];
  for (const [what, send] of refusals) {
    const res = await send();
    assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'infrastructure_file', what);
  }

  // The archive import is the service's; a Unit Instance's or a person's export is refused for what it is.
  for (const format of ['vantage-organization/1', 'vantage-unit-configuration/1', 'vantage-personal/1']) {
    const res = await post(op.token, '/api/platform/import', { format, tables: {} });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /data export .* not a backup/, format);
  }
  assert.equal(entries(app, 'instance_import').length, 0, 'nothing was imported');
});

/** Every route that writes a file out or takes one in, from the routers' own text. */
function transferRoutes() {
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  const mounts = new Map([...read('server/app.ts').matchAll(/app\.use\('([^']+)',\s*(\w+Router)\)/g)].map((m) => [m[2], m[1]]));
  const out: string[] = [];
  for (const name of readdirSync(new URL('../../server/routes', import.meta.url)).filter((f) => f.endsWith('.ts'))) {
    const src = read(`server/routes/${name}`);
    for (const [, router] of src.matchAll(/export const (\w+) = Router\(\)/g)) {
      const mount = mounts.get(router);
      if (!mount) continue;
      for (const m of src.matchAll(new RegExp(`\\b${router}\\.(get|post|put|patch|delete)\\(\\s*'([^']*)'`, 'g'))) out.push(`${m[1].toUpperCase()} ${mount}${m[2]}`);
    }
  }
  return out.filter((r) => /(export|import|backup|\.csv$|\.pdf$|\/csv$|\/pdf$|\/sync$|\/sources$|\/imports(\/preview)?$|export\.txt$)/.test(r) && !r.startsWith('GET /api/work/'));
}

/** Matched by the scan, and not a file of anyone's data. */
const NOT_TRANSFERS: Record<string, string> = {
  'GET /api/demo/sample.csv': 'a made-up sample for the demo, no one’s data',
  'POST /api/correspondence/connectors/:id/sync': 'reads a connected mailbox; no file comes in',
  'POST /api/platform/maradmins/sync': 'fetches public MARADMINs',
};

test('every bulk download and import is listed as an infrastructure backup or a data export, and only two are backups', () => {
  const routes = transferRoutes();
  const listed = DATA_TRANSFERS.flatMap((t) => t.routes);
  const missing = routes.filter((r) => !(r in NOT_TRANSFERS) && !listed.includes(r));
  const stale = listed.filter((r) => !routes.includes(r));
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] }, 'shared/dataTransfer.ts lists every one, and nothing that is not a route');
  assert.deepEqual(DATA_TRANSFERS.filter((t) => t.kind === 'infrastructure').map((t) => t.id), ['database_backup', 'service_archive']);
  // Every infrastructure route takes Backups and recovery.
  const platform = readFileSync(new URL('../../server/routes/platform.ts', import.meta.url), 'utf8');
  for (const route of DATA_TRANSFERS.filter((t) => t.kind === 'infrastructure').flatMap((t) => t.routes)) {
    const [method, path] = route.split(' ');
    assert.match(platform, new RegExp(`platformRouter\\.${method.toLowerCase()}\\('${path.replace('/api/platform', '')}', requirePlatform\\('platform\\.data'\\)`), route);
  }
});

test('every change a restore lists for review is in the audit catalog', () => {
  for (const action of RESTORE_REVIEW_ACTIONS) assert.ok(action in AUDIT_CATALOG, action);
});

// ——— The restore command, on a file database, as a host would run it ———

test('npm run restore is privileged, checked and audited; a database put back by hand is noticed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-restore-'));
  const path = join(dir, 'vantage.db');
  const backupFile = join(dir, 'nightly.db');
  const env = { ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: path, VANTAGE_SECRET: SECRET, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false' };
  const restore = (args: string[], extra: Record<string, string> = { VANTAGE_RESTORE: '1' }) => spawnSync(process.execPath, ['scripts/restore.ts', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const reason = ['--reason', 'Ransomware on the host; going back to last night'];
  let live: TestApp | null = await startApp({ VANTAGE_DB: path });
  const reopen = async () => { live = await startApp({ VANTAGE_DB: path }); return live; };
  const shut = async () => { await live?.close(); live = null; };
  try {
    const owner = await live.setupOperator();
    await staffMember(live, owner.token, 'filevadmin', 'admin');
    execFileSync(process.execPath, ['scripts/backup.ts', backupFile], { env, stdio: 'pipe' });
    const copy = new Database(backupFile, { readonly: true });
    const backedUp = (copy.prepare('SELECT MAX(seq) AS seq FROM audit_log').get() as { seq: number }).seq;
    copy.close();

    // After the backup: a new Unit Manager, which a restore undoes.
    const later = await live.register('fileum');
    await enroll(live, owner.token, 'G8', later.id);
    assert.equal((await live.call('POST', '/api/orgs/G8/roles', { token: owner.token, body: { user_id: later.id, role: 'admin' } })).status, 201);

    // Refused while the service has the database open.
    const busy = restore(['REPLACE-DATABASE', '--from', backupFile, '--by', 'boletz', ...reason]);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /Stop Vantage/);
    await shut();

    assert.match(restore(['REPLACE-DATABASE', '--from', backupFile, '--by', 'boletz', ...reason], {}).stderr, /Refusing: this replaces the whole database/, 'without VANTAGE_RESTORE=1');
    assert.match(restore(['--from', backupFile, '--by', 'boletz', ...reason]).stderr, /Refusing/, 'without the word that says so');
    assert.match(restore(['REPLACE-DATABASE', '--from', backupFile, '--by', 'boletz', '--reason', 'oops']).stderr, /--reason is required/);
    assert.match(restore(['REPLACE-DATABASE', '--from', backupFile, '--by', 'filevadmin', ...reason]).stderr, /not an active Lead Vantage Administrator/, 'a Vantage Administrator does not authorize one');
    assert.match(restore(['REPLACE-DATABASE', '--from', join(dir, 'missing.db'), '--by', 'boletz', ...reason]).stderr, /No backup at/);

    const count = () => { const db = new Database(path, { readonly: true }); try { return (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n; } finally { db.close(); } };
    const liveCount = count();
    const dry = restore(['REPLACE-DATABASE', '--from', backupFile, '--by', 'boletz', ...reason, '--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry run/i);
    assert.equal(count(), liveCount, 'a dry run replaces nothing');

    const ran = restore(['REPLACE-DATABASE', '--from', backupFile, '--by', 'boletz', ...reason, '--change', 'INC-4471']);
    assert.equal(ran.status, 0, ran.stderr);
    assert.ok(readdirSync(dir).some((f) => /^vantage-before-restore-.*\.db$/.test(f)), 'the database it replaced is kept beside it');
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.vantage-restore-')), 'no temporary copy is left');

    const back = await reopen();
    const [record] = restoreHistory(back.ctx.db);
    assert.equal(record.method, 'script');
    assert.equal(record.by!.username, 'boletz');
    assert.equal(record.change, 'INC-4471');
    assert.equal(record.sameDatabase, true);
    assert.equal(record.restored.seq, backedUp);
    assert.ok(record.lost!.entries > 0);
    assert.ok(record.lost!.instances.G8 > 0, 'what it undid, per Unit Instance');
    assert.ok(record.undone!.entries.some((e) => e.action === 'org_role_granted' && e.subject_id === later.id), 'the Unit Manager named after the backup is listed for review');
    assert.equal(record.audited, true, 'the start audited it');
    assert.equal((back.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0, 'everyone signed in before is signed out');
    const restored = entries(back, 'database_restored');
    assert.deepEqual(restored.map((e) => e.org_id), [null, 'G8']);
    assert.match(restored[0].detail, /Authorized by John Boletz \(boletz\), run as .* under INC-4471: Ransomware on the host/);
    assert.equal(restored[0].actor_id, owner.id);
    assert.ok(notes(back, owner.id, '/admin/data').some((n) => n.title === 'The restore you authorized is in place'));
    assert.equal(notes(back, owner.id, '/console/operations').length, 1, 'G-8’s Lead Unit Manager is told');

    const token = await login(back, 'boletz');
    const recovery = (await back.call('GET', '/api/platform/recovery', { token })).body;
    assert.equal(recovery.restores.history[0].method, 'script');
    assert.equal(recovery.restores.lineage.kept, true);
    // The account was opened after the backup, so it is gone with the restore; the record still names it.
    assert.equal(recovery.restores.usernames[later.id], undefined);
    assert.ok(recovery.restores.history[0].undone.entries.some((e: { subject_username: string }) => e.subject_username === 'fileum'));
    const ops = (await back.call('GET', '/api/orgs/G8/operations', { token })).body;
    assert.equal(ops.restore.last.method, 'script');
    assert.ok(ops.health.checks.some((c: { id: string }) => c.id === 'restore'));
    // Starting again audits nothing twice.
    await shut();
    assert.equal(entries(await reopen(), 'database_restored').length, 2);
    await shut();

    // Put back by hand, behind the service's back: the lineage beside it says the database lost entries it had.
    copyFileSync(backupFile, path);
    for (const suffix of ['-wal', '-shm']) if (existsSync(`${path}${suffix}`)) unlinkSync(`${path}${suffix}`);
    const replaced = await reopen();
    const detected = restoreHistory(replaced.ctx.db).at(-1)!;
    assert.equal(detected.method, 'detected');
    assert.equal(detected.finding, 'missing_entry');
    assert.equal(detected.by, null);
    assert.deepEqual(entries(replaced, 'database_replaced').map((e) => e.org_id), [null, 'G8']);
    await shut();
    assert.equal(entries(await reopen(), 'database_replaced').length, 2, 'noticed once');
  } finally {
    await shut();
    rmSync(dir, { recursive: true, force: true });
  }
});
