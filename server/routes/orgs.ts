import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { requireAuth, requireSudo } from '../auth/middleware.ts';
import { scopeFor, orgCan } from '../authz/scope.ts';
import { ORG_PERMISSION_LIST, ORG_ROLES, ORG_ROLE_KEYS, type OrgPermission, type OrgRole } from '../../shared/permissions.ts';
import { audit, orgAuditClause, verifyAuditChain } from '../services/audit.ts';
import { orgSummaries } from '../services/org.ts';
import {
  exportOrganization, getOrg, grantOrgRole, isOrgMember, orgCounts, orgMembers, orgRoleHolders, orgUnits, publicOrg, removeFromOrg, revokeOrgRole,
  setUnitLeader, updateOrganization,
} from '../services/organizations.ts';
import { accessForOrg, decideAccess, endAccess } from '../services/access.ts';
import { parseRoster, planSync, applySync, divergence, rosterStats, isEdipi, summarizePlan, SOURCED_FIELDS } from '../services/personnel.ts';
import { listSchedules, saveSchedule, openHolds, placeHold, releaseHold, runDisposition, dispositionHistory, RETAINABLE_TYPES, HOLDABLE_TYPES } from '../services/retention.ts';
import { buildInventory, inventoryMarkdown } from '../services/privacyInventory.ts';
import { readRoster, planAccounts, applyAccounts } from '../services/accountImport.ts';
import { signInAudience, sendSignInDetails, MAX_SIGN_IN_BATCH } from '../services/signInMail.ts';
import { explainAccess } from '../services/explain.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { unlockAccount } from '../auth/lockout.ts';
import { now } from '../lib/ids.ts';
import { notify } from '../services/notifications.ts';
import { authorityBeyond, tellOtherInstances } from '../services/identity.ts';
import { membershipHistory } from '../services/membership.ts';

/**
 * The Unit Manager console's API (ADR-0006, ADR-0010): one Unit Instance, for the people who hold a role in it (Lead Unit
 * Managers, Unit Managers, Records Officers, Unit Auditors) and still belong to it. Every route names the Unit Instance
 * and the granular Unit Instance permission it needs; nothing here reads a Marine's records.
 */
export const orgsRouter = Router();
orgsRouter.use(requireAuth);

/** The caller holds one of these Unit Instance permissions in the Unit Instance the path names, and it is active. */
const inOrg = (...permissions: OrgPermission[]) => (req: Request, _res: Response, next: NextFunction) => {
  const orgId = String(req.params.orgId);
  const org = getOrg(req.ctx, orgId);
  // A Unit Instance the caller holds no role in is not found, rather than forbidden: its existence is not theirs to learn.
  const scope = scopeFor(req.ctx, req.user, req);
  if (!org || !scope.orgs[orgId]) return next(notFound('No such Unit Instance.'));
  if (!permissions.some((p) => orgCan(scope, p, orgId))) return next(forbidden('Your Unit Instance role does not cover that.', 'org_permission'));
  req.org = org;
  next();
};

const ip = (req: Request) => clientIp(req);
const orgOf = (req: Request) => req.org!;

/** The organizations the caller holds a role in, or belongs to. */
orgsRouter.get('/', wrap((req, res) => res.json({ organizations: orgSummaries(req.ctx, scopeFor(req.ctx, req.user, req)) })));

// Everything past the list is the console proper: re-authenticated, as the Vantage Administrator console is.
orgsRouter.use('/:orgId', requireSudo);

orgsRouter.get('/:orgId/overview', inOrg('org.view'), wrap((req, res) => {
  const org = orgOf(req);
  const scope = scopeFor(req.ctx, req.user, req);
  const lastSync = req.ctx.db.prepare('SELECT source, at, created, updated, separated FROM personnel_sync_runs WHERE org_id = ? ORDER BY at DESC LIMIT 1').get(org.id) ?? null;
  res.json({
    organization: publicOrg(org),
    counts: orgCounts(req.ctx, org.id),
    mine: scope.orgs[org.id],
    holds: openHolds(req.ctx, org.id).length,
    lastSync,
    catalog: { roles: ORG_ROLES, permissions: ORG_PERMISSION_LIST },
  });
}));

