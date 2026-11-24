import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, Field, Input, NumberInput, Select, Switch, useRefusal, type Tone } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { keys } from '@/lib/queries';
import * as api from '@/lib/api';
import { FITREP_ATTRIBUTES, FITREP_METHOD, OCCASIONS, OCCASION_NAMES, REPORT_TYPES, REPORT_TYPE_NAMES, type Occasion, type ReportType, type Third } from '../../shared/fitrepMethod';
import { averageOfMarks, fig, methodOn, profileKey, project, standingDay, standingOf, summarize, thirdLabel, type ReportStanding } from '../../shared/fitrepStanding';

/**
 * The fitness reports a Marine received and where each stands (ADR-0047): the Fitness Report Average, the place in the
 * reporting senior's profile and the Relative Value, worked by the published method with its working shown. The Master
 * Brief Sheet is the record. Nothing here compares one Marine with another.
 */

const THIRD_TONE: Record<Third, Tone> = { upper: 'good', middle: 'accent', lower: 'neutral' };
export const GRADES = ['E-5', 'E-6', 'E-7', 'E-8', 'E-9', 'W-1', 'W-2', 'W-3', 'W-4', 'W-5', 'O-1', 'O-2', 'O-3', 'O-4', 'O-5', 'O-6', 'O-7', 'O-8', 'O-9', 'O-10'];
const ABBRS = FITREP_ATTRIBUTES.map((a) => a.abbr).join(' ');

/** The day after a date, so the coming report's period starts where the last one entered ended. */
export function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The end of the latest report the Marine entered, or null. */
export const lastPeriodEnd = (reports: api.FitnessReport[] = []) => reports.reduce<string | null>((m, r) => (!m || r.period_to > m ? r.period_to : m), null);

export function useStandings(reports: api.FitnessReport[] = []) {
  return useMemo(() => {
    const method = methodOn(standingDay()).data;
    return reports.map((r) => ({ report: r, standing: standingOf(r, method) }));
  }, [reports]);
}

/** How many reports sit in each third, as the Master Brief Sheet sums them. */
export function ThirdsSummary({ standings, label = 'Your reports by third' }: { standings: ReportStanding[]; label?: string }) {
  const method = methodOn(standingDay()).data;
  const s = summarize(standings);
  const parts: Array<[string, number]> = [...method.thirds.map((t) => [t.label, s.counts[t.key]] as [string, number]), ['No relative value', s.counts.none]];
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={label}>
      {parts.map(([label, n]) => (
        <div key={label} className="rounded-md border border-line px-3 py-2">
          <dt className="eyebrow">{label}</dt>
          <dd className="fig mt-0.5 text-lg font-semibold text-ink">{n}</dd>
        </div>
      ))}
    </dl>
  );
}

const periodText = (r: api.FitnessReport) => `${r.period_from} to ${r.period_to}`;
const occasionText = (r: api.FitnessReport) => `${r.occasion}, ${OCCASION_NAMES[r.occasion as Occasion] ?? r.occasion}`;

