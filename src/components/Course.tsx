import { useEffect, useState } from 'react';
import { BadgeCheck, PenLine } from 'lucide-react';
import { Badge, Button } from '@/components/ui/primitives';
import { DescriptionList } from '@/components/common';
import * as api from '@/lib/api';
import { formatStamp } from '@/lib/utils';
import { formatNumber } from '../../shared/metrics';
import {
  VERIFIABLE, bestListing, courseKey, courseSourceLabel, filled, sameCourseInputs, verifiedWords,
  type CourseEntry, type CourseLookup, type CourseProvenance, type CourseValues, type Verifiable,
} from '../../shared/courses';

/**
 * A training's course (Task 22, ADR-0029): the course code looked up in the approved catalogs in use, the values a listing
 * gives, and, beside each value, whether it is what the catalog lists (verified) or what the person entered (manual).
 * The marks here are the same rule the server applies when the training is saved (shared/courses.ts verifiedValues): the
 * server decides, from the catalogs in use, and nothing the form sends can say a value is verified.
 */

/** The values of a training a catalog verifies, under the names the form keeps them; on an edit, what it held when opened. */
export interface CourseDraft { course_code: string; title: string; provider: string; hours: number | string; ceus: number | string; saved_course?: SavedCourse }
/** What a saved training held of its course, and what it says was verified: an edit that keeps those values keeps that. */
export interface SavedCourse { values: CourseValues; course: CourseProvenance | null }

export type Lookup = { code: string; state: 'idle' | 'looking' | 'done' | 'failed'; result: CourseLookup | null; error?: string };

