import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, Download, Upload, X, Inbox, CheckCircle2, CircleAlert } from 'lucide-react';
import { useActivities, useProjects, useIdentity } from '@/store/useStore';
import {
  aggregateMetrics, rangeForPeriod, activitiesInRange, formatDollars, formatDollarsExact,
  formatNumber, formatDTG,
} from '@/lib/metrics';
import { CATEGORIES, CATEGORY_COLORS, JEPES_AREAS, DOLLAR_TYPES, DOLLAR_SUM_RULE } from '@/lib/constants';
import { strength } from '@/lib/bullets';
import { exportWorkbook } from '@/lib/sheets';
import { useToast } from '@/components/ui/toast';
import {
  Panel, EmptyState, Button, Input, Select, Badge, Dot, Segmented, Tooltip,
} from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { unitFor } from '@/lib/bullets';
import DollarTypeBreakdown from '@/components/DollarTypeBreakdown';

const PERIODS = [
  { value: 'all', label: 'ALL', ariaLabel: 'All time' },
  { value: 'week', label: 'WK', ariaLabel: 'Week' },
  { value: 'month', label: 'MO', ariaLabel: 'Month' },
  { value: 'fiscalQuarter', label: 'FQ', ariaLabel: 'Fiscal quarter' },
  { value: 'fiscalYear', label: 'FY', ariaLabel: 'Fiscal year' },
];

const SORTS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'dollar-desc', label: 'Largest transaction value' },
  { value: 'quantity-desc', label: 'Largest action amount' },
  { value: 'strength-asc', label: 'Weakest entries' },
  { value: 'strength-desc', label: 'Strongest entries' },
];

