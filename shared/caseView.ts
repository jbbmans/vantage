import type { Stage } from './caseModel.ts';
import type { Procedure, StepProgress } from './procedures.ts';
import type { CONTRIBUTION_DEFINITIONS } from './record.ts';

/**
 * The shape of GET /api/work/items/:id. The server's builders are annotated with these types, so a change on
 * one side that the other does not expect fails the typecheck instead of the page.
 */

/** An event's body is the JSON its kind writes; readers pick the fields they know. */
export type EventBody = Record<string, any>;

export interface CasePerson { id: string; name: string; rank: string | null }

export interface CaseEventView {
  id: string;
  kind: string;
  step: string | null;
  actor_id: string | null;
  subject_id: string | null;
  body: EventBody;
  supersedes_id: string | null;
  /** A later correction replaced this entry. */
  superseded: boolean;
  occurred_at: string;
  created_at: string;
}

export interface CaseContributor {
  user_id: string;
  name: string;
  rank: string | null;
  research: number;
  submitted: number;
  verified: number;
  handoffs: number;
  resolved: number;
  actions: number;
  first_at: string;
  last_at: string;
}

export interface CalculationState { stale: boolean; reasons: string[] }

export interface CaseIntegrity {
  status: 'verified' | 'broken' | 'unsealed';
  count: number;
  reason?: string;
}

export interface CasePermissions {
  claim: boolean;
  act: boolean;
  progress: boolean;
  resolve: boolean;
  reassign: boolean;
  hand_off: boolean;
  apply_procedure: boolean;
}

export interface CaseView {
  stage: Stage;
  waiting: { category: string; since: string | null } | null;
  blocked_reason: string | null;
  procedure: (Procedure & { pinned_version: string; newer_version: string | null }) | null;
  /** The case is pinned to a procedure version this build no longer carries. */
  procedure_unavailable: { key: string; version: string | null; current: string | null } | null;
  progress: { steps: StepProgress[]; next: string | null } | null;
  /** The newest calculation's body, flattened, with its standing. */
  latest_calculation: (EventBody & CalculationState & { id: string; step: string | null }) | null;
  calculations: Array<CalculationState & { id: string; formula: string; step: string | null }>;
  latest_funds_check: (EventBody & { id: string }) | null;
  resolution: { checks: Array<{ check: string; label: string }>; met: { ok: boolean; check: string | null } } | null;
  integrity: CaseIntegrity;
  events: CaseEventView[];
  people: Record<string, CasePerson>;
  contributors: CaseContributor[];
  permissions: CasePermissions;
}

export interface WorkItemView {
  id: string;
  unit_id: string | null;
  owner_id: string;
  visibility: string;
  source_file_id: string | null;
  import_job_id: string | null;
  natural_key: string;
  row_hash: string;
  source_row: number | null;
  title: string;
  reference: string | null;
  due_date: string | null;
  amount: number | null;
  amount_type: string | null;
  quantity: number | null;
  unit_label: string | null;
  state: string;
  /** The source row's columns, as imported. */
  data: Record<string, string>;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  source_changed_at: string | null;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  stage?: string | null;
  waiting_category?: string | null;
  waiting_since?: string | null;
  blocked_reason?: string | null;
  procedure_key?: string | null;
  procedure_version?: string | null;
  project_id?: string | null;
}

export interface WorkItemDetail {
  item: WorkItemView;
  /** The older per-person action log, newest first. */
  actions: Array<Record<string, unknown>>;
  source: { id: string; filename: string; created_at: string; sha256: string } | null;
  project: { id: string; name: string; target_date: string | null } | null;
  contributors: Array<Record<string, unknown>>;
  case: CaseView;
}

/** A case on someone's assigned list (GET /api/record/assigned), with the step it waits on. */
export interface AssignedItem {
  id: string; title: string; reference: string | null; natural_key: string; due_date: string | null;
  stage: Stage; state: string; waiting_category: string | null; waiting_since: string | null; blocked_reason: string | null;
  claimed_at: string | null; unit_id: string | null; project_id: string | null; project_name: string | null;
  amount: number | null; amount_type: string | null; procedure_key: string | null; procedure_short: string | null;
  next_step: { key: string; title: string; status: string; note: string | null } | null;
  version: number;
}

/** One person's recorded contribution in a window; CONTRIBUTION_DEFINITIONS says what each count means. */
export type ContributionCounts = Record<keyof typeof CONTRIBUTION_DEFINITIONS, number>;

export interface WorkloadMember extends ContributionCounts {
  id: string; name: string; rank_abbr: string | null; billet: string | null;
  /** The sub-unit, when the view rolls several up. */
  team: string | null;
  assigned: number; waiting: number; blocked: number; overdue: number;
  last_recorded_at: string | null;
}

/** GET /api/work/workload: a unit's shared work and, for those who may see it, each member's share. */
export interface WorkloadResponse {
  unit_id: string; unit_name: string | null;
  /** How many units below this one are counted in. */
  rolls_up: number;
  window: { from: string; to: string; timezone?: string };
  section: {
    open: number; unassigned: number; overdue: number; blocked: number; waiting: number; verification_required: number;
    aging: { under_7_days: number; from_7_to_30_days: number; over_30_days: number };
    by_stage: Record<string, number>;
    by_waiting: Record<string, { count: number; oldest_hours: number }>;
    by_procedure: Array<{ key: string; short: string; title: string; family: string | null; open: number; unassigned: number; blocked: number; overdue: number }>;
    documents_researched: number; resolved: number; verified: number; submitted: number;
  };
  unassigned: AssignedItem[];
  attention: AssignedItem[];
  members: WorkloadMember[];
  members_visible: boolean;
  definitions: typeof CONTRIBUTION_DEFINITIONS;
  limitations: readonly string[];
}
