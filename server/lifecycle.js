import { audit, grantRole, newId, now, addMember, freezeMemberUnitRecords } from './db.js';
import { PERMISSIONS } from './roles.js';
import { can, permissionMap, positionIn, isUnitOwner, memberUnitIds } from './permissions.js';
import { validateRoleGrant } from './roleGuard.js';
import { invalidateUserSessions, listSessions, hashPassword } from './auth.js';
import { isInstanceOperator, isBootstrapOperator } from './instance.js';

const ok = (extra = {}) => ({ ok: true, ...extra });
const deny = (status, message, code = 'forbidden') => ({ ok: false, status, message, code });

export function primaryAssignment(db, userId) {
  return db.prepare('SELECT * FROM assignments WHERE user_id = ? AND is_primary = 1').get(userId) || null;
}

export function canAdministerAccount(db, actor, target) {
  if (!target) return deny(404, 'No such Marine.', 'not_found');
  if (isInstanceOperator(actor) || isBootstrapOperator(db, actor)) return ok();
  return deny(
    403,
    'Account-wide recovery is restricted to the Instance Operator. Manage this Marine’s unit membership instead.',
    'not_operator'
  );
}

export function otherActiveAdmins(db, exceptUserId) {
  return db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) AS n FROM users u
        WHERE u.active = 1 AND u.id <> ?
          AND (u.is_admin = 1 OR EXISTS (
            SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
             WHERE mr.user_id = u.id AND (r.permissions & ?) <> 0))`
    )
    .get(exceptUserId, PERMISSIONS.ADMINISTRATOR).n;
}

const ownedUnits = (db, user) =>
  db.prepare('SELECT id, name FROM units WHERE owner_user_id = ? AND active = 1').all(user.id);

const holdsAdmin = (db, user) =>
  Boolean(user.is_admin) ||
  ownedUnits(db, user).length > 0 ||
  Boolean(
    db
      .prepare(
        `SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id
          WHERE mr.user_id = ? AND (r.permissions & ?) <> 0 LIMIT 1`
      )
      .get(user.id, PERMISSIONS.ADMINISTRATOR)
  );

export function transferMember(db, actor, targetId, { unit_id, billet_id, role, retain_role_ids, retainRoleIds }, { currentToken = null } = {}) {
  const retainList = retain_role_ids ?? retainRoleIds ?? [];
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return deny(404, 'No such Marine.', 'not_found');
  if (!target.active) return deny(400, 'That account is deactivated. Reactivate it before reassigning.', 'inactive');

  const destination = db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(unit_id);
  if (!destination) return deny(400, 'No such unit.', 'invalid');
  if (billet_id && !db.prepare('SELECT 1 FROM billets WHERE id = ?').get(billet_id)) {
    return deny(400, 'No such billet.', 'invalid');
  }

  const oldUnitPeek = primaryAssignment(db, targetId)?.unit_id || null;

  const admin = Boolean(oldUnitPeek && isUnitOwner(db, actor.id, oldUnitPeek));
  const existing = primaryAssignment(db, targetId);
  const oldUnit = existing?.unit_id || null;
  const moved = oldUnit !== unit_id;
  const nextBilletId = billet_id || null;
  const billetChanged = (existing?.billet_id || null) !== nextBilletId;

  if (!can(db, actor, PERMISSIONS.MANAGE_MEMBERS, unit_id)) {
    return deny(403, 'You cannot move Marines into that unit.');
  }
  if (!admin) {

    if (moved && oldUnit && !can(db, actor, PERMISSIONS.MANAGE_MEMBERS, oldUnit)) {
      return deny(403, "You cannot move a Marine out of a unit you don't manage.");
    }

    if (targetId !== actor.id) {
      const compareUnit = oldUnit || unit_id;
      if (positionIn(db, target, compareUnit) >= positionIn(db, actor, compareUnit)) {
        return deny(403, 'You cannot reassign a Marine whose role is at or above your own.');
      }
    }
  }

  const defaultRoleId = db.prepare('SELECT id FROM roles WHERE is_default = 1 AND unit_id = ? LIMIT 1').get(unit_id)?.id || null;
  const revokedRoles = [];
  const retainedRoles = [];
  let recordsFrozen = 0;
  const retain = new Set((Array.isArray(retainList) ? retainList : []).map(String));

  const run = db.transaction(() => {
    if (existing) {
      if (moved || billetChanged) {
        db.prepare("UPDATE assignments SET unit_id = ?, billet_id = ?, role = '' WHERE id = ?").run(
          unit_id, nextBilletId, existing.id
        );
      }
    } else {
      db.prepare(
        `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
         VALUES (?, ?, ?, ?, '', 1, ?, ?)`
      ).run(newId(), targetId, unit_id, billet_id || null, now().slice(0, 10), now());
    }

    if (moved) {
      addMember(targetId, unit_id, { kind: 'member', invitedBy: actor.id });
    }

    if (moved && oldUnit) {
      const oldGrants = db
        .prepare(
          `SELECT mr.id AS grant_id, r.* FROM member_roles mr JOIN roles r ON r.id = mr.role_id
            WHERE mr.user_id = ? AND mr.unit_id = ?`
        )
        .all(targetId, oldUnit);
      for (const grant of oldGrants) {
        const keep =
          retain.has(grant.id) &&
          validateRoleGrant(db, actor, grant, oldUnit, target).ok;
        if (keep) {
          retainedRoles.push(grant.name);
          continue;
        }
        db.prepare('DELETE FROM member_roles WHERE id = ?').run(grant.grant_id);
        if (grant.id !== defaultRoleId) revokedRoles.push(grant.name);
      }

      if (defaultRoleId) grantRole(targetId, defaultRoleId, unit_id, actor.id);

      if (!retainedRoles.length) {
        recordsFrozen = freezeMemberUnitRecords(targetId, oldUnit);
        db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(targetId, oldUnit);
      }
    }
  });
  run();

  const sessionsRevoked = 0;

  if (moved || billetChanged) {
    audit({
      actor_id: actor.id, action: 'reassign', entity: 'user', entity_id: targetId,
      subject_id: targetId, unit_id,
      detail: `${oldUnit || 'unassigned'} → ${unit_id}`
        + (revokedRoles.length ? `; revoked: ${revokedRoles.join(', ')}` : '')
        + (retainedRoles.length ? `; retained: ${retainedRoles.join(', ')}` : ''),
    });
  }

  return ok({ moved, billetChanged, from: oldUnit, to: unit_id, revokedRoles, retainedRoles, recordsFrozen, sessionsRevoked });
}

export function deactivateMember(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerAccount(db, actor, target);
  if (!gate.ok) return gate;
  if (targetId === actor.id) return deny(400, 'You cannot deactivate your own account.', 'invalid');
  if (!target.active) return ok({ already: true, sessionsRevoked: 0 });

  const owns = ownedUnits(db, target);
  if (owns.length) {
    return deny(
      400,
      `That Marine owns ${owns.length === 1 ? owns[0].name : `${owns.length} units`}. `
      + 'Transfer ownership before deactivating the account.',
      'last_owner'
    );
  }
  if (holdsAdmin(db, target) && otherActiveAdmins(db, targetId) === 0) {
    return deny(400, 'That is the last active administrator. Create another administrator first.', 'last_admin');
  }

  let sessionsRevoked = 0;
  db.transaction(() => {
    db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(now(), targetId);
    sessionsRevoked = invalidateUserSessions(db, targetId);
  })();
  const unitId = primaryAssignment(db, targetId)?.unit_id || null;
  audit({
    actor_id: actor.id, action: 'deactivate_member', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: unitId, detail: `sessions revoked: ${sessionsRevoked}`,
  });
  return ok({ sessionsRevoked });
}

export function reactivateMember(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return deny(404, 'No such Marine.', 'not_found');
  const gate = canAdministerAccount(db, actor, target);
  if (!gate.ok) return gate;
  if (target.active) return ok({ already: true });
  db.prepare('UPDATE users SET active = 1, updated_at = ? WHERE id = ?').run(now(), targetId);
  const unitId = primaryAssignment(db, targetId)?.unit_id || null;
  audit({
    actor_id: actor.id, action: 'reactivate_member', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: unitId,
  });
  return ok();
}

export function resetMemberPassword(db, actor, targetId, newPassword) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerAccount(db, actor, target);
  if (!gate.ok) return gate;
  if (targetId === actor.id) {
    return deny(400, 'Use Change password for your own account.', 'invalid');
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(
    hashPassword(newPassword), now(), targetId
  );
  const sessionsRevoked = invalidateUserSessions(db, targetId);
  const unitId = primaryAssignment(db, targetId)?.unit_id || null;
  audit({
    actor_id: actor.id, action: 'reset_password', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: unitId, detail: `sessions revoked: ${sessionsRevoked}`,
  });
  return ok({ sessionsRevoked });
}

export function forceLogout(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerAccount(db, actor, target);
  if (!gate.ok) return gate;
  const sessionsRevoked = invalidateUserSessions(db, targetId);
  audit({
    actor_id: actor.id, action: 'revoke_sessions', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: primaryAssignment(db, targetId)?.unit_id || null,
    detail: `sessions revoked: ${sessionsRevoked}`,
  });
  return ok({ sessionsRevoked });
}

export function accessReview(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerAccount(db, actor, target);
  if (!gate.ok) return gate;

  const assignments = db
    .prepare(
      `SELECT a.*, u.name AS unit_name, u.short_name AS unit_short, b.title AS billet_title
         FROM assignments a JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ? AND (a.end_date IS NULL OR a.end_date > date('now'))`
    )
    .all(targetId);

  const memberUnits = new Set(memberUnitIds(db, targetId));

  const roles = db
    .prepare(
      `SELECT mr.id AS grant_id, mr.unit_id, mr.created_at AS granted_at, mr.granted_by,
              r.id, r.name, r.color, r.position, r.permissions
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id = ? ORDER BY r.position DESC`
    )
    .all(targetId)
    .map((r) => ({ ...r, orphaned: !memberUnits.has(r.unit_id) }));

  const { map, topPosition } = permissionMap(db, target);
  const sessions = listSessions(db, targetId);
  const lastLogin = db
    .prepare("SELECT at FROM audit_log WHERE actor_id = ? AND action = 'login' ORDER BY at DESC LIMIT 1")
    .get(targetId)?.at || null;

  const findings = [];
  for (const r of roles.filter((x) => x.orphaned)) {
    findings.push(`Role "${r.name}" is granted in ${r.unit_id}, where this Marine is not a member. It confers nothing.`);
  }
  if (!target.active && roles.length) {
    findings.push('Account is deactivated but still holds role grants. Revoke them if the departure is permanent.');
  }
  if (holdsAdmin(db, target)) findings.push('This account has administrator access.');
  const isOperator = isInstanceOperator(target) || isBootstrapOperator(db, target);
  if (isOperator) findings.push('This account is an Instance Operator configured outside the database.');

  audit({
    actor_id: actor.id, action: 'access_review', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: primaryAssignment(db, targetId)?.unit_id || null,
  });

  return ok({
    user: {
      id: target.id, username: target.username, first_name: target.first_name,
      last_name: target.last_name, active: Boolean(target.active),
      is_admin: Boolean(target.is_admin), is_operator: isOperator,
    },
    assignments,
    roles,
    permissionsByUnit: Object.fromEntries(map),
    topPosition,
    sessions,
    lastLogin,
    findings,
  });
}
