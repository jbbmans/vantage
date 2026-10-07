import { Router, type Request } from 'express';
import express from 'express';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, statSync, unlinkSync } from 'node:fs';
import { normalizeMetrics } from '../../shared/constants.ts';
import { setCurrencySymbol } from '../../shared/metrics.ts';
import { PLATFORM_ROLE_KEYS, PLATFORM_ROLES, PLATFORM_PERMISSION_LIST, ORG_ROLES, ORG_PERMISSION_LIST, type PlatformRole } from '../../shared/permissions.ts';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { notify, notifyStaff } from '../services/notifications.ts';
import { requireAuth, requirePlatform, requireSudo } from '../auth/middleware.ts';
import { audit, verifyAuditChain } from '../services/audit.ts';
import { auditForwardingStatus } from '../services/auditSink.ts';
import { aiStatus, discoverModels, unlockAi } from '../services/ai.ts';
import { syncMaradmins, maradminSyncState } from '../services/maradmins.ts';
import { exportInstance, importInstance } from '../services/exports.ts';
import { metaSet, SCHEMA_VERSION } from '../db/index.ts';
import { VERSION } from '../version.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { layout } from '../services/mailLayout.ts';
import { checkRecords, dnsHostOf, domainOf, heloName, lastPath, probePath, requiredRecords } from '../services/directMail.ts';
import type { AppContext } from '../context.ts';
import { usageReport, MIN_COHORT } from '../services/usage.ts';
import { EVENTS } from '../services/telemetry.ts';
import { openHolds, placeHold, releaseHold, HOLDABLE_TYPES } from '../services/retention.ts';
import { buildInventory, inventoryMarkdown } from '../services/privacyInventory.ts';
import { verifyAllCases, anchorCaseHeads } from '../services/caseSeal.ts';
import { sendSignInDetails, MAX_SIGN_IN_BATCH } from '../services/signInMail.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { unlockAccount } from '../auth/lockout.ts';
import { hashPassword } from '../lib/crypto.ts';
import { createOrganization, getOrg, listOrganizations, nameFirstOwner, orgCounts, orgRoleHolders, publicOrg, setOrgStatus, updateOrganization } from '../services/organizations.ts';
import { accessForPlatform, endAccess, requestAccess, ACCESS_DEFAULT_MINUTES, ACCESS_MAX_MINUTES } from '../services/access.ts';
import { platformRolesOf } from '../authz/platform.ts';
import { assertRuntimePatchAllowed, deploymentPosture } from '../services/deployment.ts';

/**
 * The Vantage admin dashboard's API (ADR-0006): the service, for Vantage staff. Organizations appear here as
 * containers (names, counts, owners, status), never as their contents. Seeing inside one takes that organization's
 * approval, through an access request.
 */
export const platformRouter = Router();
platformRouter.use(requireAuth, (req, _res, next) => next(req.user.platform.length ? undefined : forbidden('The Vantage admin dashboard is for Vantage staff.', 'not_staff')), requireSudo);

const ip = (req: Request) => clientIp(req);

platformRouter.get('/me', wrap((req, res) => res.json({
  roles: req.user.platform,
  permissions: req.user.platformPermissions,
  catalog: { roles: PLATFORM_ROLES, permissions: PLATFORM_PERMISSION_LIST, orgRoles: ORG_ROLES, orgPermissions: ORG_PERMISSION_LIST },
})));

