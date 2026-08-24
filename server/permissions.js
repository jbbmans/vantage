/**
 * Vantage — authorization.
 *
 * v3.4 rewrites this file around one invariant:
 *
 *   NO PERMISSION DECISION READS units.parent_id.
 *
 * That is not a behaviour, it is the shape of the module. In v3.3 authority
 * flowed down the tree (`inherits_down` expanded a grant across a subtree) and
 * visibility flowed up it (`ancestorUnitIds` in the visibility clause), both
 * automatically, with no act by the owning unit. Under Decision 1 a unit is a
 * sovereign boundary, so both of those are gone — not narrowed, gone. The tree
 * walkers live in org.js now and are display code.
 *
 * The whole model, in four sentences:
 *
 *   A grant is (user, role, unit). It confers the role's bits in that unit and
 *   nowhere else. Membership in a unit is a row in `unit_members`, stated
 *   rather than inferred. Reaching into another unit requires a grant in that
 *   unit — there is no other door.
 *
 * ADMINISTRATOR is still a bit, and still means "everything", but "everything"
 * is now bounded by the unit the grant was made in. The cross-tenant fan-out
 * v3.3 had (`if (global) for (const u of units) add(u.id, global)`) is deleted;
 * finding 4 replaced it with two named concepts that are not permission bits at
 * all — the Unit Owner (units.owner_user_id) and the Instance Operator
 * (environment variable, see instance.js).
 *
 * Nothing here reads rank. A Sergeant running a fire team outranks a Corporal
 * in another section but has no business in that section's records.
 */

import { PERMISSIONS, has, ALL_PERMISSIONS } from './roles.js';

export { PERMISSIONS, has };

/* ── membership ───────────────────────────────────────────────────── */

/**
 * Stated membership (finding 8). v3.3 answered "is this person in this unit"
 * by joining `assignments` with a date-range predicate, which conflated
 * membership, billet and history in one row: a member holding no billet, a
 * guest from another unit, and an ended assignment that should still read as
 * history were all inexpressible.
 *
 * Guest memberships carry `expires_at` and fail closed the moment it passes —
 * no cleanup job stands between an expiry and the loss of access.
 */
const LIVE_MEMBERSHIP = `(um.expires_at IS NULL OR um.expires_at > datetime('now'))`;

export function membershipsOf(db, userId) {
  return db
    .prepare(
      `SELECT um.unit_id, um.kind, um.joined_at, um.expires_at,
              u.name AS unit_name, u.short_name AS unit_short, u.code AS unit_code, u.level, u.data_mode
         FROM unit_members um
         JOIN units u ON u.id = um.unit_id
        WHERE um.user_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP}
        ORDER BY um.joined_at`
    )
    .all(userId);
}

/** Unit ids this user is a live member of. Includes guest memberships. */
export function memberUnitIds(db, userId) {
  return membershipsOf(db, userId).map((m) => m.unit_id);
}

/** Membership kind — owner, member or guest — or null if not a live member. */
export function membershipKind(db, userId, unitId) {
  if (!unitId) return null;
  const row = db
    .prepare(
      `SELECT um.kind FROM unit_members um JOIN units u ON u.id = um.unit_id
        WHERE um.user_id = ? AND um.unit_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP} LIMIT 1`
    )
    .get(userId, unitId);
  return row ? row.kind : null;
}

