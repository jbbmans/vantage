import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ShieldCheck, Users } from 'lucide-react';
import { Panel, Stat, Select, Skeleton, Badge, EmptyState, Progress } from '@/components/ui/primitives';
import * as api from '@/lib/api';
import { formatNumber } from '../../shared/metrics';

/**
 * Usage and reliability, for the person who runs the instance.
 *
 * Everything here is a count across people. There is no way to open a figure and find a name,
 * because the figures were never built from names: a breakdown too few people produced is withheld
 * rather than shown, and the events behind them carry no content in the first place.
 */

interface Distribution { count: number; median: number | null; p90: number | null; total: number }
interface Bucket { key: string; events: number; people: number }

const ms = (v: number | null) => (v == null ? '—' : v >= 60_000 ? `${Math.round(v / 60_000)} min` : `${Math.round(v / 1000)} s`);
const minutes = (v: number | null) => (v == null ? '—' : `${Math.round(v)} min`);
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
const label = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Buckets({ items, withheldCount, empty }: { items: Bucket[]; withheldCount?: number; empty: string }) {
  const max = Math.max(1, ...items.map((i) => i.events));
  if (!items.length) return <p className="text-sm text-ink-3">{empty}{withheldCount ? ` ${withheldCount} withheld as too small to show.` : ''}</p>;
  return (
    <>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-ink-2">{label(item.key)}</span>
              <span className="fig shrink-0 text-xs text-ink-3">{formatNumber(item.events)}</span>
            </div>
            <Progress value={item.events} max={max} className="mt-1" />
          </li>
        ))}
      </ul>
      {Boolean(withheldCount) && (
        <p className="mt-2 text-2xs text-ink-3">{withheldCount} more withheld: too few people contributed to show them without naming someone.</p>
      )}
    </>
  );
}

