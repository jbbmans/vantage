import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, Target, Users, ArrowRight, EyeOff } from 'lucide-react';
import { Panel, Skeleton, Stat, EmptyState } from '@/components/ui/primitives';
import { useIdentity } from '@/lib/queries';
import { useView } from '@/lib/view';
import { formatDollars } from '../../shared/metrics';
import { cn } from '@/lib/utils';
import { CountUp } from '@/components/ui/motion';
import * as api from '@/lib/api';

export interface Overview {
  unit: { id: string; name: string; short_name: string | null };
  parent: { id: string; name: string } | null;
  level: 'full' | 'overview';
  window: { from: string; to: string };
  totals: { members: number; teams: number; entries: number | null; contributors: number | null; dollars: number | null; withheld: boolean };
  teams: Array<{ unit_id: string; name: string; full_name: string; parent_id: string | null; members: number; entries: number | null; contributors: number | null; dollars: number | null; withheld: boolean }>;
  roster: Array<{ id: string; name: string; rank_abbr: string | null; billet: string | null; team: string; unit_id: string }>;
  goals: Array<{ id: string; title: string; status: string; unit_id: string; period_end: string | null; unit_label: string | null; target_value: number | null; current_value: number | null; progress: { percent?: number | null } | null }>;
  minimum_contributors: number;
}

export function useUnitOverview(unitId: string | null | undefined) {
  return useQuery<Overview>({ queryKey: ['unit-overview', unitId], queryFn: () => api.unitOverview(unitId!), enabled: Boolean(unitId), staleTime: 60_000 });
}

const share = (contributors: number | null, members: number) => (contributors == null || !members ? 0 : Math.min(100, Math.round((contributors / members) * 100)));

function Withheld({ min }: { min: number }) {
  return <span className="inline-flex items-center gap-1 text-2xs text-ink-3"><EyeOff className="h-3 w-3" aria-hidden />fewer than {min} contributors, so not shown</span>;
}

