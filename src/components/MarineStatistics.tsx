import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { Panel, Select, Skeleton } from '@/components/ui/primitives';
import { VisualView } from '@/components/analytics';
import DateRangePicker from '@/components/DateRangePicker';
import DownloadMenu, { type DownloadChoice } from '@/components/DownloadMenu';
import { QueryFailure } from '@/components/QueryFailure';
import { useParam } from '@/components/common';
import { keys, useIdentity, usePrefs } from '@/lib/queries';
import { usePeriodParam } from '@/lib/usePeriodParam';
import { periodQuery } from '@/lib/periodParams';
import * as api from '@/lib/api';
import { formatStamp } from '@/lib/utils';
import { DEFAULT_PERIOD, formatDate, NO_VALUE } from '../../shared/metrics';
import { REPORT_FILE_LABELS } from '../../shared/reportCatalog';
import type { MarineStatistics, StatisticsFact, StatisticsSection } from '../../shared/marineStatistics';

/**
 * A Marine's statistics over a range (ADR-0051): their entries and outcomes, duty, training and awards, counseling, and
 * what they added in Vantage, as the Analysis and the Duty report count them, with the Statistics report to take away.
 * About oneself, every record one keeps; about another Marine, what they shared with one Unit Instance's units. Reading
 * another Marine's is logged to each unit's access log, so it is read once a minute at most and never again on focus.
 */

/** A Unit Instance the reader may read the Marine in, by its first unit. */
export interface StatisticsInstance { unitId: string; label: string }

const AUDITED_READ = { staleTime: 60_000, refetchOnWindowFocus: false, retry: false } as const;

const factText = (f: StatisticsFact) => (!f.value ? (f.key === 'last_sign_in' ? 'Never' : 'None in Vantage') : f.kind === 'instant' ? formatStamp(f.value) : formatDate(f.value));

function Section({ section }: { section: StatisticsSection }) {
  const [tiles, ...charts] = section.visuals;
  return (
    <Panel title={section.title} subtitle={section.lede}>
      <div className="space-y-4">
        {tiles && <VisualView visual={tiles} />}
        {charts.length > 0 && <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">{charts.map((v) => <VisualView key={v.id} visual={v} first={v.axis || (v.kind === 'columns' ? 'Month' : undefined)} />)}</div>}
        {section.facts.length > 0 && (
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            {section.facts.map((f) => <div key={f.key} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2"><dt className="text-ink-2">{f.label}</dt><dd className="fig text-ink">{factText(f)}</dd></div>)}
          </dl>
        )}
        {section.notes.map((n) => <p key={n} className="text-xs text-ink-3">{n}</p>)}
      </div>
    </Panel>
  );
}

export default function MarineStatisticsView({ userId, instances = [] }: {
  /** The Marine, when it is not the reader. */
  userId?: string;
  /** The Unit Instances the reader may read the Marine in; a choice is offered when there is more than one. */
  instances?: StatisticsInstance[];
}) {
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const range = usePeriodParam(prefs.reportPeriod || identity?.unitDefaults?.reportPeriod || DEFAULT_PERIOD);
  const [chosen, choose] = useParam('in', instances[0]?.unitId ?? '');
  const unitId = userId ? (instances.find((i) => i.unitId === chosen) ?? instances[0])?.unitId : undefined;
  const { period, from, to } = periodQuery(range);
  const days = useMemo(() => ({ period, ...(from && to ? { from, to } : {}) }), [period, from, to]);
  const subject = useMemo(() => (userId ? { subject: 'member', user_id: userId, ...(unitId ? { unit_id: unitId } : {}) } : { subject: 'self' }), [userId, unitId]);
  const ask = useMemo(() => ({ ...days, ...(userId ? { user_id: userId, ...(unitId ? { unit_id: unitId } : {}) } : {}) }), [days, userId, unitId]);
  const query = useQuery<MarineStatistics>({ queryKey: keys.statistics(ask), queryFn: () => api.marineStatistics(ask), ...AUDITED_READ });
  const s = query.data;
  const files: DownloadChoice[] = (s?.files || []).map((fmt) => ({
    label: REPORT_FILE_LABELS[fmt][0], hint: REPORT_FILE_LABELS[fmt][1],
    url: api.reportFileUrl({ type: 'statistics', ...subject, ...days }, fmt), fallback: `vantage-statistics.${fmt}`,
  }));

  return (
    <div className="space-y-4" data-testid="statistics">
      <div className="flex flex-wrap items-end gap-3">
        <DateRangePicker value={range} ignored={range.ignored} className="w-44" onChange={range.set} />
        {userId && instances.length > 1 && (
          <Select aria-label="Unit Instance" className="w-56" value={unitId ?? ''} onValueChange={choose} options={instances.map((i) => ({ value: i.unitId, label: i.label }))} />
        )}
        {files.length > 0 && <div className="sm:ml-auto"><DownloadMenu choices={files} label="Export statistics" /></div>}
      </div>
      {query.isPending ? <Skeleton className="h-96" /> : query.isError ? <QueryFailure error={query.error} onRetry={() => query.refetch()} what="The statistics" /> : s && (
        <>
          <p className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden />
            <span>
              {`${s.period.label}. `}
              {s.self ? 'Your own record, private entries included.' : `What ${s.subject || 'this Marine'} shared with ${s.units.map((u) => u.short_name || u.name).join(', ') || NO_VALUE}. This view was logged to each unit’s access log.`}
            </span>
          </p>
          {s.privacy_act && (
            <section aria-labelledby="privacy-act" className="rounded-md border border-line px-4 py-3">
              <h2 id="privacy-act" className="eyebrow mb-1.5">Privacy Act statement</h2>
              {s.privacy_act.split('\n').filter(Boolean).map((p, i) => <p key={i} className="text-xs leading-relaxed text-ink-2">{p}</p>)}
            </section>
          )}
          {s.sections.map((x) => <Section key={x.id} section={x} />)}
          {s.notes.length > 0 && <div className="space-y-1">{s.notes.map((n) => <p key={n} className="text-xs text-ink-3">{n}</p>)}</div>}
        </>
      )}
    </div>
  );
}
