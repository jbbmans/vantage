import { AWARD_NAMES, type AWARD_TYPES, type TRAINING_TYPES } from './constants.ts';

/**
 * Where each kind of record Vantage knows lives, who writes it, who may correct it, and which system outside Vantage
 * holds the official copy (ADR-0015). One entry per concept of the spec's core domain model (section 11).
 *
 * An Activity is one kind among these: work a person did. It sits on the timeline beside the others, and it never stands
 * in for an award, a course, a counseling or a duty, which keep records of their own. The timeline is read from each
 * kind's own store when it is asked for; nothing copies a record into Activities to put it there.
 */
export interface RecordKind {
  key: string;
  /** The concept's name in the spec's domain model. */
  label: string;
  /** Its table and, where one table holds several kinds, which of its rows. Null for a kind no Task has built yet. */
  store: { table: string; rows?: string } | null;
  /** The Task that builds it, for a kind with no store yet. */
  plannedIn?: string;
  writtenBy: string;
  correctedBy: string;
  /** The system outside Vantage whose copy is official, where there is one. Vantage's copy is the person's working record. */
  systemOfRecord: string | null;
  /** On the person's timeline (GET /api/record/timeline). */
  timeline: boolean;
  /** Only work a person did is recorded as an Activity. */
  activity: boolean;
}

