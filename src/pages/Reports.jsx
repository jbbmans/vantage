import React, { useMemo, useState } from 'react';
import { Copy, Download, Printer, FileText, Inbox, Users, ArrowUp, ArrowDown, Minus, ListChecks, Sparkles, TrendingUp } from 'lucide-react';
import {
  useActivities, useProjects, useRecognitions, useTrainings, useGoals, useTasks,
  useIdentity, useCanLead, usePrefs, unitPath,
  can, PERMISSIONS,
} from '@/store/useStore';
import * as apiClient from '@/lib/api';
import {
  aggregateMetrics, activitiesInRange, rangeForPeriod, fiscalYearRange, fiscalQuarterRange,
  formatDollars, formatDollarsExact, formatNumber, formatDTG,
} from '@/lib/metrics';
import { DOLLAR_TYPES, DOLLAR_SUM_RULE } from '@/lib/constants';
import { buildPackage, packageToText } from '@/lib/bullets';
import { composeNarrative } from '@/lib/narrative';
import { narrativeConfig, trackMeta, areasFor } from '@/lib/evaluation';
import { comparePeriods, comparisonToText } from '@/lib/delta';
import { useEvalTrack } from '@/store/useStore';
import { exportWorkbook } from '@/lib/sheets';
import { copyToClipboard, downloadText } from '@/lib/utils';
import { useToast } from '@/components/ui/toast';
import { Panel, EmptyState, Button, Segmented, Badge, Tooltip, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const PERIODS = [
  { value: 'fiscalQuarter', label: 'FQ', ariaLabel: 'Fiscal quarter' },
  { value: 'fiscalYear', label: 'FY', ariaLabel: 'Fiscal year' },
  { value: 'month', label: 'MO', ariaLabel: 'Month' },
  { value: 'year', label: 'CY', ariaLabel: 'Calendar year' },
];

const viewsFor = (track) => [
  { value: 'narrative', label: trackMeta(track).inputName },
  { value: 'bullets', label: 'Bullets' },
  { value: 'delta', label: 'Change report' },
];

function Move({ m, invert = false, format = (v) => formatNumber(Math.round(v)) }) {
  const Icon = m.direction === 'up' ? ArrowUp : m.direction === 'down' ? ArrowDown : Minus;
  const good = m.direction === 'flat' ? null : (m.direction === 'up') !== invert;
  return (
    <span className={cn('fig inline-flex items-center gap-1 text-xs',
      good === null ? 'text-text-3' : good ? 'text-ledger' : 'text-redline')}>
      <Icon className="h-3 w-3" />
      {m.diff > 0 ? '+' : ''}{format(m.diff)}
      {m.pct != null && <span className="text-text-3">({m.pct > 0 ? '+' : ''}{m.pct}%)</span>}
    </span>
  );
}

function DeltaRow({ label, m, format = (v) => formatNumber(Math.round(v)), invert }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-rule py-1.5 last:border-0">
      <span className="min-w-0 flex-1 truncate text-base text-text-2">{label}</span>
      <span className="fig w-28 shrink-0 text-right text-md text-text">{format(m.current)}</span>
      <span className="fig w-28 shrink-0 text-right text-xs text-text-3">{format(m.prior)}</span>
      <span className="w-32 shrink-0 text-right"><Move m={m} format={format} invert={invert} /></span>
    </div>
  );
}

