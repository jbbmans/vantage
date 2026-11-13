import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from './helpers.ts';
import { authenticationOptions, completeAuthentication, MAX_CHALLENGES, passkeyChallengeCount, registrationOptions } from '../../server/auth/passkeys.ts';
import { issueToken, consumeToken } from '../../server/auth/tokens.ts';
import { sha256 } from '../../server/lib/crypto.ts';
import { exportInstance } from '../../server/services/exports.ts';
import { pruneSessions } from '../../server/auth/sessions.ts';
import { trackedJob, jobStatus } from '../../server/services/operations.ts';
import { totpCode } from '../../server/auth/totp.ts';

const invalidCredential = { id: 'not-a-registered-credential', rawId: '', response: { clientDataJSON: '', authenticatorData: '', signature: '' }, clientExtensionResults: {}, type: 'public-key' as const };

/** Simulate revocation/consumption immediately after a caller's first lookup, without timing-dependent threads. */
function spendAfterLookup(app: Awaited<ReturnType<typeof startApp>>, kind: string) {
  const prepare = app.ctx.db.prepare.bind(app.ctx.db);
  let spent = false;
  return mock.method(app.ctx.db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('SELECT * FROM tokens WHERE kind = ?')) return statement;
    return new Proxy(statement, { get(target, property, receiver) {
      if (property !== 'get') return Reflect.get(target, property, receiver);
      return (...params: unknown[]) => {
        const row = target.get(...params);
        if (!spent && params[0] === kind && row) {
          spent = true;
          prepare('UPDATE tokens SET used_at = ? WHERE kind = ?').run(new Date().toISOString(), kind);
        }
        return row;
      };
    } });
  });
}

test('a second-factor route never creates a session if its password challenge was consumed after the first lookup', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const start = await app.call('POST', '/api/me/mfa/totp/start', { token: op.token });
    const step = Math.floor(Date.now() / 30000);
    assert.equal((await app.call('POST', '/api/me/mfa/totp/confirm', { token: op.token, body: { code: totpCode(start.body.secret, step) } })).status, 200);
    const pending = await app.login('boletz');
    const before = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
    const hook = spendAfterLookup(app, 'login_mfa');
    try {
      const result = await app.call('POST', '/api/auth/login/mfa', { body: { challenge: pending.body.challenge, code: totpCode(start.body.secret, step + 1) } });
      assert.equal(result.status, 401, JSON.stringify(result.body)); assert.equal(result.body.code, 'challenge_expired');
      assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, before);
    } finally { hook.mock.restore(); }
  } finally { await app.close(); }
});

test('a recovery code or authenticator step is not used up when the sign-in challenge is gone by the time it is consumed', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const start = await app.call('POST', '/api/me/mfa/totp/start', { token: op.token });
    const step = Math.floor(Date.now() / 30000);
    const confirmed = await app.call('POST', '/api/me/mfa/totp/confirm', { token: op.token, body: { code: totpCode(start.body.secret, step) } });
    assert.equal(confirmed.status, 200);
    const recovery = confirmed.body.recoveryCodes[0];
    const usedCodes = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NOT NULL').get(op.id) as { n: number }).n;
    const lastStep = () => (app.ctx.db.prepare('SELECT totp_last_step AS s FROM users WHERE id = ?').get(op.id) as { s: number | null }).s;

    for (const code of [recovery, totpCode(start.body.secret, step + 1)]) {
      const pending = await app.login('boletz');
      const stepBefore = lastStep();
      const hook = spendAfterLookup(app, 'login_mfa');
      try {
        const result = await app.call('POST', '/api/auth/login/mfa', { body: { challenge: pending.body.challenge, code } });
        assert.equal(result.status, 401, JSON.stringify(result.body)); assert.equal(result.body.code, 'challenge_expired');
      } finally { hook.mock.restore(); }
      assert.equal(usedCodes(), 0);
      assert.equal(lastStep(), stepBefore);
    }
    // The same recovery code still signs in once there is a live challenge.
    const pending = await app.login('boletz');
    const signedIn = await app.call('POST', '/api/auth/login/mfa', { body: { challenge: pending.body.challenge, code: recovery } });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    assert.equal(usedCodes(), 1);
  } finally { await app.close(); }
});

test('email confirmation never changes the account when the token was spent after the first lookup', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const pending = issueToken(app.ctx, 'email_change', { userId: op.id, email: 'synthetic-new@example.mil', ttlMinutes: 5 });
    const hook = spendAfterLookup(app, 'email_change');
    try {
      const result = await app.call('POST', '/api/me/email/confirm', { token: op.token, body: { token: pending.token } });
      assert.equal(result.status, 400);
      assert.equal((app.ctx.db.prepare('SELECT email FROM users WHERE id = ?').get(op.id) as { email: string }).email, 'boletz@example.mil');
    } finally { hook.mock.restore(); }
  } finally { await app.close(); }
});

