import { useEffect, useId, useState } from 'react';
import { Input, Select } from '@/components/ui/primitives';
import { PERIOD_OPTIONS } from '../../shared/metrics';
import { CUSTOM_LABEL, CUSTOM_PERIOD, FIRST_YEAR, LAST_YEAR, customSeed, rangeProblems, type PeriodChoice, type RangeProblem } from '../../shared/dateRange';
import { cn } from '@/lib/utils';

/**
 * The period choice (ADR-0038): the presets, and Custom dates, which opens a From and a To field. A custom range is
 * handed on only once both days pass the range rule; until then the field says what is wrong, in the words the server
 * uses, and the page keeps the last good range. A page that holds the days in a form until it runs (`everyEdit`) is
 * handed every edit instead, and checks the range itself before it runs. A Field around it reaches the select through
 * the aria props. A page with choices of its own (a window of so many days, or a set of periods in its own words) passes
 * them as `presets`, with `seed` for the days Custom dates starts from (ADR-0039).
 */
export default function DateRangePicker<P extends string = PeriodChoice>({
  value, onChange, everyEdit = false, includeAll = true, stacked = false, className, placeholder, errors, ignored,
  presets, label = 'Period', seed = customSeed,
  'aria-describedby': describedBy, 'aria-labelledby': labelledBy, 'aria-invalid': invalid,
}: {
  value: { period: string; from?: string; to?: string };
  onChange: (next: { period: P | typeof CUSTOM_PERIOD; from?: string; to?: string }) => void;
  /** Hand on every edit of the days, good or not. */
  everyEdit?: boolean;
  /** All time among the standard periods; not used with `presets`. */
  includeAll?: boolean;
  /** The page's own choices, in its own words, in place of the standard periods. Custom dates always follows them. */
  presets?: ReadonlyArray<{ value: P; label: string }>;
  /** The select's name, when it is not Period (a dashboard's Window). */
  label?: string;
  /** The days Custom dates starts from, given the choice before it. */
  seed?: (previous: string) => { from: string; to: string };
  /** Under a Field's label, where the days go below the select rather than beside it. */
  stacked?: boolean;
  /** The select's width. */
  className?: string;
  placeholder?: string;
  /** What the server said about the days, by field, when it refused them. */
  errors?: Partial<Record<'from' | 'to', string | undefined>>;
  /** Days a link carried that were not used, and why. */
  ignored?: RangeProblem | null;
  'aria-describedby'?: string;
  'aria-labelledby'?: string;
  'aria-invalid'?: boolean;
}) {
  const custom = value.period === CUSTOM_PERIOD;
  const [draft, setDraft] = useState({ from: value.from ?? '', to: value.to ?? '' });
  // The address moved (back, forward, a link): the fields follow it.
  useEffect(() => { if (custom) setDraft({ from: value.from ?? '', to: value.to ?? '' }); }, [custom, value.from, value.to]);
  const problem = custom ? rangeProblems(draft.from, draft.to, { required: true }) : null;
  // A date field reports each part of a day as it is typed (a year passes through 0002 and 0020 on its way to 2026), so
  // what is wrong with the range is said once the person leaves the field, not at every keystroke.
  const [typing, setTyping] = useState(false);
  const shown = typing ? null : { from: problem?.fieldErrors.from ?? errors?.from, to: problem?.fieldErrors.to ?? errors?.to };
  const noticeId = useId();
  const described = [describedBy, ignored ? noticeId : null].filter(Boolean).join(' ') || undefined;

  const choose = (v: string) => {
    if (v !== CUSTOM_PERIOD) { onChange({ period: v as P }); return; }
    // Custom dates start from the days the period before covered, so neither field is empty.
    const days = seed(value.period);
    setDraft(days);
    onChange({ period: CUSTOM_PERIOD, ...days });
  };
  const edit = (field: 'from' | 'to', day: string) => {
    const next = { ...draft, [field]: day };
    setDraft(next);
    setTyping(true);
    if (everyEdit || !rangeProblems(next.from, next.to, { required: true })) onChange({ period: CUSTOM_PERIOD, ...next });
  };
  const options = [
    ...(presets ?? PERIOD_OPTIONS.filter((p) => includeAll || p.value !== 'all')).map((p) => ({ value: p.value as string, label: p.label })),
    { value: CUSTOM_PERIOD, label: CUSTOM_LABEL },
  ];

  return (
    <>
      <Select aria-label={label} aria-labelledby={labelledBy} aria-describedby={described} {...(invalid ? { 'aria-invalid': true } : {})} placeholder={placeholder} className={className} value={value.period} onValueChange={choose} options={options} />
      {custom && (
        <fieldset className={cn('flex min-w-0 flex-wrap items-start gap-2', stacked && 'mt-2')}>
          <legend className="sr-only">{CUSTOM_LABEL}</legend>
          <DayField label="From" value={draft.from} min={`${FIRST_YEAR}-01-01`} max={draft.to || `${LAST_YEAR}-12-31`} error={shown?.from} onChange={(d) => edit('from', d)} onBlur={() => setTyping(false)} />
          <DayField label="To" value={draft.to} min={draft.from || `${FIRST_YEAR}-01-01`} max={`${LAST_YEAR}-12-31`} error={shown?.to} onChange={(d) => edit('to', d)} onBlur={() => setTyping(false)} />
        </fieldset>
      )}
      {ignored && <p id={noticeId} className={cn('w-full text-xs leading-snug text-ink-3', stacked && 'mt-1')}>The dates in the link were not used. {ignored.message}</p>}
    </>
  );
}

/** One day of the range: a native date field with its name beside it, so it sits in a row of filters. */
function DayField({ label, value, min, max, error, onChange, onBlur }: { label: string; value: string; min: string; max: string; error?: string; onChange: (day: string) => void; onBlur: () => void }) {
  const errorId = useId();
  return (
    <div className="min-w-0">
      <label className="flex items-center gap-1.5 text-sm text-ink-2">
        <span>{label}</span>
        <Input type="date" className="fig w-[10.5rem]" value={value} min={min} max={max} onChange={(e) => onChange(e.target.value)} onBlur={onBlur}
          {...(error ? { 'aria-invalid': true, 'aria-describedby': errorId } : {})} />
      </label>
      {error && <p id={errorId} className="mt-1 text-xs leading-snug text-bad" role="alert">{error}</p>}
    </div>
  );
}
