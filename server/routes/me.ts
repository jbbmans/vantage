import express, { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, forbidden, notFound, HttpError } from '../lib/errors.ts';
import { requireAuth, requireSudo } from '../auth/middleware.ts';
import { scopeFor, unitsWith, PERMISSIONS, detailUnitsFor, orgOfUnit } from '../authz/scope.ts';
import { profileSchema, passwordField, readinessSchema, prefsSchema, emailField, formEdipiSchema, fitnessReportSchema } from '../../shared/schemas.ts';
import { sourcedFieldsFor } from '../services/personnel.ts';
import { withPersonnelNote } from '../services/personnelRecords.ts';
import { hashPassword, verifyPassword, encryptSecret, decryptSecret, sha256 } from '../lib/crypto.ts';
import { secretsOf } from '../lib/keys.ts';
import { assertNotLocked, recordFailure, clearFailures } from '../auth/lockout.ts';
import { assertConfirmedProof, assertProofCurrent, credentialsChanged, invalidateUserSessions, listSessions, liveSession, revokeSessionByPrefix, sessionRef, SESSION_COOKIE, SIGNED_IN_COOKIE } from '../auth/sessions.ts';
import { generateTotpSecret, otpauthUrl, matchTotp, generateRecoveryCodes } from '../auth/totp.ts';
import { registrationOptions, completeRegistration, listPasskeys, deletePasskey } from '../auth/passkeys.ts';
import { issueToken, consumeToken, peekToken } from '../auth/tokens.ts';
import { mailAllowance } from '../auth/limiter.ts';
import { audit } from '../services/audit.ts';
import { auditQuery, auditRows, withoutEdipis, type AuditTrail } from '../services/auditQuery.ts';
import { EMAIL_CHANGE_SUBJECT, emailChangeMessage } from '../services/mailMessages.ts';
import { notSentMessage } from '../services/email.ts';
import { newId, now } from '../lib/ids.ts';
import { ancestorIds, orgSummaries, viewsFor } from '../services/org.ts';
import { PERMISSION_LIST } from '../../shared/permissions.ts';
import type { OrgResponse, Rank, Role, Unit } from '../../shared/types.ts';
import { composeDigest, sendDigest } from '../services/digest.ts';
import { unitSettingsOf } from '../services/unitConfig.ts';
import { buildPersonalExport, buildPersonalExportCsv, buildPersonalExportWorkbook, buildPersonalExportZip } from '../services/personalExport.ts';
import { cancelImport, commitImport, getImport, listImports, planImport, stageImport, undoImport } from '../services/recordImport.ts';
import { CATEGORY_KEYS } from '../../shared/recordTransfer.ts';
import { JEPES_READINESS_COLUMNS } from '../../shared/jepesEstimate.ts';
import { listOwnReports, listSharedReports, removeReport, saveReport, updateReport } from '../services/fitnessReports.ts';
import { demoStatus } from '../services/demo.ts';
import { listNotices, markAllRead } from '../services/notifications.ts';
import { myRequests } from '../services/comments.ts';
import { NOTICE_GROUPS } from '../../shared/notifications.ts';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const rank = req.user.rank_id ? ctx.db.prepare('SELECT * FROM ranks WHERE id = ?').get(req.user.rank_id) : null;
  const passkeys = (ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(req.user.id) as { n: number }).n;
  let prefs = {};
  try { prefs = JSON.parse(req.user.prefs || '{}'); } catch {}
  // The EDIPI goes out as where it comes from and its last four digits, never whole: the page needs no more (ADR-0033).
  const { prefs: _p, edipi: card, form_edipi: typed, form_edipi_at: _fa, ...user } = req.user as typeof req.user & { edipi?: string | null; form_edipi?: string | null; form_edipi_at?: string | null };
  const edipiOnFile = card ? { source: 'account' as const, last4: card.slice(-4) } : typed ? { source: 'typed' as const, last4: typed.slice(-4) } : null;
  // How this person can confirm it is them for a sensitive change: their password where one is set and accepted here,
  // their card where one is linked (ADR-0009). Neither means signing in again, which confirms it too.
  const credentials = ctx.db.prepare("SELECT password_hash <> '' AS has_password, edipi IS NOT NULL AS has_card FROM users WHERE id = ?").get(req.user.id) as { has_password: number; has_card: number };
  const stepUp = [
    ...(credentials.has_password && !ctx.config.cac.exclusive ? ['password' as const] : []),
    ...(credentials.has_card && ctx.config.cac.mode !== 'off' ? ['cac' as const] : []),
  ];
  // Where the person's own Unit Instance opens reports when they have not chosen (ADR-0012): the one holding their primary unit.
  const homeOrg = scope.primaryUnitId ? orgOfUnit(ctx, scope.primaryUnitId) : null;
  res.json({
    user: { ...user, rank, passkeys, edipi_on_file: edipiOnFile },
    prefs,
    unitDefaults: { reportPeriod: homeOrg ? unitSettingsOf(ctx, homeOrg).reports.defaultPeriod : null },
    memberships: scope.memberships,
    primaryUnitId: scope.primaryUnitId,
    homeUnitId: scope.homeUnitId,
    unitIds: scope.unitIds,
    readableUnitIds: scope.readableUnitIds,
    viewableUnitIds: scope.viewableUnitIds,
    ...viewsFor(ctx, scope),
    ownedUnitIds: scope.ownedUnitIds,
    permissions: scope.permissions,
    positions: scope.positions,
    roles: scope.roles,
    canLead: scope.readableUnitIds.length > 0,
    // The three tiers (ADR-0006): the organizations this person runs, and the platform roles of Vantage staff.
    orgs: orgSummaries(ctx, scope),
    platform: { roles: req.user.platform, permissions: req.user.platformPermissions },
    vantageAccess: scope.vantageAccess,
    manageableUnits: unitsWith(scope, PERMISSIONS.MANAGE_UNITS),
    counselUnits: unitsWith(scope, PERMISSIONS.COUNSEL),
    exportUnits: unitsWith(scope, PERMISSIONS.EXPORT_DATA),
    session: { id: req.sessionId.slice(0, 12), method: req.sessionRow.method, sudoUntil: req.sessionRow.sudo_until, stepUp },
    demo: ctx.config.accessMode === 'demo' ? demoStatus(ctx, req.user.id) : null,
    instance: { accessMode: ctx.config.accessMode, displayName: ctx.runtime.displayName, organizationName: ctx.runtime.organizationName, announcement: ctx.runtime.announcement, reportMarking: ctx.runtime.reportMarking, emailEnabled: ctx.mailer.enabled, attachmentsEnabled: ctx.runtime.attachmentsEnabled, aiEnabled: ctx.runtime.aiEnabled && Boolean(ctx.config.ai.apiKey), maradminsEnabled: ctx.runtime.maradminsEnabled, selfServiceUnits: ctx.runtime.selfServiceUnits, metrics: ctx.runtime.metrics, timezone: ctx.config.timezone },
  });
}));