export const RECORD_KINDS: readonly RecordKind[] = [
  { key: 'identity', label: 'Identity', store: { table: 'users', rows: 'edipi, edipi_verified_at, oidc_subject; passkeys' }, writtenBy: 'The CAC or the organization’s sign-in, which proves the EDIPI (ADR-0009)', correctedBy: 'Vantage support, with a second staff member where the account holds authority (ADR-0013)', systemOfRecord: 'The CAC and the enterprise identity provider', timeline: false, activity: false },
  { key: 'account', label: 'User / Account', store: { table: 'users' }, writtenBy: 'An invitation, self-registration, a Unit Manager’s account import or the personnel feed', correctedBy: 'The person for their profile; fields the personnel feed sets, only the feed', systemOfRecord: null, timeline: false, activity: false },
  { key: 'unit_membership', label: 'Unit Membership', store: { table: 'unit_members', rows: 'and unit_membership_periods for its history' }, writtenBy: 'Unit leaders, Unit Managers and the personnel feed', correctedBy: 'Unit leaders and Unit Managers', systemOfRecord: null, timeline: false, activity: false },
  { key: 'personnel_assignment', label: 'Personnel Assignment', store: { table: 'personnel_records', rows: 'with unit_members for billet and assignment dates, personnel_responsibilities, and personnel_events for its history (ADR-0017); personnel_roster mirrors the feed' }, writtenBy: 'Those who manage the Marine’s membership, one at a time or in bulk; rank, MOS and EAS also by the person and the personnel feed', correctedBy: 'Those who manage the Marine’s membership; fields the personnel feed sets, only the feed', systemOfRecord: 'The personnel system the roster feed mirrors, for what it sets', timeline: false, activity: false },
  { key: 'unit', label: 'Unit', store: { table: 'units' }, writtenBy: 'Unit Managers and unit leaders', correctedBy: 'Unit Managers and unit leaders', systemOfRecord: null, timeline: false, activity: false },
  { key: 'team', label: 'Team / Fire Team', store: { table: 'units', rows: 'echelon squad or fire_team' }, writtenBy: 'Unit leaders', correctedBy: 'Unit leaders', systemOfRecord: null, timeline: false, activity: false },
  { key: 'billet', label: 'Billet', store: { table: 'unit_billets', rows: 'and unit_members.billet for who holds one' }, writtenBy: 'Unit Managers (ADR-0012)', correctedBy: 'Unit Managers', systemOfRecord: null, timeline: false, activity: false },
  { key: 'role', label: 'Role', store: { table: 'roles', rows: 'member_roles, org_roles and platform_roles for who holds one' }, writtenBy: 'Unit leaders, Unit Managers and Vantage Administrators, each within their own tier (ADR-0010)', correctedBy: 'The same tier', systemOfRecord: null, timeline: false, activity: false },
  { key: 'permission', label: 'Permission', store: { table: 'roles', rows: 'the permissions bit set; catalogued in shared/permissions.ts' }, writtenBy: 'The code: a role chooses among the catalogued permissions', correctedBy: 'A role’s editor, within their own permissions', systemOfRecord: null, timeline: false, activity: false },
  { key: 'activity', label: 'Activity', store: { table: 'activities' }, writtenBy: 'The person, about their own work; a financial case they worked, through a draft they word', correctedBy: 'The person; a unit leader with Edit others’ records, on a shared entry', systemOfRecord: null, timeline: true, activity: true },
  { key: 'training', label: 'Training', store: { table: 'trainings', rows: "type 'training', 'course' or 'skill'" }, writtenBy: 'The person', correctedBy: 'The person; a unit leader with Edit others’ records, on a shared one', systemOfRecord: 'MCTIMS, and MarineNet for distance education', timeline: true, activity: false },
  { key: 'pme', label: 'Professional Military Education', store: { table: 'trainings', rows: "type 'pme'" }, writtenBy: 'The person', correctedBy: 'The person; a unit leader with Edit others’ records, on a shared one', systemOfRecord: 'MCTIMS and MarineNet; MOL for the credit it earns', timeline: true, activity: false },
  { key: 'education', label: 'Education', store: { table: 'trainings', rows: "type 'education'" }, writtenBy: 'The person', correctedBy: 'The person', systemOfRecord: 'The school’s transcript', timeline: true, activity: false },
  { key: 'certification', label: 'Certification', store: { table: 'trainings', rows: "type 'certification'" }, writtenBy: 'The person', correctedBy: 'The person', systemOfRecord: 'The certifying body', timeline: true, activity: false },
  { key: 'qualification', label: 'Qualification', store: { table: 'trainings', rows: "type 'qualification'; readiness for rifle, PFT, CFT and MCMAP" }, writtenBy: 'The person', correctedBy: 'The person', systemOfRecord: 'MCTIMS', timeline: true, activity: false },
  { key: 'award', label: 'Award', store: { table: 'awards', rows: "type 'personal_award' or 'unit_award'" }, writtenBy: 'The person, or a leader who recommends them (recorded_by)', correctedBy: 'Whoever recorded it: the person for their own; for a recommendation, its recorder while they hold Counsel members, and a unit leader with Edit others’ records. Never its subject (ADR-0015)', systemOfRecord: 'iAPS and MOL', timeline: true, activity: false },
  { key: 'recognition', label: 'Recognition', store: { table: 'awards', rows: "type 'meritorious_mast', 'certificate', 'loa', 'coin' or 'other'" }, writtenBy: 'The person, or a leader who recommends them (recorded_by)', correctedBy: 'As for an award', systemOfRecord: null, timeline: true, activity: false },
  { key: 'counseling', label: 'Counseling', store: { table: 'counselings' }, writtenBy: 'The counselor (counselor_id), or the person for their own notes', correctedBy: 'The counselor until it is acknowledged; never its subject (ADR-0013)', systemOfRecord: 'The signed counseling the command keeps', timeline: true, activity: false },
  { key: 'duty', label: 'Duty', store: null, plannedIn: 'Task 17', writtenBy: 'Recorded against the Unit Instance’s duty types', correctedBy: 'Decided in Task 18', systemOfRecord: null, timeline: true, activity: false },
  { key: 'duty_type', label: 'Duty Type', store: { table: 'duty_types' }, writtenBy: 'Unit Managers (ADR-0012)', correctedBy: 'Unit Managers', systemOfRecord: null, timeline: false, activity: false },
  { key: 'duty_scoring_policy', label: 'Duty Scoring Policy', store: { table: 'duty_scoring_policies' }, writtenBy: 'Unit Managers, as versions with effective dates (ADR-0012)', correctedBy: 'Nobody: a new version replaces it from its date', systemOfRecord: null, timeline: false, activity: false },
  { key: 'goal', label: 'Goal', store: { table: 'goals' }, writtenBy: 'The person, or a leader who assigns it', correctedBy: 'Its owner; its assignee for status and progress', systemOfRecord: null, timeline: true, activity: false },
  // Not one of the spec's concepts, but a record type the records API serves: work a person or their unit is carrying.
  { key: 'project', label: 'Project', store: { table: 'projects' }, writtenBy: 'The person, or a unit leader for shared work', correctedBy: 'Its owner; a unit leader with Edit others’ records, on a shared one', systemOfRecord: null, timeline: false, activity: false },
  { key: 'task', label: 'Task', store: { table: 'tasks' }, writtenBy: 'The person, or a leader who assigns it', correctedBy: 'Its owner; its assignee for status and notes', systemOfRecord: null, timeline: false, activity: false },
  { key: 'financial_case', label: 'Financial Case', store: { table: 'work_items' }, writtenBy: 'Intake from an uploaded report, or a person opening one', correctedBy: 'Through its append-only history only (ADR-0002)', systemOfRecord: 'DAI, SABRS and the other financial systems the case is about', timeline: false, activity: false },
  { key: 'financial_error_snapshot', label: 'Financial Error Snapshot', store: null, plannedIn: 'Task 15', writtenBy: 'An uploaded error report', correctedBy: 'Nobody: a later upload is a new snapshot', systemOfRecord: 'The report it was uploaded from', timeline: false, activity: false },
  { key: 'financial_action', label: 'Financial Action', store: { table: 'work_events', rows: 'and work_actions for the person’s own steps' }, writtenBy: 'The person working the case', correctedBy: 'A later event that supersedes it; the history is append-only (ADR-0002)', systemOfRecord: null, timeline: false, activity: false },
  { key: 'report', label: 'Report', store: { table: 'report_drafts', rows: 'and report_revisions for each saved version' }, writtenBy: 'The person', correctedBy: 'The person, as a new revision', systemOfRecord: 'MOL holds the official evaluation', timeline: false, activity: false },
  { key: 'attachment', label: 'Attachment', store: { table: 'attachments' }, writtenBy: 'Whoever may edit the record it hangs on', correctedBy: 'Removed and added again, never changed (its hash is kept)', systemOfRecord: null, timeline: false, activity: false },
  { key: 'import', label: 'Import', store: { table: 'import_jobs', rows: 'and source_files for the file itself' }, writtenBy: 'The person or the unit running it', correctedBy: 'Nobody: it is the record of what was read', systemOfRecord: null, timeline: false, activity: false },
  { key: 'export', label: 'Export', store: { table: 'audit_log', rows: "actions 'export', 'export_csv', 'export_personal' and the others" }, writtenBy: 'The service, when someone exports', correctedBy: 'Nobody', systemOfRecord: null, timeline: false, activity: false },
  { key: 'audit_event', label: 'Audit Event', store: { table: 'audit_log' }, writtenBy: 'The service', correctedBy: 'Nobody: the trail is append-only (ADR-0013)', systemOfRecord: null, timeline: false, activity: false },
];

