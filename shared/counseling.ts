import type { COUNSELING_TYPES } from './constants.ts';

/**
 * Counseling as structured data (VANTAGE_CLAUDE_MASTER Task 20, ADR-0027). A counseling a leader writes for a Marine is
 * drafted, may be shared with that Marine to review, is finalized, and from then on changes only by an amendment that
 * keeps what it replaced. Its Marine acknowledges the text as it stands. A Marine's own counseling notes stay as they
 * were: theirs to write and correct, always final.
 *
 * Who may do what is one rule (`counselingOptions`), which the server enforces and sends with each counseling, so a page
 * offers exactly what will be accepted. The printable COUNSELING WORKSHEET is one document (`CounselingDocument`), built by the
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
// The counseling worksheet. Marines counsel on a one-page COUNSELING WORKSHEET whose references line cites NAVMC 2795 (the
// USMC User's Guide to Counseling), MCI 8002, MCI 7104, the IRAM and MCO P1610.7E (PES): A. Administrative information,
// B. Billet title, C. Major accomplishments/significant events, D. Evaluation of performance this period, E. Tasks
// assigned next period, F. Additional comments and G. Certification. Vantage draws that form box for box, from the copy
// John supplied on 2026-11-17 (ADR-0033), with the section bars in upright type. It replaces Task 20's look-alike of the
// guide's Appendix A figures, which was not the form in use.
//
// Every box Vantage fills, it fills from the stored record. A box it has nothing for (date of rank, billet MOS, the start
// of the period covered, the signature dates, and anything else the record does not hold) is left blank for the reader:
// on paper to write in, and in the PDF a form field to type into after downloading.
//
// The two EDIPI boxes print each person's EDIPI from their own Vantage profile: the one their CAC proved, or the one they
// typed for their forms (`users.form_edipi`, never a sign-in credential). Only the Marine and the counselor are given
// them, as the paper form is theirs alone (NAVMC 2795 para 3005.1.i). The counseling record never stores either one.
// ---------------------------------------------------------------------------------------------------------------------

export const WORKSHEET_TITLE = 'COUNSELING WORKSHEET';
export const WORKSHEET_REFERENCES = 'References:  NAVMC 2795 (Guide to Counseling), MCI 8002, MCI 7104, IRAM, MCO P1610.7E (PES)';
/** The form's ID box: what it is called, and its length (an EDIPI, the DoD ID number on a CAC, is ten digits). */
export const WORKSHEET_ID = { label: 'EDIPI', maxLength: 10 } as const;
export const EDIPI_PATTERN = /^\d{10}$/;
/**
 * The form's eight columns, as parts of its width, measured from the form: Last Name, First Name, MI, EDIPI, Rank, DOR,
 * PMOS and BILMOS. Every other box lines up with them (Occasion runs to DOR, the period and the billet start at it).
 */
export const WORKSHEET_COLUMNS = [158, 130, 31, 104, 60, 98, 55, 82] as const;

/** Who the worksheet is about and who counseled, as of its finalization (or as they are now, on a draft or a counseling from before 035). */
export interface CounselingParticulars {
  subject: {
    name: string; rank: string | null; grade: string | null; mos: string | null; billet: string | null; unit: string | null;
    /** The name as the form's three boxes take it. Kept from 2026-11-17; earlier particulars hold only `name` ("Last, First M"). */
    last_name?: string | null; first_name?: string | null; middle_initial?: string | null;
  };
  counselor: { name: string; rank: string | null; last_name?: string | null; first_name?: string | null; middle_initial?: string | null; billet?: string | null } | null;
}

/**
 * One box of the form. Its label lines sit above the value; a row's caption ("Marine Reported On:") is the first line of
 * its first box. `cols` is the columns it spans, [first, last + 1). A box with `fill` is one Vantage leaves blank for the
 * reader, and `fill.field` names the PDF form field it becomes. A box with `pii` holds an EDIPI: the screen masks it.
 */
