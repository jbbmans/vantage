import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound, tooMany, unauthorized, HttpError } from '../lib/errors.ts';
import { registrationSchema, setupSchema, passwordField, usernameField, emailField } from '../../shared/schemas.ts';
import { hashPassword, verifyPassword, burnVerification, safeEqual, decryptSecret, sha256, needsRehash } from '../lib/crypto.ts';
import { assertNotLocked, assertNameNotLocked, recordFailure, recordNameFailure, clearFailures } from '../auth/lockout.ts';
import { DOD_CONSENT_BANNER } from '../../shared/consent.ts';
import { secretsOf } from '../lib/keys.ts';
import { limiters } from '../auth/limiter.ts';
import { createSession, destroySession, invalidateUserSessions, SESSION_COOKIE, SIGNED_IN_COOKIE, grantSudo } from '../auth/sessions.ts';
import { requireAuth } from '../auth/middleware.ts';
import { issueToken, consumeToken, peekToken, revokeTokens } from '../auth/tokens.ts';
import { matchTotp } from '../auth/totp.ts';
import { presentedCertificate, resolveAccount, CacError } from '../auth/cac.ts';
import { authenticationOptions, completeAuthentication } from '../auth/passkeys.ts';
import { record } from '../services/telemetry.ts';
import { facesOf } from '../lib/hosts.ts';
import { audit } from '../services/audit.ts';
import { layout } from '../services/mailLayout.ts';
import { newId, now } from '../lib/ids.ts';
import { claimUnit, addMember } from '../services/org.ts';
import { slug } from '../lib/ids.ts';
import type { Request, Response } from 'express';
import type { AppContext } from '../context.ts';
import { startSignIn, completeSignIn, resolveOidcAccount, OidcError } from '../auth/oidc.ts';

export const authRouter = Router();

interface UserRow { id: string; username: string; email: string | null; first_name: string; last_name: string; password_hash: string; totp_enabled: number; totp_secret: string | null; totp_last_step: number | null; must_change_password: number; active: number; is_operator: number }

function cookieOptions(req: Request) {
  const secure = req.ctx.config.production || req.secure;
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
}

export function finishSignIn(req: Request, res: Response, user: { id: string; must_change_password: number }, method: string, action = 'login') {
  const { token, expires } = openSession(req, res, user, method, action);
  const body: Record<string, unknown> = { ok: true, expires, mustChangePassword: Boolean(user.must_change_password) };
  if (req.ctx.config.test) body.token = token;
  return res.json(body);
}

/**
 * Every way of getting a session ends here: the notice, the console's owners-only rule, the lockout count and the
 * cookies. `consented` is for a sign-in that came back from another site and so carries no header.
 */
function openSession(req: Request, res: Response, user: { id: string }, method: string, action: string, opts: { consented?: boolean } = {}) {
  const ctx = req.ctx;
  // The router refused anything unaccepted before it ran; this is the backstop for any future way in.
  if (consentFor(ctx) && !(opts.consented ?? req.get('x-vantage-consent') === '1')) throw forbidden('Read and accept the notice before signing in.', 'consent_required');
  // A console on a host of its own is for the people it serves, and nobody else signs in there: the owner console for
  // an organization's owners, administrators, records officers and auditors; the admin dashboard for Vantage staff.
  const faces = facesOf(res);
  if (!faces.has('app') && (faces.has('console') || faces.has('admin'))) {
    const staff = Boolean(ctx.db.prepare('SELECT 1 FROM platform_roles WHERE user_id = ? LIMIT 1').get(user.id));
    const orgRole = Boolean(ctx.db.prepare("SELECT 1 FROM org_roles WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1").get(user.id, now()));
    const allowed = (faces.has('admin') && staff) || (faces.has('console') && orgRole);
    if (!allowed) {
      audit(ctx, { actor_id: user.id, action: 'console_sign_in_refused', ip: clientIp(req), detail: method });
      throw forbidden(faces.has('admin') ? `The admin dashboard is for Vantage staff. Sign in at ${ctx.config.urls.app} instead.` : `The owner console is for the people who run a Unit Instance on Vantage. Sign in at ${ctx.config.urls.app} instead.`, 'console_owners_only');
    }
  }
  clearFailures(ctx, user.id);
  const { token, expires } = createSession(ctx, user.id, { ip: clientIp(req), userAgent: req.get('user-agent'), method, sudo: true });
  audit(ctx, { actor_id: user.id, action, ip: clientIp(req), detail: method });
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  res.cookie(SIGNED_IN_COOKIE, '1', { ...cookieOptions(req), httpOnly: false });
  return { token, expires };
}

