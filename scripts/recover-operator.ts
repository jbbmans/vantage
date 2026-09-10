// Grant operator authority and a temporary password from the shell. Requires VANTAGE_RECOVERY=1.
import { loadConfig } from '../server/config.ts';
import { createContext } from '../server/app.ts';
import { hashPassword } from '../server/lib/crypto.ts';
import { invalidateUserSessions } from '../server/auth/sessions.ts';
import { audit } from '../server/services/audit.ts';
import { randomBytes } from 'node:crypto';

if (process.env.VANTAGE_RECOVERY !== '1') { console.error('Refusing: set VANTAGE_RECOVERY=1 for this one invocation.'); process.exit(1); }
const username = String(process.argv[2] || '').toLowerCase();
if (!username) { console.error('Usage: VANTAGE_RECOVERY=1 node scripts/recover-operator.ts <username>'); process.exit(1); }
const ctx = createContext(loadConfig());
const user = ctx.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username) as { id: string } | undefined;
if (!user) { console.error(`No account named ${username}.`); process.exit(1); }
const password = `${randomBytes(6).toString('hex')}-${randomBytes(6).toString('hex')}-${randomBytes(3).toString('hex')}`;
ctx.db.prepare('UPDATE users SET is_operator = 1, active = 1, password_hash = ?, must_change_password = 1, totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?').run(hashPassword(password), new Date().toISOString(), user.id);
ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
invalidateUserSessions(ctx, user.id);
audit(ctx, { actor_id: user.id, action: 'operator_recovery', entity: 'user', entity_id: user.id, subject_id: user.id, detail: 'shell recovery' });
console.log(`Operator ${username} recovered. Temporary password (change at first sign-in):\n${password}`);
ctx.db.close();
