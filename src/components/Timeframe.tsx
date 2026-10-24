import { useState } from 'react';
import { Field, Input, Switch } from '@/components/ui/primitives';
import { onText } from '@/components/common';
import { TIMEFRAMES, TIME_HINT, formatTimeframe, militaryTime, parseTime, timeframeProblems, type TimeframedTable, type TimeframeSpec } from '../../shared/timeframe';

/** A timeframe as a form holds it (ADR-0018): days as YYYY-MM-DD, times as typed ("0800"), '' for none. */
export interface TimeframeDraft { date: string; end_date: string; start_time: string; end_time: string; ongoing: boolean }

/** A stored row's timeframe for a form, its times as Marines write them. */
export const timeframeDraft = (row: { date?: string | null; end_date?: string | null; start_time?: string | null; end_time?: string | null; ongoing?: number | boolean | null } = {}): TimeframeDraft => ({
  date: row.date || '', end_date: row.end_date || '', start_time: militaryTime(row.start_time), end_time: militaryTime(row.end_time), ongoing: row.ongoing === 1 || row.ongoing === true,
});

/**
 * What is wrong with a form's timeframe, by field, before anything is sent: a time that is not one, then the server's own
 * rules (shared/timeframe.ts), in the same words. Null when nothing is.
 */
export function timeframeCheck(table: TimeframedTable, row: object): { message: string; fieldErrors: Record<string, string> } | null {
  const draft = row as Record<string, unknown>;
  const unreadable = ['start_time', 'end_time'].filter((f) => String(draft[f] ?? '').trim() && !parseTime(draft[f]));
  if (unreadable.length) return { message: TIME_HINT, fieldErrors: Object.fromEntries(unreadable.map((f) => [f, TIME_HINT])) };
  return timeframeProblems(table, { ...draft, start_time: parseTime(draft.start_time), end_time: parseTime(draft.end_time) });
}

/**
 * When an activity or a course ran: its first day, its last if it ran longer, "ongoing" while it has no end yet, and a
 * time of day at each end behind "Add times". `extra` sits beside the Ongoing switch (the status, which goes with it).
 */
export function TimeframeFields({ table, d, set, errors, extra }: { table: 'activities' | 'trainings'; d: TimeframeDraft; set: (k: keyof TimeframeDraft, v: unknown) => void; errors: Record<string, string>; extra?: React.ReactNode }) {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  const [timed, setTimed] = useState(Boolean(d.start_time || d.end_time));
  const ongoing = (v: boolean) => { set('ongoing', v); if (v) { set('end_date', ''); set('end_time', ''); } };
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label={spec.labels.start} error={errors.date}><Input type="date" value={d.date} onChange={onText(set, 'date')} /></Field>
      <Field label={spec.labels.end} hint={d.ongoing ? 'none yet: ongoing' : 'if it ran longer than a day'} error={errors.end_date}>
        <Input type="date" value={d.ongoing ? '' : d.end_date} min={d.date || undefined} disabled={d.ongoing} onChange={onText(set, 'end_date')} />
      </Field>
      {timed && (
        <>
          <Field label="Start time" hint="24-hour" error={errors.start_time}><Input inputMode="numeric" maxLength={5} placeholder="0800" value={d.start_time} onChange={onText(set, 'start_time')} /></Field>
          <Field label="End time" hint="24-hour" error={errors.end_time}><Input inputMode="numeric" maxLength={5} placeholder="1630" value={d.ongoing ? '' : d.end_time} disabled={d.ongoing} onChange={onText(set, 'end_time')} /></Field>
        </>
      )}
      {extra}
      <div className="min-w-0 self-end">
        <Switch checked={d.ongoing} onChange={ongoing} label="Ongoing" description="Begun and not finished: it counts in every period until it ends." />
        {errors.ongoing && <p className="text-xs text-bad" role="alert">{errors.ongoing}</p>}
        {!timed && <button type="button" className="text-xs text-accent hover:underline" onClick={() => setTimed(true)}>Add times</button>}
      </div>
    </div>
  );
}

/** A record's timeframe in words: "12 May 25", "12 May 25 – 16 May 25", "12 May 25 0800–1600", "3 Mar 25 – present". */
export function TimeframeText({ table, row, fallback = 'No date', pattern }: { table: TimeframedTable; row: object; fallback?: string; pattern?: string }) {
  const text = formatTimeframe(table, row, { pattern });
  return <span className="fig">{text || <span className="text-ink-3">{fallback}</span>}</span>;
}
