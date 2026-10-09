import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { requireAuth, requireSudo } from '../auth/middleware.ts';
import { scopeFor, orgCan } from '../authz/scope.ts';
import { ORG_PERMISSION_LIST, ORG_ROLES, ORG_ROLE_KEYS, ROLE_TEMPLATE, type OrgPermission, type OrgRole } from '../../shared/permissions.ts';
import { audit, orgAuditClause, verifyAuditChain } from '../services/audit.ts';
import { canManageRoleDefinition, orgSummaries, type RoleRow } from '../services/org.ts';
import {
  exportOrganization, getOrg, grantOrgRole, isOrgMember, orgCounts, orgMembers, orgRoleHolders, orgUnits, publicOrg, removeFromOrg, revokeOrgRole,
  setUnitLeader, updateOrganization,
} from '../services/organizations.ts';
import { accessForOrg, decideAccess, endAccess } from '../services/access.ts';
import { parseRoster, planSync, holdBackRoleHolders, applySync, divergence, rosterStats, isEdipi, summarizePlan, SOURCED_FIELDS } from '../services/personnel.ts';
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
import { AUDIT_CSV_COLUMNS, AUDIT_EXPORT_MAX, auditActions, auditDay, auditFilterLabel, auditQuery, auditRows, type AuditTrail } from '../services/auditQuery.ts';
import {
  addStandardDutyTypes, applyConfigurationImport, exportUnitConfiguration, planConfigurationImport, saveBillet, saveDutyType, saveTrainingRequirement,
  unitConfiguration, updateUnitSettings, type UnitConfigurationFile,
} from '../services/unitConfig.ts';
import { rowsToCsv } from '../../shared/csv.ts';
import { REPORT_PERIODS, UNIT_CONFIG_FORMAT } from '../../shared/unitConfig.ts';
import { SCORING_COMBINE, SCORING_CONDITIONS, SCORING_LIMITS, SCORING_METHODS } from '../../shared/dutyScoring.ts';
import { publishScoringPolicy, withdrawScoringPolicy } from '../services/dutyScoring.ts';
import { TRAINING_TYPES } from '../../shared/constants.ts';
import type { PeriodKey } from '../../shared/metrics.ts';

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
  const plan = holdBackRoleHolders(ctx, planSync(ctx, org.id, parsed.rows, source, parsed.rejected, confirmSeparations), orgCan(scopeFor(ctx, req.user, req), 'org.owners', org.id));
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
  // A Unit Instance role is authority over this instance itself. Re-keying the sign-in of someone who holds one is the
  // Lead Unit Managers' call, or a Unit Manager could link their own card to a Lead Unit Manager's account (ADR-0010).
  if (user_id !== req.user.id && !orgCan(scopeFor(ctx, req.user, req), 'org.owners', org.id)
    && ctx.db.prepare('SELECT 1 FROM org_roles WHERE org_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)').get(org.id, user_id, now())) {
    throw forbidden('This person holds a Unit Instance role. Only a Lead Unit Manager links or changes their CAC.', 'org_permission');
  }
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

/**
 * The Unit Instance's trail (ADR-0012): its own entries and its units', filtered and paged on the server like the
 * platform's, so nothing older than a page is out of reach. A unit filter names one of its own units.
 */
const orgAuditQuery = auditQuery.extend({ unit: z.string().trim().max(64).optional() });

