/**
 * Course lookup (Task 22, ADR-0029): what a course code says, and where it was said.
 *
 * Vantage holds no course list of its own and fetches none. A Vantage Administrator registers an approved authoritative
 * source (with the authorization that approves it) and loads the catalog that source publishes. A course value on a
 * training is *verified* only when it equals what the current catalog of such a source lists for the training's course
 * code; any other value that is filled in is *manual*. The server works that out on every write; this file holds the
 * shared words, limits and the rule, so the form can show the same marks the server will store.
 *
 * Kept free of the validation library: the browser imports it (see shared/courseSchemas.ts for request bodies).
 */

/** The longest course code a training or a catalog holds, as a training requirement's (ADR-0012). */
export const COURSE_CODE_MAX = 40;
/** The most CEUs a training or a catalog entry holds. */
export const CEUS_MAX = 1000;
/** The most courses one catalog file may list. */
export const MAX_CATALOG_ROWS = 20_000;
/** The largest catalog file a Vantage Administrator may load, in bytes. */
export const MAX_CATALOG_BYTES = 10 * 1024 * 1024;
/** How long a staged catalog waits to be applied before it is discarded. */
export const STAGED_CATALOG_HOURS = 24;

/** The longest each catalog value may be. A longer one is not cut: its row is left out and said to be. */
export const CATALOG_LIMITS = { name: 300, provider: 200, description: 4000, category: 100, requirements: 2000, ranks: 500, mos: 500 } as const;

/** The values on a training that a catalog entry can verify, in the order they are shown. */
export const VERIFIABLE = ['code', 'title', 'provider', 'hours', 'ceus'] as const;
export type Verifiable = (typeof VERIFIABLE)[number];
export const VERIFIABLE_LABELS: Record<Verifiable, string> = { code: 'Course code', title: 'Title', provider: 'Provider', hours: 'Hours', ceus: 'CEUs' };
export const isVerifiable = (v: unknown): v is Verifiable => typeof v === 'string' && (VERIFIABLE as readonly string[]).includes(v);

// Characters a person never means to type into a code or a value: controls, zero-width and direction marks.
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

