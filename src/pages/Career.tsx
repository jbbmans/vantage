import { useEffect, useMemo, useState } from 'react';
import { Plus, GraduationCap, Award as AwardIcon, MessageSquare, CheckCircle2, Paperclip } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, Tabs, EmptyState, Badge, NumberInput, Stat } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import VisibilityPicker from '@/components/VisibilityPicker';
import { AiAction, AiResult } from '@/components/AiPanel';
import { DateText, StatusBadge, useParam, onText, Table, DescriptionList } from '@/components/common';
import { useAwards, useCounselings, useDeleteRecord, useIdentity, usePrefs, useTrainings, invalidateRecords } from '@/lib/queries';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '@/lib/api';
import { TRAINING_TYPES, TRAINING_STATUS, AWARD_TYPES, AWARD_STATUS, AWARD_NAMES, COUNSELING_TYPES } from '../../shared/constants';
import { formatNumber } from '../../shared/metrics';
import { humanize, todayIso, fullName } from '@/lib/utils';

interface TrainingDraft { id?: string; version?: number; title: string; date: string; type: string; hours: number | string; provider: string; status: string; notes: string; visibility: 'private' | 'unit'; unit_id: string | null }
interface AwardDraft { id?: string; version?: number; name: string; date: string; type: string; status: string; recommending_official: string; approving_authority: string; citation: string; notes: string; submitted_at: string; approved_at: string; presented_at: string; visibility: 'private' | 'unit'; unit_id: string | null }
interface CounselingDraft { id?: string; version?: number; summary: string; date: string; type: string; counselor_name: string; strengths: string; improvements: string; goals_set: string; follow_up_date: string; visibility: 'private' | 'unit'; unit_id: string | null }

export const emptyTraining = (v: 'private' | 'unit', unit: string | null): TrainingDraft => ({ title: '', date: todayIso(), type: 'course', hours: '', provider: '', status: 'completed', notes: '', visibility: v, unit_id: unit });
export const emptyAward = (v: 'private' | 'unit', unit: string | null): AwardDraft => ({ name: '', date: todayIso(), type: 'personal_award', status: 'planned', recommending_official: '', approving_authority: '', citation: '', notes: '', submitted_at: '', approved_at: '', presented_at: '', visibility: v, unit_id: unit });
export const emptyCounseling = (v: 'private' | 'unit', unit: string | null): CounselingDraft => ({ summary: '', date: todayIso(), type: 'monthly', counselor_name: '', strengths: '', improvements: '', goals_set: '', follow_up_date: '', visibility: v, unit_id: unit });