function orgTrail(req: Request, unit?: string): AuditTrail {
  const org = orgOf(req);
  if (unit && !req.ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND org_id = ?').get(unit, org.id)) throw notFound('No such unit in this Unit Instance.');
  return {
    where: `${orgAuditClause('al')}${unit ? ' AND al.unit_id = ?' : ''}`,
    params: [org.id, org.id, ...(unit ? [unit] : [])],
    hideCacUsernames: true,
    columns: "u.first_name || ' ' || u.last_name AS actor_name, s.first_name || ' ' || s.last_name AS subject_name, (SELECT 1 FROM platform_roles p WHERE p.user_id = al.actor_id LIMIT 1) AS actor_is_staff",
    names: true,
  };
}

/**
 * Verifying the chain reads the whole service's trail, so an instance's page reuses one answer for a minute: a filter
 * applied again and again is not a full verification each time.
 */
const chainChecks = new WeakMap<object, { at: number; ok: boolean }>();
function chainHolds(ctx: Request['ctx']) {
  const seen = chainChecks.get(ctx);
  if (seen && Date.now() - seen.at < 60_000) return seen.ok;
  const { ok } = verifyAuditChain(ctx);
  chainChecks.set(ctx, { at: Date.now(), ok });
  return ok;
}

function instanceChain(req: Request) {
  const ok = chainHolds(req.ctx);
  const trail = orgTrail(req);
  const { n } = req.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log al WHERE ${trail.where}`).get(...trail.params) as { n: number };
  return { ok, count: n, ...(ok ? {} : { reason: 'An entry in the audit trail does not match the chain' }) };
}

orgsRouter.get('/:orgId/audit', inOrg('org.audit'), wrap((req, res) => {
  const q = parse(orgAuditQuery, req.query);
  const limit = q.limit ?? 200;
  const trail = orgTrail(req, q.unit);
  const rows = auditRows(req.ctx, trail, q, limit + 1);
  const page = rows.slice(0, limit);
  const first = !q.before;
  res.json({
    rows: page,
    next: rows.length > limit ? page.at(-1)!.seq : null,
    // The chain is verified, and the action list read, on the first page only, not on every page back. The chain is
    // the whole service's, so a Unit Instance is told whether it holds and how many of the entries are its own, never
    // the service's count or which entry broke it, which may be another instance's.
    chain: first ? instanceChain(req) : null,
    actions: first ? auditActions(req.ctx, orgTrail(req)) : null,
  });
}));

const ORG_AUDIT_CSV_COLUMNS = [...AUDIT_CSV_COLUMNS.slice(0, 9), 'unit_id', ...AUDIT_CSV_COLUMNS.slice(9)];
/** The Unit Instance's trail as a file, for its commander or an inspector. Downloading it is itself in the trail. */
orgsRouter.get('/:orgId/audit/export', inOrg('org.audit'), wrap((req, res) => {
  const org = orgOf(req);
  const format = String(req.query.format || 'csv') === 'json' ? 'json' : 'csv';
  const q = parse(orgAuditQuery.omit({ before: true, limit: true }), req.query);
  const rows = auditRows(req.ctx, orgTrail(req, q.unit), q, AUDIT_EXPORT_MAX + 1);
  if (rows.length > AUDIT_EXPORT_MAX) throw badRequest(`More than ${AUDIT_EXPORT_MAX.toLocaleString('en-US')} entries match. Narrow the dates and export each range.`, { code: 'export_too_large' });
  const filter = auditFilterLabel({ action: q.action, q: q.q, from: q.from, to: q.to, unit: q.unit });
  audit(req.ctx, { actor_id: req.user.id, action: 'organization_audit_exported', entity: 'audit_log', org_id: org.id, detail: `${rows.length} rows as ${format}${filter ? `; ${filter}` : ''}`, ip: ip(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-${org.slug.toLowerCase()}-audit-${now().slice(0, 10)}.${format}"`);
  if (format === 'json') return res.json({ exportedAt: now(), organization: { id: org.id, name: org.name }, filter: q, rows });
  res.type('text/csv').send(rowsToCsv(rows, ORG_AUDIT_CSV_COLUMNS));
}));