/** A hash made the old way is replaced while the password is in hand, so the instance moves to PBKDF2 as people sign in. */
export function rehashIfOld(ctx: AppContext, userId: string, password: string, stored: string) {
  if (needsRehash(stored)) ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(hashPassword(password), userId, stored);
}

/** The notice to acknowledge before sign-in, if this instance shows one. */
function consentFor(ctx: AppContext): string | null {
  const { consentBanner, consentText } = ctx.config.security;
  if (consentBanner === 'off' || ctx.config.accessMode === 'demo') return null;
  return consentBanner === 'dod' ? DOD_CONSENT_BANNER : consentText;
}

function userCount(ctx: AppContext) { return (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n; }

authRouter.get('/setup', wrap((req, res) => {
  const ctx = req.ctx;
  res.json({
    accessMode: ctx.config.accessMode,
    needsSetup: ctx.config.accessMode === 'demo' ? false : userCount(ctx) === 0,
    requiresSetupToken: ctx.config.production && userCount(ctx) === 0,
    selfRegistration: ctx.runtime.selfRegistration && !ctx.config.cac.exclusive && !ctx.config.oidc.exclusive,
    cac: { enabled: ctx.config.cac.mode !== 'off', exclusive: ctx.config.cac.exclusive },
    sso: { enabled: ctx.config.oidc.enabled, label: ctx.config.oidc.label, exclusive: ctx.config.oidc.exclusive },
    emailEnabled: ctx.mailer.enabled,
    displayName: ctx.runtime.displayName,
    announcement: ctx.runtime.announcement,
    maintenance: ctx.runtime.maintenance,
    consent: consentFor(ctx),
  });
}));

/** Every request that creates an account or a session. With a sign-in notice on, none of them runs until it is accepted. */
const NEEDS_CONSENT = new Set(['/setup', '/register', '/login', '/login/mfa', '/passkey/verify', '/reset', '/invite/accept', '/cac']);
authRouter.use((req, _res, next) => {
  const path = req.path.toLowerCase().replace(/\/+$/, '');
  if (req.method === 'POST' && NEEDS_CONSENT.has(path) && consentFor(req.ctx) && req.get('x-vantage-consent') !== '1') {
    return next(forbidden('Read and accept the notice before signing in.', 'consent_required'));
  }
  next();
});

authRouter.post('/setup', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const limited = limiters.loginIp.limited(ip);
  if (limited) throw tooMany('Too many attempts from this connection. Try again later.', limited.retryAfter);
  if (userCount(ctx) > 0) throw conflict('Vantage is already set up.', 'already_setup');
  if (ctx.config.production) {
    const supplied = String(req.get('x-vantage-setup-token') || req.body?.setup_token || '');
    if (!safeEqual(sha256(supplied), sha256(ctx.config.setupToken))) { limiters.loginIp.bump(ip); throw forbidden('The deployment setup token is incorrect.', 'setup_locked'); }
  }
  const body = parse(setupSchema, req.body);
  const unitId = slug(body.unit_short_name || body.unit_name);
  if (!unitId) throw badRequest('That unit name produces an empty code.', { fieldErrors: { unit_name: 'Use letters or numbers.' } });
  const id = newId();
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, middle_initial, rank_id, mos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.username, body.email || null, hashPassword(body.password), body.first_name, body.last_name, body.middle_initial || null, body.rank_id || null, body.mos || null, now(), now());
    // The first account owns the service, and the first organization (its first unit founds it, ADR-0006).
    ctx.db.prepare("INSERT INTO platform_roles (user_id, role, granted_by, created_at) VALUES (?, 'owner', NULL, ?)").run(id, now());
    ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(unitId, unitId, body.unit_name, body.unit_short_name || null, 'command', now());
    claimUnit(ctx, unitId, id);
    ctx.db.prepare("INSERT INTO org_roles (org_id, user_id, role, granted_by, created_at) SELECT org_id, ?, 'owner', NULL, ? FROM units WHERE id = ?").run(id, now(), unitId);
    ctx.db.prepare('UPDATE organizations SET created_by = ? WHERE id = (SELECT org_id FROM units WHERE id = ?)').run(id, unitId);
  })();
  audit(ctx, { actor_id: id, action: 'setup', entity: 'platform', unit_id: unitId, ip });
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return finishSignIn(req, res, user, 'password', 'setup');
}));

