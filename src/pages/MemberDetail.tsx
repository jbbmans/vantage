import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileDown, MessageSquare, Award as AwardIcon, Pencil, ShieldCheck, Sparkles, Activity, Timer, Printer } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Tabs, TabPanel, Panel, EmptyState, Badge, Skeleton, Stat } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import { DraftStrip, useResumeDraft } from '@/components/FormDrafts';
import { AiAction, AiResult } from '@/components/AiPanel';
import { DateText, StatusBadge, CategoryDot, DescriptionList, Table, useParam } from '@/components/common';
import { AwardFields, emptyAward, evidenceCount } from '@/pages/Career';
import { AmendDialog, CounselingActions, CounselingDialog, CounselingHistory, CounselingStatus, counselingDraft, emptyCounseling, openCounselingPrint, type CounselingDraft } from '@/components/Counseling';
import { counselorWritten } from '../../shared/counseling';
import { Attachments } from '@/components/Attachments';
import { CourseCodeText, TrainingCourse } from '@/components/Course';
import { TimeframeText, timeframeCheck } from '@/components/Timeframe';
import { can, canCorrectDuty, keys, useIdentity, useOrg, useRoles, useTrack, useMetrics, useMetricsReport } from '@/lib/queries';
import { MetricTotalsGrid } from '@/components/MetricTotals';
import * as api from '@/lib/api';
import { useForgetVisit, useRememberVisit } from '@/lib/recent';
import { DEFAULT_PERIOD, aggregateMetrics, formatDollars, formatNumber, rangeForPeriod, dayKey, NO_VALUE } from '../../shared/metrics';
import { trackForGrade, trackMeta, mapAreaToTrack } from '../../shared/evaluation';
import { estimateJepes } from '../../shared/jepesEstimate';
import { EstimateBreakdown, EstimateSources, EstimateTotal } from '@/components/JepesEstimate';
import { humanize, fullName, cn, useMediaQuery } from '@/lib/utils';
import WhyList from '@/components/WhyList';
import { PersonnelPanel } from '@/components/PersonnelRecord';
import { endOfDay, tomorrowKey, type UnitExplanation } from '@/lib/tenancy';
import DutyDialog, { DUTY_TONE, DutyDetail, type DutyMode } from '@/components/DutyDialog';
import { ApprovedPoints, DutyReviewActions, DutyReviewHistory } from '@/components/DutyReview';
import { hasReviewOptions } from '../../shared/dutyReview';
import { DUTY_STATUS_LABELS, formatHours } from '../../shared/duty';
import type { Counseling, Duty, Training } from '../../shared/types';
import { PERMISSIONS } from '../../shared/permissions';
import { formatTimeframe } from '../../shared/timeframe';

