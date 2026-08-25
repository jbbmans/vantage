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
  /** Rename and restructure this unit. Creating a NEW unit needs an invite. */
  MANAGE_UNITS: 1 << 8,
  /** Read the access log for this unit. */
  VIEW_AUDIT: 1 << 9,
  /** Pull the unit's data out as a bounded CSV export. */
  EXPORT_DATA: 1 << 10,
  /**
   * Everything, inside the unit the grant was made in. v3.3 fanned this out
   * across every unit in the database (finding 4); v3.4 does not. Kept as a
   * separate bit so it can be audited on its own.
   */
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

/**
 * Role TEMPLATES (finding 1).
 *
 * v3.3 seeded six roles with `unit_id = NULL`, which the schema comment
 * described as "applies org-wide". So on a fresh install every role in the
 * database was a single global object shared by every unit, and two SNCOICs at
 * two commands could not have a "Training NCO" that meant different things —
 * editing one edited both. That was the single largest obstacle to tenancy.
 *
 * These are no longer rows. They are a template set. At unit creation the
 * chosen template is COPIED into the new unit as ordinary, editable, unit-local
 * rows, which diverge immediately and permanently. `is_system` survives on the
 * copies only as "this row came from a template" and confers no edit
 * protection: the owning unit may rename, re-colour, re-permission or delete
 * any of its own roles.
 *
 * `inherits_down` is gone from the model entirely (finding 2). A role grants
 * inside the unit it was granted in, full stop.
 *
 * `position` is the hierarchy, and it is now PER UNIT: you cannot create, edit,
 * delete or hand out a role at or above your own highest position in that
 * unit's own scale. Position 30 in Unit A has no relationship to position 30 in
 * Unit B.
 *
 * `owner: true` marks the role the unit's creator receives. It is a
 * convenience, not the source of their authority — that is
 * `units.owner_user_id`, which no role edit can revoke.
 */

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

/**
 * The one default template ships the six approved Vantage roles. They form a
 * deliberate capability ladder while remaining editable, unit-local copies.
 */
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

/** Public shape for the creation wizard — no bit maths on the wire. */
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
