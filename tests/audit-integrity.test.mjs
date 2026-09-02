import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-audit-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_AUDIT_HMAC_KEY = 'audit-test-key-material-that-is-longer-than-thirty-two-bytes';

const { audit, bootstrapAdmin, getDb, verifyAuditChain } = await import('../server/db.js');
const db = getDb();
const admin = bootstrapAdmin({
  username: 'audit-admin', password: 'audit-admin-long-passphrase-927', first_name: 'Audit', last_name: 'Admin', unit_code: 'MFR',
});
audit({ actor_id: admin.id, action: 'audit_test_one', entity: 'test' });
audit({ actor_id: admin.id, action: 'audit_test_two', entity: 'test' });
assert.equal(verifyAuditChain(db).ok, true);

const tail = db.prepare("SELECT id FROM audit_log WHERE action = 'audit_test_two'").get();
db.prepare('DELETE FROM audit_log WHERE id = ?').run(tail.id);
const remaining = db.prepare('SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1').get();
const count = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
db.prepare("UPDATE meta SET value = ? WHERE key = 'audit_log_anchor'")
  .run(JSON.stringify({ hash: remaining.entry_hash, count }));
const truncated = verifyAuditChain(db);
assert.equal(truncated.ok, false);
assert.match(truncated.reason, /anchor/);

const changed = db.prepare("SELECT id FROM audit_log WHERE action = 'audit_test_one'").get();
db.prepare("UPDATE audit_log SET detail = 'tampered' WHERE id = ?").run(changed.id);
const tampered = verifyAuditChain(db);
assert.equal(tampered.ok, false);
assert.match(tampered.reason, /chain/);

db.close();
try { rmSync(DB, { force: true }); rmSync(`${DB}-wal`, { force: true }); rmSync(`${DB}-shm`, { force: true }); } catch { }
console.log('  ok    HMAC audit chain detects row tampering');