platformRouter.get('/overview', requirePlatform('platform.view'), wrap((req, res) => {
  const { db } = req.ctx;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  let sizeBytes: number | null = null;
  try { sizeBytes = db.name === ':memory:' ? null : statSync(db.name).size; } catch {}
  res.json({
    version: VERSION, schemaVersion: SCHEMA_VERSION, uptime: Math.round(process.uptime()), node: process.version,
    organizations: {
      active: count("SELECT COUNT(*) AS n FROM organizations WHERE status = 'active'"),
      suspended: count("SELECT COUNT(*) AS n FROM organizations WHERE status = 'suspended'"),
      archived: count("SELECT COUNT(*) AS n FROM organizations WHERE status = 'archived'"),
      withoutOwner: count(`SELECT COUNT(*) AS n FROM organizations o WHERE o.status = 'active' AND NOT EXISTS (SELECT 1 FROM org_roles r JOIN users u ON u.id = r.user_id WHERE r.org_id = o.id AND r.role = 'owner' AND u.active = 1)`),
    },
    users: count('SELECT COUNT(*) AS n FROM users WHERE active = 1'), inactiveUsers: count('SELECT COUNT(*) AS n FROM users WHERE active = 0'),
    lockedUsers: (db.prepare('SELECT COUNT(*) AS n FROM users WHERE locked_until > ?').get(now()) as { n: number }).n,
    staff: count('SELECT COUNT(DISTINCT p.user_id) AS n FROM platform_roles p JOIN users u ON u.id = p.user_id WHERE u.active = 1'),
    units: count('SELECT COUNT(*) AS n FROM units WHERE active = 1'),
    sessions: count('SELECT COUNT(*) AS n FROM sessions'),
    mfaUsers: count('SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1 AND active = 1'), passkeyUsers: count('SELECT COUNT(DISTINCT user_id) AS n FROM passkeys'),
    access: {
      pending: count("SELECT COUNT(*) AS n FROM access_grants WHERE status = 'pending'"),
      active: (db.prepare("SELECT COUNT(*) AS n FROM access_grants WHERE status = 'active' AND expires_at > ?").get(now()) as { n: number }).n,
    },
    support: { open: count("SELECT COUNT(*) AS n FROM support_tickets WHERE state NOT IN ('resolved', 'closed') AND unit_id IS NULL AND deleted_at IS NULL") },
    database: { sizeBytes, maxBytes: req.ctx.config.limits.maxDatabaseBytes },
    email: { provider: req.ctx.mailer.provider, enabled: req.ctx.mailer.enabled, from: req.ctx.config.email.from, recent: db.prepare('SELECT to_address, kind, status, error, created_at FROM email_log ORDER BY created_at DESC LIMIT 10').all() },
    maradmins: maradminSyncState(req.ctx),
    runtime: req.ctx.runtime,
    urls: req.ctx.config.urls, rpId: req.ctx.config.rpId, timezone: req.ctx.config.timezone,
    audit: verifyAuditChain(req.ctx),
    auditForwarding: auditForwardingStatus(req.ctx),
    browserBackups: req.ctx.config.security.browserBackups,
    deployment: deploymentPosture(req.ctx),
  });
}));

// ——— Platform settings ———

const runtimeSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  organizationName: z.string().trim().max(120).optional(),
  announcement: z.string().max(240).optional(),
  selfRegistration: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
  aiModels: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,99}$/)).max(30).optional(),
  aiDefaultModel: z.string().max(100).optional(),
  attachmentsEnabled: z.boolean().optional(),
  maradminsEnabled: z.boolean().optional(),
  maintenance: z.boolean().optional(),
  selfServiceUnits: z.boolean().optional(),
  selfServiceUnitLimit: z.coerce.number().int().min(0).max(100).optional(),
  metrics: z.object({
    currency_label: z.string().trim().min(1).max(30),
    currency_symbol: z.string().trim().max(4),
    value_types: z.array(z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,29}$/, 'Keys are lowercase letters, digits, dash, underscore.'), label: z.string().trim().min(1).max(40), verb: z.string().trim().max(40).optional(), summable: z.boolean(), definition: z.string().trim().max(200).optional() })).min(1).max(20),
    categories: z.array(z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).min(1).max(40),
    unit_suggestions: z.array(z.string().trim().min(1).max(30)).max(60),
  }).optional(),
});

