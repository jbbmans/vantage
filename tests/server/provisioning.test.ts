import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionUnitInstance, provisioningActor } from '../../server/services/provisioning.ts';
import { startApp } from './helpers.ts';

/**
 * Provisioning a Unit Instance from a manifest (ADR-0007): only a Vantage Administrator may, a dry run writes nothing,
 * a run that would fail changes nothing, and running a manifest again changes nothing that is already true.
 */

const count = (app: Awaited<ReturnType<typeof startApp>>, sql: string, ...params: unknown[]) => (app.ctx.db.prepare(sql).get(...params) as { n: number }).n;

test('a Vantage Administrator provisions a Unit Instance and its first Unit Manager, once', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const lead = await app.register('gonelead');
    assert.throws(() => provisioningActor(app.ctx, 'gonelead'), /not a Vantage Administrator/);
    assert.throws(() => provisioningActor(app.ctx, 'nobody'), /No active account/);
    const actor = provisioningActor(app.ctx, 'boletz');
    assert.equal(actor.id, op.id);

    const manifest = { name: 'MARFORRES G-1', code: 'G1', short_name: 'G-1', manager: 'gonelead' };
    const before = count(app, 'SELECT COUNT(*) AS n FROM audit_log');
    const dry = provisionUnitInstance(app.ctx, actor, manifest, { dryRun: true });
    assert.deepEqual([dry.action, dry.manager], ['would_create', 'would_name']);
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM organizations WHERE id = 'G1'"), 0, 'a dry run writes nothing');
    assert.equal(count(app, 'SELECT COUNT(*) AS n FROM audit_log'), before);

    const made = provisionUnitInstance(app.ctx, actor, manifest);
    assert.deepEqual([made.action, made.manager, made.unitInstance.id], ['created', 'named', 'G1']);
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM org_roles WHERE org_id = 'G1' AND user_id = ? AND role = 'owner'", lead.id), 1);
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'unit_instance_provisioned' AND actor_id = ? AND org_id = 'G1'", op.id), 1, 'audited to the administrator who ran it');
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM org_roles WHERE org_id = 'G1' AND user_id = ?", op.id), 0, 'the administrator gains no role inside it');

    const again = provisionUnitInstance(app.ctx, actor, manifest);
    assert.deepEqual([again.action, again.manager], ['exists', 'already_manager']);
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'unit_instance_provisioned'"), 1, 'running it again changes nothing');

    assert.throws(() => provisionUnitInstance(app.ctx, actor, { ...manifest, name: 'MARFORRES G-One' }), /exists as "MARFORRES G-1"/);
    assert.throws(() => provisionUnitInstance(app.ctx, actor, { name: 'G-3', manager: 'ghost' }), /No active account matches the manager "ghost"/);
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM organizations WHERE name = 'G-3'"), 0, 'a refused run leaves nothing half made');
    assert.throws(() => provisionUnitInstance(app.ctx, actor, { name: 'G-4', owner_user_id: lead.id }), /Unrecognized key/);

    // A Unit Instance with no manager gets its first from a later run; one with managers names its own.
    const bare = provisionUnitInstance(app.ctx, actor, { name: 'MARFORRES G-4', code: 'G4' });
    assert.deepEqual([bare.action, bare.manager], ['created', 'none']);
    assert.equal(provisionUnitInstance(app.ctx, actor, { name: 'MARFORRES G-4', code: 'G4', manager: 'gonelead' }).manager, 'named');
    await app.register('second');
    assert.equal(provisionUnitInstance(app.ctx, actor, { name: 'MARFORRES G-4', code: 'G4', manager: 'second' }).manager, 'has_managers');
  } finally { await app.close(); }
});

test('a dedicated deployment provisions no second Unit Instance', async () => {
  const app = await startApp({ VANTAGE_TOPOLOGY: 'dedicated' });
  try {
    await app.setupOperator();
    const actor = provisioningActor(app.ctx, 'boletz');
    assert.throws(() => provisionUnitInstance(app.ctx, actor, { name: 'MARFORRES G-1', code: 'G1' }, { dryRun: true }), /dedicated to one Unit Instance/);
    assert.equal(provisionUnitInstance(app.ctx, actor, { name: 'G-8 Comptroller', code: 'G8' }).action, 'exists', 'its own Unit Instance is reported as it is');
  } finally { await app.close(); }
});

function run(db: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/provision-instance.ts', ...args], {
      env: {
        ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: db, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
        VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_PUBLIC_URL: 'http://localhost:5173', VANTAGE_PROVISION: '', ...env,
      },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('the provisioning script runs a manifest as a named administrator, and only when asked to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-provision-'));
  const db = join(dir, 'vantage.db');
  const manifest = join(dir, 'g1.json');
  writeFileSync(manifest, JSON.stringify({ name: 'MARFORRES G-1', code: 'G1', manager: 'gonelead' }));
  const app = await startApp({ VANTAGE_DB: db });
  try {
    await app.setupOperator();
    await app.register('gonelead');
    const refused = await run(db, ['--by', 'boletz', manifest]);
    assert.notEqual(refused.status, 0, 'VANTAGE_PROVISION=1 is required');
    assert.notEqual((await run(db, [manifest], { VANTAGE_PROVISION: '1' })).status, 0, 'the administrator is required');
    const notAdmin = await run(db, ['--by', 'gonelead', manifest], { VANTAGE_PROVISION: '1' });
    assert.notEqual(notAdmin.status, 0);
    assert.match(notAdmin.stderr, /not a Vantage Administrator/);
    const dry = await run(db, ['--by', 'boletz', manifest, '--dry-run'], { VANTAGE_PROVISION: '1' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).action, 'would_create');
    const done = await run(db, ['--by', 'boletz', manifest], { VANTAGE_PROVISION: '1' });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual([JSON.parse(done.stdout).action, JSON.parse(done.stdout).manager], ['created', 'named']);
    assert.equal(count(app, "SELECT COUNT(*) AS n FROM organizations WHERE id = 'G1'"), 1, 'the running server sees it');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
