import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../server/config.ts';
import { createContext } from '../../server/app.ts';
import { audit, verifyAuditChain } from '../../server/services/audit.ts';
import { decryptSecret, encryptSecret } from '../../server/lib/crypto.ts';
import { metaGet } from '../../server/db/index.ts';

const OLD = 'old-secret-old-secret-old-secret-0001';
const NEW = 'new-secret-new-secret-new-secret-0002';

function contextFor(db: string, env: Record<string, string>) {
  return createContext(loadConfig({
    NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: db, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_PUBLIC_URL: 'http://localhost:5173', ...env,
  } as NodeJS.ProcessEnv));
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-rotate-'));
  return { path: join(dir, 'vantage.db'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('changing VANTAGE_SECRET with the old one as VANTAGE_SECRET_PREVIOUS keeps the chain and every stored secret', () => {
  const db = scratch();
  try {
    const first = contextFor(db.path, { VANTAGE_SECRET: OLD });
    first.db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, totp_secret, created_at, updated_at) VALUES ('u1', 'avery', '', 'Jordan', 'Avery', ?, '2026-10-01', '2026-10-01')`)
      .run(encryptSecret(OLD, 'JBSWY3DPEHPK3PXP'));
    audit(first, { action: 'before_rotation' });
    assert.equal(verifyAuditChain(first).ok, true);
    first.db.close();

    const rotating = contextFor(db.path, { VANTAGE_SECRET: NEW, VANTAGE_SECRET_PREVIOUS: OLD });
    const stored = (rotating.db.prepare("SELECT totp_secret FROM users WHERE id = 'u1'").get() as { totp_secret: string }).totp_secret;
    assert.equal(decryptSecret(NEW, stored), 'JBSWY3DPEHPK3PXP', 'the authenticator secret is re-sealed under the new secret');
    assert.equal(decryptSecret(OLD, stored), null);
    assert.equal(verifyAuditChain(rotating).ok, true, 'the chain still verifies after the secret changes');
    audit(rotating, { action: 'after_rotation' });
    rotating.db.close();

    const after = contextFor(db.path, { VANTAGE_SECRET: NEW });
    assert.equal(verifyAuditChain(after).ok, true, 'and without the old secret once it is re-sealed');
    assert.equal((after.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n >= 2, true);
    after.db.close();

    assert.throws(() => contextFor(db.path, { VANTAGE_SECRET: 'a-third-secret-nobody-set-before-0003' }), /VANTAGE_SECRET_PREVIOUS/);
  } finally {
    db.done();
  }
});

test('a chain written before the chain key existed keeps verifying, keyed by the secret it was written under', () => {
  const db = scratch();
  try {
    const legacy = contextFor(db.path, { VANTAGE_SECRET: OLD });
    legacy.db.exec("DELETE FROM audit_log; DELETE FROM meta WHERE key IN ('audit_head', 'chain_key');");
    legacy.chainKey = OLD;
    audit(legacy, { action: 'legacy_entry' });
    legacy.db.close();

    const upgraded = contextFor(db.path, { VANTAGE_SECRET: OLD });
    assert.equal(upgraded.chainKey, OLD);
    assert.equal(verifyAuditChain(upgraded).ok, true);
    assert.ok(metaGet(upgraded.db, 'chain_key'));
    upgraded.db.close();
  } finally {
    db.done();
  }
});

test('a fresh instance gets a chain key of its own, not the secret', () => {
  const ctx = contextFor(':memory:', { VANTAGE_SECRET: OLD });
  assert.notEqual(ctx.chainKey, OLD);
  assert.ok(ctx.chainKey.length >= 40);
  ctx.db.close();
});