export interface WorksheetBox {
  key: string;
  label: string[];
  value: string;
  cols: [number, number];
  pii?: boolean;
  fill?: { field: string; maxLength?: number; tooltip: string };
}
export type WorksheetSectionKey = 'accomplishments' | 'evaluation' | 'tasks' | 'comments';
export interface WorksheetSection { key: WorksheetSectionKey; heading: string; parts: Array<{ label: string | null; text: string }> }
export interface WorksheetSignature { key: string; label: string; date: WorksheetBox }
/** The form, as the preview, the print page and the PDF all draw it. */
export interface CounselingWorksheet {
  title: string;
  references: string;
  admin: { heading: string; rows: WorksheetBox[][] };
  billet: { heading: string; note: string; box: WorksheetBox };
  sections: WorksheetSection[];
  certification: { heading: string; rows: WorksheetSignature[] };
}

/** Which EDIPI box is whose, and which the reader may fill from their own profile. */
export type EdipiBox = 'reported' | 'senior';
export interface CounselingEdipi {
  /** The EDIPI each box prints, given only to the Marine and the counselor; null when it is not on that person's profile. */
  reported: string | null;
  senior: string | null;
  /** The box that is the reader's own, when the reader is the Marine or the counselor (both, on a Marine's own notes). */
  yours: EdipiBox | null;
}

/** The one structured document a counseling prints as: the preview, the print page and the PDF all draw it. */
export interface CounselingDocument {
  form: 'vantage-counseling/2';
  id: string;
  version: number;
  stage: CounselingStage;
  /** The revision drawn, and the counseling's current one: an earlier revision is drawn from what it replaced. */
  revision: number;
  current_revision: number;
  /** A Marine's own counseling notes: no counselor signed them in Vantage. */
  own_notes: boolean;
  worksheet: CounselingWorksheet;
  particulars: CounselingParticulars;
  /** Whether the particulars are as they stood at finalization, or as they are now. */
  particulars_as_of: 'finalized' | 'now';
  /** Whether each EDIPI box is printed, and which is the reader's own. Never the numbers: those are in the boxes. */
  edipi: { reported: boolean; senior: boolean; yours: EdipiBox | null };
  date: string | null;
  type: string;
  type_label: string;
  follow_up_date: string | null;
  finalized: { at: string | null; by: string | null };
  acknowledgement: { at: string | null; due: boolean };
  /** Amendments, newest first, capped at COUNSELING_LIMITS.history. */
  amendments: Array<{ revision: number; at: string; by: string | null; reason: string; changed: string[]; acknowledged_at: string | null }>;
  amendments_total: number;
  /** When this revision was replaced, for an earlier one. */
  superseded_at: string | null;
  marking: string;
  /** When, by whom, and in which time zone: the worksheet's dates are days there, as its "generated on" is. */
  generated: { on: string; by: string; zone?: string };
  source: string;
  notices: string[];
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const part = (label: string | null, text: unknown) => (nonEmpty(text) ? [{ label, text: text.trim() }] : []);

/** A day as the form writes it: YYYYMMDD. */
export const formDay = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10).replace(/-/g, '') : '');

// Marine Corps rank abbreviations (server/db/ranks.ts), longest first where one starts another.
const RANK_ABBRS = ['SgtMaj', 'MGySgt', 'GySgt', 'SSgt', 'MSgt', '1stSgt', 'SMMC', 'Sgt', 'LCpl', 'Cpl', 'PFC', 'Pvt', 'CWO2', 'CWO3', 'CWO4', 'CWO5', 'WO',
  '2ndLt', '1stLt', 'Capt', 'LtCol', 'MajGen', 'LtGen', 'BGen', 'Maj', 'Col', 'Gen'];
const LEADING_RANK = new RegExp(`^(${RANK_ABBRS.join('|')})\\.?\\s+(\\S.*)$`, 'i');

/**
 * A counselor typed in by hand often starts with their rank ("Sgt Juandiego, Luis"): it goes in the Rank box, and the
 * rest is the name. Anything else is left as typed.
 */
export function leadingRank(typed: string): { rank: string | null; name: string } {
  const m = LEADING_RANK.exec(typed.trim());
  if (!m) return { rank: null, name: typed.trim() };
  return { rank: RANK_ABBRS.find((r) => r.toLowerCase() === m[1].toLowerCase()) ?? m[1], name: m[2].trim() };
}