authRouter.post('/register', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  if (ctx.config.cac.exclusive) throw forbidden('Vantage requires a CAC here. Accounts are created from your Unit Instance’s personnel roster.', 'cac_required');
  if (ctx.config.oidc.exclusive) throw forbidden(`Vantage signs in through your organization here. Use ${ctx.config.oidc.label}.`, 'oidc_required');
  if (!ctx.runtime.selfRegistration) throw notFound('Self-registration is not enabled. Ask a leader for an invitation.');
  if (userCount(ctx) === 0) throw conflict('The deployment must be initialized before accounts can self-register.', 'setup_required');
  const limited = limiters.registerIp.limited(ip);
  if (limited) throw tooMany('Too many accounts were requested from this connection. Try again later.', limited.retryAfter, 'registration_throttled');
  limiters.registerIp.bump(ip);
  const body = parse(registrationSchema, req.body);
  if (body.rank_id && !ctx.db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) throw badRequest('No such rank.', { fieldErrors: { rank_id: 'No such rank.' } });
  if (body.email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(body.email)) throw badRequest('That email is already in use.', { fieldErrors: { email: 'Already in use.' } });
  const id = newId();
  try {
    ctx.db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, middle_initial, rank_id, mos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, body.username, body.email || null, hashPassword(body.password), body.first_name, body.last_name, body.middle_initial || null, body.rank_id || null, body.mos || null, now(), now());
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) throw badRequest('That username is unavailable.', { fieldErrors: { username: 'That username is unavailable.' } });
    throw error;
  }
  audit(ctx, { actor_id: id, action: 'self_register', entity: 'user', entity_id: id, subject_id: id, ip });
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return finishSignIn(req, res, user, 'password', 'register');
}));

const loginSchema = z.object({ username: z.string().max(40), password: z.string().max(512) });

authRouter.post('/login', wrap(async (req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  if (ctx.config.cac.exclusive) throw forbidden('Vantage requires a CAC here. Sign in with your card.', 'cac_required');
  if (ctx.config.oidc.exclusive) throw forbidden(`Vantage signs in through your organization here. Use ${ctx.config.oidc.label}.`, 'oidc_required');
  const { username, password } = parse(loginSchema, req.body);
  const name = username.trim().toLowerCase();
  const ipLimit = limiters.loginIp.limited(ip);
  if (ipLimit) throw tooMany('Too many sign-in attempts from this connection. Try again later.', ipLimit.retryAfter);
  // Names that match no account are throttled in memory; real accounts lock in the database.
  const userLimit = name ? limiters.loginUser.limited(name) : null;
  const row = ctx.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(name) as UserRow | undefined;
  if (!row) {
    assertNameNotLocked(ctx, name);
    await burnVerification(password);
    limiters.loginIp.bump(ip);
    if (name) limiters.loginUser.bump(name);
    if (userLimit) throw tooMany('Too many failed attempts for this account. Try again later.', userLimit.retryAfter);
    if (name) recordNameFailure(ctx, name);
    throw unauthorized('Username or password is incorrect.', 'bad_credentials');
  }
  assertNotLocked(ctx, row.id);
  if (!(await verifyPassword(password, row.password_hash))) {
    limiters.loginIp.bump(ip);
    if (recordFailure(ctx, row.id, { ip, where: 'password' })) assertNotLocked(ctx, row.id);
    throw unauthorized('Username or password is incorrect.', 'bad_credentials');
  }
  rehashIfOld(ctx, row.id, password, row.password_hash);
  if (row.totp_enabled) {
    const mfaLimit = limiters.mfaUser.limited(row.id);
    if (mfaLimit) throw tooMany('Too many second-factor failures for this account. Try again later.', mfaLimit.retryAfter);
    const { token } = issueToken(ctx, 'login_mfa', { userId: row.id, ttlMinutes: 5, payload: { ip } });
    return res.json({ ok: false, mfa: 'totp', challenge: token });
  }
  return finishSignIn(req, res, row, 'password');
}));