orgsRouter.patch('/:orgId', inOrg('org.settings', 'org.owners'), wrap((req, res) => {
  const body = parse(z.object({
    name: z.string().max(120).optional(),
    short_name: z.string().max(40).nullish(),
    settings: z.object({ vantageAccess: z.enum(['approval', 'notify']).optional() }).optional(),
  }), req.body);
  const scope = scopeFor(req.ctx, req.user, req);
  const org = orgOf(req);
  // Whether Vantage support must ask is the Lead Unit Managers' decision; the name and short name are Unit Managers' too.
  if (body.settings && !orgCan(scope, 'org.owners', org.id)) throw forbidden('Only a Lead Unit Manager sets the Vantage access policy.', 'org_permission');
  if ((body.name !== undefined || body.short_name !== undefined) && !orgCan(scope, 'org.settings', org.id)) throw forbidden('Your Unit Instance role does not cover renaming it.', 'org_permission');
  res.json(updateOrganization(req.ctx, req.user, org.id, { name: body.name, short_name: body.short_name, settings: body.settings as { vantageAccess: 'approval' | 'notify' } | undefined }, ip(req)));
}));

// ——— Unit Instance roles: Lead Unit Managers assign them, never their own (ADR-0010) ———

orgsRouter.get('/:orgId/roles', inOrg('org.view'), wrap((req, res) => {
  res.json({ holders: orgRoleHolders(req.ctx, orgOf(req).id), catalog: { roles: ORG_ROLES, permissions: ORG_PERMISSION_LIST } });
}));

orgsRouter.post('/:orgId/roles', inOrg('org.owners'), wrap((req, res) => {
  const body = parse(z.object({ user_id: z.string().max(64), role: z.enum(ORG_ROLE_KEYS as [OrgRole, ...OrgRole[]]), expires_at: z.string().max(40).nullish() }), req.body);
  res.status(201).json({ holders: grantOrgRole(req.ctx, req.user, orgOf(req).id, body, ip(req)) });
}));

orgsRouter.delete('/:orgId/roles/:userId/:role', inOrg('org.owners'), wrap((req, res) => {
  res.json({ holders: revokeOrgRole(req.ctx, req.user, orgOf(req).id, String(req.params.userId), String(req.params.role), ip(req)) });
}));

// ——— Members ———

orgsRouter.get('/:orgId/members', inOrg('org.members', 'org.owners', 'org.roles'), wrap((req, res) => {
  res.json({ members: orgMembers(req.ctx, orgOf(req).id, String(req.query.q || '').slice(0, 60)) });
}));

const memberOf = (req: Request) => {
  const userId = String(req.params.userId);
  if (!isOrgMember(req.ctx, orgOf(req).id, userId)) throw notFound('No such member of this Unit Instance.');
  return userId;
};

/** "Why can they?": every grant behind what a member can do in the organization's units. */
orgsRouter.get('/:orgId/members/:userId/why', inOrg('org.members', 'org.owners', 'org.roles', 'org.audit'), wrap((req, res) => {
  const org = orgOf(req);
  const userId = memberOf(req);
  const units = (req.ctx.db.prepare('SELECT id FROM units WHERE org_id = ?').all(org.id) as Array<{ id: string }>).map((u) => u.id);
  const orgRoles = orgRoleHolders(req.ctx, org.id).filter((h) => h.user_id === userId).map((h) => ({ role: h.role, label: ORG_ROLES[h.role].label, expires_at: h.expires_at, granted_by_name: h.granted_by_name }));
  res.json({ units: explainAccess(req.ctx, userId, units), orgRoles });
}));

