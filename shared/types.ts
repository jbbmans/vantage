import type { Visibility } from './constants.ts';
import type { ProgressResult } from './metricEngine.ts';
import type { PermissionKey, RoleTemplate } from './permissions.ts';

export interface Rank { id: string; grade: string; abbr: string; name: string; tier: string; sort: number }

export interface Unit {
  id: string; code: string; name: string; short_name: string | null; echelon: string; location: string | null;
  parent_id: string | null; owner_user_id: string | null; active: number; created_at: string;
}

export interface Role {
  id: string; unit_id: string; key: string | null; name: string; description: string | null; color: string | null;
  position: number; permissions: number; is_default: number; is_system: number; created_at: string;
}

export interface Membership {
  unit_id: string; user_id: string; is_primary: number; billet: string | null; joined_at: string;
  unit_name?: string; unit_short?: string | null; unit_code?: string;
}

export interface BaseRecord {
  id: string; user_id: string; unit_id: string | null; visibility: Visibility; version: number;
  frozen_at: string | null; deleted_at: string | null; created_at: string; updated_at: string;
}

export interface Activity extends BaseRecord {
  date: string | null; title: string; category: string | null; eval_area: string | null; quantity: number | null;
  unit_label: string | null; dollar_amount: number | null; dollar_type: string | null; result: string | null;
  organization: string | null; system: string | null; project_id: string | null; status: string | null;
  notes: string | null; evidence_links: EvidenceLink[]; fingerprint?: string | null;
}
export interface EvidenceLink { label?: string | null; url?: string | null }

export interface Project extends BaseRecord {
  name: string; description: string | null; status: string; priority: string; progress: number;
  start_date: string | null; target_date: string | null; organization: string | null;
}

export interface Task extends BaseRecord {
  title: string; notes: string | null; status: string; priority: string; due_date: string | null;
  project_id: string | null; assignee_id: string | null;
}

export interface Goal extends BaseRecord {
  title: string; description: string | null; type: string; category: string | null; metric: string;
  current_value: number; target_value: number | null; unit_label: string | null; status: string;
  period_start: string | null; period_end: string | null; assignee_id: string | null;
  metric_id: string | null; direction: string; baseline_value: number | null; aggregation: string;
  /** Stored as JSON; the API sends it parsed. */
  filters: Record<string, string | null>;
  measure_scope: string; completed_at: string | null;
  /** Computed by the server from the records the goal counts. */
  progress?: GoalProgress;
}

export interface GoalProgress extends ProgressResult {
  basis: string;
  auto: boolean;
  measuresEntries: boolean;
  metricId: string | null;
  unit: string | null;
}

export interface Training extends BaseRecord {
  date: string | null; title: string; type: string | null; hours: number | null; provider: string | null;
  status: string; notes: string | null;
}

export interface Award extends BaseRecord {
  date: string | null; name: string; type: string; status: string; recommending_official: string | null;
  approving_authority: string | null; citation: string | null; notes: string | null;
  submitted_at: string | null; approved_at: string | null; presented_at: string | null;
  /** Who entered it: the Marine, or the leader who recommended them (ADR-0015). */
  recorded_by?: string | null;
  /** Set when someone other than the viewer recorded it. */
  recorder_name?: string;
}

export interface Counseling extends BaseRecord {
  date: string | null; type: string; counselor_id: string | null; counselor_name: string | null;
  summary: string; strengths: string | null; improvements: string | null; goals_set: string | null;
  follow_up_date: string | null; acknowledged_at: string | null;
  /** Sent when the reader is not the person counseled. */
  subject_name?: string;
}

export interface Readiness {
  pft_score: number | null; cft_score: number | null; rifle_qual: string | null; mcmap_belt: string | null;
  ceus: number | null; college_credits: number | null; degree: string | null; pme_complete: string | null;
  cmd_character: number | null; cmd_mos: number | null; cmd_leadership: number | null;
  fitrep_period_end: string | null; rank_grade?: string | null; rank_abbr?: string | null;
}

export interface UserPublic {
  id: string; username: string; email: string | null; first_name: string; last_name: string; middle_initial: string | null;
  rank_id: string | null; mos: string | null; eas: string | null; is_operator: number; active: number;
  mfa_enabled: number; must_change_password: number; created_at: string; last_login_at: string | null;
}

export type DateRange = { start: Date; end: Date; label?: string };

