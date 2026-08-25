/**
 * Vantage — administrator account recovery (v3.3 finding 32).
 *
 * The controlled, documented, auditable path back in when the administrator
 * password is lost. Not a backdoor: it only runs with shell access to the
 * deployment, only when VANTAGE_RECOVERY=1 is set for this one invocation,
 * it prints the new one-time password exactly once, revokes every session the
 * account held, and writes an audit event that cannot be suppressed.
 *
 *   VANTAGE_RECOVERY=1 npm run recover -- <username>
 *
 * With no username it targets the sole administrator account, and refuses to
 * guess when more than one exists.
 */

import { randomBytes } from 'node:crypto';

if (process.env.VANTAGE_RECOVERY !== '1') {
  console.error('Refusing: set VANTAGE_RECOVERY=1 for this one invocation. See README — Administrator recovery.');
  process.exit(1);
}

const { getDb, now, audit } = await import('../server/db.js');
const db = getDb();
const { hashPassword, invalidateUserSessions } = await import('../server/auth.js');
const { operatorUserIds, operatorUsernames } = await import('../server/instance.js');
const { normalizeUsername } = await import('../server/identity.js');

const arg = process.argv[2];
let target;
if (arg) {
  target = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(normalizeUsername(arg));
  if (!target) { console.error(`No account named "${arg}".`); process.exit(1); }
} else {
  const configuredIds = operatorUserIds();
  const configured = operatorUsernames();
  const candidates = configuredIds.length
    ? db.prepare(`SELECT * FROM users WHERE id IN (${configuredIds.map(() => '?').join(',')})`).all(...configuredIds)
    : configured.length
      ? db.prepare(`SELECT * FROM users WHERE username COLLATE NOCASE IN (${configured.map(() => '?').join(',')})`).all(...configured)
      : db.prepare('SELECT * FROM users WHERE is_admin = 1').all();
  if (candidates.length !== 1) {
    console.error(`Found ${candidates.length} recovery candidates — name one explicitly: npm run recover -- <username>`);
    process.exit(1);
  }
  [target] = candidates;
}

const password = randomBytes(12).toString('base64url');
const sessions = invalidateUserSessions(db, target.id);
db.prepare('UPDATE users SET password_hash = ?, active = 1, must_change_password = 1, updated_at = ? WHERE id = ?')
  .run(hashPassword(password), now(), target.id);
// actor_id is NOT NULL by schema; attribute the event to the recovered
// account itself with the detail making the mechanism unambiguous.
audit({
  actor_id: target.id, action: 'admin_recovery', entity: 'user', entity_id: target.id,
  subject_id: target.id, detail: `deployment-level shell recovery (VANTAGE_RECOVERY=1); ${sessions} session(s) revoked`,
});

console.log(`Account:   ${target.username}`);
console.log(`Password:  ${password}`);
console.log(`Sessions revoked: ${sessions}`);
console.log('Sign in now and change this password immediately (Settings → Change your password).');
