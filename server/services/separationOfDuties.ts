import type { AppContext } from '../context.ts';
import { ORG_ROLES, PLATFORM_ROLES, RECORD_READING_BITS, UNIT_MANAGER_ROLES, type OrgRole, type PlatformRole } from '../../shared/permissions.ts';
import { now } from '../lib/ids.ts';
import { seatedLeader } from '../authz/scope.ts';

/**
 * The separation-of-duties report (ADR-0013): every account whose authority crosses a line the role model draws, for
 * Vantage staff who hold platform.audit to review. It changes nothing and names no record: who holds what, and where.
 * Nothing it lists is refused today (some of it predates the rule that would refuse it); each is a question for a person.
 */

export interface SodPerson { id: string; username: string; name: string; active: boolean }
export interface SodInstance { orgId: string; orgName: string; roles: string[] }

export interface SeparationOfDuties {
  checkedAt: string;
  /** A Vantage staff role and a Unit Instance role: the platform's authority and a command's in one account. */
  platformAndInstance: Array<{ person: SodPerson; platformRoles: string[]; instances: SodInstance[] }>;
  /** In one Unit Instance, a Unit Instance role and a unit role that reads records, or the leadership of a unit. */
  instanceAndRecords: Array<{ person: SodPerson; orgId: string; orgName: string; instanceRoles: string[]; reading: Array<{ unitId: string; unitName: string; role: string }> }>;
  /** A Lead Unit Manager or Unit Manager role in more than one Unit Instance. */
  managersAcrossInstances: Array<{ person: SodPerson; instances: SodInstance[] }>;
  /** A unit whose recorded leader no longer belongs to it: the leadership confers nothing until somebody is named. */
  leadersNotMembers: Array<{ person: SodPerson; unitId: string; unitName: string; orgId: string | null; orgName: string | null }>;
  /** An account that has not signed in as its own, holding a role that reads records from the person who created or invited it. */
  unprovenReaders: Array<{ person: SodPerson; unitId: string | null; unitName: string | null; orgId: string | null; orgName: string | null; role: string; grantedBy: SodPerson }>;
}

const LIMIT = 500;
const orgRoleLabel = (role: string) => ORG_ROLES[role as OrgRole]?.label ?? role;
const platformRoleLabel = (role: string) => PLATFORM_ROLES[role as PlatformRole]?.label ?? role;

interface PersonRow { user_id: string; username: string; first_name: string; last_name: string; active: number }
const personOf = (r: PersonRow): SodPerson => ({ id: r.user_id, username: r.username, name: `${r.first_name} ${r.last_name}`, active: Boolean(r.active) });
const PERSON = 'p.id AS user_id, p.username, p.first_name, p.last_name, p.active';

/** The first membership of every account, and who opened it, when it was an account import, an invitation or a join code. */
const OPENED_BY = `SELECT f.user_id, f.started_by FROM unit_membership_periods f
  WHERE f.id = (SELECT f2.id FROM unit_membership_periods f2 WHERE f2.user_id = f.user_id ORDER BY f2.started_at, f2.id LIMIT 1)
    AND f.start_reason IN ('account_import', 'invitation', 'join_code') AND f.started_by IS NOT NULL`;

function group<T, K>(rows: T[], keyOf: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) { const k = keyOf(r); out.set(k, [...(out.get(k) || []), r]); }
  return out;
}