test('passkey challenges survive a restart and are consumed exactly once, even when verification fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-challenge-'));
  const env = { VANTAGE_DB: join(dir, 'test.db') };
  let app = await startApp(env);
  try {
    await app.setupOperator();
    const pending = await authenticationOptions(app.ctx);
    await app.close(); app = await startApp(env);
    assert.equal(passkeyChallengeCount(app.ctx), 1);
    await assert.rejects(completeAuthentication(app.ctx, invalidCredential, pending.key), /not registered/);
    await assert.rejects(completeAuthentication(app.ctx, invalidCredential, pending.key), /timed out/);
    assert.equal(passkeyChallengeCount(app.ctx), 0);
    assert.ok(!('passkey_challenges' in exportInstance(app.ctx).tables), 'portable archives never carry pending authentication');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('registration challenges cannot be substituted for sign-in challenges, and expired challenges are pruned', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    await registrationOptions(app.ctx, { id: op.id, username: 'boletz', first_name: 'John', last_name: 'Boletz' });
    await assert.rejects(completeAuthentication(app.ctx, invalidCredential, `reg:${op.id}`), /timed out/);
    assert.equal(passkeyChallengeCount(app.ctx), 1, 'wrong-purpose consumption leaves registration intact');
    const pending = await authenticationOptions(app.ctx);
    app.ctx.db.prepare('UPDATE passkey_challenges SET expires_at = ? WHERE key_hash = ?').run('2000-01-01T00:00:00.000Z', sha256(pending.key));
    await assert.rejects(completeAuthentication(app.ctx, invalidCredential, pending.key), /timed out/);
    app.ctx.db.prepare("UPDATE passkey_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    pruneSessions(app.ctx); assert.equal(passkeyChallengeCount(app.ctx), 0);
  } finally { await app.close(); }
});

test('the persistent challenge store remains bounded and instances do not share challenge state', async () => {
  const app = await startApp(); const other = await startApp();
  try {
    const at = new Date().toISOString(); const until = new Date(Date.now() + 60000).toISOString();
    app.ctx.db.transaction(() => {
      const insert = app.ctx.db.prepare("INSERT INTO passkey_challenges (key_hash, kind, challenge, expires_at, created_at) VALUES (?, 'authentication', ?, ?, ?)");
      for (let i = 0; i <= MAX_CHALLENGES; i++) insert.run(`synthetic-${i}`, 'synthetic', until, at);
    })();
    const newest = await authenticationOptions(app.ctx);
    assert.equal(passkeyChallengeCount(app.ctx), MAX_CHALLENGES);
    assert.equal(passkeyChallengeCount(other.ctx), 0);
    await assert.rejects(completeAuthentication(app.ctx, invalidCredential, newest.key), /not registered/);
  } finally { await app.close(); await other.close(); }
});

test('single-use links cannot be consumed twice, accept only their purpose and reject expired links', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const issued = issueToken(app.ctx, 'reset', { userId: op.id, ttlMinutes: 5 });
    assert.equal(consumeToken(app.ctx, 'invite', issued.token), null);
    assert.equal(consumeToken(app.ctx, 'reset', issued.token)?.user_id, op.id);
    assert.equal(consumeToken(app.ctx, 'reset', issued.token), null);
    const expired = issueToken(app.ctx, 'reset', { userId: op.id, ttlMinutes: -1 });
    assert.equal(consumeToken(app.ctx, 'reset', expired.token), null);
  } finally { await app.close(); }
});

test('a slow scheduled job skips overlapping ticks and can run again after completion or failure', async () => {
  const app = await startApp();
  try {
    let release: () => void = () => {};
    let calls = 0;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const run = trackedJob(app.ctx, 'synthetic', 'Synthetic job', 1000, async () => { calls++; await wait; });
    const first = run(); await run();
    assert.equal(calls, 1); assert.equal(jobStatus(app.ctx)[0].skipped, 1); assert.equal(jobStatus(app.ctx)[0].running, true);
    release(); await first; await run();
    assert.equal(calls, 2); assert.equal(jobStatus(app.ctx)[0].running, false);
    let failures = 0;
    const failing = trackedJob(app.ctx, 'failing', 'Synthetic failure', 1000, () => { failures++; throw new Error('synthetic test failure'); });
    await failing(); await failing();
    assert.equal(failures, 2); assert.equal(jobStatus(app.ctx).find((s) => s.name === 'failing')?.failures, 2);
  } finally { await app.close(); }
});