/**
 * A name as the form's three boxes take it. Particulars kept before 2026-11-17 hold only "Last, First M"; a counselor
 * typed in by hand with no comma goes whole in the last-name box rather than be guessed at.
 */
export function nameParts(p: { name: string; last_name?: string | null; first_name?: string | null; middle_initial?: string | null }): { last: string; first: string; mi: string } {
  if (p.last_name != null || p.first_name != null) return { last: p.last_name ?? '', first: p.first_name ?? '', mi: p.middle_initial ?? '' };
  const comma = p.name.indexOf(', ');
  if (comma < 0) return { last: p.name, first: '', mi: '' };
  const rest = p.name.slice(comma + 2).trim().split(/\s+/).filter(Boolean);
  const mi = rest.length > 1 && /^[A-Za-z]\.?$/.test(rest[rest.length - 1]) ? rest.pop()!.replace('.', '') : '';
  return { last: p.name.slice(0, comma), first: rest.join(' '), mi };
}

/** Each Vantage field placed where the form asks for it. "Areas to improve" is part of the evaluation, labelled. */
export function worksheetSections(c: Partial<Record<CounselingField, string | null>>): WorksheetSection[] {
  const next = formDay(c.follow_up_date);
  return [
    { key: 'accomplishments', heading: 'C. MAJOR ACCOMPLISHMENTS/SIGNIFICANT EVENTS', parts: part(null, c.strengths) },
    { key: 'evaluation', heading: 'D. EVALUATION OF PERFORMANCE THIS PERIOD', parts: [...part(null, c.summary), ...part('Areas to improve', c.improvements)] },
    { key: 'tasks', heading: 'E. TASKS ASSIGNED NEXT PERIOD', parts: part(null, c.goals_set) },
    { key: 'comments', heading: 'F. ADDITIONAL COMMENTS', parts: next ? [{ label: null, text: `Target date for next counseling: ${next}.` }] : [] },
  ];
}

/** The form for one counseling: what goes in each box, and which boxes are left for the reader. */
export function counselingWorksheet(input: { particulars: CounselingParticulars; content: Partial<Record<CounselingField, string | null>>; type_label: string; edipi: CounselingEdipi }): CounselingWorksheet {
  const s = input.particulars.subject;
  const c = input.particulars.counselor;
  const up = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();
  const you = nameParts(s);
  // A counselor with no Vantage account is only the name typed for them, rank and all.
  const typed = c && c.rank == null && c.last_name == null && c.first_name == null ? leadingRank(c.name) : null;
  const senior = c ? nameParts(typed ? { name: typed.name } : c) : { last: '', first: '', mi: '' };
  const seniorRank = c?.rank ?? typed?.rank ?? null;
  // A box Vantage has nothing for is the reader's: its key names the PDF field, and its tooltip says so.
  const box = (key: string, label: string[], value: string, cols: [number, number], maxLength?: number): WorksheetBox => (value
    ? { key, label, value, cols }
    : { key, label, value: '', cols, fill: { field: key, maxLength, tooltip: `${label[label.length - 1]}: left blank by Vantage, to fill in.` } });
  const id = (key: string, label: string[], value: string | null): WorksheetBox => (value
    ? { key, label, value, cols: [3, 4], pii: true }
    : { key, label, value: '', cols: [3, 4], fill: { field: key, maxLength: WORKSHEET_ID.maxLength, tooltip: `${WORKSHEET_ID.label}: not on this person's Vantage profile. Type it here; once filled in, this file holds PII.` } });
  return {
    title: WORKSHEET_TITLE,
    references: WORKSHEET_REFERENCES,
    admin: {
      heading: 'A. ADMINISTRATIVE INFORMATION',
      rows: [
        [
          box('reported_last', ['Marine Reported On:', 'Last Name'], up(you.last), [0, 1]),
          box('reported_first', ['First Name'], up(you.first), [1, 2]),
          box('reported_mi', ['MI'], up(you.mi), [2, 3], 1),
          id('reported_edipi', [WORKSHEET_ID.label], input.edipi.reported),
          box('reported_rank', ['Rank'], up(s.rank), [4, 5]),
          box('reported_dor', ['DOR'], '', [5, 6], 8),
          box('reported_pmos', ['PMOS'], up(s.mos), [6, 7], 4),
          box('reported_bilmos', ['BILMOS'], '', [7, 8], 4),
        ],
        [
          box('occasion', ['Occasion:', '(Initial, scheduled, event related, etc.)'], up(input.type_label), [0, 5]),
          box('period_from', ['Period Covered:', 'From'], '', [5, 6], 8),
          box('period_to', ['To'], formDay(input.content.date), [6, 8], 8),
        ],
        [
          box('senior_last', ['Marine Performing Counseling (Reporting Senior)', 'Last Name'], up(senior.last), [0, 1]),
          box('senior_first', ['First Name'], up(senior.first), [1, 2]),
          box('senior_mi', ['MI'], up(senior.mi), [2, 3], 1),
          id('senior_edipi', [WORKSHEET_ID.label], input.edipi.senior),
          box('senior_rank', ['Rank'], up(seniorRank), [4, 5]),
          box('senior_billet', ['Billet'], up(c?.billet), [5, 8]),
        ],
      ],
    },
    billet: { heading: 'B. BILLET TITLE', note: '(description if required)', box: box('billet_title', ['Billet Title'], up(s.billet), [0, 8]) },
    sections: worksheetSections(input.content),
    certification: {
      heading: 'G. CERTIFICATION',
      rows: [
        { key: 'senior_signature', label: 'Signature of Marine Performing Counseling (Reporting Senior)', date: box('senior_signed', ['Date'], '', [5, 8], 8) },
        { key: 'reported_signature', label: 'Signature of Marine Reported On', date: box('reported_signed', ['Date'], '', [5, 8], 8) },
      ],
    },
  };
}

