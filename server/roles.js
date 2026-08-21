/**
 * Vantage — permission flags.
 *
 * A bitfield, the way Discord does it. The previous model had three hard-coded
 * roles, which meant every command that didn't organise itself as
 * member/team-lead/section-head had to pretend it did. A shop with a Training
 * NCO who should see everyone's PME but nobody's fiscal work had no way to say
 * that.
 *
 * Roles are rows. Permissions are bits. A Marine can hold several roles and
 * gets the union of them. That's the whole model.
 */

export const PERMISSIONS = {
  /** See that a unit exists and who is in it. */
  VIEW_UNIT: 1 << 0,
  /** See records members have shared. Never covers anything marked private. */
  VIEW_RECORDS: 1 << 1,
  /** Open a member's full record page. */
  VIEW_MEMBER_DETAIL: 1 << 2,
  /** Correct someone else's entry before it goes on a package. */
  MANAGE_RECORDS: 1 << 3,
  /** Post tasks and projects to the unit. */
  CREATE_SHARED_WORK: 1 << 4,
  /** Post goals to the unit. */
  CREATE_SHARED_GOALS: 1 << 5,
  /** Add Marines, move them between units, end assignments. */
  MANAGE_MEMBERS: 1 << 6,
  /** Create roles and hand them out. */
  MANAGE_ROLES: 1 << 7,
  /** Create and rename units beneath this one. */
  MANAGE_UNITS: 1 << 8,
  /** Read the access log for this unit. */
  VIEW_AUDIT: 1 << 9,
  /** Pull the unit's data out as a workbook. */
  EXPORT_DATA: 1 << 10,
  /** Everything, everywhere. Kept separate so it can be audited on its own. */
  ADMINISTRATOR: 1 << 11,
};

export const PERMISSION_LIST = [
  {
    key: 'VIEW_UNIT',
    label: 'View unit',
    hint: 'See the unit and its roster.',
    group: 'Visibility',
  },
  {
    key: 'VIEW_RECORDS',
    label: 'View shared records',
    hint: "See work members have shared. Never shows anything marked private.",
    group: 'Visibility',
  },
  {
    key: 'VIEW_MEMBER_DETAIL',
    label: 'Open member records',
    hint: 'Open a Marine\u2019s full page and pull their JEPES input. Every open is logged.',
    group: 'Visibility',
  },
  {
    key: 'VIEW_AUDIT',
    label: 'View access log',
    hint: 'See who has been reading records in this unit.',
    group: 'Visibility',
  },
  {
    key: 'CREATE_SHARED_WORK',
    label: 'Post tasks and projects',
    hint: 'Push tasking to everyone in the unit.',
    group: 'Work',
  },
  {
    key: 'CREATE_SHARED_GOALS',
    label: 'Post goals',
    hint: 'Set targets the whole unit can see and track against.',
    group: 'Work',
  },
  {
    key: 'MANAGE_RECORDS',
    label: 'Edit others\u2019 records',
    hint: 'Correct a Marine\u2019s entry. Cannot touch private entries.',
    group: 'Work',
  },
  {
    key: 'EXPORT_DATA',
    label: 'Export unit data',
    hint: 'Download the unit\u2019s records as a workbook.',
    group: 'Work',
  },
  {
    key: 'MANAGE_MEMBERS',
    label: 'Manage members',
    hint: 'Add Marines and move them between units.',
    group: 'Administration',
  },
  {
    key: 'MANAGE_ROLES',
    label: 'Manage roles',
    hint: 'Create roles and assign them. Only roles below your own.',
    group: 'Administration',
  },
  {
    key: 'MANAGE_UNITS',
    label: 'Manage units',
    hint: 'Create, rename and restructure units beneath this one.',
    group: 'Administration',
  },
  {
    key: 'ADMINISTRATOR',
    label: 'Administrator',
    hint: 'Every permission, in every unit. Grant this to almost nobody.',
    group: 'Administration',
    dangerous: true,
  },
];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0);

export const has = (bits, flag) =>
  Boolean(bits & PERMISSIONS.ADMINISTRATOR) || Boolean(bits & flag);

export const listPermissions = (bits) =>
  PERMISSION_LIST.filter((p) => bits & PERMISSIONS[p.key]).map((p) => p.key);

export const fromKeys = (keys = []) =>
  keys.reduce((bits, key) => bits | (PERMISSIONS[key] || 0), 0);

/**
 * Roles every install starts with.
 *
 * `position` is the hierarchy: you cannot create, edit, delete or hand out a
 * role at or above your own highest position. Without that rule, anyone who
 * can manage roles can make themselves an administrator, and the permission
 * system is decorative.
 *
 * `inherits_down` is the difference between a fire team leader and a section
 * head. The fire team leader's role applies to their unit alone; the section
 * head's applies to every unit beneath theirs too.
 */
export const SYSTEM_ROLES = [
  {
    id: 'marine',
    name: 'Marine',
    color: '#8D98A8',
    position: 0,
    is_default: 1,
    inherits_down: 0,
    permissions: fromKeys(['VIEW_UNIT']),
    description: 'Everyone gets this. Sees their own record and anything shared to their unit.',
  },
  {
    id: 'fire-team-leader',
    name: 'Fire Team Leader',
    color: '#3DD68C',
    position: 10,
    is_default: 0,
    inherits_down: 0,
    permissions: fromKeys([
      'VIEW_UNIT', 'VIEW_RECORDS', 'VIEW_MEMBER_DETAIL', 'CREATE_SHARED_WORK', 'CREATE_SHARED_GOALS',
    ]),
    description: 'Sees and tasks their own team. Does not reach into units beneath it.',
  },
  {
    id: 'ncoic',
    name: 'NCOIC',
    color: '#F0A93B',
    position: 20,
    is_default: 0,
    inherits_down: 1,
    permissions: fromKeys([
      'VIEW_UNIT', 'VIEW_RECORDS', 'VIEW_MEMBER_DETAIL', 'CREATE_SHARED_WORK', 'CREATE_SHARED_GOALS',
      'MANAGE_RECORDS', 'MANAGE_MEMBERS', 'VIEW_AUDIT',
    ]),
    description: 'Runs a section. Reaches every unit beneath it.',
  },
  {
    id: 'section-head',
    name: 'Section Head',
    color: '#4C9DFF',
    position: 30,
    is_default: 0,
    inherits_down: 1,
    permissions: fromKeys([
      'VIEW_UNIT', 'VIEW_RECORDS', 'VIEW_MEMBER_DETAIL', 'CREATE_SHARED_WORK', 'CREATE_SHARED_GOALS',
      'MANAGE_RECORDS', 'MANAGE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_UNITS', 'VIEW_AUDIT', 'EXPORT_DATA',
    ]),
    description: 'Full authority over a section and everything under it, including its structure.',
  },
  {
    id: 'training-nco',
    name: 'Training NCO',
    color: '#A78BFA',
    position: 15,
    is_default: 0,
    inherits_down: 1,
    permissions: fromKeys(['VIEW_UNIT', 'VIEW_RECORDS', 'CREATE_SHARED_WORK']),
    description: 'Sees shared work across the section without opening individual records. For tracking PME and quals.',
  },
  {
    id: 'administrator',
    name: 'Administrator',
    color: '#FB7185',
    position: 100,
    is_default: 0,
    inherits_down: 1,
    permissions: PERMISSIONS.ADMINISTRATOR,
    description: 'Everything, everywhere. Grant to almost nobody.',
  },
];
