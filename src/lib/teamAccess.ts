import { PERMISSIONS } from '../../shared/permissions';
import { unitsWith, type Identity, type UnitView } from './queries';

export type TeamSection = 'overview' | 'workload' | 'roster' | 'dashboard' | 'invites' | 'roles' | 'units' | 'audit';

/**
 * The parts of Team a person may open, for the view they are looking at: a full view shows its people and
 * figures, and each management page needs the permission behind it. The sidebar and the page both ask here.
 */
export function teamSections(identity: Identity | undefined, view: UnitView | null): Set<TeamSection> {
  const out = new Set<TeamSection>();
  if (!identity?.views?.length) return out;
  out.add('overview');
  if (view?.level === 'full') { out.add('workload'); out.add('roster'); out.add('dashboard'); }
  const operator = Boolean(identity.user.is_operator);
  // Accounts and membership are closed in the synthetic demo, so it offers none of the actions that change them.
  if (!identity.demo && unitsWith(identity, PERMISSIONS.MANAGE_MEMBERS).length) out.add('invites');
  const units = unitsWith(identity, PERMISSIONS.MANAGE_UNITS).length;
  if (unitsWith(identity, PERMISSIONS.MANAGE_ROLES).length || units || operator) out.add('roles');
  if (units || operator) out.add('units');
  if (unitsWith(identity, PERMISSIONS.VIEW_AUDIT).length) out.add('audit');
  return out;
}
