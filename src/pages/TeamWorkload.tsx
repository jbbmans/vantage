import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Info } from 'lucide-react';
import { EmptyState, Panel, Segmented, Skeleton, Tooltip } from '@/components/ui/primitives';
import { WorkList, StageBadge } from '@/components/work';
import { StatStrip } from '@/components/StatStrip';
import { useWorkload } from '@/lib/queries';
import { STAGE_LABEL, WAITING_LABEL, type WaitingCategory } from '../../shared/caseModel';
import { cn } from '@/lib/utils';

/**
 * A leader's view of the section's work. Counts sit beside the context needed to read them —
 * the window, what each person holds, what is waiting or blocked — and no person is labelled.
 * The definitions and the limits of what was captured are on the page, not in a manual.
 */
const WINDOWS = [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }] as const;

type SortKey = 'name' | 'assigned' | 'waiting' | 'blocked' | 'documents_researched' | 'research_actions' | 'submitted_actions' | 'verified_outcomes' | 'resolved_work';

export default function TeamWorkload({ unitId }: { unitId: string }) {
  const [days, setDays] = useState<'30' | '90'>('30');
  const params = useMemo(() => {
    const to = new Date(); const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [days]);
  const w = useWorkload(unitId, params);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'documents_researched', dir: 'desc' });

  if (w.isPending) return <Skeleton className="h-64" />;
  if (w.isError || !w.data) return <div className="card"><EmptyState title="Workload is not available for this unit" description="It needs permission to view the unit’s shared records." /></div>;
  const d = w.data;
  const s = d.section;
  const members = [...d.members].sort((a: any, b: any) => {
    const av = sort.key === 'name' ? a.name : a[sort.key]; const bv = sort.key === 'name' ? b.name : b[sort.key];
    const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
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
        <p className="text-sm text-ink-3">{d.unit_name} · recorded {d.window.from} to {d.window.to}</p>
        <Segmented label="Window" value={days} onChange={setDays} options={WINDOWS.map((x) => ({ value: x.value, label: x.label }))} size="sm" />
      </div>

      <StatStrip label="Section figures" className="grid-cols-2 md:grid-cols-3 xl:grid-cols-6" items={[
        { label: 'Open', value: s.open },
        { label: 'Unassigned', value: s.unassigned, tone: s.unassigned ? 'accent' : undefined },
        { label: 'Overdue', value: s.overdue, tone: s.overdue ? 'bad' : undefined, live: true },
        { label: 'Waiting', value: s.waiting },
        { label: 'Blocked', value: s.blocked, tone: s.blocked ? 'warn' : undefined, live: true },
        { label: 'Documents researched', value: s.documents_researched },
      ]} />

      {/* Three short breakdowns of the same open work, read side by side in one place. */}
      <Panel title="Where the section stands" subtitle="Open work by stage, what it is waiting on, and how long it has been open" bodyClassName="p-0">
        <div className="grid grid-cols-1 divide-y divide-line md:grid-cols-3 md:divide-x md:divide-y-0">
          <section aria-labelledby="by-stage" className="p-4">
            <h3 id="by-stage" className="eyebrow mb-3">By stage</h3>
            <ul className="space-y-2 text-sm">
              {Object.entries(s.by_stage as Record<string, number>).map(([stage, n]) => (
                <li key={stage} className="flex items-center justify-between gap-2"><StageBadge stage={stage} /><span className="fig text-ink">{n}</span></li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="waiting-on" className="p-4">
            <h3 id="waiting-on" className="eyebrow mb-3">Waiting on</h3>
            {Object.keys(s.by_waiting).length === 0 ? <p className="text-sm text-ink-3">Nothing is waiting.</p> : (
              <ul className="space-y-2 text-sm">
                {Object.entries(s.by_waiting as Record<string, { count: number; oldest_hours: number }>).map(([cat, v]) => (
                  <li key={cat} className="flex items-center justify-between gap-2"><span className="text-ink">{WAITING_LABEL[cat as WaitingCategory] || cat}</span><span className="text-xs text-ink-3">{v.count} · oldest {Math.round(v.oldest_hours / 24)} days</span></li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-3">Elapsed calendar time, never counted as work.</p>
          </section>
          <section aria-labelledby="age" className="p-4">
            <h3 id="age" className="eyebrow mb-3">Age of open work</h3>
            <ul className="space-y-2 text-sm">
              <li className="flex justify-between"><span className="text-ink">Under a week</span><span className="fig">{s.aging.under_7_days}</span></li>
              <li className="flex justify-between"><span className="text-ink">One to four weeks</span><span className="fig">{s.aging.from_7_to_30_days}</span></li>
              <li className="flex justify-between"><span className="text-ink">Over thirty days</span><span className="fig">{s.aging.over_30_days}</span></li>
            </ul>
          </section>
        </div>
      </Panel>

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
                {members.map((m: any) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="px-3 py-2"><span className="font-medium text-ink">{[m.rank_abbr, m.name].filter(Boolean).join(' ')}</span>{m.billet && <span className="block text-xs text-ink-3">{m.billet}</span>}</td>
                    {['assigned', 'waiting', 'blocked', 'documents_researched', 'research_actions', 'submitted_actions', 'verified_outcomes', 'resolved_work'].map((k) => (
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
          {d.unassigned.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">Everything open has someone on it.</p> : <WorkList items={d.unassigned.slice(0, 6)} showNext={false} />}
        </Panel>
        <Panel title="Needs a decision" subtitle={`${STAGE_LABEL.blocked as string}, overdue, or waiting on verification`} padded={false}>
          {d.attention.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">Nothing is stuck.</p> : <WorkList items={d.attention.slice(0, 6)} />}
        </Panel>
      </div>

      <details className="card p-4 text-sm">
        <summary className="cursor-pointer font-medium text-ink">How to read these numbers</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">{d.limitations.map((l: string) => <li key={l}>{l}</li>)}</ul>
      </details>
    </div>
  );
}

