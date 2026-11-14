/**
 * Course lookup and what a training's course values are verified by (Task 22, ADR-0029).
 *
 * A course code is looked up only in the current catalogs of approved sources that are not withdrawn
 * (courseCatalog.ts loads them). Vantage fetches nothing from anywhere. Whether a training's values are verified is
 * worked out here, on every write that could change it (a new training, an edit, a move into Training, an import), from
 * what the training holds and what the catalogs list: never from a request or a file. Anything filled in that a current
 * catalog does not list is manual.
 */
import type { AppContext } from '../context.ts';
import { now } from '../lib/ids.ts';
import { bestListing, cleanCourseCode, courseKey, isVerifiable, sameCourseInputs, type CourseEntry, type CourseLookup, type CourseProvenance, type CourseValues, type Verifiable } from '../../shared/courses.ts';

interface EntryRow {
  id: string; load_id: string; code: string; code_key: string; name: string; provider: string | null; description: string | null;
  hours: number | null; ceus: number | null; category: string | null; requirements: string | null; ranks: string | null; mos: string | null;
  as_of: string; applied_at: string | null; load_status: string; source_id: string; source_name: string; source_authority: string;
  withdrawn_at: string | null; withdrawn_reason: string | null;
}

/** A catalog entry with its catalog and source, as a lookup, a training and the console's browsing read it. */
export const ENTRY_SELECT = `SELECT e.id, e.load_id, e.code, e.code_key, e.name, e.provider, e.description, e.hours, e.ceus, e.category, e.requirements, e.ranks, e.mos,
    l.as_of, l.applied_at, l.status AS load_status, s.id AS source_id, s.name AS source_name, s.authority AS source_authority, s.withdrawn_at, s.withdrawn_reason
  FROM course_catalog_entries e JOIN course_catalog_loads l ON l.id = e.load_id JOIN course_sources s ON s.id = l.source_id`;

export const entryOf = (r: EntryRow): CourseEntry => ({
  entry_id: r.id, code: r.code, name: r.name, provider: r.provider, description: r.description, hours: r.hours, ceus: r.ceus,
  category: r.category, requirements: r.requirements, ranks: r.ranks, mos: r.mos,
  source: { id: r.source_id, name: r.source_name, authority: r.source_authority }, as_of: r.as_of,
});

/**
 * Every current listing of a course code: one per approved source whose applied catalog lists it, the newest catalog
 * first. A staged, superseded or discarded catalog answers nothing, and neither does a withdrawn source.
 */
export function currentListings(ctx: AppContext, code: unknown): EntryRow[] {
  const key = courseKey(code);
  if (!key) return [];
  return ctx.db.prepare(`${ENTRY_SELECT} WHERE e.code_key = ? AND l.status = 'current' AND s.withdrawn_at IS NULL ORDER BY l.as_of DESC, l.applied_at DESC, s.name, s.id`).all(key) as EntryRow[];
}

/** How many approved sources answer lookups now: not withdrawn, with a catalog applied. */
export function sourcesAnswering(ctx: AppContext): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM course_catalog_loads l JOIN course_sources s ON s.id = l.source_id WHERE l.status = 'current' AND s.withdrawn_at IS NULL`).get() as { n: number }).n;
}

/** What a course code is listed as, for anyone signed in: course details are no one's record, and hold no one's name. */
export function lookupCourse(ctx: AppContext, code: string): CourseLookup {
  return { code: cleanCourseCode(code), sources: sourcesAnswering(ctx), matches: currentListings(ctx, code).map(entryOf) };
}

export interface CourseColumns { course_entry_id: string | null; course_verified: string | null; course_verified_at: string | null }
const NONE: CourseColumns = { course_entry_id: null, course_verified: null, course_verified_at: null };

/**
 * What a training's values are verified by, as the columns that keep it: the current listing of its course code that
 * matches the most of its values (the newest catalog when two match as many), which of them match, and now. No course
 * code, or no current listing of it, and nothing is verified.
 */
export function courseColumns(ctx: AppContext, record: CourseValues | Record<string, unknown>): CourseColumns {
  const values = record as CourseValues;
  // An anonymized training is verified against nothing (bestListing): a listing's name and provider would stand beside
  // its redacted title and say what it was (ADR-0029 §5). Its owner typing a title again is a new value, and is checked as one.
  const best = bestListing(values, currentListings(ctx, values.course_code).map(entryOf));
  return best ? { course_entry_id: best.entry.entry_id, course_verified: JSON.stringify(best.verified), course_verified_at: now() } : NONE;
}

/**
 * Whether an edit is checked against the catalogs again: when it changes the course code or a value a catalog can verify,
 * or when the training has a course code and nothing verified yet (its values may have been typed before a catalog was
 * loaded). An edit that changes neither keeps what was verified, and when: a course's hours as the catalog listed them the
 * day it was checked stay verified as of that day, even after a later catalog lists other hours.
 */
export function rechecksCourse(row: Record<string, unknown>, data: Record<string, unknown>): boolean {
  const after = { ...row, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
  return !sameCourseInputs(row, after) || (Boolean(after.course_code) && !row.course_entry_id);
}

/** The verified list as it is stored: a JSON list, or one hydrate already read. Anything else verifies nothing. */
export function verifiedList(value: unknown): Verifiable[] {
  let list: unknown = value;
  if (typeof value === 'string') { try { list = JSON.parse(value); } catch { list = []; } }
  return Array.isArray(list) ? list.filter(isVerifiable) : [];
}

/**
 * Each training as it is read, with what its course values were verified against: the catalog entry and its source,
 * whether that catalog has since been replaced, and whether the source has since been withdrawn. One lookup for the page.
 */
export function withCourseDetail<T extends Record<string, unknown>>(ctx: AppContext, rows: T[]): Array<T & { course?: CourseProvenance }> {
  const ids = [...new Set(rows.map((r) => r.course_entry_id).filter((id): id is string => typeof id === 'string' && Boolean(id)))];
  if (!ids.length) return rows;
  const found = new Map((ctx.db.prepare(`${ENTRY_SELECT} WHERE e.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as EntryRow[]).map((e) => [e.id, e]));
  return rows.map((r) => {
    const e = typeof r.course_entry_id === 'string' ? found.get(r.course_entry_id) : undefined;
    if (!e) return r;
    const course: CourseProvenance = {
      entry: { ...entryOf(e), withdrawn_at: e.withdrawn_at, withdrawn_reason: e.withdrawn_reason, superseded: e.load_status !== 'current' },
      verified: verifiedList(r.course_verified),
      verified_at: String(r.course_verified_at || ''),
    };
    return { ...r, course };
  });
}
