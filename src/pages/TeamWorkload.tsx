import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Info } from 'lucide-react';
import { Panel, Progress, Segmented, Skeleton, Tooltip } from '@/components/ui/primitives';
import { WorkRow, StageBadge } from '@/components/work';
import { useWorkload } from '@/lib/queries';
import { STAGE_LABEL, WAITING_LABEL, type WaitingCategory } from '../../shared/caseModel';
import { cn, formatRange, lastDays } from '@/lib/utils';
import { QueryFailure } from '@/components/QueryFailure';
import type { WorkloadMember } from '../../shared/caseView';

const WINDOWS = [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const;

type SortKey = 'name' | 'assigned' | 'waiting' | 'blocked' | 'documents_researched' | 'research_actions' | 'submitted_actions' | 'verified_outcomes' | 'resolved_work';


/** "5 hours", "1 day", "3 days": whole units a person reads at a glance, never "1 days" or "0 days". */
const elapsed = (hours: number) => {
  if (hours < 24) { const h = Math.max(1, Math.round(hours)); return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  const d = Math.round(hours / 24);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
};
export default function TeamWorkload({ unitId }: { unitId: string }) {
  const [days, setDays] = useState<'30' | '90'>('30');
  const params = useMemo(() => lastDays(days), [days]);
  const w = useWorkload(unitId, params);
  // Alphabetical until a leader asks for an order: opening the page should not rank people.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });

  if (w.isPending) return <Skeleton className="h-64" />;
  if (w.isError || !w.data) {
    return <QueryFailure error={w.error} what="The section’s workload" onRetry={() => w.refetch()} denied={{ title: 'Workload is not available for this unit', description: 'It needs permission to view the unit’s shared records.' }} />;
  }
  const d = w.data;
  const s = d.section;
  const members = [...d.members].sort((a, b) => {
    // By last name, as a roster reads.
    const byName = (m: WorkloadMember) => `${m.name.split(' ').slice(-1)[0]} ${m.name}`;
    const cmp = sort.key === 'name' ? byName(a).localeCompare(byName(b)) : a[sort.key] - b[sort.key];
    return sort.dir === 'asc' ? cmp : -cmp;
  });
  const col = (key: SortKey, label: string, definition?: string) => (
    <th scope="col" className="px-3 py-2 text-right text-xs font-semibold text-ink-2 first:text-left" aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className="inline-flex items-center gap-1">
        <button type="button" className="inline-flex items-center gap-1 hover:text-ink" onClick={() => setSort((p) => ({ key, dir: p.key === key && p.dir === 'desc' ? 'asc' : 'desc' }))}>
          {label}{sort.key === key && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
        </button>
        {definition && <Tooltip content={definition}><button type="button" className="rounded text-ink-3 hover:text-ink" aria-label={`What counts as ${label.toLowerCase()}: ${definition}`}><Info className="h-3 w-3" /></button></Tooltip>}
      </span>
    </th>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-3">{d.unit_name} · recorded {formatRange(d.window.from, d.window.to)}</p>
        <Segmented label="Window" value={days} onChange={setDays} options={WINDOWS.map((x) => ({ value: x.value, label: x.label }))} size="sm" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['Open', s.open], ['Unassigned', s.unassigned], ['Overdue', s.overdue], ['Waiting', s.waiting], ['Blocked', s.blocked],
          ['Documents researched', s.documents_researched],
        ].map(([label, value]) => (
          <div key={String(label)} className="card p-4"><p className="text-sm text-ink-2">{label}</p><p className="stat-value mt-2">{value as number}</p></div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Where open work stands">
          <ul className="space-y-1.5 text-sm">
            {Object.entries(s.by_stage as Record<string, number>).map(([stage, n]) => (
              <li key={stage} className="flex items-center justify-between gap-2"><StageBadge stage={stage} /><span className="fig text-ink">{n}</span></li>
            ))}
          </ul>
        </Panel>
        <Panel title="What the section is waiting on" subtitle="Elapsed calendar time, never counted as work">
          {Object.keys(s.by_waiting).length === 0 ? <p className="text-sm text-ink-3">Nothing is waiting.</p> : (
            <ul className="space-y-1.5 text-sm">
              {Object.entries(s.by_waiting as Record<string, { count: number; oldest_hours: number }>).map(([cat, v]) => (
                <li key={cat} className="flex items-center justify-between gap-2"><span className="text-ink">{WAITING_LABEL[cat as WaitingCategory] || cat}</span><span className="text-xs text-ink-3">{v.count} · oldest {elapsed(v.oldest_hours)}</span></li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Age of open work">
          {/* Days since each item was opened; the bar is its share of the open work. */}
          <ul className="space-y-3 text-sm">
            {([['Under 7 days', s.aging.under_7_days, 'accent'], ['7 to 30 days', s.aging.from_7_to_30_days, 'accent'], ['Over 30 days', s.aging.over_30_days, 'warn']] as const).map(([label, n, tone]) => {
              const all = s.aging.under_7_days + s.aging.from_7_to_30_days + s.aging.over_30_days;
              return (
                <li key={label}>
                  <span className="flex justify-between"><span className="text-ink">{label}</span><span className="fig">{n}</span></span>
                  <Progress value={all ? (n / all) * 100 : 0} tone={n ? tone : 'accent'} className="mt-1" label={`${label}: ${n} of ${all}`} />
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      {d.members_visible ? (
        <Panel title="By person" subtitle="Each person’s own recorded work in the window, beside what they hold now" padded={false}>
          <div className="scroll-x">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <caption className="sr-only">Workload and recorded contributions by person</caption>
              <thead className="bg-surface-2/60">
                <tr>
                  {col('name', 'Marine')}
                  {col('assigned', 'Holding')}
                  {col('waiting', 'Waiting')}
                  {col('blocked', 'Blocked')}
                  {col('documents_researched', 'Documents researched', d.definitions.documents_researched)}
                  {col('research_actions', 'Research entries', d.definitions.research_actions)}
                  {col('submitted_actions', 'Submitted', d.definitions.submitted_actions)}
                  {col('verified_outcomes', 'Verified', d.definitions.verified_outcomes)}
                  {col('resolved_work', 'Resolved', d.definitions.resolved_work)}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="px-3 py-2"><span className="font-medium text-ink">{[m.rank_abbr, m.name].filter(Boolean).join(' ')}</span>{m.billet && <span className="block text-xs text-ink-3">{m.billet}</span>}</td>
                    {(['assigned', 'waiting', 'blocked', 'documents_researched', 'research_actions', 'submitted_actions', 'verified_outcomes', 'resolved_work'] as const).map((k) => (
                      <td key={k} className={cn('fig px-3 py-2 text-right', m[k] === 0 ? 'text-ink-3' : 'text-ink')}>{m[k]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-4 py-2 text-xs text-ink-3">Section total: {s.documents_researched} distinct documents researched. Individual counts add up to more when several people worked the same document.</p>
        </Panel>
      ) : (
        <p className="text-sm text-ink-3">Your role shows section totals. The per-person breakdown needs permission to open member records.</p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Unassigned" subtitle="Soonest due first" padded={false} action={<Link to="/work?claimed=nobody" className="text-xs text-accent hover:underline">All</Link>}>
          {d.unassigned.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">Everything open has someone on it.</p> : <ul className="divide-y divide-line">{d.unassigned.slice(0, 6).map((i) => <WorkRow key={i.id} item={i} showNext={false} />)}</ul>}
        </Panel>
        <Panel title="Needs a decision" subtitle={`${STAGE_LABEL.blocked as string}, overdue, or waiting on verification`} padded={false}>
          {d.attention.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">Nothing is stuck.</p> : <ul className="divide-y divide-line">{d.attention.slice(0, 6).map((i) => <WorkRow key={i.id} item={i} />)}</ul>}
        </Panel>
      </div>

      <details className="card p-4 text-sm">
        <summary className="cursor-pointer font-medium text-ink">How to read these numbers</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">{d.limitations.map((l: string) => <li key={l}>{l}</li>)}</ul>
      </details>
    </div>
  );
}