/** The boxes Vantage leaves for the reader, in the order the form has them. */
export const worksheetFills = (w: CounselingWorksheet): WorksheetBox[] =>
  [...w.admin.rows.flat(), w.billet.box, ...w.certification.rows.map((r) => r.date)].filter((b) => b.fill);

/** An EDIPI as a screen shows it: only its last four digits. The print page and the PDF print it whole. */
export const maskEdipi = (v: string) => (v.length > 4 ? `••••••${v.slice(-4)}` : v);

export const EDIPI_NOTICE = `Each ${WORKSHEET_ID.label} box prints that person's ${WORKSHEET_ID.label} from their own Vantage profile, on the copy for the Marine and the counselor only. One left blank is not on that person's profile: they add it there, or type it into the downloaded PDF or write it on the printed copy. With an ${WORKSHEET_ID.label} on it, this file or paper holds PII and is handled as such.`;
export const BLANKS_NOTICE = 'Boxes Vantage does not hold (date of rank, billet MOS, the start of the period covered, the signature dates, and anything else left empty) are blank to fill in, in the PDF or by hand.';

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
  edipi: CounselingEdipi;
  finalized: { at: string | null; by: string | null };
  acknowledged_at: string | null;
  amendments: CounselingDocument['amendments'];
  amendments_total: number;
  superseded_at: string | null;
  marking: string;
  generated: { on: string; by: string; zone?: string };
}