export function isMember(db, userId, unitId) {
  if (!unitId) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM unit_members um JOIN units u ON u.id = um.unit_id
          WHERE um.user_id = ? AND um.unit_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP} LIMIT 1`
      )
      .get(userId, unitId)
  );
}

/** The Unit Owner is stored on the unit, not granted as a role (finding 4). */
export function isUnitOwner(db, userId, unitId) {
  if (!unitId) return false;
  const unit = db.prepare('SELECT owner_user_id FROM units WHERE id = ? AND active = 1').get(unitId);
  return Boolean(unit && unit.owner_user_id && unit.owner_user_id === userId);
}

/* ── effective permissions ────────────────────────────────────────── */

/**
 * Fold every role grant into a map of unit id → permission bits.
 *
 * One grant, one unit. A role granted in G8-FMRAC contributes to G8-FMRAC and
 * to nothing else, whatever the org chart says sits above or below it.
 *
 * Role position ordering is per-unit (finding 1): position 30 in Unit A has no
 * relationship to position 30 in Unit B, so a single global "your position"
 * number would be comparing two unrelated scales. `topPosition` is retained
 * only as the maximum across units for coarse display; every authorization use
 * goes through `positionIn`.
 */
export function permissionMap(db, user) {
  const grants = db
    .prepare(
      `SELECT mr.unit_id, r.permissions, r.position
         FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         JOIN units u ON u.id = mr.unit_id
         JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
        WHERE mr.user_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP}`
    )
    .all(user.id);

  const map = new Map();
  const positions = new Map();
  const add = (unitId, bits) => map.set(unitId, (map.get(unitId) || 0) | bits);

  for (const g of grants) {
    add(g.unit_id, g.permissions);
    positions.set(g.unit_id, Math.max(positions.get(g.unit_id) || 0, g.position));
  }

  // A Unit Owner holds everything inside their own unit and cannot be edited
  // out of it by a role change. This is the replacement for v3.3's global
  // administrator, and it stops at the unit boundary.
  for (const row of db.prepare('SELECT id FROM units WHERE owner_user_id = ? AND active = 1').all(user.id)) {
    add(row.id, ALL_PERMISSIONS);
    positions.set(row.id, Math.max(positions.get(row.id) || 0, 100));
  }

  const topPosition = positions.size ? Math.max(...positions.values()) : 0;
  return { map, positions, topPosition };
}

/** Permission bits this user holds inside a specific unit. Zero elsewhere. */
export function permissionsIn(db, user, unitId) {
  if (!unitId) return 0;
  const { map } = permissionMap(db, user);
  return map.get(unitId) || 0;
}

/** Highest role position this user holds inside a specific unit. */
export function positionIn(db, user, unitId) {
  if (!unitId) return 0;
  const { positions } = permissionMap(db, user);
  return positions.get(unitId) || 0;
}

export function can(db, user, flag, unitId) {
  return has(permissionsIn(db, user, unitId), flag);
}

/**
 * Units where this user holds a given permission.
 *
 * v3.3 also exported `canAnywhere`, which answered "do you hold this bit
 * anywhere in the database" and was used to gate whole routes. Finding 8
 * deletes it: under tenancy every permission question names a unit, and a
 * route that cannot name one is a route that has not decided whose data it is
 * touching. Where the UI genuinely needs "should I show this nav item at all",
 * it asks `unitsWith(...).length > 0` — the same information, but derived from
 * an explicit per-unit list rather than a boolean that hides which unit
 * answered yes.
 */
export function unitsWith(db, user, flag) {
  const { map } = permissionMap(db, user);
  const out = [];
  for (const [unitId, bits] of map) if (has(bits, flag)) out.push(unitId);
  return out;
}

/* ── scope ────────────────────────────────────────────────────────── */

/**
 * Everything a user's memberships and grants give them.
 *
 * `ancestorUnitIds` is deleted (finding 2). If something in the UI wants a
 * breadcrumb it calls org.ancestorChain directly and does not route it through
 * an object that authorization also reads.
 */
export function resolveScope(db, user) {
  const memberships = membershipsOf(db, user.id);
  const unitIds = memberships.map((m) => m.unit_id);

  const assignments = db
    .prepare(
      `SELECT a.*, u.code AS unit_code, u.name AS unit_name, u.short_name AS unit_short, u.echelon, u.level,
              b.title AS billet_title
         FROM assignments a
         JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ? AND u.active = 1 AND (a.end_date IS NULL OR a.end_date > date('now'))`
    )
    .all(user.id);

  const roles = db
    .prepare(
      `SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions,
              u.short_name AS unit_short, u.name AS unit_name
         FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         JOIN units u ON u.id = mr.unit_id
         JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
        WHERE mr.user_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP}
        ORDER BY r.position DESC`
    )
    .all(user.id);

  const { map, positions, topPosition } = permissionMap(db, user);

  // Units whose members this user may see. Bounded by grants, so it can only
  // ever be a subset of the units they are actually in.
  const scopeUnitIds = [];
  for (const [unitId, bits] of map) {
    if (has(bits, PERMISSIONS.VIEW_RECORDS)) scopeUnitIds.push(unitId);
  }

  const ownedUnitIds = db
    .prepare('SELECT id FROM units WHERE owner_user_id = ? AND active = 1')
    .all(user.id)
    .map((r) => r.id);

  return {
    memberships,
    assignments,
    roles,
    unitIds,
    scopeUnitIds,
    ownedUnitIds,
    topPosition,
    permissions: Object.fromEntries(map),
    positions: Object.fromEntries(positions),
    canLead: scopeUnitIds.length > 0,
  };
}

/** User ids this user may read personnel records for. Always includes themselves. */
export function visibleUserIds(db, user) {
  const { scopeUnitIds } = resolveScope(db, user);
  const ids = new Set([user.id]);
  if (scopeUnitIds.length) {
    const placeholders = scopeUnitIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT um.user_id
           FROM unit_members um
           JOIN users u ON u.id = um.user_id
          WHERE um.unit_id IN (${placeholders})
            AND u.active = 1
            AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))`
      )
      .all(...scopeUnitIds);
    for (const r of rows) ids.add(r.user_id);
  }
  return [...ids];
}