/** A row of each record store, as GET /api/records/:store returns it. */
export interface RecordRows {
  activities: Activity; projects: Project; tasks: Task; goals: Goal; trainings: Training; awards: Award; counselings: Counseling;
}

/** GET /api/me/org: the ranks, the units in view and the roles in the reader's own units. */
export interface OrgResponse {
  ranks: Rank[];
  units: Unit[];
  roles: Role[];
  permissionCatalogue: Array<{ key: PermissionKey; label: string; hint: string; group: string; dangerous?: boolean; bit: number }>;
}

/** GET /api/org/roles. */
export interface RolesResponse {
  roles: Array<Role & { editable: boolean }>;
  /** The reader's highest role position in each unit. */
  positions: Record<string, number>;
  template: RoleTemplate[];
}

export interface TeamMembership { user_id: string; unit_id: string; is_primary: number; billet: string | null; unit_name: string; unit_short: string | null }
export interface TeamRole { user_id: string; unit_id: string; id: string; name: string; color: string | null; position: number; key: string | null }

export interface TeamPerson {
  id: string; first_name: string; last_name: string; middle_initial: string | null; mos: string | null; rank_id: string | null;
  rank_abbr: string | null; rank_grade: string | null; rank_sort: number | null;
  /** Only the memberships in units the reader can see. */
  memberships: TeamMembership[];
  roles: TeamRole[];
  /** The reader may open this person's page. */
  canOpen: boolean;
}

/** GET /api/org/team: everyone the reader can see, and the units where the reader holds each power. */
export interface TeamResponse {
  roster: TeamPerson[];
  readableUnitIds: string[];
  manageMembers: string[];
  manageRoles: string[];
  counsel: string[];
  exportUnits: string[];
}

/** One stretch of one unit membership with the same billet and primary flag; open while ended_at is null. */
export interface MembershipPeriod {
  id: number; unit_id: string; unit_name: string; unit_short: string | null; billet: string | null; is_primary: number;
  started_at: string; ended_at: string | null; start_reason: string | null; end_reason: string | null;
}

/** Whether an account can be used, as the people who manage it see it (ADR-0017). Never a secret. */
export type AccountStatus = 'active' | 'locked' | 'never_signed_in' | 'must_change_password' | 'deactivated';

/** A person named on a personnel record: a supervisor, a leader, whoever made a change. */
export interface PersonnelPersonRef { id: string; first_name: string; last_name: string; rank_abbr: string | null }

/** One membership as the personnel record shows it: the unit, the billet it fills and the dates of the assignment. */
export interface PersonnelAssignment {
  unit_id: string; unit_name: string; unit_short: string | null; echelon: string | null; is_primary: number;
  billet: string | null; billet_id: string | null; assignment_start: string | null; assignment_end: string | null; joined_at: string;
  /** The reader may change it: Manage members in the unit, above the Marine there. */
  canManage: boolean;
}

export interface PersonnelResponsibility {
  id: string; title: string; unit_id: string | null; unit_label: string | null; starts_on: string | null; ends_on: string | null;
  created_at: string; ended_at: string | null; end_reason: string | null; assigned_by: PersonnelPersonRef | null;
  /** The reader may end it: they manage the Marine in its unit, or anywhere in its Unit Instance once the Marine has left that unit. */
  canEnd?: boolean;
}

/** One change to a personnel fact: rank, mos, eas, account, supervisor, checked_in, assignment_start or assignment_end. */
export interface PersonnelEvent {
  id: number; field: string; from_value: string | null; to_value: string | null; from_label: string | null; to_label: string | null;
  unit_id: string | null; unit_label: string | null; source: string | null; reason: string | null; batch_id: string | null; at: string;
  /** Who made it, when the reader may know. */
  actor: PersonnelPersonRef | null;
}

/** A Marine's personnel record in one Unit Instance they serve in. */
export interface PersonnelInstance {
  org_id: string; org_name: string;
  assignments: PersonnelAssignment[];
  /** Their own team: the deepest unit they belong to there. */
  team: { unit_id: string; label: string; echelon: string | null } | null;
  supervisor: PersonnelPersonRef | null;
  checked_in_on: string | null;
  /** Their supervisors upward, then the leaders of their primary unit there and of the units above it. Information only. */
  chain: Array<PersonnelPersonRef & { relation: 'supervisor' | 'leader'; unit_label: string | null }>;
  supervises: PersonnelPersonRef[];
  responsibilities: PersonnelResponsibility[];
  roles: Array<{ unit_id: string; unit_label: string; name: string; color: string | null }>;
  /** Unit Instance roles, by label: Lead Unit Manager, Unit Manager, Records Officer, Unit Auditor. */
  orgRoles: string[];
  canManage: boolean;
  /** The Unit Instance's active billets for their units, when the reader may set one. */
  billets: Array<{ id: string; title: string; unit_id: string | null; code: string | null }>;
}

