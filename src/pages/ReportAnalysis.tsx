import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { TrendingUp, TrendingDown, Minus, FileDown } from 'lucide-react';
import { Panel, Skeleton, EmptyState, Badge, Button } from '@/components/ui/primitives';
import { AreaChart, BarList } from '@/components/charts';
import { Table, StatusBadge } from '@/components/common';
import { keys, useMetrics } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatDollars, formatNumber } from '../../shared/metrics';
import { categoryColor } from '../../shared/constants';
import type { Analysis, Kpi } from '../../shared/analytics';
import type { Movement } from '../../shared/delta';
import { cn, humanize } from '@/lib/utils';

type Q = Record<string, string | number | undefined | null>;

const fmtBy = (kind: Kpi['format']) => (n: number) => (kind === 'money' ? formatDollars(n) : kind === 'percent' ? `${formatNumber(n)}%` : kind === 'hours' ? `${formatNumber(n)} h` : formatNumber(n));

function Delta({ m, kind = 'number' }: { m: Movement; kind?: Kpi['format'] }) {
  const Icon = m.direction === 'up' ? TrendingUp : m.direction === 'down' ? TrendingDown : Minus;
  const f = fmtBy(kind);
  return <span className={cn('fig inline-flex items-center gap-1 text-xs', m.direction === 'up' ? 'text-good' : m.direction === 'down' ? 'text-bad' : 'text-ink-3')}><Icon className="h-3.5 w-3.5" aria-hidden />{m.isNew ? 'new' : m.lapsed ? 'lapsed' : m.pct == null ? f(m.diff) : `${m.pct > 0 ? '+' : ''}${m.pct}%`}</span>;
}

