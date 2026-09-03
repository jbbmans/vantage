import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { requireAuth, requireSudo } from '../auth/middleware.ts';
import { scopeFor, unitsWith, PERMISSIONS, can, detailUnitsFor } from '../authz/scope.ts';
import { profileSchema, passwordField, readinessSchema, prefsSchema, emailField } from '../../shared/schemas.ts';
import { hashPassword, verifyPassword, encryptSecret, decryptSecret, sha256 } from '../lib/crypto.ts';
import { invalidateUserSessions, listSessions, revokeSessionByPrefix, SESSION_COOKIE, SIGNED_IN_COOKIE } from '../auth/sessions.ts';
import { generateTotpSecret, otpauthUrl, verifyTotp, generateRecoveryCodes } from '../auth/totp.ts';
import { registrationOptions, completeRegistration, listPasskeys, deletePasskey } from '../auth/passkeys.ts';
import { issueToken, consumeToken } from '../auth/tokens.ts';
import { audit } from '../services/audit.ts';
import { layout } from '../services/email.ts';
import { newId, now } from '../lib/ids.ts';
import { ancestorIds } from '../services/org.ts';
import { PERMISSION_LIST } from '../../shared/permissions.ts';
import { composeDigest, sendDigest } from '../services/digest.ts';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const rank = req.user.rank_id ? ctx.db.prepare('SELECT * FROM ranks WHERE id = ?').get(req.user.rank_id) : null;
  const passkeys = (ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(req.user.id) as { n: number }).n;
  let prefs = {};
  try { prefs = JSON.parse(req.user.prefs || '{}'); } catch {}
  const { prefs: _p, ...user } = req.user;
  res.json({
    user: { ...user, rank, passkeys },
    prefs,
    memberships: scope.memberships,
    primaryUnitId: scope.primaryUnitId,
    unitIds: scope.unitIds,
    readableUnitIds: scope.readableUnitIds,
    ownedUnitIds: scope.ownedUnitIds,
    permissions: scope.permissions,
    positions: scope.positions,
    roles: scope.roles,
    canLead: scope.readableUnitIds.length > 0,
    manageableUnits: unitsWith(scope, PERMISSIONS.MANAGE_UNITS),
    counselUnits: unitsWith(scope, PERMISSIONS.COUNSEL),
    exportUnits: unitsWith(scope, PERMISSIONS.EXPORT_DATA),
    session: { id: req.sessionId.slice(0, 12), method: req.sessionRow.method, sudoUntil: req.sessionRow.sudo_until },
    instance: { displayName: ctx.runtime.displayName, organizationName: ctx.runtime.organizationName, announcement: ctx.runtime.announcement, emailEnabled: ctx.mailer.enabled, attachmentsEnabled: ctx.runtime.attachmentsEnabled, aiEnabled: ctx.runtime.aiEnabled && Boolean(ctx.config.ai.apiKey), maradminsEnabled: ctx.runtime.maradminsEnabled },
  });
}));

