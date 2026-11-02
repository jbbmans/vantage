import { useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, ArrowRight, Check, FileSpreadsheet, FileWarning, Printer, Upload } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, NumberInput, Panel, Segmented, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { PageShell, Table } from '@/components/common';
import { AreaChart } from '@/components/charts';
import { QueryFailure } from '@/components/QueryFailure';
import { SamplePreview, ScanNotice, type ImportSource, type Inspection } from '@/components/ImportWizard';
import { can, useIdentity } from '@/lib/queries';
import { subtreeOf, useView, viewLabel } from '@/lib/view';
import { usePlace } from '@/lib/place';
import { cn, formatStamp, todayIso } from '@/lib/utils';
import * as api from '@/lib/api';
import { PERMISSIONS } from '../../shared/permissions';
import { formatCents } from '../../shared/money';
import { formatDate, formatNumber } from '../../shared/metrics';
import {
  AGE_BASIS_LABELS, COLUMN_ROLES, COLUMN_ROLE_LABELS, DRILL_LABELS, FLAG_LABELS, SINGLE_ROLES, STANDING_LABELS, closedByDefault, guessRole, normalStatus,
  type ChangeFlag, type ColumnRole, type Drill, type DrillGroup, type ErrorFigure, type ErrorReportLayout, type ErrorReportPreview,
  type ErrorReportType, type ErrorReportsOverview, type GroupLine, type SnapshotSummary, type Standing,
} from '../../shared/errorReports';

const errorKeys = {
  all: ['error-reports'] as const,
  overview: (unitId: string) => ['error-reports', 'overview', unitId] as const,
  series: (q: api.ErrorComparisonQuery) => ['error-reports', 'series', q] as const,
  rows: (q: object) => ['error-reports', 'rows', q] as const,
};
// Reading a unit's error reports is audited, so a page reads them when it opens, not again on every focus.
const READ = { staleTime: 60_000, refetchOnWindowFocus: false, retry: false } as const;

const day = (iso: string) => formatDate(iso, 'dd MMM yyyy');
const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/**
 * Financial error reports (Task 15, ADR-0021): the ULO, OCMT, UMT, invoices-on-hold and sync-error reports a unit is
 * sent, each filed as it stood on its day and kept as filed, and any two of a series compared: what is new, still
 * open, back, or resolved, what changed, and the figures that follow, each opening the rows behind it. What a person
 * may read, file or take away is the server's to decide; the page shows what it says.
 */
export default function ErrorReports() {
  const place = usePlace();
  const { data: identity } = useIdentity();
  const { view, views } = useView(identity);
  const [search, setSearch] = useSearchParams();
  const unitId = search.get('unit') || view?.id || '';
  const typeId = search.get('type') || '';
  const setQuery = (patch: Record<string, string>) => setSearch((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });
  const [filing, setFiling] = useState<{ unitId: string; typeId: string } | null>(null);
  const overview = useQuery({ queryKey: errorKeys.overview(unitId), queryFn: () => api.errorReports(unitId), enabled: Boolean(unitId), ...READ });
  // A report is filed for this unit or one beneath it, by someone who may post its work.
  const filingUnits = useMemo(() => {
    if (!overview.data) return [];
    const ids = subtreeOf(views, overview.data.unit.id);
    return views.filter((v) => ids.includes(v.id) && v.level === 'full' && can(identity, PERMISSIONS.CREATE_SHARED_WORK, v.id));
  }, [overview.data, views, identity]);
  const openSeries = (u: string, t: string) => setQuery({ unit: u === view?.id ? '' : u, type: t, report: '', against: '' });
  const startFiling = (t = typeId) => setFiling({ unitId: filingUnits.some((u) => u.id === unitId) ? unitId : filingUnits[0]?.id ?? unitId, typeId: t });
  const canFile = Boolean(overview.data?.can.file || filingUnits.length);

  const lede = 'The error reports your units are sent, each filed as it stood on its day and kept as filed, then compared report to report: what is new, still open, back or resolved, and every figure opens the rows behind it.';
  if (!unitId) {
    return <PageShell eyebrow={place.group} title="Error reports" lede={lede}><div className="card"><EmptyState icon={FileWarning} title="No unit to show" description="Error reports are filed for a unit. Join one, or ask a leader to add you." /></div></PageShell>;
  }
  return (
    <PageShell
      eyebrow={place.group} title="Error reports" lede={lede}
      actions={canFile && overview.data ? <Button variant="primary" onClick={() => startFiling()}><Upload className="h-4 w-4" aria-hidden />File a report</Button> : null}
    >
      {overview.isPending ? <Skeleton className="h-64" />
        : overview.isError || !overview.data ? (
          <QueryFailure error={overview.error} what="The unit’s error reports" onRetry={() => overview.refetch()}
            denied={{ title: 'Error reports are not available for this unit', description: 'They need permission to view the unit’s shared records.' }} />
        ) : typeId ? (
          <Series unitId={unitId} typeId={typeId} overview={overview.data} onBack={() => setQuery({ unit: '', type: '', report: '', against: '' })}
            onFile={() => startFiling(typeId)} search={search} setQuery={setQuery} canFile={canFile} />
        ) : (
          <Overview data={overview.data} onOpen={openSeries} onFile={canFile ? () => startFiling('') : undefined} />
        )}
      {filing && overview.data ? (
        <FileDialog
          types={overview.data.types.filter((t) => t.active)} units={filingUnits.map((u) => ({ id: u.id, label: viewLabel(u) }))}
          initial={filing} onClose={() => setFiling(null)}
          onFiled={(s) => { setFiling(null); openSeries(s.unit_id, s.type_id); }}
        />
      ) : null}
    </PageShell>
  );
}

