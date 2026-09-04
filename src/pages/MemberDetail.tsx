import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileDown, MessageSquare, Award as AwardIcon, Pencil, ShieldCheck, Sparkles, Activity } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Tabs, Panel, EmptyState, Badge, Skeleton, Stat } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import { AiAction, AiResult } from '@/components/AiPanel';
import { DateText, StatusBadge, CategoryDot, DescriptionList, Table, useParam } from '@/components/common';
import { CounselingFields, AwardFields, emptyCounseling, emptyAward } from '@/pages/Career';
import { keys, useIdentity, useOrg, useRoles, useTrack, useMetrics } from '@/lib/queries';
import * as api from '@/lib/api';
import { aggregateMetrics, formatDollars, formatNumber } from '../../shared/metrics';
import { trackForGrade, trackMeta, mapAreaToTrack } from '../../shared/evaluation';
import { estimate } from '../../shared/jepes';
import { humanize, fullName, cn } from '@/lib/utils';

export default function MemberDetail() {
  const cfg = useMetrics();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  const { data, isPending, error, refetch } = useQuery({ queryKey: keys.member(id), queryFn: () => api.member(id), retry: false });
  const { data: readiness } = useQuery({ queryKey: ['readiness', id], queryFn: () => api.memberReadiness(id), enabled: Boolean(data) });
  const { data: rolesData } = useRoles(Boolean(data?.canManageMembers?.length));
  const [tab, setTab] = useParam('tab', 'overview');
  const [counseling, setCounseling] = useState<any>(null);
  const [award, setAward] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [prep, setPrep] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const myTrack = useTrack();
  const person = data?.person;
  const track = person ? trackForGrade(person.rank_grade) : myTrack;
  const metrics = useMemo(() => aggregateMetrics(data?.activities || [], cfg), [data, cfg]);
  const est = useMemo(() => (readiness ? estimate(readiness) : null), [readiness]);
  const isSelf = id === identity?.user.id;
  const unitId = data?.detailUnits?.[0];
  const canCounsel = Boolean(data?.canCounsel?.length) && !isSelf;
  const canManage = Boolean(data?.canManageMembers?.length) || Boolean(identity?.user.is_operator);
  const unitLabel = (u: string) => { const x = (org?.units || []).find((y: any) => y.id === u); return x ? x.short_name || x.name : u; };

  if (isPending) return <div className="page space-y-3"><Skeleton className="h-10 w-72" /><Skeleton className="h-64" /></div>;
  if (error || !data) return <div className="page"><div className="card"><EmptyState title="Cannot open this Marine" description={api.errorText(error)} action={<Button onClick={() => navigate('/team')}>Back to team</Button>} /></div></div>;

  const download = async () => { try { const name = await api.downloadFile(api.reportPdfUrl({ user_id: id, unit_id: unitId, period: 'fiscalYear', limit: 12 }), 'vantage-report.pdf'); toast.success(`Downloaded ${name}.`); } catch (e) { toast.error(api.errorText(e)); } };
  const grant = async (roleId: string, unit: string) => { try { await api.grantRole(id, { role_id: roleId, unit_id: unit }); refetch(); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role granted. Their sessions were reset.'); } catch (e) { toast.error(api.errorText(e)); } };
  const revoke = async (roleId: string) => { try { await api.revokeRole(id, roleId); refetch(); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role removed.'); } catch (e) { toast.error(api.errorText(e)); } };
  const saveProfile = async () => { try { await api.updateMemberProfile(id, { first_name: profile.first_name, last_name: profile.last_name, middle_initial: profile.middle_initial || null, rank_id: profile.rank_id || null, mos: profile.mos || null, eas: profile.eas || null }); refetch(); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Profile updated.'); setProfile(null); } catch (e) { toast.error(api.errorText(e)); } };
  const pendingAck = data.counselings.filter((c: any) => !c.acknowledged_at && c.counselor_id && c.counselor_id !== c.user_id).length;

  return (
    <div className="page">
      <Link to="/team" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />Team</Link>
      <PageHeader eyebrow={data.memberships.map((m: any) => `${m.unit_short || m.unit_name}${m.billet ? ` · ${m.billet}` : ''}`).join(' · ') || 'No unit'} title={fullName(person)} lede={`${person.rank_name || 'No rank'}${person.mos ? ` · MOS ${person.mos}` : ''}${person.eas ? ` · EAS ${person.eas}` : ''} · ${trackMeta(track).name} track${isSelf ? ' · this is you' : ''}`}>
        {canManage && !isSelf && <Button onClick={() => setProfile({ first_name: person.first_name, last_name: person.last_name, middle_initial: person.middle_initial || '', rank_id: person.rank_id || '', mos: person.mos || '', eas: person.eas || '' })}><Pencil className="h-4 w-4" />Edit profile</Button>}
        {canCounsel && <Button onClick={() => setAward({ ...emptyAward('unit', unitId), user_id: id })}><AwardIcon className="h-4 w-4" />Recommend award</Button>}
        {canCounsel && <Button variant="primary" onClick={() => setCounseling({ ...emptyCounseling('unit', unitId), user_id: id })}><MessageSquare className="h-4 w-4" />Record counseling</Button>}
        <Button onClick={download}><FileDown className="h-4 w-4" />{trackMeta(track).inputName} PDF</Button>
      </PageHeader>
      {!isSelf && <p className="mb-4 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2"><ShieldCheck className="h-4 w-4 text-ink-3" />You are seeing only what this Marine shared with {data.detailUnits.map(unitLabel).join(', ')}. This view was logged to the unit access log.</p>}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Shared entries" value={formatNumber(metrics.totalActivities)} hint={`${metrics.totalActivities ? Math.round((metrics.withOutcome / metrics.totalActivities) * 100) : 0}% with outcome`} />
        <Stat label={`${cfg.currency_label} moved`} value={formatDollars(metrics.totalDollars)} tone="accent" />
        <Stat label="Open tasks" value={data.tasks.length} hint={`${data.goals.filter((g: any) => g.status === 'active').length} active goals`} />
        <Stat label="Counselings" value={data.counselings.length} hint={pendingAck ? `${pendingAck} not yet acknowledged` : 'all acknowledged'} tone={pendingAck ? 'warn' : undefined} />
      </div>
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: 'overview', label: 'Overview' }, { value: 'activities', label: 'Activities', count: data.activities.length }, { value: 'counseling', label: 'Counseling', count: data.counselings.length }, { value: 'career', label: 'Awards and training', count: data.awards.length + data.trainings.length }, { value: 'roles', label: 'Roles' }]} />

      {tab === 'overview' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title={`${trackMeta(track).areaLabel} balance`} className="lg:col-span-1"><ul className="space-y-1.5">{Object.entries(metrics.byArea).map(([area, b]) => <li key={area} className="flex items-center justify-between text-sm"><span className="text-ink">{mapAreaToTrack(area, track)}</span><span className="fig text-xs text-ink-3">{b.count}</span></li>)}{!Object.keys(metrics.byArea).length && <li className="text-sm text-ink-3">No shared entries.</li>}</ul></Panel>
          <Panel title="Readiness" subtitle="as entered by the Marine">{!readiness || !Object.keys(readiness).length ? <p className="text-sm text-ink-3">Nothing entered.</p> : <dl className="grid grid-cols-2 gap-2 text-sm">{[['PFT', readiness.pft_score], ['CFT', readiness.cft_score], ['Rifle', readiness.rifle_qual], ['MCMAP', readiness.mcmap_belt], ['PME', readiness.pme_complete ? humanize(readiness.pme_complete) : null], ['CEUs', readiness.ceus]].map(([k, v]) => <div key={String(k)} className="rounded-md border border-line px-3 py-2"><dt className="eyebrow">{k}</dt><dd className={cn('fig mt-0.5 font-semibold', v == null || v === '' ? 'text-ink-3' : 'text-ink')}>{v == null || v === '' ? '—' : String(v)}</dd></div>)}</dl>}{est && track === 'jepes' && <p className="mt-2 text-2xs text-ink-3">{Math.round(est.completeness * 100)}% of JEPES pillars have data.</p>}</Panel>
          <Panel title="Open work and goals">{data.tasks.length === 0 && data.goals.length === 0 ? <p className="text-sm text-ink-3">Nothing shared.</p> : <ul className="space-y-1.5 text-sm">{data.tasks.slice(0, 5).map((t: any) => <li key={t.id} className="flex justify-between gap-2"><span className="truncate text-ink">{t.title}</span><span className="text-xs text-ink-3"><DateText value={t.due_date} fallback="" /></span></li>)}{data.goals.filter((g: any) => g.status === 'active').slice(0, 4).map((g: any) => <li key={g.id} className="flex justify-between gap-2"><span className="truncate text-ink-2">Goal: {g.title}</span><span className="fig text-xs text-ink-3">{g.target_value ? `${Math.round((Number(g.current_value) / Number(g.target_value)) * 100)}%` : ''}</span></li>)}</ul>}</Panel>
          {canCounsel && identity?.instance.aiEnabled && <Panel className="lg:col-span-3" title="Counseling preparation" subtitle="AI drafts talking points from shared records; verify before the sit-down" action={<AiAction workflow="counseling_prep" input={{ user_id: id, unit_id: unitId, days: 90 }} label="Prepare" onResult={(output, meta) => setPrep({ output, meta })} />}>{prep ? <AiResult output={prep.output} meta={prep.meta} /> : <p className="flex items-center gap-2 text-sm text-ink-3"><Sparkles className="h-4 w-4" />Uses the last 90 days of shared entries, goals, and prior counselings.</p>}</Panel>}
        </div>
      )}

      {tab === 'activities' && (data.activities.length === 0 ? <div className="card"><EmptyState icon={Activity} title="No shared activities" /></div> : (
        <div className="card" style={{ overflow: 'hidden' }}><Table head={<><th className="w-24">Date</th><th>Entry</th><th className="w-40">{trackMeta(track).areaLabel}</th><th className="w-24 text-right">Qty</th><th className="w-28 text-right">Value</th></>}>
          {data.activities.map((a: any) => <tr key={a.id}><td className="text-xs"><DateText value={a.date} /></td><td><Link to={`/records/${a.id}`} className="flex items-start gap-2"><CategoryDot category={a.category} /><span><span className="block font-medium text-ink hover:underline">{a.title}</span>{a.result && <span className="block truncate text-xs text-ink-3">{a.result}</span>}</span></Link></td><td className="text-xs">{mapAreaToTrack(a.eval_area, track)}</td><td className="fig text-right text-xs">{a.quantity != null ? `${formatNumber(a.quantity)} ${a.unit_label || ''}` : ''}</td><td className="fig text-right text-xs">{a.dollar_amount != null ? formatDollars(a.dollar_amount) : ''}</td></tr>)}
        </Table></div>
      ))}

      {tab === 'counseling' && (data.counselings.length === 0 ? <div className="card"><EmptyState icon={MessageSquare} title="No counselings on record" action={canCounsel ? <Button variant="primary" onClick={() => setCounseling({ ...emptyCounseling('unit', unitId), user_id: id })}>Record one</Button> : undefined} /></div> : (
        <div className="space-y-3">{data.counselings.map((c: any) => (
          <article key={c.id} className="card p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3"><DateText value={c.date} /><Badge>{humanize(c.type)}</Badge>{c.counselor_name && <span>by {c.counselor_name}</span>}{c.acknowledged_at ? <Badge tone="good">Acknowledged</Badge> : c.counselor_id && c.counselor_id !== c.user_id ? <Badge tone="warn">Awaiting acknowledgement</Badge> : <Badge>Self-recorded</Badge>}{c.follow_up_date && <span>follow-up <DateText value={c.follow_up_date} /></span>}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{c.summary}</p>
            <DescriptionList items={[['Strengths', c.strengths], ['Areas to improve', c.improvements], ['Goals set', c.goals_set]]} />
            {c.counselor_id === identity?.user.id && !c.acknowledged_at && <div className="mt-2 flex justify-end"><Button size="xs" variant="ghost" onClick={() => setCounseling({ ...c, date: c.date || '', counselor_name: c.counselor_name || '', strengths: c.strengths || '', improvements: c.improvements || '', goals_set: c.goals_set || '', follow_up_date: c.follow_up_date || '' })}>Edit</Button></div>}
          </article>
        ))}</div>
      ))}

      {tab === 'career' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Awards" padded={false}>{!data.awards.length ? <EmptyState title="No shared awards" /> : <ul>{data.awards.map((a: any) => <li key={a.id} className="row flex items-center justify-between gap-2 px-4 py-2.5 text-sm"><span><span className="block text-ink">{a.name}</span><span className="block text-xs text-ink-3"><DateText value={a.date} /> · {humanize(a.type)}</span></span><StatusBadge value={a.status} /></li>)}</ul>}</Panel>
          <Panel title="Training" padded={false}>{!data.trainings.length ? <EmptyState title="No shared training" /> : <ul>{data.trainings.map((t: any) => <li key={t.id} className="row flex items-center justify-between gap-2 px-4 py-2.5 text-sm"><span><span className="block text-ink">{t.title}</span><span className="block text-xs text-ink-3"><DateText value={t.date} /> · {t.type === 'pme' ? 'PME' : humanize(t.type)}{t.provider ? ` · ${t.provider}` : ''}</span></span><span className="fig text-xs text-ink-3">{t.hours ? `${t.hours} h` : ''}</span></li>)}</ul>}</Panel>
        </div>
      )}

      {tab === 'roles' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Held roles">{!data.roles.length ? <p className="text-sm text-ink-3">Only the default Marine role.</p> : <ul className="space-y-2">{data.roles.map((r: any) => <li key={`${r.unit_id}-${r.id}`} className="flex items-center justify-between gap-2 text-sm"><span className="flex items-center gap-2"><span className="badge-dot" style={{ backgroundColor: r.color || '#6b7a8f' }} /><span className="text-ink">{r.name}</span><span className="text-xs text-ink-3">{unitLabel(r.unit_id)}</span></span>{canManage && !isSelf && r.key !== 'unit-leader' && !(rolesData?.roles || []).find((x: any) => x.id === r.id)?.is_default && <Button size="xs" variant="ghost" onClick={() => revoke(r.id)}>Remove</Button>}</li>)}</ul>}</Panel>
          {canManage && !isSelf && <Panel title="Grant a role" subtitle="only roles below your own position; granting resets their sessions"><ul className="space-y-1.5">{(rolesData?.roles || []).filter((r: any) => data.detailUnits.includes(r.unit_id) && r.editable && !r.is_default && r.key !== 'unit-leader' && !data.roles.some((h: any) => h.id === r.id)).map((r: any) => <li key={r.id} className="flex items-center justify-between gap-2 text-sm"><span className="flex items-center gap-2"><span className="badge-dot" style={{ backgroundColor: r.color || '#6b7a8f' }} /><span className="text-ink">{r.name}</span><span className="text-xs text-ink-3">{unitLabel(r.unit_id)}</span></span><Button size="xs" onClick={() => grant(r.id, r.unit_id)}>Grant</Button></li>)}</ul></Panel>}
        </div>
      )}

      <RecordDialog store="counselings" open={Boolean(counseling)} onOpenChange={(o) => { if (!o) setCounseling(null); }} initial={counseling} title={counseling?.id ? 'Edit counseling' : `Counsel ${person.last_name}`} noun="Counseling" size="lg" validate={(d: any) => (!d.summary.trim() ? 'A summary is required.' : null)} onSaved={() => refetch()} fields={(d: any, set, errors) => <CounselingFields d={d} set={set} errors={errors} leader />} />
      <RecordDialog store="awards" open={Boolean(award)} onOpenChange={(o) => { if (!o) setAward(null); }} initial={award} title={`Recommend ${person.last_name} for an award`} noun="Award" size="lg" validate={(d: any) => (!d.name.trim() ? 'The award name is required.' : null)} onSaved={() => refetch()} fields={(d: any, set, errors) => <AwardFields d={d} set={set} errors={errors} ai={<AiAction workflow="award_citation" input={{ award: d.name, facts: `${d.citation}\n${d.notes}`.trim(), user_id: id, unit_id: unitId, to: d.date || undefined }} label="Draft citation" onResult={(out) => { if (out.citation) set('citation', String(out.citation)); }} />} />} />
      <Dialog open={Boolean(profile)} onOpenChange={(o) => { if (!o) setProfile(null); }} title={`Edit ${person.last_name}'s profile`} description="Rank changes notify the Marine. Email and password stay theirs." size="sm" footer={<><Button variant="ghost" onClick={() => setProfile(null)}>Cancel</Button><Button variant="primary" onClick={saveProfile}>Save</Button></>}>
        {profile && <div className="grid grid-cols-2 gap-3"><Field label="First name"><Input value={profile.first_name} onChange={(e) => setProfile({ ...profile, first_name: e.target.value })} /></Field><Field label="Last name"><Input value={profile.last_name} onChange={(e) => setProfile({ ...profile, last_name: e.target.value })} /></Field><Field label="Rank"><Select value={profile.rank_id || '__none'} onValueChange={(v) => setProfile({ ...profile, rank_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'None' }, ...(org?.ranks || []).map((r: any) => ({ value: r.id, label: `${r.abbr} · ${r.name}` }))]} /></Field><Field label="MOS"><Input value={profile.mos} onChange={(e) => setProfile({ ...profile, mos: e.target.value })} /></Field><Field label="EAS"><Input type="date" value={profile.eas} onChange={(e) => setProfile({ ...profile, eas: e.target.value })} /></Field><Field label="Middle initial"><Input value={profile.middle_initial} onChange={(e) => setProfile({ ...profile, middle_initial: e.target.value })} maxLength={4} /></Field></div>}
      </Dialog>
    </div>
  );
}