export default function Activities() {
  const activities = useActivities();
  const projects = useProjects();
  const identity = useIdentity();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('all');
  const [category, setCategory] = useState('');
  const [jepes, setJepes] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [showFilters, setShowFilters] = useState(false);

  const dayFilter = params.get('date');
  const qualityFilter = params.get('quality');
  const dollarType = params.get('dollarType') || '';

  const setDollarType = (value) => {
    const next = new URLSearchParams(params);
    if (value) next.set('dollarType', value);
    else next.delete('dollarType');
    setParams(next);
  };

  const filtered = useMemo(() => {
    let rows = activities;

    if (dayFilter) {
      rows = rows.filter((a) => a.date === dayFilter);
    } else if (period !== 'all') {
      rows = activitiesInRange(rows, rangeForPeriod(period));
    }

    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((a) =>
        [a.title, a.result, a.organization, a.system, a.unit, a.category, a.notes, a.description]
          .some((f) => String(f || '').toLowerCase().includes(q))
      );
    }
    if (category) rows = rows.filter((a) => a.category === category);
    if (jepes) rows = rows.filter((a) => (a.jepes_area || 'Unassigned') === jepes);
    if (dollarType) rows = rows.filter((a) => a.dollar_type === dollarType && a.dollar_amount);
    if (qualityFilter === 'complete') rows = rows.filter((a) => strength(a) >= 2);
    if (qualityFilter === 'needs-detail') rows = rows.filter((a) => strength(a) < 2);

    const sorted = [...rows];
    switch (sort) {
      case 'date-asc':
        sorted.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        break;
      case 'dollar-desc':
        sorted.sort((a, b) => (b.dollar_amount || 0) - (a.dollar_amount || 0));
        break;
      case 'quantity-desc':
        sorted.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
        break;
      case 'strength-asc':
        sorted.sort((a, b) => strength(a) - strength(b));
        break;
      case 'strength-desc':
        sorted.sort((a, b) => strength(b) - strength(a));
        break;
      default:
        sorted.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    return sorted;
  }, [activities, query, period, category, jepes, dollarType, sort, dayFilter, qualityFilter]);

  const metrics = useMemo(() => aggregateMetrics(filtered), [filtered]);
  const activeFilters = [category, jepes, dollarType, query, dayFilter, qualityFilter].filter(Boolean).length;

  const clearAll = () => {
    setQuery('');
    setCategory('');
    setJepes('');
    setPeriod('all');
    setParams({});
  };

  const doExport = async () => {
    try {
      const mine = filtered.filter((row) => row.user_id === identity?.user?.id);
      const myProjects = projects.filter((row) => row.user_id === identity?.user?.id);
      await exportWorkbook({ activities: mine, projects: myProjects }, `vantage-activities-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success(`Exported ${mine.length} of your activities.`);
    } catch (err) {
      toast.error(err.message || 'Export failed.');
    }
  };

  return (
    <div className="page-canvas records-page">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
        <div>
          <p className="eyebrow">Searchable operational ledger</p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">Records</h2>
          <p className="mt-1.5 max-w-2xl text-base text-text-3">Every activity, transaction, quantity, and outcome—structured for retrieval instead of buried in a spreadsheet.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" asChild>
            <Link to="/settings#data"><Upload className="h-3.5 w-3.5" />Import CSV</Link>
          </Button>
        <Button variant="default" size="sm" onClick={doExport} disabled={!filtered.length}>
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
        </div>
      </div>

      <div className="mb-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles, results, systems…"
              className="pl-7"
            />
          </div>
          <Segmented value={dayFilter ? 'all' : period} onChange={(v) => { setParams({}); setPeriod(v); }} options={PERIODS} />
          <Button
            variant={showFilters || activeFilters ? 'outline' : 'ghost'}
            size="sm"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {activeFilters > 0 && <Badge tone="signal">{activeFilters}</Badge>}
          </Button>
          <Select
            value={sort}
            onValueChange={setSort}
            options={SORTS}
            className="w-40"
          />
        </div>

        {dayFilter && (
          <div className="flex items-center gap-2">
            <Badge tone="signal">{formatDTG(dayFilter)}</Badge>
            <button onClick={() => setParams({})} className="text-xs text-text-3 hover:text-text">
              clear day filter
            </button>
          </div>
        )}

        {qualityFilter && (
          <div className="flex items-center gap-2">
            <Badge tone="signal">{qualityFilter === 'complete' ? 'Complete records' : 'Needs detail'}</Badge>
            <button onClick={() => { const next = new URLSearchParams(params); next.delete('quality'); setParams(next); }} className="text-xs text-text-3 hover:text-text">
              clear quality filter
            </button>
          </div>
        )}

        {showFilters && (
          <div className="panel grid grid-cols-1 gap-2 rounded p-2 sm:grid-cols-3">
            <Select
              value={category}
              onValueChange={setCategory}
              placeholder="Any category"
              options={[{ value: '', label: 'Any category' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]}
            />
            <Select
              value={jepes}
              onValueChange={setJepes}
              placeholder="Any JEPES area"
              options={[{ value: '', label: 'Any JEPES area' }, ...JEPES_AREAS.map((j) => ({ value: j, label: j }))]}
            />
            <Select
              value={dollarType}
              onValueChange={setDollarType}
              placeholder="Any dollar type"
              options={[{ value: '', label: 'Any dollar type' }, ...DOLLAR_TYPES.map((d) => ({ value: d.key, label: d.label }))]}
            />
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-x-7 gap-y-2 border-y border-rule px-1 py-3">
        <span className="fig text-xs text-text-2">
          <span className="text-text">{formatNumber(filtered.length)}</span> entries
        </span>
        <span className="fig text-xs text-text-2">
          <span className="text-text">{formatNumber(metrics.totalQuantity)}</span> action amount
        </span>
        <Tooltip content={DOLLAR_SUM_RULE}>
          <span className="fig cursor-help text-xs text-text-2">
            <span className="text-ledger">{formatDollarsExact(metrics.totalDollars)}</span> headline transaction value
          </span>
        </Tooltip>
        {metrics.reviewedDollars > 0 && (
          <span className="fig text-xs text-text-3">{formatDollars(metrics.reviewedDollars)} reviewed (excluded)</span>
        )}
        {activeFilters > 0 && (
          <button onClick={clearAll} className="ml-auto flex items-center gap-1 text-xs text-text-3 hover:text-text">
            <X className="h-3 w-3" />
            Clear filters
          </button>
        )}
      </div>

      <DollarTypeBreakdown amounts={metrics.dollarsByType} className="mb-4" />

      <Panel bodyClassName="p-0">
        {filtered.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title={activities.length ? 'Nothing matches those filters' : 'No activities logged'}
            description={activities.length ? 'Loosen a filter or widen the window.' : 'Press N to log your first entry.'}
            action={activeFilters > 0 && <Button size="sm" onClick={clearAll}>Clear filters</Button>}
          />
        ) : (
          <>

            <div className="hidden items-center gap-3 border-b border-rule px-3 py-1.5 md:flex">
              <span className="eyebrow w-16 shrink-0">Date</span>
              <span className="eyebrow min-w-0 flex-1">Entry</span>
              <span className="eyebrow w-32 shrink-0">Category</span>
              <span className="eyebrow w-28 shrink-0 text-right">Action amount</span>
              <span className="eyebrow w-28 shrink-0 text-right">Transaction value</span>
              <span className="eyebrow w-28 shrink-0 text-right">Status</span>
            </div>

            {filtered.map((a) => (
              <Link
                key={a.id}
                to={`/activities/${a.id}`}
                className="row flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 md:flex-nowrap"
              >
                <span className="fig w-16 shrink-0 text-2xs text-text-3">{formatDTG(a.date)}</span>

                <span className="order-last min-w-0 flex-1 basis-full md:order-none md:basis-auto">
                  <span className="block truncate text-base text-text">{a.title}</span>
                  {(a.result || a.system || a.organization) && (
                    <span className="block truncate text-2xs text-text-3">
                      {[a.result, a.system, a.organization].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>

                <span className="flex w-32 shrink-0 items-center gap-1.5 text-xs text-text-2">
                  <Dot color={CATEGORY_COLORS[a.category]} />
                  <span className="truncate">{a.category}</span>
                </span>

                <span className="fig w-28 shrink-0 text-right text-xs text-text-2">
                  {a.quantity ? `${formatNumber(a.quantity)} ${unitFor(a.unit || 'items', a.quantity)}` : '—'}
                </span>

                <span
                  className={cn(
                    'fig w-28 shrink-0 text-right text-xs',
                    a.dollar_amount ? (a.dollar_type === 'reviewed' ? 'text-text-3' : 'text-ledger') : 'text-text-3'
                  )}
                >
                  {a.dollar_amount ? (
                    <><span className="block">{formatDollars(a.dollar_amount)}</span><span className="block text-2xs text-text-3">{DOLLAR_TYPES.find((type) => type.key === a.dollar_type)?.label || 'Impact'}</span></>
                  ) : '—'}
                </span>

                <span className={cn('flex w-28 shrink-0 items-center justify-end gap-1.5 text-xs', strength(a) >= 2 ? 'text-ledger' : 'text-attention')}>
                  {strength(a) >= 2 ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleAlert className="h-3.5 w-3.5" />}
                  {strength(a) >= 2 ? 'Complete' : 'Needs detail'}
                </span>
              </Link>
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}