/** One report and its standing, with the working. */
export function ReportCard({ report: r, standing: s, actions }: { report: api.FitnessReport; standing: ReportStanding; actions?: React.ReactNode }) {
  const method = methodOn(standingDay()).data;
  const avg = s.average;
  return (
    <article className="rounded-lg border border-line p-3" aria-label={`Fitness report ${periodText(r)}`} data-report-id={r.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{periodText(r)}</h3>
          <p className="text-xs text-ink-3">{[occasionText(r), r.report_type !== 'observed' ? REPORT_TYPE_NAMES[r.report_type as ReportType] : null, r.grade, r.rs_label ? `RS ${r.rs_label}` : null].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {s.third && <Badge tone={THIRD_TONE[s.third]}>{thirdLabel(s.third, method)}</Badge>}
          {r.shared ? <Badge tone="accent">Shared</Badge> : null}
          {actions}
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div><dt className="eyebrow">Report average</dt><dd className="fig text-ink">{avg ? fig(avg.value) : 'Not entered'}</dd>{avg?.source === 'marks' && <dd className="fig text-2xs text-ink-3">{avg.sum} over {avg.observed} observed</dd>}{avg?.source === 'printed' && <dd className="text-2xs text-ink-3">as printed</dd>}</div>
        <div><dt className="eyebrow">RS Avg / High</dt><dd className="fig text-ink">{r.rs_avg != null && r.rs_high != null ? `${fig(r.rs_avg)} / ${fig(r.rs_high)}` : 'Not entered'}</dd></div>
        <div><dt className="eyebrow">Reports</dt><dd className="fig text-ink">{r.reports_at_processing != null || r.reports_cumulative != null ? `${r.reports_at_processing ?? '?'} of ${r.reports_cumulative ?? '?'}` : 'Not entered'}</dd></div>
        <div><dt className="eyebrow">RV processed / cum</dt><dd className="fig text-ink">{s.atProcessing.value != null ? fig(s.atProcessing.value) : s.atProcessing.reason ? 'None' : 'Not entered'} / {s.rv ? fig(s.rv.value) : 'None'}</dd></div>
      </dl>
      {s.position && <p className="mt-2 text-xs text-ink-2">The report average is {s.position.text}.</p>}
      {s.rv && <p className="fig mt-1 text-xs text-ink-2">Cumulative RV: {s.rv.arithmetic}.</p>}
      {s.reason && <p className="mt-1 text-xs text-ink-3">{s.reason}</p>}
      {s.atProcessing.reason && s.atProcessing.reason !== s.reason && <p className="mt-1 text-xs text-ink-3">When processed: {s.atProcessing.reason}</p>}
      {s.check && <p className="mt-1 text-xs text-warn">{s.check}</p>}
      {s.notes.map((n) => <p key={n} className="mt-1 text-xs text-warn">{n}</p>)}
    </article>
  );
}

/** The method's version, with its sources and the readings it takes where they leave something open. */
export function FitrepMethodSources() {
  const v = methodOn(standingDay());
  return (
    <details className="rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-ink-2">How these are worked, and the sources</summary>
      <div className="mt-2 space-y-1.5 text-xs text-ink-2">
        <p><span className="font-medium text-ink">{FITREP_METHOD.name}</span> <span className="fig text-ink-3">({v.id}, from {v.effective_from})</span></p>
        <p>{v.cites.map((c, i) => <span key={`${c.source}-${i}`}>{i > 0 && '; '}<a className="link inline-flex items-center gap-0.5" href={c.url} target="_blank" rel="noopener noreferrer">{c.source}<ExternalLink className="h-3 w-3" aria-hidden /></a>, {c.where}</span>)}</p>
        <ul className="list-disc space-y-1 pl-4 text-ink-3">{(v.notes ?? []).map((n) => <li key={n}>{n}</li>)}</ul>
      </div>
    </details>
  );
}

const FIELDS = ['period_from', 'period_to', 'occasion', 'report_type', 'grade', 'rs_label', 'marks', 'rpt_avg', 'rs_avg', 'rs_high', 'reports_at_processing', 'reports_cumulative', 'rv_at_processing', 'cum_rv_printed'] as const;
type Draft = Record<(typeof FIELDS)[number], string> & { shared: boolean };
const draftOf = (r: api.FitnessReport | null, grade: string | null): Draft => ({
  ...(Object.fromEntries(FIELDS.map((k) => [k, r?.[k] == null ? '' : String(r[k])])) as Record<(typeof FIELDS)[number], string>),
  ...(r ? {} : { report_type: 'observed', grade: grade && GRADES.includes(grade) ? grade : '' }),
  shared: Boolean(r?.shared),
});
/** The body the server takes: every field, a blank one as null, so a correction can clear it. */
const bodyOf = (d: Draft, version?: number) => ({
  ...Object.fromEntries(FIELDS.map((k) => [k, d[k].trim() === '' ? null : d[k].trim()])),
  shared: d.shared, ...(version ? { version } : {}),
});

/**
 * The saved row goes into the list at once, so a change made before the list is read again carries the new version and
 * is not refused as a change from another window. A refusal for a stale version reads the list again.
 */
function useKeepReport() {
  const qc = useQueryClient();
  return {
    saved: (row: api.FitnessReport) => {
      qc.setQueryData<{ reports: api.FitnessReport[] }>(keys.fitnessReports, (old) => (old && old.reports.some((x) => x.id === row.id) ? { ...old, reports: old.reports.map((x) => (x.id === row.id ? row : x)) } : old));
      return qc.invalidateQueries({ queryKey: keys.fitnessReports });
    },
    refused: (e: unknown) => { if (e instanceof api.ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: keys.fitnessReports }); },
  };
}

/** Add or correct a report the Marine received, copied from their Master Brief Sheet. */
export function FitnessReportDialog({ open, onOpenChange, report, grade }: { open: boolean; onOpenChange: (o: boolean) => void; report: api.FitnessReport | null; grade: string | null }) {
  const keep = useKeepReport();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftOf(report, grade));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ text: string; atField: boolean } | null>(null);
  const form = useRef<HTMLFormElement | null>(null);
  const summary = useRef<HTMLParagraphElement | null>(null);
  const refuse = useRefusal(form, () => summary.current?.focus());
  const set = (k: keyof Draft) => (v: string | boolean) => {
    setD((x) => ({ ...x, [k]: v }));
    setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; });
  };
  const save = useMutation({
    mutationFn: () => api.saveFitnessReport(report?.id ?? null, bodyOf(d, report?.version)),
    onSuccess: (row) => { void keep.saved(row); toast.success(report ? 'Report saved.' : 'Report added.'); onOpenChange(false); },
    onError: (e) => {
      keep.refused(e);
      const fieldErrors = e instanceof api.ApiError ? e.fieldErrors || {} : {};
      setErrors(fieldErrors);
      setProblem({ text: api.errorText(e), atField: Object.keys(fieldErrors).length > 0 });
      refuse(api.errorText(e));
    },
  });
  const marksAvg = averageOfMarks(/^[A-H]{14}$/i.test(d.marks.trim()) ? d.marks.trim() : null);
  const text = (k: (typeof FIELDS)[number], label: string, hint?: string) => (
    <Field label={label} hint={hint} error={errors[k]}><Input value={d[k]} onChange={(e) => set(k)(e.target.value)} /></Field>
  );
  const number = (k: (typeof FIELDS)[number], label: string, hint?: string) => (
    <Field label={label} hint={hint} error={errors[k]}><NumberInput value={d[k]} onChange={(e) => set(k)(e.target.value)} /></Field>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title={report ? 'Correct this report' : 'Add a fitness report'}
      description="Copy each figure from your Master Brief Sheet, which is the record. Only you see a report unless you share it."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={save.isPending}>Cancel</Button><Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>{report ? 'Save changes' : 'Add report'}</Button></>}>
      <form ref={form} className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <fieldset className="min-w-0">
          <legend className="eyebrow mb-2">The report</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Period from" required error={errors.period_from}><Input type="date" value={d.period_from} onChange={(e) => set('period_from')(e.target.value)} /></Field>
            <Field label="Period to" required error={errors.period_to}><Input type="date" value={d.period_to} onChange={(e) => set('period_to')(e.target.value)} /></Field>
            <Field label="Occasion" required error={errors.occasion}><Select aria-label="Occasion" value={d.occasion} onValueChange={(v) => set('occasion')(v)} placeholder="Choose the occasion" options={OCCASIONS.map((o) => ({ value: o, label: `${o}, ${OCCASION_NAMES[o]}` }))} /></Field>
            <Field label="Type" error={errors.report_type}><Select aria-label="Type" value={d.report_type} onValueChange={(v) => set('report_type')(v)} options={REPORT_TYPES.map((t) => ({ value: t, label: REPORT_TYPE_NAMES[t] }))} /></Field>
            <Field label="Your grade on the report" required error={errors.grade}><Select aria-label="Your grade on the report" value={d.grade} onValueChange={(v) => set('grade')(v)} placeholder="Choose the grade" options={GRADES} /></Field>
            {text('rs_label', 'Reporting senior', 'As you name them. The same name and grade make one profile.')}
          </div>
        </fieldset>
        <fieldset className="min-w-0">
          <legend className="eyebrow mb-2">Marks and averages</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">{text('marks', 'Marks', `Fourteen letters in form order (${ABBRS}). H is not observed.`)}</div>
            {number('rpt_avg', 'RPT Avg', 'As printed, when you leave the marks blank')}
            {number('rs_avg', 'RS Avg', 'From your MBS, now')}
            {number('rs_high', 'RS High', 'From your MBS, now')}
          </div>
          {marksAvg && <p className="fig mt-2 text-xs text-ink-2">These marks average {fig(marksAvg.value)} ({marksAvg.sum} over {marksAvg.observed} observed).</p>}
        </fieldset>
        <fieldset className="min-w-0">
          <legend className="eyebrow mb-2">Profile and relative value, as printed</legend>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {number('reports_at_processing', 'Reports when processed', 'The first number under Reports')}
            {number('reports_cumulative', 'Reports now', 'The second number')}
            {number('rv_at_processing', 'RV at processing')}
            {number('cum_rv_printed', 'Cum RV')}
          </div>
        </fieldset>
        <Switch checked={d.shared} onChange={(v) => set('shared')(v)} label="Share with the leaders who see my readiness" description="They see this report and its standing, never ranked against anyone. Each time one opens your reports it is logged." />
        {problem && <p ref={summary} tabIndex={-1} role={problem.atField ? undefined : 'alert'} className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{problem.text}</p>}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Dialog>
  );
}

