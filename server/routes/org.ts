import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { requireAuth, requireOperator } from '../auth/middleware.ts';
import { scopeFor, can, PERMISSIONS, isUnitOwner, positionIn, visibleUserIds, detailUnitsFor, unitsWith } from '../authz/scope.ts';
import { createUnit, updateUnit, archiveUnit, transferOwnership, addMember, removeMember, getUnit, validateRoleDefinition, validateRoleGrant, canManageRoleDefinition, type RoleRow } from '../services/org.ts';
import { audit } from '../services/audit.ts';
import { notify } from '../services/notifications.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { issueToken } from '../auth/tokens.ts';
import { layout } from '../services/email.ts';
import { emailField, profileSchema } from '../../shared/schemas.ts';
import { hydrate } from '../services/records.ts';
import { newId, now } from '../lib/ids.ts';
import { unitDashboard } from '../services/dashboard.ts';
import { ROLE_TEMPLATE } from '../../shared/permissions.ts';

export const orgRouter = Router();
orgRouter.use(requireAuth);

// Units ----------------------------------------------------------------
orgRouter.post('/units', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.status(201).json(createUnit(req.ctx, req.user, scope, req.body || {}, clientIp(req)));
}));
orgRouter.put('/units/:unitId', wrap((req, res) => res.json(updateUnit(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.unitId), req.body || {}, clientIp(req)))));
orgRouter.delete('/units/:unitId', wrap((req, res) => { archiveUnit(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.unitId), clientIp(req)); res.json({ ok: true }); }));
orgRouter.post('/units/:unitId/owner', wrap((req, res) => res.json(transferOwnership(req.ctx, req.user, String(req.params.unitId), String(req.body?.user_id || ''), clientIp(req)))));

orgRouter.get('/units/:unitId/dashboard', wrap((req, res) => {
  const unitId = String(req.params.unitId);
  const scope = scopeFor(req.ctx, req.user, req);
  if (!getUnit(req.ctx, unitId)) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('You cannot view that unit dashboard.');
  const to = String(req.query.to || new Date().toISOString().slice(0, 10));
  const from = String(req.query.from || new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw badRequest('Use a valid from/to window.');
  const includeMembers = can(scope, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId);
  audit(req.ctx, { actor_id: req.user.id, action: 'view_unit_dashboard', entity: 'unit', entity_id: unitId, unit_id: unitId, detail: `${from}..${to}`, ip: clientIp(req) });
  res.json(unitDashboard(req.ctx, unitId, from, to, { includeMembers }));
}));

orgRouter.get('/units/:unitId/audit', wrap((req, res) => {
  const unitId = String(req.params.unitId);
  const scope = scopeFor(req.ctx, req.user, req);
  if (!getUnit(req.ctx, unitId)) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.VIEW_AUDIT, unitId)) throw forbidden('You cannot read the access log for that unit.');
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const rows = req.ctx.db.prepare(`SELECT al.id, al.action, al.entity, al.entity_id, al.detail, al.at, al.actor_id, act.first_name AS actor_first, act.last_name AS actor_last, ar.abbr AS actor_rank, sub.first_name AS subject_first, sub.last_name AS subject_last
    FROM audit_log al LEFT JOIN users act ON act.id = al.actor_id LEFT JOIN ranks ar ON ar.id = act.rank_id LEFT JOIN users sub ON sub.id = al.subject_id WHERE al.unit_id = ? ORDER BY al.seq DESC LIMIT ?`).all(unitId, limit);
  res.json({ unit_id: unitId, rows });
}));