// ——— Every series of the unit ———

function Overview({ data, onOpen, onFile }: { data: ErrorReportsOverview; onOpen: (unitId: string, typeId: string) => void; onFile?: () => void }) {
  if (!data.series.length) {
    return (
      <div className="card">
        <EmptyState icon={FileWarning} title={`No error report is filed for ${data.unit.name} yet`}
          description="File each report the unit is sent, such as the ULO, OCMT, UMT, invoices on hold or sync errors. Each is kept as it stood on its day, and the next of its kind is compared with it."
          action={onFile ? <Button variant="primary" onClick={onFile}><Upload className="h-4 w-4" aria-hidden />File the first report</Button> : undefined} />
      </div>
    );
  }
  return (
    <Panel title={`${data.unit.name} and the units beneath it`} subtitle="Each kind of report a unit files is a series. Open one to compare its reports." padded={false}>
      <Table minWidth={760} head={<>
        <th scope="col">Report</th><th scope="col">Unit</th><th scope="col" className="text-right">Filed</th><th scope="col">Latest</th>
        <th scope="col" className="text-right">Open</th><th scope="col" className="text-right">Value open</th><th scope="col" className="text-right">Since the one before</th><th scope="col" className="relative"><span className="sr-only">Actions</span></th>
      </>}>
        {data.series.map((s) => {
          const change = s.latest && s.previous ? s.latest.open_count - s.previous.open_count : null;
          return (
            <tr key={`${s.unit_id}-${s.type_id}`}>
              <td><span className="font-medium text-ink">{s.code}</span><span className="block text-xs text-ink-3">{s.name}</span></td>
              <td className="text-ink-2">{s.unit_name}</td>
              <td className="fig text-right">{formatNumber(s.reports)}{s.withdrawn ? <span className="block text-2xs text-ink-3">{formatNumber(s.withdrawn)} withdrawn</span> : null}</td>
              <td>{s.latest ? <span className="fig">{day(s.latest.as_of)}</span> : <span className="text-ink-3">None standing</span>}</td>
              <td className="fig text-right">{s.latest ? formatNumber(s.latest.open_count) : '—'}</td>
              <td className="fig text-right">{s.latest ? formatCents(s.latest.open_cents) : '—'}</td>
              <td className={cn('fig text-right', change != null && change > 0 && 'text-bad', change != null && change < 0 && 'text-good')}>
                {change == null ? <span className="text-ink-3">First report</span> : change === 0 ? 'No change' : `${change > 0 ? '+' : ''}${formatNumber(change)}`}
              </td>
              <td className="text-right"><Button size="sm" onClick={() => onOpen(s.unit_id, s.type_id)} aria-label={`Open the ${s.code} reports of ${s.unit_name}`}>Open<ArrowRight className="h-3.5 w-3.5" aria-hidden /></Button></td>
            </tr>
          );
        })}
      </Table>
    </Panel>
  );
}

// ——— One series: two of its reports compared ———

interface DrillAsk { drill: Drill; group?: DrillGroup; value?: string; title: string }

const GROUPS: Array<{ value: DrillGroup; label: string }> = [{ value: 'category', label: 'Error type' }, { value: 'unit', label: 'Unit or office' }, { value: 'owner', label: 'Marine' }];

