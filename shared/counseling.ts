import type { COUNSELING_TYPES } from './constants.ts';

/**
 * Counseling as structured data (VANTAGE_CLAUDE_MASTER Task 20, ADR-0027). A counseling a leader writes for a Marine is
 * drafted, may be shared with that Marine to review, is finalized, and from then on changes only by an amendment that
 * keeps what it replaced. Its Marine acknowledges the text as it stands. A Marine's own counseling notes stay as they
 * were: theirs to write and correct, always final.
 *
 * Who may do what is one rule (`counselingOptions`), which the server enforces and sends with each counseling, so a page
 * offers exactly what will be accepted. The printable worksheet is one document (`CounselingDocument`), built by the
 * server from what is stored, that the preview, the print page and the PDF all draw. Pure: nothing here reads the database.
 */

/** Where a counseling stands. A draft is its counselor's alone; one in review is its counselor's and its Marine's. */
export const COUNSELING_STAGES = ['draft', 'review', 'final'] as const;
export type CounselingStage = (typeof COUNSELING_STAGES)[number];
export const COUNSELING_STAGE_LABELS: Record<CounselingStage, string> = { draft: 'Draft', review: 'Shared for review', final: 'Final' };

/** What can be asked of a counseling's workflow, each its own route under /api/records/counselings/:id. */
export const COUNSELING_ACTIONS = ['share', 'withdraw', 'finalize', 'amend', 'acknowledge'] as const;
export type CounselingAction = (typeof COUNSELING_ACTIONS)[number];

/** What a counseling says: what a revision keeps, and what an amendment may change. Never its stage, people or stamps. */
export const COUNSELING_CONTENT = ['date', 'type', 'counselor_name', 'summary', 'strengths', 'improvements', 'goals_set', 'follow_up_date'] as const;
export type CounselingField = (typeof COUNSELING_CONTENT)[number];
export const COUNSELING_FIELD_LABELS: Record<CounselingField, string> = {
  date: 'Date', type: 'Type', counselor_name: 'Counselor', summary: 'Summary', strengths: 'Strengths', improvements: 'Areas to improve', goals_set: 'Goals set', follow_up_date: 'Follow-up',
};

export const COUNSELING_TYPE_LABELS: Record<(typeof COUNSELING_TYPES)[number], string> = {
  initial: 'Initial', monthly: 'Monthly', quarterly: 'Quarterly', semi_annual: 'Semi-annual', event: 'Event-related', career: 'Career', other: 'Other',
};
export const counselingTypeLabel = (type: string | null | undefined) => (type && type in COUNSELING_TYPE_LABELS ? COUNSELING_TYPE_LABELS[type as keyof typeof COUNSELING_TYPE_LABELS] : type ? type.replace(/_/g, ' ') : 'Counseling');

/** The bounds on what the workflow takes: an amendment's reason, and how many amendments a worksheet lists. */
export const COUNSELING_LIMITS = { reason: 1000, history: 50 } as const;

/** Written by a counselor about another Marine: the workflow applies. Otherwise it is the Marine's own note. */
export const counselorWritten = (row: { counselor_id?: string | null; user_id: string }) => Boolean(row.counselor_id && row.counselor_id !== row.user_id);

/** What the reader holds over one counseling, worked out by the server (server/authz/records.ts counselingAuthority). */
export interface CounselingAuthority {
  /** They wrote it, and they still counsel its Marine: Counsel members, in a unit the Marine serves in, outranking them. */
  counselor: boolean;
  /** Manage shared records in its unit, and it is shared with the unit: they may amend it, as they could correct it before. */
  manager: boolean;
  /** It is about them. */
  subject: boolean;
}

/** What the reader may do with one counseling's workflow, as it stands. Editing a draft or one's own notes is `edit`. */
export interface CounselingOptions {
  edit: boolean;
  share: boolean;
  withdraw: boolean;
  finalize: boolean;
  amend: boolean;
  acknowledge: boolean;
}
export const NO_COUNSELING_OPTIONS: CounselingOptions = { edit: false, share: false, withdraw: false, finalize: false, amend: false, acknowledge: false };

export interface CounselingState {
  stage: CounselingStage | string;
  user_id: string;
  counselor_id?: string | null;
  acknowledged_at?: string | null;
  frozen_at?: string | null;
  deleted_at?: string | null;
  /** Its words were anonymized under a retention schedule. */
  anonymized?: boolean;
}

/**
 * The one rule for a counseling's workflow. `edit` is the server's edit rule (canEdit), passed through so the page and the
 * server agree. Nothing moves on a counseling that is deleted, frozen because its Marine left the unit, or anonymized,
 * except that its Marine may still say they read it.
 */