export function separationOfDuties(ctx: AppContext): SeparationOfDuties {
  const { db } = ctx;
  const at = now();
  // Unit Instance roles that have not run out, in Unit Instances that still exist; the instance's own state is shown by name.
  const orgRoles = db.prepare(`SELECT ${PERSON}, r.org_id, o.name AS org_name, r.role FROM org_roles r JOIN users p ON p.id = r.user_id JOIN organizations o ON o.id = r.org_id
      WHERE (r.expires_at IS NULL OR r.expires_at > ?) ORDER BY p.last_name COLLATE NOCASE, p.first_name COLLATE NOCASE, o.name`)
    .all(at) as Array<PersonRow & { org_id: string; org_name: string; role: string }>;
  const byPerson = group(orgRoles, (r) => r.user_id);
  const instancesOf = (rows: typeof orgRoles): SodInstance[] =>
    [...group(rows, (r) => r.org_id).values()].map((rs) => ({ orgId: rs[0].org_id, orgName: rs[0].org_name, roles: rs.map((r) => orgRoleLabel(r.role)) }));

  const staff = group(db.prepare('SELECT user_id, role FROM platform_roles').all() as Array<{ user_id: string; role: string }>, (r) => r.user_id);
  const platformAndInstance = [...byPerson.values()]
    .filter((rows) => staff.has(rows[0].user_id))
    .slice(0, LIMIT)
    .map((rows) => ({ person: personOf(rows[0]), platformRoles: staff.get(rows[0].user_id)!.map((r) => platformRoleLabel(r.role)), instances: instancesOf(rows) }));

  // Reading in the same Unit Instance: a unit role that reads records, held while a member, or leading one of its units.
  const reading = db.prepare(`SELECT mr.user_id, u.org_id, u.id AS unit_id, u.name AS unit_name, r.name AS role FROM member_roles mr
        JOIN roles r ON r.id = mr.role_id JOIN units u ON u.id = mr.unit_id JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
       WHERE u.active = 1 AND (r.permissions & ?) <> 0 AND (mr.expires_at IS NULL OR mr.expires_at > ?)
      UNION ALL
      SELECT u.owner_user_id, u.org_id, u.id, u.name, 'Unit leader' FROM units u WHERE u.active = 1 AND u.owner_user_id IS NOT NULL AND ${seatedLeader('u')}`)
    .all(RECORD_READING_BITS, at) as Array<{ user_id: string; org_id: string | null; unit_id: string; unit_name: string; role: string }>;
  const readingAt = group(reading, (r) => `${r.user_id}|${r.org_id}`);
  const instanceAndRecords: SeparationOfDuties['instanceAndRecords'] = [];
  for (const rows of group(orgRoles, (r) => `${r.user_id}|${r.org_id}`).values()) {
    const reads = readingAt.get(`${rows[0].user_id}|${rows[0].org_id}`);
    if (!reads || instanceAndRecords.length >= LIMIT) continue;
    instanceAndRecords.push({
      person: personOf(rows[0]), orgId: rows[0].org_id, orgName: rows[0].org_name, instanceRoles: rows.map((r) => orgRoleLabel(r.role)),
      reading: reads.map((r) => ({ unitId: r.unit_id, unitName: r.unit_name, role: r.role })),
    });
  }

  const managersAcrossInstances = [...group(orgRoles.filter((r) => (UNIT_MANAGER_ROLES as readonly string[]).includes(r.role)), (r) => r.user_id).values()]
    .filter((rows) => new Set(rows.map((r) => r.org_id)).size > 1)
    .slice(0, LIMIT)
    .map((rows) => ({ person: personOf(rows[0]), instances: instancesOf(rows) }));

  const leadersNotMembers = (db.prepare(`SELECT ${PERSON}, u.id AS unit_id, u.name AS unit_name, u.org_id, o.name AS org_name FROM units u
        JOIN users p ON p.id = u.owner_user_id LEFT JOIN organizations o ON o.id = u.org_id
       WHERE u.active = 1 AND NOT ${seatedLeader('u')} ORDER BY o.name, u.name LIMIT ?`)
    .all(LIMIT) as Array<PersonRow & { unit_id: string; unit_name: string; org_id: string | null; org_name: string | null }>)
    .map((r) => ({ person: personOf(r), unitId: r.unit_id, unitName: r.unit_name, orgId: r.org_id, orgName: r.org_name }));

  // Granted by the person who opened the account, before it signed in with its own CAC or the organization's sign-in.
  const unproven = `p.edipi_verified_at IS NULL AND p.oidc_subject IS NULL`;
  const unprovenRows = db.prepare(`
      SELECT ${PERSON}, u.id AS unit_id, u.name AS unit_name, u.org_id, o.name AS org_name, r.name AS role, g.id AS g_id, g.username AS g_username, g.first_name AS g_first, g.last_name AS g_last, g.active AS g_active
        FROM member_roles mr JOIN roles r ON r.id = mr.role_id JOIN units u ON u.id = mr.unit_id LEFT JOIN organizations o ON o.id = u.org_id
        JOIN users p ON p.id = mr.user_id JOIN (${OPENED_BY}) ob ON ob.user_id = mr.user_id AND ob.started_by = mr.granted_by JOIN users g ON g.id = mr.granted_by
       WHERE ${unproven} AND u.active = 1 AND (r.permissions & ?) <> 0 AND (mr.expires_at IS NULL OR mr.expires_at > ?)
      UNION ALL
      SELECT ${PERSON}, NULL, NULL, x.org_id, o.name, x.role, g.id, g.username, g.first_name, g.last_name, g.active
        FROM org_roles x JOIN organizations o ON o.id = x.org_id JOIN users p ON p.id = x.user_id
        JOIN (${OPENED_BY}) ob ON ob.user_id = x.user_id AND ob.started_by = x.granted_by JOIN users g ON g.id = x.granted_by
       WHERE ${unproven} AND (x.expires_at IS NULL OR x.expires_at > ?)
      LIMIT ?`)
    .all(RECORD_READING_BITS, at, at, LIMIT) as Array<PersonRow & { unit_id: string | null; unit_name: string | null; org_id: string | null; org_name: string | null; role: string; g_id: string; g_username: string; g_first: string; g_last: string; g_active: number }>;
  const unprovenReaders = unprovenRows.map((r) => ({
    person: personOf(r), unitId: r.unit_id, unitName: r.unit_name, orgId: r.org_id, orgName: r.org_name,
    role: r.unit_id ? r.role : orgRoleLabel(r.role),
    grantedBy: personOf({ user_id: r.g_id, username: r.g_username, first_name: r.g_first, last_name: r.g_last, active: r.g_active }),
  }));

  return { checkedAt: at, platformAndInstance, instanceAndRecords, managersAcrossInstances, leadersNotMembers, unprovenReaders };
}