orgRouter.get('/units/:unitId/export', wrap((req, res) => {
  const unitId = String(req.params.unitId);
  const scope = scopeFor(req.ctx, req.user, req);
  const unit = getUnit(req.ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.EXPORT_DATA, unitId)) throw forbidden('You cannot export that unit.');
  const members = req.ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, u.mos, um.billet, r.abbr AS rank_abbr FROM users u JOIN unit_members um ON um.user_id = u.id LEFT JOIN ranks r ON r.id = u.rank_id WHERE um.unit_id = ? AND u.active = 1`).all(unitId);
  const out: Record<string, unknown> = { unit: { id: unit.id, name: unit.name }, generated_at: now(), members };
  for (const table of ['activities', 'projects', 'tasks', 'goals', 'trainings', 'awards'] as const) {
    out[table] = (req.ctx.db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL AND visibility = 'unit' AND unit_id = ? ORDER BY created_at DESC`).all(unitId) as Array<Record<string, unknown>>).map((r) => hydrate(r, table));
  }
  audit(req.ctx, { actor_id: req.user.id, action: 'export', entity: 'unit', entity_id: unitId, unit_id: unitId, ip: clientIp(req) });
  res.json(out);
}));

// Membership ------------------------------------------------------------
orgRouter.get('/directory', wrap((req, res) => {
  const unitId = String(req.query.unit_id || '');
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const scope = scopeFor(req.ctx, req.user, req);
  if (!unitId) throw badRequest('A destination unit is required.');
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot enroll members in that unit.');
  if (q.length < 2) throw badRequest('Enter at least two characters.', { fieldErrors: { q: 'Enter at least two characters.' } });
  const pattern = `${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = req.ctx.db.prepare(`SELECT u.id, u.username, u.first_name, u.last_name, r.abbr AS rank_abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
    WHERE u.active = 1 AND (u.username LIKE ? ESCAPE '\\' OR u.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.email LIKE ? ESCAPE '\\')
      AND NOT EXISTS (SELECT 1 FROM unit_members um WHERE um.user_id = u.id AND um.unit_id = ?) ORDER BY u.last_name, u.first_name LIMIT 10`).all(pattern, pattern, pattern, unitId);
  res.json({ results: rows });
}));

orgRouter.post('/units/:unitId/members', wrap((req, res) => {
  const ctx = req.ctx;
  const unitId = String(req.params.unitId);
  const scope = scopeFor(ctx, req.user, req);
  const { user_id, role_id, billet, primary } = parse(z.object({ user_id: z.string().max(64), role_id: z.string().max(120).nullish(), billet: z.string().max(80).nullish(), primary: z.boolean().optional() }), req.body);
  if (!getUnit(ctx, unitId)) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot add members to that unit.');
  if (user_id === req.user.id) throw forbidden('A second authorized person must change your own membership.', 'self_membership_change');
  const target = ctx.db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ? AND active = 1').get(user_id) as { id: string; first_name: string; last_name: string } | undefined;
  if (!target) throw badRequest('No such active account.', { fieldErrors: { user_id: 'No such active account.' } });
  const role = role_id ? (ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id) as RoleRow | undefined) : undefined;
  ctx.db.transaction(() => {
    addMember(ctx, user_id, unitId, { invitedBy: req.user.id, primary: Boolean(primary), billet: billet || null });
    if (role_id) {
      validateRoleGrant(ctx, req.user, scope, role, unitId, user_id);
      ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(user_id, role_id, unitId, req.user.id, now());
    }
  })();
  const revoked = invalidateUserSessions(ctx, user_id);
  audit(ctx, { actor_id: req.user.id, action: 'add_member', entity: 'unit', entity_id: unitId, subject_id: user_id, unit_id: unitId, detail: `${role?.name || 'default role'}; sessions revoked: ${revoked}`, ip: clientIp(req) });
  notify(ctx, user_id, { kind: 'unit', title: 'Added to a unit', message: `${req.user.first_name} ${req.user.last_name} added you to ${getUnit(ctx, unitId)?.name}. Sign in again to see it.`, actionUrl: '/', dedupeKey: `member:${unitId}:${user_id}` });
  res.status(201).json({ ok: true, sessionsRevoked: revoked });
}));

orgRouter.put('/units/:unitId/members/:userId', wrap((req, res) => {
  const ctx = req.ctx;
  const unitId = String(req.params.unitId);
  const userId = String(req.params.userId);
  const scope = scopeFor(ctx, req.user, req);
  const body = parse(z.object({ billet: z.string().max(80).nullish(), primary: z.boolean().optional() }), req.body);
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot manage members in that unit.');
  if (!ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) throw notFound('That Marine is not a member of this unit.');
  ctx.db.transaction(() => {
    if (body.billet !== undefined) ctx.db.prepare('UPDATE unit_members SET billet = ? WHERE user_id = ? AND unit_id = ?').run(body.billet || null, userId, unitId);
    if (body.primary) { ctx.db.prepare('UPDATE unit_members SET is_primary = 0 WHERE user_id = ?').run(userId); ctx.db.prepare('UPDATE unit_members SET is_primary = 1 WHERE user_id = ? AND unit_id = ?').run(userId, unitId); }
  })();
  audit(ctx, { actor_id: req.user.id, action: 'edit_membership', entity: 'unit', entity_id: unitId, subject_id: userId, unit_id: unitId, ip: clientIp(req) });
  res.json({ ok: true });
}));

orgRouter.delete('/units/:unitId/members/:userId', wrap((req, res) => {
  const ctx = req.ctx;
  const unitId = String(req.params.unitId);
  const userId = String(req.params.userId);
  const scope = scopeFor(ctx, req.user, req);
  if (!getUnit(ctx, unitId)) throw notFound('No such unit.');
  if (!ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) throw notFound('That Marine is not a member of this unit.');
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot remove members from that unit.');
  if (isUnitOwner(ctx, userId, unitId)) throw badRequest('That Marine leads this unit. Transfer ownership first.', { code: 'last_owner' });
  if (userId !== req.user.id && !isUnitOwner(ctx, req.user.id, unitId) && positionIn(scopeFor(ctx, { id: userId }), unitId) >= positionIn(scope, unitId)) throw forbidden('You cannot remove a Marine whose role is at or above your own.', 'hierarchy');
  const removed = removeMember(ctx, userId, unitId);
  const revoked = invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: req.user.id, action: 'remove_member', entity: 'unit', entity_id: unitId, subject_id: userId, unit_id: unitId, detail: `roles: ${removed.roles}; records frozen: ${removed.recordsFrozen}; sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, ...removed, sessionsRevoked: revoked });
}));

