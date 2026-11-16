/**
 * Drafts (ADR-0030). A draft lives with its own kind: a counseling not yet final, a report package with no revision yet,
 * correspondence written but not sent, an entry drawn from work and not yet kept, and the forms people save to finish
 * later (`form_drafts`). The Drafts page reads all of them for the person asking and stores nothing of its own.
 * What the browser and the server share about them is here.
 */
import { z } from 'zod';
import type { DraftKind } from './draftKinds.ts';

export { DRAFT_KINDS, DRAFT_KIND_LABELS, type DraftKind } from './draftKinds.ts';

/** The forms a person may save to finish later. Each is sent, when it is finished, through its kind's own route. */
export const FORM_DRAFT_KINDS = ['goal', 'award', 'training', 'task', 'personnel_change'] as const;
export type FormDraftKind = (typeof FORM_DRAFT_KINDS)[number];

/** Where each kind of draft is kept, which says how it is opened, finished and discarded. */
export type DraftSource = 'form' | 'entry' | 'counseling' | 'report' | 'correspondence';

/** A saved form is kept this many days after it was last saved, then removed, unless its author is under a legal hold. */
export const DRAFT_KEPT_DAYS = 90;
/** A report package worked on in this many days counts as waiting on its author; older ones are listed and not counted. */
export const DRAFT_ACTIVE_DAYS = 30;
/** A saved form this many days from being removed says so. */
export const DRAFT_WARN_DAYS = 14;
/** At most this many saved forms per person. */
export const DRAFT_LIMIT = 200;
/** A saved form's values, as JSON, at most this many bytes. */
export const DRAFT_PAYLOAD_BYTES = 32_768;
/** One value of a saved form, at most this many characters. The kind's own form decides the real limit when it is sent. */
export const DRAFT_TEXT_CHARS = 8_000;

/** The record table a saved form becomes, for the kinds that become a record. */
export const FORM_DRAFT_TABLE = { goal: 'goals', award: 'awards', training: 'trainings', task: 'tasks' } as const;
export type RecordDraftKind = keyof typeof FORM_DRAFT_TABLE;
export const kindOfTable = (table: string): RecordDraftKind | null =>
  (Object.entries(FORM_DRAFT_TABLE).find(([, t]) => t === table)?.[0] as RecordDraftKind | undefined) ?? null;

/** The fields of an assignment change a personnel change draft keeps (the assignment form's own). */
export const ASSIGNMENT_DRAFT_FIELDS = ['billet', 'billet_id', 'primary', 'assignment_start', 'assignment_end', 'supervisor_id', 'checked_in_on', 'reason'] as const;
export type AssignmentDraftField = (typeof ASSIGNMENT_DRAFT_FIELDS)[number];

/** One saved form, as its author reads it back. */
export interface FormDraft {
  id: string;
  kind: FormDraftKind;
  subject_id: string | null;
  /** The Marine it is about, as they were named when it was last saved. */
  subject_label: string | null;
  unit_id: string | null;
  title: string;
  payload: Record<string, unknown>;
  version: number;
  created_at: string;
  updated_at: string;
  kept_until: string;
  /** Whether its author may still send it: they may still act for its Marine in its unit. */
  can_submit: boolean;
  blocked: string | null;
}

/** A personnel change draft's values: the fields changed, what they were when it was saved, and the supervisor's name. */
export interface AssignmentDraftPayload {
  changes: Partial<Record<AssignmentDraftField, string | boolean | null>>;
  was: Partial<Record<AssignmentDraftField, string | boolean | null>>;
  supervisor_label?: string | null;
}

/** One line of the Drafts page: any draft of the person's, wherever it is kept. */
export interface DraftItem {
  key: string;
  id: string;
  source: DraftSource;
  kind: DraftKind;
  title: string;
  /** The Marine it is about, when that is not its author. */
  about: string | null;
  /** Their id, for the page that is about them. */
  subject_id: string | null;
  /** The page it belongs to, by name. */
  place: string;
  /** Where it opens to be finished. */
  href: string;
  /** Who else can read it now. */
  readers: string;
  updated_at: string;
  /** When a saved form is removed if it is not saved again; null for the kinds kept until finished. */
  kept_until: string | null;
  can_submit: boolean;
  blocked: string | null;
  /** Whether it can be discarded from the Drafts page; the rest are discarded where they are kept. */
  discardable: boolean;
  /**
   * Whether it is waiting on its author, which is what the menu's count counts. A counseling shared with its Marine to
   * review is waiting on the Marine, and a report package nobody has worked on in DRAFT_ACTIVE_DAYS is listed, not counted.
   */
  waiting: boolean;
}

export interface DraftsResponse {
  items: DraftItem[];
  /** Every draft listed, by kind. */
  counts: Partial<Record<DraftKind, number>>;
  /** Every draft listed. */
  total: number;
  /** Those waiting on the person, every one of them, listed or not: the menu's count, and the record overview's. */
  waiting: number;
  /** Whether a kind has more than the newest SOURCE_LIMIT, which are all that are listed. */
  more: boolean;
  kept_days: number;
  limit: number;
  /** Saved forms the person has, against the limit. */
  saved: number;
}

const kind = z.enum(FORM_DRAFT_KINDS);
const payload = z.record(z.string().max(64), z.unknown());

export const formDraftCreateSchema = z.object({
  kind,
  subject_id: z.string().min(1).max(64).nullish(),
  unit_id: z.string().min(1).max(64).nullish(),
  payload,
});

export const formDraftUpdateSchema = z.object({
  payload,
  version: z.number().int().min(1),
});

/** "Kept until 12 Feb" from when it was last saved. */
export const keptUntil = (updatedAt: string) => new Date(new Date(updatedAt).getTime() + DRAFT_KEPT_DAYS * 86_400_000).toISOString();