/** A course code as it is kept and shown: hidden characters out, runs of space as one, upper case. */
export function cleanCourseCode(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(HIDDEN, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** A course code as it is matched: letters and digits only, so "CDET 8010" and "cdet-8010" are the same course. */
export function courseKey(value: unknown): string {
  return cleanCourseCode(value).replace(/[^\p{L}\p{N}]/gu, '');
}

/** A one-line value as it is compared: hidden characters out, runs of space as one. Case is kept: it is the source's. */
export function cleanLine(value: unknown): string {
  return String(value ?? '').normalize('NFC').replace(HIDDEN, '').replace(/\s+/g, ' ').trim();
}

/** A longer value (a description, requirements): hidden characters out, line breaks kept, trailing space trimmed. */
export function cleanBlock(value: unknown): string {
  return String(value ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(HIDDEN, '').replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** One course as an approved source's current catalog lists it. */
export interface CourseEntry {
  entry_id: string;
  code: string;
  name: string;
  provider: string | null;
  description: string | null;
  hours: number | null;
  ceus: number | null;
  category: string | null;
  requirements: string | null;
  ranks: string | null;
  mos: string | null;
  source: { id: string; name: string; authority: string };
  /** The day the source's catalog was as of, as the Vantage Administrator who loaded it stated it. */
  as_of: string;
}

/** What a lookup answers: every current listing of the code, and how many approved sources have a catalog loaded. */
export interface CourseLookup {
  code: string;
  sources: number;
  matches: CourseEntry[];
}

/** What a training says of its course: the entry it was checked against, which of its values matched, and when. */
export interface CourseProvenance {
  entry: CourseEntry & {
    /** Set when the source has since been withdrawn: the values stay as they were verified, and say so. */
    withdrawn_at: string | null;
    withdrawn_reason: string | null;
    /** Set when a later catalog of the source replaced the one it was checked against. */
    superseded: boolean;
  };
  verified: Verifiable[];
  verified_at: string;
}

/** The values of a training the rule compares. */
export interface CourseValues { course_code?: unknown; title?: unknown; provider?: unknown; hours?: unknown; ceus?: unknown }

const sameText = (a: unknown, b: unknown) => { const x = cleanLine(a); return x !== '' && x === cleanLine(b); };
const sameNumber = (a: unknown, b: unknown) => {
  if (a === null || a === undefined || a === '' || b === null || b === undefined) return false;
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1e-9;
};

/**
 * Which of a training's values equal what a catalog entry lists: the rule the server stores and the form shows. The code
 * matches when it is the same course code; a text value when it reads the same once spacing is ignored (case is the
 * source's, so "sergeants course" is not "Sergeants Course"); a number when it is the same number. A value the entry does
 * not list is never verified.
 */
export function verifiedValues(values: CourseValues, entry: Pick<CourseEntry, 'code' | 'name' | 'provider' | 'hours' | 'ceus'>): Verifiable[] {
  if (!courseKey(values.course_code) || courseKey(values.course_code) !== courseKey(entry.code)) return [];
  const out: Verifiable[] = ['code'];
  if (sameText(values.title, entry.name)) out.push('title');
  if (entry.provider && sameText(values.provider, entry.provider)) out.push('provider');
  if (entry.hours != null && sameNumber(values.hours, entry.hours)) out.push('hours');
  if (entry.ceus != null && sameNumber(values.ceus, entry.ceus)) out.push('ceus');
  return out;
}

/**
 * The listing a training's values are verified against, of those its course code has in the catalogs in use: the one that
 * matches the most of them, the first (the newest catalog) when two match as many. The server stores it; the form shows it.
 */
export function bestListing<E extends Pick<CourseEntry, 'code' | 'name' | 'provider' | 'hours' | 'ceus'>>(values: CourseValues, listings: readonly E[]): { entry: E; verified: Verifiable[] } | null {
  let best: { entry: E; verified: Verifiable[] } | null = null;
  for (const entry of listings) {
    const verified = verifiedValues(values, entry);
    if (!best || verified.length > best.verified.length) best = { entry, verified };
  }
  return best;
}

/** Whether a value is filled in at all: a mark is shown only beside a value there is. */
export const filled = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== '';

/** "MarineNet course catalog (TECOM), catalog as of 2026-10-01" as a file or a page writes it. */
export const courseSourceLabel = (entry: Pick<CourseEntry, 'source' | 'as_of'>) => `${entry.source.name} (${entry.source.authority}), catalog as of ${entry.as_of}`;

// ——— The Vantage Administrator's side ———

/** An approved source as the console lists it. */
export interface CourseSourceRecord {
  id: string;
  name: string;
  authority: string;
  approval_reference: string;
  approved_by: string;
  approved_on: string;
  notes: string | null;
  recorded_by_name: string | null;
  recorded_at: string;
  withdrawn_at: string | null;
  withdrawn_by_name: string | null;
  withdrawn_reason: string | null;
  current: CatalogLoadRecord | null;
  staged: CatalogLoadRecord | null;
  /** Earlier catalogs, newest first: what trainings verified against them still name. */
  history: CatalogLoadRecord[];
}

export type CatalogLoadStatus = 'staged' | 'current' | 'superseded' | 'discarded';

/** A row of a catalog file that was left out, and why. */
export interface CatalogProblem { line: number; code: string | null; reason: string }

/** The values a catalog file can fill, and the column names Vantage reads for each (compared as letters and digits). */
export const CATALOG_FIELDS = ['code', 'name', 'provider', 'description', 'hours', 'ceus', 'category', 'requirements', 'ranks', 'mos'] as const;
export type CatalogField = (typeof CATALOG_FIELDS)[number];
export const CATALOG_FIELD_LABELS: Record<CatalogField, string> = {
  code: 'Course code', name: 'Name', provider: 'Provider', description: 'Description', hours: 'Hours', ceus: 'CEUs',
  category: 'Category', requirements: 'Requirements', ranks: 'Ranks', mos: 'MOS',
};
export const CATALOG_HEADERS: Record<CatalogField, string[]> = {
  code: ['coursecode', 'code', 'courseid', 'coursenumber', 'courseno'],
  name: ['name', 'coursename', 'title', 'coursetitle'],
  provider: ['provider', 'school', 'institution', 'offeredby', 'proponent'],
  description: ['description', 'coursedescription', 'summary'],
  hours: ['hours', 'coursehours', 'contacthours', 'lengthhours'],
  ceus: ['ceus', 'ceu', 'ceuvalue', 'continuingeducationunits'],
  category: ['category', 'coursecategory', 'coursetype'],
  requirements: ['requirements', 'prerequisites', 'prereqs', 'eligibility'],
  ranks: ['ranks', 'rank', 'grades', 'grade', 'rankapplicability', 'eligibleranks'],
  mos: ['mos', 'mosapplicability', 'eligiblemos', 'moss'],
};
/** A column header as it is compared with the names above. */
export const headerKey = (h: unknown) => String(h ?? '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

/** What a staged catalog would change, before it is applied. */
export interface CatalogPreview {
  /** Rows read, courses it lists, and rows left out. */
  rows: number;
  courses: number;
  left_out: number;
  /** Against the source's current catalog. With none, every course is added. */
  added: number;
  changed: number;
  unchanged: number;
  removed: number;
  /** The sheet read, for a workbook. */
  sheet: string | null;
  /** The file's columns Vantage read, by the value each fills, and the ones it did not use. */
  columns: Partial<Record<CatalogField, string>>;
  ignored_columns: string[];
  /** The first rows left out (at most 200), with their line in the file. */
  problems: CatalogProblem[];
  /** A few courses as they will read, for a last look. */
  sample: Array<Pick<CourseEntry, 'code' | 'name' | 'provider' | 'hours' | 'ceus' | 'category'>>;
}

export interface CatalogLoadRecord {
  id: string;
  status: CatalogLoadStatus;
  as_of: string;
  file_name: string;
  file_sha256: string;
  byte_size: number;
  courses: number;
  staged_by_name: string | null;
  staged_at: string;
  applied_by_name: string | null;
  applied_at: string | null;
  superseded_at: string | null;
  preview: CatalogPreview;
}