/** The Marine's own reports: add, correct, share and remove them. */
export function MyFitnessReports({ reports, grade }: { reports: api.FitnessReport[]; grade: string | null }) {
  const qc = useQueryClient();
  const keep = useKeepReport();
  const toast = useToast();
  // A removed report's buttons go with it, so focus moves to the one control that stays.
  const addButton = useRef<HTMLButtonElement | null>(null);
  const rows = useStandings(reports);
  const [editing, setEditing] = useState<{ report: api.FitnessReport | null; n: number } | null>(null);
  const [removing, setRemoving] = useState<api.FitnessReport | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFitnessReport(id),
    onSuccess: (_done, id) => {
      void qc.invalidateQueries({ queryKey: keys.fitnessReports });
      toast.success('Report removed.');
      setRemoving(null);
      // Only when focus went nowhere, or is still on the removed report: a Marine who moved on keeps their place.
      requestAnimationFrame(() => {
        const at = document.activeElement;
        if (!at || at === document.body || at.closest(`[data-report-id="${CSS.escape(id)}"]`)) addButton.current?.focus();
      });
    },
    onError: (e) => toast.error(api.errorText(e)),
  });
  const share = useMutation({
    mutationFn: (r: api.FitnessReport) => api.saveFitnessReport(r.id, bodyOf({ ...draftOf(r, null), shared: !r.shared }, r.version)),
    onSuccess: (r) => { void keep.saved(r); toast.success(r.shared ? 'Shared with the leaders who see your readiness.' : 'No longer shared.'); },
    onError: (e) => { keep.refused(e); toast.error(api.errorText(e)); },
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-2">The record is your Master Brief Sheet. These are its sums, worked the published way with the working shown.</p>
        <Button ref={addButton} size="sm" variant="soft" onClick={() => setEditing({ report: null, n: Date.now() })}><Plus className="h-3.5 w-3.5" aria-hidden />Add a report</Button>
      </div>
      {rows.length > 0 && <ThirdsSummary standings={rows.map((x) => x.standing)} />}
      {rows.length ? rows.map(({ report: r, standing }) => (
        <ReportCard key={r.id} report={r} standing={standing} actions={<>
          <Button size="xs" variant="ghost" onClick={() => share.mutate(r)} loading={share.isPending && share.variables?.id === r.id} aria-label={`${r.shared ? 'Stop sharing' : 'Share'} the report of ${periodText(r)}`}>{r.shared ? 'Stop sharing' : 'Share'}</Button>
          <Button size="xs" variant="ghost" onClick={() => setEditing({ report: r, n: Date.now() })} aria-label={`Correct the report of ${periodText(r)}`}><Pencil className="h-3.5 w-3.5" aria-hidden /></Button>
          <Button size="xs" variant="ghost" onClick={() => setRemoving(r)} aria-label={`Remove the report of ${periodText(r)}`}><Trash2 className="h-3.5 w-3.5" aria-hidden /></Button>
        </>} />
      )) : <p className="rounded-md border border-dashed border-line px-3 py-4 text-sm text-ink-3">No reports yet. Add the ones on your Master Brief Sheet to see where each stands and what the coming one needs.</p>}
      <FitrepMethodSources />
      {editing && <FitnessReportDialog key={editing.n} open onOpenChange={(o) => { if (!o) setEditing(null); }} report={editing.report} grade={grade} />}
      <ConfirmDialog open={Boolean(removing)} onOpenChange={(o) => { if (!o) setRemoving(null); }} title="Remove this report?" confirmLabel="Remove"
        body={removing ? <>The report of {periodText(removing)} leaves your page and any leader’s view of it. Your MBS is not changed.</> : null}
        onConfirm={() => { if (removing) remove.mutate(removing.id); }} loading={remove.isPending} />
    </div>
  );
}

