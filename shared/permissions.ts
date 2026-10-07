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
  CLAIM_WORK: 1 << 13,
  EDIT_WORK: 1 << 14,
  RESOLVE_WORK: 1 << 15,
  REASSIGN_WORK: 1 << 16,
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
  { key: 'MANAGE_UNITS', label: 'Manage units', hint: 'Rename this unit and create or archive the units beneath it.', group: 'Administration' },
  { key: 'ADMINISTRATOR', label: 'Administrator', hint: 'Every permission in this unit and the units beneath it. Confers nothing in the units above it.', group: 'Administration', dangerous: true },
];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0);
export const has = (bits: number, flag: number) => Boolean(bits & PERMISSIONS.ADMINISTRATOR) || Boolean(bits & flag);
export const listPermissions = (bits: number): PermissionKey[] => PERMISSION_LIST.filter((p) => bits & PERMISSIONS[p.key]).map((p) => p.key);
export const fromKeys = (keys: PermissionKey[] = []) => keys.reduce((bits, key) => bits | (PERMISSIONS[key] || 0), 0);

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
  { key: 'unit-leader', name: 'Unit Leader', color: '#7c5cf0', position: 100, is_default: false, owner: true, permissions: OWNER_BITS, description: 'Every permission in this unit and the units beneath it. The unit owner receives this role.' },
];

/**
 * Three tiers of authority (ADR-0006). The unit permissions above flow down a chain of command. The two tiers below
 * them are separate: organization roles run a command's tenancy, platform roles run the service. Neither implies the
 * other, and neither confers a unit permission that reads records.
 */

export const ORG_PERMISSION_LIST = [
  { key: 'org.view', label: 'Open the owner console', hint: 'See the Unit Instance’s overview and settings.' },
  { key: 'org.settings', label: 'Unit Instance settings', hint: 'Rename the Unit Instance and set how people join and sign in.' },
  { key: 'org.owners', label: 'Owners and access policy', hint: 'Grant and remove Unit Instance roles, and choose whether Vantage support needs approval to look.' },
  { key: 'org.members', label: 'Members', hint: 'Enroll, move and remove members anywhere in the Unit Instance; unlock and sign them out.' },
  { key: 'org.units', label: 'Units', hint: 'Create, rename, move and archive units, and transfer a unit’s leadership.' },
  { key: 'org.roles', label: 'Unit roles', hint: 'Define unit roles and grant them, below the Unit Leader. Does not read records.' },
  { key: 'org.personnel', label: 'Personnel feed', hint: 'Load the roster extract that keeps names, ranks and EAS current, and separates people who left.' },
  { key: 'org.export', label: 'Export structure', hint: 'Download the Unit Instance’s structure: units, unit roles, members and who holds which role. Shared work is exported unit by unit, by those whose unit role allows it.' },
  { key: 'org.retention', label: 'Retention', hint: 'Set how long the Unit Instance’s records are kept, and run disposition.' },
  { key: 'org.holds', label: 'Legal holds', hint: 'Place and release holds that stop records being disposed of.' },
  { key: 'org.audit', label: 'Audit trail', hint: 'Read who did what in the Unit Instance, in its tamper-evident trail.' },
  { key: 'org.privacy', label: 'Privacy inventory', hint: 'See what personal information the Unit Instance holds, and why.' },
  { key: 'org.access', label: 'Approve Vantage access', hint: 'Approve, deny or end a Vantage support request to look at the Unit Instance’s data.' },
] as const;
export type OrgPermission = (typeof ORG_PERMISSION_LIST)[number]['key'];
export type OrgRole = 'owner' | 'admin' | 'records' | 'auditor';

const ALL_ORG = ORG_PERMISSION_LIST.map((p) => p.key) as OrgPermission[];
export const ORG_ROLES: Record<OrgRole, { label: string; description: string; permissions: OrgPermission[] }> = {
  owner: { label: 'Owner', description: 'Everything at Unit Instance level, including its owners and whether Vantage support needs approval.', permissions: ALL_ORG },
  admin: { label: 'Administrator', description: 'Members, units, unit roles, the personnel feed and the structure export. Does not read Marines’ records.', permissions: ['org.view', 'org.settings', 'org.members', 'org.units', 'org.roles', 'org.personnel', 'org.export', 'org.audit'] },
  records: { label: 'Records officer', description: 'Retention schedules, legal holds, the privacy inventory and the audit trail.', permissions: ['org.view', 'org.retention', 'org.holds', 'org.audit', 'org.privacy'] },
  auditor: { label: 'Auditor', description: 'Reads the audit trail and the privacy inventory. Changes nothing.', permissions: ['org.view', 'org.audit', 'org.privacy'] },
};
export const ORG_ROLE_KEYS = Object.keys(ORG_ROLES) as OrgRole[];