export function counselingDocument(input: CounselingDocumentInput): CounselingDocument {
  const type = String(input.content.type || 'other');
  const type_label = counselingTypeLabel(type);
  const notices = [
    'Documentation of a counseling session is for use only by the senior and the junior (NAVMC 2795, para 3005.1.i).',
    EDIPI_NOTICE,
    BLANKS_NOTICE,
  ];
  if (input.own_notes) notices.unshift('The Marine’s own notes of a counseling. No counselor finalized or signed them in Vantage.');
  if (input.particulars_as_of === 'now' && !input.own_notes && input.stage === 'final') notices.push('Finalized before Vantage kept particulars: name, grade, MOS and billet are shown as they are now.');
  return {
    form: 'vantage-counseling/2',
    id: input.id,
    version: input.version,
    stage: input.stage,
    revision: input.revision,
    current_revision: input.current_revision,
    own_notes: input.own_notes,
    worksheet: counselingWorksheet({ particulars: input.particulars, content: input.content, type_label, edipi: input.edipi }),
    particulars: input.particulars,
    particulars_as_of: input.particulars_as_of,
    edipi: { reported: Boolean(input.edipi.reported), senior: Boolean(input.edipi.senior), yours: input.edipi.yours },
    date: input.content.date ?? null,
    type,
    type_label,
    follow_up_date: input.content.follow_up_date ?? null,
    finalized: input.finalized,
    acknowledgement: { at: input.acknowledged_at, due: !input.own_notes && input.stage === 'final' && input.revision === input.current_revision && !input.acknowledged_at },
    amendments: input.amendments.slice(0, COUNSELING_LIMITS.history),
    amendments_total: input.amendments_total,
    superseded_at: input.superseded_at,
    marking: input.marking,
    generated: input.generated,
    source: `${WORKSHEET_TITLE} (${WORKSHEET_REFERENCES.replace(/^References:\s+/, 'references ')}), drawn box for box by Vantage from the structured counseling record.`,
    notices,
  };
}

/** The calendar day of a stamp in the zone the worksheet was generated in, so its dates and its "generated on" agree. */
export function dayOf(iso: string, zone?: string | null): string {
  if (!zone) return iso.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
    const part = (t: string) => parts.find((p) => p.type === t)?.value;
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : iso.slice(0, 10);
  } catch { return iso.slice(0, 10); }
}

export const personLine = (p: { name: string; rank: string | null } | null) => (p ? `${p.rank ? `${p.rank} ` : ''}${p.name}` : '');

/** Where the counseling stands in Vantage, said beside the form's two signature lines (the form's own lines stay blank to sign). */
export function signatureNotes(doc: Pick<CounselingDocument, 'own_notes' | 'stage' | 'acknowledgement' | 'finalized'> & { generated?: { zone?: string } }): { subject: string; counselor: string } {
  const zone = doc.generated?.zone;
  const subject = doc.own_notes ? 'The Marine’s own notes: nothing to acknowledge in Vantage.'
    : doc.acknowledgement.at ? `Acknowledged in Vantage on ${dayOf(doc.acknowledgement.at, zone)}: confirms the Marine read it, not that they agree.`
      : doc.stage === 'final' ? 'Not yet acknowledged in Vantage.' : 'Acknowledged once it is final.';
  const counselor = doc.own_notes ? 'Recorded by the Marine. No counselor finalized it in Vantage.'
    : doc.finalized.at ? `Finalized in Vantage on ${dayOf(doc.finalized.at, zone)}${doc.finalized.by ? ` by ${doc.finalized.by}` : ''}.`
      : doc.stage === 'final' ? 'Recorded in Vantage before finalization was kept.' : 'Not yet finalized.';
  return { subject, counselor };
}

/** One amendment's line on the worksheet: which revision, when, who, and what it changed. */
export const amendmentLine = (a: CounselingDocument['amendments'][number], zone?: string) =>
  `Revision ${a.revision} · ${dayOf(a.at, zone)}${a.by ? ` · ${a.by}` : ''} · changed ${a.changed.join(', ') || 'nothing'}${a.acknowledged_at ? ` · replaced text the Marine acknowledged on ${dayOf(a.acknowledged_at, zone)}` : ''}`;

/** The band a worksheet carries when it is not the final, current text. */
export function documentBand(doc: Pick<CounselingDocument, 'stage' | 'revision' | 'current_revision' | 'superseded_at'> & { generated?: { zone?: string } }): string | null {
  if (doc.stage === 'draft') return 'DRAFT - NOT FINAL';
  if (doc.stage === 'review') return 'DRAFT FOR REVIEW - NOT FINAL';
  if (doc.revision < doc.current_revision) return `REVISION ${doc.revision} OF ${doc.current_revision} - REPLACED BY AN AMENDMENT${doc.superseded_at ? ` ON ${dayOf(doc.superseded_at, doc.generated?.zone)}` : ''}`;
  if (doc.current_revision > 1) return `AMENDED - REVISION ${doc.current_revision}`;
  return null;
}