// Invitations -----------------------------------------------------------
orgRouter.post('/units/:unitId/invites', wrap(async (req, res) => {
  const ctx = req.ctx;
  const unitId = String(req.params.unitId);
  const scope = scopeFor(ctx, req.user, req);
  const body = parse(z.object({ email: emailField.optional(), first_name: z.string().max(80).optional(), last_name: z.string().max(80).optional(), rank_id: z.string().max(12).nullish(), billet: z.string().max(80).nullish(), role_id: z.string().max(120).nullish() }), req.body);
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot invite members to that unit.');
  if (body.email && ctx.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(body.email)) throw badRequest('An account with that email already exists. Enroll it instead.', { fieldErrors: { email: 'Already registered.' } });
  if (body.role_id) {
    const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(body.role_id) as RoleRow | undefined;
    if (!role || role.unit_id !== unitId) throw badRequest('No such role in this unit.');
    if (role.key === 'unit-leader') throw badRequest('Unit Leader is granted by ownership transfer, not invitation.');
    if (!isUnitOwner(ctx, req.user.id, unitId) && (!can(scope, PERMISSIONS.MANAGE_ROLES, unitId) || role.position >= positionIn(scope, unitId))) throw forbidden('You cannot grant that role.', 'hierarchy');
  }
  const { token, id } = issueToken(ctx, 'invite', { email: body.email || null, ttlMinutes: 7 * 24 * 60, createdBy: req.user.id, payload: { unit_id: unitId, role_id: body.role_id || null, billet: body.billet || null, first_name: body.first_name || null, last_name: body.last_name || null, rank_id: body.rank_id || null } });
  const url = `${ctx.config.publicUrl}/invite?token=${encodeURIComponent(token)}`;
  let emailed = false;
  if (body.email && ctx.mailer.enabled) {
    const mail = layout({ title: `You are invited to ${unit.short_name || unit.name} on Vantage`, intro: `${req.user.first_name} ${req.user.last_name} invited you to join ${unit.name}. Create your account with the link below. The invitation works for seven days.`, cta: { label: 'Accept invitation', url } });
    emailed = (await ctx.mailer.send({ to: body.email, subject: `Invitation to ${unit.short_name || unit.name} on Vantage`, text: mail.text, html: mail.html, kind: 'invite' })).ok;
  }
  audit(ctx, { actor_id: req.user.id, action: 'invite_created', entity: 'unit', entity_id: unitId, unit_id: unitId, detail: `${body.email || 'link'}; emailed: ${emailed}`, ip: clientIp(req) });
  res.status(201).json({ ok: true, id, url, emailed, expiresInDays: 7 });
}));