/**
 * Where a member has served in this Unit Instance, and when (ADR-0009): its own units only. A former member's history
 * is still this instance's to read; which other commands they served in is not.
 */
orgsRouter.get('/:orgId/members/:userId/history', inOrg('org.members', 'org.audit'), wrap((req, res) => {
  const org = orgOf(req);
  const userId = String(req.params.userId);
  const history = membershipHistory(req.ctx, userId, [org.id]);
  if (!history.length && !isOrgMember(req.ctx, org.id, userId)) throw notFound('No such member of this Unit Instance.');
  res.json({ history });
}));

orgsRouter.post('/:orgId/members/:userId/unlock', inOrg('org.members'), wrap((req, res) => {
  const userId = memberOf(req);
  // An unlock lets guessing start again. On an account that also serves in another Unit Instance, or runs the service,
  // that is not this Unit Instance's to allow: the lock lapses on its own, a reset link lifts it, or Vantage support does.
  if (userId !== req.user.id && authorityBeyond(req.ctx, userId, orgOf(req).id)) throw forbidden('This account also holds authority outside this Unit Instance. Its lock lifts by itself, with a password reset link, or through Vantage support.', 'cross_instance');
  res.json({ ok: true, unlocked: unlockAccount(req.ctx, userId, req.user.id, ip(req)) });
}));