/** One card per team beneath a command, each opening that team's view. */
export function TeamStrip({ data }: { data: Overview }) {
  const { data: identity } = useIdentity();
  const { views, setView } = useView(identity);
  if (!data.teams.length) return null;
  return (
    <ul className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {data.teams.map((t, i) => {
        const open = views.some((v) => v.id === t.unit_id);
        const body = (
          <>
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink">{t.name}</span>
                <span className="block text-2xs text-ink-3">{t.members} {t.members === 1 ? 'Marine' : 'Marines'}</span>
              </span>
              {open && <ArrowRight className="h-4 w-4 shrink-0 text-ink-3 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />}
            </span>
            <span className="mt-3 block h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span className="bar-grow block h-full rounded-full bg-accent" style={{ width: `${t.withheld ? 0 : share(t.contributors, t.members)}%` }} />
            </span>
            <span className="mt-1.5 block text-2xs text-ink-3">{t.withheld ? <Withheld min={data.minimum_contributors} /> : `${t.contributors} of ${t.members} shared work${t.dollars ? ` · ${formatDollars(t.dollars)} recorded` : ''}`}</span>
          </>
        );
        return (
          <li key={t.unit_id} style={{ '--i': i } as React.CSSProperties}>
            {open ? (
              <button type="button" onClick={() => setView(t.unit_id)} className="card card-hover lift group block w-full p-4 text-left" aria-label={`Open ${t.name}`}>{body}</button>
            ) : <div className="card p-4">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** The short version for Today: who is in the view and how it is doing. */
export function UnitPulse({ unitId }: { unitId: string }) {
  const { data, isPending, isError } = useUnitOverview(unitId);
  if (isPending) return <Skeleton className="mb-6 h-32" />;
  if (isError || !data) return null;
  const t = data.totals;
  const whole = data.teams.length > 0;
  return (
    <section aria-labelledby="pulse-heading" className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="pulse-heading" className="flex items-center gap-2 text-md font-semibold text-ink">
          {whole ? <Building2 className="h-4 w-4 text-accent" aria-hidden /> : <Users className="h-4 w-4 text-accent" aria-hidden />}
          {data.unit.short_name || data.unit.name}
          <span className="text-sm font-normal text-ink-3">{whole ? `· whole command, ${data.teams.length} ${data.teams.length === 1 ? 'team' : 'teams'}` : data.parent ? `· ${data.parent.name}` : ''}</span>
        </h2>
        <Link to="/team?tab=overview" className="text-xs text-accent hover:underline">Open</Link>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Marines" value={<CountUp value={t.members} />} hint={whole ? `across ${t.teams} teams` : 'on the roster'} />
        <Stat label="Contributors" value={t.withheld ? '—' : <CountUp value={t.contributors || 0} />} hint={t.withheld ? 'too few to show' : `${share(t.contributors, t.members)}% shared work, last 90 days`} />
        <Stat label="Value recorded" value={t.withheld || t.dollars == null ? '—' : <CountUp value={t.dollars} format={formatDollars} />} hint="headline value types" />
        <Stat label="Unit goals" value={<CountUp value={data.goals.filter((g) => g.status === 'active').length} />} hint="active now" />
      </div>
      {whole && <div className="mt-4"><TeamStrip data={data} /></div>}
    </section>
  );
}

/** The full version for the Team page. */
export function UnitOverviewPanel({ unitId }: { unitId: string }) {
  const { data, isPending, isError } = useUnitOverview(unitId);
  const byTeam = useMemo(() => {
    const groups = new Map<string, Overview['roster']>();
    for (const p of data?.roster || []) groups.set(p.team, [...(groups.get(p.team) || []), p]);
    return [...groups.entries()];
  }, [data]);
  if (isPending) return <Skeleton className="h-72" />;
  if (isError || !data) return <div className="card"><EmptyState icon={Users} title="This view could not be loaded" description="Try another view from the switcher, or reload." /></div>;
  const t = data.totals;
  const whole = data.teams.length > 0;
  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Marines" value={<CountUp value={t.members} />} hint={whole ? `across ${t.teams} teams` : 'on the roster'} />
        <Stat label="Contributors" value={t.withheld ? '—' : <CountUp value={t.contributors || 0} />} hint={t.withheld ? 'too few to show' : `${share(t.contributors, t.members)}% of the roster, ${data.window.from} to ${data.window.to}`} />
        <Stat label="Value recorded" value={t.withheld || t.dollars == null ? '—' : <CountUp value={t.dollars} format={formatDollars} />} hint="headline value types" />
        <Stat label="Unit goals" value={<CountUp value={data.goals.filter((g) => g.status === 'active').length} />} hint={`${data.goals.filter((g) => g.status === 'achieved').length} achieved`} />
      </div>
      {t.withheld && <p className="text-xs text-ink-3"><Withheld min={data.minimum_contributors} /> Leaders of this unit see the full figures.</p>}
      {whole && <Panel title="Teams" subtitle="Open a team to see it on its own"><TeamStrip data={data} /></Panel>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
        <Panel title="Goals" subtitle="What this unit and its command are working toward" className="xl:col-span-2" padded={false}>
          {data.goals.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">No shared goals yet.</p> : (
            <ul className="stagger divide-y divide-line">
              {data.goals.map((g, i) => {
                const pct = Math.max(0, Math.min(100, Math.round(g.progress?.percent ?? (g.target_value ? ((g.current_value || 0) / g.target_value) * 100 : 0))));
                return (
                  <li key={g.id} className="px-4 py-3" style={{ '--i': i } as React.CSSProperties}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-ink"><Target className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden /><span className="truncate">{g.title}</span></span>
                      <span className={cn('fig text-xs', g.status === 'achieved' ? 'text-good' : 'text-ink-2')}>{g.status === 'achieved' ? 'achieved' : `${pct}%`}</span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3" aria-hidden><div className={cn('bar-grow h-full rounded-full', g.status === 'achieved' ? 'bg-good' : 'bg-accent')} style={{ width: `${g.status === 'achieved' ? 100 : pct}%` }} /></div>
                    {g.period_end && <p className="mt-1 text-2xs text-ink-3">by {g.period_end}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Roster" subtitle={whole ? 'Everyone in the command, by team' : 'Everyone on the team'} className="xl:col-span-3" padded={false}>
          <div className="divide-y divide-line">
            {byTeam.map(([team, people]) => (
              <div key={team}>
                {whole && <p className="bg-surface-2/60 px-4 py-1.5 text-2xs font-semibold uppercase tracking-[0.12em] text-ink-3">{team} · {people.length}</p>}
                <ul className="stagger grid grid-cols-1 sm:grid-cols-2">
                  {people.map((p, i) => (
                    <li key={p.id} className="flex items-center gap-2.5 px-4 py-2" style={{ '--i': i } as React.CSSProperties}>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-2xs font-bold text-ink">{p.name.split(', ').reverse().map((s) => s[0] || '').join('')}</span>
                      <span className="min-w-0"><span className="block truncate text-sm text-ink">{p.rank_abbr || ''} {p.name}</span>{p.billet && <span className="block truncate text-2xs text-ink-3">{p.billet}</span>}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
