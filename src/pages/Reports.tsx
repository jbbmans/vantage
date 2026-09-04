import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { FileDown, Download, Copy, TrendingUp, TrendingDown, Minus, Sparkles } from 'lucide-react';
import { PageHeader, Button, Select, Panel, Segmented, Badge, Skeleton, EmptyState, Stat } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { AiAction, AiResult, ModelPicker } from '@/components/AiPanel';
import { PeriodSelect, DateText } from '@/components/common';
import { keys, useIdentity, usePrefs, useSavePrefs, useTeam, useTrack, useMetrics } from '@/lib/queries';
import * as api from '@/lib/api';
import { packageToText } from '../../shared/bullets';
import { comparisonToText, type Comparison, type Movement } from '../../shared/delta';
import { formatDollars, formatNumber } from '../../shared/metrics';
import { trackMeta, type Track } from '../../shared/evaluation';
import { copyToClipboard, cn } from '@/lib/utils';

export default function Reports() {
  const cfg = useMetrics();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const savePrefs = useSavePrefs();
  const myTrack = useTrack();
  const [params] = useSearchParams();
  const subjectId = params.get('user') || '';
  const unitParam = params.get('unit') || '';
  const { data: team } = useTeam(Boolean(identity?.canLead));
  const [period, setPeriod] = useState(prefs.reportPeriod || 'fiscalYear');
  const [style, setStyle] = useState<'jepes' | 'fitrep' | 'resume'>(myTrack === 'fitrep' ? 'fitrep' : 'jepes');
  const [track, setTrack] = useState<Track | ''>('');
  const [view, setView] = useState<'narrative' | 'bullets' | 'delta'>((prefs.reportView as never) || 'narrative');
  const [limit, setLimit] = useState(8);
  const [aiOut, setAiOut] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const q = { period, style, track: track || undefined, limit, user_id: subjectId || undefined, unit_id: unitParam || undefined };
  const { data: report, isPending, error } = useQuery({ queryKey: keys.report(q), queryFn: () => api.report(q) });
  const { data: delta } = useQuery<Comparison>({ queryKey: keys.delta(q), queryFn: () => api.reportDelta(q), enabled: view === 'delta' });
  const subject = subjectId ? (team?.roster || []).find((r: any) => r.id === subjectId) : null;
  const effectiveTrack: Track = report?.track || myTrack;
  const meta = trackMeta(effectiveTrack);
  const pkgText = useMemo(() => (report ? packageToText(report.pkg, `${meta.inputName} · ${report.subject} · ${report.label}`) : ''), [report, meta.inputName]);
  const copy = async (text: string, what: string) => { if (await copyToClipboard(text)) toast.success(`${what} copied.`); else toast.error('Could not copy.'); };
  const download = async (kind: 'pdf' | 'csv') => {
    try { const name = await api.downloadFile(kind === 'pdf' ? api.reportPdfUrl({ ...q, limit: 12 }) : api.reportCsvUrl(q), kind === 'pdf' ? 'vantage-report.pdf' : 'vantage-activities.csv'); toast.success(`Downloaded ${name}.`); }
    catch (e) { toast.error(api.errorText(e)); }
  };

  return (
    <div className="page">
      <PageHeader eyebrow="Reports" title={subject ? `${meta.inputName} for ${subject.rank_abbr || ''} ${subject.last_name}` : meta.inputName} lede={`A narrative and a bullet package built from ${subject ? 'their shared' : 'your'} logged entries. Copy it, or export a PDF to hand to the reporting senior.`}>
        <Button onClick={() => download('csv')}><Download className="h-4 w-4" />CSV</Button>
        <Button variant="primary" onClick={() => download('pdf')}><FileDown className="h-4 w-4" />Export PDF</Button>
      </PageHeader>

      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <PeriodSelect value={period} onChange={(v) => { setPeriod(v); savePrefs.mutate({ reportPeriod: v }); }} className="w-44" />
        <Select aria-label="Evaluation system" className="w-40" value={track || 'auto'} onValueChange={(v) => setTrack(v === 'auto' ? '' : (v as Track))} options={[{ value: 'auto', label: `By rank (${meta.name})` }, { value: 'jepes', label: 'JEPES' }, { value: 'fitrep', label: 'FITREP' }]} />
        <Select aria-label="Bullet style" className="w-36" value={style} onValueChange={(v) => setStyle(v as never)} options={[{ value: 'jepes', label: 'JEPES style' }, { value: 'fitrep', label: 'FITREP style' }, { value: 'resume', label: 'Résumé style' }]} />
        <Select aria-label="Bullets per area" className="w-40" value={String(limit)} onValueChange={(v) => setLimit(Number(v))} options={[4, 8, 12, 20].map((n) => ({ value: String(n), label: `${n} per area` }))} />
        <Segmented className="ml-auto" label="View" value={view} onChange={(v) => { setView(v); savePrefs.mutate({ reportView: v }); }} options={[{ value: 'narrative', label: 'Narrative' }, { value: 'bullets', label: 'Bullets' }, { value: 'delta', label: 'Period over period' }]} />
      </div>

      {isPending ? <Skeleton className="h-72" /> : error || !report ? <div className="card"><EmptyState title="Could not build the report" description={api.errorText(error)} /></div> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Entries" value={formatNumber(report.counts.activities)} hint={report.label} />
            <Stat label={`Summable ${cfg.currency_label.toLowerCase()}`} value={formatDollars(report.metrics.totalDollars)} hint={report.metrics.reviewedDollars ? `${formatDollars(report.metrics.reviewedDollars)} reviewed` : 'reconciled, obligated, saved, impact'} tone="accent" />
            <Stat label="Awards" value={report.counts.awards} hint="in period" />
            <Stat label="Training hours" value={formatNumber(report.counts.trainingHours)} hint="in period" />
          </div>

          {view === 'narrative' && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Panel className="lg:col-span-2" title={`Section I narrative (${meta.name})`} subtitle={`${report.narrative.length} of ${report.narrative.limit} characters${report.narrative.omitted ? ` · ${report.narrative.omitted} supporting sentences did not fit` : ''}`} action={<Button size="sm" variant="ghost" onClick={() => copy(report.narrative.text, 'Narrative')}><Copy className="h-3.5 w-3.5" />Copy</Button>}>
                {report.narrative.text ? <p className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-ink">{report.narrative.text}</p> : <EmptyState title="Nothing logged in this period" description="Widen the period, or log the work you did." />}
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"><div className={cn('h-full', report.narrative.fits ? 'bg-accent' : 'bg-bad')} style={{ width: `${Math.min(100, (report.narrative.length / report.narrative.limit) * 100)}%` }} /></div>
                {report.narrative.areas?.length > 0 && <ul className="mt-3 flex flex-wrap gap-1.5">{report.narrative.areas.map((a: any) => <li key={a.area}><Badge>{a.label} · {a.count} entries · {a.included}/{a.available} support</Badge></li>)}</ul>}
              </Panel>
              <div className="space-y-4">
                <Panel title="Recognitions in period">{report.awards.length === 0 && report.trainings.length === 0 ? <p className="text-sm text-ink-3">No awards or training in this period.</p> : <ul className="space-y-1 text-sm">{report.awards.map((a: any, i: number) => <li key={`a${i}`} className="flex justify-between gap-2"><span className="truncate text-ink">{a.name}</span><span className="shrink-0 text-xs text-ink-3"><DateText value={a.date} /></span></li>)}{report.trainings.map((t: any, i: number) => <li key={`t${i}`} className="flex justify-between gap-2"><span className="truncate text-ink-2">{t.title}</span><span className="fig shrink-0 text-xs text-ink-3">{t.hours ? `${t.hours} h` : ''}</span></li>)}</ul>}</Panel>
                {identity?.instance.aiEnabled && !subjectId && (
                  <Panel title="AI narrative draft" subtitle="from the same entries; verify every figure" action={<ModelPicker className="h-8 w-40 text-xs" />}>
                    <AiAction workflow="report_narrative" input={{ from: report.from, to: report.to, track: effectiveTrack, character_limit: report.narrative.limit }} label="Draft narrative" onResult={(output, meta2) => setAiOut({ output, meta: meta2 })} size="md" />
                    {aiOut && <div className="mt-3"><AiResult output={aiOut.output} meta={aiOut.meta} primaryKey="narrative" /></div>}
                    {!aiOut && <p className="mt-2 flex items-center gap-1.5 text-2xs text-ink-3"><Sparkles className="h-3 w-3" />Sends your entries in this period to GenAI.mil.</p>}
                  </Panel>
                )}
              </div>
            </div>
          )}

          {view === 'bullets' && (
            <Panel title="Bullet package" subtitle={`${report.pkg.reduce((n: number, g: any) => n + g.bullets.length, 0)} bullets across ${report.pkg.length} areas`} action={<Button size="sm" variant="ghost" onClick={() => copy(pkgText, 'Package')}><Copy className="h-3.5 w-3.5" />Copy all</Button>}>
              {report.pkg.length === 0 ? <EmptyState title="Nothing to package" description="Log entries with a result and a number; those make the cut." /> : (
                <div className="space-y-5">{report.pkg.map((g: any) => (
                  <section key={g.area}><h3 className="mb-2 flex items-center justify-between text-sm font-semibold text-ink">{g.area}<span className="fig text-xs font-normal text-ink-3">{g.count} entries · top {g.bullets.length}</span></h3>
                    {g.rollup && <p className="mb-2 rounded-md bg-accent-soft/50 px-3 py-2 text-sm text-ink">{g.rollup}</p>}
                    <ul className="space-y-1.5">{g.bullets.map((b: any, i: number) => <li key={i} className="group flex items-start gap-2 rounded-md border border-line px-3 py-2 font-mono text-xs leading-relaxed text-ink"><span className="flex-1">{b.text}</span><button type="button" onClick={() => copy(b.text, 'Bullet')} className="text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100" aria-label="Copy bullet"><Copy className="h-3.5 w-3.5" /></button></li>)}</ul>
                  </section>
                ))}</div>
              )}
            </Panel>
          )}

          {view === 'delta' && (!delta ? <Skeleton className="h-64" /> : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Panel className="lg:col-span-2" title={`${delta.label.current} vs ${delta.label.prior}`} action={<Button size="sm" variant="ghost" onClick={() => copy(comparisonToText(delta, meta.inputName), 'Comparison')}><Copy className="h-3.5 w-3.5" />Copy</Button>}>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {([['Entries', delta.headline.activities, formatNumber], ['Summable dollars', delta.headline.dollars, formatDollars], ['Reviewed dollars', delta.headline.reviewed, formatDollars], ['Quantity', delta.headline.quantity, formatNumber], ['With outcome', delta.headline.withOutcome, formatNumber], ['Awards', delta.extras.awards, formatNumber]] as Array<[string, Movement, (n: number) => string]>).map(([label, m, f]) => <MovementTile key={label} label={label} m={m} format={f} />)}
                </div>
                <h3 className="mb-2 mt-5 text-sm font-semibold text-ink">By {meta.areaLabel.toLowerCase()}</h3>
                <ul className="space-y-1.5">{delta.byArea.map((a) => <li key={a.area} className="flex items-center justify-between gap-2 text-sm"><span className="text-ink">{a.area}</span><span className="flex items-center gap-2"><MovementInline m={a} format={formatNumber} /><span className="text-xs text-ink-3"><MovementInline m={a.dollars} format={formatDollars} /></span></span></li>)}</ul>
                <h3 className="mb-2 mt-5 text-sm font-semibold text-ink">By dollar type</h3>
                <ul className="space-y-1.5">{delta.byDollarType.filter((d) => d.current || d.prior).map((d) => <li key={d.key} className="flex items-center justify-between text-sm"><span className="text-ink">{d.label}{!d.summable && <span className="ml-1 text-2xs text-ink-3">not summed</span>}</span><MovementInline m={d} format={formatDollars} /></li>)}</ul>
              </Panel>
              <Panel title="Reading the change"><ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink-2">{delta.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Panel>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function MovementTile({ label, m, format }: { label: string; m: Movement; format: (n: number) => string }) {
  const Icon = m.direction === 'up' ? TrendingUp : m.direction === 'down' ? TrendingDown : Minus;
  return <div className="rounded-lg border border-line p-3"><p className="text-xs text-ink-3">{label}</p><p className="fig mt-1 text-lg font-semibold text-ink">{format(m.current)}</p><p className={cn('mt-0.5 flex items-center gap-1 text-xs', m.direction === 'up' ? 'text-good' : m.direction === 'down' ? 'text-bad' : 'text-ink-3')}><Icon className="h-3.5 w-3.5" />{m.isNew ? 'new' : m.lapsed ? 'lapsed' : m.pct == null ? 'no prior' : `${m.pct >= 0 ? '+' : ''}${Math.round(m.pct)}%`}<span className="text-ink-3"> · prior {format(m.prior)}</span></p></div>;
}
function MovementInline({ m, format }: { m: Movement; format: (n: number) => string }) {
  return <span className={cn('fig text-xs', m.direction === 'up' ? 'text-good' : m.direction === 'down' ? 'text-bad' : 'text-ink-3')}>{format(m.prior)} → {format(m.current)}</span>;
}
