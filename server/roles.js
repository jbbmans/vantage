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
    hint: 'Download the unit\u2019s records as a CSV export.',
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
    hint: 'Rename this unit and manage its sub-units. Does not grant reach into them.',
    group: 'Administration',
  },
  {
    key: 'ADMINISTRATOR',
    label: 'Administrator',
    hint: 'Every permission inside this unit. Confers nothing in any other unit.',
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

const OWNER_BITS = PERMISSIONS.ADMINISTRATOR;

const SNCOIC_BITS = fromKeys([
  'VIEW_UNIT', 'VIEW_RECORDS', 'VIEW_MEMBER_DETAIL', 'CREATE_SHARED_WORK', 'CREATE_SHARED_GOALS',
  'MANAGE_RECORDS', 'MANAGE_MEMBERS', 'MANAGE_ROLES', 'MANAGE_UNITS', 'VIEW_AUDIT', 'EXPORT_DATA',
]);

const NCO_BITS = fromKeys([
  'VIEW_UNIT', 'VIEW_RECORDS', 'CREATE_SHARED_WORK', 'CREATE_SHARED_GOALS',
]);

const FIRE_TEAM_LEADER_BITS = NCO_BITS | fromKeys(['VIEW_MEMBER_DETAIL']);

const SNCO_BITS = FIRE_TEAM_LEADER_BITS | fromKeys([
  'MANAGE_RECORDS', 'VIEW_AUDIT',
]);

const MARINE_BITS = fromKeys(['VIEW_UNIT']);

export const ROLE_TEMPLATES = [
  {
    id: 'default',
    name: 'Vantage default',
    summary: 'Marine, NCO, Fire Team Leader, SNCO, SNCOIC and Unit Leader.',
    recommended: true,
    roles: [
      {
        key: 'marine', name: 'Marine', color: '#8D98A8', position: 0, is_default: 1,
        permissions: MARINE_BITS,
        description: 'Everyone gets this. Sees their own record and the unit roster; shared records require an explicit reader role.',
      },
      {
        key: 'nco', name: 'NCO', color: '#3DD68C', position: 20, is_default: 0,
        permissions: NCO_BITS,
        description: 'Sees shared work and can post unit tasks and goals. Cannot open a Marine’s full record.',
      },
      {
        key: 'fire-team-leader', name: 'Fire Team Leader', color: '#20A4A8', position: 30, is_default: 0,
        permissions: FIRE_TEAM_LEADER_BITS,
        description: 'Adds full member-record visibility to the NCO tasking capabilities. Every record open is audited.',
      },
      {
        key: 'snco', name: 'SNCO', color: '#F0A93B', position: 40, is_default: 0,
        permissions: SNCO_BITS,
        description: 'Can correct shared records and review the unit access log, but cannot administer people, roles or units.',
      },
      {
        key: 'sncoic', name: 'SNCOIC', color: '#4C9DFF', position: 60, is_default: 0,
        permissions: SNCOIC_BITS,
        description: 'Runs unit administration: members, roles, records, sub-units, audit and export.',
      },
      {
        key: 'unit-leader', name: 'Unit Leader', color: '#6D7CF6', position: 100, is_default: 0, owner: true,
        permissions: OWNER_BITS,
        description: 'Every permission inside this unit. The unit’s accountable owner receives this role.',
      },
    ],
  },
];

export const DEFAULT_TEMPLATE_ID = 'default';

export const templateById = (id) =>
  ROLE_TEMPLATES.find((t) => t.id === id) || ROLE_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID);

export const templateSummaries = () =>
  ROLE_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    summary: t.summary,
    recommended: Boolean(t.recommended),
    roles: t.roles.map((r) => ({
      name: r.name, position: r.position, color: r.color,
      permissions: listPermissions(r.permissions),
    })),
  }));