export function counselingOptions(a: CounselingAuthority, row: CounselingState, edit: boolean): CounselingOptions {
  if (row.deleted_at || !counselorWritten(row)) return { ...NO_COUNSELING_OPTIONS, edit: Boolean(edit && !row.deleted_at) };
  const still = !row.frozen_at && !row.anonymized;
  const draft = row.stage === 'draft';
  const review = row.stage === 'review';
  const final = row.stage === 'final';
  return {
    edit: Boolean(edit && still && !final),
    share: still && a.counselor && draft,
    withdraw: still && a.counselor && review,
    finalize: still && a.counselor && (draft || review),
    amend: still && final && (a.counselor || a.manager),
    acknowledge: final && a.subject && !row.acknowledged_at && !row.anonymized,
  };
}

/** One amendment, as a reader of the counseling is given it: what it replaced is printed from its revision. */
export interface CounselingRevision {
  /** The revision this amendment replaced; the counseling read this way from its finalization, or its last amendment, until then. */
  revision: number;
  /** What the counseling said at that revision. */
  content: Partial<Record<CounselingField, string | null>>;
  /** When that revision was finalized (the first) or written (an amendment). */
  finalized_at: string | null;
  /** Whether, and when, its Marine had acknowledged that revision before it was replaced. */
  acknowledged_at: string | null;
  amended_by_name: string | null;
  amended_at: string;
  reason: string;
  changed: CounselingField[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The NAVMC 2795 worksheet. NAVMC 2795 is the USMC User's Guide to Counseling (21 Jul 86, PCN 100 013485 00); its
// Appendix A holds two suggested worksheets, Figure A-1 (Lance Corporal and below) and Figure A-2 (Corporal and above).
// The labels below are the guide's, read from the published PDF (https://www.marines.mil/portals/1/publications/navmc%202795.pdf).
// Both figures print an SSN block. Vantage never records or prints an SSN (DoDI 1000.30), so that block is left out.
// ---------------------------------------------------------------------------------------------------------------------

export type Worksheet = 'A-1' | 'A-2';
export const WORKSHEETS: Record<Worksheet, { figure: string; caption: string }> = {
  'A-1': { figure: 'Figure A-1', caption: 'COUNSELING WORKSHEET - LANCE CORPORAL AND BELOW' },
  'A-2': { figure: 'Figure A-2', caption: 'COUNSELING WORKSHEET - CORPORAL AND ABOVE' },
};
/** Lance Corporal and below (E-1 to E-3) take Figure A-1; Corporal and above, and a Marine whose grade is unknown, Figure A-2. */
export const worksheetFor = (grade: string | null | undefined): Worksheet => (/^E-[123]$/.test(String(grade || '').trim()) ? 'A-1' : 'A-2');

/** NAVMC 2795 names three kinds of session (paras 2001-2002): the initial session, follow-on sessions, and event-related ones. */
export type SessionKind = 'ics' | 'follow_on' | 'event' | null;
export const sessionKindFor = (type: string | null | undefined): SessionKind =>
  type === 'initial' ? 'ics' : type === 'monthly' || type === 'quarterly' || type === 'semi_annual' ? 'follow_on' : type === 'event' ? 'event' : null;

/** Who the worksheet is about and who counseled, as of its finalization (or as they are now, on a draft or a counseling from before 035). */
export interface CounselingParticulars {
  subject: { name: string; rank: string | null; grade: string | null; mos: string | null; billet: string | null; unit: string | null };
  counselor: { name: string; rank: string | null } | null;
}

export interface CounselingBlock { key: string; label: string; parts: Array<{ label: string | null; text: string }> }

/** The one structured document a counseling prints as: the preview, the print page and the PDF all draw it. */
export interface CounselingDocument {
  form: 'vantage-counseling/1';
  id: string;
  version: number;
  stage: CounselingStage;
  /** The revision drawn, and the counseling's current one: an earlier revision is drawn from what it replaced. */
  revision: number;
  current_revision: number;
  /** A Marine's own counseling notes: no counselor signed them in Vantage. */
  own_notes: boolean;
  worksheet: { key: Worksheet; figure: string; caption: string };
  particulars: CounselingParticulars;
  /** Whether the particulars are as they stood at finalization, or as they are now. */
  particulars_as_of: 'finalized' | 'now';
  date: string | null;
  type: string;
  type_label: string;
  session_kind: SessionKind;
  follow_up_date: string | null;
  blocks: CounselingBlock[];
  finalized: { at: string | null; by: string | null };
  acknowledgement: { at: string | null; due: boolean };
  /** Amendments, newest first, capped at COUNSELING_LIMITS.history. */
  amendments: Array<{ revision: number; at: string; by: string | null; reason: string; changed: string[]; acknowledged_at: string | null }>;
  amendments_total: number;
  /** When this revision was replaced, for an earlier one. */
  superseded_at: string | null;
  marking: string;
  generated: { on: string; by: string };
  source: string;
  notices: string[];
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const part = (label: string | null, text: unknown) => (nonEmpty(text) ? [{ label, text: text.trim() }] : []);

/** The worksheet's narrative blocks, in the guide's order, with each Vantage field placed where the guide asks for it. */
export function worksheetBlocks(sheet: Worksheet, c: Partial<Record<CounselingField, string | null>>): CounselingBlock[] {
  // "Areas to improve" has no block of its own on either worksheet. It goes where the guide asks for comments, labelled.
  const improve = part('Areas to improve', c.improvements);
  if (sheet === 'A-1') {
    return [
      { key: 'tasks', label: 'Tasks Assigned Next Period', parts: part(null, c.goals_set) },
      { key: 'subjects', label: 'Subjects on Which Guidance Was Provided', parts: part(null, c.summary) },
      { key: 'accomplishments', label: 'Major Accomplishments and/or Comments', parts: [...part(improve.length ? 'Major accomplishments' : null, c.strengths), ...improve] },
    ];
  }
  return [
    { key: 'agenda', label: 'Agenda/Subjects Discussed', parts: part(null, c.summary) },
    { key: 'accomplishments', label: 'Major Accomplishments', parts: part(null, c.strengths) },
    { key: 'targets', label: 'Targets for Coming Period and/or Comments', parts: [...part(improve.length ? 'Targets' : null, c.goals_set), ...improve] },
  ];
}

export interface CounselingDocumentInput {
  id: string;
  version: number;
  stage: CounselingStage;
  revision: number;
  current_revision: number;
  own_notes: boolean;
  content: Partial<Record<CounselingField, string | null>>;
  particulars: CounselingParticulars;
  particulars_as_of: 'finalized' | 'now';
  finalized: { at: string | null; by: string | null };
  acknowledged_at: string | null;
  amendments: CounselingDocument['amendments'];
  amendments_total: number;
  superseded_at: string | null;
  marking: string;
  generated: { on: string; by: string };
}

export function counselingDocument(input: CounselingDocumentInput): CounselingDocument {
  const sheet = worksheetFor(input.particulars.subject.grade);
  const type = String(input.content.type || 'other');
  const notices = [
    'Documentation of a counseling session is for use only by the senior and the junior (NAVMC 2795, para 3005.1.i).',
    'No SSN is recorded or printed. The worksheet’s SSN block is left out on purpose.',
  ];
  if (input.own_notes) notices.unshift('The Marine’s own notes of a counseling. No counselor finalized or signed them in Vantage.');
  if (input.particulars_as_of === 'now' && !input.own_notes && input.stage === 'final') notices.push('Finalized before Vantage kept particulars: name, grade, MOS and billet are shown as they are now.');
  return {
    form: 'vantage-counseling/1',
    id: input.id,
    version: input.version,
    stage: input.stage,
    revision: input.revision,
    current_revision: input.current_revision,
    own_notes: input.own_notes,
    worksheet: { key: sheet, ...WORKSHEETS[sheet] },
    particulars: input.particulars,
    particulars_as_of: input.particulars_as_of,
    date: input.content.date ?? null,
    type,
    type_label: counselingTypeLabel(type),
    session_kind: sessionKindFor(type),
    follow_up_date: input.content.follow_up_date ?? null,
    blocks: worksheetBlocks(sheet, input.content),
    finalized: input.finalized,
    acknowledgement: { at: input.acknowledged_at, due: !input.own_notes && input.stage === 'final' && input.revision === input.current_revision && !input.acknowledged_at },
    amendments: input.amendments.slice(0, COUNSELING_LIMITS.history),
    amendments_total: input.amendments_total,
    superseded_at: input.superseded_at,
    marking: input.marking,
    generated: input.generated,
    source: `Counseling worksheet in the layout of NAVMC 2795, USMC User’s Guide to Counseling (21 Jul 86), Appendix A, ${WORKSHEETS[sheet].figure}. Not an official form; produced by Vantage from the structured record.`,
    notices,
  };
}

/** The band a worksheet carries when it is not the final, current text. */
export function documentBand(doc: Pick<CounselingDocument, 'stage' | 'revision' | 'current_revision' | 'superseded_at'>): string | null {
  if (doc.stage === 'draft') return 'DRAFT - NOT FINAL';
  if (doc.stage === 'review') return 'DRAFT FOR REVIEW - NOT FINAL';
  if (doc.revision < doc.current_revision) return `REVISION ${doc.revision} OF ${doc.current_revision} - REPLACED BY AN AMENDMENT${doc.superseded_at ? ` ON ${doc.superseded_at.slice(0, 10)}` : ''}`;
  if (doc.current_revision > 1) return `AMENDED - REVISION ${doc.current_revision}`;
  return null;
}
