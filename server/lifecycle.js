/**
 * Vantage — personnel access lifecycle.
 *
 * The dangerous moments in a permission system are not the day-to-day reads;
 * they are the transitions. A Marine transfers and their old roles linger
 * (finding 2). A leader with authority over one unit pulls somebody out of a
 * unit they don't control (finding 8). An account should be shut off and
 * there's no button, so it just… stays on (finding 4). This module owns those
 * transitions so every route asks the same questions and every answer lands in
 * the audit log.
 *
 * The rule set:
 *
 *   - Moving a Marine needs authority over BOTH ends: MANAGE_MEMBERS in the
 *     unit they're leaving and in the unit they're joining.
 *   - A non-administrator can never move, deactivate, or reset the password of
 *     someone whose highest role position is at or above their own.
 *   - A transfer revokes every role granted in the old unit unless the actor
 *     explicitly retains it — and retaining a role is itself a grant, so it
 *     passes the same delegation check a grant would.
 *   - Deactivation cuts every session immediately and refuses to orphan the
 *     install by removing the last administrator.
 *   - Nothing here deletes a user. History stays attached to the account.
 */

import { audit, grantRole, newId, now, addMember } from './db.js';
import { PERMISSIONS } from './roles.js';
import { can, permissionMap, positionIn, isUnitOwner, memberUnitIds } from './permissions.js';
import { validateRoleGrant } from './roleGuard.js';
import { invalidateUserSessions, listSessions, hashPassword } from './auth.js';

const ok = (extra = {}) => ({ ok: true, ...extra });
const deny = (status, message, code = 'forbidden') => ({ ok: false, status, message, code });

export function primaryAssignment(db, userId) {
  return db.prepare('SELECT * FROM assignments WHERE user_id = ? AND is_primary = 1').get(userId) || null;
}

/**
 * May `actor` administer `target`'s account (deactivate, reset password, force
 * logout, review access)? Administrators always; otherwise MANAGE_MEMBERS in
 * the target's primary unit AND a strictly higher role position — a fire team
 * leader does not get to switch off a peer fire team leader.
 */
export function canAdministerMember(db, actor, target) {
  if (!target) return deny(404, 'No such Marine.', 'not_found');

  /* v3.4: authority over a person is authority IN A UNIT THEY ARE IN. v3.3
   * short-circuited on isTrueAdmin — "holds ADMINISTRATOR anywhere" — which is
   * the cross-tenant superuser finding 4 deletes: it let Unit A's
   * administrator switch off Unit B's Marine. Position is compared on that
   * unit's own scale, because role positions are per-unit now (finding 1) and
   * comparing a position-60 role in one unit against a position-60 role in
   * another is comparing two unrelated numbers. */
  const shared = memberUnitIds(db, target.id)
    .filter((unitId) => can(db, actor, PERMISSIONS.MANAGE_MEMBERS, unitId));
  if (!shared.length) return deny(403, 'That Marine is outside your personnel authority.');

  for (const unitId of shared) {
    if (isUnitOwner(db, actor.id, unitId)) return ok();
    if (positionIn(db, target, unitId) < positionIn(db, actor, unitId)) return ok();
  }
  return deny(403, 'You cannot administer a Marine whose role is at or above your own.');
}

/** Active administrators other than `exceptUserId` — the lock-out guard. */
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

/**
 * Units this user owns outright. Under v3.4 this — not an ADMINISTRATOR bit —
 * is what makes an account load-bearing, so it is what the lock-out guards
 * below are written against (finding 11).
 */
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