/** The catalogs' listings of the code typed, looked up a moment after typing stops. Vantage fetches nothing to answer. */
export function useCourseLookup(code: string): Lookup {
  const key = courseKey(code);
  const [state, setState] = useState<Lookup>({ code: '', state: 'idle', result: null });
  useEffect(() => {
    if (key.length < 2) { setState({ code: '', state: 'idle', result: null }); return; }
    // What was found for the code before is not shown for this one while it is looked up.
    setState({ code, state: 'looking', result: null });
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      api.lookupCourse(code, ctl.signal)
        .then((result) => setState({ code, state: 'done', result }))
        .catch((e) => { if (!ctl.signal.aborted) setState({ code, state: 'failed', result: null, error: api.errorText(e) }); });
    }, 400);
    return () => { window.clearTimeout(timer); ctl.abort(); };
    // Looked up again only when the course it names changes, not on every change of spacing or case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

const valuesOf = (d: CourseDraft): CourseValues => ({ course_code: d.course_code, title: d.title, provider: d.provider, hours: d.hours, ceus: d.ceus });
/** "1 hour", "2 courses". */
const count = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** The listing the server would verify against: the one that matches the most values, the newest catalog first. */
export const bestMatch = (d: CourseDraft, matches: CourseEntry[]) => bestListing(valuesOf(d), matches);

/**
 * What the form marks as verified, as the server would store it on saving. An edit that changes no course value of a
 * training something was verified for keeps what was verified (`kept`), whatever the catalogs in use list now. Otherwise
 * what the catalogs in use would verify, once the code typed has been looked up; with no code, nothing; while the code is
 * being looked up, or the lookup failed, it is not known (null), and no value is marked.
 */
export function courseMarks(d: CourseDraft, lookup: Lookup): { verified: Verifiable[] | null; kept: CourseProvenance | null } {
  const saved = d.saved_course;
  if (saved?.course && sameCourseInputs(saved.values, valuesOf(d))) return { verified: saved.course.verified, kept: saved.course };
  if (lookup.state === 'idle') return { verified: [], kept: null };
  if (lookup.state === 'done' && lookup.result && courseKey(lookup.code) === courseKey(d.course_code)) return { verified: bestMatch(d, lookup.result.matches)?.verified ?? [], kept: null };
  return { verified: null, kept: null };
}

/** "Verified" or "Manual" beside a value that is filled in, as a field label shows it; nothing while that is not known. */
export function CourseMark({ field, value, verified }: { field: Verifiable; value: unknown; verified: Verifiable[] | null }) {
  if (!filled(value) || verified === null) return null;
  const ok = verified.includes(field);
  // Read with the field's label: "Title Verified", "Provider Manual".
  return (
    <>{' '}<Badge tone={ok ? 'good' : 'neutral'} className="ml-1 gap-1 align-middle text-2xs">
      {ok ? <BadgeCheck className="h-3 w-3" aria-hidden /> : <PenLine className="h-3 w-3" aria-hidden />}{ok ? 'Verified' : 'Manual'}
    </Badge></>
  );
}

/** Saved with its course values as they are, a training keeps what was verified: said instead of a guess from the catalogs in use. */
function KeptNote({ kept }: { kept: CourseProvenance }) {
  const since = kept.entry.withdrawn_at ? ' That source has since been withdrawn.' : kept.entry.superseded ? ' A later catalog has replaced that one since.' : '';
  return (
    <p className="text-xs text-ink-3">
      These course values are as they were saved, so saving keeps what was verified against {courseSourceLabel(kept.entry)}, {formatStamp(kept.verified_at)}: {verifiedWords(kept.verified)}.{since} Changing the course code or one of these values checks it against the catalogs in use.
    </p>
  );
}

/** What a lookup found, under the course code field: each listing, and a button that fills the form from it. */
export function CourseLookupPanel({ d, lookup, onUse, kept = null }: { d: CourseDraft; lookup: Lookup; onUse: (entry: CourseEntry) => void; kept?: CourseProvenance | null }) {
  const note = kept ? <KeptNote kept={kept} /> : null;
  if (lookup.state === 'idle') return note ?? <p className="text-xs text-ink-3">Enter the course code to look it up in the approved catalogs. Without one, every value is kept as entered (manual).</p>;
  const current = lookup.state === 'done' && courseKey(lookup.code) === courseKey(d.course_code);
  if (lookup.state === 'failed') return <div className="space-y-1">{note}<p className="text-xs text-bad" role="alert">{lookup.error} Vantage checks the course code again when it saves.</p></div>;
  if (!current || !lookup.result) return <div className="space-y-1">{note}<p className="text-xs text-ink-3" role="status">Looking up {d.course_code.trim()}…</p></div>;
  const r = lookup.result;
  if (!r.sources) return <div className="space-y-1">{note}<p className="text-xs text-ink-3" role="status">No approved course source has a catalog in use, so nothing can be verified now.{kept ? '' : ' What you enter is kept as manual.'}</p></div>;
  if (!r.matches.length) return <div className="space-y-1">{note}<p className="text-xs text-ink-3" role="status">No approved catalog lists {r.code}.{kept ? '' : ' What you enter is kept as manual.'}</p></div>;
  const best = bestMatch(d, r.matches);
  const would = !best || !best.verified.length ? 'nothing would be verified' : best.verified.length === 1 ? `only the ${verifiedWords(best.verified)} would be verified` : `${verifiedWords(best.verified)} would be verified`;
  return (
    <div className="space-y-2" role="status">
      {r.matches.map((m) => (
        <div key={m.entry_id} className="rounded border border-line px-3 py-2 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-ink">{m.code} · {m.name}</p>
              <p className="text-xs text-ink-3">{[m.provider, m.hours != null ? count(m.hours, 'hour') : null, m.ceus != null ? count(m.ceus, 'CEU') : null, m.category].filter(Boolean).join(' · ')}</p>
              <p className="mt-1 text-xs text-ink-3">Listed by {courseSourceLabel(m)}.</p>
            </div>
            <Button size="xs" onClick={() => onUse(m)}>Use these details</Button>
          </div>
          {m.description && <p className="mt-1 line-clamp-3 text-xs text-ink-2">{m.description}</p>}
        </div>
      ))}
      {note ?? <p className="text-xs text-ink-3">Saved as it reads now, {would}; anything else you fill in is manual. Vantage checks again when it saves.</p>}
    </div>
  );
}

/**
 * A training's course as its page shows it: the code and CEUs, which values an approved catalog verified, against which
 * catalog and when, and what that catalog says of the course. A value not verified is manual.
 */
export function TrainingCourse({ row }: { row: { course_code?: string | null; ceus?: number | null; title?: string | null; provider?: string | null; hours?: number | null; course?: CourseProvenance } }) {
  const course = row.course;
  const verified = course?.verified ?? [];
  const values: Record<Verifiable, unknown> = { code: row.course_code, title: row.title, provider: row.provider, hours: row.hours, ceus: row.ceus };
  const manual = VERIFIABLE.filter((f) => filled(values[f]) && !verified.includes(f));
  const entry = course?.entry;
  const said = entry ? [
    ['Catalog name', entry.name], ['Catalog provider', entry.provider], ['Catalog hours', entry.hours != null ? formatNumber(entry.hours) : null],
    ['Catalog CEUs', entry.ceus != null ? formatNumber(entry.ceus) : null], ['Category', entry.category], ['Requirements', entry.requirements],
    ['Ranks', entry.ranks], ['MOS', entry.mos], ['Description', entry.description ? <span className="whitespace-pre-wrap">{entry.description}</span> : null],
  ] as Array<[string, React.ReactNode]> : [];
  return (
    <div className="mt-4 space-y-2">
      {(row.course_code || row.ceus != null) && <DescriptionList items={[['Course code', row.course_code || null], ['CEUs', row.ceus != null ? formatNumber(row.ceus) : null]]} />}
      <div className="rounded border border-line px-3 py-2 text-sm" data-testid="course-provenance">
        {entry ? (
          <>
            <p className="flex items-center gap-1.5 font-medium text-ink"><BadgeCheck className="h-4 w-4 text-good" aria-hidden />Verified: {verifiedWords(verified)}</p>
            <p className="text-xs text-ink-3">Against {courseSourceLabel(entry)}, checked {formatStamp(course!.verified_at)}.</p>
            {entry.withdrawn_at && <p className="mt-1 text-xs text-warn">That source has since been withdrawn{entry.withdrawn_reason ? `: ${entry.withdrawn_reason}` : ''}. These values were verified while it was approved.</p>}
            {!entry.withdrawn_at && entry.superseded && <p className="mt-1 text-xs text-ink-3">A later catalog from the source has replaced that one since. Changing the course checks it against the catalog in use.</p>}
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-ink-2"><PenLine className="h-4 w-4 text-ink-3" aria-hidden />{row.course_code ? 'No approved catalog listed this course code when it was saved.' : 'No course code.'} Its values are as entered (manual).</p>
        )}
        {entry && manual.length > 0 && <p className="mt-1 text-xs text-ink-3">Manual: {verifiedWords(manual)}.</p>}
      </div>
      {said.some(([, v]) => v != null && v !== '') && <div><p className="eyebrow mb-1">What the catalog says</p><DescriptionList items={said} /></div>}
    </div>
  );
}

/** A course code and a check beside it on a list, when an approved catalog verified the training's code. */
export function CourseCodeText({ row }: { row: { course_code?: string | null; course?: CourseProvenance } }) {
  if (!row.course_code) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {row.course_code}
      {row.course ? <BadgeCheck className="h-3 w-3 text-good" role="img" aria-label="verified against an approved catalog" /> : null}
    </span>
  );
}