platformRouter.put('/runtime', requirePlatform('platform.settings'), wrap((req, res) => {
  const ctx = req.ctx;
  const patch = parse(runtimeSchema, req.body);
  assertRuntimePatchAllowed(ctx.config, patch);
  const { metrics, ...rest } = patch;
  Object.assign(ctx.runtime, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
  if (metrics) {
    const keys = metrics.value_types.map((t) => t.key);
    if (new Set(keys).size !== keys.length) throw badRequest('Value type keys must be unique.');
    const names = metrics.categories.map((c) => c.name.toLowerCase());
    if (new Set(names).size !== names.length) throw badRequest('Category names must be unique.');
    if (!metrics.value_types.some((t) => t.summable)) throw badRequest('At least one value type must count toward the headline total.');
    ctx.runtime.metrics = normalizeMetrics(metrics);
    setCurrencySymbol(ctx.runtime.metrics.currency_symbol);
  }
  if (!ctx.runtime.aiModels.length) ctx.runtime.aiModels = [...ctx.config.ai.models];
  if (!ctx.runtime.aiModels.includes(ctx.runtime.aiDefaultModel)) ctx.runtime.aiDefaultModel = ctx.runtime.aiModels[0];
  ctx.saveRuntime();
  audit(ctx, { actor_id: req.user.id, action: 'edit_configuration', entity: 'platform', detail: Object.keys(patch).join(', '), ip: ip(req) });
  res.json(ctx.runtime);
}));

platformRouter.post('/maintenance', requirePlatform('platform.settings'), wrap((req, res) => {
  req.ctx.runtime.maintenance = Boolean(req.body?.enabled);
  req.ctx.saveRuntime();
  audit(req.ctx, { actor_id: req.user.id, action: req.ctx.runtime.maintenance ? 'maintenance_on' : 'maintenance_off', entity: 'platform', ip: ip(req) });
  res.json({ maintenance: req.ctx.runtime.maintenance });
}));

platformRouter.get('/ai', requirePlatform('platform.ai'), wrap((req, res) => res.json(aiStatus(req.ctx, { operator: true, userId: req.user.id }))));
platformRouter.post('/ai/discover', requirePlatform('platform.ai'), wrap(async (req, res) => res.json({ models: await discoverModels(req.ctx) })));
platformRouter.post('/ai/unlock', requirePlatform('platform.ai'), wrap((req, res) => { unlockAi(); audit(req.ctx, { actor_id: req.user.id, action: 'ai_unlocked', entity: 'platform', ip: ip(req) }); res.json(aiStatus(req.ctx, { operator: true })); }));

platformRouter.post('/maradmins/sync', requirePlatform('platform.settings'), wrap(async (req, res) => {
  const result = await syncMaradmins(req.ctx, { force: true });
  audit(req.ctx, { actor_id: req.user.id, action: 'sync_maradmins', entity: 'platform', detail: JSON.stringify(result), ip: ip(req) });
  res.json({ ...result, state: maradminSyncState(req.ctx) });
}));

// ——— Email ———

function emailSetup(ctx: AppContext) {
  const direct = ctx.mailer.provider === 'direct';
  const queue = ctx.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM email_queue').get() as { n: number; oldest: string | null };
  return {
    provider: ctx.mailer.provider, from: ctx.config.email.from, domain: domainOf(ctx.config.email.from), replyTo: ctx.config.email.replyTo || null,
    records: direct ? requiredRecords(ctx.db, ctx.config) : [],
    path: direct ? lastPath(ctx.db) : null,
    helo: direct ? heloName(ctx.db, ctx.config) : null,
    queue: { waiting: queue.n, oldest: queue.oldest },
    recent: ctx.db.prepare('SELECT to_address, kind, status, error, created_at FROM email_log ORDER BY created_at DESC LIMIT 15').all(),
  };
}

platformRouter.get('/email', requirePlatform('platform.email'), wrap((req, res) => res.json(emailSetup(req.ctx))));

platformRouter.post('/email/check', requirePlatform('platform.email'), wrap(async (req, res) => {
  const ctx = req.ctx;
  if (ctx.mailer.provider !== 'direct') throw badRequest('These checks are for sending from the service’s own domain. Set VANTAGE_EMAIL_PROVIDER=direct first.');
  const path = await probePath(ctx.db, ctx.config);
  const records = await checkRecords(ctx.db, ctx.config);
  const dnsHost = await dnsHostOf(domainOf(ctx.config.email.from));
  audit(ctx, { actor_id: req.user.id, action: 'email_setup_checked', entity: 'platform', detail: `SMTP check ${path.open ? 'passed' : 'failed'}; ${records.map((r) => `${r.id} ${r.status}`).join(', ')}`, ip: ip(req) });
  res.json({ ...emailSetup(ctx), records, path, dnsHost });
}));

platformRouter.post('/email/test', requirePlatform('platform.email'), wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!ctx.mailer.enabled) throw badRequest('Email is not configured. Set VANTAGE_EMAIL_PROVIDER and its credentials.');
  const to = String(req.body?.to || req.user.email || '');
  if (!to) throw badRequest('Provide a destination address or add an email to your profile.');
  const mail = layout({
    eyebrow: 'Test message',
    title: 'Email is working',
    intro: 'If you are reading this, Vantage can reach this inbox. Reset links, invitations, sign-in details and digests will arrive the same way.',
    details: [{ label: 'Sent from', value: ctx.config.urls.app }, { label: 'Provider', value: ctx.mailer.provider }, { label: 'From address', value: ctx.config.email.from }, { label: 'Sent at', value: new Date().toLocaleString('en-US', { timeZone: ctx.config.timezone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) }],
    note: 'Check that this message did not land in spam. For direct delivery, open the message headers and look for “dkim=pass”.',
    footer: 'Vantage staff sent this test from the admin dashboard.',
    origin: ctx.config.urls.app,
  });
  const result = await ctx.mailer.send({ to, subject: 'Vantage email test', text: mail.text, html: mail.html, kind: 'test', userId: req.user.id });
  if (!result.ok) throw badRequest(result.error || 'Send failed.');
  res.json({ ok: true, queued: Boolean(result.queued) });
}));