orgsRouter.post('/:orgId/members/:userId/logout', inOrg('org.members'), wrap((req, res) => {
  const userId = memberOf(req);
  const org = orgOf(req);
  // Ending sessions only ever protects an account, so any Unit Instance the person serves in may do it. They are told,
  // and so is every other instance they serve in, since the sessions it ended were theirs too.
  const revoked = invalidateUserSessions(req.ctx, userId);
  audit(req.ctx, { actor_id: req.user.id, action: 'force_logout', entity: 'user', entity_id: userId, subject_id: userId, org_id: org.id, detail: `sessions revoked: ${revoked}`, ip: ip(req) });
  tellOtherInstances(req.ctx, userId, org.id, `ended this account's sessions (${revoked})`, ip(req));
  if (userId !== req.user.id) notify(req.ctx, userId, { kind: 'security', title: `${org.name} signed you out everywhere`, message: 'Sign in again to carry on. If you did not expect this, ask your Unit Manager why.', actionUrl: '/settings' });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

orgsRouter.delete('/:orgId/members/:userId', inOrg('org.members'), wrap((req, res) => {
  res.json(removeFromOrg(req.ctx, req.user, orgOf(req).id, memberOf(req), ip(req)));
}));

const accountRoster = express.raw({ type: () => true, limit: '5mb' });
orgsRouter.post('/:orgId/accounts/import', inOrg('org.members'), accountRoster, wrap((req, res) => {
  const org = orgOf(req);
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) throw badRequest('Choose a roster file.');
  let filename = String(req.get('x-vantage-filename') || 'roster.xlsx');
  try { filename = decodeURIComponent(filename); } catch {}
  const rows = readRoster(buffer, filename.slice(0, 200));
  if (req.query.apply !== '1') return res.json(planAccounts(req.ctx, org.id, rows));
  const result = applyAccounts(req.ctx, req.user, org.id, rows, ip(req));
  audit(req.ctx, { actor_id: req.user.id, action: 'accounts_imported', entity: 'organization', entity_id: org.id, org_id: org.id, detail: `${result.created} created; ${result.counts.exists} already existed; ${result.counts.error} skipped; ${result.counts.new_units} new units`, ip: ip(req) });
  res.json(result);
}));

orgsRouter.get('/:orgId/accounts/sign-in-details', inOrg('org.members'), wrap((req, res) => res.json(signInAudience(req.ctx, req.user.id, orgOf(req).id))));

orgsRouter.post('/:orgId/accounts/sign-in-details', inOrg('org.members'), wrap(async (req, res) => {
  const ctx = req.ctx;
  const { userIds } = parse(z.object({ userIds: z.array(z.string().max(64)).min(1).max(MAX_SIGN_IN_BATCH) }), req.body);
  if (!ctx.mailer.enabled) throw badRequest('Email is not set up on Vantage right now. Contact Vantage support.');
  const results = [];
  for (const id of [...new Set(userIds)]) results.push(await sendSignInDetails(ctx, req.user, id, orgOf(req).id, ip(req)));
  res.json({ results });
}));

// ——— Units ———

orgsRouter.get('/:orgId/units', inOrg('org.view'), wrap((req, res) => res.json({ units: orgUnits(req.ctx, orgOf(req).id) })));

orgsRouter.post('/:orgId/units/:unitId/leader', inOrg('org.units'), wrap((req, res) => {
  const { user_id } = parse(z.object({ user_id: z.string().max(64) }), req.body);
  res.json(setUnitLeader(req.ctx, req.user, orgOf(req).id, String(req.params.unitId), user_id, ip(req)));
}));

// ——— Personnel feed ———

const rosterBody = express.text({ type: ['text/*', 'application/json'], limit: '32mb' });

orgsRouter.get('/:orgId/personnel', inOrg('org.personnel'), wrap((req, res) => res.json({ ...rosterStats(req.ctx, orgOf(req).id), sourcedFields: SOURCED_FIELDS })));
orgsRouter.get('/:orgId/personnel/divergence', inOrg('org.personnel'), wrap((req, res) => res.json(divergence(req.ctx, orgOf(req).id))));

orgsRouter.post('/:orgId/personnel/sync', inOrg('org.personnel'), rosterBody, wrap((req, res) => {
  const ctx = req.ctx;
  const org = orgOf(req);
  const apply = String(req.query.apply || '') === '1';
  const source = String(req.query.source || 'roster').slice(0, 60).trim() || 'roster';
  const text = typeof req.body === 'string' ? req.body : '';
  if (!text.trim()) throw badRequest('Post the roster extract as the request body.');
  const confirmSeparations = apply && String(req.query.confirm_separations || '') === '1';
  const parsed = parseRoster(text);
  const plan = planSync(ctx, org.id, parsed.rows, source, parsed.rejected, confirmSeparations);
  if (!apply) {
    audit(ctx, { actor_id: req.user.id, action: 'personnel_sync_planned', org_id: org.id, detail: `${source}: ${plan.rowsSeen} rows`, ip: ip(req) });
    return res.json({ applied: false, plan: summarizePlan(plan) });
  }
  if (plan.massSeparation) {
    throw badRequest(
      `That extract would separate ${plan.massSeparation.count} of ${plan.massSeparation.activeBefore} people on the roster. If the extract really is the whole Unit Instance, re-send it with confirm_separations=1.`,
      { code: 'mass_separation', massSeparation: plan.massSeparation },
    );
  }
  const { runId } = applySync(ctx, plan, req.user.id);
  res.json({ applied: true, runId, plan: summarizePlan(plan) });
}));

orgsRouter.post('/:orgId/personnel/link', inOrg('org.personnel'), wrap((req, res) => {
  const ctx = req.ctx;
  const org = orgOf(req);
  const { user_id, edipi } = parse(z.object({ user_id: z.string().max(64), edipi: z.string().max(32).nullable() }), req.body);
  if (!isOrgMember(ctx, org.id, user_id)) throw badRequest('Link only members of this Unit Instance.');
  // The EDIPI is how an account signs in with a CAC. Somebody else's account that also serves in another Unit Instance,
  // or that runs the service, carries authority beyond this one: re-keying its sign-in is not this organization's to do,
  // or one Unit Instance's Unit Manager could sign in as a leader of another (ADR-0008).
  if (user_id !== req.user.id && authorityBeyond(ctx, user_id, org.id)) throw forbidden('This account also holds authority outside this Unit Instance, so its EDIPI cannot be changed from here.', 'cross_instance');
  const current = ctx.db.prepare('SELECT edipi, edipi_verified_at FROM users WHERE id = ?').get(user_id) as { edipi: string | null; edipi_verified_at: string | null } | undefined;
  const before = current?.edipi ?? null;
  // Once the person's own card has proven an EDIPI, it is their sign-in key: no Unit Manager moves it, not even their
  // own, or one could free their card's EDIPI and link it to somebody else's account to sign in as them (ADR-0009).
  // Vantage support corrects a proven EDIPI, on the record.
  if (before && current?.edipi_verified_at && edipi !== before) throw forbidden('This EDIPI was proven by the person’s own card. Only Vantage support changes it.', 'edipi_verified');
  if (edipi !== null) {
    if (!isEdipi(edipi)) throw badRequest('An EDIPI is exactly ten digits.', { fieldErrors: { edipi: 'Ten digits.' } });
    const taken = ctx.db.prepare('SELECT id FROM users WHERE edipi = ? AND id <> ?').get(edipi, user_id) as { id: string } | undefined;
    if (taken) throw badRequest('Another account already carries that EDIPI.', { fieldErrors: { edipi: 'Already linked to another account.' } });
  }
  ctx.db.prepare("UPDATE users SET edipi = ?, edipi_verified_at = CASE WHEN edipi IS ? THEN edipi_verified_at END, identity_source = CASE WHEN ? IS NULL THEN 'local' ELSE identity_source END, updated_at = ? WHERE id = ?").run(edipi, edipi, edipi, now(), user_id);
  // Somebody else's changed sign-in key ends the sessions opened under the old one, and they are told: a card they do not
  // hold now signing in as them is something only they would notice.
  const revoked = edipi !== before && user_id !== req.user.id ? invalidateUserSessions(ctx, user_id) : 0;
  audit(ctx, { actor_id: req.user.id, action: edipi ? 'personnel_link' : 'personnel_unlink', entity: 'users', entity_id: user_id, subject_id: user_id, org_id: org.id, detail: `${edipi ? `EDIPI ${edipi}` : 'EDIPI cleared'}; sessions revoked: ${revoked}`, ip: ip(req) });
  if (edipi !== before && user_id !== req.user.id) {
    notify(ctx, user_id, { kind: 'security', title: edipi ? 'A CAC was linked to your account' : 'The CAC link on your account was removed', message: `${org.name} ${edipi ? `linked the card with DoD ID ending ${edipi.slice(-4)}` : 'removed the card link'}. If that is not your card, contact your Unit Manager or Vantage support.`, actionUrl: '/settings' });
  }
  res.json({ ok: true });
}));

// ——— Retention and holds ———

orgsRouter.get('/:orgId/retention', inOrg('org.retention', 'org.holds'), wrap((req, res) => {
  const org = orgOf(req);
  res.json({ schedules: listSchedules(req.ctx, org.id), retainableTypes: RETAINABLE_TYPES, holdableTypes: HOLDABLE_TYPES, holds: openHolds(req.ctx, org.id), history: dispositionHistory(req.ctx, org.id, 50) });
}));

orgsRouter.put('/:orgId/retention/schedule', inOrg('org.retention'), wrap((req, res) => {
  const body = parse(z.object({
    record_type: z.string().max(40),
    retain_days: z.coerce.number().int().min(1).max(36_500),
    disposition: z.enum(['destroy', 'anonymize', 'review']),
    authority: z.string().max(300).nullable().optional(),
    notes: z.string().max(1000).nullable().optional(),
    enabled: z.boolean().optional(),
  }), req.body);
  res.json(saveSchedule(req.ctx, orgOf(req).id, body, req.user.id));
}));

orgsRouter.post('/:orgId/retention/run', inOrg('org.retention'), wrap((req, res) => {
  const apply = String(req.query.apply || '') === '1';
  const result = runDisposition(req.ctx, { orgId: orgOf(req).id, dryRun: !apply, actorId: req.user.id });
  res.json({ applied: apply && !result.blocked, ...result });
}));

orgsRouter.post('/:orgId/holds', inOrg('org.holds'), wrap((req, res) => {
  const body = parse(z.object({
    scope: z.enum(['instance', 'user', 'record_type']),
    subject_id: z.string().max(64).nullable().optional(),
    record_type: z.string().max(40).nullable().optional(),
    reason: z.string().min(1).max(1000),
  }), req.body);
  res.json(placeHold(req.ctx, orgOf(req).id, body, req.user.id));
}));

orgsRouter.delete('/:orgId/holds/:id', inOrg('org.holds'), wrap((req, res) => {
  releaseHold(req.ctx, orgOf(req).id, String(req.params.id), req.user.id);
  res.json({ ok: true });
}));

// ——— Privacy, audit, export ———

orgsRouter.get('/:orgId/privacy/inventory', inOrg('org.privacy'), wrap((req, res) => {
  const inventory = buildInventory(req.ctx, orgOf(req).id);
  if (String(req.query.format || '') === 'markdown') { res.type('text/markdown').send(inventoryMarkdown(inventory)); return; }
  res.json(inventory);
}));

orgsRouter.get('/:orgId/audit', inOrg('org.audit'), wrap((req, res) => {
  const org = orgOf(req);
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const action = String(req.query.action || '').slice(0, 60);
  const rows = req.ctx.db.prepare(`SELECT al.id, al.seq, al.action, al.entity, al.entity_id, al.unit_id, al.detail, al.at, al.ip, al.actor_id, al.subject_id,
        u.username AS actor_username, u.first_name || ' ' || u.last_name AS actor_name, s.first_name || ' ' || s.last_name AS subject_name,
        (SELECT 1 FROM platform_roles p WHERE p.user_id = al.actor_id LIMIT 1) AS actor_is_staff
      FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id
     WHERE ${orgAuditClause('al')} ${action ? 'AND al.action = ?' : ''} ORDER BY al.seq DESC LIMIT ?`).all(org.id, org.id, ...(action ? [action] : []), limit);
  res.json({ rows, chain: { ok: verifyAuditChain(req.ctx).ok } });
}));

orgsRouter.get('/:orgId/export', inOrg('org.export'), wrap((req, res) => {
  const org = orgOf(req);
  const out = exportOrganization(req.ctx, org.id);
  audit(req.ctx, { actor_id: req.user.id, action: 'organization_export', entity: 'organization', entity_id: org.id, org_id: org.id, ip: ip(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-${org.slug.toLowerCase()}-${now().slice(0, 10)}.json"`);
  res.json(out);
}));

// ——— Vantage access requests ———

orgsRouter.get('/:orgId/access', inOrg('org.access', 'org.audit'), wrap((req, res) => res.json({ grants: accessForOrg(req.ctx, orgOf(req).id) })));

orgsRouter.post('/:orgId/access/:id/approve', inOrg('org.access'), wrap((req, res) => {
  const { note } = parse(z.object({ note: z.string().max(500).nullish() }), req.body ?? {});
  res.json(decideAccess(req.ctx, req.user, orgOf(req).id, String(req.params.id), true, note ?? null, ip(req)));
}));

orgsRouter.post('/:orgId/access/:id/deny', inOrg('org.access'), wrap((req, res) => {
  const { note } = parse(z.object({ note: z.string().max(500).nullish() }), req.body ?? {});
  res.json(decideAccess(req.ctx, req.user, orgOf(req).id, String(req.params.id), false, note ?? null, ip(req)));
}));

orgsRouter.post('/:orgId/access/:id/revoke', inOrg('org.access'), wrap((req, res) => {
  res.json(endAccess(req.ctx, req.user, String(req.params.id), 'org', orgOf(req).id, ip(req)));
}));
