export const PERMISSIONS = {
  VIEW_UNIT: 1 << 0,
  VIEW_RECORDS: 1 << 1,
  VIEW_MEMBER_DETAIL: 1 << 2,
  MANAGE_RECORDS: 1 << 3,
  CREATE_SHARED_WORK: 1 << 4,
  CREATE_SHARED_GOALS: 1 << 5,
  MANAGE_MEMBERS: 1 << 6,
  MANAGE_ROLES: 1 << 7,
  MANAGE_UNITS: 1 << 8,
  VIEW_AUDIT: 1 << 9,
  EXPORT_DATA: 1 << 10,
  COUNSEL: 1 << 11,
  ADMINISTRATOR: 1 << 12,
  // Work verbs, split apart. Claiming a case used to be the only gate, and holding a claim meant
  // you could rewrite every field on it. These are four different decisions and a unit should be
  // able to answer them differently.
  CLAIM_WORK: 1 << 13,
  EDIT_WORK: 1 << 14,
  RESOLVE_WORK: 1 << 15,
  REASSIGN_WORK: 1 << 16,
  // The support queue. Separate from ADMINISTRATOR because the person who answers "I cannot log
  // in" is usually not the person who runs the unit.
  VIEW_SUPPORT: 1 << 17,
} as const;
export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_LIST: Array<{ key: PermissionKey; label: string; hint: string; group: string; dangerous?: boolean }> = [
  { key: 'VIEW_UNIT', label: 'View unit', hint: 'See the unit and its roster.', group: 'Visibility' },
  { key: 'VIEW_RECORDS', label: 'View shared records', hint: 'See work members have shared with the unit. Never shows private entries.', group: 'Visibility' },
  { key: 'VIEW_MEMBER_DETAIL', label: 'Open member records', hint: 'Open a Marine’s full page, readiness, and evaluation input. Every open is logged.', group: 'Visibility' },
  { key: 'VIEW_AUDIT', label: 'View access log', hint: 'See who has been reading records in this unit.', group: 'Visibility' },
  { key: 'CREATE_SHARED_WORK', label: 'Post tasks and projects', hint: 'Assign tasking and projects to members of the unit.', group: 'Work' },
  { key: 'CREATE_SHARED_GOALS', label: 'Post goals', hint: 'Set targets the whole unit can see and track against.', group: 'Work' },
  { key: 'MANAGE_RECORDS', label: 'Edit others’ records', hint: 'Correct a Marine’s shared entry. Cannot touch private entries.', group: 'Work' },
  { key: 'COUNSEL', label: 'Counsel members', hint: 'Record counselings and award recommendations for members of the unit.', group: 'Work' },
  { key: 'EXPORT_DATA', label: 'Export unit data', hint: 'Download unit records, dashboards, and command briefs.', group: 'Work' },
  { key: 'CLAIM_WORK', label: 'Claim work', hint: 'Take a case off the queue to signal you are working it. Does not let you change its figures.', group: 'Work' },
  { key: 'EDIT_WORK', label: 'Edit work detail', hint: 'Change a case’s own fields. Values that came off an imported sheet stay read-only for everyone.', group: 'Work' },
  { key: 'RESOLVE_WORK', label: 'Resolve work', hint: 'Close a case out, or reopen one that was closed too early.', group: 'Work' },
  { key: 'REASSIGN_WORK', label: 'Reassign work', hint: 'Move a case to somebody else, or release a claim somebody is sitting on.', group: 'Work' },
  { key: 'VIEW_SUPPORT', label: 'Work the support queue', hint: 'Read and answer help requests, including sign-in trouble. Never shows the contents of anyone’s email.', group: 'Administration' },
  { key: 'MANAGE_MEMBERS', label: 'Manage members', hint: 'Invite Marines, enroll existing accounts, and move them between units.', group: 'Administration' },
  { key: 'MANAGE_ROLES', label: 'Manage roles', hint: 'Create roles and assign them. Only roles below your own.', group: 'Administration' },
  { key: 'MANAGE_UNITS', label: 'Manage units', hint: 'Rename this unit and manage its sub-units. Does not grant reach into them.', group: 'Administration' },
  { key: 'ADMINISTRATOR', label: 'Administrator', hint: 'Every permission inside this unit. Confers nothing in any other unit.', group: 'Administration', dangerous: true },
];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0);
export const has = (bits: number, flag: number) => Boolean(bits & PERMISSIONS.ADMINISTRATOR) || Boolean(bits & flag);
export const listPermissions = (bits: number): PermissionKey[] => PERMISSION_LIST.filter((p) => bits & PERMISSIONS[p.key]).map((p) => p.key);
export const fromKeys = (keys: PermissionKey[] = []) => keys.reduce((bits, key) => bits | (PERMISSIONS[key] || 0), 0);

// Claiming and resolving together, because that is what claiming already means today. The point of
// splitting the verbs is that a unit can now take RESOLVE_WORK away from a role that should only
// work cases, not that every instance silently becomes stricter the day it upgrades.
const MARINE_BITS = fromKeys(['VIEW_UNIT', 'CLAIM_WORK', 'RESOLVE_WORK']);
const NCO_BITS = fromKeys(['VIEW_UNIT', 'VIEW_RECORDS', 'CREATE_SHARED_WORK', 'CREATE_SHARED_GOALS', 'CLAIM_WORK', 'RESOLVE_WORK']);
const FIRE_TEAM_LEADER_BITS = NCO_BITS | fromKeys(['VIEW_MEMBER_DETAIL', 'COUNSEL', 'EDIT_WORK']);
const SNCO_BITS = FIRE_TEAM_LEADER_BITS | fromKeys(['MANAGE_RECORDS', 'VIEW_AUDIT', 'EXPORT_DATA', 'REASSIGN_WORK']);
const SNCOIC_BITS = SNCO_BITS | fromKeys(['MANAGE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_UNITS', 'VIEW_SUPPORT']);
const OWNER_BITS = PERMISSIONS.ADMINISTRATOR;

export interface RoleTemplate { key: string; name: string; color: string; position: number; is_default: boolean; owner?: boolean; permissions: number; description: string }
export const ROLE_TEMPLATE: RoleTemplate[] = [
  { key: 'marine', name: 'Marine', color: '#6b7a8f', position: 0, is_default: true, permissions: MARINE_BITS, description: 'Everyone gets this. Sees their own record and the unit roster.' },
  { key: 'nco', name: 'NCO', color: '#1f9d6a', position: 20, is_default: false, permissions: NCO_BITS, description: 'Sees shared work and can post unit tasks and goals.' },
  { key: 'fire-team-leader', name: 'Fire Team Leader', color: '#149ca6', position: 30, is_default: false, permissions: FIRE_TEAM_LEADER_BITS, description: 'Adds member-record visibility and counseling to NCO tasking.' },
  { key: 'snco', name: 'SNCO', color: '#d98b1f', position: 40, is_default: false, permissions: SNCO_BITS, description: 'Can correct shared records, export, and review the unit access log.' },
  { key: 'sncoic', name: 'SNCOIC', color: '#3b82f6', position: 60, is_default: false, permissions: SNCOIC_BITS, description: 'Runs unit administration: members, roles, sub-units, audit, and export.' },
  { key: 'unit-leader', name: 'Unit Leader', color: '#7c5cf0', position: 100, is_default: false, owner: true, permissions: OWNER_BITS, description: 'Every permission inside this unit. The unit owner receives this role.' },
];