/**
 * What organization owners and administrators hold in every unit of their organization: its structure. Never the
 * permissions that read records, member detail or the access log.
 */
export const ORG_STRUCTURE_BITS = PERMISSIONS.VIEW_UNIT | PERMISSIONS.MANAGE_MEMBERS | PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_UNITS;
/** What Vantage access grants in each unit of the organization: reading what is shared with it. Never member detail, never changes. */
/** Unit permissions that read what Marines keep. Granting one to yourself through organization authority is watched. */
export const RECORD_READING_BITS = PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL | PERMISSIONS.EXPORT_DATA | PERMISSIONS.ADMINISTRATOR;
export const VANTAGE_ACCESS_BITS = PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_AUDIT;

export const PLATFORM_PERMISSION_LIST = [
  { key: 'platform.view', label: 'Open the admin dashboard', hint: 'See the service’s health and the Unit Instances on it.' },
  { key: 'platform.orgs', label: 'Unit Instances', hint: 'Create, rename, suspend and restore Unit Instances, and name their first owner. Not their data.' },
  { key: 'platform.settings', label: 'Platform settings', hint: 'The service’s name, sign-in announcement, registration policy and maintenance.' },
  { key: 'platform.accounts', label: 'Account support', hint: 'Find an account and help it sign in: unlock, sign out, temporary password, reset a second factor.' },
  { key: 'platform.staff', label: 'Vantage staff', hint: 'Grant and remove platform roles.' },
  { key: 'platform.access', label: 'Request Vantage access', hint: 'Ask a Unit Instance for time-limited, read-only access to its data, with a reason.' },
  { key: 'platform.support', label: 'Support queue', hint: 'Read and answer help requests that belong to no Unit Instance, such as sign-in trouble.' },
  { key: 'platform.audit', label: 'Platform audit trail', hint: 'Read the platform’s own actions and verify the integrity of every trail.' },
  { key: 'platform.email', label: 'Email', hint: 'How the service sends mail, and what it has sent.' },
  { key: 'platform.ai', label: 'AI', hint: 'GenAI.mil models, budgets and whether AI is offered.' },
  { key: 'platform.data', label: 'Backups and recovery', hint: 'Back up the whole service, and restore it.' },
  { key: 'platform.usage', label: 'Usage', hint: 'How the service is used and where it fails, without anyone’s content.' },
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSION_LIST)[number]['key'];
export type PlatformRole = 'owner' | 'admin' | 'support' | 'auditor';

const ALL_PLATFORM = PLATFORM_PERMISSION_LIST.map((p) => p.key) as PlatformPermission[];
export const PLATFORM_ROLES: Record<PlatformRole, { label: string; description: string; permissions: PlatformPermission[] }> = {
  owner: { label: 'Owner', description: 'Everything at platform level, including Vantage staff.', permissions: ALL_PLATFORM },
  admin: { label: 'Administrator', description: 'Unit Instances, platform settings, account support, email, AI and integrity.', permissions: ALL_PLATFORM.filter((p) => p !== 'platform.staff' && p !== 'platform.data') },
  support: { label: 'Support', description: 'Account sign-in help and the support queue; may request access to a Unit Instance.', permissions: ['platform.view', 'platform.accounts', 'platform.access', 'platform.support'] },
  auditor: { label: 'Auditor', description: 'Reads the platform audit trail and verifies integrity. Changes nothing.', permissions: ['platform.view', 'platform.audit', 'platform.usage'] },
};
export const PLATFORM_ROLE_KEYS = Object.keys(PLATFORM_ROLES) as PlatformRole[];

export const orgPermissionsOf = (roles: readonly string[]): OrgPermission[] =>
  [...new Set(roles.flatMap((r) => ORG_ROLES[r as OrgRole]?.permissions ?? []))];
export const platformPermissionsOf = (roles: readonly string[]): PlatformPermission[] =>
  [...new Set(roles.flatMap((r) => PLATFORM_ROLES[r as PlatformRole]?.permissions ?? []))];
