import {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON, type AuthenticatorTransport,
} from '@simplewebauthn/server';
import type { AppContext } from '../context.ts';
import { now } from '../lib/ids.ts';
import { sha256 } from '../lib/crypto.ts';

/** A passkey is used on the application and on the Unit Manager console, wherever each one lives. */
const passkeyOrigins = (ctx: AppContext) => [...new Set([ctx.config.urls.app, ctx.config.urls.console])];

const CHALLENGE_TTL = 5 * 60_000;
export const MAX_CHALLENGES = 2000;
type ChallengeKind = 'registration' | 'authentication';

function remember(ctx: AppContext, kind: ChallengeKind, key: string, challenge: string, userId: string | null) {
  ctx.db.transaction(() => {
    const at = now();
    ctx.db.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ?').run(at);
    ctx.db.prepare('INSERT OR REPLACE INTO passkey_challenges (key_hash, kind, challenge, user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(key), kind, challenge, userId, new Date(Date.now() + CHALLENGE_TTL).toISOString(), at);
    // Keep the newest bounded set, even when more than one application process shares the database.
    ctx.db.prepare('DELETE FROM passkey_challenges WHERE key_hash IN (SELECT key_hash FROM passkey_challenges ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(MAX_CHALLENGES);
  }).immediate();
}
export function passkeyChallengeCount(ctx: AppContext) { return (ctx.db.prepare('SELECT COUNT(*) AS n FROM passkey_challenges').get() as { n: number }).n; }

function take(ctx: AppContext, kind: ChallengeKind, key: string) {
  return ctx.db.transaction(() => {
    const entry = ctx.db.prepare('DELETE FROM passkey_challenges WHERE key_hash = ? AND kind = ? RETURNING challenge, user_id, expires_at')
      .get(sha256(key), kind) as { challenge: string; user_id: string | null; expires_at: string } | undefined;
    if (!entry || Date.parse(entry.expires_at) <= Date.now()) return null;
    return { challenge: entry.challenge, userId: entry.user_id };
  }).immediate();
}

interface PasskeyRow { id: string; user_id: string; public_key: Buffer; counter: number; transports: string; device_type: string | null; backed_up: number; name: string; created_at: string; last_used_at: string | null }

export function listPasskeys(ctx: AppContext, userId: string) {
  return (ctx.db.prepare('SELECT id, name, device_type, backed_up, created_at, last_used_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId) as Array<Omit<PasskeyRow, 'public_key' | 'counter' | 'user_id'>>)
    .map((r) => ({ ...r, transports: JSON.parse(r.transports || '[]') as string[] }));
}

export async function registrationOptions(ctx: AppContext, user: { id: string; username: string; first_name: string; last_name: string }) {
  const existing = ctx.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id) as Array<{ id: string; transports: string }>;
  const options = await generateRegistrationOptions({
    rpName: ctx.runtime.displayName || 'Vantage',
    rpID: ctx.config.rpId,
    userName: user.username,
    userDisplayName: `${user.first_name} ${user.last_name}`,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports || '[]') as AuthenticatorTransport[] })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  remember(ctx, 'registration', `reg:${user.id}`, options.challenge, user.id);
  return options;
}

export async function completeRegistration(ctx: AppContext, userId: string, response: RegistrationResponseJSON, name: string) {
  const pending = take(ctx, 'registration', `reg:${userId}`);
  if (!pending) throw new Error('Passkey registration timed out. Start again.');
  const verification = await verifyRegistrationResponse({
    response, expectedChallenge: pending.challenge, expectedOrigin: passkeyOrigins(ctx), expectedRPID: ctx.config.rpId, requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) throw new Error('The passkey could not be verified.');
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  ctx.db.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(credential.id, userId, Buffer.from(credential.publicKey), credential.counter, JSON.stringify(credential.transports || []), credentialDeviceType, credentialBackedUp ? 1 : 0, name.slice(0, 80) || 'Passkey', now());
  return { id: credential.id, name };
}

export async function authenticationOptions(ctx: AppContext, username?: string | null) {
  let allow: Array<{ id: string; transports?: AuthenticatorTransport[] }> | undefined;
  let userId: string | null = null;
  if (username) {
    const user = ctx.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(username) as { id: string } | undefined;
    if (user) {
      userId = user.id;
      allow = (ctx.db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id) as Array<{ id: string; transports: string }>)
        .map((c) => ({ id: c.id, transports: JSON.parse(c.transports || '[]') as AuthenticatorTransport[] }));
    }
  }
  const options = await generateAuthenticationOptions({ rpID: ctx.config.rpId, allowCredentials: allow, userVerification: 'required' });
  const key = `auth:${options.challenge}`;
  remember(ctx, 'authentication', key, options.challenge, userId);
  return { options, key };
}

export async function completeAuthentication(ctx: AppContext, response: AuthenticationResponseJSON, challengeKey: string) {
  const pending = take(ctx, 'authentication', challengeKey);
  if (!pending) throw new Error('Passkey sign-in timed out. Try again.');
  const row = ctx.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id) as PasskeyRow | undefined;
  if (!row) throw new Error('That passkey is not registered here.');
  if (pending.userId && pending.userId !== row.user_id) throw new Error('That passkey belongs to a different account.');
  const verification = await verifyAuthenticationResponse({
    response, expectedChallenge: pending.challenge, expectedOrigin: passkeyOrigins(ctx), expectedRPID: ctx.config.rpId, requireUserVerification: true,
    credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: JSON.parse(row.transports || '[]') },
  });
  if (!verification.verified) throw new Error('The passkey could not be verified.');
  ctx.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(verification.authenticationInfo.newCounter, now(), row.id);
  return { userId: row.user_id, passkeyId: row.id };
}

export function deletePasskey(ctx: AppContext, userId: string, id: string): boolean {
  return ctx.db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function resetPasskeyChallenges(ctx: AppContext) { ctx.db.prepare('DELETE FROM passkey_challenges').run(); }