const Row = ({ label: text, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-0">
    <span className="text-sm text-ink-2">{text}</span>
    <span className="fig shrink-0 text-sm font-medium text-ink">{value}</span>
  </div>
);

export default function UsageConsole() {
  const [days, setDays] = useState('30');
  const query = useQuery({ queryKey: ['admin-usage', days], queryFn: () => api.adminUsage({ days: Number(days) }), staleTime: 60_000 });

  if (query.isPending) return <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32" />)}</div>;
  if (query.isError) return <div className="card"><EmptyState icon={Activity} title="Could not read usage" description={api.errorText(query.error)} /></div>;

  const r = query.data.report;
  const instrumented = r.coverage.filter((c: { instrumented: boolean }) => c.instrumented).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-3">
          {r.period.from} to {r.period.to} · {formatNumber(r.events)} events · {instrumented} of {r.coverage.length} measures reporting
        </p>
        <Select
          aria-label="Period"
          className="w-40"
          value={days}
          onValueChange={setDays}
          options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last year' }]}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="People" value={formatNumber(r.adoption.people)} hint="signed in and did something" icon={Users} />
        <Stat label="Capture completed" value={pct(r.capture.completionRate)} hint={`${formatNumber(r.capture.completed)} of ${formatNumber(r.capture.opened)} opened`} />
        <Stat label="Import conversion" value={pct(r.imports.conversion)} hint={`${formatNumber(r.imports.committed)} of ${formatNumber(r.imports.uploaded)} uploads`} />
        <Stat label="Failed requests" value={formatNumber(r.reliability.failedRequests)} tone={r.reliability.failedRequests ? 'warn' : undefined} hint="server refused or broke" icon={ShieldCheck} />
      </div>

      <Panel title="Three different times" subtitle="measured separately because they measure different things; they are never added together">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TimeCard
            title="Form open"
            body="From opening a form to leaving it. Includes thinking, interruptions, and lunch."
            d={r.capture.times.formOpen}
            format={ms}
          />
          <TimeCard
            title="Active editing, estimated"
            body="The browser's estimate of stretches of actual typing. An estimate, never time worked."
            d={r.capture.times.activeEditorEstimate}
            format={ms}
          />
          <TimeCard
            title="Work duration, confirmed"
            body="What a person said the work itself took. The only one of the three they stated."
            d={r.capture.times.confirmedWorkMinutes}
            format={minutes}
          />
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Where captures are abandoned" subtitle="the state a person left in, never what they had written">
          <Buckets items={r.capture.abandonmentStates} withheldCount={r.capture.abandonmentWithheld} empty="No abandoned captures in this period." />
        </Panel>

        <Panel title="Which destinations get used">
          <Buckets items={r.adoption.surfaces} withheldCount={r.adoption.surfacesWithheld} empty="No page views recorded yet." />
        </Panel>

        <Panel title="Work">
          <Row label="Rows claimed" value={formatNumber(r.work.claimed)} />
          <Row label="Rows released" value={formatNumber(r.work.released)} />
          <Row label="Actions recorded" value={formatNumber(r.work.actions)} />
          <Row label="Actions that drafted a record" value={formatNumber(r.work.draftedRecords)} />
          <Row label="Actions that closed the row" value={formatNumber(r.work.resolved)} />
          <Row label="Confirmed work, median" value={minutes(r.work.confirmedWorkMinutes.median)} />
        </Panel>

        <Panel title="Import">
          <Row label="Uploaded" value={formatNumber(r.imports.uploaded)} />
          <Row label="Previewed" value={formatNumber(r.imports.previewed)} />
          <Row label="Committed" value={formatNumber(r.imports.committed)} />
          <Row label="Rows inserted" value={formatNumber(r.imports.rowsInserted)} />
          <Row label="Rows unchanged on reimport" value={formatNumber(r.imports.rowsUnchanged)} />
          <Row label="Rows rejected" value={formatNumber(r.imports.rowsRejected)} />
          <Row label="Identifiers damaged by the spreadsheet" value={formatNumber(r.imports.damagedIdentifiers)} />
          <div className="mt-3"><Buckets items={r.imports.abandonmentStates} withheldCount={r.imports.abandonmentWithheld} empty="No abandoned imports in this period." /></div>
          <div className="mt-3">
            <p className="eyebrow mb-1">Scanner verdicts</p>
            <Buckets items={r.imports.scanVerdicts} empty="No scan verdicts recorded." />
          </div>
        </Panel>

        <Panel title="Correspondence">
          <Row label="Threads started" value={formatNumber(r.correspondence.threads)} />
          <Row label="Messages imported" value={formatNumber(r.correspondence.imported)} />
          <Row label="Already held, not stored twice" value={formatNumber(r.correspondence.duplicates)} />
          <Row label="Remote images blocked" value={formatNumber(r.correspondence.blockedRemoteImages)} />
          <Row label="Runnable content removed" value={formatNumber(r.correspondence.blockedActiveContent)} />
          <Row label="Documents linked to a thread" value={formatNumber(r.correspondence.linked)} />
          <Row label="Days to a reply, median" value={r.correspondence.daysToResponse.median == null ? '—' : `${Math.round(r.correspondence.daysToResponse.median)}`} />
          <div className="mt-3"><Buckets items={r.correspondence.states} withheldCount={r.correspondence.statesWithheld} empty="No thread moved in this period." /></div>
        </Panel>

        <Panel title="Goals and reports">
          <Row label="Goals created" value={formatNumber(r.goalsAndReports.goalsCreated)} />
          <Row label="Of those, tied to a metric" value={formatNumber(r.goalsAndReports.typedGoals)} />
          <Row label="Of those, advancing on their own" value={formatNumber(r.goalsAndReports.automaticGoals)} />
          <Row label="Report revisions saved" value={formatNumber(r.goalsAndReports.revisions)} />
          <Row label="Saves refused for a changed source" value={formatNumber(r.goalsAndReports.staleRejections)} />
          <Row label="Revisions exported" value={formatNumber(r.goalsAndReports.exports)} />
          <Row label="Records cited per revision, median" value={r.goalsAndReports.sourcesPerRevision.median ?? '—'} />
        </Panel>

        <Panel title="AI" subtitle="what was asked for and what it cost; never a prompt, never a draft">
          <Row label="Requests" value={formatNumber(r.ai.requested)} />
          <Row label="Answered" value={formatNumber(r.ai.answered)} />
          <Row label="Failed" value={formatNumber(r.ai.failed)} />
          <Row label="Suggestions taken" value={`${formatNumber(r.ai.accepted)} (${pct(r.ai.acceptanceRate)})`} />
          <Row label="Tokens" value={formatNumber(r.ai.tokens)} />
          <Row label="Response time, median" value={ms(r.ai.latencyMs.median)} />
          <div className="mt-3"><Buckets items={r.ai.workflows} withheldCount={r.ai.workflowsWithheld} empty="No AI requests in this period." /></div>
          {r.ai.failureReasons.length > 0 && (
            <div className="mt-3">
              <p className="eyebrow mb-1">Why requests failed</p>
              <Buckets items={r.ai.failureReasons} empty="" />
            </div>
          )}
        </Panel>

        <Panel title="Reliability">
          <Row label="Server refused or broke" value={formatNumber(r.reliability.failedRequests)} />
          <Row label="Pages that hit an error" value={formatNumber(r.reliability.clientErrors)} />
          <Row label="Entries queued offline" value={formatNumber(r.reliability.offlineQueued)} />
          <Row label="Queued entries replayed" value={formatNumber(r.reliability.offlineReplayed)} />
          <div className="mt-3"><Buckets items={r.reliability.byRoute} empty="No failing requests in this period." /></div>
        </Panel>

        <Panel title="Security" subtitle="counts of refusals and step-ups, never who was refused">
          <Row label="Step-ups asked for" value={formatNumber(r.security.stepUps)} />
          <Row label="Step-ups granted" value={formatNumber(r.security.stepUpsGranted)} />
          <Row label="Requests refused for authorization" value={formatNumber(r.security.authorizationDenied)} />
          <div className="mt-3"><Buckets items={r.security.deniedByRoute} empty="Nothing was refused in this period." /></div>
        </Panel>

        <Panel title="Data quality" subtitle="what entries are missing, so the form can be fixed rather than the person corrected">
          <Buckets items={r.quality.missingMeasures} empty="Nothing missing was recorded in this period." />
        </Panel>
      </div>

      <Panel title="What is measured" subtitle={`${r.coverage.length} declared measures; a client cannot send anything not on this list`}>
        <div className="flex flex-wrap gap-1.5">
          {r.coverage.map((c: { name: string; family: string; instrumented: boolean; events: number }) => (
            <Badge key={c.name} tone={c.instrumented ? 'accent' : 'neutral'} className="normal-case tracking-normal">
              {c.name}{c.events ? ` · ${formatNumber(c.events)}` : ''}
            </Badge>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          Every property is a number, a true or false, or one of a fixed set of words. There is no free-text property, so a
          draft, a workbook cell, an email body, or a keystroke has nowhere to go. A breakdown produced by fewer than{' '}
          {query.data.minimumCohort} people is withheld.
        </p>
      </Panel>
    </div>
  );
}

function TimeCard({ title, body, d, format }: { title: string; body: string; d: Distribution; format: (v: number | null) => string }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{body}</p>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between"><dt className="text-ink-3">Median</dt><dd className="fig font-medium text-ink">{format(d.median)}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-3">90th percentile</dt><dd className="fig text-ink-2">{format(d.p90)}</dd></div>
        <div className="flex justify-between"><dt className="text-ink-3">Measurements</dt><dd className="fig text-ink-2">{formatNumber(d.count)}</dd></div>
      </dl>
    </div>
  );
}