orgsRouter.get('/:orgId/export', inOrg('org.export'), wrap((req, res) => {
  const org = orgOf(req);
  const out = exportOrganization(req.ctx, org.id);
  audit(req.ctx, { actor_id: req.user.id, action: 'organization_export', entity: 'organization', entity_id: org.id, org_id: org.id, ip: ip(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-${org.slug.toLowerCase()}-${now().slice(0, 10)}.json"`);
  res.json(out);
}));

/** A username Vantage made from a card is the person's EDIPI (server/auth/cac.ts); exports leave it out. */
const CAC_USERNAME = /^edipi-\d+$/i;

/**
 * The Unit Instance's roster as a spreadsheet, for its S-1: who serves where, in which billet and with which roles. No
 * EDIPI, no email address, and nothing anyone recorded. Downloading it is in the trail.
 */
orgsRouter.get('/:orgId/roster.csv', inOrg('org.export'), wrap((req, res) => {
  const org = orgOf(req);
  const holders = orgRoleHolders(req.ctx, org.id);
  const rows = orgMembers(req.ctx, org.id, '', null).flatMap((m) => {
    const person = m as unknown as { username: string; first_name: string; last_name: string; rank_abbr: string | null; active: number; units: Array<{ unit_id: string; unit: string; billet: string | null; is_primary: number; roles: string | null }> };
    const instanceRoles = holders.filter((h) => h.user_id === m.id).map((h) => ORG_ROLES[h.role].label).join('; ');
    const base = { last_name: person.last_name, first_name: person.first_name, rank: person.rank_abbr ?? '', username: CAC_USERNAME.test(person.username) ? '' : person.username, status: person.active ? 'active' : 'off', unit_instance_roles: instanceRoles };
    return person.units.length
      ? person.units.map((u) => ({ ...base, unit_id: u.unit_id, unit: u.unit, billet: u.billet ?? '', primary: u.is_primary ? 'yes' : '', unit_roles: u.roles ?? '' }))
      : [{ ...base, unit_id: '', unit: '', billet: '', primary: '', unit_roles: '' }];
  });
  audit(req.ctx, { actor_id: req.user.id, action: 'organization_roster_exported', entity: 'organization', entity_id: org.id, org_id: org.id, detail: `${rows.length} rows`, ip: ip(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-${org.slug.toLowerCase()}-roster-${now().slice(0, 10)}.csv"`);
  res.type('text/csv').send(rowsToCsv(rows, ['last_name', 'first_name', 'rank', 'username', 'status', 'unit_id', 'unit', 'billet', 'primary', 'unit_roles', 'unit_instance_roles']));
}));

// ——— Unit roles: defined and granted through /api/org, listed here across the whole Unit Instance ———

/**
 * Every unit role in the Unit Instance's units, who holds it, and whether the caller may change it. The roles are
 * defined, granted and revoked through the same calls the app's Team page makes (/api/org), which decide each one.
 */
orgsRouter.get('/:orgId/unit-roles', inOrg('org.roles', 'org.members', 'org.owners'), wrap((req, res) => {
  const ctx = req.ctx;
  const org = orgOf(req);
  const scope = scopeFor(ctx, req.user, req);
  const roles = ctx.db.prepare('SELECT r.* FROM roles r JOIN units u ON u.id = r.unit_id WHERE u.org_id = ? AND u.active = 1 ORDER BY r.unit_id, r.position DESC, r.name').all(org.id) as Array<RoleRow & { created_at: string }>;
  const holders = ctx.db.prepare(`SELECT mr.role_id, mr.user_id, mr.expires_at, us.username, us.first_name, us.last_name, rk.abbr AS rank_abbr
      FROM member_roles mr JOIN roles r ON r.id = mr.role_id JOIN units u ON u.id = r.unit_id JOIN users us ON us.id = mr.user_id LEFT JOIN ranks rk ON rk.id = us.rank_id
     WHERE u.org_id = ? AND u.active = 1 AND us.active = 1 AND (mr.expires_at IS NULL OR mr.expires_at > ?) ORDER BY us.last_name, us.first_name`).all(org.id, now()) as Array<{ role_id: string; user_id: string; expires_at: string | null; username: string; first_name: string; last_name: string; rank_abbr: string | null }>;
  const byRole = new Map<string, typeof holders>();
  for (const h of holders) byRole.set(h.role_id, [...(byRole.get(h.role_id) || []), h]);
  res.json({
    roles: roles.map((r) => ({ ...r, editable: canManageRoleDefinition(ctx, req.user, scope, r), holders: (byRole.get(r.id) || []).map(({ role_id: _r, ...h }) => h) })),
    template: ROLE_TEMPLATE,
  });
}));

// ——— Unit configuration (ADR-0012): billets, duty types, training requirements, work and report settings ———

orgsRouter.get('/:orgId/configuration', inOrg('org.view'), wrap((req, res) => res.json(unitConfiguration(req.ctx, orgOf(req).id))));

const text = (max: number) => z.string().max(max);
const billetBody = z.object({ unit_id: z.string().max(64).nullish(), title: text(80).optional(), code: text(20).nullish(), description: text(300).nullish(), active: z.boolean().optional() });
const dutyTypeBody = z.object({ code: text(20).optional(), name: text(60).optional(), description: text(300).nullish(), active: z.boolean().optional() });
const trainingTypes = TRAINING_TYPES as unknown as [(typeof TRAINING_TYPES)[number], ...Array<(typeof TRAINING_TYPES)[number]>];
const requirementBody = z.object({
  unit_id: z.string().max(64).nullish(), title: text(120).optional(), type: z.enum(trainingTypes).optional(), course_code: text(40).nullish(),
  interval_months: z.number().int().min(1).max(120).nullish(), description: text(300).nullish(), active: z.boolean().optional(),
});

orgsRouter.post('/:orgId/billets', inOrg('org.config'), wrap((req, res) => {
  res.status(201).json(saveBillet(req.ctx, req.user, orgOf(req).id, parse(billetBody.required({ title: true }), req.body), undefined, ip(req)));
}));
orgsRouter.patch('/:orgId/billets/:id', inOrg('org.config'), wrap((req, res) => {
  res.json(saveBillet(req.ctx, req.user, orgOf(req).id, parse(billetBody, req.body), String(req.params.id), ip(req)));
}));

orgsRouter.post('/:orgId/duty-types', inOrg('org.config'), wrap((req, res) => {
  res.status(201).json(saveDutyType(req.ctx, req.user, orgOf(req).id, parse(dutyTypeBody.required({ name: true }), req.body), undefined, ip(req)));
}));
orgsRouter.post('/:orgId/duty-types/standard', inOrg('org.config'), wrap((req, res) => res.json(addStandardDutyTypes(req.ctx, req.user, orgOf(req).id, ip(req)))));
orgsRouter.patch('/:orgId/duty-types/:id', inOrg('org.config'), wrap((req, res) => {
  res.json(saveDutyType(req.ctx, req.user, orgOf(req).id, parse(dutyTypeBody, req.body), String(req.params.id), ip(req)));
}));

orgsRouter.post('/:orgId/training-requirements', inOrg('org.config'), wrap((req, res) => {
  res.status(201).json(saveTrainingRequirement(req.ctx, req.user, orgOf(req).id, parse(requirementBody.required({ title: true }), req.body), undefined, ip(req)));
}));
orgsRouter.patch('/:orgId/training-requirements/:id', inOrg('org.config'), wrap((req, res) => {
  res.json(saveTrainingRequirement(req.ctx, req.user, orgOf(req).id, parse(requirementBody, req.body), String(req.params.id), ip(req)));
}));

const periods = REPORT_PERIODS as unknown as [PeriodKey, ...PeriodKey[]];
orgsRouter.patch('/:orgId/configuration/settings', inOrg('org.config'), wrap((req, res) => {
  const body = parse(z.object({
    work: z.object({ claimExpiryHours: z.number().int() }).partial().optional(),
    reports: z.object({ defaultPeriod: z.enum(periods) }).partial().optional(),
  }), req.body);
  res.json(updateUnitSettings(req.ctx, req.user, orgOf(req).id, body, ip(req)));
}));

/** Duty scoring (Task 18 brought forward): a new version, checked again in the service against the duty types in use. */
const keysOf = <T extends ReadonlyArray<{ key: string }>>(list: T) => list.map((x) => x.key) as unknown as [T[number]['key'], ...Array<T[number]['key']>];
const scoringBody = z.object({
  effective_from: auditDay,
  note: z.string().max(SCORING_LIMITS.note),
  rules: z.array(z.object({
    duty_type_id: z.string().max(64),
    method: z.enum(keysOf(SCORING_METHODS)),
    points: z.number().nullish().transform((v) => v ?? null),
    bands: z.array(z.object({ from_hours: z.number(), points: z.number() })).max(SCORING_LIMITS.bands).nullish().transform((v) => v ?? null),
  })).max(SCORING_LIMITS.rules),
  multipliers: z.array(z.object({ condition: z.enum(keysOf(SCORING_CONDITIONS)), factor: z.number() })).max(SCORING_CONDITIONS.length),
  combine: z.enum(keysOf(SCORING_COMBINE)),
});
orgsRouter.post('/:orgId/duty-scoring', inOrg('org.config'), wrap((req, res) => {
  res.status(201).json(publishScoringPolicy(req.ctx, req.user, orgOf(req).id, parse(scoringBody, req.body), ip(req)));
}));
orgsRouter.post('/:orgId/duty-scoring/:id/withdraw', inOrg('org.config'), wrap((req, res) => {
  res.json(withdrawScoringPolicy(req.ctx, req.user, orgOf(req).id, String(req.params.id), ip(req)));
}));

orgsRouter.get('/:orgId/configuration/export', inOrg('org.export'), wrap((req, res) => {
  const org = orgOf(req);
  const out = exportUnitConfiguration(req.ctx, org.id);
  audit(req.ctx, { actor_id: req.user.id, action: 'unit_configuration_exported', entity: 'organization', entity_id: org.id, org_id: org.id, detail: `${out.billets.length} billets, ${out.dutyTypes.length} duty types, ${out.trainingRequirements.length} training requirements`, ip: ip(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-${org.slug.toLowerCase()}-configuration-${now().slice(0, 10)}.json"`);
  res.json(out);
}));

/** A configuration file, as exported here or from another Unit Instance: read, bounded, and nothing else trusted. */
const configurationFile = z.object({
  format: z.literal(UNIT_CONFIG_FORMAT),
  generated_at: z.string().max(40).optional(),
  organization: z.object({ id: z.string().max(64), name: z.string().max(120) }).optional(),
  billets: z.array(z.object({ unit_id: z.string().max(64).nullish(), title: text(80).trim().min(1), code: text(20).nullish(), description: text(300).nullish() })).max(2000).default([]),
  dutyTypes: z.array(z.object({ code: text(20).default(''), name: text(60).trim().min(1), description: text(300).nullish() })).max(500).default([]),
  trainingRequirements: z.array(z.object({
    unit_id: z.string().max(64).nullish(), title: text(120).trim().min(1), type: z.enum(trainingTypes), course_code: text(40).nullish(),
    interval_months: z.number().int().min(1).max(120).nullish(), description: text(300).nullish(),
  })).max(2000).default([]),
  settings: z.object({
    work: z.object({ claimExpiryHours: z.number() }).partial().optional(),
    reports: z.object({ defaultPeriod: z.enum(periods) }).partial().optional(),
  }).optional(),
});

orgsRouter.post('/:orgId/configuration/import', inOrg('org.config'), wrap((req, res) => {
  const org = orgOf(req);
  const file = parse(configurationFile, req.body) as UnitConfigurationFile;
  if (req.query.apply !== '1') return res.json({ applied: false, ...planConfigurationImport(req.ctx, org.id, file) });
  res.json({ applied: true, ...applyConfigurationImport(req.ctx, req.user, org.id, file, ip(req)) });
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