meRouter.get('/org', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const ids = req.user.is_operator ? (ctx.db.prepare('SELECT id FROM units WHERE active = 1').all() as Array<{ id: string }>).map((r) => r.id) : ancestorIds(ctx, scope.unitIds);
  const units = ids.length ? ctx.db.prepare(`SELECT * FROM units WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids) : [];
  const roles = scope.unitIds.length ? ctx.db.prepare(`SELECT * FROM roles WHERE unit_id IN (${scope.unitIds.map(() => '?').join(',')}) ORDER BY position DESC, name`).all(...scope.unitIds) : [];
  res.json({ ranks: ctx.db.prepare('SELECT * FROM ranks ORDER BY sort').all(), units, roles, permissionCatalogue: PERMISSION_LIST.map((p) => ({ ...p, bit: PERMISSIONS[p.key] })) });
}));

meRouter.put('/profile', wrap((req, res) => {
  const ctx = req.ctx;
  const body = parse(profileSchema, req.body);
  if (body.email !== undefined && body.email !== req.user.email) {
    if (!req.sessionRow.sudo_until || new Date(req.sessionRow.sudo_until).getTime() < Date.now()) throw forbidden('Confirm your password to change your email.', 'sudo_required');
    if (body.email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(body.email, req.user.id)) throw badRequest('That email is already in use.', { fieldErrors: { email: 'Already in use.' } });
  }
  if (body.rank_id && !ctx.db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) throw badRequest('No such rank.', { fieldErrors: { rank_id: 'No such rank.' } });
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
  if (!sets.length) return res.json({ ok: true, changed: [] });
  ctx.db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), req.user.id);
  audit(ctx, { actor_id: req.user.id, action: 'edit_profile', entity: 'user', entity_id: req.user.id, subject_id: req.user.id, detail: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined).join(', '), ip: clientIp(req) });
  res.json({ ok: true, changed: sets.map((s) => s.split(' ')[0]) });
}));

meRouter.get('/prefs', wrap((req, res) => { let prefs = {}; try { prefs = JSON.parse(req.user.prefs || '{}'); } catch {} res.json(prefs); }));

meRouter.put('/prefs', wrap((req, res) => {
  const ctx = req.ctx;
  const patch = parse(prefsSchema, req.body);
  let prefs: Record<string, unknown> = {};
  try { prefs = JSON.parse(req.user.prefs || '{}'); } catch {}
  const merged = { ...prefs, ...patch };
  ctx.db.prepare('UPDATE users SET prefs = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), now(), req.user.id);
  res.json(merged);
}));

meRouter.post('/password', wrap((req, res) => {
  const ctx = req.ctx;
  const { current_password, new_password } = parse(z.object({ current_password: z.string().max(512), new_password: passwordField }), req.body);
  const stored = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as { password_hash: string };
  if (!verifyPassword(current_password, stored.password_hash)) throw forbidden('Current password is incorrect.', 'bad_password');
  if (current_password === new_password) throw badRequest('Choose a different password.', { fieldErrors: { new_password: 'Choose a different password.' } });
  ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hashPassword(new_password), now(), req.user.id);
  const revoked = invalidateUserSessions(ctx, req.user.id, req.sessionId);
  audit(ctx, { actor_id: req.user.id, action: 'password_change', detail: `other sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, otherSessionsRevoked: revoked });
}));

