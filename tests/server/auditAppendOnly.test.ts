import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { audit, verifyAuditChain } from '../../server/services/audit.ts';
import { dropAuditAppendOnlyTriggers } from '../../server/db/index.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { purgeExpired } from '../../server/services/demo.ts';

/**
 * The audit log is append-only (ADR-0013): the database refuses to change or remove an entry, and lifts that only inside
 * the one transaction that removes a demo workspace, loads an instance archive or starts over, which puts it back before
 * it commits.
 */

const H = { 'x-vantage-client': '1' };
const triggers = (app: TestApp) => (app.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit_log_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);

function assertSealed(app: TestApp, why: string) {
  assert.deepEqual(triggers(app), ['audit_log_no_delete', 'audit_log_no_update'], `${why}: the log is append-only again`);
  assert.throws(() => app.ctx.db.prepare("UPDATE audit_log SET detail = 'rewritten'").run(), /audit_append_only: an audit entry is never changed/);
  assert.throws(() => app.ctx.db.prepare('DELETE FROM audit_log').run(), /audit_append_only: an audit entry is never removed/);
  const chain = verifyAuditChain(app.ctx);
  assert.equal(chain.ok, true, `${why}: ${chain.reason}`);
}

test('an entry is never changed or removed, and the log is opened only inside a transaction that closes it', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    audit(app.ctx, { actor_id: op.id, action: 'edit_configuration', entity: 'platform', detail: 'probe' });
    const count = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    assertSealed(app, 'a running instance');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, count, 'nothing was removed');

    assert.throws(() => dropAuditAppendOnlyTriggers(app.ctx.db), /only inside a transaction/, 'never lifted outside a transaction');
    // A transaction that lifts the triggers and then fails leaves them where they were: dropping a trigger rolls back too.
    assert.throws(() => app.ctx.db.transaction(() => {
      dropAuditAppendOnlyTriggers(app.ctx.db);
      app.ctx.db.prepare('DELETE FROM audit_log').run();
      throw new Error('stopped half way');
    })(), /stopped half way/);
    assertSealed(app, 'after a transaction that failed');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, count);

    // A request whose writes would reach into the audit log is answered as a refusal, not a server error.
    app.ctx.db.exec("CREATE TEMP TRIGGER rewrite_probe BEFORE INSERT ON activities BEGIN UPDATE audit_log SET detail = 'rewritten'; END");
    try {
      const refused = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Reaches the log', date: '2026-09-01' } });
      assert.equal(refused.status, 403, JSON.stringify(refused.body));
      assert.equal(refused.body.code, 'audit_append_only');
    } finally { app.ctx.db.exec('DROP TRIGGER rewrite_probe'); }
    assert.equal((await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Writes as usual', date: '2026-09-01' } })).status, 201);
    assertSealed(app, 'after the refusal');
  } finally { await app.close(); }
});

test('removing an expired demo workspace takes its entries, reseals the chain and leaves the log append-only', async () => {
  const app = await startApp({ VANTAGE_ACCESS_MODE: 'demo' });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await app.call('POST', '/api/demo/start', { headers: H })).status, 200);
    const before = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    app.ctx.db.prepare("UPDATE demo_workspaces SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = (SELECT id FROM demo_workspaces ORDER BY created_at LIMIT 1)").run();
    assert.equal(purgeExpired(app.ctx), 1);
    assert.ok((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n < before, 'the workspace’s entries went with it');
    assertSealed(app, 'after a demo purge');
  } finally { await app.close(); }
});

test('an instance archive loads into a fresh instance with its own chain, and the log is append-only afterwards', async () => {
  const source = await startApp();
  const fresh = await startApp();
  try {
    const op = await source.setupOperator();
    assert.equal((await source.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Moves with the instance', date: '2026-09-01' } })).status, 201);
    const archive = JSON.parse(JSON.stringify(exportInstance(source.ctx))) as Parameters<typeof importInstance>[1] & { tables: Record<string, Array<Record<string, unknown>>> };
    assert.ok(archive.tables.audit_log.every((r) => r.category), 'the archive carries each entry’s category');
    const freshOp = await fresh.setupOperator();
    importInstance(fresh.ctx, archive, freshOp.id);
    const imported = fresh.ctx.db.prepare("SELECT category FROM audit_log WHERE action = 'instance_import'").get() as { category: string };
    assert.equal(imported.category, 'enterprise');
    assertSealed(fresh, 'after an instance import');
    // A second import is refused, as before: only a fresh instance is ever emptied.
    assert.throws(() => importInstance(fresh.ctx, archive, freshOp.id), /fresh instance/);
    assertSealed(fresh, 'after a refused import');
  } finally {
    await source.close();
    await fresh.close();
  }
});