authRouter.post('/login/mfa', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const { challenge, code } = parse(z.object({ challenge: z.string().max(200), code: z.string().max(20) }), req.body);
  const key = sha256(challenge).slice(0, 16);
  const limited = limiters.mfaToken.limited(key);
  if (limited) throw tooMany('Too many codes tried. Sign in again.', limited.retryAfter);
  const pending = peekToken(ctx, 'login_mfa', challenge);
  if (!pending?.user_id) throw unauthorized('The sign-in challenge expired. Start again.', 'challenge_expired');
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(pending.user_id) as UserRow | undefined;
  if (!row) throw unauthorized('The sign-in challenge expired. Start again.', 'challenge_expired');
  const accountLimit = limiters.mfaUser.limited(row.id);
  if (accountLimit) throw tooMany('Too many second-factor failures for this account. Try again later.', accountLimit.retryAfter);
  assertNotLocked(ctx, row.id);
  const secret = row.totp_secret ? decryptSecret(secretsOf(ctx.config), row.totp_secret) : null;
  const clean = code.replace(/\s+/g, '').toLowerCase();
  const step = secret ? matchTotp(secret, clean) : null;
  let ok = step !== null && ctx.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND COALESCE(totp_last_step, -1) < ?').run(step, row.id, step).changes === 1;
  if (!ok && /^[a-f0-9]{5}-?[a-f0-9]{5}$/.test(clean)) {
    const normalized = clean.includes('-') ? clean : `${clean.slice(0, 5)}-${clean.slice(5)}`;
    const rc = ctx.db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(row.id, sha256(`recovery:${normalized}`)) as { id: string } | undefined;
    if (rc) { ctx.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now(), rc.id); ok = true; audit(ctx, { actor_id: row.id, action: 'recovery_code_used', ip }); }
  }
  if (!ok) {
    limiters.mfaToken.bump(key);
    limiters.loginIp.bump(ip);
    limiters.mfaUser.bump(row.id);
    if (recordFailure(ctx, row.id, { ip, where: 'second_factor' })) { consumeToken(ctx, 'login_mfa', challenge); assertNotLocked(ctx, row.id); }
    throw unauthorized('That code is not valid.', 'bad_code');
  }
  limiters.mfaUser.clear(row.id);
  consumeToken(ctx, 'login_mfa', challenge);
  return finishSignIn(req, res, row, 'password+totp');
}));

authRouter.post('/passkey/options', wrap(async (req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const limited = limiters.loginIp.limited(ip);
  if (limited) throw tooMany('Too many sign-in attempts from this connection. Try again later.', limited.retryAfter);
  limiters.loginIp.bump(ip);
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 40) : null;
  const { options, key } = await authenticationOptions(ctx, username || null);
  res.json({ options, key });
}));

authRouter.post('/passkey/verify', wrap(async (req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const { key, response } = req.body || {};
  if (typeof key !== 'string' || !response || typeof response !== 'object') throw badRequest('A passkey response is required.');
  let result;
  try { result = await completeAuthentication(ctx, response, key); }
  catch (error) { limiters.loginIp.bump(ip); throw unauthorized((error as Error).message, 'passkey_failed'); }
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(result.userId) as UserRow | undefined;
  if (!row) throw unauthorized('That account is not active.', 'inactive');
  return finishSignIn(req, res, row, 'passkey');
}));