/* ── visibility ───────────────────────────────────────────────────── */

/**
 * The visibility tiers.
 *
 *   personal  Belongs to a person, not a unit. unit_id IS NULL. Readable by
 *             the owner and by nobody else, ever — including the Unit Owner
 *             and the Instance Operator. This is finding 6, and it is the
 *             scope a Marine keeps their own running log in before, between
 *             and outside any unit.
 *   private   Mine, inside a unit. Not readable by others.
 *   unit      Visible inside the owning unit. Invisible everywhere else.
 *
 * `chain` is deleted (finding 3). It meant "the unit and everyone under it",
 * which is automatic cross-unit sharing, and it was the DEFAULT on the three
 * most-used record types. Cross-unit visibility is now reached only by a share
 * package or a guest membership, both of which are explicit acts by someone
 * inside the owning unit.
 */
export const VISIBILITIES = ['personal', 'private', 'unit'];

export const VISIBILITY_LABELS = {
  personal: 'Only me — kept outside any unit',
  private: 'Only me',
  unit: 'Everyone in the unit',
};

export const DEFAULT_VISIBILITY = 'unit';

/**
 * SQL fragment restricting a table to what this user may read.
 *
 *   A  It's mine. Any visibility, including personal and private.
 *   B  It belongs to someone whose records I may view, AND it lives in one of
 *      the units that gave me that authority, AND they didn't mark it private.
 *   C  It was posted to a unit I am a member of.
 *
 * v3.3's branches C and D — the two `visibility = 'chain'` clauses resolving
 * through ancestorUnitIds and scopeUnitIds — are removed. That is the whole of
 * finding 3 in this file.
 *
 * A and B are kept separate deliberately: collapsing them leaked every private
 * record a subordinate had ever written. Personal scope is excluded from B and
 * C by predicate, not by convention, so no future branch can re-admit it.
 *
 * The unit predicate in B is load-bearing and was missing from the first draft
 * of this rewrite. Keying B on the AUTHOR alone means that once you may read
 * someone's records anywhere, you may read them EVERYWHERE — so a Marine with
 * VIEW_RECORDS in their own section could read their SNCOIC's records posted
 * in a different unit entirely, purely because the two shared one membership.
 * Authority to read a person is granted by a unit and is bounded by it; a
 * record's home unit decides who may see it, not its author's address book.
 */