meRouter.get('/sessions', wrap((req, res) => res.json({ sessions: listSessions(req.ctx, req.user.id, req.sessionId) })));
meRouter.post('/sessions/revoke-others', wrap((req, res) => {
  const revoked = invalidateUserSessions(req.ctx, req.user.id, req.sessionId);
  audit(req.ctx, { actor_id: req.user.id, action: 'revoke_sessions', detail: `own other sessions: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, revoked });
}));
meRouter.delete('/sessions/:sid', wrap((req, res) => {
  const isCurrent = req.sessionId.startsWith(String(req.params.sid));
  const n = revokeSessionByPrefix(req.ctx, req.user.id, String(req.params.sid));
  if (!n) throw notFound('No such session.');
  if (isCurrent) { res.clearCookie(SESSION_COOKIE, { path: '/' }); res.clearCookie(SIGNED_IN_COOKIE, { path: '/' }); }
  res.json({ ok: true, current: isCurrent });
}));

// MFA: authenticator app --------------------------------------------------
meRouter.post('/mfa/totp/start', requireSudo, wrap(async (req, res) => {
  const ctx = req.ctx;
  const secret = generateTotpSecret();
  ctx.db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?').run(encryptSecret(ctx.config.secret, secret), now(), req.user.id);
  const url = otpauthUrl(secret, req.user.username, ctx.runtime.displayName || 'Vantage');
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
  res.json({ secret, otpauth: url, qr });
}));

meRouter.post('/mfa/totp/confirm', requireSudo, wrap((req, res) => {
  const ctx = req.ctx;
  const { code } = parse(z.object({ code: z.string().max(12) }), req.body);
  const row = ctx.db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(req.user.id) as { totp_secret: string | null };
  const secret = row.totp_secret ? decryptSecret(ctx.config.secret, row.totp_secret) : null;
  if (!secret) throw badRequest('Start authenticator setup first.');
  if (!verifyTotp(secret, code)) throw badRequest('That code did not match. Check the time on your device and try again.', { fieldErrors: { code: 'Incorrect code.' } });
  const codes = generateRecoveryCodes();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(now(), req.user.id);
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
    for (const c of codes) ctx.db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)').run(newId(), req.user.id, sha256(`recovery:${c}`));
  })();
  audit(ctx, { actor_id: req.user.id, action: 'mfa_enabled', detail: 'totp', ip: clientIp(req) });
  res.json({ ok: true, recoveryCodes: codes });
}));

meRouter.post('/mfa/totp/disable', requireSudo, wrap((req, res) => {
  const ctx = req.ctx;
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?').run(now(), req.user.id);
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
  })();
  audit(ctx, { actor_id: req.user.id, action: 'mfa_disabled', detail: 'totp', ip: clientIp(req) });
  res.json({ ok: true });
}));

meRouter.post('/mfa/recovery/regenerate', requireSudo, wrap((req, res) => {
  const ctx = req.ctx;
  if (!req.user.totp_enabled) throw badRequest('Enable an authenticator app first.');
  const codes = generateRecoveryCodes();
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
    for (const c of codes) ctx.db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)').run(newId(), req.user.id, sha256(`recovery:${c}`));
  })();
  audit(ctx, { actor_id: req.user.id, action: 'recovery_codes_regenerated', ip: clientIp(req) });
  res.json({ ok: true, recoveryCodes: codes });
}));

// Passkeys -------------------------------------------------------------
meRouter.get('/passkeys', wrap((req, res) => res.json({ passkeys: listPasskeys(req.ctx, req.user.id), rpId: req.ctx.config.rpId })));
meRouter.post('/passkeys/options', requireSudo, wrap(async (req, res) => res.json(await registrationOptions(req.ctx, req.user))));
meRouter.post('/passkeys', requireSudo, wrap(async (req, res) => {
  const { response, name } = req.body || {};
  if (!response || typeof response !== 'object') throw badRequest('A passkey response is required.');
  let saved;
  try { saved = await completeRegistration(req.ctx, req.user.id, response, String(name || 'Passkey')); }
  catch (error) { throw badRequest((error as Error).message); }
  audit(req.ctx, { actor_id: req.user.id, action: 'passkey_added', detail: saved.name, ip: clientIp(req) });
  res.status(201).json({ ok: true, passkey: saved, passkeys: listPasskeys(req.ctx, req.user.id) });
}));
meRouter.delete('/passkeys/:id', requireSudo, wrap((req, res) => {
  if (!deletePasskey(req.ctx, req.user.id, String(req.params.id))) throw notFound('No such passkey.');
  audit(req.ctx, { actor_id: req.user.id, action: 'passkey_removed', ip: clientIp(req) });
  res.json({ ok: true, passkeys: listPasskeys(req.ctx, req.user.id) });
}));

// Readiness ------------------------------------------------------------
const READINESS_SELECT = `SELECT r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.ceus, r.college_credits, r.degree, r.pme_complete, r.cmd_character, r.cmd_mos, r.cmd_leadership, r.fitrep_period_end, rk.grade AS rank_grade, rk.abbr AS rank_abbr
  FROM users u LEFT JOIN readiness r ON r.user_id = u.id LEFT JOIN ranks rk ON rk.id = u.rank_id WHERE u.id = ?`;

meRouter.get('/readiness', wrap((req, res) => res.json(req.ctx.db.prepare(READINESS_SELECT).get(req.user.id) || {})));
meRouter.put('/readiness', wrap((req, res) => {
  const ctx = req.ctx;
  const body = parse(readinessSchema, req.body);
  const entries = Object.entries(body).filter(([, v]) => v !== undefined);
  ctx.db.prepare('INSERT OR IGNORE INTO readiness (user_id, updated_at) VALUES (?, ?)').run(req.user.id, now());
  if (entries.length) ctx.db.prepare(`UPDATE readiness SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`).run(...entries.map(([, v]) => v), now(), req.user.id);
  res.json(ctx.db.prepare(READINESS_SELECT).get(req.user.id));
}));
meRouter.get('/readiness/:id', wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.id);
  if (id !== req.user.id) {
    const scope = scopeFor(ctx, req.user, req);
    const units = detailUnitsFor(ctx, scope, id);
    if (!units.length) throw forbidden('You cannot open that readiness record.');
    audit(ctx, { actor_id: req.user.id, action: 'view_readiness', entity: 'user', entity_id: id, subject_id: id, unit_id: units[0], ip: clientIp(req) });
  }
  res.json(ctx.db.prepare(READINESS_SELECT).get(id) || {});
}));

// Notifications --------------------------------------------------------
meRouter.get('/notifications', wrap((req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const rows = req.ctx.db.prepare('SELECT id, kind, title, message, action_url, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(req.user.id, limit);
  const unread = (req.ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id) as { n: number }).n;
  res.json({ rows, unread });
}));
meRouter.put('/notifications/:id/read', wrap((req, res) => {
  const r = req.ctx.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(now(), String(req.params.id), req.user.id);
  if (!r.changes) throw notFound('No such notification.');
  res.json({ ok: true });
}));
meRouter.post('/notifications/read-all', wrap((req, res) => {
  const r = req.ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
  res.json({ ok: true, updated: r.changes });
}));

// Audit trail about me ------------------------------------------------
meRouter.get('/audit', wrap((req, res) => {
  const rows = req.ctx.db.prepare(`SELECT al.id, al.action, al.entity, al.entity_id, al.detail, al.at, u.first_name, u.last_name, r.abbr AS rank_abbr FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN ranks r ON r.id = u.rank_id WHERE al.subject_id = ? AND al.actor_id <> ? ORDER BY al.seq DESC LIMIT 100`).all(req.user.id, req.user.id);
  res.json(rows);
}));

// Digest ----------------------------------------------------------------
meRouter.get('/digest/preview', wrap((req, res) => {
  const digest = composeDigest(req.ctx, { id: req.user.id, email: req.user.email, first_name: req.user.first_name, last_name: req.user.last_name, prefs: req.user.prefs, digest_last_sent_at: null });
  res.json({ subject: digest.subject, text: digest.text, stats: digest.stats, emailEnabled: req.ctx.mailer.enabled, hasEmail: Boolean(req.user.email) });
}));
meRouter.post('/digest/send-now', wrap(async (req, res) => {
  if (!req.ctx.mailer.enabled) throw badRequest('Email is not configured on this server.');
  if (!req.user.email) throw badRequest('Add an email address to your profile first.');
  const result = await sendDigest(req.ctx, { id: req.user.id, email: req.user.email, first_name: req.user.first_name, last_name: req.user.last_name, prefs: req.user.prefs, digest_last_sent_at: null });
  if (!result.ok) throw badRequest(result.error || 'The digest could not be sent.');
  res.json({ ok: true });
}));

// Email verification for a changed address --------------------------------
meRouter.post('/email/verify', requireSudo, wrap(async (req, res) => {
  const ctx = req.ctx;
  const { email } = parse(z.object({ email: emailField }), req.body);
  if (!ctx.mailer.enabled) throw badRequest('Email is not configured on this server.');
  if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, req.user.id)) throw badRequest('That email is already in use.', { fieldErrors: { email: 'Already in use.' } });
  const { token } = issueToken(ctx, 'email_change', { userId: req.user.id, email, ttlMinutes: 60 });
  const url = `${ctx.config.publicUrl}/settings?verify=${encodeURIComponent(token)}`;
  const mail = layout({ title: 'Confirm your email for Vantage', intro: `Confirm that ${email} belongs to ${req.user.username}. The link works for one hour.`, cta: { label: 'Confirm email', url } });
  const result = await ctx.mailer.send({ to: email, subject: 'Confirm your Vantage email', text: mail.text, html: mail.html, kind: 'email_change', userId: req.user.id });
  if (!result.ok) throw badRequest(result.error || 'The confirmation could not be sent.');
  res.json({ ok: true });
}));
meRouter.post('/email/confirm', wrap((req, res) => {
  const ctx = req.ctx;
  const { token } = parse(z.object({ token: z.string().max(200) }), req.body);
  const pending = consumeToken(ctx, 'email_change', token);
  if (!pending || pending.user_id !== req.user.id || !pending.email) throw badRequest('That confirmation link is invalid or has expired.');
  ctx.db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(pending.email, now(), req.user.id);
  audit(ctx, { actor_id: req.user.id, action: 'email_confirmed', subject_id: req.user.id, ip: clientIp(req) });
  res.json({ ok: true, email: pending.email });
}));

export { can };
