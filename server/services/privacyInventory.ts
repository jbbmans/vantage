import type { AppContext } from '../context.ts';
import { listSchedules } from './retention.ts';

export type PiiCategory =
  | 'none'            // not about a person
  | 'identifier'      // names a person: EDIPI, username, email
  | 'contact'
  | 'employment'      // rank, unit, MOS, billet, dates of service
  | 'performance'     // what somebody did and how it was judged
  | 'authentication'  // secrets and credential material
  | 'technical';      // addresses, agents, timestamps

export interface TableDeclaration {
  purpose: string;
  authority: string;
  /** Who can read it inside the app. */
  access: string;
  /** Column name → what kind of personal information it is. */
  columns: Record<string, PiiCategory>;
}

export const DECLARATIONS: Record<string, TableDeclaration> = {
  users: {
    purpose: 'Identifies the account holder and carries the service details their record is reported under.',
    authority: '10 U.S.C. 5013; DoDI 1336.05 (evaluation reporting); collected under the instance Privacy Act statement.',
    access: 'The person. A unit leader sees name, rank and billet for their own unit. The owner sees accounts but never private record contents.',
    columns: {
      id: 'identifier', username: 'identifier', email: 'contact', edipi: 'identifier',
      first_name: 'identifier', last_name: 'identifier', middle_initial: 'identifier',
      rank_id: 'employment', mos: 'employment', eas: 'employment',
      password_hash: 'authentication', totp_secret: 'authentication', totp_enabled: 'authentication', totp_pending: 'authentication', totp_last_step: 'authentication',
      is_operator: 'employment', active: 'employment', must_change_password: 'authentication',
      identity_source: 'employment', identity_synced_at: 'employment', demo_workspace_id: 'technical',
      prefs: 'none', digest_last_sent_at: 'technical', last_login_at: 'technical',
      created_at: 'technical', updated_at: 'technical',
    },
  },
  personnel_roster: {
    purpose: 'The authoritative service record as an upstream personnel system states it, so the app does not keep its own divergent copy.',
    authority: 'Mirrored from the source system of record under its own authority; retained here only while the person is assigned.',
    access: 'Administrators. A person sees their own row through their profile.',
    columns: {
      edipi: 'identifier', last_name: 'identifier', first_name: 'identifier', middle_initial: 'identifier',
      rank_id: 'employment', mos: 'employment', eas: 'employment', unit_code: 'employment', billet: 'employment',
      status: 'employment', source: 'technical', row_hash: 'technical', synced_at: 'technical',
      created_at: 'technical', updated_at: 'technical',
    },
  },
  activities: {
    purpose: 'What the person did, quantified, so their evaluation input is built from a dated record rather than recollection.',
    authority: 'Voluntarily recorded by the person about their own work.',
    access: 'The person. Shared entries are visible to their unit only when the person marks them shared.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', date: 'performance', title: 'performance',
      category: 'performance', eval_area: 'performance', quantity: 'performance', unit_label: 'performance',
      dollar_amount: 'performance', dollar_type: 'performance', result: 'performance', organization: 'employment',
      system: 'none', project_id: 'technical', status: 'performance', notes: 'performance', evidence_links: 'performance',
      visibility: 'none', fingerprint: 'technical', frozen_at: 'technical', deleted_at: 'technical',
      created_at: 'technical', updated_at: 'technical', version: 'technical',
    },
  },
  counselings: {
    purpose: 'Counseling given or received, including acknowledgement, so the conversation has a dated record both sides can see.',
    authority: 'Recorded under the counseling policy the unit operates by. Directly about a named person and treated as the most sensitive record here.',
    access: 'The subject and the counselor. Private counselings are never readable by other leaders or by the owner through the app.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', counselor_id: 'identifier',
      date: 'performance', type: 'performance', counselor_name: 'identifier', summary: 'performance',
      strengths: 'performance', improvements: 'performance', goals_set: 'performance', follow_up_date: 'performance',
      acknowledged_at: 'performance', visibility: 'none', frozen_at: 'technical', deleted_at: 'technical',
      created_at: 'technical', updated_at: 'technical', version: 'technical',
    },
  },
  work_events: {
    purpose: 'The attributed history of one piece of work: who claimed, researched, decided, submitted, verified or handed it on, when, and on what reference.',
    authority: 'Operational work records of the unit that owns the work item. Append-only.',
    access: 'People who can read the work item. A person keeps seeing the entries they authored.',
    columns: {
      id: 'technical', work_item_id: 'technical', unit_id: 'employment', actor_id: 'identifier', kind: 'performance', step: 'performance',
      subject_id: 'identifier', body: 'performance', supersedes_id: 'technical', correlation_id: 'technical', idempotency_key: 'technical',
      occurred_at: 'performance', created_at: 'technical',
    },
  },
  record_drafts: {
    purpose: 'A private accomplishment draft a person prepares from facts they recorded, before deciding whether to use it.',
    authority: 'Voluntarily prepared by the person about their own work.',
    access: 'The person only. No leader, reviewer or operator route reads it.',
    columns: {
      id: 'technical', user_id: 'identifier', work_item_id: 'technical', title: 'performance', facts: 'performance', wording: 'performance',
      wording_source: 'technical', activity_id: 'technical', version: 'technical', deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  career_steps: {
    purpose: 'A person’s own development plan: next steps, where the guidance came from, and whether it was checked.',
    authority: 'Voluntarily recorded by the person.',
    access: 'The person only.',
    columns: {
      id: 'technical', user_id: 'identifier', title: 'employment', category: 'employment', status: 'employment', due_date: 'employment',
      notes: 'employment', source_label: 'none', source_url: 'none', source_checked_on: 'technical', version: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  career_profiles: {
    purpose: 'A person’s stated military goal and civilian interests, to organise their own next steps.',
    authority: 'Voluntarily recorded by the person.',
    access: 'The person only.',
    columns: { user_id: 'identifier', military_goal: 'employment', civilian_interests: 'employment', updated_at: 'technical' },
  },
  audit_log: {
    purpose: 'Who did what, so access to somebody else’s record can be answered for. Hash-chained so an entry cannot be removed without detection.',
    authority: 'Security and accountability logging. Required to demonstrate the access controls work.',
    access: 'The owner. A person sees the entries where somebody else acted on their record.',
    columns: {
      id: 'technical', seq: 'technical', actor_id: 'identifier', action: 'none', entity: 'none', entity_id: 'technical',
      subject_id: 'identifier', unit_id: 'employment', detail: 'technical', ip: 'technical', at: 'technical',
      prev_hash: 'technical', entry_hash: 'technical',
    },
  },
  sessions: {
    purpose: 'Signed-in devices, so a person can see and end them.',
    authority: 'Necessary to operate authenticated access.',
    access: 'The person, for their own sessions.',
    columns: {
      id: 'authentication', user_id: 'identifier', ip: 'technical', user_agent: 'technical',
      method: 'technical', sudo_until: 'technical', created_at: 'technical', last_used_at: 'technical',
      expires_at: 'technical', absolute_expires_at: 'technical',
    },
  },
  retention_schedules: {
    purpose: 'How long each kind of record is kept and what happens then, with the authority it is kept under.',
    authority: 'Records management. The schedule itself is the instrument, so it is retained as long as the records it governs.',
    access: 'The owner.',
    columns: {
      id: 'technical', record_type: 'none', retain_days: 'none', disposition: 'none', authority: 'none',
      notes: 'none', enabled: 'none', created_at: 'technical', updated_at: 'technical',
    },
  },
  legal_holds: {
    purpose: 'Which records are frozen against disposition, why, and who froze them.',
    authority: 'Preservation obligation. A hold naming a person is about that person, so it is treated as identifying.',
    access: 'The owner.',
    columns: {
      id: 'technical', scope: 'none', subject_id: 'identifier', record_type: 'none', reason: 'employment',
      placed_by: 'identifier', placed_at: 'technical', released_by: 'identifier', released_at: 'technical',
    },
  },
  disposition_runs: {
    purpose: 'What disposition did on each run, which is the evidence that retention was applied as written.',
    authority: 'Records management accountability.',
    access: 'The owner.',
    columns: {
      id: 'technical', actor_id: 'identifier', dry_run: 'none', record_type: 'none', disposition: 'none',
      eligible: 'none', acted: 'none', held: 'none', detail: 'technical', at: 'technical',
    },
  },
  personnel_sync_runs: {
    purpose: 'Every applied roster sync and what it changed, so a person can be told why their record changed under them.',
    authority: 'Records management accountability for the personnel feed.',
    access: 'The owner.',
    columns: {
      id: 'technical', source: 'technical', actor_id: 'identifier', dry_run: 'none', rows_seen: 'none',
      created: 'none', updated: 'none', separated: 'none', conflicts: 'none', detail: 'technical', at: 'technical',
    },
  },
  meta: {
    purpose: 'Instance settings and markers: schema version, runtime switches, first-boot jobs.',
    authority: 'Necessary to operate the instance.',
    access: 'The owner, through the console.',
    columns: { key: 'none', value: 'none' },
  },
  ranks: {
    purpose: 'The reference list of grades and ranks the app offers.',
    authority: 'Reference data; not about any person.',
    access: 'Everyone signed in.',
    columns: { id: 'none', grade: 'none', abbr: 'none', name: 'none', tier: 'none', sort: 'none' },
  },
  readiness: {
    purpose: 'Readiness facts a person keeps about themselves (PFT, CFT, rifle, MCMAP, PME, education) to see where they stand.',
    authority: 'Voluntarily recorded by the person.',
    access: 'The person. A leader with member detail for their unit sees it on the member page.',
    columns: {
      user_id: 'identifier', pft_score: 'performance', cft_score: 'performance', rifle_qual: 'performance', mcmap_belt: 'performance',
      ceus: 'employment', college_credits: 'employment', degree: 'employment', pme_complete: 'employment', cmd_character: 'performance',
      cmd_mos: 'performance', cmd_leadership: 'performance', fitrep_period_end: 'employment', updated_at: 'technical',
    },
  },
  passkeys: {
    purpose: 'Registered passkeys, so a person can sign in without a password and see or remove their devices.',
    authority: 'Necessary to operate authenticated access.',
    access: 'The person, for their own passkeys.',
    columns: {
      id: 'authentication', user_id: 'identifier', public_key: 'authentication', counter: 'authentication', transports: 'technical',
      device_type: 'technical', backed_up: 'technical', name: 'technical', created_at: 'technical', last_used_at: 'technical',
    },
  },
  recovery_codes: {
    purpose: 'One-time recovery codes for a person who loses their authenticator. Stored only as hashes.',
    authority: 'Necessary to operate authenticated access.',
    access: 'Nobody reads them; a code is only checked against its hash.',
    columns: { id: 'technical', user_id: 'identifier', code_hash: 'authentication', used_at: 'technical' },
  },
  tokens: {
    purpose: 'Single-use links: password reset, invitations, email confirmation. Stored only as hashes, and expired.',
    authority: 'Necessary to operate account recovery and enrolment.',
    access: 'Nobody reads them; a presented token is checked against its hash.',
    columns: {
      id: 'technical', kind: 'none', token_hash: 'authentication', user_id: 'identifier', email: 'contact', payload: 'technical',
      expires_at: 'technical', used_at: 'technical', created_by: 'identifier', created_at: 'technical',
    },
  },
  units: {
    purpose: 'The organisations work and records belong to, and their chain.',
    authority: 'Organisational structure; not about a person except for the owner reference.',
    access: 'Members of the unit and its parents; the owner.',
    columns: {
      id: 'technical', code: 'employment', name: 'employment', short_name: 'employment', echelon: 'employment', location: 'employment',
      parent_id: 'technical', owner_user_id: 'identifier', active: 'none', created_at: 'technical',
    },
  },
  unit_members: {
    purpose: 'Who belongs to which unit, in what billet, and who enrolled them. Access to shared work follows this table and nothing else.',
    authority: 'Organisational assignment.',
    access: 'Members of the unit see the roster; leaders manage it.',
    columns: { user_id: 'identifier', unit_id: 'employment', is_primary: 'employment', billet: 'employment', joined_at: 'employment', invited_by: 'identifier' },
  },
  roles: {
    purpose: 'The roles a unit defines and the permissions each carries.',
    authority: 'Access control configuration; not about a person.',
    access: 'Leaders of the unit.',
    columns: {
      id: 'technical', unit_id: 'employment', key: 'none', name: 'none', description: 'none', color: 'none', position: 'none',
      permissions: 'none', is_default: 'none', is_system: 'none', created_at: 'technical',
    },
  },
  member_roles: {
    purpose: 'Which role each member holds in a unit, and who granted it.',
    authority: 'Access control; changes are audited.',
    access: 'Leaders of the unit; the person sees their own.',
    columns: { user_id: 'identifier', role_id: 'employment', unit_id: 'employment', granted_by: 'identifier', created_at: 'technical' },
  },
  projects: {
    purpose: 'Longer efforts a person or unit tracks, with the work and entries filed under them.',
    authority: 'Operational work records.',
    access: 'The author; the unit when marked shared.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', visibility: 'none', name: 'performance', description: 'performance',
      status: 'performance', priority: 'none', progress: 'performance', start_date: 'performance', target_date: 'performance',
      organization: 'employment', version: 'technical', frozen_at: 'technical', deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  tasks: {
    purpose: 'Things to do, by whom, by when.',
    authority: 'Operational work records.',
    access: 'The author and the assignee; the unit when marked shared.',
    columns: {
      id: 'technical', user_id: 'identifier', assignee_id: 'identifier', unit_id: 'employment', visibility: 'none', project_id: 'technical',
      title: 'performance', notes: 'performance', status: 'performance', priority: 'none', due_date: 'performance',
      version: 'technical', frozen_at: 'technical', deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  goals: {
    purpose: 'Targets a person or leader sets, measured from recorded outcomes.',
    authority: 'Voluntarily set by the person, or assigned by a leader for their unit.',
    access: 'The author and the assignee; the unit when marked shared.',
    columns: {
      id: 'technical', user_id: 'identifier', assignee_id: 'identifier', unit_id: 'employment', visibility: 'none', title: 'performance',
      description: 'performance', type: 'none', category: 'none', metric: 'none', current_value: 'performance', target_value: 'performance',
      unit_label: 'none', status: 'performance', period_start: 'none', period_end: 'none', version: 'technical', frozen_at: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical', metric_id: 'none', direction: 'none',
      baseline_value: 'performance', aggregation: 'none', filters: 'none', measure_scope: 'none', completed_at: 'performance',
    },
  },
  trainings: {
    purpose: 'Training a person completed, with hours and provider.',
    authority: 'Voluntarily recorded by the person about their own training.',
    access: 'The person; the unit when marked shared.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', visibility: 'none', date: 'employment', title: 'employment', type: 'employment',
      hours: 'employment', provider: 'employment', status: 'employment', notes: 'employment', version: 'technical', frozen_at: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  awards: {
    purpose: 'Awards recommended, approved or presented, and their citations.',
    authority: 'Recorded under the awards program the unit operates by.',
    access: 'The person; the unit when marked shared.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', visibility: 'none', date: 'performance', name: 'performance', type: 'performance',
      status: 'performance', recommending_official: 'identifier', approving_authority: 'identifier', citation: 'performance', notes: 'performance',
      submitted_at: 'performance', approved_at: 'performance', presented_at: 'performance', version: 'technical', frozen_at: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  attachments: {
    purpose: 'Files attached to a record as its evidence. Stored with a hash so a changed file is detectable.',
    authority: 'Evidence for the record it hangs on; inherits that record’s authority.',
    access: 'Whoever can read the record it is attached to.',
    columns: {
      id: 'technical', record_table: 'none', record_id: 'technical', uploaded_by: 'identifier', original_name: 'performance',
      mime_type: 'technical', size_bytes: 'technical', sha256: 'technical', content: 'performance', created_at: 'technical', deleted_at: 'technical',
    },
  },
  notifications: {
    purpose: 'Messages to a person about work and records that changed.',
    authority: 'Necessary to operate the product.',
    access: 'The person.',
    columns: {
      id: 'technical', user_id: 'identifier', kind: 'none', title: 'performance', message: 'performance', action_url: 'technical',
      dedupe_key: 'technical', read_at: 'technical', created_at: 'technical',
    },
  },
  maradmins: {
    purpose: 'Public MARADMIN messages fetched from marines.mil, for reference.',
    authority: 'Public information; not about any person.',
    access: 'Everyone signed in.',
    columns: {
      id: 'technical', number: 'none', title: 'none', summary: 'none', url: 'none', tags: 'none', audience: 'none',
      published_at: 'none', source_hash: 'technical', fetched_at: 'technical',
    },
  },
  maradmin_user_state: {
    purpose: 'Which MARADMINs a person has read or saved.',
    authority: 'Necessary to operate the product.',
    access: 'The person.',
    columns: { user_id: 'identifier', maradmin_id: 'technical', read_at: 'technical', saved_at: 'technical' },
  },
  ai_usage_daily: {
    purpose: 'How many AI requests and tokens each person used per day, to enforce budgets. Never the prompt or the answer.',
    authority: 'Operational control of a metered service.',
    access: 'The owner, as totals; the person, for their own.',
    columns: {
      day: 'technical', user_id: 'identifier', workflow: 'none', model: 'none', requests: 'none', prompt_tokens: 'none',
      completion_tokens: 'none', total_tokens: 'none', failures: 'none',
    },
  },
  email_queue: {
    purpose: 'Email a receiving server asked this instance to retry later, when it delivers mail itself. The message, which can hold a reset link, is encrypted with the instance secret and deleted once delivered or given up: after 30 minutes for a reset link, two days at most for anything else.',
    authority: 'Operational delivery of mail the instance already decided to send.',
    access: 'Nobody through the app; the delivery job alone.',
    columns: {
      id: 'technical', log_id: 'technical', to_address: 'contact', kind: 'none', payload: 'authentication', attempts: 'technical', last_error: 'technical',
      next_attempt_at: 'technical', expires_at: 'technical', created_at: 'technical',
    },
  },
  email_log: {
    purpose: 'Which emails the instance sent, to whom, and whether delivery failed. Never the body.',
    authority: 'Operational accountability for outbound mail.',
    access: 'The owner.',
    columns: {
      id: 'technical', user_id: 'identifier', to_address: 'contact', kind: 'none', subject: 'technical', status: 'technical',
      error: 'technical', created_at: 'technical',
    },
  },
  source_files: {
    purpose: 'Spreadsheets uploaded to bring work in, kept byte-for-byte as the evidence each work item came from, with the scan result.',
    authority: 'Operational work records of the unit; bytes released after the intake retention window unless a hold covers them.',
    access: 'The uploader; the unit when uploaded as shared.',
    columns: {
      id: 'technical', user_id: 'identifier', unit_id: 'employment', visibility: 'none', filename: 'performance', content_type: 'technical',
      kind: 'technical', byte_size: 'technical', sha256: 'technical', scan_status: 'technical', scan_detail: 'technical', scanner: 'technical',
      scanned_at: 'technical', notes: 'technical', content: 'performance', deleted_at: 'technical', created_at: 'technical',
    },
  },
  import_jobs: {
    purpose: 'Each import run: the mapping used, what it inserted, updated or refused, and who ran it.',
    authority: 'Operational accountability for imported work.',
    access: 'The person who ran it; the unit when shared.',
    columns: {
      id: 'technical', source_file_id: 'technical', user_id: 'identifier', unit_id: 'employment', visibility: 'none', sheet_name: 'none',
      header_row: 'none', mapping: 'none', key_columns: 'none', status: 'technical', total_rows: 'none', processed_rows: 'none',
      inserted_rows: 'none', updated_rows: 'none', unchanged_rows: 'none', rejected_rows: 'none', rejections: 'performance',
      error: 'technical', idempotency_key: 'technical', started_at: 'technical', finished_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  work_items: {
    purpose: 'One piece of unit work (a document, a UMT, an open balance): its source values, stage, holder and the procedure it follows.',
    authority: 'Operational work records of the unit that owns the work item.',
    access: 'Current members of the unit for shared work; the author and holder for private work.',
    columns: {
      id: 'technical', unit_id: 'employment', owner_id: 'identifier', visibility: 'none', source_file_id: 'technical', import_job_id: 'technical',
      natural_key: 'none', row_hash: 'technical', source_row: 'technical', title: 'none', reference: 'none', due_date: 'none', amount: 'none',
      amount_type: 'none', quantity: 'none', unit_label: 'none', state: 'performance', data: 'none', claimed_by: 'identifier',
      claimed_at: 'performance', resolved_at: 'performance', source_changed_at: 'technical', version: 'technical', deleted_at: 'technical',
      created_at: 'technical', updated_at: 'technical', project_id: 'technical', stage: 'performance', waiting_category: 'performance',
      waiting_since: 'performance', blocked_reason: 'performance', procedure_key: 'none', procedure_version: 'none',
    },
  },
  work_actions: {
    purpose: 'Work recorded on an item through the older free-form path: what kind, how much, and whether it also went into the person’s record.',
    authority: 'Operational work records of the unit.',
    access: 'People who can read the work item.',
    columns: {
      id: 'technical', work_item_id: 'technical', user_id: 'identifier', unit_id: 'employment', kind: 'performance', note: 'performance',
      occurred_at: 'performance', quantity: 'performance', unit_label: 'performance', dollar_amount: 'performance', dollar_type: 'performance',
      activity_id: 'technical', idempotency_key: 'technical', created_at: 'technical',
    },
  },
  work_views: {
    purpose: 'Saved filters for the queue.',
    authority: 'Necessary to operate the product.',
    access: 'The person; the unit when shared.',
    columns: { id: 'technical', user_id: 'identifier', unit_id: 'employment', name: 'none', shared: 'none', config: 'none', created_at: 'technical', updated_at: 'technical' },
  },
  report_drafts: {
    purpose: 'Evaluation input (JEPES, FITREP) being assembled about a named person, with its revisions.',
    authority: 'Prepared under the evaluation program. About a named person and treated as sensitive.',
    access: 'The author and, when shared, the unit leaders with evaluation permission.',
    columns: {
      id: 'technical', user_id: 'identifier', subject_id: 'identifier', unit_id: 'employment', visibility: 'none', title: 'performance',
      period_start: 'performance', period_end: 'performance', track: 'employment', latest_revision: 'technical', version: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  report_revisions: {
    purpose: 'Each saved version of a report draft and the records it was built from.',
    authority: 'As report_drafts.',
    access: 'As report_drafts.',
    columns: {
      id: 'technical', report_id: 'technical', revision: 'technical', title: 'performance', period_start: 'performance', period_end: 'performance',
      sections: 'performance', source_snapshots: 'performance', note: 'performance', created_by: 'identifier', created_at: 'technical',
    },
  },
  contacts: {
    purpose: 'People outside the unit the work is coordinated with: vendors, contracting officers, DFAS, other agencies.',
    authority: 'Operational contact records.',
    access: 'The author; the unit when shared.',
    columns: {
      id: 'technical', owner_id: 'identifier', unit_id: 'employment', visibility: 'none', name: 'identifier', email: 'contact',
      organization: 'employment', role: 'employment', phone: 'contact', notes: 'contact', version: 'technical', deleted_at: 'technical',
      created_at: 'technical', updated_at: 'technical',
    },
  },
  threads: {
    purpose: 'A correspondence thread about work: who it is with, where it stands, and when a response or key supporting document arrived.',
    authority: 'Operational correspondence records of the unit.',
    access: 'The owner; the unit when shared.',
    columns: {
      id: 'technical', owner_id: 'identifier', unit_id: 'employment', visibility: 'none', contact_id: 'technical', subject: 'performance',
      state: 'performance', follow_up_at: 'performance', last_message_at: 'technical', response_at: 'performance', ksd_at: 'performance',
      resolved_at: 'performance', provider: 'technical', provider_thread_id: 'technical', connector_id: 'technical', version: 'technical',
      deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  thread_messages: {
    purpose: 'The messages in a thread, sanitised: remote images and active content are blocked and recorded as blocked.',
    authority: 'As threads.',
    access: 'As threads.',
    columns: {
      id: 'technical', thread_id: 'technical', direction: 'none', provider_message_id: 'technical', connector_id: 'technical', source: 'technical',
      from_name: 'identifier', from_email: 'contact', to_emails: 'contact', cc_emails: 'contact', sent_at: 'technical', subject: 'performance',
      body_text: 'performance', body_html: 'performance', blocked_remote_images: 'technical', blocked_active_content: 'technical',
      attachments: 'performance', created_by: 'identifier', created_at: 'technical',
    },
  },
  thread_links: {
    purpose: 'Which work items a thread is about.',
    authority: 'As threads.',
    access: 'People who can read both the thread and the work item.',
    columns: { id: 'technical', thread_id: 'technical', work_item_id: 'technical', created_by: 'identifier', created_at: 'technical' },
  },
  connectors: {
    purpose: 'A person’s read-only connection to their Microsoft 365 mailbox: which cloud, which account it signed in as, and its encrypted sign-in.',
    authority: 'Voluntarily authorized by the person for their own mailbox.',
    access: 'The person. An operator can see that a connection exists, never read through it; tokens never leave the server.',
    columns: {
      id: 'technical', user_id: 'identifier', provider: 'technical', cloud: 'technical', account_label: 'contact', access: 'technical',
      status: 'technical', scopes: 'technical', delta_token: 'authentication', last_sync_at: 'technical', last_error: 'technical',
      created_at: 'technical', updated_at: 'technical', access_token_enc: 'authentication', refresh_token_enc: 'authentication',
      token_expires_at: 'technical', account_id: 'identifier', account_address: 'contact', tenant_id: 'technical', authorized_at: 'technical',
    },
  },
  connector_auth_states: {
    purpose: 'A mailbox sign-in in progress: the hash of its state value and its encrypted PKCE verifier, for ten minutes, once.',
    authority: 'Necessary to complete a sign-in safely.',
    access: 'Nobody reads it; a returning sign-in is matched against the hash.',
    columns: { state_hash: 'authentication', connector_id: 'technical', user_id: 'identifier', verifier_enc: 'authentication', created_at: 'technical', expires_at: 'technical', used_at: 'technical' },
  },
  comments: {
    purpose: 'Discussion on a record or work item, with mentions.',
    authority: 'Operational communication about the record it hangs on.',
    access: 'Whoever can read the record it is on.',
    columns: {
      id: 'technical', record_table: 'none', record_id: 'technical', author_id: 'identifier', unit_id: 'employment', body: 'performance',
      mentions: 'identifier', edited_at: 'technical', deleted_at: 'technical', created_at: 'technical',
    },
  },
  unit_invites: {
    purpose: 'Invitation links into a unit. The code is stored only as a hash.',
    authority: 'Necessary to operate enrolment.',
    access: 'Leaders of the unit.',
    columns: {
      id: 'technical', unit_id: 'employment', code_hash: 'authentication', code_hint: 'technical', created_by: 'identifier', role_id: 'employment',
      note: 'none', max_uses: 'none', uses: 'none', expires_at: 'technical', revoked_at: 'technical', created_at: 'technical',
    },
  },
  unit_invite_uses: {
    purpose: 'Who joined through which invitation.',
    authority: 'Enrolment accountability.',
    access: 'Leaders of the unit.',
    columns: { id: 'technical', invite_id: 'technical', user_id: 'identifier', created_at: 'technical' },
  },
  support_tickets: {
    purpose: 'Requests for help from people using the instance.',
    authority: 'Operational support records.',
    access: 'The requester and the operators handling it.',
    columns: {
      id: 'technical', requester_id: 'identifier', requester_email: 'contact', requester_name: 'identifier', unit_id: 'employment',
      subject: 'technical', category: 'none', state: 'technical', priority: 'none', assigned_to: 'identifier', resolved_at: 'technical',
      closed_at: 'technical', version: 'technical', deleted_at: 'technical', created_at: 'technical', updated_at: 'technical',
    },
  },
  support_messages: {
    purpose: 'The conversation on a support request, including internal operator notes.',
    authority: 'As support_tickets.',
    access: 'The requester sees public messages; operators see all.',
    columns: { id: 'technical', ticket_id: 'technical', author_id: 'identifier', body: 'technical', internal: 'none', created_at: 'technical' },
  },
  demo_workspaces: {
    purpose: 'A visitor’s synthetic demo workspace and when it expires. Every person in it is invented.',
    authority: 'Demo operation only; the demo instance holds no real person.',
    access: 'The visitor holding the workspace.',
    columns: { id: 'technical', unit_id: 'technical', persona_user_id: 'technical', leader_user_id: 'technical', created_at: 'technical', last_used_at: 'technical', expires_at: 'technical' },
  },
  work_event_seals: {
    purpose: 'The per-case hash chain over work history, so a changed, removed or inserted entry is detectable.',
    authority: 'Integrity control for the work history.',
    access: 'Nobody edits it; verification reads it.',
    columns: { event_id: 'technical', work_item_id: 'technical', seq: 'technical', prev_hash: 'technical', entry_hash: 'technical', sealed_at: 'technical' },
  },
  work_event_heads: {
    purpose: 'The signed head of each case’s history chain, anchored daily into the audit chain.',
    authority: 'Integrity control for the work history.',
    access: 'Nobody edits it; verification reads it.',
    columns: { work_item_id: 'technical', hash: 'technical', count: 'technical', mac: 'authentication', updated_at: 'technical' },
  },
  product_events: {
    purpose: 'Whether the product works: which screens get used and where people give up. Holds names and numbers only, never anything anybody typed.',
    authority: 'Operational measurement. Reported only in aggregate above a minimum cohort size.',
    access: 'The owner, as counts. Never as one person’s row.',
    columns: {
      id: 'technical', name: 'none', user_id: 'identifier', unit_id: 'employment', session_id: 'technical',
      origin: 'none', properties: 'none', form_ms: 'none', active_editor_ms: 'none', confirmed_work_minutes: 'none',
      occurred_at: 'technical', received_at: 'technical',
    },
  },
};

export interface InventoryTable {
  table: string;
  purpose: string | null;
  authority: string | null;
  access: string | null;
  rows: number;
  retention: { retain_days: number; disposition: string; authority: string | null; enabled: boolean } | null;
  columns: Array<{ column: string; category: PiiCategory | 'unclassified' }>;
  unclassified: string[];
  stale: string[];
}

export interface Inventory {
  generatedAt: string;
  instance: string;
  tables: InventoryTable[];
  summary: { tables: number; declared: number; undeclared: string[]; unclassifiedColumns: number; staleColumns: number; piiTables: number };
}

const SENSITIVE: PiiCategory[] = ['identifier', 'contact', 'employment', 'performance', 'authentication'];

export function buildInventory(ctx: AppContext): Inventory {
  const { db } = ctx;
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  const schedules = new Map(listSchedules(ctx).map((s) => [s.record_type, s]));

  const out: InventoryTable[] = [];
  const undeclared: string[] = [];
  let unclassifiedColumns = 0; let staleColumns = 0; let piiTables = 0;

  for (const table of tables) {
    const declaration = DECLARATIONS[table];
    const live = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!declaration) undeclared.push(table);

    const columns = live.map((column) => ({
      column,
      category: (declaration?.columns[column] ?? 'unclassified') as PiiCategory | 'unclassified',
    }));
    const unclassified = columns.filter((c) => c.category === 'unclassified').map((c) => c.column);
    const stale = declaration ? Object.keys(declaration.columns).filter((c) => !live.includes(c)) : [];
    unclassifiedColumns += unclassified.length;
    staleColumns += stale.length;
    if (columns.some((c) => SENSITIVE.includes(c.category as PiiCategory))) piiTables += 1;

    const schedule = schedules.get(table);
    let rows = 0;
    try { rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; } catch { rows = -1; }

    out.push({
      table,
      purpose: declaration?.purpose ?? null,
      authority: declaration?.authority ?? null,
      access: declaration?.access ?? null,
      rows,
      retention: schedule ? { retain_days: schedule.retain_days, disposition: schedule.disposition, authority: schedule.authority, enabled: Boolean(schedule.enabled) } : null,
      columns,
      unclassified,
      stale,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    instance: ctx.runtime.organizationName || ctx.runtime.displayName || 'Vantage',
    tables: out,
    summary: { tables: tables.length, declared: tables.length - undeclared.length, undeclared, unclassifiedColumns, staleColumns, piiTables },
  };
}

export function inventoryMarkdown(inv: Inventory): string {
  const lines: string[] = [];
  lines.push(`# Data inventory — ${inv.instance}`, '', `Generated ${inv.generatedAt} from the live schema.`, '');
  lines.push(`${inv.summary.tables} tables, ${inv.summary.piiTables} holding personal information.`);
  if (inv.summary.unclassifiedColumns) lines.push('', `**${inv.summary.unclassifiedColumns} columns are unclassified.** Each one is a question this assessment cannot yet answer.`);
  if (inv.summary.staleColumns) lines.push('', `**${inv.summary.staleColumns} declared columns no longer exist.** The declaration has drifted from the schema.`);
  if (inv.summary.undeclared.length) lines.push('', `**Undeclared tables:** ${inv.summary.undeclared.join(', ')}`);

  for (const t of inv.tables) {
    lines.push('', `## ${t.table}`, '');
    lines.push(`- **Rows:** ${t.rows < 0 ? 'unknown' : t.rows.toLocaleString()}`);
    lines.push(`- **Purpose:** ${t.purpose ?? '_not declared_'}`);
    lines.push(`- **Authority:** ${t.authority ?? '_not declared_'}`);
    lines.push(`- **Who can see it:** ${t.access ?? '_not declared_'}`);
    lines.push(`- **Retention:** ${t.retention ? `${t.retention.retain_days} days, then ${t.retention.disposition}${t.retention.enabled ? '' : ' (schedule not enabled)'}${t.retention.authority ? ` — ${t.retention.authority}` : ''}` : '_no schedule set_'}`);
    const sensitive = t.columns.filter((c) => SENSITIVE.includes(c.category as PiiCategory));
    if (sensitive.length) {
      lines.push('', '| Column | Category |', '| --- | --- |');
      for (const c of sensitive) lines.push(`| ${c.column} | ${c.category} |`);
    }
    if (t.unclassified.length) lines.push('', `_Unclassified: ${t.unclassified.join(', ')}_`);
    if (t.stale.length) lines.push('', `_Declared but absent: ${t.stale.join(', ')}_`);
  }
  return lines.join('\n');
}
