import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, FileDown, Download, Copy, TrendingUp, TrendingDown, Minus, Sparkles, Printer } from 'lucide-react';
import { Button, Select, Panel, Segmented, Skeleton, EmptyState, Stat } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { AiAction, AiResult, ModelPicker } from '@/components/AiPanel';
import { DateText, PageShell } from '@/components/common';
import DateRangePicker from '@/components/DateRangePicker';
import { QueryFailure } from '@/components/QueryFailure';
import { keys, useIdentity, usePrefs, useSavePrefs, useTeam, useTrack, useMetricsReport } from '@/lib/queries';
import { MetricTotalsGrid } from '@/components/MetricTotals';
import * as api from '@/lib/api';
import { notShown, packageToText } from '../../shared/bullets';
import { comparisonToText, type Comparison, type Movement } from '../../shared/delta';
import { DEFAULT_PERIOD, formatDollars, formatNumber } from '../../shared/metrics';
import { CUSTOM_PERIOD } from '../../shared/dateRange';
import { usePeriodParam } from '@/lib/usePeriodParam';
import { metricsPeriod, periodQuery } from '@/lib/periodParams';
import { trackMeta, type Track } from '../../shared/evaluation';
import { copyToClipboard, cn } from '@/lib/utils';
import ReportAnalysis from './ReportAnalysis';
import NarrativeStudio, { choicesToParams, editStateOf, keyPart, useNarrativeChoices } from '@/components/NarrativeStudio';
import type { WorksheetBlocks } from '../../shared/writer/worksheet';
import { usePlace } from '@/lib/place';

const AUDITED_READ = { staleTime: 60_000, refetchOnWindowFocus: false, retry: false } as const;
/** Periods that end today and move with it. */
const ROLLING_PERIODS = new Set(['last30', 'last90', 'last12', 'all']);