/** The record types a person may move an entry between: work they did, an award, and training. */
export const MOVABLE_TABLES = ['activities', 'awards', 'trainings'] as const;
export type MovableTable = (typeof MOVABLE_TABLES)[number];
export const isMovableTable = (t: string): t is MovableTable => (MOVABLE_TABLES as readonly string[]).includes(t);

export const MOVABLE_LABELS: Record<MovableTable, { one: string; place: string }> = {
  activities: { one: 'activity', place: 'Activities' },
  awards: { one: 'award', place: 'Awards' },
  trainings: { one: 'training', place: 'Training' },
};

/**
 * Activities drawn from a financial case carry its key in their fingerprint (server/services/work.ts and record.ts):
 * `work:` and `case:` for a case's own entry, `draft:` for one worded from a draft. Those stay where they are, tied to
 * the case they came from.
 */
export const isDrawnFromWork = (fingerprint: unknown) => typeof fingerprint === 'string' && /^(?:work|case|draft):/.test(fingerprint);

export type AwardType = (typeof AWARD_TYPES)[number];
export type TrainingType = (typeof TRAINING_TYPES)[number];

export type KindReading =
  | { kind: 'award'; type: AwardType; name: string | null; why: string }
  | { kind: 'training'; type: TrainingType; why: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const AWARD_ABBREVIATIONS: Record<string, string> = {
  NAM: 'Navy and Marine Corps Achievement Medal', NMCAM: 'Navy and Marine Corps Achievement Medal',
  NCM: 'Navy and Marine Corps Commendation Medal', NMCCM: 'Navy and Marine Corps Commendation Medal',
  MSM: 'Meritorious Service Medal', JSAM: 'Joint Service Achievement Medal', JSCM: 'Joint Service Commendation Medal',
  GCM: 'Marine Corps Good Conduct Medal', MUC: 'Meritorious Unit Commendation', NUC: 'Navy Unit Commendation',
};
// LOA is left out on purpose: on a financial desk it is a line of accounting far more often than a letter of appreciation.
const AWARD_WORDS = new RegExp(`\\b(?:${[...AWARD_NAMES.map(escapeRe), ...Object.keys(AWARD_ABBREVIATIONS), 'medal', 'commendation', 'letter of appreciation',
  'certificate of (?:commendation|appreciation|achievement)', 'meritorious mast', 'challenge coin', 'coined by', 'good conduct'].join('|')})\\b`, 'i');
// Received, not handed out: "was presented the NAM", not "presented the NAM to LCpl Diaz".
const RECEIVED = /\b(?:received|receiving|awarded|was presented|presented with|got|earned|recognized with|recipient of|pinned|coined by)\b|\bfrom (?:the |my |our )?(?:co|xo|cg|sgtmaj|commanding (?:officer|general)|commander|sergeant major|battalion|regiment|division|command)\b/i;
// Writing up or moving someone else's award is work, and stays an Activity.
const OTHERS_AWARD = /\b(?:drafted|drafting|wrote|writing|written|prepared|preparing|processed|processing|routed|routing|submitted|submitting|nominated|recommended|recommending|reviewed|tracked|staffed|presented (?:\w+ ){0,6}to)\b|\bfor (?:my|his|her|their|the|our|two|three|four|five|\d+) (?:marines?|team|section|shop|subordinates?|members?|personnel)\b|\bfor (?:pvt|pfc|lcpl|cpl|sgt|ssgt|gysgt|msgt|1stsgt|mgysgt|sgtmaj|2ndlt|1stlt|capt|maj|ltcol|col)\b|\b\d+\s+(?:awards?|packages?|marines)\b/i;

const COMPLETED = /\b(?:completed|complete|completing|finished|graduated|graduate of|passed|attended|certified|earned|obtained|enrolled in|took|qualified)\b/i;
const COURSE_WORDS = /\b(?:course|courses|pme|marinenet|mci|class|classes|seminar|school|academy|certification|certificate program|degree|bachelor'?s|master'?s|associate'?s|diploma|curriculum|dep|distance education|ews|snco ?a|corporals course|sergeants course|career course|command and staff|war college|training|qualification|credential|exam|certificate)\b/i;
// Teaching, running or building training for others is work, and stays an Activity.
const OTHERS_TRAINING = /\b(?:taught|teach|teaching|instructed|instructing|instruction|led|leading|facilitated|facilitating|conducted|conducting|ran|running|organized|organizing|coordinated|coordinating|briefed|trained|training \d+|mentored|coached|developed|built|designed|wrote|scheduled|hosted|proctored)\b|\bfor (?:my|the|our|two|three|four|five|\d+) (?:marines?|personnel|students|members|section|team|shop)\b|\b\d+\s+(?:marines|students|personnel|members|graduates)\b/i;
// The readiness snapshot holds these; they are not a course.
const READINESS = /\b(?:rifle|pistol|range|pft|cft|mcmap|swim qual|gas chamber)\b/i;

function awardType(text: string): AwardType {
  if (/meritorious mast/i.test(text)) return 'meritorious_mast';
  if (/letter of appreciation/i.test(text)) return 'loa';
  if (/certificate of/i.test(text)) return 'certificate';
  if (/\bcoin(?:ed)?\b/i.test(text)) return 'coin';
  if (/unit commendation|\bMUC\b|\bNUC\b/i.test(text)) return 'unit_award';
  return 'personal_award';
}

function awardName(text: string): string | null {
  const named = AWARD_NAMES.find((n) => new RegExp(`\\b${escapeRe(n)}\\b`, 'i').test(text));
  if (named) return named;
  const abbr = Object.keys(AWARD_ABBREVIATIONS).find((a) => new RegExp(`\\b${a}\\b`).test(text));
  return abbr ? AWARD_ABBREVIATIONS[abbr] : null;
}

export function trainingType(text: string): TrainingType {
  if (/\bpme\b|corporals course|sergeants course|career course|advanced course|\bsnco ?a\b|\bews\b|command and staff|war college|\bdep\b|academy/i.test(text)) return 'pme';
  if (/\bdegree\b|bachelor|master'?s|associate'?s|college|university|credits?\b|diploma|semester/i.test(text)) return 'education';
  if (/certif|security\+|comptia|license|licence|credential|\bexam\b/i.test(text)) return 'certification';
  if (/qualif/i.test(text)) return 'qualification';
  if (/course|class|seminar|school|marinenet|\bmci\b/i.test(text)) return 'course';
  return 'training';
}

/**
 * Whether an entry's words read as an award the person received or training they completed rather than work they did.
 * Conservative: when the words could be either, it says nothing, and the entry stays an Activity. It only ever suggests;
 * nothing is moved without its owner (ADR-0015).
 */
export function recordKindOf(text: string | null | undefined): KindReading | null {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (AWARD_WORDS.test(t) && RECEIVED.test(t) && !OTHERS_AWARD.test(t)) {
    return { kind: 'award', type: awardType(t), name: awardName(t), why: 'Reads like an award you received.' };
  }
  if (COMPLETED.test(t) && COURSE_WORDS.test(t) && !OTHERS_TRAINING.test(t) && !READINESS.test(t)) {
    return { kind: 'training', type: trainingType(t), why: 'Reads like training you completed.' };
  }
  return null;
}

/** The words of an entry the classifier reads. */
export const kindText = (table: MovableTable, row: Record<string, unknown>) =>
  (table === 'awards' ? [row.name] : table === 'trainings' ? [row.title] : [row.title, row.result]).filter(Boolean).join('. ');

const clamp = (v: unknown, max: number): string | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const joined = (parts: unknown[], max: number) => clamp(parts.map((p) => String(p ?? '').trim()).filter(Boolean).join('\n\n'), max);
const linksText = (links: unknown) => {
  const list = Array.isArray(links) ? links : (() => { try { return JSON.parse(String(links || '[]')); } catch { return []; } })();
  const lines = (list as Array<{ label?: string | null; url?: string | null }>).filter((l) => l?.url || l?.label).map((l) => [l.label, l.url].filter(Boolean).join(': '));
  return lines.length ? `Evidence:\n${lines.join('\n')}` : null;
};
const HOURS = /^(?:h|hr|hrs|hour|hours)$/i;

/**
 * What an entry becomes in another record type: the fields that carry across, and sensible ones for the rest. What has
 * nowhere to go (an activity's dollar value, an award's approving authority in a course) is kept in the move's lineage snapshot,
 * and an undo puts the entry back exactly as it was.
 */
export function movedFields(from: MovableTable, row: Record<string, unknown>, to: MovableTable): Record<string, unknown> {
  const reading = recordKindOf(kindText(from, row));
  const date = row.date ?? null;
  if (from === 'activities') {
    const notes = joined([row.result, row.notes, linksText(row.evidence_links)], 4000);
    if (to === 'awards') {
      const planned = row.status === 'planned';
      const name = clamp((reading?.kind === 'award' && reading.name) || row.title, 200);
      // Named from what the title says ("Navy and Marine Corps Achievement Medal"), the award keeps the title's own words.
      const said = name !== clamp(row.title, 200) ? row.title : null;
      return {
        name, date, type: reading?.kind === 'award' ? reading.type : 'personal_award',
        status: planned ? 'planned' : 'presented', presented_at: planned ? null : date, notes: said ? joined([said, notes], 4000) : notes,
      };
    }
    return {
      title: clamp(row.title, 300), date, type: reading?.kind === 'training' ? reading.type : trainingType(String(row.title || '')),
      hours: row.quantity != null && HOURS.test(String(row.unit_label || '').trim()) ? row.quantity : null, provider: clamp(row.organization, 200),
      status: row.status === 'planned' ? 'scheduled' : 'completed', notes,
    };
  }
  if (from === 'awards') {
    const done = row.status === 'presented' || row.status === 'approved';
    if (to === 'activities') return { title: clamp(row.name, 300), date, category: 'Recognition', status: done ? 'completed' : 'planned', notes: joined([row.citation, row.notes], 8000) };
    return { title: clamp(row.name, 300), date, type: trainingType(String(row.name || '')), status: done ? 'completed' : 'scheduled', notes: joined([row.citation, row.notes], 4000) };
  }
  const completed = row.status === 'completed';
  if (to === 'activities') {
    return {
      title: clamp(row.title, 300), date, category: 'Training & PME', status: completed ? 'completed' : 'planned', quantity: row.hours ?? null,
      unit_label: row.hours != null ? 'hours' : null, organization: clamp(row.provider, 200), notes: clamp(row.notes, 8000),
    };
  }
  return { name: clamp(row.title, 200), date, type: 'personal_award', status: completed ? 'presented' : 'planned', presented_at: completed ? date : null, notes: joined([row.provider, row.notes], 4000) };
}

/** GET /api/record/timeline: one entry of the person's own records, read from its own table (server/services/timeline.ts). */
export interface TimelineItem {
  kind: string; table: 'activities' | 'trainings' | 'awards' | 'counselings' | 'goals'; id: string; date: string; title: string;
  detail: string | null; status: string | null; from_work: boolean; href: string;
}
export interface TimelineResponse { items: TimelineItem[]; kind: string | null; counts: Record<string, number>; total: number; truncated: boolean; pending: Array<{ key: string; label: string; plannedIn: string | null }> }

/** GET /api/record/move-candidates: an activity that reads like an award received or training completed. */
export interface MoveCandidate { id: string; title: string; date: string | null; result: string | null; reading: KindReading; to: MovableTable }
export interface MoveCandidatesResponse { candidates: MoveCandidate[]; total: number }

/** GET /api/records/:table/:id/lineage. `before` and `reason` reach the entry's owner only. */
export interface LineageMove {
  id: string; from_table: MovableTable; from_id: string; to_table: MovableTable; to_id: string; method: 'move' | 'undo'; at: string; by_owner: boolean;
  reason?: string | null; before?: Record<string, unknown> | null;
}
export interface LineageResponse { moves: LineageMove[]; undo: { from_table: MovableTable } | null }