orgRouter.get('/units/:unitId/invites', wrap((req, res) => {
  const unitId = String(req.params.unitId);
  const scope = scopeFor(req.ctx, req.user, req);
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot view invitations for that unit.');
  const rows = req.ctx.db.prepare(`SELECT t.id, t.email, t.payload, t.expires_at, t.used_at, t.created_at, u.first_name AS by_first, u.last_name AS by_last FROM tokens t LEFT JOIN users u ON u.id = t.created_by WHERE t.kind = 'invite' AND json_extract(t.payload, '$.unit_id') = ? AND t.expires_at > ? ORDER BY t.created_at DESC LIMIT 50`).all(unitId, now()) as Array<Record<string, unknown>>;
  res.json({ invites: rows.map((r) => ({ ...r, payload: JSON.parse(String(r.payload || '{}')) })) });
}));

orgRouter.delete('/invites/:id', wrap((req, res) => {
  const row = req.ctx.db.prepare(`SELECT id, payload FROM tokens WHERE id = ? AND kind = 'invite' AND used_at IS NULL`).get(String(req.params.id)) as { id: string; payload: string } | undefined;
  if (!row) throw notFound('No such invitation.');
  const unitId = String(JSON.parse(row.payload || '{}').unit_id || '');
  if (!can(scopeFor(req.ctx, req.user, req), PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot revoke that invitation.');
  req.ctx.db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(now(), row.id);
  res.json({ ok: true });
}));

// Roles -----------------------------------------------------------------
orgRouter.get('/roles', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const roles = scope.unitIds.length ? (req.ctx.db.prepare(`SELECT * FROM roles WHERE unit_id IN (${scope.unitIds.map(() => '?').join(',')}) ORDER BY unit_id, position DESC`).all(...scope.unitIds) as RoleRow[]) : [];
  res.json({ roles: roles.map((r) => ({ ...r, editable: canManageRoleDefinition(req.ctx, req.user, scope, r) })), positions: scope.positions, template: ROLE_TEMPLATE });
}));

const roleBody = z.object({ unit_id: z.string().max(64), name: z.string().max(60), description: z.string().max(300).nullish(), color: z.string().max(20).nullish(), position: z.coerce.number().int(), permissions: z.coerce.number().int() });

orgRouter.post('/roles', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const body = parse(roleBody, req.body);
  const { name } = validateRoleDefinition(ctx, req.user, scope, body);
  const id = `${body.unit_id}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${newId().slice(0, 6)}`.slice(0, 120);
  ctx.db.prepare('INSERT INTO roles (id, unit_id, name, description, color, position, permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, body.unit_id, name, body.description || null, body.color || '#6b7a8f', body.position, body.permissions, now());
  audit(ctx, { actor_id: req.user.id, action: 'create_role', entity: 'role', entity_id: id, unit_id: body.unit_id, detail: name, ip: clientIp(req) });
  res.status(201).json(ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(id));
}));