interface Profile { key: string; label: string; grade: string; avg: number; high: number; reports: number; observed: number | null; earlier: api.FitnessReport[] }

/**
 * Each profile the Marine has a report in: every one of their reports in it, the profile's figures from the newest
 * report that carries them, and the marks observed on the newest report whose marks were entered.
 */
function profilesOf(reports: api.FitnessReport[]): Profile[] {
  const groups = new Map<string, api.FitnessReport[]>();
  for (const r of [...reports].sort((a, b) => (a.period_to < b.period_to ? 1 : a.period_to > b.period_to ? -1 : 0))) {
    const key = profileKey(r);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: Profile[] = [];
  for (const [key, list] of groups) {
    const withFigures = list.find((r) => r.rs_avg != null && r.rs_high != null && r.reports_cumulative != null);
    if (!withFigures) continue;
    const marked = list.map((r) => averageOfMarks(r.marks)).find(Boolean);
    out.push({ key, label: withFigures.rs_label!, grade: withFigures.grade, avg: withFigures.rs_avg!, high: withFigures.rs_high!, reports: withFigures.reports_cumulative!, observed: marked?.observed ?? null, earlier: list });
  }
  return out;
}

const ENTER = '__enter';
const inRange = (n: number | null): n is number => n != null && Number.isFinite(n) && n >= 1 && n <= 7;
const numberOf = (s: string) => (s.trim() === '' ? null : Number(s));

/** The coming report against an RS profile, worked as it would be when processed. Nothing here is saved. */
export function ComingReport({ reports }: { reports: api.FitnessReport[] }) {
  const profiles = useMemo(() => profilesOf(reports), [reports]);
  const [choice, setChoice] = useState('');
  const chosen = choice === ENTER ? null : profiles.find((p) => p.key === choice) ?? profiles[0] ?? null;
  const [typed, setTyped] = useState({ avg: '', high: '', reports: '' });
  const [expect, setExpect] = useState({ fra: '', marks: '', observed: '' });
  const method = methodOn(standingDay()).data;
  const base = chosen
    ? { rsAvg: chosen.avg, rsHigh: chosen.high, reports: chosen.reports }
    : { rsAvg: numberOf(typed.avg), rsHigh: numberOf(typed.high), reports: numberOf(typed.reports) };
  const ready = inRange(base.rsAvg) && inRange(base.rsHigh) && base.rsHigh >= base.rsAvg && base.reports != null && Number.isInteger(base.reports) && base.reports >= 0;
  const marks = /^[A-H]{14}$/i.test(expect.marks.trim()) ? expect.marks.trim().toUpperCase() : null;
  const fra = numberOf(expect.fra);
  // Fourteen attributes unless one is not observed: the newest marks entered in the profile say how many were.
  const observedDefault = chosen?.observed ?? method.attributes;
  const typedObserved = numberOf(expect.observed);
  const observedOk = typedObserved == null || (Number.isInteger(typedObserved) && typedObserved >= 1 && typedObserved <= method.attributes);
  const observed = typedObserved != null && observedOk ? typedObserved : observedDefault;
  const p = ready ? project({ rsAvg: base.rsAvg!, rsHigh: base.rsHigh!, reports: base.reports!, fra: inRange(fra) ? fra : null, marks, observed, earlier: chosen?.earlier ?? [] }, method) : null;
  const byId = new Map(reports.map((r) => [r.id, r]));
  const moved = p ? p.earlier.filter((e) => e.after != null && e.id && byId.has(e.id)) : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="RS profile" className="sm:col-span-3">
          <Select aria-label="RS profile" value={chosen ? chosen.key : ENTER} onValueChange={setChoice}
            options={[...profiles.map((x) => ({ value: x.key, label: `${x.label}, ${x.grade} (RS Avg ${fig(x.avg)}, High ${fig(x.high)}, ${x.reports} ${x.reports === 1 ? 'report' : 'reports'})` })), { value: ENTER, label: 'Enter the figures' }]} />
        </Field>
        {!chosen && <>
          <Field label="RS Avg" hint="1.00 to 7.00"><NumberInput value={typed.avg} onChange={(e) => setTyped((f) => ({ ...f, avg: e.target.value }))} /></Field>
          <Field label="RS High" hint="1.00 to 7.00"><NumberInput value={typed.high} onChange={(e) => setTyped((f) => ({ ...f, high: e.target.value }))} /></Field>
          <Field label="Reports the RS has written on the grade" hint="0 or more"><NumberInput value={typed.reports} onChange={(e) => setTyped((f) => ({ ...f, reports: e.target.value }))} /></Field>
        </>}
        <Field label="Average you expect" hint="1.00 to 7.00"><NumberInput value={expect.fra} onChange={(e) => setExpect((x) => ({ ...x, fra: e.target.value }))} /></Field>
        <Field label="Or the marks you expect" hint="Fourteen letters, A to H"><Input value={expect.marks} onChange={(e) => setExpect((x) => ({ ...x, marks: e.target.value }))} /></Field>
        <Field label="Attributes observed" hint={`1 to ${method.attributes}; ${observedDefault} unless you change it`} error={observedOk ? undefined : `A whole number from 1 to ${method.attributes}. Worked over ${observedDefault} until then.`}><NumberInput value={expect.observed} placeholder={String(observedDefault)} onChange={(e) => setExpect((x) => ({ ...x, observed: e.target.value }))} /></Field>
      </div>
      <p aria-live="polite" className="rounded-md bg-surface-2 px-3 py-2 text-sm text-ink">
        {!p ? 'Choose a profile, or enter the RS Avg, RS High and how many reports the RS has written on the grade.'
          : p.reason || !p.rv || !p.third || !p.profile.after ? p.reason
            : <>Processed now, it would be valued <span className="fig font-semibold">{fig(p.rv.value)}</span>, in the {thirdLabel(p.third, method).toLowerCase()}. The profile would read RS Avg <span className="fig">{fig(p.profile.after.avg)}</span>, RS High <span className="fig">{fig(p.profile.after.high)}</span>, <span className="fig">{p.profile.after.reports}</span> reports.</>}
      </p>
      {p?.rv && <p className="fig text-xs text-ink-2">{marks && p.fra != null ? `The marks average ${fig(p.fra)}. ` : ''}{p.rv.arithmetic}.</p>}
      {moved.length > 0 && (
        <ul className="space-y-1 text-xs text-ink-2" aria-label="Your earlier reports in this profile">
          {moved.map((e) => <li key={e.id}>Your report of {periodText(byId.get(e.id!)!)}: cumulative RV {e.before == null ? (e.beforeUnworked ? 'not worked from these figures now (your MBS prints it)' : 'none now') : <><span className="fig">{fig(e.before)}</span> now</>}, <span className="fig">{fig(e.after!)}</span> after.</li>)}
        </ul>
      )}
      {p && (
        <div>
          <h3 className="eyebrow mb-1.5">The average each needs, over {p.observed} observed marks</h3>
          <ul className="space-y-1">{p.targets.map((t) => (
            <li key={t.key} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="text-ink-2">{t.label.charAt(0).toUpperCase() + t.label.slice(1)}</span>
              <span className="fig text-ink">{t.reach === 'no_value' ? 'No RV yet' : t.fra == null ? 'Out of reach' : <>{fig(t.fra)} <span className="text-2xs text-ink-3">({t.total} over {p.observed})</span></>}{t.reach === 'reached' && <Badge tone="good" className="ml-1.5">Reached</Badge>}</span>
            </li>
          ))}</ul>
        </div>
      )}
      <p className="text-2xs text-ink-3">Nothing here is saved. A report’s RV is fixed when it is processed; the cumulative values of the reports before it move with each report the RS writes on the grade.</p>
    </div>
  );
}

/** The reports a Marine shares, as a leader who sees their readiness reads them. Each read is logged. */
export function SharedFitnessReports({ reports, sharedOnly }: { reports: api.FitnessReport[]; sharedOnly: boolean }) {
  const rows = useStandings(reports);
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-2">The record is the Master Brief Sheet. These are the figures the Marine copied from it, worked the published way.{sharedOnly ? ' Only the reports the Marine shares are shown, and each view is logged.' : ''}</p>
      {rows.length ? <>
        <ThirdsSummary standings={rows.map((x) => x.standing)} label={sharedOnly ? 'Shared reports by third' : 'Your reports by third'} />
        {rows.map(({ report, standing }) => <ReportCard key={report.id} report={report} standing={standing} />)}
      </> : <p className="text-sm text-ink-3">{sharedOnly ? 'The Marine shares no fitness reports.' : 'No reports entered.'}</p>}
      <FitrepMethodSources />
    </div>
  );
}