meRouter.get('/org', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const ids = [...new Set([...ancestorIds(ctx, scope.unitIds), ...scope.viewableUnitIds])];
  const units = ids.length ? ctx.db.prepare(`SELECT * FROM units WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).all(...ids) as Unit[] : [];
  const roles = scope.unitIds.length ? ctx.db.prepare(`SELECT * FROM roles WHERE unit_id IN (${scope.unitIds.map(() => '?').join(',')}) ORDER BY position DESC, name`).all(...scope.unitIds) as Role[] : [];
  const body: OrgResponse = { ranks: ctx.db.prepare('SELECT * FROM ranks ORDER BY sort').all() as Rank[], units, roles, permissionCatalogue: PERMISSION_LIST.map((p) => ({ ...p, bit: PERMISSIONS[p.key] })) };
  res.json(body);
}));

meRouter.put('/profile', wrap((req, res) => {
  const ctx = req.ctx;
  const body = parse(profileSchema, req.body);
  if (body.email !== undefined && body.email !== req.user.email) {
    if (!req.sessionRow.sudo_until || new Date(req.sessionRow.sudo_until).getTime() < Date.now()) throw forbidden('Confirm your password to change your email.', 'sudo_required');
    if (body.email && ctx.mailer.enabled) throw badRequest('New addresses are confirmed by a link. Use the email confirmation flow.', { code: 'email_confirmation_required', fieldErrors: { email: 'Confirm the new address through the link sent to it.' } });
    if (body.email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(body.email, req.user.id)) throw badRequest('That email is already in use.', { fieldErrors: { email: 'Already in use.' } });
  }
  if (body.rank_id && !ctx.db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) throw badRequest('No such rank.', { fieldErrors: { rank_id: 'No such rank.' } });
  const owned = sourcedFieldsFor(ctx, req.user.id);
  if (owned.length) {
    const attempted = owned.filter((f) => (body as Record<string, unknown>)[f] !== undefined && (body as Record<string, unknown>)[f] !== (req.user as unknown as Record<string, unknown>)[f]);
    if (attempted.length) {
      throw badRequest(
        `${attempted.length === 1 ? 'That field comes' : 'Those fields come'} from the personnel feed and cannot be edited here. Ask your admin to correct it upstream.`,
        { code: 'field_is_sourced', fieldErrors: Object.fromEntries(attempted.map((f) => [f, 'Set by the personnel feed.'])) },
      );
    }
  }
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(body)) { if (v === undefined) continue; sets.push(`${k} = ?`); vals.push(v); }
  if (!sets.length) return res.json({ ok: true, changed: [] });
  withPersonnelNote(ctx, { actorId: req.user.id, source: 'self' }, () => ctx.db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), req.user.id));
  audit(ctx, { actor_id: req.user.id, action: 'edit_profile', entity: 'user', entity_id: req.user.id, subject_id: req.user.id, detail: Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined).join(', '), ip: clientIp(req) });
  res.json({ ok: true, changed: sets.map((s) => s.split(' ')[0]) });
}));

/**
 * The EDIPI a person's counseling worksheets print when their CAC has not proved one (ADR-0033). Only its own person sets
 * it: never a Unit Manager, a counselor or Vantage support, so nobody puts a number on someone else's paper. It is a
 * column of its own, never unique and never read to sign in, so typing a number links no card to any account; a proven
 * EDIPI on the account (users.edipi, from the CAC or the unit's roster) is the one the form prints, and is corrected as
 * ADR-0009 says: by Vantage support once proven, by the person's own Unit Instance before.
 */
meRouter.put('/edipi', wrap((req, res) => {
  const ctx = req.ctx;
  const { edipi } = parse(formEdipiSchema, req.body);
  const row = ctx.db.prepare('SELECT edipi, form_edipi FROM users WHERE id = ?').get(req.user.id) as { edipi: string | null; form_edipi: string | null };
  if (row.edipi) throw badRequest('Your account already carries your EDIPI, and your forms print that one. If it is wrong, your Unit Manager or Vantage support corrects it.', { code: 'edipi_on_account', fieldErrors: { edipi: 'Already on your account.' } });
  if ((edipi ?? null) === row.form_edipi) return res.json({ ok: true, changed: false, on_file: Boolean(edipi) });
  ctx.db.prepare('UPDATE users SET form_edipi = ?, form_edipi_at = ?, updated_at = ? WHERE id = ?').run(edipi, edipi ? now() : null, now(), req.user.id);
  // The trail says it changed, never the number.
  audit(ctx, { actor_id: req.user.id, action: 'edit_profile', entity: 'user', entity_id: req.user.id, subject_id: req.user.id, detail: edipi ? `form EDIPI ${row.form_edipi ? 'changed' : 'added'}` : 'form EDIPI removed', ip: clientIp(req) });
  res.json({ ok: true, changed: true, on_file: Boolean(edipi) });
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

meRouter.post('/password', wrap(async (req, res) => {
  const ctx = req.ctx;
  const { current_password, new_password } = parse(z.object({ current_password: z.string().max(512), new_password: passwordField }), req.body);
  // Failures here count toward the same lockout as sign-in.
  assertNotLocked(ctx, req.user.id);
  const stored = ctx.db.prepare('SELECT password_hash, auth_epoch FROM users WHERE id = ?').get(req.user.id) as { password_hash: string; auth_epoch: number };
  if (!(await verifyPassword(current_password, stored.password_hash))) {
    if (recordFailure(ctx, req.user.id, { ip: clientIp(req), where: 'password_change' })) assertNotLocked(ctx, req.user.id);
    throw forbidden('Current password is incorrect.', 'bad_password');
  }
  if (current_password === new_password) throw badRequest('Choose a different password.', { fieldErrors: { new_password: 'Choose a different password.' } });
  const hash = hashPassword(new_password);
  // Written only while this session is live under the epoch the current password was checked in (ADR-0035): a reset,
  // a sign-out everywhere or a deactivation while it hashed leaves the password as that left it.
  const revoked = ctx.db.transaction(() => {
    assertProofCurrent(liveSession(ctx, req.sessionId, req.user.id), stored.auth_epoch);
    const changed = ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ? AND auth_epoch = ? AND active = 1')
      .run(hash, now(), req.user.id, stored.auth_epoch).changes;
    if (changed !== 1) throw credentialsChanged();
    return invalidateUserSessions(ctx, req.user.id, req.sessionId);
  })();
  clearFailures(ctx, req.user.id);
  audit(ctx, { actor_id: req.user.id, action: 'password_change', detail: `other sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, otherSessionsRevoked: revoked });
}));