export default function ReportAnalysis({ q, areaLabel, onDownload }: { q: Q; areaLabel: string; onDownload: () => void }) {
  const cfg = useMetrics();
  const { data, isPending, error } = useQuery<Analysis & { label: string; subject: string }>({ queryKey: keys.analysis(q), queryFn: () => api.reportAnalysis(q) });
  const [ledgerOpen, setLedgerOpen] = useState(false);
  if (isPending) return <Skeleton className="h-96" />;
  if (error || !data) return <div className="card"><EmptyState title="Could not build the analysis" description={api.errorText(error)} /></div>;
  const a = data;
  const money = cfg.currency_label;
  return (
    <div className="space-y-4" data-testid="analysis">
      <Panel title="Executive summary" subtitle={`${a.period.label} against ${a.prior.label}`} action={<Button size="sm" variant="primary" onClick={onDownload}><FileDown className="h-4 w-4" />Analysis PDF</Button>}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-ink">{a.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {a.kpis.map((k) => (
            <div key={k.key} className="rounded-lg border border-line p-3">
              <p className="text-xs text-ink-3">{k.label}</p>
              <p className="fig mt-1 text-lg font-semibold text-ink">{fmtBy(k.format)(k.value)}</p>
              <p className="mt-0.5 flex items-center justify-between gap-2 text-xs text-ink-3"><span className="fig">prior {fmtBy(k.format)(k.prior)}</span><Delta m={k.movement} kind={k.format} /></p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-3">
          {a.runRate.projectedEntries != null
            ? `Pace: ${Math.round((a.runRate.elapsedFraction || 0) * 100)}% of the period elapsed at ${a.runRate.entriesPerWeek} entries and ${formatDollars(a.runRate.valuePerWeek)} per week; straight-line finish near ${formatNumber(a.runRate.projectedEntries)} entries${a.runRate.projectedValue ? ` and ${formatDollars(a.runRate.projectedValue)}` : ''}.`
            : `Run rate ${a.runRate.entriesPerWeek} entries and ${formatDollars(a.runRate.valuePerWeek)} per week over ${a.runRate.weeks} weeks; prior period ${a.runRate.priorEntriesPerWeek} and ${formatDollars(a.runRate.priorValuePerWeek)}.`}
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Activity trend" subtitle={`entries per month, dashed line is ${money.toLowerCase()}`} padded={false} bodyClassName="p-3">
          {a.monthly.length > 1 ? <AreaChart ariaLabel="Entries per month" data={a.monthly.map((m) => ({ label: m.label, value: m.entries, secondary: Math.round(m.value) }))} secondaryLabel={money} /> : <p className="p-3 text-sm text-ink-3">A period of one month has no trend to draw.</p>}
        </Panel>
        <Panel title="Logging cadence">
          <dl className="space-y-1.5 text-sm">
            {([['Active days', `${a.consistency.activeDays} of ${a.consistency.spanDays}`], ['Entries per active day', String(a.consistency.entriesPerActiveDay)], ['Weeks with nothing logged', `${a.consistency.zeroWeeks} of ${a.consistency.weeks}`], ['Longest gap', `${a.consistency.longestGapDays} days`], ['Mean per week (σ)', `${a.consistency.meanPerWeek} (${a.consistency.stdevPerWeek})`], ['Busiest week', a.consistency.busiestWeek ? `${a.consistency.busiestWeek.week}: ${a.consistency.busiestWeek.entries}` : '—']] as Array<[string, string]>).map(([k, v]) => <div key={k} className="flex items-center justify-between gap-2"><dt className="text-ink-2">{k}</dt><dd className="fig text-ink">{v}</dd></div>)}
          </dl>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title={`By ${areaLabel.toLowerCase()}`}>
          <BarList items={a.byArea.map((x) => ({ label: x.name, value: x.entries, hint: `${x.share}% · ${x.outcomeRate}% with outcome` }))} />
          <ul className="mt-2 space-y-1 text-xs text-ink-3">{a.byArea.map((x) => <li key={x.name} className="flex justify-between"><span>{x.name}</span><Delta m={x.movement} /></li>)}</ul>
        </Panel>
        <Panel title="By category">
          <BarList items={a.byCategory.filter((c) => c.entries).map((x) => ({ label: x.name, value: x.entries, hint: x.value ? formatDollars(x.value) : `${x.share}%` }))} colorFor={(l) => categoryColor(l, cfg)} />
        </Panel>
        <Panel title={`${money} by type`}>
          {a.byValueType.some((t) => t.amount) ? <ul className="space-y-1.5 text-sm">{a.byValueType.filter((t) => t.amount || t.prior).map((t) => <li key={t.key} className="flex items-center justify-between gap-2"><span className="text-ink">{t.label}{!t.summable && <Badge className="ml-1">separate</Badge>}</span><span className="flex items-center gap-2"><span className="fig text-ink">{formatDollars(t.amount)}</span><span className="fig text-xs text-ink-3">{t.share}%</span><Delta m={t.movement} kind="money" /></span></li>)}</ul> : <p className="text-sm text-ink-3">No {money.toLowerCase()} recorded in this period.</p>}
          <p className="mt-3 text-xs text-ink-3">Top three entries carry {a.concentration.top3ValueShare}% of the headline; concentration index {formatNumber(a.concentration.hhi)}.</p>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`Largest entries by ${money.toLowerCase()}`} padded={false}>
          <Table head={<tr><th>Date</th><th>Entry</th><th className="text-right">Amount</th></tr>} minWidth={360}>{a.concentration.topByValue.map((e) => <tr key={e.id}><td className="fig text-xs">{e.date}</td><td className="text-ink">{e.title}<span className="block text-xs text-ink-3">{e.value_type}</span></td><td className="fig text-right">{formatDollars(e.value || 0)}</td></tr>)}{!a.concentration.topByValue.length && <tr><td colSpan={3} className="text-sm text-ink-3">Nothing valued this period.</td></tr>}</Table>
        </Panel>
        <Panel title="Largest entries by actions counted" padded={false}>
          <Table head={<tr><th>Date</th><th>Entry</th><th className="text-right">Count</th></tr>} minWidth={360}>{a.concentration.topByQuantity.map((e) => <tr key={e.id}><td className="fig text-xs">{e.date}</td><td className="text-ink">{e.title}</td><td className="fig text-right">{formatNumber(e.quantity || 0)} {e.unit_label}</td></tr>)}{!a.concentration.topByQuantity.length && <tr><td colSpan={3} className="text-sm text-ink-3">Nothing counted this period.</td></tr>}</Table>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Coverage" subtitle={`average completeness ${a.coverage.avgStrength} of 5`}>
          <ul className="space-y-2">{a.coverage.fields.map((f) => <li key={f.key}><div className="flex items-center justify-between text-sm"><span className="text-ink">{f.label}</span><span className="fig text-xs text-ink-3">{f.count} · {f.pct}%</span></div><div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"><div className={cn('h-full', f.pct >= 80 ? 'bg-good' : f.pct >= 50 ? 'bg-warn' : 'bg-bad')} style={{ width: `${f.pct}%` }} /></div></li>)}</ul>
          {(a.coverage.emptyAreas.length > 0 || a.coverage.unusedCategories.length > 0) && <p className="mt-3 text-xs text-ink-3">{a.coverage.emptyAreas.length ? `Nothing under ${a.coverage.emptyAreas.join(', ')}. ` : ''}{a.coverage.unusedCategories.length ? `Unused: ${a.coverage.unusedCategories.join(', ')}.` : ''}</p>}
        </Panel>
        <Panel title="Data quality">
          {a.quality.length ? <ul className="space-y-2 text-sm">{a.quality.map((qi) => <li key={qi.key}><span className="fig font-semibold text-ink">{qi.count}</span> <span className="text-ink">{qi.label}</span><span className="block text-xs text-ink-3">{qi.detail}</span></li>)}</ul> : <p className="text-sm text-ink-3">No open issues. Every entry is dated, tagged, and carries an outcome.</p>}
        </Panel>
        <Panel title="Goals" subtitle={`${a.goals.active} active · ${a.goals.achieved} achieved · attainment ${a.goals.attainment}%`}>
          {a.goals.items.length ? <ul className="space-y-2">{a.goals.items.slice(0, 8).map((g, i) => <li key={i}><div className="flex items-center justify-between gap-2 text-sm"><span className="truncate text-ink">{g.title}</span><span className="flex items-center gap-2"><StatusBadge value={g.status} /><span className="fig text-xs text-ink-3">{g.pct}%</span></span></div><div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"><div className="h-full bg-accent" style={{ width: `${g.pct}%` }} /></div></li>)}</ul> : <p className="text-sm text-ink-3">No goals in this period.</p>}
        </Panel>
      </div>

      <Panel title="Career record" subtitle={`${formatNumber(a.career.trainingHours)} training hours · ${a.career.awards.length} awards · ${a.career.counselings.count} counselings`}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3 text-sm">
          <div><p className="eyebrow mb-1">Training</p>{a.career.hoursByType.length ? <ul className="space-y-1">{a.career.hoursByType.map((t) => <li key={t.type} className="flex justify-between"><span className="text-ink">{humanize(t.type)}</span><span className="fig text-ink-2">{formatNumber(t.hours)} h · {t.count}</span></li>)}</ul> : <p className="text-ink-3">None in period.</p>}</div>
          <div><p className="eyebrow mb-1">Awards</p>{a.career.awards.length ? <ul className="space-y-1">{a.career.awards.map((w, i) => <li key={i} className="flex justify-between gap-2"><span className="truncate text-ink">{w.name}</span><StatusBadge value={w.status} /></li>)}</ul> : <p className="text-ink-3">None in period.</p>}</div>
          <div><p className="eyebrow mb-1">Counseling</p><p className="text-ink-2">{a.career.counselings.count ? `${a.career.counselings.count} sessions${a.career.counselings.avgIntervalDays ? `, every ${a.career.counselings.avgIntervalDays} days` : ''}${a.career.counselings.lastDate ? `, last ${a.career.counselings.lastDate}` : ''}${a.career.counselings.unacknowledged ? `, ${a.career.counselings.unacknowledged} unacknowledged` : ''}.` : 'None in period.'}</p></div>
        </div>
      </Panel>

      <Panel title="Entry ledger" subtitle={`${a.appendix.length} completed entries in ${a.period.label}`} action={<Button size="sm" variant="ghost" onClick={() => setLedgerOpen((v) => !v)}>{ledgerOpen ? 'Hide' : 'Show all'}</Button>} padded={false}>
        {ledgerOpen ? (
          <Table head={<tr><th>Date</th><th>Entry</th><th>Area</th><th className="text-right">Count</th><th className="text-right">{money}</th><th>Outcome</th><th className="text-right">Score</th></tr>} minWidth={760}>
            {a.appendix.map((e) => <tr key={e.id}><td className="fig text-xs">{e.date}</td><td className="text-ink">{e.title}</td><td className="text-xs text-ink-2">{e.area}</td><td className="fig text-right text-xs">{e.quantity == null ? '' : `${formatNumber(e.quantity)} ${e.unit_label || ''}`}</td><td className="fig text-right text-xs">{e.value == null ? '' : formatDollars(e.value)}</td><td className="text-xs text-ink-2">{e.result}</td><td className="fig text-right text-xs">{e.strength}</td></tr>)}
          </Table>
        ) : <p className="px-4 py-3 text-sm text-ink-3">The PDF always includes the full ledger as an appendix.</p>}
      </Panel>
    </div>
  );
}