export function TrainingFields({ d, set, errors }: { d: TrainingDraft; set: (k: any, v: unknown) => void; errors: Record<string, string> }) {
  return (
    <>
      <Field label="Title" required error={errors.title}><Input autoFocus value={d.title} onChange={onText(set, 'title')} placeholder="Sergeants Course (distance)" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" error={errors.date}><Input type="date" value={d.date} onChange={onText(set, 'date')} /></Field>
        <Field label="Type"><Select value={d.type} onValueChange={(v) => set('type', v)} options={TRAINING_TYPES.map((t) => ({ value: t, label: t === 'pme' ? 'PME' : humanize(t) }))} /></Field>
        <Field label="Hours" error={errors.hours}><NumberInput value={d.hours} onChange={onText(set, 'hours')} /></Field>
        <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={TRAINING_STATUS.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
        <Field label="Provider" className="col-span-2"><Input value={d.provider} onChange={onText(set, 'provider')} placeholder="MarineNet, CDET, college…" /></Field>
      </div>
      <Field label="Notes"><Textarea rows={2} value={d.notes} onChange={onText(set, 'notes')} /></Field>
      <VisibilityPicker value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
    </>
  );
}

export function AwardFields({ d, set, errors, ai }: { d: AwardDraft; set: (k: any, v: unknown) => void; errors: Record<string, string>; ai?: React.ReactNode }) {
  return (
    <>
      <Field label="Award" required error={errors.name}><><Input autoFocus list="award-names" value={d.name} onChange={onText(set, 'name')} /><datalist id="award-names">{AWARD_NAMES.map((n) => <option key={n} value={n} />)}</datalist></></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type"><Select value={d.type} onValueChange={(v) => set('type', v)} options={AWARD_TYPES.map((t) => ({ value: t, label: t === 'loa' ? 'Letter of Appreciation' : humanize(t) }))} /></Field>
        <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={AWARD_STATUS.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
        <Field label="Period end / award date" error={errors.date}><Input type="date" value={d.date} onChange={onText(set, 'date')} /></Field>
        <Field label="Recommending official"><Input value={d.recommending_official} onChange={onText(set, 'recommending_official')} /></Field>
        <Field label="Submitted"><Input type="date" value={d.submitted_at} onChange={onText(set, 'submitted_at')} /></Field>
        <Field label="Approving authority"><Input value={d.approving_authority} onChange={onText(set, 'approving_authority')} /></Field>
        <Field label="Approved"><Input type="date" value={d.approved_at} onChange={onText(set, 'approved_at')} /></Field>
        <Field label="Presented"><Input type="date" value={d.presented_at} onChange={onText(set, 'presented_at')} /></Field>
      </div>
      <div><div className="mb-1.5 flex items-center justify-between"><span className="text-xs font-semibold text-ink-2">Citation</span>{ai}</div><Textarea rows={5} value={d.citation} onChange={onText(set, 'citation')} placeholder="For professional achievement in the superior performance of…" /></div>
      <Field label="Notes" hint="tracking numbers, routing, who has it"><Textarea rows={2} value={d.notes} onChange={onText(set, 'notes')} /></Field>
      <VisibilityPicker value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
    </>
  );
}

export function CounselingFields({ d, set, errors, leader }: { d: CounselingDraft; set: (k: any, v: unknown) => void; errors: Record<string, string>; leader?: boolean }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date" error={errors.date}><Input type="date" value={d.date} onChange={onText(set, 'date')} /></Field>
        <Field label="Type"><Select value={d.type} onValueChange={(v) => set('type', v)} options={COUNSELING_TYPES.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
        {!leader && <Field label="Counselor" className="col-span-2"><Input value={d.counselor_name} onChange={onText(set, 'counselor_name')} placeholder="SSgt Rivera" /></Field>}
      </div>
      <Field label="Summary" required error={errors.summary}><Textarea autoFocus rows={3} value={d.summary} onChange={onText(set, 'summary')} placeholder="What was discussed and decided." /></Field>
      <Field label="Strengths"><Textarea rows={2} value={d.strengths} onChange={onText(set, 'strengths')} /></Field>
      <Field label="Areas to improve"><Textarea rows={2} value={d.improvements} onChange={onText(set, 'improvements')} /></Field>
      <Field label="Goals set"><Textarea rows={2} value={d.goals_set} onChange={onText(set, 'goals_set')} /></Field>
      <Field label="Follow-up"><Input type="date" value={d.follow_up_date} onChange={onText(set, 'follow_up_date')} /></Field>
      {!leader && <VisibilityPicker value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />}
    </>
  );
}

export default function Career() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const [tab, setTab] = useParam('tab', 'training');
  const [openId, setOpenId] = useParam('open');
  const { data: trainings } = useTrainings();
  const { data: awards } = useAwards();
  const { data: counselings } = useCounselings();
  const delTraining = useDeleteRecord('trainings'); const delAward = useDeleteRecord('awards'); const delCounseling = useDeleteRecord('counselings');
  const [training, setTraining] = useState<TrainingDraft | null>(null);
  const [award, setAward] = useState<AwardDraft | null>(null);
  const [counseling, setCounseling] = useState<CounselingDraft | null>(null);
  const [view, setView] = useState<any>(null);
  const [confirm, setConfirm] = useState<{ store: 'trainings' | 'awards' | 'counselings'; row: any } | null>(null);
  const [citationOut, setCitationOut] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const me = identity?.user.id;
  const vis = prefs.defaultVisibility || 'private';
  const unit = identity?.primaryUnitId || null;
  useEffect(() => { if (openId && counselings) { const c = counselings.find((x: any) => x.id === openId); if (c) { setView({ kind: 'counseling', row: c }); setTab('counseling'); } } }, [openId, counselings, setTab]);

  const hours = useMemo(() => (trainings || []).reduce((n: number, t: any) => n + (Number(t.hours) || 0), 0), [trainings]);
  const canEditRow = (r: any) => r.user_id === me ? !r.frozen_at : Boolean(r.unit_id && identity && ((identity.permissions[r.unit_id] || 0) & ((1 << 12) | (1 << 3))));
  const acknowledge = async (c: any) => { try { await api.acknowledgeCounseling(c.id); invalidateRecords(qc, 'counselings'); toast.success('Acknowledged.'); setView(null); } catch (e) { toast.error(api.errorText(e)); } };

  return (
    <div className="page">
      <PageHeader eyebrow="Career" title="Training, awards, and counseling" lede="The parts of the record that are not day-to-day work but decide how the year is scored.">
        {tab === 'training' && <Button variant="primary" onClick={() => setTraining(emptyTraining(vis, unit))}><Plus className="h-4 w-4" />Log training</Button>}
        {tab === 'awards' && <Button variant="primary" onClick={() => setAward(emptyAward(vis, unit))}><Plus className="h-4 w-4" />Track an award</Button>}
        {tab === 'counseling' && <Button variant="primary" onClick={() => setCounseling(emptyCounseling(vis, unit))}><Plus className="h-4 w-4" />Record counseling</Button>}
      </PageHeader>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Training hours" value={formatNumber(hours)} hint={`${(trainings || []).length} entries`} />
        <Stat label="Awards in progress" value={(awards || []).filter((a: any) => ['recommended', 'submitted', 'approved'].includes(a.status)).length} hint={`${(awards || []).filter((a: any) => a.status === 'presented').length} presented`} />
        <Stat label="Counselings" value={(counselings || []).length} hint={(counselings || []).some((c: any) => c.user_id === me && !c.acknowledged_at && c.counselor_id && c.counselor_id !== me) ? 'one awaits your acknowledgement' : 'up to date'} tone={(counselings || []).some((c: any) => c.user_id === me && !c.acknowledged_at && c.counselor_id && c.counselor_id !== me) ? 'warn' : undefined} />
      </div>
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: 'training', label: 'Training', count: (trainings || []).length }, { value: 'awards', label: 'Awards', count: (awards || []).length }, { value: 'counseling', label: 'Counseling', count: (counselings || []).length }]} />

      {tab === 'training' && ((trainings || []).length === 0 ? <div className="card"><EmptyState icon={GraduationCap} title="No training logged" description="PME, MarineNet courses, certifications, college. Hours here feed training-hour goals and the evaluation package." action={<Button variant="primary" onClick={() => setTraining(emptyTraining(vis, unit))}>Log training</Button>} /></div> : (
        <div className="card" style={{ overflow: 'hidden' }}><Table head={<><th className="w-24">Date</th><th>Training</th><th className="w-28">Type</th><th className="w-20 text-right">Hours</th><th className="w-28">Status</th><th className="w-28"></th></>}>
          {(trainings || []).map((t: any) => <tr key={t.id}><td className="text-xs"><DateText value={t.date} /></td><td><span className="font-medium text-ink">{t.title}</span>{t.provider && <span className="block text-xs text-ink-3">{t.provider}</span>}</td><td className="text-xs">{t.type === 'pme' ? 'PME' : humanize(t.type)}</td><td className="fig text-right text-xs">{t.hours ?? ''}</td><td><StatusBadge value={t.status} /></td><td className="text-right">{canEditRow(t) && <><Button size="xs" variant="ghost" onClick={() => setTraining({ ...t, hours: t.hours ?? '', provider: t.provider || '', notes: t.notes || '', date: t.date || '' })}>Edit</Button><Button size="xs" variant="ghost" onClick={() => setConfirm({ store: 'trainings', row: t })}>Delete</Button></>}</td></tr>)}
        </Table></div>
      ))}

      {tab === 'awards' && ((awards || []).length === 0 ? <div className="card"><EmptyState icon={AwardIcon} title="No awards tracked" description="Track a recommendation from the day it is drafted to the day it is pinned. Citations draft from your logged activities." action={<Button variant="primary" onClick={() => setAward(emptyAward(vis, unit))}>Track an award</Button>} /></div> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(awards || []).map((a: any) => (
            <article key={a.id} className="card card-hover p-4">
              <div className="flex items-start justify-between gap-2"><div><h3 className="text-base font-semibold text-ink">{a.name}</h3><p className="text-xs text-ink-3">{a.type === 'loa' ? 'Letter of Appreciation' : humanize(a.type)} · <DateText value={a.date} /></p></div><StatusBadge value={a.status} /></div>
              <ol className="mt-3 flex items-center gap-1 text-2xs uppercase tracking-wider text-ink-3">{['recommended', 'submitted', 'approved', 'presented'].map((s, i) => { const idx = AWARD_STATUS.indexOf(a.status); const reached = idx >= AWARD_STATUS.indexOf(s as never); return <li key={s} className="flex items-center gap-1"><span className={reached ? 'text-good' : ''}>{reached ? <CheckCircle2 className="inline h-3 w-3" /> : '○'} {humanize(s)}</span>{i < 3 && <span className="mx-1">›</span>}</li>; })}</ol>
              {a.citation && <p className="mt-3 line-clamp-3 text-sm text-ink-2">{a.citation}</p>}
              <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-xs text-ink-3"><span>{a.recommending_official ? `Rec: ${a.recommending_official}` : ''}{a.user_id !== me ? ' · shared record' : ''}</span><span className="flex gap-1"><Button size="xs" variant="ghost" onClick={() => setView({ kind: 'award', row: a })}>View</Button>{canEditRow(a) && <><Button size="xs" variant="ghost" onClick={() => { setCitationOut(null); setAward({ ...a, date: a.date || '', recommending_official: a.recommending_official || '', approving_authority: a.approving_authority || '', citation: a.citation || '', notes: a.notes || '', submitted_at: a.submitted_at || '', approved_at: a.approved_at || '', presented_at: a.presented_at || '' }); }}>Edit</Button><Button size="xs" variant="ghost" onClick={() => setConfirm({ store: 'awards', row: a })}>Delete</Button></>}</span></div>
            </article>
          ))}
        </div>
      ))}

      {tab === 'counseling' && ((counselings || []).length === 0 ? <div className="card"><EmptyState icon={MessageSquare} title="No counselings recorded" description="Record what your leadership told you, or what you told your Marines. Counselings recorded by a leader ask for your acknowledgement." action={<Button variant="primary" onClick={() => setCounseling(emptyCounseling(vis, unit))}>Record counseling</Button>} /></div> : (
        <div className="card" style={{ overflow: 'hidden' }}><Table head={<><th className="w-24">Date</th><th>Counseling</th><th className="w-28">Type</th><th className="w-32">Follow-up</th><th className="w-32">Status</th><th className="w-28"></th></>}>
          {(counselings || []).map((c: any) => { const leaderRecorded = c.counselor_id && c.counselor_id !== c.user_id; const needsAck = c.user_id === me && leaderRecorded && !c.acknowledged_at; return (
            <tr key={c.id}><td className="text-xs"><DateText value={c.date} /></td><td><button type="button" className="text-left font-medium text-ink hover:underline" onClick={() => setView({ kind: 'counseling', row: c })}>{c.summary.length > 90 ? `${c.summary.slice(0, 90)}…` : c.summary}</button><span className="block text-xs text-ink-3">{c.counselor_name ? `by ${c.counselor_name}` : ''}{c.user_id !== me && c.subject_name ? ` · for ${c.subject_name}` : ''}</span></td><td className="text-xs">{humanize(c.type)}</td><td className="text-xs"><DateText value={c.follow_up_date} fallback="" /></td><td>{needsAck ? <Badge tone="warn">Acknowledge</Badge> : c.acknowledged_at ? <Badge tone="good">Acknowledged</Badge> : leaderRecorded ? <Badge>Pending</Badge> : <Badge>Self-recorded</Badge>}</td><td className="text-right">{needsAck && <Button size="xs" variant="soft" onClick={() => acknowledge(c)}>Acknowledge</Button>}{canEditRow(c) && !leaderRecorded && <><Button size="xs" variant="ghost" onClick={() => setCounseling({ ...c, date: c.date || '', counselor_name: c.counselor_name || '', strengths: c.strengths || '', improvements: c.improvements || '', goals_set: c.goals_set || '', follow_up_date: c.follow_up_date || '' })}>Edit</Button><Button size="xs" variant="ghost" onClick={() => setConfirm({ store: 'counselings', row: c })}>Delete</Button></>}</td></tr>
          ); })}
        </Table></div>
      ))}

      <RecordDialog<TrainingDraft> store="trainings" open={Boolean(training)} onOpenChange={(o) => { if (!o) setTraining(null); }} initial={training} title={training?.id ? 'Edit training' : 'Log training'} noun="Training" validate={(d) => (!d.title.trim() ? 'A title is required.' : null)} fields={(d, set, errors) => <TrainingFields d={d} set={set} errors={errors} />} />
      <RecordDialog<AwardDraft> store="awards" open={Boolean(award)} onOpenChange={(o) => { if (!o) { setAward(null); setCitationOut(null); } }} initial={award} title={award?.id ? 'Edit award' : 'Track an award'} noun="Award" size="lg" validate={(d) => (!d.name.trim() ? 'The award name is required.' : null)}
        fields={(d, set, errors) => (
          <>
            <AwardFields d={d} set={set} errors={errors} ai={<AiAction workflow="award_citation" input={{ award: d.name, facts: `${d.citation}\n${d.notes}`.trim(), to: d.date || undefined }} label="Draft citation" onResult={(output, meta) => { setCitationOut({ output, meta }); if (output.citation && !d.citation) set('citation', String(output.citation)); }} />} />
            {citationOut && <AiResult output={citationOut.output} meta={citationOut.meta} primaryKey="citation" />}
          </>
        )} />
      <RecordDialog<CounselingDraft> store="counselings" open={Boolean(counseling)} onOpenChange={(o) => { if (!o) setCounseling(null); }} initial={counseling} title={counseling?.id ? 'Edit counseling' : 'Record counseling'} noun="Counseling" size="lg" validate={(d) => (!d.summary.trim() ? 'A summary is required.' : null)} fields={(d, set, errors) => <CounselingFields d={d} set={set} errors={errors} />} />

      <Dialog open={Boolean(view)} onOpenChange={(o) => { if (!o) { setView(null); setOpenId(''); } }} title={view?.kind === 'award' ? view.row.name : `${humanize(view?.row?.type || '')} counseling`} description={view?.row?.date ? new Date(`${view.row.date}T00:00:00`).toLocaleDateString() : undefined}
        footer={view?.kind === 'counseling' && view.row.user_id === me && view.row.counselor_id && view.row.counselor_id !== me && !view.row.acknowledged_at ? <><span className="mr-auto text-xs text-ink-3">Acknowledging confirms you read it, not that you agree.</span><Button variant="primary" onClick={() => acknowledge(view.row)}><CheckCircle2 className="h-4 w-4" />Acknowledge</Button></> : undefined}>
        {view?.kind === 'award' && <DescriptionList items={[['Status', <StatusBadge value={view.row.status} />], ['Type', humanize(view.row.type)], ['Recommending official', view.row.recommending_official], ['Approving authority', view.row.approving_authority], ['Submitted', <DateText value={view.row.submitted_at} fallback="" />], ['Approved', <DateText value={view.row.approved_at} fallback="" />], ['Presented', <DateText value={view.row.presented_at} fallback="" />], ['Citation', view.row.citation ? <span className="whitespace-pre-wrap">{view.row.citation}</span> : null], ['Notes', view.row.notes]]} />}
        {view?.kind === 'counseling' && <div className="space-y-3"><DescriptionList items={[['Counselor', view.row.counselor_name || (view.row.counselor_id === me ? 'You' : null)], ['Subject', view.row.subject_name ? fullName(view.row) || view.row.subject_name : null], ['Follow-up', <DateText value={view.row.follow_up_date} fallback="" />], ['Acknowledged', view.row.acknowledged_at ? new Date(view.row.acknowledged_at).toLocaleString() : null]]} />{[['Summary', view.row.summary], ['Strengths', view.row.strengths], ['Areas to improve', view.row.improvements], ['Goals set', view.row.goals_set]].filter(([, v]) => v).map(([k, v]) => <section key={k}><h4 className="eyebrow mb-1">{k}</h4><p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{v}</p></section>)}<p className="flex items-center gap-1 text-2xs text-ink-3"><Paperclip className="h-3 w-3" />Attachments for counselings are managed by the leader who recorded it.</p></div>}
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this record?" body="It moves to the recycle bin for 30 days." onConfirm={async () => { const m = confirm!.store === 'trainings' ? delTraining : confirm!.store === 'awards' ? delAward : delCounseling; try { await m.mutateAsync(confirm!.row.id); toast.success('Deleted.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}