authRouter.post('/logout', requireAuth, wrap((req, res) => {
  destroySession(req.ctx, req.sessionId);
  audit(req.ctx, { actor_id: req.user.id, action: 'logout', ip: clientIp(req) });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(SIGNED_IN_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

/** Step-up authentication for sensitive settings. */
authRouter.post('/sudo', requireAuth, wrap(async (req, res) => {
  const ctx = req.ctx;
  const { password } = parse(z.object({ password: z.string().max(512) }), req.body);
  // Failures here count toward the same lockout as sign-in: a stolen session must not become a way to guess the password.
  try { assertNotLocked(ctx, req.user.id); } catch (e) { record(ctx, 'security.step_up', { granted: false, method: 'password' }, { id: req.user.id }); throw e; }
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as { password_hash: string };
  if (!(await verifyPassword(password, row.password_hash))) {
    record(ctx, 'security.step_up', { granted: false, method: 'password' }, { id: req.user.id });
    if (recordFailure(ctx, req.user.id, { ip: clientIp(req), where: 'step_up' })) assertNotLocked(ctx, req.user.id);
    throw forbidden('Current password is incorrect.', 'bad_password');
  }
  clearFailures(ctx, req.user.id);
  rehashIfOld(ctx, req.user.id, password, row.password_hash);
  const until = grantSudo(ctx, req.sessionId);
  record(ctx, 'security.step_up', { granted: true, method: 'password' }, { id: req.user.id });
  res.json({ ok: true, until });
}));

authRouter.post('/forgot', wrap(async (req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const limited = limiters.resetIp.limited(ip);
  if (limited) throw tooMany('Too many reset requests. Try again later.', limited.retryAfter);
  limiters.resetIp.bump(ip);
  const { identifier } = parse(z.object({ identifier: z.string().trim().max(254) }), req.body);
  const lookup = identifier.toLowerCase();
  const row = ctx.db.prepare('SELECT id, username, email, first_name FROM users WHERE active = 1 AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE)').get(lookup, lookup) as { id: string; username: string; email: string | null; first_name: string } | undefined;
  // Always respond the same way; never confirm whether an account exists.
  if (row?.email && ctx.mailer.enabled && !limiters.resetUser.limited(row.id)) {
    limiters.resetUser.bump(row.id);
    revokeTokens(ctx, 'reset', row.id);
    const { token } = issueToken(ctx, 'reset', { userId: row.id, email: row.email, ttlMinutes: 30, payload: { ip } });
    const url = `${ctx.config.urls.app}/reset?token=${encodeURIComponent(token)}`;
    const mail = layout({
      eyebrow: 'Account recovery',
      title: 'Reset your password',
      preheader: 'A one-time link to choose a new Vantage password. It works for 30 minutes.',
      intro: `${row.first_name}, someone asked to reset the password for your Vantage account. Choose a new one with the button below.`,
      details: [{ label: 'Username', value: row.username, mono: true }],
      cta: { label: 'Choose a new password', url },
      note: 'This link works once and expires in 30 minutes. If you did not ask for it, ignore this message: your password stays as it is.',
      footer: 'Vantage sent this because a password reset was requested for your account.',
      origin: ctx.config.urls.app,
    });
    audit(ctx, { actor_id: row.id, action: 'password_reset_requested', subject_id: row.id, ip });
    void ctx.mailer.send({ to: row.email, subject: 'Reset your Vantage password', text: mail.text, html: mail.html, kind: 'reset', userId: row.id }).catch(() => undefined);
  }
  res.json({ ok: true, emailEnabled: ctx.mailer.enabled });
}));

authRouter.get('/reset', wrap((req, res) => {
  const token = String(req.query.token || '');
  const pending = peekToken(req.ctx, 'reset', token);
  // A sign-in link's email already told its holder the username; saying it again on the page is what makes it usable.
  const signIn = pending?.payload.purpose === 'sign_in' && pending.user_id
    ? req.ctx.db.prepare('SELECT username FROM users WHERE id = ? AND active = 1').get(pending.user_id) as { username: string } | undefined
    : undefined;
  res.json({
    valid: Boolean(pending), email: pending?.email ? pending.email.replace(/^(.).*(@.*)$/, '$1***$2') : null,
    ...(signIn ? { purpose: 'sign_in', username: signIn.username, expiresAt: pending!.expires_at } : {}),
  });
}));

authRouter.post('/reset', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const { token, password } = parse(z.object({ token: z.string().max(200), password: passwordField }), req.body);
  const pending = consumeToken(ctx, 'reset', token);
  if (!pending?.user_id) throw badRequest('That reset link is invalid or has expired. Request a new one.');
  ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hashPassword(password), now(), pending.user_id);
  // A reset link proves the mailbox, so it is also the way out of a lock somebody else's guesses put on the account.
  clearFailures(ctx, pending.user_id);
  invalidateUserSessions(ctx, pending.user_id);
  audit(ctx, { actor_id: pending.user_id, action: 'password_reset', subject_id: pending.user_id, ip });
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(pending.user_id) as UserRow | undefined;
  if (!row) throw badRequest('That account is not active.');
  if (row.totp_enabled) {
    const { token: challenge } = issueToken(ctx, 'login_mfa', { userId: row.id, ttlMinutes: 5, payload: { ip } });
    return res.json({ ok: false, mfa: 'totp', challenge });
  }
  return finishSignIn(req, res, row, 'password', 'password_reset_login');
}));

authRouter.get('/invite', wrap((req, res) => {
  const ctx = req.ctx;
  const pending = peekToken(ctx, 'invite', String(req.query.token || ''));
  if (!pending) return res.json({ valid: false });
  const unit = pending.payload.unit_id ? (ctx.db.prepare('SELECT name, short_name FROM units WHERE id = ?').get(String(pending.payload.unit_id)) as { name: string; short_name: string | null } | undefined) : undefined;
  const inviter = pending.created_by ? (ctx.db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(pending.created_by) as { first_name: string; last_name: string } | undefined) : undefined;
  res.json({ valid: true, email: pending.email, unit: unit ? unit.short_name || unit.name : null, invitedBy: inviter ? `${inviter.first_name} ${inviter.last_name}` : null, suggested: pending.payload });
}));

authRouter.post('/invite/accept', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const body = parse(z.object({ token: z.string().max(200), username: usernameField, password: passwordField, first_name: z.string().trim().min(1).max(80), last_name: z.string().trim().min(1).max(80), rank_id: z.string().max(12).nullish(), mos: z.string().max(12).nullish(), email: emailField.optional() }), req.body);
  const pending = peekToken(ctx, 'invite', body.token);
  if (!pending) throw badRequest('That invitation is invalid or has expired. Ask your leader for a new one.');
  if (ctx.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(body.username)) throw badRequest('That username is taken.', { fieldErrors: { username: 'Unavailable.' } });
  if (body.rank_id && !ctx.db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) throw badRequest('No such rank.', { fieldErrors: { rank_id: 'No such rank.' } });
  const email = pending.email || body.email || null;
  const id = newId();
  try {
    ctx.db.transaction(() => {
      if (!consumeToken(ctx, 'invite', body.token)) throw badRequest('That invitation was just used. Ask your leader for a new one.');
      ctx.db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, rank_id, mos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, body.username, email, hashPassword(body.password), body.first_name, body.last_name, body.rank_id || null, body.mos || null, now(), now());
      const unitId = pending.payload.unit_id ? String(pending.payload.unit_id) : null;
      if (unitId && ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) {
        addMember(ctx, id, unitId, { invitedBy: pending.created_by, primary: true, billet: pending.payload.billet ? String(pending.payload.billet) : null });
        const roleId = pending.payload.role_id ? String(pending.payload.role_id) : null;
        if (roleId && ctx.db.prepare('SELECT 1 FROM roles WHERE id = ? AND unit_id = ?').get(roleId, unitId)) {
          ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, roleId, unitId, pending.created_by, now());
        }
      }
    })();
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) throw badRequest('That username or email is already in use.', { fieldErrors: { username: 'Unavailable.' } });
    throw error;
  }
  audit(ctx, { actor_id: id, action: 'invite_accepted', entity: 'user', entity_id: id, subject_id: id, unit_id: pending.payload.unit_id ? String(pending.payload.unit_id) : null, ip });
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return finishSignIn(req, res, row, 'password', 'invite_login');
}));