orgRouter.put('/roles/:roleId', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(String(req.params.roleId)) as RoleRow | undefined;
  if (!role) throw notFound('No such role.');
  const body = parse(roleBody.partial().omit({ unit_id: true }), req.body);
  const def = { name: body.name ?? role.name, position: body.position ?? role.position, permissions: body.permissions ?? role.permissions, unit_id: role.unit_id };
  const { name } = validateRoleDefinition(ctx, req.user, scope, def, role);
  let revoked = 0;
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE roles SET name = ?, description = ?, color = ?, position = ?, permissions = ? WHERE id = ?').run(name, body.description === undefined ? role.description : body.description || null, body.color === undefined ? role.color : body.color || null, def.position, def.permissions, role.id);
    if (def.permissions !== role.permissions || def.position !== role.position) {
      for (const h of ctx.db.prepare('SELECT DISTINCT user_id FROM member_roles WHERE role_id = ?').all(role.id) as Array<{ user_id: string }>) revoked += invalidateUserSessions(ctx, h.user_id);
    }
  })();
  audit(ctx, { actor_id: req.user.id, action: 'edit_role', entity: 'role', entity_id: role.id, unit_id: role.unit_id, detail: `sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ...(ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(role.id) as RoleRow), sessionsRevoked: revoked });
}));

orgRouter.delete('/roles/:roleId', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(String(req.params.roleId)) as RoleRow | undefined;
  if (!role) throw notFound('No such role.');
  if (!canManageRoleDefinition(ctx, req.user, scope, role)) throw forbidden('That role is outside your authority.');
  if (role.is_default || role.key === 'unit-leader') throw badRequest('The default and Unit Leader roles cannot be deleted.');
  let revoked = 0;
  ctx.db.transaction(() => {
    for (const h of ctx.db.prepare('SELECT DISTINCT user_id FROM member_roles WHERE role_id = ?').all(role.id) as Array<{ user_id: string }>) revoked += invalidateUserSessions(ctx, h.user_id);
    ctx.db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
  })();
  audit(ctx, { actor_id: req.user.id, action: 'delete_role', entity: 'role', entity_id: role.id, unit_id: role.unit_id, detail: `${role.name}; sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

orgRouter.post('/team/:userId/roles', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const { role_id, unit_id } = parse(z.object({ role_id: z.string().max(120), unit_id: z.string().max(64) }), req.body);
  const userId = String(req.params.userId);
  const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id) as RoleRow | undefined;
  validateRoleGrant(ctx, req.user, scope, role, unit_id, userId);
  ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, role_id, unit_id, req.user.id, now());
  const revoked = invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: req.user.id, action: 'grant_role', entity: 'role', entity_id: role_id, subject_id: userId, unit_id, detail: `${role!.name}; sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

orgRouter.delete('/team/:userId/roles/:roleId', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const userId = String(req.params.userId);
  const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ?').get(String(req.params.roleId)) as RoleRow | undefined;
  if (!role) throw notFound('No such role.');
  if (role.is_default || role.key === 'unit-leader') throw badRequest('That role is tied to membership or ownership.');
  if (!isUnitOwner(ctx, req.user.id, role.unit_id)) {
    if (!can(scope, PERMISSIONS.MANAGE_ROLES, role.unit_id)) throw forbidden('You cannot manage roles there.');
    if (role.position >= positionIn(scope, role.unit_id)) throw forbidden('That role is at or above your own.', 'hierarchy');
  }
  const r = ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(userId, role.id);
  if (!r.changes) throw notFound('That Marine does not hold that role.');
  const revoked = invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: req.user.id, action: 'revoke_role', entity: 'role', entity_id: role.id, subject_id: userId, unit_id: role.unit_id, ip: clientIp(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));

// Team roster and member detail -----------------------------------------
orgRouter.get('/team', wrap((req, res) => {
  const ctx = req.ctx;
  const scope = scopeFor(ctx, req.user, req);
  const ids = visibleUserIds(ctx, scope, req.user.id);
  const allowed = new Set(scope.readableUnitIds);
  const people = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, u.middle_initial, u.mos, u.rank_id, r.abbr AS rank_abbr, r.grade AS rank_grade, r.sort AS rank_sort FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.active = 1 AND u.id IN (${ids.map(() => '?').join(',')}) ORDER BY r.sort DESC, u.last_name`).all(...ids) as Array<Record<string, unknown> & { id: string }>;
  const memberships = ctx.db.prepare(`SELECT um.user_id, um.unit_id, um.is_primary, um.billet, u.name AS unit_name, u.short_name AS unit_short FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id IN (${ids.map(() => '?').join(',')}) AND u.active = 1`).all(...ids) as Array<{ user_id: string; unit_id: string; is_primary: number; billet: string | null; unit_name: string; unit_short: string | null }>;
  const roleRows = scope.readableUnitIds.length ? ctx.db.prepare(`SELECT mr.user_id, mr.unit_id, r.id, r.name, r.color, r.position, r.key FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id IN (${ids.map(() => '?').join(',')}) AND mr.unit_id IN (${scope.readableUnitIds.map(() => '?').join(',')}) ORDER BY r.position DESC`).all(...ids, ...scope.readableUnitIds) as Array<{ user_id: string; unit_id: string; id: string; name: string; color: string | null; position: number; key: string | null }> : [];
  const roster = people.map((p) => ({
    ...p,
    memberships: memberships.filter((m) => m.user_id === p.id && (m.user_id === req.user.id || allowed.has(m.unit_id))),
    roles: roleRows.filter((r) => r.user_id === p.id),
    canOpen: p.id === req.user.id || detailUnitsFor(ctx, scope, p.id).length > 0,
  }));
  if (roster.length > 1) audit(ctx, { actor_id: req.user.id, action: 'view_roster', detail: `${roster.length} personnel`, ip: clientIp(req) });
  res.json({ roster, readableUnitIds: scope.readableUnitIds, manageMembers: unitsWith(scope, PERMISSIONS.MANAGE_MEMBERS), manageRoles: unitsWith(scope, PERMISSIONS.MANAGE_ROLES), counsel: unitsWith(scope, PERMISSIONS.COUNSEL), exportUnits: unitsWith(scope, PERMISSIONS.EXPORT_DATA) });
}));