// ——— Organizations: containers, never contents ———

platformRouter.get('/orgs', requirePlatform('platform.view'), wrap((req, res) => res.json({ organizations: listOrganizations(req.ctx) })));

const orgCreate = z.object({ name: z.string().max(120), short_name: z.string().max(40).nullish(), code: z.string().max(40).nullish(), owner_user_id: z.string().max(64).nullish() });
platformRouter.post('/orgs', requirePlatform('platform.orgs'), wrap((req, res) => {
  res.status(201).json(createOrganization(req.ctx, req.user, parse(orgCreate, req.body), ip(req)));
}));

platformRouter.get('/orgs/:orgId', requirePlatform('platform.view'), wrap((req, res) => {
  const org = getOrg(req.ctx, String(req.params.orgId));
  if (!org) throw notFound('No such Unit Instance.');
  const recentAccess = accessForPlatform(req.ctx).filter((g) => g.org_id === org.id).slice(0, 20);
  res.json({ organization: publicOrg(org), counts: orgCounts(req.ctx, org.id), roles: orgRoleHolders(req.ctx, org.id).map(({ username: _u, ...r }) => r), access: recentAccess });
}));

platformRouter.patch('/orgs/:orgId', requirePlatform('platform.orgs'), wrap((req, res) => {
  const body = parse(z.object({ name: z.string().max(120).optional(), short_name: z.string().max(40).nullish() }), req.body);
  res.json(updateOrganization(req.ctx, req.user, String(req.params.orgId), body, ip(req)));
}));

platformRouter.post('/orgs/:orgId/status', requirePlatform('platform.orgs'), wrap((req, res) => {
  const body = parse(z.object({ status: z.enum(['active', 'suspended', 'archived']), reason: z.string().max(500).nullish() }), req.body);
  res.json(setOrgStatus(req.ctx, req.user, String(req.params.orgId), body.status, body.reason ?? null, ip(req)));
}));

platformRouter.post('/orgs/:orgId/owner', requirePlatform('platform.orgs'), wrap((req, res) => {
  const body = parse(z.object({ user_id: z.string().max(64) }), req.body);
  res.json({ roles: nameFirstOwner(req.ctx, req.user, String(req.params.orgId), body.user_id, ip(req)) });
}));

// ——— Accounts: sign-in help. Who someone is and how they sign in; never what they keep. ———

platformRouter.get('/accounts', requirePlatform('platform.accounts'), wrap((req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
  const filter = String(req.query.filter || '');
  const where: string[] = [];
  const params: unknown[] = [now()];
  if (q) {
    const p = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push("(lower(u.username) LIKE ? ESCAPE '\\' OR lower(u.last_name) LIKE ? ESCAPE '\\' OR lower(u.first_name) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\' OR u.edipi = ?)");
    params.push(p, p, p, p, q);
  }
  if (filter === 'locked') { where.push('u.locked_until > ?'); params.push(now()); }
  if (filter === 'inactive') where.push('u.active = 0');
  if (filter === 'staff') where.push('EXISTS (SELECT 1 FROM platform_roles p WHERE p.user_id = u.id)');
  const rows = req.ctx.db.prepare(`SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.active, u.totp_enabled, u.must_change_password, u.last_login_at,
      CASE WHEN u.locked_until > ? THEN u.locked_until END AS locked_until, u.created_at, r.abbr AS rank_abbr,
      (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
      (SELECT GROUP_CONCAT(DISTINCT o.name) FROM unit_members um JOIN units un ON un.id = um.unit_id JOIN organizations o ON o.id = un.org_id WHERE um.user_id = u.id) AS organizations,
      (SELECT GROUP_CONCAT(p.role) FROM platform_roles p WHERE p.user_id = u.id) AS platform_roles
    FROM users u LEFT JOIN ranks r ON r.id = u.rank_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY u.active DESC, u.last_name COLLATE NOCASE LIMIT 200`).all(...params);
  res.json({ accounts: rows });
}));