/** Where a failed organization sign-in lands: the sign-in page of the face it started from, with the reason. */
function signInPage(req: Request, res: Response, code: string): string {
  const faces = facesOf(res);
  const base = faces.has('console') && !faces.has('app') ? '/' : '/login';
  return `${base}?sso_error=${encodeURIComponent(code)}`;
}

/** A path on this host to return to after signing in; anything else (another host, a scheme) is ignored. */
const localPath = (value: unknown): string | null => {
  const v = typeof value === 'string' ? value : '';
  return /^\/(?!\/)[^\\\s]*$/.test(v) ? v.slice(0, 300) : null;
};

/** Sends the browser to the organization's identity provider. */
authRouter.get('/oidc/start', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!ctx.config.oidc.enabled) throw notFound('Organization sign-in is not enabled here.');
  const ip = clientIp(req);
  const limited = limiters.loginIp.limited(ip);
  if (limited) return res.redirect(302, signInPage(req, res, 'throttled'));
  limiters.loginIp.bump(ip);
  const consented = req.query.consent === '1';
  // The notice is accepted on the sign-in page before the browser leaves for the provider; the answer rides in the state.
  if (consentFor(ctx) && !consented) return res.redirect(302, signInPage(req, res, 'consent_required'));
  const faces = facesOf(res);
  const face = faces.has('console') && !faces.has('app') ? 'console' : 'app';
  try {
    res.redirect(302, await startSignIn(ctx, { face, consented, returnTo: localPath(req.query.return) }));
  } catch (error) {
    if (!(error instanceof OidcError)) throw error;
    audit(ctx, { action: 'oidc_rejected', ip, detail: `${error.code}: ${error.message}`.slice(0, 300) });
    res.redirect(302, signInPage(req, res, error.code));
  }
}));