/** The categories a selective export names (`?sections=awards,trainings`), or null for everything. */
function exportSections(req: express.Request): string[] | null {
  const raw = typeof req.query.sections === 'string' ? req.query.sections.trim() : '';
  if (!raw) return null;
  const keys = [...new Set(raw.split(',').map((k) => k.trim()).filter(Boolean))];
  const unknown = keys.filter((k) => !CATEGORY_KEYS.includes(k));
  if (unknown.length || !keys.length) throw badRequest(`Not a category Vantage exports: ${unknown.join(', ').slice(0, 120) || 'none'}.`, { code: 'unknown_section' });
  return keys;
}

meRouter.get('/export', requireSudo, wrap((req, res) => {
  const ctx = req.ctx;
  const format = ['json', 'xlsx', 'csv'].includes(String(req.query.format)) ? String(req.query.format) as 'json' | 'xlsx' | 'csv' : 'zip';
  const sections = exportSections(req);
  const what = sections ? `sections ${sections.join(',')}; ` : '';
  const send = (body: Buffer | string, filename: string, type: string, counts: unknown) => {
    audit(ctx, { actor_id: req.user.id, action: 'export_personal', entity: 'user', entity_id: req.user.id, detail: `${format}; ${what}${JSON.stringify(counts)}`.slice(0, 900), ip: clientIp(req) });
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  };
  if (format === 'json') {
    const { _files, ...archive } = buildPersonalExport(ctx, req.user.id, { attachments: false, sections });
    void _files;
    send(JSON.stringify(archive, null, 2), `vantage-${req.user.username}-${archive.exported_at.slice(0, 10)}${sections ? '-selected' : ''}.json`, 'application/json; charset=utf-8', archive.counts);
    return;
  }
  if (format === 'csv') {
    // A CSV holds one record type: one category, or the profile.
    if (sections?.length !== 1) throw badRequest('A CSV holds one record type. Choose one category, or download a ZIP or a workbook.', { code: 'csv_one_category' });
    const { text, filename, counts } = buildPersonalExportCsv(ctx, req.user.id, sections[0]);
    send(text, filename, 'text/csv; charset=utf-8', counts);
    return;
  }
  const { buffer, filename, counts } = format === 'xlsx' ? buildPersonalExportWorkbook(ctx, req.user.id, { sections }) : buildPersonalExportZip(ctx, req.user.id, { sections });
  send(buffer, filename, format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip', counts);
}));

// Importing their own records (ADR-0019): upload, review, correct, import, undo

const importBody: express.RequestHandler = (req, res, next) =>
  express.raw({ type: () => true, limit: req.ctx.config.recordImports.maxBytes })(req, res, next);

meRouter.post('/imports', importBody, wrap(async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const filename = String(req.get('x-filename') || 'import').slice(0, 255);
  res.status(201).json(await stageImport(req.ctx, req.user, { buffer, filename, sessionId: req.sessionId }, req, clientIp(req)));
}));
meRouter.get('/imports', wrap((req, res) => res.json({ imports: listImports(req.ctx, req.user) })));
meRouter.get('/imports/:id', wrap((req, res) => res.json(getImport(req.ctx, req.user, String(req.params.id), req))));
meRouter.put('/imports/:id', wrap((req, res) => res.json(planImport(req.ctx, req.user, String(req.params.id), req.body, req))));
meRouter.post('/imports/:id/commit', wrap((req, res) => res.json(commitImport(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
meRouter.post('/imports/:id/undo', wrap((req, res) => res.json(undoImport(req.ctx, req.user, String(req.params.id), clientIp(req)))));
meRouter.delete('/imports/:id', wrap((req, res) => res.json(cancelImport(req.ctx, req.user, String(req.params.id), clientIp(req)))));

meRouter.get('/sessions', wrap((req, res) => res.json({ sessions: listSessions(req.ctx, req.user.id, req.sessionId) })));
meRouter.post('/sessions/revoke-others', wrap((req, res) => {
  const revoked = invalidateUserSessions(req.ctx, req.user.id, req.sessionId);
  audit(req.ctx, { actor_id: req.user.id, action: 'revoke_sessions', detail: `own other sessions: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, revoked });
}));
meRouter.delete('/sessions/:sid', wrap((req, res) => {
  const ended = revokeSessionByPrefix(req.ctx, req.user.id, String(req.params.sid));
  if (!ended) throw notFound('No such session.');
  const isCurrent = ended === req.sessionId;
  // Signing this session out from the list is signing out; another one is ended (ADR-0040). Each names the session.
  if (isCurrent) audit(req.ctx, { actor_id: req.user.id, action: 'logout', entity: 'sessions', entity_id: sessionRef(ended), ip: clientIp(req), detail: 'from the sessions list' });
  else audit(req.ctx, { actor_id: req.user.id, action: 'session_revoked', entity: 'sessions', entity_id: sessionRef(ended), subject_id: req.user.id, ip: clientIp(req) });
  if (isCurrent) { res.clearCookie(SESSION_COOKIE, { path: '/' }); res.clearCookie(SIGNED_IN_COOKIE, { path: '/' }); }
  res.json({ ok: true, current: isCurrent });
}));

meRouter.post('/mfa/totp/start', requireSudo, wrap(async (req, res) => {
  const ctx = req.ctx;
  const secret = generateTotpSecret();
  ctx.db.prepare('UPDATE users SET totp_pending = ?, updated_at = ? WHERE id = ?').run(encryptSecret(ctx.config.secret, secret), now(), req.user.id);
  const url = otpauthUrl(secret, req.user.username, ctx.runtime.displayName || 'Vantage');
  const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
  res.json({ secret, otpauth: url, qr });
}));

meRouter.post('/mfa/totp/confirm', requireSudo, wrap((req, res) => {
  const ctx = req.ctx;
  const { code } = parse(z.object({ code: z.string().max(12) }), req.body);
  const row = ctx.db.prepare('SELECT totp_pending FROM users WHERE id = ?').get(req.user.id) as { totp_pending: string | null };
  const secret = row.totp_pending ? decryptSecret(secretsOf(ctx.config), row.totp_pending) : null;
  if (!secret) throw badRequest('Start authenticator setup first.');
  const step = matchTotp(secret, code);
  if (step === null) throw badRequest('That code did not match. Check the time on your device and try again.', { fieldErrors: { code: 'Incorrect code.' } });
  const codes = generateRecoveryCodes();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_last_step = ?, updated_at = ? WHERE id = ?').run(step, now(), req.user.id);
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(req.user.id);
    for (const c of codes) ctx.db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)').run(newId(), req.user.id, sha256(`recovery:${c}`));
  })();
  audit(ctx, { actor_id: req.user.id, action: 'mfa_enabled', detail: 'totp', ip: clientIp(req) });
  res.json({ ok: true, recoveryCodes: codes });
}));

meRouter.post('/mfa/totp/disable', requireSudo, wrap((req, res) => {
  const ctx = req.ctx;
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?').run(now(), req.user.id);
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

meRouter.get('/passkeys', wrap((req, res) => res.json({ passkeys: listPasskeys(req.ctx, req.user.id), rpId: req.ctx.config.rpId })));
meRouter.post('/passkeys/options', requireSudo, wrap(async (req, res) => res.json(await registrationOptions(req.ctx, req.user))));
meRouter.post('/passkeys', requireSudo, wrap(async (req, res) => {
  const { response, name } = req.body || {};
  if (!response || typeof response !== 'object') throw badRequest('A passkey response is required.');
  const epoch = (req.ctx.db.prepare('SELECT auth_epoch FROM users WHERE id = ?').get(req.user.id) as { auth_epoch: number }).auth_epoch;
  // After the response is checked, the session that asked must still be live, under the same epoch, and still confirmed (ADR-0035).
  const stillAllowed = () => { assertConfirmedProof(req.ctx, req.sessionId, req.user.id, epoch); };
  let saved;
  try { saved = await completeRegistration(req.ctx, req.user.id, response, String(name || 'Passkey'), stillAllowed); }
  catch (error) { if (error instanceof HttpError) throw error; throw badRequest((error as Error).message); }
  audit(req.ctx, { actor_id: req.user.id, action: 'passkey_added', detail: saved.name, ip: clientIp(req) });
  res.status(201).json({ ok: true, passkey: saved, passkeys: listPasskeys(req.ctx, req.user.id) });
}));
meRouter.delete('/passkeys/:id', requireSudo, wrap((req, res) => {
  if (!deletePasskey(req.ctx, req.user.id, String(req.params.id))) throw notFound('No such passkey.');
  audit(req.ctx, { actor_id: req.user.id, action: 'passkey_removed', ip: clientIp(req) });
  res.json({ ok: true, passkeys: listPasskeys(req.ctx, req.user.id) });
}));

const READINESS_SELECT = `SELECT r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.ceus, r.college_credits, r.degree, r.pme_complete, r.cmd_character, r.cmd_mos, r.cmd_leadership, r.fitrep_period_end,
  ${JEPES_READINESS_COLUMNS.map((c) => `r.${c}`).join(', ')}, rk.grade AS rank_grade, rk.abbr AS rank_abbr
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

// The fitness reports a Marine received (ADR-0047): theirs to enter, change and remove, and private unless they share
// one. A leader who may open the Marine's readiness reads the shared ones, and every such read is audited.
meRouter.get('/fitness-reports', wrap((req, res) => res.json({ reports: listOwnReports(req.ctx, req.user.id) })));
meRouter.post('/fitness-reports', wrap((req, res) => {
  res.status(201).json(saveReport(req.ctx, req.user.id, null, parse(fitnessReportSchema, req.body)));
}));
meRouter.put('/fitness-reports/:id', wrap((req, res) => {
  res.json(updateReport(req.ctx, req.user.id, String(req.params.id), req.body));
}));
meRouter.delete('/fitness-reports/:id', wrap((req, res) => {
  removeReport(req.ctx, req.user.id, String(req.params.id));
  res.json({ ok: true });
}));
meRouter.get('/readiness/:id/fitness-reports', wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.id);
  if (id === req.user.id) return res.json({ reports: listOwnReports(ctx, id), shared_only: false });
  const scope = scopeFor(ctx, req.user, req);
  const units = detailUnitsFor(ctx, scope, id);
  if (!units.length) throw forbidden('You cannot open that readiness record.');
  const reports = listSharedReports(ctx, id);
  audit(ctx, { actor_id: req.user.id, action: 'view_fitness_reports', entity: 'user', entity_id: id, subject_id: id, unit_id: units[0], detail: `${reports.length} shared`, ip: clientIp(req) });
  res.json({ reports, shared_only: true });
}));

// A person's notices, each checked again as it is read: one about a record they may no longer open is not shown or
// counted, and a record's name is read now, never stored (ADR-0031).
const noticeQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(40),
  cursor: z.string().max(200).optional(),
  filter: z.enum(['all', 'unread']).default('all'),
  group: z.enum(NOTICE_GROUPS).optional(),
});
meRouter.get('/notifications', wrap((req, res) => {
  const q = parse(noticeQuery, req.query);
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(listNotices(req.ctx, req.user, scope, { limit: q.limit, cursor: q.cursor ?? null, unread: q.filter === 'unread', group: q.group ?? null }));
}));
meRouter.get('/requests', wrap((req, res) => {
  res.json(myRequests(req.ctx, req.user, scopeFor(req.ctx, req.user, req)));
}));
meRouter.put('/notifications/:id/read', wrap((req, res) => {
  const r = req.ctx.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(now(), String(req.params.id), req.user.id);
  if (!r.changes) throw notFound('No such notification.');
  res.json({ ok: true });
}));
meRouter.post('/notifications/read-all', wrap((req, res) => {
  const { group } = parse(z.object({ group: z.enum(NOTICE_GROUPS).optional() }), req.body ?? {});
  res.json({ ok: true, updated: markAllRead(req.ctx, req.user, group ?? null) });
}));

/**
 * Who has opened the reader's record: entries about them that someone else wrote, newest first, a page at a time.
 * `next` is the `before` of the page after it, null on the last, so every entry is in reach, however old.
 */
meRouter.get('/audit', wrap((req, res) => {
  const q = parse(auditQuery.pick({ before: true, limit: true }), req.query);
  const limit = q.limit ?? 100;
  const rows = req.ctx.db.prepare(`SELECT al.seq, al.id, al.action, al.entity, al.entity_id, al.detail, al.at, u.first_name, u.last_name, r.abbr AS rank_abbr FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN ranks r ON r.id = u.rank_id
    WHERE al.subject_id = ? AND al.actor_id <> ? AND al.seq < ? ORDER BY al.seq DESC LIMIT ?`).all(req.user.id, req.user.id, q.before ?? Number.MAX_SAFE_INTEGER, limit + 1) as Array<{ seq: number }>;
  const page = rows.slice(0, limit);
  // An EDIPI in an entry's words goes out masked, as GET /me sends one (ADR-0033): a CAC correction names two, and the
  // one it replaced may be somebody else's. The query stays as it is; only what is shown is masked.
  for (const row of page) withoutEdipis(row);
  res.json({ rows: page, next: rows.length > limit ? page.at(-1)!.seq : null });
}));

/**
 * Actions written with the account as their actor that someone else may have set off while its owner was signed out: a
 * password reset anyone can ask for by name, and a lockout after failed sign-ins from anywhere. Shown as on the account.
 */
const ON_THE_ACCOUNT: ReadonlySet<string> = new Set(['password_reset_requested', 'login_lockout']);
/** An id as Vantage makes one (a UUID): of a person, a record, a comment or a message. None goes out in the words. */
const AN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The reader's own activity: the entries they wrote, and those on their account nobody did (a failed sign-in, a
 * session Vantage ended), newest first, a page at a time, filtered as the audit trails are. Every Unit Instance they
 * acted in, as the personal export gives it, and nothing anyone else did. Each entry says what happened and when, and
 * less than the export does: no address, no seals, no unit or Unit Instance field, no entity id, and no id in its words, so
 * nobody is named by id. No parameter names whose activity it is: the reader is always the session's own.
 */
meRouter.get('/activity', wrap((req, res) => {
  const q = parse(auditQuery.pick({ category: true, action: true, from: true, to: true, before: true, limit: true }), req.query);
  const limit = q.limit ?? 100;
  const me = req.user.id;
  // Two reads, each down its own index and newest first, merged by position: one OR over both columns would read and
  // sort every entry of a busy leader (as the personal export's trail is read). Each is read with its words as written,
  // not as a trail that hides EDIPIs reads them: that masks ten digits in a row first, and an id whose last group holds
  // ten would then no longer read as an id, and most of it would go out. Nothing else that trail changes matters here:
  // no username or entity id is sent, and no search is taken.
  const read = (trail: AuditTrail) => auditRows(req.ctx, trail, q, limit + 1);
  const rows = [
    ...read({ where: 'al.actor_id = ?', params: [me], index: 'idx_audit_actor' }),
    ...read({ where: 'al.actor_id IS NULL AND al.subject_id = ?', params: [me], index: 'idx_audit_subject' }),
  ].sort((a, b) => b.seq - a.seq).slice(0, limit + 1);
  // Every id in the words is blanked first, whole, and only then is an EDIPI the words still carry masked (ADR-0033).
  const words = (detail: unknown) => (typeof detail === 'string' ? withoutEdipis({ detail: detail.replace(AN_ID, '…') }).detail : null);
  const page = rows.slice(0, limit).map((r) => ({
    seq: r.seq, id: r.id, at: r.at, action: r.action, category: r.category, entity: r.entity,
    detail: words(r.detail),
    by: r.actor_id == null || ON_THE_ACCOUNT.has(r.action) ? 'account' as const : 'you' as const,
  }));
  res.json({ rows: page, next: rows.length > limit ? page.at(-1)!.seq : null });
}));

meRouter.get('/digest/preview', wrap((req, res) => {
  const digest = composeDigest(req.ctx, { id: req.user.id, email: req.user.email, first_name: req.user.first_name, last_name: req.user.last_name, prefs: req.user.prefs, digest_last_sent_at: null });
  res.json({ subject: digest.subject, text: digest.text, stats: digest.stats, emailEnabled: req.ctx.mailer.enabled, hasEmail: Boolean(req.user.email) });
}));
meRouter.post('/digest/send-now', wrap(async (req, res) => {
  if (!req.ctx.mailer.enabled) throw badRequest('Email is off on Vantage right now.');
  mailAllowance(req.user.id);
  if (!req.user.email) throw badRequest('Add an email address to your profile first.');
  const result = await sendDigest(req.ctx, { id: req.user.id, email: req.user.email, first_name: req.user.first_name, last_name: req.user.last_name, prefs: req.user.prefs, digest_last_sent_at: null }, req.user.id);
  // The allow-list's reason is meant for the reader; a provider's own error stays in the mail log.
  if (!result.ok) throw badRequest(notSentMessage(result, 'The digest'));
  res.json({ ok: true });
}));

meRouter.post('/email/verify', requireSudo, wrap(async (req, res) => {
  const ctx = req.ctx;
  const { email } = parse(z.object({ email: emailField }), req.body);
  if (!ctx.mailer.enabled) throw badRequest('Email is off on Vantage right now.');
  if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(email, req.user.id)) throw badRequest('That email is already in use.', { fieldErrors: { email: 'Already in use.' } });
  mailAllowance(req.user.id);
  // An address outside the allowed domains is the field's problem, said on the field, before any link exists.
  const refused = ctx.mailer.checkRecipient({ to: email, subject: EMAIL_CHANGE_SUBJECT, kind: 'email_change', userId: req.user.id, actorId: req.user.id });
  if (refused) throw badRequest(refused.error!, { fieldErrors: { email: refused.error! } });
  const { token } = issueToken(ctx, 'email_change', { userId: req.user.id, email, ttlMinutes: 60 });
  const url = `${ctx.config.urls.app}/settings?verify=${encodeURIComponent(token)}`;
  const mail = emailChangeMessage({ username: req.user.username, email, url, origin: ctx.config.urls.app });
  const result = await ctx.mailer.send({ to: email, subject: mail.subject, text: mail.text, html: mail.html, kind: 'email_change', userId: req.user.id, actorId: req.user.id });
  if (!result.ok) {
    const message = notSentMessage(result, 'The confirmation');
    // An address its own mail server would not take is the field's problem, as one outside the list is.
    throw badRequest(message, result.recipient ? { fieldErrors: { email: message } } : {});
  }
  res.json({ ok: true });
}));
meRouter.post('/email/confirm', wrap((req, res) => {
  const ctx = req.ctx;
  const { token } = parse(z.object({ token: z.string().max(200) }), req.body);
  const email = ctx.db.transaction(() => {
    // Checked before it is spent: opening the link as somebody else must not burn it.
    const pending = peekToken(ctx, 'email_change', token);
    if (!pending || pending.user_id !== req.user.id || !pending.email) throw badRequest('That confirmation link is invalid or has expired.');
    if (ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id <> ?').get(pending.email, req.user.id)) throw badRequest('That email is already in use.', { fieldErrors: { email: 'Already in use.' } });
    if (!consumeToken(ctx, 'email_change', token)) throw badRequest('That confirmation link is invalid or has expired.');
    ctx.db.prepare('UPDATE users SET email = ?, updated_at = ? WHERE id = ?').run(pending.email, now(), req.user.id);
    audit(ctx, { actor_id: req.user.id, action: 'email_confirmed', subject_id: req.user.id, ip: clientIp(req) });
    return pending.email;
  }).immediate();
  res.json({ ok: true, email });
}));