const accountTarget = (req: Request) => {
  const id = String(req.params.userId);
  const row = req.ctx.db.prepare('SELECT id, username, active FROM users WHERE id = ?').get(id) as { id: string; username: string; active: number } | undefined;
  if (!row) throw notFound('No such account.');
  // A platform owner's account is recovered only by another owner: support cannot take over the people above it.
  const theirRoles = platformRolesOf(req.ctx, id);
  if (theirRoles.length && id !== req.user.id && !req.user.platformPermissions.includes('platform.staff')) throw forbidden('Only a platform owner changes another staff member’s sign-in.', 'staff_account');
  return row;
};

platformRouter.post('/accounts/:userId/unlock', requirePlatform('platform.accounts'), wrap((req, res) => {
  const target = accountTarget(req);
  res.json({ ok: true, unlocked: unlockAccount(req.ctx, target.id, req.user.id, ip(req)) });
}));

platformRouter.post('/accounts/:userId/logout', requirePlatform('platform.accounts'), wrap((req, res) => {
  const target = accountTarget(req);
  const revoked = invalidateUserSessions(req.ctx, target.id);
  audit(req.ctx, { actor_id: req.user.id, action: 'force_logout', entity: 'user', entity_id: target.id, subject_id: target.id, detail: `sessions revoked: ${revoked}`, ip: ip(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

platformRouter.post('/accounts/:userId/temporary-password', requirePlatform('platform.accounts'), wrap((req, res) => {
  const ctx = req.ctx;
  const target = accountTarget(req);
  if (target.id === req.user.id) throw badRequest('Use Change password for your own account.');
  const hex = randomBytes(10).toString('hex');
  const password = `${hex.slice(0, 8)}-${hex.slice(8, 16)}-${hex.slice(16)}`;
  // A new password is support's answer to a locked account, so it unlocks it too.
  ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, failed_sign_ins = 0, locked_until = NULL, updated_at = ? WHERE id = ?').run(hashPassword(password), now(), target.id);
  const revoked = invalidateUserSessions(ctx, target.id);
  audit(ctx, { actor_id: req.user.id, action: 'temporary_password', entity: 'user', entity_id: target.id, subject_id: target.id, detail: `sessions revoked: ${revoked}`, ip: ip(req) });
  notify(ctx, target.id, { kind: 'security', title: 'Vantage support set a temporary password on your account', message: 'If you did not ask for this, contact Vantage support.', actionUrl: '/settings' });
  res.json({ ok: true, password, sessionsRevoked: revoked });
}));

platformRouter.post('/accounts/:userId/reset-mfa', requirePlatform('platform.accounts'), wrap((req, res) => {
  const ctx = req.ctx;
  const target = accountTarget(req);
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_pending = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?').run(now(), target.id);
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(target.id);
    ctx.db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(target.id);
  })();
  const revoked = invalidateUserSessions(ctx, target.id);
  audit(ctx, { actor_id: req.user.id, action: 'reset_mfa', entity: 'user', entity_id: target.id, subject_id: target.id, detail: `sessions revoked: ${revoked}`, ip: ip(req) });
  notify(ctx, target.id, { kind: 'security', title: 'Vantage support reset your second factor', message: 'Set up an authenticator or passkey again from Settings.', actionUrl: '/settings' });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

platformRouter.post('/accounts/:userId/deactivate', requirePlatform('platform.accounts'), wrap((req, res) => {
  const ctx = req.ctx;
  const target = accountTarget(req);
  if (target.id === req.user.id) throw badRequest('You cannot deactivate your own account.');
  const leads = ctx.db.prepare('SELECT name FROM units WHERE owner_user_id = ? AND active = 1').all(target.id) as Array<{ name: string }>;
  if (leads.length) throw badRequest(`They lead ${leads.map((u) => u.name).join(', ')}. That Unit Instance transfers the leadership first.`);
  ctx.db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(now(), target.id);
  const revoked = invalidateUserSessions(ctx, target.id);
  audit(ctx, { actor_id: req.user.id, action: 'deactivate_account', entity: 'user', entity_id: target.id, subject_id: target.id, detail: `${String(req.body?.reason || '').slice(0, 200)}; sessions revoked: ${revoked}`, ip: ip(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

platformRouter.post('/accounts/:userId/reactivate', requirePlatform('platform.accounts'), wrap((req, res) => {
  const target = accountTarget(req);
  req.ctx.db.prepare('UPDATE users SET active = 1, updated_at = ? WHERE id = ?').run(now(), target.id);
  audit(req.ctx, { actor_id: req.user.id, action: 'reactivate_account', entity: 'user', entity_id: target.id, subject_id: target.id, ip: ip(req) });
  res.json({ ok: true });
}));

platformRouter.post('/accounts/sign-in-details', requirePlatform('platform.accounts'), wrap(async (req, res) => {
  const ctx = req.ctx;
  const { userIds } = parse(z.object({ userIds: z.array(z.string().max(64)).min(1).max(MAX_SIGN_IN_BATCH) }), req.body);
  if (!ctx.mailer.enabled) throw badRequest('Email is not configured. Set VANTAGE_EMAIL_PROVIDER and its credentials.');
  const results = [];
  for (const id of [...new Set(userIds)]) results.push(await sendSignInDetails(ctx, req.user, id, null, ip(req)));
  res.json({ results });
}));

// ——— Vantage staff ———

platformRouter.get('/staff', requirePlatform('platform.view'), wrap((req, res) => {
  const rows = req.ctx.db.prepare(`SELECT p.user_id, p.role, p.granted_by, p.created_at, u.username, u.first_name, u.last_name, u.active, u.totp_enabled, u.last_login_at,
      (SELECT COUNT(*) FROM passkeys k WHERE k.user_id = u.id) AS passkeys, g.first_name || ' ' || g.last_name AS granted_by_name
    FROM platform_roles p JOIN users u ON u.id = p.user_id LEFT JOIN users g ON g.id = p.granted_by
    ORDER BY CASE p.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'support' THEN 2 ELSE 3 END, u.last_name`).all();
  res.json({ staff: rows, roles: PLATFORM_ROLES });
}));

platformRouter.post('/staff', requirePlatform('platform.staff'), wrap((req, res) => {
  const ctx = req.ctx;
  const body = parse(z.object({ user_id: z.string().max(64).optional(), username: z.string().max(80).optional(), role: z.enum(PLATFORM_ROLE_KEYS as [PlatformRole, ...PlatformRole[]]) }), req.body);
  const user = (body.user_id
    ? ctx.db.prepare('SELECT id, first_name, last_name, totp_enabled FROM users WHERE id = ? AND active = 1').get(body.user_id)
    : ctx.db.prepare('SELECT id, first_name, last_name, totp_enabled FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(String(body.username || ''))) as { id: string; first_name: string; last_name: string; totp_enabled: number } | undefined;
  if (!user) throw notFound('No such active account.');
  if (user.id === req.user.id) throw forbidden('Another platform owner changes your own staff roles.', 'self_grant');
  const passkeys = (ctx.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(user.id) as { n: number }).n;
  if (!user.totp_enabled && !passkeys) throw badRequest('Vantage staff sign in with a second factor. They set one up in Settings first.', { code: 'mfa_required' });
  const r = ctx.db.prepare('INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, created_at) VALUES (?, ?, ?, ?)').run(user.id, body.role, req.user.id, now());
  if (!r.changes) throw conflict('They already hold that role.');
  invalidateUserSessions(ctx, user.id);
  audit(ctx, { actor_id: req.user.id, action: 'staff_role_granted', entity: 'platform', entity_id: user.id, subject_id: user.id, detail: body.role, ip: ip(req) });
  notifyStaff(ctx, 'platform.staff', { kind: 'system', title: `${user.first_name} ${user.last_name} is now Vantage ${PLATFORM_ROLES[body.role].label.toLowerCase()}`, message: `Granted by ${req.user.first_name} ${req.user.last_name}.`, actionUrl: '/admin/staff' }, req.user.id);
  res.status(201).json({ ok: true });
}));

platformRouter.delete('/staff/:userId/:role', requirePlatform('platform.staff'), wrap((req, res) => {
  const ctx = req.ctx;
  const userId = String(req.params.userId);
  const role = String(req.params.role);
  if (role === 'owner') {
    const owners = (ctx.db.prepare("SELECT p.user_id FROM platform_roles p JOIN users u ON u.id = p.user_id WHERE p.role = 'owner' AND u.active = 1").all() as Array<{ user_id: string }>).map((r) => r.user_id);
    if (owners.includes(userId) && owners.length === 1) throw badRequest('The platform always keeps at least one owner.', { code: 'last_owner' });
  }
  const r = ctx.db.prepare('DELETE FROM platform_roles WHERE user_id = ? AND role = ?').run(userId, role);
  if (!r.changes) throw notFound('They do not hold that role.');
  // Access opened under a role they no longer hold ends with it.
  if (!platformRolesOf(ctx, userId).length) ctx.db.prepare("UPDATE access_grants SET status = 'ended', ended_at = ?, ended_by = ? WHERE staff_user_id = ? AND status IN ('pending', 'active')").run(now(), req.user.id, userId);
  invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: req.user.id, action: 'staff_role_revoked', entity: 'platform', entity_id: userId, subject_id: userId, detail: role, ip: ip(req) });
  res.json({ ok: true });
}));

// ——— Vantage access to an organization ———

platformRouter.get('/access', requirePlatform('platform.view'), wrap((req, res) => {
  const all = req.user.platformPermissions.includes('platform.audit') || req.user.platformPermissions.includes('platform.staff');
  res.json({
    grants: accessForPlatform(req.ctx, all ? { status: String(req.query.status || '') || undefined } : { staffId: req.user.id }),
    defaults: { minutes: ACCESS_DEFAULT_MINUTES, maxMinutes: ACCESS_MAX_MINUTES },
    canRequest: req.user.platformPermissions.includes('platform.access'),
  });
}));

platformRouter.post('/access', requirePlatform('platform.access'), wrap((req, res) => {
  const body = parse(z.object({ org_id: z.string().max(64), reason: z.string().max(1000), minutes: z.coerce.number().int().min(15).max(ACCESS_MAX_MINUTES).optional() }), req.body);
  res.status(201).json(requestAccess(req.ctx, req.user, body.org_id, body, ip(req)));
}));

platformRouter.post('/access/:id/end', requirePlatform('platform.access'), wrap((req, res) => {
  res.json(endAccess(req.ctx, req.user, String(req.params.id), 'staff', undefined, ip(req)));
}));

// ——— Audit, integrity, usage ———

/**
 * The platform's own trail: what Vantage staff did, sign-ins, and every access request. An organization's internal
 * actions (its units, its roles, its records) stay in its own trail.
 */
platformRouter.get('/audit', requirePlatform('platform.audit'), wrap((req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const action = String(req.query.action || '').slice(0, 60);
  const rows = req.ctx.db.prepare(`SELECT al.*, u.username AS actor_username, s.username AS subject_username FROM audit_log al
      LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id
     WHERE al.org_id IS NULL AND al.unit_id IS NULL ${action ? 'AND al.action = ?' : ''} ORDER BY al.seq DESC LIMIT ?`).all(...(action ? [action] : []), limit);
  res.json({ rows, chain: verifyAuditChain(req.ctx) });
}));

platformRouter.get('/integrity', requirePlatform('platform.audit'), wrap((req, res) => res.json({ audit: verifyAuditChain(req.ctx), cases: verifyAllCases(req.ctx) })));

platformRouter.post('/integrity/anchor', requirePlatform('platform.settings'), wrap((req, res) => {
  const anchored = anchorCaseHeads(req.ctx);
  audit(req.ctx, { actor_id: req.user.id, action: 'case_history_anchor_requested', entity: 'work_event_heads', detail: `${anchored.cases} cases`, ip: ip(req) });
  res.json(anchored);
}));

const usageQuery = z.object({ from: z.string().max(10).optional(), to: z.string().max(10).optional(), days: z.coerce.number().int().min(1).max(400).optional() });
platformRouter.get('/usage', requirePlatform('platform.usage'), wrap((req, res) => {
  const q = parse(usageQuery, req.query);
  const days = q.days ?? 30;
  const to = q.to || zonedDay(req.ctx.config.timezone);
  const from = q.from || new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  res.json({ report: usageReport(req.ctx, { from, to }), minimumCohort: MIN_COHORT, catalogSize: Object.keys(EVENTS).length });
}));

platformRouter.get('/privacy/inventory', requirePlatform('platform.audit'), wrap((req, res) => {
  const inventory = buildInventory(req.ctx);
  if (String(req.query.format || '') === 'markdown') { res.type('text/markdown').send(inventoryMarkdown(inventory)); return; }
  res.json(inventory);
}));

// ——— Platform-wide legal holds: a hold on the service itself, over every organization ———

platformRouter.get('/holds', requirePlatform('platform.data'), wrap((req, res) => {
  res.json({ holds: openHolds(req.ctx).filter((h) => !h.org_id), holdableTypes: HOLDABLE_TYPES });
}));

platformRouter.post('/holds', requirePlatform('platform.data'), wrap((req, res) => {
  const body = parse(z.object({ scope: z.enum(['instance', 'user', 'record_type']), subject_id: z.string().max(64).nullable().optional(), record_type: z.string().max(40).nullable().optional(), reason: z.string().min(1).max(1000) }), req.body);
  res.json(placeHold(req.ctx, null, body, req.user.id));
}));

platformRouter.delete('/holds/:id', requirePlatform('platform.data'), wrap((req, res) => {
  releaseHold(req.ctx, null, String(req.params.id), req.user.id);
  res.json({ ok: true });
}));

// ——— Disaster recovery: the whole service. Platform owners only. ———

/**
 * The database and the archive hold every Marine's records, password hashes and sealed secrets. On the production
 * host they are taken on the server (docs/operations.md) and VANTAGE_BROWSER_BACKUPS=false closes this door. Where it
 * stays open, every other platform owner is told each time it is used.
 */
function browserCopy(req: Request, what: string) {
  if (!req.ctx.config.security.browserBackups) throw forbidden(`Downloading ${what} through the browser is turned off. Take it on the server; see Operations in the documentation.`, 'browser_backups_off');
  const name = `${req.user.first_name} ${req.user.last_name}`.trim() || req.user.username;
  notifyStaff(req.ctx, 'platform.data', { kind: 'system', title: `${name} downloaded ${what}`, message: `From ${clientIp(req) || 'an unknown address'}. If that was not expected, review the platform audit trail.`, actionUrl: '/admin/audit' }, req.user.id);
}

platformRouter.get('/backup', requirePlatform('platform.data'), wrap(async (req, res) => {
  const ctx = req.ctx;
  if (ctx.db.name === ':memory:') throw badRequest('In-memory databases cannot be backed up.');
  browserCopy(req, 'a full database backup');
  const stamp = now().replace(/[-:]/g, '').slice(0, 13);
  const dest = join(tmpdir(), `vantage-backup-${stamp}-${newId().slice(0, 6)}.db`);
  await ctx.db.backup(dest);
  chmodSync(dest, 0o600);
  metaSet(ctx.db, 'last_backup_at', now());
  audit(ctx, { actor_id: req.user.id, action: 'backup', entity: 'database', detail: `${statSync(dest).size} bytes`, ip: ip(req) });
  res.download(dest, `vantage-backup-${stamp}.db`, () => { try { unlinkSync(dest); } catch {} });
}));

platformRouter.get('/export', requirePlatform('platform.data'), wrap((req, res) => {
  browserCopy(req, 'the service archive');
  const archive = exportInstance(req.ctx);
  audit(req.ctx, { actor_id: req.user.id, action: 'instance_export', entity: 'platform', ip: ip(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-instance-${now().slice(0, 10)}.json"`);
  res.json(archive);
}));

platformRouter.post('/import', requirePlatform('platform.data'), express.json({ limit: '512mb' }), wrap((req, res) => {
  let counts;
  try { counts = importInstance(req.ctx, req.body, req.user.id); } catch (error) { throw badRequest((error as Error).message); }
  res.json({ ok: true, counts, note: 'All sessions were reset. Sign in again.' });
}));
