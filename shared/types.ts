import type { Visibility } from './constants.ts';

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
}

export interface Training extends BaseRecord {
  date: string | null; title: string; type: string | null; hours: number | null; provider: string | null;
  status: string; notes: string | null;
}

export interface Award extends BaseRecord {
  date: string | null; name: string; type: string; status: string; recommending_official: string | null;
  approving_authority: string | null; citation: string | null; notes: string | null;
  submitted_at: string | null; approved_at: string | null; presented_at: string | null;
}

export interface Counseling extends BaseRecord {
  date: string | null; type: string; counselor_id: string | null; counselor_name: string | null;
  summary: string; strengths: string | null; improvements: string | null; goals_set: string | null;
  follow_up_date: string | null; acknowledged_at: string | null;
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