/**
 * Change a Marine's primary assignment (finding 2 + 8).
 *
 * Returns { ok, moved, revokedRoles, retainedRoles, sessionsRevoked } or a deny.
 * `retainRoleIds` keeps named role grants alive in the OLD unit — each one is
 * re-judged as if the actor were granting it fresh, so "retain" can never keep
 * alive something the actor couldn't have handed out.
 */
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
  // v3.4: "admin" is no longer a global standing. The only actor who skips the
  // source-authority and position checks is the Owner of the unit the Marine is
  // being moved out of — authority over that unit, named.
  const admin = Boolean(oldUnitPeek && isUnitOwner(db, actor.id, oldUnitPeek));
  const existing = primaryAssignment(db, targetId);
  const oldUnit = existing?.unit_id || null;
  const moved = oldUnit !== unit_id;

  /* Authority over the destination — everyone needs this. */
  if (!can(db, actor, PERMISSIONS.MANAGE_MEMBERS, unit_id)) {
    return deny(403, 'You cannot move Marines into that unit.');
  }
  if (!admin) {
    /* Authority over the source — you cannot pull someone out of a unit you
     * don't control just because you control where they'd land. */
    if (moved && oldUnit && !can(db, actor, PERMISSIONS.MANAGE_MEMBERS, oldUnit)) {
      return deny(403, "You cannot move a Marine out of a unit you don't manage.");
    }
    /* Never move an equal or higher — that's how a peer removes a rival. */
    if (targetId !== actor.id) {
      const compareUnit = oldUnit || unit_id;
      if (positionIn(db, target, compareUnit) >= positionIn(db, actor, compareUnit)) {
        return deny(403, 'You cannot reassign a Marine whose role is at or above your own.');
      }
    }
  }

  // The default role is the destination unit's own (finding 1): there is no
  // global default role any more, because there are no global roles.
  const defaultRoleId = db.prepare('SELECT id FROM roles WHERE is_default = 1 AND unit_id = ? LIMIT 1').get(unit_id)?.id || null;
  const revokedRoles = [];
  const retainedRoles = [];
  const retain = new Set((Array.isArray(retainList) ? retainList : []).map(String));

  const run = db.transaction(() => {
    if (existing) {
      // Finding 9, Option A: the assignment carries no role — permissions are grants.
      db.prepare("UPDATE assignments SET unit_id = ?, billet_id = ?, role = '' WHERE id = ?").run(
        unit_id, billet_id || null, existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
         VALUES (?, ?, ?, ?, '', 1, ?, ?)`
      ).run(newId(), targetId, unit_id, billet_id || null, now().slice(0, 10), now());
    }

    // Membership is stated (finding 8), so a transfer has to move the
    // membership row as well as the assignment. Writing it BEFORE the grants
    // below matters: permissionMap joins through unit_members, so the baseline
    // grant into the destination would confer nothing without it.
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
      // Baseline role follows the Marine to the new unit.
      if (defaultRoleId) grantRole(targetId, defaultRoleId, unit_id, actor.id);

      /* Leaving the old unit means leaving it. If nothing was retained the
       * membership row goes too, so the Marine stops appearing on the old
       * unit's roster and stops being a valid assignee there. A retained
       * grant is an explicit decision to keep them attached, so membership
       * survives alongside it. */
      if (!retainedRoles.length) {
        db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(targetId, oldUnit);
      }
    }
  });
  run();

  /* A transfer changes what this account can see. Anything it is currently
   * signed into is a session issued under the old scope, so it ends — except
   * the actor's own session when they reassign themselves, or the request
   * that just succeeded would sign itself out. */
  let sessionsRevoked = 0;
  if (moved) {
    sessionsRevoked = invalidateUserSessions(db, targetId, {
      exceptToken: targetId === actor.id ? currentToken : null,
    });
  }

  audit({
    actor_id: actor.id, action: 'reassign', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id,
    detail: `${oldUnit || 'unassigned'} → ${unit_id}`
      + (revokedRoles.length ? `; revoked: ${revokedRoles.join(', ')}` : '')
      + (retainedRoles.length ? `; retained: ${retainedRoles.join(', ')}` : ''),
  });

  return ok({ moved, from: oldUnit, to: unit_id, revokedRoles, retainedRoles, sessionsRevoked });
}

/** Deactivate an account (finding 4). Sessions die now; history stays. */
export function deactivateMember(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerMember(db, actor, target);
  if (!gate.ok) return gate;
  if (targetId === actor.id) return deny(400, 'You cannot deactivate your own account.', 'invalid');
  if (!target.active) return ok({ already: true, sessionsRevoked: 0 });
  /* Orphan protection (finding 11). Deactivating a Unit Owner leaves records
   * nobody can reach, and unlike a role grant an owner cannot be re-created by
   * anyone still inside the unit. Ownership must be handed over first. */
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
  // canAdministerMember reads the target's roles, which an inactive account
  // still has — same bar to switch it back on as to switch it off.
  const gate = canAdministerMember(db, actor, target);
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

/** Administrative password reset. Every session the account holds ends. */
export function resetMemberPassword(db, actor, targetId, newPassword) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerMember(db, actor, target);
  if (!gate.ok) return gate;
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
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

/** Cut every session an account holds, without touching anything else. */
export function forceLogout(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerMember(db, actor, target);
  if (!gate.ok) return gate;
  const sessionsRevoked = invalidateUserSessions(db, targetId);
  audit({
    actor_id: actor.id, action: 'revoke_sessions', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: primaryAssignment(db, targetId)?.unit_id || null,
    detail: `sessions revoked: ${sessionsRevoked}`,
  });
  return ok({ sessionsRevoked });
}

/**
 * Access review (finding 27, and finding 2's "show me what survives a
 * transfer"): everything one account can currently reach, with the smells
 * flagged — roles in units the Marine is no longer assigned anywhere near,
 * an inactive account still holding roles, administrator access.
 */
export function accessReview(db, actor, targetId) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  const gate = canAdministerMember(db, actor, target);
  if (!gate.ok) return gate;

  const assignments = db
    .prepare(
      `SELECT a.*, u.name AS unit_name, u.short_name AS unit_short, b.title AS billet_title
         FROM assignments a JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ? AND (a.end_date IS NULL OR a.end_date > date('now'))`
    )
    .all(targetId);
  // Orphan detection is membership-based now. A grant in a unit the Marine is
  // not a member of confers nothing (permissionMap joins through unit_members),
  // so surfacing it is the whole point.
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

  audit({
    actor_id: actor.id, action: 'access_review', entity: 'user', entity_id: targetId,
    subject_id: targetId, unit_id: primaryAssignment(db, targetId)?.unit_id || null,
  });

  return ok({
    user: {
      id: target.id, username: target.username, first_name: target.first_name,
      last_name: target.last_name, active: Boolean(target.active), is_admin: Boolean(target.is_admin),
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