export default function MemberDetail() {
  const cfg = useMetrics();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  // The personnel record first (ADR-0017): anyone who sees the Marine on a roster may open it. Their records only for
  // those who may read them (ADR-0015), so a Unit Manager never asks for what they would be refused. Each read of either
  // is logged, so neither is read again on returning to the window within a minute. Once a read is a minute old, or a
  // change made it stale, coming back reads it again, so a training the Marine took back is not still shown.
  const personnel = useQuery({ queryKey: keys.personnel(id), queryFn: () => api.personnelRecord(id), staleTime: 60_000, retry: false });
  const record = personnel.data;
  const { data, isPending, error, refetch } = useQuery({ queryKey: keys.member(id), queryFn: () => api.member(id), staleTime: 60_000, retry: false, enabled: Boolean(record?.canOpenRecords) });
  const { data: readiness } = useQuery({ queryKey: ['readiness', id], queryFn: () => api.memberReadiness(id), enabled: Boolean(data) });
  const { data: rolesData } = useRoles(Boolean(data?.canManageMembers?.length));
  const [tab, setTab] = useParam('tab', 'personnel');
  // One layout at a time: on a phone the duty is a list, not a table to scroll sideways.
  const wide = useMediaQuery('(min-width: 640px)');
  const [counseling, setCounseling] = useState<{ draft: CounselingDraft; row?: Counseling } | null>(null);
  const [amending, setAmending] = useState<Counseling | null>(null);
  const [award, setAward] = useState<any>(null);
  const [duty, setDuty] = useState<DutyMode | null>(null);
  const [dutyView, setDutyView] = useState<Duty | null>(null);
  const [trainingView, setTrainingView] = useState<Training | null>(null);
  const [profile, setProfile] = useState<any>(null);
  const [prep, setPrep] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const myTrack = useTrack();
  const person = record?.person;
  useForgetVisit(identity?.user.id, `/team/${id}`, Boolean(personnel.error));
  useRememberVisit(identity?.user.id, person && id !== identity?.user.id ? { to: `/team/${id}`, title: `${person.rank_abbr ? `${person.rank_abbr} ` : ''}${person.last_name}, ${person.first_name}`, kind: 'marine' } : null);
  const track = person ? trackForGrade(person.rank_grade) : myTrack;
  const metrics = useMemo(() => aggregateMetrics(data?.activities || [], cfg), [data, cfg]);
  const memberParams = useMemo(() => { const r = rangeForPeriod(DEFAULT_PERIOD); return { from: dayKey(r.start), to: dayKey(r.end), user_id: id }; }, [id]);
  const memberMetrics = useMetricsReport(memberParams, Boolean(data));
  // The Marine's own figures worked on the published tables, as they see it (ADR-0046); opening them is audited.
  const est = useMemo(() => (readiness && Object.keys(readiness).length ? estimateJepes(readiness) : null), [readiness]);
  const isSelf = id === identity?.user.id;
  const unitId = data?.detailUnits?.[0] ?? null;
  const canCounsel = Boolean(data?.canCounsel?.length) && !isSelf;
  // An award recommendation for this Marine saved as a draft (ADR-0030) opens here from ?draft=, in the unit it names.
  const restoreAward = (p: Record<string, unknown>) => ({ ...emptyAward('unit', unitId), ...p, user_id: id });
  const resumeAward = useResumeDraft('award', (d) => setAward(restoreAward(d.payload)), { subjectId: id, enabled: !isSelf });
  const canManage = Boolean(data?.canManageMembers?.length);
  const [until, setUntil] = useState('');
  const why = useQuery<{ units: UnitExplanation[] }>({ queryKey: ['why', id], queryFn: () => api.whyCan(id!), enabled: Boolean(id) && Boolean(data) && tab === 'roles', retry: false });
  const unitLabel = (u: string) => { const x = (org?.units || []).find((y) => y.id === u); return x ? x.short_name || x.name : u; };
  // A training open here closes once the page has been read again and no longer lists it: un-shared, moved or removed.
  // A read that failed closes nothing, and nothing reopens by itself.
  useEffect(() => { if (trainingView && data && !error && !data.trainings.some((t) => t.id === trainingView.id)) setTrainingView(null); }, [data, error, trainingView]);

  // The page paints once the personnel record is in; their records fill their tabs when they arrive.
  if (personnel.isPending) return <div className="page space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-64" /></div>;
  if (personnel.error || !record || !person) return <div className="page"><div className="card"><EmptyState title="Cannot open this Marine" description={api.errorText(personnel.error)} action={<Button onClick={() => navigate('/team')}>Back to Personnel</Button>} /></div></div>;
  // Their records, when this reader may open them; otherwise the Personnel tab alone.
  const records = record.canOpenRecords && !error ? data ?? null : null;
  const recordsLoading = record.canOpenRecords && isPending;
  const shownTab = records || recordsLoading || tab === 'personnel' ? tab : 'personnel';
  // A list longer than the page lists is cut to its newest, and says so.
  const cut = (listed: number, total: number, what: string) => (total > listed ? <p className="mb-2 text-xs text-ink-3">Showing the newest {listed} of {total} {what}.</p> : null);
  // The open duty as the page holds it now; a decision just made is ahead of a page still being read again.
  const dutyListed = dutyView ? records?.duties.find((r) => r.id === dutyView.id) : undefined;
  const dutyViewed = dutyView ? (dutyListed && dutyListed.version >= dutyView.version ? dutyListed : dutyView) : null;
  // The open training as the page lists it now, or as it was opened while the page is being read again.
  const trainingViewed = trainingView ? records?.trainings.find((t) => t.id === trainingView.id) ?? trainingView : null;
  const canEditProfile = record.canEditProfile;
  const sourced = new Set(record.sourced);
  const reload = () => { personnel.refetch(); if (records) refetch(); qc.invalidateQueries({ queryKey: ['personnel'] }); qc.invalidateQueries({ queryKey: keys.team }); };

  const download = async () => { try { const name = await api.downloadFile(api.reportPdfUrl({ user_id: id, unit_id: unitId, period: DEFAULT_PERIOD, limit: 12 }), 'vantage-report.pdf'); toast.success(`Downloaded ${name}.`); } catch (e) { toast.error(api.errorText(e)); } };
  const grant = async (roleId: string, unit: string) => { try { await api.grantRole(id, { role_id: roleId, unit_id: unit, expires_at: endOfDay(until) }); refetch(); why.refetch(); qc.invalidateQueries({ queryKey: keys.team }); toast.success(until ? `Role granted until ${new Date(`${until}T12:00:00`).toLocaleDateString()}. Their sessions were reset.` : 'Role granted. Their sessions were reset.'); } catch (e) { toast.error(api.errorText(e)); } };
  const revoke = async (roleId: string) => { try { await api.revokeRole(id, roleId); refetch(); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role removed.'); } catch (e) { toast.error(api.errorText(e)); } };
  // What the personnel feed sets is not sent, so a correction to the rest is never refused for it.
  const saveProfile = async () => { try { const body = Object.fromEntries(Object.entries({ first_name: profile.first_name, last_name: profile.last_name, middle_initial: profile.middle_initial || null, rank_id: profile.rank_id || null, mos: profile.mos || null, eas: profile.eas || null }).filter(([k]) => !sourced.has(k))); await api.updateMemberProfile(id, body); reload(); toast.success('Profile updated.'); setProfile(null); } catch (e) { toast.error(api.errorText(e)); } };
  const pendingAck = records ? records.counselings.filter((c) => c.stage === 'final' && !c.acknowledged_at && counselorWritten(c)).length : 0;
  const counselingsCut = Boolean(records && records.counts.counselings > records.counselings.length);
  const goalsCut = Boolean(records && records.counts.goals > records.goals.length);
  const assignments = record.instances.flatMap((i) => i.assignments);

  return (
    <div className="page">
      <Link to="/team" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />Personnel</Link>
      <PageHeader eyebrow={assignments.map((m) => `${m.unit_short || m.unit_name}${m.billet ? ` · ${m.billet}` : ''}`).join(' · ') || 'No unit'} title={fullName(person)} lede={`${person.rank_name || 'No rank'}${person.mos ? ` · MOS ${person.mos}` : ''}${person.eas ? ` · EAS ${person.eas}` : ''} · ${trackMeta(track).name} track${isSelf ? ' · this is you' : ''}`}>
        {canEditProfile && <Button onClick={() => setProfile({ first_name: person.first_name, last_name: person.last_name, middle_initial: person.middle_initial || '', rank_id: person.rank_id || '', mos: person.mos || '', eas: person.eas || '' })}><Pencil className="h-4 w-4" />Edit profile</Button>}
        {canCounsel && <Button onClick={() => setAward({ ...emptyAward('unit', unitId), user_id: id })}><AwardIcon className="h-4 w-4" />Recommend award</Button>}
        {canCounsel && <Button onClick={() => setDuty({ kind: 'new', forUser: { id, name: fullName(person) } })}><Timer className="h-4 w-4" />Record duty</Button>}
        {canCounsel && <Button variant="primary" onClick={() => setCounseling({ draft: { ...emptyCounseling('unit', unitId), user_id: id } })} data-tutorial="counseling-new-for-marine"><MessageSquare className="h-4 w-4" />New counseling</Button>}
        {records && <Button onClick={download}><FileDown className="h-4 w-4" />{trackMeta(track).inputName} PDF</Button>}
      </PageHeader>
      {!isSelf && <p className="mb-4 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2"><ShieldCheck className="h-4 w-4 text-ink-3" />{records ? `You are seeing only what this Marine shared with ${records.detailUnits.map(unitLabel).join(', ')}. This view was logged to the unit access log.` : recordsLoading ? 'You are seeing their personnel record. What they shared with your units is loading. Each view is logged.' : 'You are seeing their personnel record: where they serve, in what billet and under whom. Their entries stay with those who may read them. This view was logged.'}</p>}
      {records && <>
      <div className="mb-4">
        <h2 className="eyebrow mb-2">Shared outcomes, fiscal year to date</h2>
        <MetricTotalsGrid
          headline={memberMetrics.data?.headline || []}
          tracked={memberMetrics.data?.tracked || []}
          prior={memberMetrics.data?.priorHeadline || []}
          params={memberParams}
          emptyTitle="No shared outcome carries a measurable result yet"
          emptyDescription="This Marine has shared no entry with a quantity, a value, or logged hours in this period."
        />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-2">
        <Stat label="Open tasks" value={records.counts.tasks} hint={`${records.goals.filter((g) => g.status === 'active').length}${goalsCut ? ' or more' : ''} active goals`} />
        <Stat label="Counselings" value={records.counts.counselings} hint={pendingAck ? `${pendingAck}${counselingsCut ? ' or more' : ''} not yet acknowledged` : counselingsCut ? `none of the newest ${records.counselings.length} awaits acknowledgment` : 'all acknowledged'} tone={pendingAck ? 'warn' : undefined} />
      </div>
      </>}
      {!isSelf && <DraftStrip kind="award" subjectId={id} onContinue={resumeAward.open} />}
      {/* Each count is of every record the reader may see, from the server, not of the list it sends. */}
      <Tabs value={shownTab} onChange={setTab} className="mb-4" label="This Marine’s records" panel="member-panel" tabs={[{ value: 'personnel', label: 'Personnel' }, ...(records || recordsLoading ? [{ value: 'overview', label: 'Overview' }, { value: 'activities', label: 'Activities', count: records?.counts.activities }, { value: 'counseling', label: 'Counseling', count: records?.counts.counselings }, { value: 'career', label: 'Awards and training', count: records ? records.counts.awards + records.counts.trainings : undefined }, { value: 'duty', label: 'Duty', count: records?.counts.duties }, { value: 'roles', label: 'Roles' }] : [])]} />

      <TabPanel id="member-panel" value={shownTab}>
      {shownTab === 'personnel' && <PersonnelPanel record={record} onTab={records || recordsLoading ? setTab : undefined} onChanged={reload} />}
      {shownTab !== 'personnel' && recordsLoading && <div className="space-y-3" aria-hidden><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}

      {records && <>
      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title={`${trackMeta(track).areaLabel} balance`} subtitle={records.counts.activities > records.activities.length ? `From the newest ${records.activities.length} of ${records.counts.activities} shared activities` : undefined} className="lg:col-span-1"><ul className="space-y-1.5">{Object.entries(metrics.byArea).map(([area, b]) => <li key={area} className="flex items-center justify-between text-sm"><span className="text-ink">{mapAreaToTrack(area, track)}</span><span className="fig text-xs text-ink-3">{b.count}</span></li>)}{!Object.keys(metrics.byArea).length && <li className="text-sm text-ink-3">No shared entries.</li>}</ul></Panel>
          <Panel title="Readiness" subtitle="As entered by the Marine">{!readiness || !Object.keys(readiness).length ? <p className="text-sm text-ink-3">Nothing entered.</p> : <dl className="grid grid-cols-2 gap-2 text-sm">{[['PFT', readiness.pft_score], ['CFT', readiness.cft_score], ['Rifle', readiness.rifle_qual], ['MCMAP', readiness.mcmap_belt], ['PME', readiness.pme_complete ? humanize(readiness.pme_complete) : null], ['CEUs', readiness.ceus]].map(([k, v]) => <div key={String(k)} className="rounded-md border border-line px-3 py-2"><dt className="eyebrow">{k}</dt><dd className={cn('fig mt-0.5 font-semibold', v == null || v === '' ? 'text-ink-3' : 'text-ink')}>{v == null || v === '' ? NO_VALUE : String(v)}</dd></div>)}</dl>}</Panel>
          {est && track === 'jepes' && est.applies && <Panel title="JEPES estimate" subtitle="From the figures the Marine entered" className="lg:col-span-2"><EstimateTotal est={est} /><p className="mt-1 text-xs text-ink-2">The score of record is the one on MOL. This works the MCO 1616.1 worksheet on the Marine’s own figures, as they see it on Readiness.</p><div className="mt-3"><EstimateBreakdown est={est} /></div><div className="mt-3"><EstimateSources est={est} /></div></Panel>}
          <Panel title="Open work and goals">{records.tasks.length === 0 && records.goals.length === 0 ? <p className="text-sm text-ink-3">Nothing shared.</p> : <ul className="space-y-1.5 text-sm">{records.tasks.slice(0, 5).map((t) => <li key={t.id} className="flex justify-between gap-2"><span className="truncate text-ink">{t.title}</span><span className="text-xs text-ink-3"><DateText value={t.due_date} fallback="" /></span></li>)}{records.goals.filter((g) => g.status === 'active').slice(0, 4).map((g) => <li key={g.id} className="flex justify-between gap-2"><span className="truncate text-ink-2">Goal: {g.title}</span><span className="fig text-xs text-ink-3">{g.target_value ? `${Math.round((Number(g.current_value) / Number(g.target_value)) * 100)}%` : ''}</span></li>)}</ul>}</Panel>
          {canCounsel && identity?.instance.aiEnabled && <Panel className="lg:col-span-3" title="Counseling preparation" subtitle="AI drafts talking points from shared records; verify before the sit-down" action={<AiAction workflow="counseling_prep" input={{ user_id: id, unit_id: unitId, days: 90 }} label="Prepare" onResult={(output, meta) => setPrep({ output, meta })} />}>{prep ? <AiResult output={prep.output} meta={prep.meta} /> : <p className="flex items-center gap-2 text-sm text-ink-3"><Sparkles className="h-4 w-4" />Uses the last 90 days of shared entries, goals, and prior counselings.</p>}</Panel>}
        </div>
      )}

      {tab === 'activities' && (records.activities.length === 0 ? <div className="card"><EmptyState icon={Activity} title="No shared activities" /></div> : (
        <>{cut(records.activities.length, records.counts.activities, 'shared activities')}
        <div className="card" style={{ overflow: 'hidden' }}><Table label="Shared activities" head={<><th scope="col" className="w-24">Date</th><th scope="col">Entry</th><th scope="col" className="w-40">{trackMeta(track).areaLabel}</th><th scope="col" className="w-24 text-right">Qty</th><th scope="col" className="w-28 text-right">Value</th></>}>
          {records.activities.map((a) => <tr key={a.id}><td className="text-xs"><TimeframeText table="activities" row={a} /></td><td><Link to={`/records/${a.id}`} className="flex items-start gap-2"><CategoryDot category={a.category} /><span><span className="block font-medium text-ink hover:underline">{a.title}</span>{a.result && <span className="block truncate text-xs text-ink-3">{a.result}</span>}</span></Link></td><td className="text-xs">{mapAreaToTrack(a.eval_area, track)}</td><td className="fig text-right text-xs">{a.quantity != null ? `${formatNumber(a.quantity)} ${a.unit_label || ''}` : ''}</td><td className="fig text-right text-xs">{a.dollar_amount != null ? formatDollars(a.dollar_amount) : ''}</td></tr>)}
        </Table></div></>
      ))}

      {tab === 'counseling' && (records.counselings.length === 0 ? <div className="card"><EmptyState icon={MessageSquare} title="No counselings on record" action={canCounsel ? <Button variant="primary" onClick={() => setCounseling({ draft: { ...emptyCounseling('unit', unitId), user_id: id } })}>New counseling</Button> : undefined} /></div> : (
        <div className="space-y-3">{cut(records.counselings.length, records.counts.counselings, 'counselings')}{records.counselings.map((c) => (
          <article key={c.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3"><DateText value={c.date} fallback="No date" /><Badge>{humanize(c.type)}</Badge>{c.counselor_name && <span>by {c.counselor_name}</span>}<CounselingStatus row={c} />{c.follow_up_date && <span>follow-up <DateText value={c.follow_up_date} /></span>}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{c.summary}</p>
            <DescriptionList items={[['Strengths', c.strengths], ['Areas to improve', c.improvements], ['Goals set', c.goals_set]]} />
            <CounselingHistory row={c} className="mt-3" />
            <div className="mt-2 flex flex-wrap justify-end gap-1">
              <Button size="xs" variant="ghost" onClick={() => openCounselingPrint(c.id)}><Printer className="h-3.5 w-3.5" aria-hidden />Print</Button>
              <CounselingActions row={c} size="xs" onEdit={() => setCounseling({ draft: counselingDraft(c), row: c })} onAmend={() => setAmending(c)} onMoved={() => refetch()} />
            </div>
          </article>
        ))}</div>
      ))}

      {tab === 'career' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Awards" subtitle={records.counts.awards > records.awards.length ? `The newest ${records.awards.length} of ${records.counts.awards}` : undefined} padded={false}>{!records.awards.length ? <EmptyState title="No shared awards" /> : <ul>{records.awards.map((a) => <li key={a.id} className="row flex items-center justify-between gap-2 px-4 py-2.5 text-sm"><span><span className="block text-ink">{a.name}</span><span className="block text-xs text-ink-3"><TimeframeText table="awards" row={a} /> · {humanize(a.type)}</span></span><StatusBadge value={a.status} /></li>)}</ul>}</Panel>
          <Panel title="Training" subtitle={records.counts.trainings > records.trainings.length ? `The newest ${records.trainings.length} of ${records.counts.trainings}` : undefined} padded={false}>{!records.trainings.length ? <EmptyState title="No shared training" /> : <ul>{records.trainings.map((t) => <li key={t.id} className="row flex items-center justify-between gap-2 px-4 py-2.5 text-sm"><span className="min-w-0">{t.evidence_count != null ? <button type="button" className="block text-left font-medium text-ink hover:underline" onClick={() => setTrainingView(t)} data-tutorial="member-training-open">{t.title}</button> : <span className="block text-ink">{t.title}</span>}<span className="block text-xs text-ink-3"><TimeframeText table="trainings" row={t} /> · {t.type === 'pme' ? 'PME' : humanize(t.type)}{t.course_code ? <> · <CourseCodeText row={t} /></> : null}{t.provider ? ` · ${t.provider}` : ''}</span></span><span className="shrink-0 text-right text-xs text-ink-3"><span className="fig block">{t.hours ? `${t.hours} h` : ''}</span>{t.evidence_count != null && <span className="block">Evidence: {evidenceCount(t.evidence_count)}</span>}</span></li>)}</ul>}</Panel>
        </div>
      )}

      {tab === 'duty' && (records.duties.length === 0 ? <div className="card"><EmptyState icon={Timer} title="No duty shared with your units" description="Duty this Marine stood for a unit you lead shows here, with its hours, its points and where it stands with its reviewers." action={canCounsel ? <Button variant="primary" onClick={() => setDuty({ kind: 'new', forUser: { id, name: fullName(person) } })}>Record duty</Button> : undefined} /></div> : (
        <>{cut(records.duties.length, records.counts.duties, 'duties')}
        {wide ? <div className="card" style={{ overflow: 'hidden' }}><Table label="Shared duty" minWidth={760} head={<><th scope="col" className="w-44">When</th><th scope="col">Duty</th><th scope="col" className="w-20 text-right">Hours</th><th scope="col" className="w-24 text-right">Calculated</th><th scope="col" className="w-24 text-right">Approved</th><th scope="col" className="w-28">Status</th><th scope="col" className="relative w-28"><span className="sr-only">Actions</span></th></>}>
          {records.duties.map((r) => <tr key={r.id}><td className="text-xs"><TimeframeText table="duties" row={r} /></td><td><button type="button" className="text-left font-medium text-ink hover:underline" onClick={() => setDutyView(r)}>{r.title || r.duty_type_name || 'Duty'}</button><span className="block text-xs text-ink-3">{[r.title ? r.duty_type_name : null, r.recorded_by && r.recorded_by !== r.user_id ? `recorded by ${r.recorded_by === identity?.user.id ? 'you' : r.recorder_name || 'a leader'}` : null].filter(Boolean).join(' · ')}</span></td><td className="fig text-right text-xs">{formatHours(r.hours)}</td><td className="fig text-right text-xs">{r.calculated_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.calculated_points)}</td><td className="fig text-right text-xs"><ApprovedPoints row={r} /></td><td><Badge tone={DUTY_TONE[r.approval_status]}>{DUTY_STATUS_LABELS[r.approval_status]}</Badge></td><td className="text-right">{hasReviewOptions(r.review) && <Button size="xs" variant="soft" onClick={() => setDutyView(r)}>Review</Button>}{canCorrectDuty(identity, r) && <Button size="xs" variant="ghost" onClick={() => setDuty({ kind: 'edit', row: r })}>Edit</Button>}</td></tr>)}
        </Table></div>
          : <ul className="card divide-y divide-line overflow-hidden p-0" aria-label="Shared duty">
            {records.duties.map((r) => <li key={r.id} className="space-y-1.5 px-4 py-3">
              <div className="flex items-start justify-between gap-2"><div className="min-w-0"><button type="button" className="text-left font-medium text-ink hover:underline" onClick={() => setDutyView(r)}>{r.title || r.duty_type_name || 'Duty'}</button><span className="block text-xs text-ink-3"><TimeframeText table="duties" row={r} /></span><span className="block text-xs text-ink-3">{[r.title ? r.duty_type_name : null, r.recorded_by && r.recorded_by !== r.user_id ? `recorded by ${r.recorded_by === identity?.user.id ? 'you' : r.recorder_name || 'a leader'}` : null].filter(Boolean).join(' · ')}</span></div><Badge tone={DUTY_TONE[r.approval_status]}>{DUTY_STATUS_LABELS[r.approval_status]}</Badge></div>
              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3"><div className="flex gap-1"><dt>Hours</dt><dd className="fig text-ink-2">{formatHours(r.hours)}</dd></div><div className="flex gap-1"><dt>Calculated</dt><dd className="fig text-ink-2">{r.calculated_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.calculated_points)}</dd></div><div className="flex gap-1"><dt>Approved</dt><dd className="fig text-ink-2"><ApprovedPoints row={r} /></dd></div></dl>
              {(hasReviewOptions(r.review) || canCorrectDuty(identity, r)) && <div className="flex flex-wrap gap-2">{hasReviewOptions(r.review) && <Button size="xs" variant="soft" onClick={() => setDutyView(r)}>Review</Button>}{canCorrectDuty(identity, r) && <Button size="xs" variant="ghost" onClick={() => setDuty({ kind: 'edit', row: r })}>Edit</Button>}</div>}
            </li>)}
          </ul>}</>
      ))}

      {tab === 'roles' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Held roles">{!records.roles.length ? <p className="text-sm text-ink-3">Only the default Marine role.</p> : <ul className="space-y-2">{records.roles.map((r) => <li key={`${r.unit_id}-${r.id}`} className="flex items-center justify-between gap-2 text-sm"><span className="flex items-center gap-2"><span className="badge-dot" style={{ backgroundColor: r.color || '#6b7a8f' }} /><span className="text-ink">{r.name}</span><span className="text-xs text-ink-3">{unitLabel(r.unit_id)}</span>{r.expires_at ? <Badge tone="warn">until {new Date(r.expires_at).toLocaleDateString()}</Badge> : null}</span>{canManage && !isSelf && r.key !== 'unit-leader' && !(rolesData?.roles || []).find((x) => x.id === r.id)?.is_default && <Button size="xs" variant="ghost" onClick={() => revoke(r.id)}>Remove</Button>}</li>)}</ul>}</Panel>
          {canManage && !isSelf && <Panel title="Grant a role" subtitle="Only roles below your own position; granting resets their sessions"><Field label="Until" hint="optional: an acting billet or a leave period ends on its own" className="mb-3"><Input type="date" value={until} min={tomorrowKey()} onChange={(e) => setUntil(e.target.value)} /></Field><ul className="space-y-1.5">{(rolesData?.roles || []).filter((r) => records.detailUnits.includes(r.unit_id) && r.editable && !r.is_default && r.key !== 'unit-leader' && !records.roles.some((h) => h.id === r.id)).map((r) => <li key={r.id} className="flex items-center justify-between gap-2 text-sm"><span className="flex items-center gap-2"><span className="badge-dot" style={{ backgroundColor: r.color || '#6b7a8f' }} /><span className="text-ink">{r.name}</span><span className="text-xs text-ink-3">{unitLabel(r.unit_id)}</span></span><Button size="xs" onClick={() => grant(r.id, r.unit_id)}>Grant</Button></li>)}</ul></Panel>}
          <Panel title="Why can they?" subtitle="Every grant behind what they can do, in the units you manage" className="lg:col-span-2">{why.isPending ? <Skeleton className="h-24" /> : why.error ? <p className="text-sm text-ink-3">{api.errorText(why.error)}</p> : <WhyList units={why.data?.units ?? []} />}</Panel>
        </div>
      )}
      </>}
      </TabPanel>

      <CounselingDialog open={Boolean(counseling)} onOpenChange={(o) => { if (!o) setCounseling(null); }} initial={counseling?.draft ?? null} row={counseling?.row} leader={!counseling?.row || counselorWritten(counseling.row)} title={counseling?.draft.id ? (counseling.row && !counselorWritten(counseling.row) ? `Edit ${person.last_name}’s own counseling notes` : `Edit counseling for ${person.last_name}`) : `New counseling for ${person.last_name}`} onSaved={() => { refetch(); setTab('counseling'); }} />
      <AmendDialog row={amending} open={Boolean(amending)} onOpenChange={(o) => { if (!o) setAmending(null); }} onAmended={() => refetch()} />
      <RecordDialog store="awards" open={Boolean(award)} onOpenChange={(o) => { if (!o) { setAward(null); resumeAward.done(); } }} initial={award} title={`Recommend ${person.last_name} for an award`} noun="Award" size="lg"
        formDraft={{ kind: 'award', subjectId: id, unitId, saved: resumeAward.saved, restore: restoreAward, told: () => fullName(person), onChange: resumeAward.done }} validate={(d: any) => (!d.name.trim() ? 'The award name is required.' : timeframeCheck('awards', d))} onSaved={() => refetch()} fields={(d: any, set, errors) => <AwardFields d={d} set={set} errors={errors} ai={<AiAction workflow="award_citation" input={{ award: d.name, facts: `${d.citation}\n${d.notes}`.trim(), user_id: id, unit_id: unitId, to: d.date || undefined }} label="Draft citation" onResult={(out) => { if (out.citation) set('citation', String(out.citation)); }} />} />} />
      <DutyDialog mode={duty} open={Boolean(duty)} onOpenChange={(o) => { if (!o) setDuty(null); }} onSaved={() => { refetch(); setTab('duty'); }} />
      <Dialog open={Boolean(dutyViewed)} onOpenChange={(o) => { if (!o) setDutyView(null); }} title={dutyViewed ? dutyViewed.title || dutyViewed.duty_type_name || 'Duty' : ''} size="lg">
        {dutyViewed && hasReviewOptions(dutyViewed.review) && (
          <section aria-label="Your decision" className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
            <h3 className="eyebrow mb-1.5">Your decision</h3>
            <DutyReviewActions row={dutyViewed} me={identity?.user.id} onDone={(saved) => { setDutyView(saved); refetch(); }} onCorrect={canCorrectDuty(identity, dutyViewed) ? () => { const r = dutyViewed; setDutyView(null); setDuty({ kind: 'edit', row: r }); } : undefined} />
          </section>
        )}
        {dutyViewed && <DutyDetail row={dutyViewed} me={identity?.user.id} />}
        {dutyViewed && <DutyReviewHistory id={dutyViewed.id} className="mt-4" />}
      </Dialog>
      {/* A shared training, with the evidence it holds (ADR-0025): opened by whoever reads the unit's shared records. */}
      <Dialog open={Boolean(trainingViewed)} onOpenChange={(o) => { if (!o) setTrainingView(null); }} title={trainingViewed?.title ?? ''} description={trainingViewed ? formatTimeframe('trainings', trainingViewed, { pattern: 'd MMMM yyyy' }) || undefined : undefined} size="lg">
        {trainingViewed && <DescriptionList items={[['Status', <StatusBadge value={trainingViewed.status} />], ['Type', trainingViewed.type === 'pme' ? 'PME' : humanize(trainingViewed.type)], ['Hours', trainingViewed.hours != null ? formatNumber(trainingViewed.hours) : null], ['Provider', trainingViewed.provider], ['Notes', trainingViewed.notes ? <span className="whitespace-pre-wrap">{trainingViewed.notes}</span> : null]]} />}
        {trainingViewed && <TrainingCourse row={trainingViewed} />}
        {trainingViewed && <div className="mt-4"><Attachments table="trainings" id={trainingViewed.id} canEdit={!trainingViewed.frozen_at && (trainingViewed.user_id === identity?.user.id || can(identity, PERMISSIONS.MANAGE_RECORDS, trainingViewed.unit_id))} /></div>}
      </Dialog>
      <Dialog open={Boolean(profile)} onOpenChange={(o) => { if (!o) setProfile(null); }} title={`Edit ${person.last_name}'s profile`} description="Rank changes notify the Marine. Email and password stay theirs." size="sm" footer={<><Button variant="ghost" onClick={() => setProfile(null)}>Cancel</Button><Button variant="primary" onClick={saveProfile}>Save</Button></>}>
        {profile && <div className="grid grid-cols-2 gap-3"><Field label="First name"><Input value={profile.first_name} onChange={(e) => setProfile({ ...profile, first_name: e.target.value })} /></Field><Field label="Last name"><Input value={profile.last_name} onChange={(e) => setProfile({ ...profile, last_name: e.target.value })} /></Field><Field label="Rank"><Select value={profile.rank_id || '__none'} onValueChange={(v) => setProfile({ ...profile, rank_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'None' }, ...(org?.ranks || []).map((r) => ({ value: r.id, label: `${r.abbr} · ${r.name}` }))]} /></Field><Field label="MOS"><Input value={profile.mos} onChange={(e) => setProfile({ ...profile, mos: e.target.value })} /></Field><Field label="EAS"><Input type="date" value={profile.eas} onChange={(e) => setProfile({ ...profile, eas: e.target.value })} /></Field><Field label="Middle initial"><Input value={profile.middle_initial} onChange={(e) => setProfile({ ...profile, middle_initial: e.target.value })} maxLength={4} /></Field></div>}
      </Dialog>
    </div>
  );
}