export default function Reports({ embedded }: { embedded?: boolean } = {}) {
  const place = usePlace();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const savePrefs = useSavePrefs();
  const myTrack = useTrack();
  const [params] = useSearchParams();
  const subjectId = params.get('user') || '';
  const unitParam = params.get('unit') || '';
  const { data: team } = useTeam(Boolean(identity?.canLead));
  const range = usePeriodParam(prefs.reportPeriod || identity?.unitDefaults?.reportPeriod || DEFAULT_PERIOD);
  const { period, from, to, custom } = range;
  // The bullet style is sent only once someone picks one, so the package is written in the report's own track form by
  // default (FITREP shorthand on a FITREP package, the full JEPES form on a JEPES one) whoever is reading it.
  const [picked, setStyle] = useState<'jepes' | 'fitrep' | 'resume' | ''>('');
  const [track, setTrack] = useState<Track | ''>('');
  const [view, setView] = useState<'narrative' | 'bullets' | 'delta' | 'analysis'>((prefs.reportView as never) || 'narrative');
  const [limit, setLimit] = useState(8);
  const [aiOut, setAiOut] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  useEffect(() => { setStyle(''); }, [track, subjectId]);
  const q = { ...periodQuery({ period, from, to, custom }), style: picked || undefined, track: track || undefined, limit, user_id: subjectId || undefined, unit_id: unitParam || undefined };
  // Reading a Marine's or a unit's report is audited and rebuilt from every entry in the period, so it is read when asked
  // for, not again on every focus; an edit to a record invalidates it.
  const { data: report, isPending, error } = useQuery({ queryKey: keys.report(q), queryFn: () => api.report(q), ...AUDITED_READ });
  const { data: delta, error: deltaError, refetch: refetchDelta } = useQuery<Comparison>({ queryKey: keys.delta(q), queryFn: () => api.reportDelta(q), enabled: view === 'delta', ...AUDITED_READ });
  const metricParams = useMemo(
    () => ({ ...metricsPeriod({ period, from, to, custom }), user_id: subjectId || undefined, unit_id: unitParam || undefined, scope: subjectId || unitParam ? undefined : 'me' }),
    [period, from, to, custom, subjectId, unitParam],
  );
  const reportMetrics = useMetricsReport(metricParams);
  const subject = subjectId ? (team?.roster || []).find((r) => r.id === subjectId) : null;
  const effectiveTrack: Track = report?.track || myTrack;
  const meta = trackMeta(effectiveTrack);
  const style = picked || (effectiveTrack === 'fitrep' ? 'fitrep' : 'jepes');
  // A rolling period ("last 30 days") is kept by its name, so an edit made today is still there after midnight, and the
  // studio says what changed under it; a fixed one by its days. A Marine's view through a unit is that unit's own, by
  // the unit the server built the report for (it chooses one when the link names none, or one the reader cannot open);
  // a Marine's own report is the same whatever unit is picked, as the server reads it.
  const rolling = !custom && ROLLING_PERIODS.has(period);
  const reportUnit = (report?.unit as { id?: string } | undefined)?.id;
  const [choices, setChoices] = useNarrativeChoices(
    [identity?.user.id || 'me', effectiveTrack, ...(rolling ? [period] : [report?.from || period, report?.to || '']), subjectId, subjectId ? reportUnit || 'pending' : ''].map(keyPart).join('.'),
    // The key before units were part of it, moved once, and only for a Marine's own report: a leader's old edit of a
    // Marine's narrative could have been written from another unit's view, so it is not carried into this one.
    subjectId ? undefined : `${identity?.user.id || 'me'}.${effectiveTrack}.${report?.from || period}.${report?.to || ''}.`,
  );
  // An edit the record has moved on from, or one that cannot be checked, goes into the PDFs as written: say so in every view.
  const edit = useMemo(() => (report ? editStateOf(choices, report.activities, report.casework) : null), [report, choices]);
  const pkgText = useMemo(() => (report ? packageToText(report.pkg, `${meta.inputName} · ${report.subject} · ${report.label}`) : ''), [report, meta.inputName]);
  const worksheet = (report?.worksheet ?? null) as WorksheetBlocks | null;
  const copy = async (text: string, what: string) => { if (await copyToClipboard(text)) toast.success(`${what} copied.`); else toast.error('Could not copy.'); };
  const download = async (kind: 'pdf' | 'csv' | 'analysis') => {
    try { const name = await api.downloadFile(kind === 'pdf' ? api.reportPdfUrl({ ...q, limit: 12, ...choicesToParams(choices) }) : kind === 'analysis' ? api.analysisPdfUrl({ ...q, limit: 12, ...choicesToParams(choices) }) : api.reportCsvUrl(q), kind === 'pdf' ? 'vantage-report.pdf' : kind === 'analysis' ? 'vantage-analysis.pdf' : 'vantage-activities.csv'); toast.success(`Downloaded ${name}.`); }
    catch (e) { toast.error(api.errorText(e)); }
  };

  return (
    <PageShell
      embedded={embedded}
      eyebrow={place.group}
      title={subject ? `${meta.inputName} for ${subject.rank_abbr || ''} ${subject.last_name}` : meta.inputName}
      lede={effectiveTrack === 'fitrep'
        ? `MRO worksheet input built from ${subject ? 'their shared' : 'your'} logged entries: the Section C draft, and the PME and Other blocks beside it. Copy each block, or export a PDF for the reporting senior.`
        : `Billet accomplishments and a bullet package built from ${subject ? 'their shared' : 'your'} logged entries. Copy them, or export a PDF to hand to the reporting senior.`}
      actions={<>
        <Button asChild><Link to={`/reports/library?${new URLSearchParams({ type: 'individual', ...periodQuery({ period, from, to, custom }), ...(track ? { track } : {}), ...(subjectId ? { subject: 'member', user_id: subjectId, ...(unitParam ? { unit_id: unitParam } : {}) } : { subject: 'self' }) })}`}><Printer className="h-4 w-4" aria-hidden />Print or file</Link></Button>
        <Button onClick={() => download('csv')}><Download className="h-4 w-4" />Export activities</Button>
        <Button onClick={() => download('analysis')}><FileDown className="h-4 w-4" />Export analysis PDF</Button>
        <Button variant="primary" onClick={() => download('pdf')}><FileDown className="h-4 w-4" />Export {meta.inputName} PDF</Button>
      </>}
    >

      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <DateRangePicker value={range} ignored={range.ignored} className="w-44" onChange={(next) => { range.set(next); if (next.period !== CUSTOM_PERIOD) savePrefs.mutate({ reportPeriod: next.period }); }} />
        <Select aria-label="Evaluation system" className="w-auto min-w-[10rem]" value={track || 'auto'} onValueChange={(v) => setTrack(v === 'auto' ? '' : (v as Track))} options={[{ value: 'auto', label: `By rank (${meta.name})` }, { value: 'jepes', label: 'JEPES' }, { value: 'fitrep', label: 'FITREP' }]} />
        <Select aria-label="Bullet style" className="w-36" value={style} onValueChange={(v) => setStyle(v as never)} options={[{ value: 'jepes', label: 'JEPES style' }, { value: 'fitrep', label: 'FITREP style' }, { value: 'resume', label: 'Résumé style' }]} />
        <Select aria-label="Bullets per area" className="w-40" value={String(limit)} onValueChange={(v) => setLimit(Number(v))} options={[4, 8, 12, 20].map((n) => ({ value: String(n), label: `${n} per area` }))} />
        <Segmented className="sm:ml-auto" label="View" value={view} onChange={(v) => { setView(v); savePrefs.mutate({ reportView: v }); }} options={[{ value: 'narrative', label: 'Narrative' }, { value: 'bullets', label: 'Bullets' }, { value: 'delta', label: 'Period over period' }, { value: 'analysis', label: 'Full analysis', 'data-tutorial': 'analysis-full' }]} />
      </div>

      {isPending ? <Skeleton className="h-72" /> : error || !report ? <div className="card"><EmptyState title="Could not build the report" description={api.errorText(error)} /></div> : (
        <>
          {view !== 'narrative' && (edit?.kind === 'changed' || edit?.kind === 'unknown') && (
            <div role="status" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-warn/40 bg-warn/[.06] px-3 py-2 text-sm text-ink-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 flex-1">{edit.kind === 'changed' ? 'The record changed after the narrative was edited.' : 'Vantage cannot say whether the record changed since the narrative was edited.'} The PDFs use the edited text as written.</span>
              <Button size="sm" variant="ghost" onClick={() => { setView('narrative'); savePrefs.mutate({ reportView: 'narrative' }); }}>Check the narrative</Button>
            </div>
          )}
          <div className="mb-4">
            <h2 className="eyebrow mb-2">What the work produced, {report.label}</h2>
            <MetricTotalsGrid
              headline={reportMetrics.data?.headline || []}
              tracked={reportMetrics.data?.tracked || []}
              prior={reportMetrics.data?.priorHeadline || []}
              params={metricParams}
              emptyTitle="Nothing measurable in this period"
              emptyDescription="Widen the period, or add a quantity or a value to the work you logged."
            />
            <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-2">
              <Stat label="Awards in period" value={report.counts.awards} />
              <Stat label="Training hours in period" value={formatNumber(report.counts.trainingHours)} />
            </div>
          </div>

          {view === 'narrative' && (
            <NarrativeStudio
              report={report} title={effectiveTrack === 'fitrep' ? 'Section C draft' : 'Billet accomplishments'} choices={choices} setChoices={setChoices} onCopy={(t) => copy(t, 'Narrative')}
              aside={<>
                {worksheet ? <>
                  {([['PME and self-education', 'The worksheet’s PME/Self Education block: courses, PME and reading in the period.', worksheet.pme, 'PME block'],
                    ['Other', 'The worksheet’s Other block: awards, commendatory correspondence, community involvement.', worksheet.other, 'Other block']] as const).map(([title, subtitle, lines, what]) => (
                    <Panel key={title} title={title} subtitle={subtitle} action={lines.length ? <Button size="sm" variant="ghost" onClick={() => copy(lines.map((l) => `-${l}`).join('\n'), what)}><Copy className="h-3.5 w-3.5" />Copy</Button> : undefined}>
                      {lines.length ? <ul className="space-y-1 font-mono text-sm text-ink">{lines.map((l, i) => <li key={i}>-{l}</li>)}</ul> : <p className="text-sm text-ink-3">Nothing in this period.</p>}
                    </Panel>
                  ))}
                </> : <Panel title="Recognitions in period">{report.awards.length === 0 && report.trainings.length === 0 ? <p className="text-sm text-ink-3">No awards or training in this period.</p> : <ul className="space-y-1 text-sm">{report.awards.map((a: any, i: any) => <li key={`a${i}`} className="flex justify-between gap-2"><span className="truncate text-ink">{a.name}</span><span className="shrink-0 text-xs text-ink-3"><DateText value={a.date} /></span></li>)}{report.trainings.map((t: any, i: any) => <li key={`t${i}`} className="flex justify-between gap-2"><span className="truncate text-ink-2">{t.title}</span><span className="fig shrink-0 text-xs text-ink-3">{t.hours ? `${t.hours} h` : ''}</span></li>)}</ul>}</Panel>}
                {identity?.instance.aiEnabled && !subjectId && (
                  <Panel title="AI narrative draft" subtitle="From the same entries; verify every figure" action={<ModelPicker className="h-8 w-40 text-xs" />}>
                    <AiAction workflow="report_narrative" input={{ from: report.from, to: report.to, track: effectiveTrack, character_limit: report.narrative.limit }} label="Draft narrative" onResult={(output, meta2) => setAiOut({ output, meta: meta2 })} size="md" />
                    {aiOut && <div className="mt-3"><AiResult output={aiOut.output} meta={aiOut.meta} primaryKey="narrative" /></div>}
                    {!aiOut && <p className="mt-2 flex items-center gap-1.5 text-2xs text-ink-3"><Sparkles className="h-3 w-3" />Sends your entries in this period to GenAI.mil.</p>}
                  </Panel>
                )}
              </>}
            />
          )}

          {view === 'bullets' && (
            <Panel title="Bullet package" subtitle={`${report.pkg.reduce((n: number, g: any) => n + g.bullets.length, 0)} bullets across ${report.pkg.length} areas`} action={<Button size="sm" variant="ghost" onClick={() => copy(pkgText, 'Package')}><Copy className="h-3.5 w-3.5" />Copy all</Button>}>
              {!report.pkg.some((g: { count: number }) => g.count) ? <EmptyState title="Nothing to package" description="Log entries with a result and a number; those make the cut." /> : (
                <div className="space-y-5">{report.pkg.map((g: any) => (
                  <section key={g.area}><h3 className="mb-2 flex items-center justify-between text-md font-semibold text-ink">{g.area}<span className="fig text-xs font-normal text-ink-3">{g.count} entries · top {g.bullets.length}</span></h3>
                    <ul className="space-y-1.5">{g.bullets.map((b: any, i: any) => <li key={i} className="group flex items-start gap-2 rounded-md border border-line px-3 py-2 font-mono text-xs leading-relaxed text-ink"><span className="flex-1">{b.text}</span><Button variant="ghost" size="icon-xs" onClick={() => copy(b.text, 'Bullet')} className="-my-0.5 text-ink-3 transition-opacity hover:text-ink sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" aria-label={`Copy bullet ${i + 1} of ${g.area}`}><Copy className="h-3.5 w-3.5" /></Button></li>)}</ul>
                    {/* What the limit leaves out, said once after the bullets. */}
                    {g.rollup && <p className="mt-2 rounded-md bg-accent-soft/50 px-3 py-2 text-sm text-ink">{g.rollup}</p>}
                    {notShown(g) && <p className="mt-1.5 text-xs text-ink-3">{notShown(g)}</p>}
                    {g.held?.length > 0 && (
                      <div className="mt-2 rounded-md border border-dashed border-line px-3 py-2 text-xs text-ink-3">
                        <p className="mb-1 font-medium text-ink-2">Held back from the input</p>
                        <ul className="space-y-1">{g.held.map((h: { key: string; text: string; reason: string }) => <li key={h.key}><span className="text-ink-2">{h.text}</span> {h.reason}</li>)}</ul>
                      </div>
                    )}
                  </section>
                ))}</div>
              )}
            </Panel>
          )}

          {view === 'analysis' && <ReportAnalysis q={q} areaLabel={meta.areaLabel} onDownload={() => download('analysis')} />}

          {view === 'delta' && (deltaError ? <QueryFailure error={deltaError} onRetry={() => refetchDelta()} what="The comparison" /> : !delta ? <Skeleton className="h-64" /> : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Panel className="lg:col-span-2" title={`${delta.label.current} vs ${delta.label.prior}`} action={<Button size="sm" variant="ghost" onClick={() => copy(comparisonToText(delta, meta.inputName), 'Comparison')}><Copy className="h-3.5 w-3.5" />Copy</Button>}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {([['Entries', delta.headline.activities, formatNumber], ['Summable dollars', delta.headline.dollars, formatDollars], ['Reviewed dollars', delta.headline.reviewed, formatDollars], ['Quantity', delta.headline.quantity, formatNumber], ['With outcome', delta.headline.withOutcome, formatNumber], ['Awards', delta.extras.awards, formatNumber]] as Array<[string, Movement, (n: number) => string]>).map(([label, m, f]) => <MovementTile key={label} label={label} m={m} format={f} />)}
                </div>
                <h3 className="mb-2 mt-5 text-md font-semibold text-ink">By {meta.areaLabel}</h3>
                <ul className="space-y-1.5">{delta.byArea.map((a) => <li key={a.area} className="flex items-center justify-between gap-2 text-sm"><span className="text-ink">{a.area}</span><span className="flex items-center gap-2"><MovementInline m={a} format={formatNumber} /><span className="text-xs text-ink-3"><MovementInline m={a.dollars} format={formatDollars} /></span></span></li>)}</ul>
                <h3 className="mb-2 mt-5 text-md font-semibold text-ink">By dollar type</h3>
                <ul className="space-y-1.5">{delta.byDollarType.filter((d) => d.current || d.prior).map((d) => <li key={d.key} className="flex items-center justify-between text-sm"><span className="text-ink">{d.label}{!d.summable && <span className="ml-1 text-2xs text-ink-3">not summed</span>}</span><MovementInline m={d} format={formatDollars} /></li>)}</ul>
              </Panel>
              <Panel title="Reading the change"><ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">{delta.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Panel>
            </div>
          ))}
        </>
      )}
    </PageShell>
  );
}

function MovementTile({ label, m, format }: { label: string; m: Movement; format: (n: number) => string }) {
  const Icon = m.direction === 'up' ? TrendingUp : m.direction === 'down' ? TrendingDown : Minus;
  return <div className="rounded-lg border border-line p-3"><p className="text-xs text-ink-3">{label}</p><p className="fig mt-1 text-lg font-semibold text-ink">{format(m.current)}</p><p className={cn('mt-0.5 flex items-center gap-1 text-xs', m.direction === 'up' ? 'text-good' : m.direction === 'down' ? 'text-bad' : 'text-ink-3')}><Icon className="h-3.5 w-3.5" />{m.isNew ? 'new' : m.lapsed ? 'lapsed' : m.pct == null ? 'no prior' : `${m.pct >= 0 ? '+' : ''}${Math.round(m.pct)}%`}<span className="text-ink-3"> · prior {format(m.prior)}</span></p></div>;
}
function MovementInline({ m, format }: { m: Movement; format: (n: number) => string }) {
  return <span className={cn('fig text-xs', m.direction === 'up' ? 'text-good' : m.direction === 'down' ? 'text-bad' : 'text-ink-3')}>{format(m.prior)} → {format(m.current)}</span>;
}