orgRouter.get('/team/:userId', wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.userId);
  const isSelf = id === req.user.id;
  const scope = scopeFor(ctx, req.user, req);
  const units = isSelf ? scope.unitIds : detailUnitsFor(ctx, scope, id);
  if (!isSelf && !units.length) throw forbidden('You can see this Marine on a roster but cannot open their record in any shared unit.');
  const person = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, u.middle_initial, u.mos, u.eas, u.rank_id, u.email, u.last_login_at, r.abbr AS rank_abbr, r.grade AS rank_grade, r.name AS rank_name FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ? AND u.active = 1`).get(id) as Record<string, unknown> | undefined;
  if (!person) throw notFound('No such Marine.');
  if (!isSelf) { delete person.email; audit(ctx, { actor_id: req.user.id, action: 'view_member', entity: 'user', entity_id: id, subject_id: id, unit_id: units[0], ip: clientIp(req) }); }
  const ph = units.map(() => '?').join(',');
  const unitClause = isSelf ? '' : `AND visibility = 'unit' AND unit_id IN (${ph})`;
  const scoped = (table: 'activities' | 'trainings' | 'awards') => (ctx.db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND deleted_at IS NULL ${unitClause} ORDER BY date DESC LIMIT 500`).all(id, ...(isSelf ? [] : units)) as Array<Record<string, unknown>>).map((r) => hydrate(r, table));
  const counselings = isSelf
    ? ctx.db.prepare('SELECT * FROM counselings WHERE user_id = ? AND deleted_at IS NULL ORDER BY date DESC').all(id)
    : ctx.db.prepare(`SELECT * FROM counselings WHERE user_id = ? AND deleted_at IS NULL AND (counselor_id = ? OR (visibility = 'unit' AND unit_id IN (${ph}))) ORDER BY date DESC`).all(id, req.user.id, ...units);
  const goals = isSelf
    ? ctx.db.prepare('SELECT * FROM goals WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL').all(id, id)
    : ctx.db.prepare(`SELECT * FROM goals WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL AND visibility = 'unit' AND unit_id IN (${ph})`).all(id, id, ...units);
  const tasks = isSelf
    ? ctx.db.prepare(`SELECT * FROM tasks WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL AND status <> 'completed'`).all(id, id)
    : ctx.db.prepare(`SELECT * FROM tasks WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL AND status <> 'completed' AND visibility = 'unit' AND unit_id IN (${ph})`).all(id, id, ...units);
  res.json({
    person,
    memberships: ctx.db.prepare(`SELECT um.unit_id, um.is_primary, um.billet, um.joined_at, u.name AS unit_name, u.short_name AS unit_short FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND u.active = 1 ${isSelf ? '' : `AND um.unit_id IN (${ph})`}`).all(id, ...(isSelf ? [] : units)),
    roles: ctx.db.prepare(`SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions, r.key FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? ${isSelf ? '' : `AND mr.unit_id IN (${ph})`} ORDER BY r.position DESC`).all(id, ...(isSelf ? [] : units)),
    detailUnits: units,
    canCounsel: units.filter((u) => can(scope, PERMISSIONS.COUNSEL, u)),
    canManageMembers: units.filter((u) => can(scope, PERMISSIONS.MANAGE_MEMBERS, u)),
    activities: scoped('activities'), trainings: scoped('trainings'), awards: scoped('awards'), counselings, goals, tasks,
  });
}));