export function visibilityClause(db, user, { table = 't' } = {}) {
  const { unitIds, scopeUnitIds } = resolveScope(db, user);
  const subordinates = visibleUserIds(db, user).filter((id) => id !== user.id);

  const parts = [`${table}.user_id = ?`];
  const params = [user.id];

  if (subordinates.length && scopeUnitIds.length) {
    parts.push(
      `(${table}.user_id IN (${subordinates.map(() => '?').join(',')})`
      + ` AND ${table}.unit_id IN (${scopeUnitIds.map(() => '?').join(',')})`
      + ` AND ${table}.visibility NOT IN ('private','personal'))`
    );
    params.push(...subordinates, ...scopeUnitIds);
  }
  if (unitIds.length) {
    parts.push(`(${table}.visibility = 'unit' AND ${table}.unit_id IN (${unitIds.map(() => '?').join(',')}))`);
    params.push(...unitIds);
  }

  return { clause: `(${parts.join(' OR ')})`, params };
}

/** Can this user act on this specific row? */
export function canEdit(db, user, row) {
  if (!row) return false;
  // A frozen row is the originating unit's record of what happened (finding 12).
  // Nobody edits it, including its author.
  if (row.frozen_at) return false;
  if (row.user_id === user.id) return true;
  // Personal and private records are the author's alone — no permission bit,
  // no ownership, and no operator status opens them.
  if (row.visibility === 'private' || row.visibility === 'personal') return false;
  return Boolean(row.unit_id && can(db, user, PERMISSIONS.MANAGE_RECORDS, row.unit_id));
}

/**
 * Where a record may be posted.
 *
 * Personal scope needs nothing and takes no unit. Your own unit is always fair
 * game: a Lance Corporal logging their work so the section can see it needs no
 * permission. Posting to a unit you are not a member of means broadcasting to
 * people who do not work with you, and that needs a grant IN THAT UNIT — there
 * is no longer a subtree that makes it implicit.
 */
export function canShareTo(db, user, visibility, unitId, flag = PERMISSIONS.CREATE_SHARED_WORK) {
  if (visibility === 'personal') return !unitId;
  if (visibility === 'private') return true;
  if (!unitId) return false;

  /* A guest is a member, and that is deliberate — finding 9 builds guests as
   * ordinary membership so every existing permission check already covers
   * them and no parallel authorization path can drift. But a guest is in the
   * unit by invitation with a NARROW role, and letting them broadcast to it as
   * freely as the people who actually work there would empty that word out.
   * So guests are bounded by the share flag; members and owners are not.
   *
   * This also keeps v3.3's rule intact for everyone it applied to: your own
   * unit is free, anywhere else needs the permission. Under v3.3 a grant could
   * exist without membership, so "another unit you hold a permission in" was
   * expressible; finding 8 made membership a precondition for a grant to mean
   * anything, and guest is the shape that case takes now. */
  const kind = membershipKind(db, user.id, unitId);
  if (kind === 'owner' || kind === 'member') return true;
  return can(db, user, flag, unitId);
}

/**
 * Role hierarchy, per unit.
 *
 * You cannot create, edit, delete or hand out a role at or above your own
 * highest position IN THE UNIT THAT ROLE BELONGS TO — otherwise anyone who can
 * manage roles can promote themselves and the whole model is decorative.
 * v3.3 compared against a single global `topPosition`, which under per-unit
 * role sets would let a position-90 role in a unit you own authorize edits to
 * a position-80 role in a unit you merely visit.
 */
export function canManageRole(db, user, role) {
  if (!role || !role.unit_id) return false;
  if (isUnitOwner(db, user.id, role.unit_id)) return true;
  if (!can(db, user, PERMISSIONS.MANAGE_ROLES, role.unit_id)) return false;
  return role.position < positionIn(db, user, role.unit_id);
}