function Series({ unitId, typeId, overview, onBack, onFile, search, setQuery, canFile }: {
  unitId: string; typeId: string; overview: ErrorReportsOverview; onBack: () => void; onFile: () => void;
  search: URLSearchParams; setQuery: (patch: Record<string, string>) => void; canFile: boolean;
}) {
  const q: api.ErrorComparisonQuery = { unit_id: unitId, type_id: typeId, snapshot: search.get('report') || undefined, against: search.get('against') || undefined };
  const result = useQuery({ queryKey: errorKeys.series(q), queryFn: () => api.errorComparison(q), placeholderData: keepPreviousData, ...READ });
  const [drill, setDrill] = useState<DrillAsk | null>(null);
  const [group, setGroup] = useState<DrillGroup>('category');
  const [withdrawing, setWithdrawing] = useState<SnapshotSummary | null>(null);
  const type = overview.types.find((t) => t.id === typeId);
  const back = <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden />All error reports</Button>;

  if (result.isPending) return <div className="space-y-3">{back}<Skeleton className="h-96" /></div>;
  if (result.isError || !result.data) {
    const missing = (result.error as { status?: number } | null)?.status === 404;
    return (
      <div className="space-y-3">
        {back}
        {missing ? (
          <div className="card">
            <EmptyState icon={FileWarning} title={type ? `No ${type.code} report is filed here yet` : 'No such series'} description={api.errorText(result.error)}
              action={canFile && type?.active ? <Button variant="primary" onClick={onFile}><Upload className="h-4 w-4" aria-hidden />File one</Button> : undefined} />
          </div>
        ) : <QueryFailure error={result.error} what="This comparison" onRetry={() => result.refetch()} />}
      </div>
    );
  }
  if (result.data.after === null) {
    // Every report of the series was withdrawn: nothing to compare, and each is still listed, with why.
    const h = result.data;
    return (
      <div className="space-y-4">
        {back}
        <Panel title={<span>{h.type.code} · {h.type.name}</span>} subtitle={`${h.unit.name}${h.type.description ? ` · ${h.type.description}` : ''}`}>
          <p className="text-sm text-ink-2">{h.notes[0]}</p>
        </Panel>
        <ReportsFiled reports={h.reports} />
      </div>
    );
  }
  const r = result.data;
  const live = r.reports.filter((s) => !s.withdrawn);
  const at = live.findIndex((s) => s.id === r.after.id);
  const earlier = live.slice(at + 1);
  const groups = GROUPS.filter((g) => g.value !== 'owner' || r.groups.owner);
  const lines: GroupLine[] = (group === 'owner' ? r.groups.owner : r.groups[group]) ?? [];
  const library = `/reports/library?${new URLSearchParams({ type: 'comparison', subject: 'unit', unit_id: unitId, error_type: typeId, snapshot: r.after.id, ...(r.before ? { against: r.before.id } : {}) })}`;
  const count = (d: Drill) => r.summary.counts[d] ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {back}
        <div className="flex flex-wrap items-center gap-2">
          {canFile && r.type.active ? <Button onClick={onFile}><Upload className="h-4 w-4" aria-hidden />File the next report</Button> : null}
          <Button asChild><Link to={library}><Printer className="h-4 w-4" aria-hidden />Print or take a file</Link></Button>
        </div>
      </div>

      <Panel title={<span>{r.type.code} · {r.type.name}</span>} subtitle={`${r.unit.name}${r.type.description ? ` · ${r.type.description}` : ''}`}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Report" hint={`${r.after.filename} · filed by ${r.after.filed_by} ${formatStamp(r.after.filed_at)}`}>
            <Select value={r.after.id} onValueChange={(v) => setQuery({ report: v, against: '' })} options={live.map((s) => ({ value: s.id, label: `${day(s.as_of)} · ${s.filename}` }))} />
          </Field>
          <Field label="Compared with" hint={r.before ? `${r.before.filename} · ${plural(r.before.open_count, 'open error')}` : 'No earlier report stands in this series.'}>
            <Select value={r.before?.id ?? ''} disabled={!earlier.length} onValueChange={(v) => setQuery({ against: v })} placeholder="No earlier report"
              options={earlier.map((s, i) => ({ value: s.id, label: `${day(s.as_of)}${i === 0 ? ' (the one before)' : ''}` }))} />
          </Field>
        </div>
      </Panel>

      <section aria-labelledby="figures-heading" className="space-y-2">
        <h2 id="figures-heading" className="text-md font-semibold text-ink">{r.before ? `${day(r.after.as_of)} against ${day(r.before.as_of)}` : `The report of ${day(r.after.as_of)}`}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {r.summary.figures.map((f) => (
            <FigureCard key={f.id} figure={f} disabled={!f.drill || f.value == null || count(f.drill) === 0}
              onOpen={() => f.drill && setDrill({ drill: f.drill, title: f.drill === f.id ? f.label : `${DRILL_LABELS[f.drill]}, behind ${f.label.toLowerCase()}` })} />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel className="xl:col-span-2" title="By error type, unit and Marine" subtitle={r.before ? 'What each holds open now, and what came and went since the earlier report' : 'What each holds open on this report'} padded={false}
          action={<Segmented size="sm" label="Group by" value={group} onChange={setGroup} options={groups} />}>
          {!lines.length ? <p className="px-4 py-6 text-sm text-ink-3">Nothing is open on either report.</p> : (
            <Table minWidth={r.before ? 720 : 360} head={<>
              <th scope="col">{GROUPS.find((g) => g.value === group)?.label}</th><th scope="col" className="text-right">Open</th><th scope="col" className="text-right">Value open</th>
              {r.before ? <><th scope="col" className="text-right">New</th><th scope="col" className="text-right">Still open</th><th scope="col" className="text-right">Reopened</th><th scope="col" className="text-right">Resolved</th><th scope="col" className="text-right">Value resolved</th></> : null}
            </>}>
              {lines.map((l) => {
                const cell = (d: Drill, n: number) => (
                  <td className="fig text-right">
                    {n ? <button type="button" className="link" onClick={() => setDrill({ drill: d, group, value: l.value, title: `${DRILL_LABELS[d]}: ${l.label}` })} aria-label={`${DRILL_LABELS[d]} for ${l.label}: ${n}. Show the rows`}>{formatNumber(n)}</button> : <span className="text-ink-3">0</span>}
                  </td>
                );
                return (
                  <tr key={l.value || 'none'}>
                    <td className={cn(!l.value && 'text-ink-3')}>{l.label}</td>
                    {cell('open', l.open)}
                    <td className="fig text-right">{formatCents(l.open_cents)}</td>
                    {r.before ? <>{cell('new', l.new)}{cell('still_open', l.still_open)}{cell('reopened', l.reopened)}{cell('resolved', l.resolved)}<td className="fig text-right">{formatCents(l.resolved_cents)}</td></> : null}
                  </tr>
                );
              })}
            </Table>
          )}
        </Panel>
        <Panel title="Oldest open" subtitle={r.summary.ages.oldest != null ? `The oldest is ${plural(r.summary.ages.oldest, 'day')} old` : 'No open error has an age yet'}>
          {!r.oldest.length ? <p className="text-sm text-ink-3">An age needs an opened date or an age column, or a second report.</p> : (
            <ol className="space-y-2">
              {r.oldest.map((o) => (
                <li key={o.key} className="flex items-start justify-between gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="fig block truncate font-medium text-ink">{o.identifier}</span>
                    <span className="block truncate text-xs text-ink-3">{[o.category, o.description, o.owner].filter(Boolean).join(' · ') || 'No detail'}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="fig block text-ink" title={AGE_BASIS_LABELS[o.basis]}>{plural(o.days, 'day')}</span>
                    <span className="fig block text-xs text-ink-3">{o.amount_cents == null ? 'No amount' : formatCents(o.amount_cents)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>

      {r.trend.length > 1 ? (
        <Panel title="Open on each report" subtitle={`The last ${plural(r.trend.length, 'report')} of the series`}>
          <AreaChart data={r.trend.map((t) => ({ label: formatDate(t.as_of, 'dd MMM'), value: t.open_count }))} format={(v) => formatNumber(v)} ariaLabel={`Open errors on each ${r.type.code} report`} />
        </Panel>
      ) : null}

      <ReportsFiled reports={r.reports} afterId={r.after.id} beforeId={r.before?.id}
        onCompare={(s) => setQuery({ report: s.id, against: '' })} onWithdraw={r.can.file ? setWithdrawing : undefined} />

      <ul className="space-y-1 text-xs text-ink-3">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>

      {drill ? <DrillDialog ask={drill} q={{ ...q, snapshot: r.after.id, against: r.before?.id }} onClose={() => setDrill(null)} /> : null}
      {withdrawing ? (
        <WithdrawDialog report={withdrawing} code={r.type.code} onClose={() => setWithdrawing(null)}
          onDone={() => { const cleared = withdrawing.id === r.after.id || withdrawing.id === r.before?.id; setWithdrawing(null); if (cleared) setQuery({ report: '', against: '' }); }} />
      ) : null}
    </div>
  );
}

/** Every report of a series, newest first: a withdrawn one is kept, with who withdrew it and why. */
function ReportsFiled({ reports, afterId, beforeId, onCompare, onWithdraw }: {
  reports: SnapshotSummary[]; afterId?: string; beforeId?: string;
  onCompare?: (s: SnapshotSummary) => void; onWithdraw?: (s: SnapshotSummary) => void;
}) {
  return (
    <Panel title="Every report filed" subtitle="Newest first. A withdrawn report is kept, with why, and is in no comparison." padded={false}>
      <Table minWidth={820} head={<>
        <th scope="col">Stands on</th><th scope="col">File</th><th scope="col" className="text-right">Rows</th><th scope="col" className="text-right">Open</th><th scope="col" className="text-right">Value open</th>
        <th scope="col" className="text-right">Refused</th><th scope="col">Filed</th><th scope="col" className="relative"><span className="sr-only">Actions</span></th>
      </>}>
        {reports.map((s) => (
          <tr key={s.id} className={cn(s.withdrawn && 'text-ink-3')}>
            <td className="fig">{day(s.as_of)}{s.id === afterId ? <Badge tone="accent" className="ml-2">This report</Badge> : s.id === beforeId ? <Badge tone="neutral" className="ml-2">Compared with</Badge> : null}</td>
            <td className="max-w-[16rem] truncate">{s.filename}{s.note ? <span className="block truncate text-xs text-ink-3">{s.note}</span> : null}</td>
            <td className="fig text-right">{formatNumber(s.row_count)}</td>
            <td className="fig text-right">{formatNumber(s.open_count)}</td>
            <td className="fig text-right">{formatCents(s.open_cents)}</td>
            <td className="fig text-right">{s.rejected_rows ? formatNumber(s.rejected_rows) : '—'}</td>
            <td className="text-xs">{s.filed_by}<span className="block text-ink-3">{formatStamp(s.filed_at)}</span>
              {s.withdrawn ? <span className="mt-1 block"><Badge tone="warn">Withdrawn</Badge> <span className="text-ink-2">{s.withdrawn.by}, {formatStamp(s.withdrawn.at)}: {s.withdrawn.reason}</span></span> : null}
            </td>
            <td className="whitespace-nowrap text-right">
              {!s.withdrawn && onCompare && s.id !== afterId ? <Button size="xs" variant="ghost" onClick={() => onCompare(s)} aria-label={`Compare the report of ${day(s.as_of)}`}>Compare</Button> : null}
              {!s.withdrawn && onWithdraw ? <Button size="xs" variant="ghost" onClick={() => onWithdraw(s)} aria-label={`Withdraw the report of ${day(s.as_of)}`}>Withdraw</Button> : null}
            </td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}

function figureText(f: ErrorFigure): string {
  if (f.value == null) return '—';
  if (f.kind === 'money') return formatCents(f.value);
  if (f.kind === 'percent') return `${formatNumber(f.value)}%`;
  if (f.kind === 'days') return plural(f.value, 'day');
  return formatNumber(f.value);
}

/** A figure, which opens the rows behind it. */
function FigureCard({ figure: f, disabled, onOpen }: { figure: ErrorFigure; disabled: boolean; onOpen: () => void }) {
  const text = figureText(f);
  const sub = f.cents != null ? formatCents(f.cents, { signed: f.id === 'amount_changed' }) : null;
  return (
    <button type="button" disabled={disabled} onClick={onOpen} aria-label={`${f.label}: ${text}${sub ? `, ${sub}` : ''}.${disabled ? '' : ' Show the rows'}`}
      className={cn('card flex h-full min-w-0 flex-col justify-between p-4 text-left', !disabled && 'card-hover', disabled && 'cursor-default')}>
      <span className="line-clamp-2 text-sm font-medium leading-snug text-ink-2">{f.label}</span>
      <span className="mt-3 flex flex-wrap items-baseline gap-x-2"><span className="stat-value">{text}</span>{sub ? <span className="fig text-sm text-ink-3">{sub}</span> : null}</span>
      {f.hint ? <span className="mt-1.5 line-clamp-2 text-xs text-ink-3">{f.hint}</span> : null}
    </button>
  );
}

const standingTone: Record<Standing, 'accent' | 'warn' | 'good' | 'neutral'> = { new: 'accent', reopened: 'warn', still_open: 'neutral', resolved: 'good' };

/** The rows behind a figure, as the file had them: its row number, every column, the earlier amount, and its case. */
function DrillDialog({ ask, q, onClose }: { ask: DrillAsk; q: api.ErrorComparisonQuery; onClose: () => void }) {
  const params = { ...q, drill: ask.drill, group: ask.group, value: ask.group ? ask.value ?? '' : undefined };
  const rows = useQuery({ queryKey: errorKeys.rows(params), queryFn: () => api.errorDrill(params), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false });
  const d = rows.data;
  const earlier = ask.drill === 'resolved' || ask.drill === 'before';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="xl" title={ask.title}
      description={d ? `${plural(d.total, 'row')} · ${formatCents(d.cents)} · from ${earlier && d.before ? `${d.before.filename}, the report of ${day(d.before.as_of)}` : `${d.after.filename}, the report of ${day(d.after.as_of)}`}` : 'The rows this figure counts.'}>
      {rows.isPending ? <Skeleton className="h-64" /> : rows.isError || !d ? <QueryFailure error={rows.error} what="These rows" className="py-2" /> : !d.rows.length ? <p className="text-sm text-ink-3">No row is behind this figure.</p> : (
        <div className="space-y-2">
          {d.total > d.rows.length ? <p className="text-xs text-warn">Showing the first {formatNumber(d.rows.length)} of {formatNumber(d.total)}. The report library’s file holds them all.</p> : null}
          <Table minWidth={900} head={<>
            <th scope="col">Identifier</th><th scope="col">What</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col" className="text-right">Amount</th>
            <th scope="col" className="text-right">Age</th><th scope="col" className="text-right">Row</th><th scope="col">Case</th>
          </>}>
            {d.rows.map((row) => {
              const amount = earlier ? row.before_amount_cents : row.amount_cents ?? row.before_amount_cents;
              const other = earlier ? row.amount_cents : row.before_amount_cents;
              return (
                <tr key={row.key}>
                  <td>
                    <span className="fig font-medium text-ink">{row.identifier}</span>
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {row.standing ? <Badge tone={standingTone[row.standing]}>{STANDING_LABELS[row.standing].label}</Badge> : null}
                      {row.flags.map((fl: ChangeFlag) => <Badge key={fl} tone="neutral">{FLAG_LABELS[fl].label}</Badge>)}
                    </span>
                    <details className="mt-1 text-xs">
                      <summary className="cursor-pointer text-ink-3">Every column</summary>
                      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                        {d.headers.filter((h) => row.data[h] !== undefined).map((h) => <div key={h} className="contents"><dt className="text-ink-3">{h}</dt><dd className="break-words text-ink-2">{row.data[h] || '—'}</dd></div>)}
                      </dl>
                    </details>
                  </td>
                  <td className="max-w-[18rem]">{row.description || row.reference || '—'}{row.category ? <span className="block text-xs text-ink-3">{row.category}</span> : null}{row.unit ? <span className="block text-xs text-ink-3">{row.unit}</span> : null}</td>
                  <td>{row.marine ?? row.owner ?? <span className="text-ink-3">None named</span>}{row.marine && row.owner && row.marine !== row.owner ? <span className="block text-xs text-ink-3">{row.owner}</span> : null}</td>
                  <td>{row.status ?? <span className="text-ink-3">—</span>}{row.closed ? <Badge tone="good" className="ml-1">Closed</Badge> : null}</td>
                  <td className="fig text-right">{amount == null ? '—' : formatCents(amount)}{other != null && other !== amount ? <span className="block text-xs text-ink-3">{earlier ? 'now' : 'was'} {formatCents(other)}</span> : null}</td>
                  <td className="fig text-right" title={row.age_basis ? AGE_BASIS_LABELS[row.age_basis] : undefined}>{row.age_days == null ? '—' : plural(row.age_days, 'day')}</td>
                  <td className="fig text-right">{formatNumber(row.source_row)}</td>
                  <td>{row.case_id ? <Link className="link" to={`/work/items/${encodeURIComponent(row.case_id)}`}>Open the case</Link> : <span className="text-ink-3">—</span>}</td>
                </tr>
              );
            })}
          </Table>
        </div>
      )}
    </Dialog>
  );
}

function WithdrawDialog({ report, code, onClose, onDone }: { report: SnapshotSummary; code: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      await api.withdrawErrorReport(report.id, reason);
      toast.success(`Withdrew the ${code} report of ${day(report.as_of)}.`);
      await qc.invalidateQueries({ queryKey: errorKeys.all });
      onDone();
    } catch (e) { setError(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="sm" title={`Withdraw the report of ${day(report.as_of)}?`}
      description="For a report filed in error: the wrong file, day or unit. It is kept and shown as withdrawn, with your reason, and left out of every comparison."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={run}>Withdraw it</Button></>}>
      <Field label="Why" error={error} hint="Shown with the report to everyone who reads the series.">
        <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Filed against the wrong day; the report of 14 Oct replaces it." />
      </Field>
    </Dialog>
  );
}

// ——— Filing a report ———

type Step = 'file' | 'sheet' | 'columns' | 'preview' | 'done';
type Filed = SnapshotSummary & { unit_id: string; type_id: string };

/** The headings are chosen from the rows the upload's inspection shows, as the Import wizard's are. */
const HEADING_ROWS = 20;

/** The column most likely to identify a row on a report filed the first time. The uploader decides. */
const guessKey = (headers: string[]) => headers.find((h) => /\b(document|doc|reference|ref|number|no|id|key|invoice|piin|sdn)\b/i.test(h)) ?? headers[0] ?? '';

function FileDialog({ types, units, initial, onClose, onFiled }: {
  types: ErrorReportType[]; units: Array<{ id: string; label: string }>; initial: { unitId: string; typeId: string };
  onClose: () => void; onFiled: (s: Filed) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('file');
  const [busy, setBusy] = useState(false);
  const [unitId, setUnitId] = useState(initial.unitId);
  const [typeId, setTypeId] = useState(types.some((t) => t.id === initial.typeId) ? initial.typeId : types[0]?.id ?? '');
  const [asOf, setAsOf] = useState(todayIso());
  const [note, setNote] = useState('');
  const [source, setSource] = useState<ImportSource | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [layout, setLayout] = useState<ErrorReportLayout | null>(null);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [keys, setKeys] = useState<[string, string]>(['', '']);
  const [roles, setRoles] = useState<Record<string, ColumnRole>>({});
  // Null until the first preview, which ticks the statuses that usually mean closed when no earlier report says.
  const [closed, setClosed] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<ErrorReportPreview | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);
  const type = types.find((t) => t.id === typeId);

  const sheet = useMemo(() => (inspection?.sheets || []).find((s) => s.name === sheetName) || inspection?.sheets?.[0], [inspection, sheetName]);
  const headers = useMemo(() => (sheet?.sample?.[headerRow - 1] || []).map((h, i) => (h || '').trim() || `Column ${i + 1}`), [sheet, headerRow]);
  const twice = SINGLE_ROLES.filter((role) => headers.filter((h) => roles[h] === role).length > 1);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      // Shared with the unit when the filer belongs to it. Filed for a unit beneath theirs, it stays the filer's own
      // upload, since the intake shares a file only with a unit its uploader belongs to; the report keeps every row either way.
      const member = Boolean(identity?.memberships.some((m) => m.unit_id === unitId));
      const uploaded: ImportSource = await api.uploadSource(file, member ? { unitId, visibility: 'unit' } : { unitId: null, visibility: 'private' });
      const [detail, last] = await Promise.all([api.inspectSource(uploaded.id) as Promise<Inspection>, api.errorReportLayout(unitId, typeId)]);
      setSource(uploaded); setInspection(detail); setLayout(last.layout);
      setSheetName(last.layout && detail.sheets.some((s) => s.name === last.layout!.sheet_name) ? last.layout.sheet_name : detail.sheets[0]?.name || '');
      setHeaderRow(Math.min(last.layout?.header_row ?? 1, HEADING_ROWS));
      setStep('sheet');
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const toColumns = () => {
    const from = layout?.columns ?? {};
    setRoles(Object.fromEntries(headers.map((h) => [h, from[h] ?? guessRole(h)])));
    const kept = (layout?.key_columns ?? []).filter((k) => headers.includes(k));
    setKeys(kept.length ? [kept[0], kept[1] ?? ''] : [guessKey(headers), '']);
    setClosed(layout ? layout.closed_statuses : null);
    setStep('columns');
  };

  const plan = (closedStatuses: string[]): api.ErrorFilingPlan => ({
    unit_id: unitId, type_id: typeId, as_of: asOf, source_file_id: source?.id ?? '', sheet_name: sheet?.name || '', header_row: headerRow,
    key_columns: keys.filter((k, i, all) => k && all.indexOf(k) === i), columns: roles, closed_statuses: closedStatuses, note: note.trim() || null,
  });

  const runPreview = async (next = closed) => {
    setBusy(true);
    try {
      let result = await api.previewErrorReport(plan(next ?? []));
      let chosen = next ?? [];
      if (next === null) {
        chosen = result.statuses.filter((s) => closedByDefault(s.status)).map((s) => normalStatus(s.status));
        if (chosen.length) result = await api.previewErrorReport(plan(chosen));
      }
      setClosed(chosen); setPreview(result); setStep('preview');
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  const toggleClosed = (status: string, on: boolean) => {
    const k = normalStatus(status);
    const next = on ? [...new Set([...(closed ?? []), k])] : (closed ?? []).filter((x) => x !== k);
    void runPreview(next);
  };

  const file = async () => {
    setBusy(true);
    try {
      const result = await api.fileErrorReport(plan(closed ?? []));
      setFiled(result); setStep('done');
      await qc.invalidateQueries({ queryKey: errorKeys.all });
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const blocked = Boolean(preview?.same_file || preview?.same_day || !preview?.rows);
  const titles: Record<Step, string> = {
    file: 'File an error report', sheet: 'Which sheet, and where do the headings sit?', columns: 'What does each column hold?',
    preview: 'Here is what will be filed', done: 'Filed',
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={titles[step]}
      description={step === 'file' ? 'The report is kept exactly as it stood on the day it was run, and never changed after. The next report of its kind is compared with it.' : type && step !== 'done' ? `${type.code} · ${type.name}, standing on ${day(asOf)}` : undefined}
      footer={
        step === 'file' ? <Button variant="ghost" onClick={onClose}>Cancel</Button>
        : step === 'sheet' ? <><Button variant="ghost" onClick={() => setStep('file')}>Back</Button><Button variant="primary" disabled={!sheet || !headers.length} onClick={toColumns}>Next<ArrowRight className="h-4 w-4" aria-hidden /></Button></>
        : step === 'columns' ? <><Button variant="ghost" onClick={() => setStep('sheet')}>Back</Button><Button variant="primary" loading={busy} disabled={!keys[0] || twice.length > 0} onClick={() => runPreview()}>Preview<ArrowRight className="h-4 w-4" aria-hidden /></Button></>
        : step === 'preview' ? <><Button variant="ghost" onClick={() => setStep('columns')}>Back</Button><Button variant="primary" loading={busy} disabled={blocked} onClick={file}><Check className="h-4 w-4" aria-hidden />File {preview ? plural(preview.rows, 'row') : 'it'}</Button></>
        : <Button variant="primary" onClick={() => filed && onFiled(filed)}>Open the comparison</Button>
      }
    >
      {step === 'file' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Unit" hint="Read by everyone who may view its shared records.">
              <Select value={unitId} onValueChange={setUnitId} options={units.map((u) => ({ value: u.id, label: u.label }))} />
            </Field>
            <Field label="Report" hint={type?.description || undefined}>
              <Select value={typeId} onValueChange={setTypeId} options={types.map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))} placeholder="No report type is active" />
            </Field>
            <Field label="Stands on" hint="The day the report was run.">
              <Input type="date" value={asOf} max={todayIso()} onChange={(e) => setAsOf(e.target.value)} />
            </Field>
          </div>
          <Field label="Note" hint="Optional: where the report came from, or anything a reader should know.">
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <button type="button" disabled={busy || !typeId || !unitId || !asOf} onClick={() => fileInput.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface-2 px-6 py-10 text-center transition-colors hover:border-accent disabled:opacity-60">
            {busy ? <Skeleton className="h-8 w-8 rounded-full" /> : <Upload className="h-8 w-8 text-ink-3" aria-hidden />}
            <span className="text-sm font-medium text-ink">{busy ? 'Reading the file' : 'Choose the report'}</span>
            <span className="text-xs text-ink-3">.xlsx, .xlsm, .csv or .tsv</span>
          </button>
          <input ref={fileInput} type="file" className="sr-only" aria-label="Error report to file" accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />
          <p className="text-xs text-ink-3">Macros are never run. Formulas are read as the value the spreadsheet saved. Filing a report never changes a case in the queue.</p>
        </div>
      )}

      {step === 'sheet' && inspection && (
        <div className="space-y-4">
          <ScanNotice source={source} />
          {layout ? <p className="text-sm text-ink-2">Set up as the report of {day(layout.from.as_of)} ({layout.from.filename}) was. Change anything that differs.</p> : null}
          {inspection.notes.length > 0 && (
            <ul className="space-y-1 rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2">
              {inspection.notes.map((n) => <li key={n} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />{n}</li>)}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Sheet"><Select value={sheet?.name || ''} onValueChange={setSheetName} options={inspection.sheets.map((s) => ({ value: s.name, label: `${s.name} (${formatNumber(s.rows)} rows)` }))} /></Field>
            <Field label="Heading row" hint={`The row that names the columns, one of the first ${HEADING_ROWS}.`}><NumberInput value={String(headerRow)} min={1} max={HEADING_ROWS} onChange={(e) => setHeaderRow(Math.max(1, Math.min(HEADING_ROWS, Number(e.target.value) || 1)))} /></Field>
          </div>
          {sheet?.truncated && <p className="text-xs text-warn">This sheet is larger than Vantage reads in one pass. Only the first rows are filed.</p>}
          <SamplePreview sheet={sheet} headerRow={headerRow} />
        </div>
      )}

      {step === 'columns' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Which column identifies each error" hint="How the next report recognises the same error. Taken exactly as written.">
              <Select value={keys[0]} onValueChange={(v) => setKeys(([, b]) => [v, b === v ? '' : b])} options={headers.map((h) => ({ value: h, label: h }))} />
            </Field>
            <Field label="And, if one column is not enough" hint="A document number and its line, say.">
              <Select aria-label="Second identifying column" value={keys[1] || 'none'} onValueChange={(v) => setKeys(([a]) => [a, v === 'none' ? '' : v])}
                options={[{ value: 'none', label: 'No second column' }, ...headers.filter((h) => h !== keys[0]).map((h) => ({ value: h, label: h }))]} />
            </Field>
          </div>
          <div className="scroll-x rounded-md border border-line">
            <table className="w-full text-sm" style={{ minWidth: 560 }}>
              <thead className="bg-surface-2">
                <tr><th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-2">Column</th><th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-2">Holds</th><th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-2">First value</th></tr>
              </thead>
              <tbody>
                {headers.map((h, i) => (
                  <tr key={h} className="border-t border-line">
                    <td className="px-3 py-1.5 text-ink">{h}{keys.includes(h) && <Badge tone="accent" className="ml-2">Identifier</Badge>}</td>
                    <td className="px-3 py-1.5">
                      <Select aria-label={`What ${h} holds`} className="w-52" value={roles[h] || 'keep'} onValueChange={(v) => setRoles((m) => ({ ...m, [h]: v as ColumnRole }))}
                        options={COLUMN_ROLES.filter((role) => role !== 'ignore' || !keys.includes(h)).map((role) => ({ value: role, label: COLUMN_ROLE_LABELS[role].label }))} />
                    </td>
                    <td className="max-w-[14rem] truncate px-3 py-1.5 text-xs text-ink-3">{sheet?.sample?.[headerRow]?.[i] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {twice.length ? <p className="text-sm text-bad" role="alert">{twice.map((role) => `Two columns hold the ${COLUMN_ROLE_LABELS[role].label.toLowerCase()}.`).join(' ')} Choose one for each.</p> : null}
          <p className="text-xs text-ink-3">A column kept is filed with the row and shown with it. Only a column left out is not kept.</p>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-4">
          {preview.same_file ? <Blocker>This file is already filed in this series, as the report of {day(preview.same_file.as_of)}.</Blocker> : null}
          {preview.same_day ? <Blocker>A {preview.type.code} report for {day(asOf)} is already filed ({preview.same_day.filename}). Withdraw it first, then file this one.</Blocker> : null}
          {!preview.rows ? <Blocker>No row of this sheet has an identifier Vantage can read, so there is nothing to file.</Blocker> : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([['Rows', formatNumber(preview.rows)], ['Open', formatNumber(preview.open)], ['Value open', formatCents(preview.open_cents)], ['Refused', formatNumber(preview.rejected)]] as const).map(([label, value]) => (
              <div key={label} className={cn('rounded-md border px-3 py-2', label === 'Refused' && preview.rejected ? 'border-warn/40 bg-warn/5' : 'border-line')}>
                <p className="eyebrow">{label}</p><p className="fig mt-0.5 text-xl font-semibold text-ink">{value}</p>
              </div>
            ))}
          </div>
          {preview.previous && preview.changes ? (
            <div className="rounded-xl px-3.5 py-2.5 ring-1 ring-inset ring-line">
              <p className="eyebrow">Against the report of {day(preview.previous.as_of)} ({plural(preview.previous.open_count, 'open error')})</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {(['new', 'still_open', 'reopened', 'resolved'] as const).map((k) => <li key={k} className="chip">{STANDING_LABELS[k].label} · {formatNumber(preview.changes![k])}</li>)}
                {(['amount_changed', 'owner_changed', 'status_changed'] as const).map((k) => <li key={k} className="chip">{FLAG_LABELS[k].label} · {formatNumber(preview.changes![k])}</li>)}
              </ul>
            </div>
          ) : <p className="text-sm text-ink-2">No report of this series stands on an earlier day, so this one starts it: the next is compared with it.</p>}
          <fieldset>
            <legend className="mb-1 text-base font-medium text-ink">Which statuses mean closed</legend>
            {!preview.statuses.length ? <p className="text-sm text-ink-3">No column holds a status, so every row is open. An error gone from the next report is resolved.</p> : (
              <>
                <p className="mb-2 text-xs text-ink-3">A row with a ticked status is closed: it is not counted open, and an error open before and closed now is resolved. The next report of the series starts with these.</p>
                <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {preview.statuses.map((s) => (
                    <li key={s.status}><label className="flex items-center gap-2 text-sm text-ink-2">
                      <input type="checkbox" className="h-4 w-4 accent-accent" checked={s.closed} disabled={busy} onChange={(e) => toggleClosed(s.status, e.target.checked)} />
                      <span className="text-ink">{s.status}</span><span className="fig text-xs text-ink-3">{plural(s.rows, 'row')}</span>
                    </label></li>
                  ))}
                </ul>
              </>
            )}
          </fieldset>
          {preview.owners.named ? <p className="text-sm text-ink-2">{plural(preview.owners.named, 'row names an owner', 'rows name an owner')}; {formatNumber(preview.owners.matched)} of them name exactly one Marine of the unit, and count toward that Marine.</p> : null}
          {preview.rejection_count > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-2 text-md font-semibold text-ink"><AlertTriangle className="h-4 w-4 text-warn" aria-hidden />{plural(preview.rejection_count, 'note')} on the file</h3>
              <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                {preview.rejections.map((x, i) => (
                  <li key={`${x.source_row}-${i}`} className="rounded-md border border-line px-3 py-1.5"><span className="font-medium text-ink">Row {x.source_row}{x.value ? `: ${x.value}` : ''}</span><span className="block text-ink-3">{x.reason}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {step === 'done' && filed && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm text-good"><Check className="h-4 w-4" aria-hidden />Filed the {type?.code} report of {day(filed.as_of)}: {plural(filed.row_count, 'row')}, {formatNumber(filed.open_count)} open ({formatCents(filed.open_cents)}).</p>
          {filed.rejected_rows ? <p className="text-sm text-warn">{plural(filed.rejected_rows, 'row was', 'rows were')} refused. They are listed with the report.</p> : null}
          <p className="text-xs text-ink-3">The file is kept exactly as uploaded, so the report can be checked against it later.</p>
        </div>
      )}

      {step !== 'file' && !inspection && <EmptyState icon={FileSpreadsheet} title="Choose a file first" />}
    </Dialog>
  );
}

const Blocker = ({ children }: { children: React.ReactNode }) => (
  <p className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-ink" role="alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />{children}</p>
);