orgRouter.put('/team/:userId/profile', wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.userId);
  const scope = scopeFor(ctx, req.user, req);
  const target = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id) as Record<string, unknown> | undefined;
  if (!target) throw notFound('No such Marine.');
  const units = detailUnitsFor(ctx, scope, id).filter((u) => can(scope, PERMISSIONS.MANAGE_MEMBERS, u));
  if (!req.user.is_operator && !units.length) throw forbidden('You cannot edit that Marine’s profile.');
  const body = parse(profileSchema.omit({ email: true }), req.body);
  if (body.rank_id && !ctx.db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) throw badRequest('No such rank.', { fieldErrors: { rank_id: 'No such rank.' } });
  const entries = Object.entries(body).filter(([, v]) => v !== undefined);
  if (!entries.length) return res.json({ ok: true, changed: [] });
  ctx.db.prepare(`UPDATE users SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...entries.map(([, v]) => v), now(), id);
  audit(ctx, { actor_id: req.user.id, action: 'edit_member_profile', entity: 'user', entity_id: id, subject_id: id, unit_id: units[0] || null, detail: entries.map(([k]) => k).join(', '), ip: clientIp(req) });
  if (entries.some(([k]) => k === 'rank_id')) notify(ctx, id, { kind: 'profile', title: 'Profile updated by your leadership', message: `${req.user.first_name} ${req.user.last_name} updated: ${entries.map(([k]) => k).join(', ')}.`, actionUrl: '/settings' });
  res.json({ ok: true, changed: entries.map(([k]) => k) });
}));

// Operator-only account lifecycle -------------------------------------
orgRouter.post('/team/:userId/deactivate', requireOperator, wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.userId);
  if (id === req.user.id) throw badRequest('You cannot deactivate your own account.');
  const target = ctx.db.prepare('SELECT id, active FROM users WHERE id = ?').get(id) as { id: string; active: number } | undefined;
  if (!target) throw notFound('No such Marine.');
  const owns = ctx.db.prepare('SELECT name FROM units WHERE owner_user_id = ? AND active = 1').all(id) as Array<{ name: string }>;
  if (owns.length) throw badRequest(`That Marine leads ${owns.map((u) => u.name).join(', ')}. Transfer ownership first.`);
  ctx.db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(now(), id);
  const revoked = invalidateUserSessions(ctx, id);
  audit(ctx, { actor_id: req.user.id, action: 'deactivate_member', entity: 'user', entity_id: id, subject_id: id, detail: `sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));
