import { useEffect, useState } from 'react';
import { BadgeCheck, PenLine } from 'lucide-react';
import { Badge, Button } from '@/components/ui/primitives';
import { DescriptionList } from '@/components/common';
import * as api from '@/lib/api';
import { formatStamp } from '@/lib/utils';
import { formatNumber } from '../../shared/metrics';
import {
  VERIFIABLE, VERIFIABLE_LABELS, bestListing, courseKey, courseSourceLabel, filled,
  type CourseEntry, type CourseLookup, type CourseProvenance, type CourseValues, type Verifiable,
} from '../../shared/courses';

/**
 * A training's course (Task 22, ADR-0029): the course code looked up in the approved catalogs in use, the values a listing
 * gives, and, beside each value, whether it is what the catalog lists (verified) or what the person entered (manual).
 * The marks here are the same rule the server applies when the training is saved (shared/courses.ts verifiedValues): the
 * server decides, from the catalogs in use, and nothing the form sends can say a value is verified.
 */

/** The values of a training a catalog verifies, under the names the form keeps them. */
export interface CourseDraft { course_code: string; title: string; provider: string; hours: number | string; ceus: number | string }

export type Lookup = { code: string; state: 'idle' | 'looking' | 'done' | 'failed'; result: CourseLookup | null; error?: string };

/** The catalogs' listings of the code typed, looked up a moment after typing stops. Vantage fetches nothing to answer. */
export function useCourseLookup(code: string): Lookup {
  const key = courseKey(code);
  const [state, setState] = useState<Lookup>({ code: '', state: 'idle', result: null });
  useEffect(() => {
    if (key.length < 2) { setState({ code: '', state: 'idle', result: null }); return; }
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      setState((s) => ({ ...s, code, state: 'looking' }));
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

/** The listing the server would verify against: the one that matches the most values, the newest catalog first. */
export const bestMatch = (d: CourseDraft, matches: CourseEntry[]) => bestListing(valuesOf(d), matches);

/** "Verified" or "Manual" beside a value that is filled in, as a field label shows it. */
export function CourseMark({ field, value, verified }: { field: Verifiable; value: unknown; verified: Verifiable[] | null }) {
  if (!filled(value)) return null;
  const ok = Boolean(verified?.includes(field));
  // Read with the field's label: "Title Verified", "Provider Manual".
  return (
    <>{' '}<Badge tone={ok ? 'good' : 'neutral'} className="ml-1 gap-1 align-middle text-2xs">
      {ok ? <BadgeCheck className="h-3 w-3" aria-hidden /> : <PenLine className="h-3 w-3" aria-hidden />}{ok ? 'Verified' : 'Manual'}
    </Badge></>
  );
}

/** What a lookup found, under the course code field: each listing, and a button that fills the form from it. */
export function CourseLookupPanel({ d, lookup, onUse }: { d: CourseDraft; lookup: Lookup; onUse: (entry: CourseEntry) => void }) {
  if (lookup.state === 'idle') return <p className="text-xs text-ink-3">Enter the course code to look it up in the approved catalogs. Without one, every value is kept as entered (manual).</p>;
  if (lookup.state === 'looking') return <p className="text-xs text-ink-3" role="status">Looking up {lookup.code}…</p>;
  if (lookup.state === 'failed') return <p className="text-xs text-bad" role="alert">{lookup.error}</p>;
  const r = lookup.result!;
  if (!r.sources) return <p className="text-xs text-ink-3" role="status">No approved course source has a catalog loaded yet, so nothing can be verified. What you enter is kept as manual.</p>;
  if (!r.matches.length) return <p className="text-xs text-ink-3" role="status">No approved catalog lists {r.code}. What you enter is kept as manual.</p>;
  const best = bestMatch(d, r.matches);
  return (
    <div className="space-y-2" role="status">
      {r.matches.map((m) => (
        <div key={m.entry_id} className="rounded border border-line px-3 py-2 text-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-ink">{m.code} · {m.name}</p>
              <p className="text-xs text-ink-3">{[m.provider, m.hours != null ? `${formatNumber(m.hours)} hours` : null, m.ceus != null ? `${formatNumber(m.ceus)} CEUs` : null, m.category].filter(Boolean).join(' · ')}</p>
              <p className="mt-1 text-xs text-ink-3">Listed by {courseSourceLabel(m)}.</p>
            </div>
            <Button size="xs" onClick={() => onUse(m)}>Use these details</Button>
          </div>
          {m.description && <p className="mt-1 line-clamp-3 text-xs text-ink-2">{m.description}</p>}
        </div>
      ))}
      {best && <p className="text-xs text-ink-3">Saved as it reads now, {best.verified.length > 1 ? `${best.verified.map((v) => VERIFIABLE_LABELS[v].toLowerCase()).join(', ')} would be verified` : 'only the course code would be verified'}; anything else you fill in is manual. Vantage checks again when it saves.</p>}
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
            <p className="flex items-center gap-1.5 font-medium text-ink"><BadgeCheck className="h-4 w-4 text-good" aria-hidden />Verified: {verified.map((v) => VERIFIABLE_LABELS[v].toLowerCase()).join(', ')}</p>
            <p className="text-xs text-ink-3">Against {courseSourceLabel(entry)}, checked {formatStamp(course!.verified_at)}.</p>
            {entry.withdrawn_at && <p className="mt-1 text-xs text-warn">That source has since been withdrawn{entry.withdrawn_reason ? `: ${entry.withdrawn_reason}` : ''}. These values were verified while it was approved.</p>}
            {!entry.withdrawn_at && entry.superseded && <p className="mt-1 text-xs text-ink-3">A later catalog from the source has replaced that one since. Changing the course checks it against the catalog in use.</p>}
          </>
        ) : (
          <p className="flex items-center gap-1.5 text-ink-2"><PenLine className="h-4 w-4 text-ink-3" aria-hidden />{row.course_code ? 'No approved catalog listed this course code when it was saved.' : 'No course code.'} Its values are as entered (manual).</p>
        )}
        {entry && manual.length > 0 && <p className="mt-1 text-xs text-ink-3">Manual: {manual.map((v) => VERIFIABLE_LABELS[v].toLowerCase()).join(', ')}.</p>}
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