export default function Reports() {
  const activities = useActivities();
  const projects = useProjects();
  const recognitions = useRecognitions();
  const trainings = useTrainings();
  const goals = useGoals();
  const tasks = useTasks();
  const identity = useIdentity();
  const canLead = useCanLead();
  const track = useEvalTrack();
  const toast = useToast();
  const prefs = usePrefs();

  const [period, setPeriod] = useState(() => prefs.interface?.reportPeriod || 'fiscalYear');
  const [view, setView] = useState(() => prefs.interface?.reportView || 'narrative');
  const [style, setStyle] = useState('jepes');
  const [scope, setScope] = useState('me');
  const [limit, setLimit] = useState(8);
  const [aiResult, setAiResult] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  const me = identity?.user?.id;
  const reportUnitId = identity?.assignments?.find((a) => a.is_primary)?.unit_id
    || identity?.scopeUnitIds?.[0]
    || null;
  const canExportUnit = Boolean(reportUnitId && can(PERMISSIONS.EXPORT_DATA, reportUnitId));
  const unitScope = scope === 'unit' && canExportUnit;

  const pool = useMemo(
    () => (unitScope
      ? activities.filter((a) => a.unit_id === reportUnitId)
      : activities.filter((a) => a.user_id === me)),
    [activities, unitScope, reportUnitId, me]
  );

  const range = useMemo(() => rangeForPeriod(period), [period]);
  const scoped = useMemo(() => activitiesInRange(pool, range), [pool, range]);
  const metrics = useMemo(() => aggregateMetrics(scoped), [scoped]);
  const scopedRecognitions = useMemo(
    () => recognitions.filter((r) => (unitScope ? r.unit_id === reportUnitId : r.user_id === me)),
    [recognitions, unitScope, reportUnitId, me]
  );
  const scopedTrainings = useMemo(
    () => trainings.filter((r) => (unitScope ? r.unit_id === reportUnitId : r.user_id === me)),
    [trainings, unitScope, reportUnitId, me]
  );
  const scopedGoals = useMemo(
    () => goals.filter((r) => (unitScope ? r.unit_id === reportUnitId : r.user_id === me)),
    [goals, unitScope, reportUnitId, me]
  );

  const periodLabel = useMemo(() => {
    if (period === 'fiscalYear') return fiscalYearRange().label;
    if (period === 'fiscalQuarter') return fiscalQuarterRange().label;
    return `${formatDTG(range.start)} — ${formatDTG(range.end)}`;
  }, [period, range]);

  const narrative = useMemo(() => {
    const cfg = narrativeConfig(track);
    return composeNarrative(scoped, { ...cfg, periodLabel });
  }, [scoped, periodLabel, track]);

  const pkg = useMemo(
    () => buildPackage(scoped, { periodLabel, style, limitPerArea: limit, areas: areasFor(track) }),
    [scoped, periodLabel, style, limit, track]
  );

  const cmp = useMemo(
    () => comparePeriods(pool, { ...range, label: periodLabel }, {
      recognitions: scopedRecognitions, trainings: scopedTrainings, goals: scopedGoals, areas: areasFor(track),
    }),
    [pool, range, periodLabel, scopedRecognitions, scopedTrainings, scopedGoals, track]
  );

  const subjectLine = !unitScope
    ? `${identity?.user?.rank?.abbr || ''} ${identity?.user?.last_name || ''}`.trim()
    : unitPath(identity?.assignments?.[0]?.unit_id).map((u) => u.short_name || u.name).slice(-1)[0] || 'Authorized unit';

  const copyCurrent = async () => {
    const text = view === 'narrative'
      ? narrative.text
      : view === 'bullets'
        ? packageToText(pkg, `Performance summary — ${periodLabel}`)
        : comparisonToText(cmp, `${subjectLine} — ${periodLabel}`);
    const ok = await copyToClipboard(text);
    ok ? toast.success('Copied to clipboard.') : toast.error('Could not reach the clipboard.');
  };

  const downloadCurrent = () => {
    const slug = periodLabel.replace(/\s+/g, '-').toLowerCase();
    const text = view === 'narrative'
      ? narrative.text
      : view === 'bullets'
        ? packageToText(pkg, `Performance summary — ${periodLabel}`)
        : comparisonToText(cmp, `${subjectLine} — ${periodLabel}`);
    downloadText(`vantage-${view}-${slug}.txt`, text, 'text/plain');
    toast.success('Downloaded.');
  };

  const generateAiDraft = async () => {
    setAiBusy(true);
    setAiResult(null);
    try {
      const result = unitScope
        ? await apiClient.aiAssist('command_brief', {
          unit_id: reportUnitId,
          from: range.start.toISOString().slice(0, 10),
          to: range.end.toISOString().slice(0, 10),
        })
        : await apiClient.aiAssist('report_narrative', {
          track,
          from: range.start.toISOString().slice(0, 10),
          to: range.end.toISOString().slice(0, 10),
          character_limit: narrativeConfig(track).limit,
        });
      setAiResult(result.output);
      toast.success('AI draft generated. Verify every fact before use.');
    } catch (error) { toast.error(apiClient.errorText(error)); }
    finally { setAiBusy(false); }
  };

  const hasUnitReportSource = canExportUnit && activities.some((activity) => activity.unit_id === reportUnitId);
  if (!pool.length && !hasUnitReportSource) {
    return (
      <div className="page-canvas reports-page">
        <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
          <div>
            <p className="eyebrow">Analysis and package builder</p>
            <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Report studio</h2>
            <p className="mt-1.5 max-w-2xl text-base text-text-3">Turn source records into a structured evaluation input, a bullet package, or a period-over-period brief.</p>
          </div>
          <Button variant="primary" size="md" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log'))}>
            Log first activity
          </Button>
        </div>

        <section className="grid gap-3 py-6 md:grid-cols-3" aria-label="Available report formats">
          {[
            [FileText, trackMeta(track).inputName, 'A concise, character-aware narrative organized around your evaluation track.'],
            [ListChecks, 'Bullet package', 'Strongest accomplishments grouped by area and ready to copy, print, or refine.'],
            [TrendingUp, 'Change report', 'Current period against the prior equivalent window, with exact movement and context.'],
          ].map(([FormatIcon, title, description]) => (
            <div key={title} className="panel rounded p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded border border-rule bg-panel-2 text-signal">{React.createElement(FormatIcon, { className: 'h-5 w-5' })}</span>
              <h3 className="mt-4 text-lg font-semibold text-text">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-3">{description}</p>
            </div>
          ))}
        </section>

        <Panel title="How reports stay defensible" bodyClassName="p-5">
          <div className="grid gap-4 text-sm leading-relaxed text-text-2 sm:grid-cols-3">
            <p><strong className="block text-text">One source of truth</strong>Your selected activity window drives every format.</p>
            <p><strong className="block text-text">Exact-unit boundaries</strong>Unit output appears only when your role grants export in that unit.</p>
            <p><strong className="block text-text">No invented scores</strong>Vantage organizes evidence and leaves official evaluation decisions to authoritative systems.</p>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="page-canvas reports-page space-y-4">
      <div className="no-print">
        <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
          <div>
            <p className="eyebrow">Analysis and package builder</p>
            <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Report studio</h2>
            <p className="mt-1.5 text-base text-text-3">{subjectLine} · {periodLabel}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
          <Segmented value={period} onChange={setPeriod} options={PERIODS} />
          {canLead && canExportUnit && (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[{ value: 'me', label: 'Me' }, { value: 'unit', label: 'My unit' }]}
            />
          )}
          <Button variant="default" size="sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" />
            Print
          </Button>
          <Button size="sm" onClick={generateAiDraft} disabled={aiBusy}>
            <Sparkles className={cn('h-3.5 w-3.5', aiBusy && 'animate-pulse')} />
            {aiBusy ? 'Drafting…' : unitScope ? 'AI command brief' : 'AI narrative'}
          </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule py-3">
          <Segmented value={view} onChange={setView} options={viewsFor(track)} />
          <div className="flex items-center gap-1.5">
            {view === 'bullets' && (
              <>
                <Segmented
                  size="sm"
                  value={style}
                  onChange={setStyle}
                  options={[
                    { value: 'jepes', label: 'JEPES' },
                    { value: 'fitrep', label: 'FITREP' },
                    { value: 'resume', label: 'Résumé' },
                  ]}
                />
                <Select
                  value={String(limit)}
                  onValueChange={(v) => setLimit(Number(v))}
                  options={[
                    { value: '5', label: 'Top 5 per area' },
                    { value: '8', label: 'Top 8 per area' },
                    { value: '20', label: 'Top 20 per area' },
                    { value: '0', label: 'Everything' },
                  ]}
                />
              </>
            )}
            <Button variant="ghost" size="sm" onClick={copyCurrent}><Copy className="h-3 w-3" />Copy</Button>
            <Button variant="ghost" size="sm" onClick={downloadCurrent}><FileText className="h-3 w-3" />.txt</Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                try {
                  const data = unitScope
                    ? await apiClient.exportUnit(reportUnitId)
                    : {
                      activities: scoped,
                      projects: projects.filter((r) => r.user_id === me),
                      tasks: tasks.filter((r) => r.user_id === me),
                      goals: goals.filter((r) => r.user_id === me),
                      recognitions: recognitions.filter((r) => r.user_id === me),
                      trainings: trainings.filter((r) => r.user_id === me),
                    };
                  await exportWorkbook({ ...data, contacts: [] }, `vantage-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`);
                  toast.success('CSV exported.');
                } catch (err) { toast.error(err.message || 'Export failed.'); }
              }}
            >
              <Download className="h-3 w-3" />CSV
            </Button>
          </div>
        </div>
      </div>

      <div className="print-only mb-4 border-b-2 border-black pb-2">
        <h1 className="text-xl font-semibold">Performance Report — {periodLabel}</h1>
        <p className="mt-0.5 text-sm">
          {subjectLine}
          {identity?.assignments?.[0]?.billet_title ? ` · ${identity.assignments[0].billet_title}` : ''}
        </p>
        <p className="mt-0.5 text-xs">
          Current window {formatDTG(range.start)} — {formatDTG(range.end)} · compared against {cmp.label.prior}
          {' · '}generated {formatDTG(new Date())}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-rule px-1 py-4">
        <div>
          <p className="eyebrow">Entries</p>
          <p className="fig mt-0.5 text-xl text-text">{formatNumber(scoped.length)}</p>
          <Move m={cmp.headline.activities} />
        </div>
        <div>
          <p className="eyebrow">Action amount</p>
          <p className="fig mt-0.5 text-xl text-text">{formatNumber(metrics.totalQuantity)}</p>
          <Move m={cmp.headline.quantity} />
        </div>
        <div>
          <p className="eyebrow">Headline transaction value</p>
          <p className="fig mt-0.5 text-xl text-ledger">{formatDollarsExact(metrics.totalDollars)}</p>
          <Move m={cmp.headline.dollars} format={formatDollars} />
        </div>
        {metrics.reviewedDollars > 0 && (
          <div>
            <p className="eyebrow">Reviewed (excluded)</p>
            <p className="fig mt-0.5 text-xl text-text-3">{formatDollarsExact(metrics.reviewedDollars)}</p>
          </div>
        )}
        <div className="ml-auto max-w-sm no-print">
          <p className="text-2xs leading-relaxed text-text-3">{DOLLAR_SUM_RULE}</p>
        </div>
      </div>

      <div className="mt-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Report transaction value by dollar type">
          {DOLLAR_TYPES.map((type) => (
            <div key={type.key} className="rounded border border-rule px-3 py-2">
              <p className="eyebrow">{type.label}</p>
              <p className="fig mt-1 text-sm text-text">{formatDollarsExact(metrics.dollarsByType[type.key] || 0)}</p>
            </div>
          ))}
        </div>
      </div>

      {aiResult && (
        <Panel
          className="no-print"
          title="GenAI.mil suggestion"
          subtitle="Human review required · no automatic save"
          action={<Button size="sm" onClick={async () => {
            const text = aiResult.narrative || aiResult.executive_summary || JSON.stringify(aiResult, null, 2);
            (await copyToClipboard(text)) ? toast.success('AI draft copied.') : toast.error('Could not reach the clipboard.');
          }}><Copy className="h-3.5 w-3.5" /> Copy</Button>}
        >
          <p className="whitespace-pre-wrap text-base leading-relaxed text-text">
            {aiResult.narrative || aiResult.executive_summary || aiResult.summary}
          </p>
          {Object.entries(aiResult).filter(([key, value]) => Array.isArray(value) && value.length).map(([key, values]) => (
            <div key={key} className="mt-3 border-t border-rule pt-3">
              <p className="eyebrow">{key.replaceAll('_', ' ')}</p>
              <ul className="mt-1 space-y-1 text-sm leading-relaxed text-text-2">
                {values.map((value, index) => <li key={index}>• {typeof value === 'object' ? JSON.stringify(value) : value}</li>)}
              </ul>
            </div>
          ))}
          <p className="mt-3 border-t border-rule pt-2 text-xs text-text-3">AI output is a draft, not an official evaluation or command decision. Verify figures against VANTAGE records.</p>
        </Panel>
      )}

      {(view === 'narrative' || typeof window !== 'undefined') && (
        <Panel
          className={view === 'narrative' ? '' : 'no-print hidden'}
          title={`${trackMeta(track).name} accomplishment narrative`}
          subtitle={`Everything logged this period, ready to hand over · ${narrative.length}/${narrative.limit} characters`}
          action={
            <Badge tone={narrative.fits ? 'ledger' : 'redline'}>
              {narrative.fits ? 'fits' : 'over limit'}
            </Badge>
          }
        >
          {narrative.text ? (
            <>
              <p className="text-base leading-relaxed text-text">{narrative.text}</p>
              <div className="mt-3 h-1 overflow-hidden rounded-sm bg-rule/60 no-print">
                <div
                  className={cn('h-full transition-[width]', narrative.length > narrative.limit * 0.92 ? 'bg-signal' : 'bg-ledger/70')}
                  style={{ width: `${Math.min(100, (narrative.length / narrative.limit) * 100)}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-rule pt-2.5">
                {narrative.areas.map((a) => (
                  <span key={a.label} className="fig text-2xs text-text-3">
                    {a.label} <span className="text-text-2">{a.count} entries</span>
                    {a.available > a.included && (
                      <span className="text-signal"> · {a.available - a.included} not shown</span>
                    )}
                  </span>
                ))}
              </div>
              {narrative.omitted > 0 && (
                <p className="mt-2 text-xs leading-relaxed text-text-3 no-print">
                  {narrative.omitted} supporting {narrative.omitted === 1 ? 'entry' : 'entries'} would not fit inside
                  {narrative.limit} characters. The strongest material was kept — entries carrying a dollar figure
                  and a stated outcome rank first.
                </p>
              )}
            </>
          ) : (
            <EmptyState icon={Inbox} title="Nothing in this window" description="Widen the period to pull in more entries." />
          )}
        </Panel>
      )}

      {view === 'bullets' && (
        <Panel
          title="Bullet package"
          subtitle={`Composed from ${scoped.length} entries · ${periodLabel}`}
          bodyClassName="p-0"
        >
          <div className="divide-y divide-rule">
            {pkg.filter((g) => g.count > 0).map((group) => (
              <div key={group.area} className="px-4 py-3">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <h3 className="font-mono text-xs uppercase tracking-[0.14em] text-signal">{group.area}</h3>
                  <span className="fig text-2xs text-text-3">{group.count} entries</span>
                </div>
                {group.rollup && (
                  <p className="mb-3 border-l-2 border-signal/40 pl-3 text-base leading-relaxed text-text">{group.rollup}</p>
                )}
                <ul className="space-y-1.5">
                  {group.bullets.map((b) => (
                    <li key={b.id} className="flex items-start gap-2.5 text-sm leading-relaxed text-text-2">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-text-3" />
                      <span className="flex-1">{b.text}</span>
                      <span className="no-print flex shrink-0 items-center gap-0.5 pt-1">
                        {[0, 1, 2, 3].map((i) => (
                          <span key={i} className={cn('h-1 w-1.5 rounded-sm', i < b.strength ? 'bg-signal/70' : 'bg-rule')} />
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
                {group.withheld > 0 && (
                  <p className="mt-2 text-xs text-signal">
                    {group.withheld} further {group.withheld === 1 ? 'entry' : 'entries'} not shown at this limit.
                  </p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {view === 'delta' && (
        <>
          <Panel title="What changed" subtitle={`${cmp.label.current} against ${cmp.label.prior}`}>
            <div className="mb-1 flex items-baseline gap-3 border-b border-rule-strong pb-1.5">
              <span className="eyebrow flex-1">Measure</span>
              <span className="eyebrow w-28 text-right">This period</span>
              <span className="eyebrow w-28 text-right">Last period</span>
              <span className="eyebrow w-32 text-right">Change</span>
            </div>
            <DeltaRow label="Entries logged" m={cmp.headline.activities} />
            <DeltaRow label="Units processed" m={cmp.headline.quantity} />
            <DeltaRow label="Dollar impact" m={cmp.headline.dollars} format={formatDollars} />
            <DeltaRow label="Entries with a stated outcome" m={cmp.headline.withOutcome} />
            <DeltaRow label="Recognition received" m={cmp.extras.recognitions} />
            <DeltaRow label="Training hours" m={cmp.extras.trainingHours} />
          </Panel>

          {cmp.byDollarType.length > 0 && (
            <Panel title="Dollars by type" subtitle="Where the money actually moved">
              {cmp.byDollarType.map((d) => (
                <DeltaRow
                  key={d.key}
                  label={`${d.label}${d.summable ? '' : ' — excluded from totals'}`}
                  m={d}
                  format={formatDollars}
                />
              ))}
            </Panel>
          )}

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Panel title={trackMeta(track).balanceLabel} subtitle={track === 'fitrep' ? 'Your RS marks every section' : 'A board reads all three areas'}>
              {cmp.byJepes.map((j) => (
                <DeltaRow key={j.area} label={j.area.replace(' / Mission Accomplishment', '').replace('MOS ', '')} m={j} />
              ))}
            </Panel>

            <Panel title="Work counted" subtitle="Units of work, then and now">
              {cmp.byUnit.length === 0
                ? <EmptyState title="No quantities recorded" />
                : cmp.byUnit.slice(0, 8).map((u) => <DeltaRow key={u.unit} label={u.unit} m={u} />)}
            </Panel>
          </div>

          {cmp.notes.length > 0 && (
            <Panel title="Read this before the package goes up">
              <ul className="space-y-1.5">
                {cmp.notes.map((n, i) => (
                  <li key={i} className="flex items-start gap-2 text-base leading-relaxed text-text-2">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-signal" />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      <p className="print-only mt-4 border-t border-black pt-2 text-xs">
        Generated by Vantage · Figures trace to logged records; Reviewed dollars are
        excluded from headline totals.
      </p>
    </div>
  );
}