/** GET /api/org/team/:id/personnel: the personnel record (ADR-0017), as much of it as the reader may see. */
export interface PersonnelRecordResponse {
  person: { id: string; first_name: string; last_name: string; middle_initial: string | null; rank_id: string | null; rank_abbr: string | null; rank_name: string | null; rank_grade: string | null; mos: string | null; eas: string | null };
  /** Profile fields the personnel feed sets, which only the feed changes. */
  sourced: string[];
  self: boolean;
  canOpenRecords: boolean;
  /** Whether the reader may correct their name, rank, MOS and EAS, by the rule the profile route applies. */
  canEditProfile: boolean;
  /** For the Marine and those who manage them. */
  account: { status: AccountStatus; last_login_at: string | null; locked_until: string | null; mfa: boolean; cac: boolean } | null;
  instances: PersonnelInstance[];
  /** For the Marine, those who manage them and those who open their records. */
  history: { periods: MembershipPeriod[]; events: PersonnelEvent[] } | null;
  /** How many of each record the reader may open; only with record access. Duty counts Operations activities until Task 17. */
  records: { trainings: number; education: number; awards: number; counselings: number; duty: number; activities: number; goals: number; tasks: number } | null;
}

export interface PersonnelRosterRow {
  id: string; first_name: string; last_name: string; rank_abbr: string | null; rank_grade: string | null; rank_sort: number | null; mos: string | null; eas: string | null;
  /** The membership this row stands for: their own team beneath the unit, else the unit. */
  assignment: PersonnelAssignment;
  team_label: string;
  supervisor: PersonnelPersonRef | null;
  checked_in_on: string | null;
  responsibilities: string[];
  roles: Array<{ id: string; name: string; color: string | null }>;
  /** Only for oneself and the Marines the reader manages. */
  status?: AccountStatus;
  last_login_at?: string | null;
  self: boolean;
  canManage: boolean;
  canOpenRecords: boolean;
}

/** GET /api/org/units/:id/personnel: the personnel roster of a unit and the units beneath it. */
export interface PersonnelRosterResponse {
  unit_id: string; org_id: string | null;
  rows: PersonnelRosterRow[];
  /** The Unit Instance's active billets for these units, when the reader manages members here. */
  billets: Array<{ id: string; title: string; unit_id: string | null; code: string | null }>;
  canManage: boolean;
}

/** POST /api/org/units/:id/personnel/bulk: what happened, or would, to each Marine. Nothing is applied unless every row is. */
export interface PersonnelBulkResponse {
  batch_id: string | null; applied: boolean; dry_run: boolean; refused: number;
  results: Array<{ user_id: string; unit_id: string; ok: boolean; changed: string[]; code?: string; error?: string }>;
}

/** GET /api/org/team/:id: one Marine's page, limited to the units the reader shares with them (all of it for oneself). */
export interface MemberDetailResponse {
  person: {
    id: string; first_name: string; last_name: string; middle_initial: string | null; mos: string | null; eas: string | null;
    rank_id: string | null; rank_abbr: string | null; rank_grade: string | null; rank_name: string | null; last_login_at: string | null;
    /** Only on one's own page. */
    email?: string | null;
  };
  memberships: Array<{ unit_id: string; is_primary: number; billet: string | null; joined_at: string; unit_name: string; unit_short: string | null }>;
  /** Held unit roles; a time-bound one carries the moment it ends. */
  roles: Array<{ unit_id: string; id: string; name: string; color: string | null; position: number; permissions: number; key: string | null; expires_at?: string | null }>;
  /** Membership periods, newest first (ADR-0009): the whole history on one's own page, otherwise the periods in units the reader can open in their own Unit Instance. */
  history: MembershipPeriod[];
  detailUnits: string[];
  canCounsel: string[];
  canManageMembers: string[];
  activities: Activity[]; trainings: Training[]; awards: Award[]; counselings: Counseling[]; goals: Goal[]; tasks: Task[];
}
