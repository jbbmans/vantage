import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, Download, X, ArrowUpDown, Inbox } from 'lucide-react';
import { useActivities, useProjects } from '@/store/useStore';
import {
  aggregateMetrics, rangeForPeriod, activitiesInRange, formatDollars, formatDollarsExact,
  formatNumber, formatDTG,
} from '@/lib/metrics';
import { CATEGORIES, CATEGORY_COLORS, JEPES_AREAS, DOLLAR_TYPES, DOLLAR_SUM_RULE } from '@/lib/constants';
import { strength } from '@/lib/bullets';
import { exportWorkbook } from '@/lib/sheets';
import { useToast } from '@/components/ui/toast';
import {
  Panel, PageHeader, EmptyState, Button, Input, Select, Badge, Dot, Segmented, Tooltip,
} from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { unitFor } from '@/lib/bullets';

const PERIODS = [
  { value: 'all', label: 'ALL' },
  { value: 'week', label: 'WK' },
  { value: 'month', label: 'MO' },
  { value: 'fiscalQuarter', label: 'FQ' },
  { value: 'fiscalYear', label: 'FY' },
];

const SORTS = [
  { value: 'date-desc', label: 'Newest first' },
  { value: 'date-asc', label: 'Oldest first' },
  { value: 'dollar-desc', label: 'Largest dollars' },
  { value: 'quantity-desc', label: 'Largest quantity' },
  { value: 'strength-asc', label: 'Weakest entries' },
  { value: 'strength-desc', label: 'Strongest entries' },
];

export default function Activities() {
  const activities = useActivities();
  const projects = useProjects();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState('all');
  const [category, setCategory] = useState('');
  const [jepes, setJepes] = useState('');
  const [dollarType, setDollarType] = useState('');
  const [sort, setSort] = useState('date-desc');
  const [showFilters, setShowFilters] = useState(false);

  const dayFilter = params.get('date');

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
  }, [activities, query, period, category, jepes, dollarType, sort, dayFilter]);

  const metrics = useMemo(() => aggregateMetrics(filtered), [filtered]);
  const activeFilters = [category, jepes, dollarType, query, dayFilter].filter(Boolean).length;

  const clearAll = () => {
    setQuery('');
    setCategory('');
    setJepes('');
    setDollarType('');
    setPeriod('all');
    setParams({});
  };

  const doExport = async () => {
    try {
      await exportWorkbook({ activities: filtered, projects }, `vantage-activities-${new Date().toISOString().slice(0, 10)}.xlsx`);
      toast.success(`Exported ${filtered.length} activities.`);
    } catch (err) {
      toast.error(err.message || 'Export failed.');
    }
  };

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader title="Activity log" subtitle="Every action, with the figures attached">
        <Button variant="default" size="sm" onClick={doExport} disabled={!filtered.length}>
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </PageHeader>

      {/* filter bar */}
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

      {/* running totals for the current filter */}
      <div className="panel mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded px-3 py-2">
        <span className="fig text-xs text-text-2">
          <span className="text-text">{formatNumber(filtered.length)}</span> entries
        </span>
        <span className="fig text-xs text-text-2">
          <span className="text-text">{formatNumber(metrics.totalQuantity)}</span> units
        </span>
        <Tooltip content={DOLLAR_SUM_RULE}>
          <span className="fig cursor-help text-xs text-text-2">
            <span className="text-ledger">{formatDollarsExact(metrics.totalDollars)}</span> impact
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
            {/* table header */}
            <div className="hidden items-center gap-3 border-b border-rule px-3 py-1.5 md:flex">
              <span className="eyebrow w-16 shrink-0">Date</span>
              <span className="eyebrow min-w-0 flex-1">Entry</span>
              <span className="eyebrow w-32 shrink-0">Category</span>
              <span className="eyebrow w-28 shrink-0 text-right">Quantity</span>
              <span className="eyebrow w-28 shrink-0 text-right">Dollars</span>
              <span className="eyebrow w-12 shrink-0 text-right">Str</span>
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
                  {a.dollar_amount ? formatDollars(a.dollar_amount) : '—'}
                </span>

                <span className="flex w-12 shrink-0 items-center justify-end gap-0.5">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className={cn('h-1 w-1.5 rounded-sm', i < strength(a) ? 'bg-signal/70' : 'bg-rule')} />
                  ))}
                </span>
              </Link>
            ))}
          </>
        )}
      </Panel>
    </div>
  );
}