/** The provider sends the browser back here with a code; on success a session is opened and the browser goes on. */
authRouter.get('/oidc/callback', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!ctx.config.oidc.enabled) throw notFound('Organization sign-in is not enabled here.');
  const ip = clientIp(req);
  const q = req.query as Record<string, string | undefined>;
  try {
    const done = await completeSignIn(ctx, { code: q.code, state: q.state, error: q.error, error_description: q.error_description });
    const account = resolveOidcAccount(ctx, done.claims);
    if (account.linked) audit(ctx, { actor_id: account.userId, action: account.provisioned ? 'oidc_provisioned' : 'oidc_linked', subject_id: account.userId, ip, detail: `${done.claims.iss} ${done.claims.sub}`.slice(0, 300) });
    const user = ctx.db.prepare('SELECT id, must_change_password FROM users WHERE id = ? AND active = 1').get(account.userId) as { id: string; must_change_password: number } | undefined;
    if (!user) throw new OidcError('That account is not active.', 'oidc_inactive');
    openSession(req, res, user, 'oidc', 'login', { consented: done.consented });
    res.redirect(302, done.returnTo || '/');
  } catch (error) {
    const code = error instanceof OidcError ? error.code : error instanceof HttpError ? error.code : null;
    if (!code) throw error;
    limiters.loginIp.bump(ip);
    // The owner reads the reason in the audit log; the browser is only told the code.
    audit(ctx, { action: 'oidc_rejected', ip, detail: `${code}: ${(error as Error).message}`.slice(0, 300) });
    res.redirect(302, signInPage(req, res, code));
  }
}));

authRouter.post('/cac', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  if (ctx.config.cac.mode === 'off') throw notFound('Certificate sign-in is not enabled here.');

  const limited = limiters.loginIp.limited(ip);
  if (limited) throw tooMany('Too many sign-in attempts from this connection. Try again later.', limited.retryAfter);

  let identity;
  try {
    identity = presentedCertificate(req, ctx.config.cac);
  } catch (error) {
    limiters.loginIp.bump(ip);
    if (error instanceof CacError) {
      audit(ctx, { action: 'cac_rejected', ip, detail: error.code });
      throw unauthorized(error.message, error.code);
    }
    throw error;
  }
  if (!identity) {
    throw unauthorized('No card was presented. Check the card is in the reader, then try again.', 'cac_no_certificate');
  }

  let resolution;
  try {
    resolution = resolveAccount(ctx, identity);
  } catch (error) {
    if (error instanceof CacError) {
      limiters.loginIp.bump(ip);
      audit(ctx, { action: 'cac_rejected', ip, detail: `${error.code} edipi=${identity.edipi}` });
      throw unauthorized(error.message, error.code);
    }
    throw error;
  }

  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(resolution.userId) as UserRow | undefined;
  if (!row) throw unauthorized('That account is not active.', 'cac_inactive');

  limiters.loginIp.clear(ip);
  if (resolution.provisioned) {
    audit(ctx, { actor_id: row.id, action: 'cac_provisioned', subject_id: row.id, ip, detail: `edipi=${identity.edipi} from roster` });
  }
  audit(ctx, {
    actor_id: row.id, action: 'cac_verified', ip,
    detail: `edipi=${identity.edipi} cn=${identity.commonName ?? '—'} issuer=${identity.issuer ?? '—'} serial=${identity.serial ?? '—'}`,
  });
  return finishSignIn(req, res, row, 'cac');
}));