orgRouter.post('/team/:userId/reactivate', requireOperator, wrap((req, res) => {
  const id = String(req.params.userId);
  const r = req.ctx.db.prepare('UPDATE users SET active = 1, updated_at = ? WHERE id = ?').run(now(), id);
  if (!r.changes) throw notFound('No such Marine.');
  audit(req.ctx, { actor_id: req.user.id, action: 'reactivate_member', entity: 'user', entity_id: id, subject_id: id, ip: clientIp(req) });
  res.json({ ok: true });
}));
orgRouter.post('/team/:userId/reset-mfa', requireOperator, wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.userId);
  if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('No such Marine.');
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, updated_at = ? WHERE id = ?').run(now(), id);
    ctx.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id);
    ctx.db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(id);
  })();
  const revoked = invalidateUserSessions(ctx, id);
  audit(ctx, { actor_id: req.user.id, action: 'reset_mfa', entity: 'user', entity_id: id, subject_id: id, detail: `sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));
orgRouter.post('/team/:userId/temporary-password', requireOperator, wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.userId);
  if (id === req.user.id) throw badRequest('Use Change password for your own account.');
  if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw notFound('No such Marine.');
  const password = `${newId().slice(0, 8)}-${newId().slice(0, 8)}-${newId().slice(0, 4)}`;
  const { hashPassword } = await_import();
  ctx.db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(hashPassword(password), now(), id);
  const revoked = invalidateUserSessions(ctx, id);
  audit(ctx, { actor_id: req.user.id, action: 'temporary_password', entity: 'user', entity_id: id, subject_id: id, detail: `sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, password, sessionsRevoked: revoked });
}));
orgRouter.post('/team/:userId/logout', requireOperator, wrap((req, res) => {
  const id = String(req.params.userId);
  const revoked = invalidateUserSessions(req.ctx, id);
  audit(req.ctx, { actor_id: req.user.id, action: 'force_logout', entity: 'user', entity_id: id, subject_id: id, detail: `sessions revoked: ${revoked}`, ip: clientIp(req) });
  res.json({ ok: true, sessionsRevoked: revoked });
}));
orgRouter.post('/team/:userId/operator', requireOperator, wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.userId);
  const grant = Boolean(req.body?.grant);
  if (id === req.user.id && !grant) throw badRequest('You cannot remove your own operator authority.');
  const r = ctx.db.prepare('UPDATE users SET is_operator = ?, updated_at = ? WHERE id = ? AND active = 1').run(grant ? 1 : 0, now(), id);
  if (!r.changes) throw notFound('No such active Marine.');
  invalidateUserSessions(ctx, id);
  audit(ctx, { actor_id: req.user.id, action: grant ? 'grant_operator' : 'revoke_operator', entity: 'user', entity_id: id, subject_id: id, ip: clientIp(req) });
  res.json({ ok: true });
}));

import { hashPassword as _hashPassword } from '../lib/crypto.ts';
function await_import() { return { hashPassword: _hashPassword }; }
export { conflict };
