import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { HttpError, badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from '../lib/errors.ts';
import { registrationSchema, setupSchema, passwordField, usernameField, emailField } from '../../shared/schemas.ts';
import { hashPassword, verifyPassword, burnVerification, safeEqual, decryptSecret, sha256 } from '../lib/crypto.ts';
import { limiters } from '../auth/limiter.ts';
import { createSession, destroySession, invalidateUserSessions, SESSION_COOKIE, SIGNED_IN_COOKIE, grantSudo } from '../auth/sessions.ts';
import { requireAuth } from '../auth/middleware.ts';
import { issueToken, consumeToken, peekToken, revokeTokens } from '../auth/tokens.ts';
import { verifyTotp } from '../auth/totp.ts';
import { authenticationOptions, completeAuthentication } from '../auth/passkeys.ts';
import { audit } from '../services/audit.ts';
import { layout } from '../services/email.ts';
import { newId, now } from '../lib/ids.ts';
import { claimUnit, addMember } from '../services/org.ts';
import { slug } from '../lib/ids.ts';
import type { Request, Response } from 'express';
import type { AppContext } from '../context.ts';

export const authRouter = Router();

interface UserRow { id: string; username: string; email: string | null; first_name: string; last_name: string; password_hash: string; totp_enabled: number; totp_secret: string | null; must_change_password: number; active: number; is_operator: number }

function cookieOptions(req: Request) {
  const secure = req.ctx.config.production || req.secure;
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/' };
}

export function finishSignIn(req: Request, res: Response, user: { id: string; must_change_password: number }, method: string, action = 'login') {
  const ctx = req.ctx;
  const { token, expires } = createSession(ctx, user.id, { ip: clientIp(req), userAgent: req.get('user-agent'), method, sudo: true });
  audit(ctx, { actor_id: user.id, action, ip: clientIp(req), detail: method });
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  res.cookie(SIGNED_IN_COOKIE, '1', { ...cookieOptions(req), httpOnly: false });
  const body: Record<string, unknown> = { ok: true, expires, mustChangePassword: Boolean(user.must_change_password) };
  if (ctx.config.test) body.token = token;
  return res.json(body);
}

function userCount(ctx: AppContext) { return (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n; }

authRouter.get('/setup', wrap((req, res) => {
  const ctx = req.ctx;
  res.json({
    needsSetup: userCount(ctx) === 0,
    requiresSetupToken: ctx.config.production && userCount(ctx) === 0,
    selfRegistration: ctx.runtime.selfRegistration,
    emailEnabled: ctx.mailer.enabled,
    displayName: ctx.runtime.displayName,
    announcement: ctx.runtime.announcement,
    maintenance: ctx.runtime.maintenance,
  });
}));

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
    ctx.db.prepare(`INSERT INTO users (id, username, email, password_hash, first_name, last_name, middle_initial, rank_id, mos, is_operator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, body.username, body.email || null, hashPassword(body.password), body.first_name, body.last_name, body.middle_initial || null, body.rank_id || null, body.mos || null, now(), now());
    ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(unitId, unitId, body.unit_name, body.unit_short_name || null, 'command', now());
    claimUnit(ctx, unitId, id);
  })();
  audit(ctx, { actor_id: id, action: 'setup', entity: 'instance', unit_id: unitId, ip });
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  return finishSignIn(req, res, user, 'password', 'setup');
}));

authRouter.post('/register', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
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

authRouter.post('/login', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const { username, password } = parse(loginSchema, req.body);
  const name = username.trim().toLowerCase();
  const ipLimit = limiters.loginIp.limited(ip);
  if (ipLimit) throw tooMany('Too many sign-in attempts from this connection. Try again later.', ipLimit.retryAfter);
  const userLimit = name ? limiters.loginUser.limited(name) : null;
  const row = ctx.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(name) as UserRow | undefined;
  if (!row || !verifyPassword(password, row?.password_hash)) {
    if (!row) burnVerification(password);
    limiters.loginIp.bump(ip);
    if (name) {
      const e = limiters.loginUser.bump(name);
      if (row && e.count === 10) audit(ctx, { actor_id: row.id, action: 'login_lockout', ip, detail: 'failed-attempt threshold reached' });
    }
    if (userLimit) throw tooMany('Too many failed attempts for this account. Try again later.', userLimit.retryAfter);
    throw unauthorized('Username or password is incorrect.', 'bad_credentials');
  }
  if (userLimit) throw tooMany('Too many failed attempts for this account. Try again later.', userLimit.retryAfter);
  limiters.loginUser.clear(name);
  if (row.totp_enabled) {
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
  const secret = row.totp_secret ? decryptSecret(ctx.config.secret, row.totp_secret) : null;
  const clean = code.replace(/\s+/g, '').toLowerCase();
  let ok = Boolean(secret) && verifyTotp(secret!, clean);
  if (!ok && /^[a-f0-9]{5}-?[a-f0-9]{5}$/.test(clean)) {
    const normalized = clean.includes('-') ? clean : `${clean.slice(0, 5)}-${clean.slice(5)}`;
    const rc = ctx.db.prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(row.id, sha256(`recovery:${normalized}`)) as { id: string } | undefined;
    if (rc) { ctx.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now(), rc.id); ok = true; audit(ctx, { actor_id: row.id, action: 'recovery_code_used', ip }); }
  }
  if (!ok) { limiters.mfaToken.bump(key); throw unauthorized('That code is not valid.', 'bad_code'); }
  consumeToken(ctx, 'login_mfa', challenge);
  return finishSignIn(req, res, row, 'password+totp');
}));

authRouter.post('/passkey/options', wrap(async (req, res) => {
  const ctx = req.ctx;
  const limited = limiters.loginIp.limited(clientIp(req));
  if (limited) throw tooMany('Too many sign-in attempts from this connection. Try again later.', limited.retryAfter);
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
authRouter.post('/sudo', requireAuth, wrap((req, res) => {
  const ctx = req.ctx;
  const { password } = parse(z.object({ password: z.string().max(512) }), req.body);
  const row = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as { password_hash: string };
  if (!verifyPassword(password, row.password_hash)) { limiters.loginUser.bump(req.user.username); throw forbidden('Current password is incorrect.', 'bad_password'); }
  const until = grantSudo(ctx, req.sessionId);
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
  if (row?.email && ctx.mailer.enabled) {
    revokeTokens(ctx, 'reset', row.id);
    const { token } = issueToken(ctx, 'reset', { userId: row.id, email: row.email, ttlMinutes: 30, payload: { ip } });
    const url = `${ctx.config.publicUrl}/reset?token=${encodeURIComponent(token)}`;
    const mail = layout({ title: 'Reset your Vantage password', intro: `${row.first_name}, someone asked to reset the password for ${row.username}. This link works for 30 minutes and only once. If that was not you, ignore this message.`, cta: { label: 'Choose a new password', url } });
    await ctx.mailer.send({ to: row.email, subject: 'Reset your Vantage password', text: mail.text, html: mail.html, kind: 'reset', userId: row.id });
    audit(ctx, { actor_id: row.id, action: 'password_reset_requested', subject_id: row.id, ip });
  }
  res.json({ ok: true, emailEnabled: ctx.mailer.enabled });
}));

authRouter.get('/reset', wrap((req, res) => {
  const token = String(req.query.token || '');
  const pending = peekToken(req.ctx, 'reset', token);
  res.json({ valid: Boolean(pending), email: pending?.email ? pending.email.replace(/^(.).*(@.*)$/, '$1***$2') : null });
}));

authRouter.post('/reset', wrap((req, res) => {
  const ctx = req.ctx;
  const ip = clientIp(req);
  const { token, password } = parse(z.object({ token: z.string().max(200), password: passwordField }), req.body);
  const pending = consumeToken(ctx, 'reset', token);
  if (!pending?.user_id) throw badRequest('That reset link is invalid or has expired. Request a new one.');
  ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hashPassword(password), now(), pending.user_id);
  invalidateUserSessions(ctx, pending.user_id);
  audit(ctx, { actor_id: pending.user_id, action: 'password_reset', subject_id: pending.user_id, ip });
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(pending.user_id) as UserRow | undefined;
  if (!row) throw badRequest('That account is not active.');
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
  const pending = consumeToken(ctx, 'invite', body.token);
  if (!pending) throw badRequest('That invitation is invalid or has expired. Ask your leader for a new one.');
  if (body.rank_id && !ctx.db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) throw badRequest('No such rank.', { fieldErrors: { rank_id: 'No such rank.' } });
  const email = pending.email || body.email || null;
  const id = newId();
  try {
    ctx.db.transaction(() => {
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

export function throwIfInactive(user: { active: number }) { if (!user.active) throw new HttpError(403, 'That account is deactivated.', 'inactive'); }
