import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleDashed, ExternalLink, Lock, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText } from '@/components/common';
import { useCareer, caseKeys } from '@/lib/queries';
import * as api from '@/lib/api';
import { CAREER_CATEGORIES, CAREER_CATEGORY_LABEL, CAREER_STATUSES } from '../../shared/record';
import { humanize } from '@/lib/utils';

/**
 * Where a Marine stands and what they are doing next, in their own words.
 *
 * Vantage does not compute eligibility, promotion odds, or certification requirements. A step can
 * name where its guidance came from and when somebody last checked it; one that was never checked
 * says so, rather than looking authoritative.
 */
interface StepDraft { id?: string; version?: number; title: string; category: string; status: string; due_date: string; notes: string; source_label: string; source_url: string; source_checked_on: string }
const emptyStep = (): StepDraft => ({ title: '', category: 'pme', status: 'planned', due_date: '', notes: '', source_label: '', source_url: '', source_checked_on: '' });

export default function CareerPlan() {
  const toast = useToast();
  const qc = useQueryClient();
  const career = useCareer();
  const [editing, setEditing] = useState<StepDraft | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: caseKeys.career });

  if (career.isPending) return <div className="grid gap-4 lg:grid-cols-3"><Skeleton className="h-48" /><Skeleton className="h-48 lg:col-span-2" /></div>;
  const data = career.data;
  const p = data.profile;
  const open = data.steps.filter((s: any) => s.status === 'planned' || s.status === 'in_progress');
  const done = data.steps.filter((s: any) => s.status === 'done');

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4">
        <Panel title="Where you stand" subtitle="From your profile and readiness entries">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-3 text-sm">
            <div><dt className="text-xs text-ink-3">Rank</dt><dd className="text-ink">{p.rank_name || 'Not set'}</dd></div>
            <div><dt className="text-xs text-ink-3">MOS</dt><dd className="fig text-ink">{p.mos || 'Not set'}</dd></div>
            <div><dt className="text-xs text-ink-3">Billet</dt><dd className="text-ink">{p.billet || 'Not set'}</dd></div>
            <div><dt className="text-xs text-ink-3">Unit</dt><dd className="text-ink">{p.unit_name || 'Not set'}</dd></div>
            <div><dt className="text-xs text-ink-3">PME</dt><dd className="text-ink">{data.readiness?.pme_complete ? humanize(data.readiness.pme_complete) : 'Not entered'}</dd></div>
            <div><dt className="text-xs text-ink-3">Training completed</dt><dd className="fig text-ink">{data.training.n} ({Number(data.training.hours)} h)</dd></div>
          </dl>
        </Panel>
        <Panel title="What you are working toward" action={<Button size="xs" variant="ghost" onClick={() => setPlanOpen(true)}><Pencil className="h-3.5 w-3.5" />Edit</Button>}>
          <div className="space-y-3 text-sm">
            <div><p className="text-xs text-ink-3">Military</p><p className="text-ink">{data.plan?.military_goal || <span className="text-ink-3">Not written yet.</span>}</p></div>
            <div><p className="text-xs text-ink-3">Civilian interests</p><p className="text-ink">{data.plan?.civilian_interests || <span className="text-ink-3">Not written yet.</span>}</p></div>
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-3"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Your plan is yours. Leaders cannot open it.</p>
        </Panel>
      </div>

      <div className="space-y-4 lg:col-span-2">
        <Panel title="Next steps" subtitle="Concrete things you plan to do, with where the guidance came from" padded={false}
          action={<Button size="sm" variant="primary" onClick={() => setEditing(emptyStep())}><Plus className="h-4 w-4" />Add a step</Button>}>
          {open.length === 0 ? <EmptyState title="No next steps yet" description="Add the next course, certification, or conversation you want to have. Name the source so you can check it later." /> : (
            <ul className="divide-y divide-line">{open.map((s: any) => <StepRow key={s.id} step={s} onEdit={() => setEditing({ ...s, due_date: s.due_date || '', notes: s.notes || '', source_label: s.source_label || '', source_url: s.source_url || '', source_checked_on: s.source_checked_on || '' })} onDelete={() => setConfirm(s.id)} onDone={async () => {
              try { await api.updateCareerStep(s.id, { ...s, status: 'done', version: s.version }); refresh(); toast.success('Marked done.'); } catch (e) { toast.error(api.errorText(e)); }
            }} />)}</ul>
          )}
        </Panel>
        {done.length > 0 && (
          <Panel title="Done" padded={false}>
            <ul className="divide-y divide-line">{done.map((s: any) => <StepRow key={s.id} step={s} onEdit={() => setEditing({ ...s, due_date: s.due_date || '', notes: s.notes || '', source_label: s.source_label || '', source_url: s.source_url || '', source_checked_on: s.source_checked_on || '' })} onDelete={() => setConfirm(s.id)} />)}</ul>
          </Panel>
        )}
        <p className="flex items-start gap-2 px-1 text-xs text-ink-3"><ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Vantage does not decide eligibility, promotion, or certification requirements. Check the current order, MARADMIN, or issuing body before you rely on a step.</p>
      </div>

      {editing && <StepDialog draft={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {planOpen && <PlanDialog initial={data.plan} onClose={() => setPlanOpen(false)} onSaved={() => { setPlanOpen(false); refresh(); }} />}
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Remove this step?" body="It leaves your plan." confirmLabel="Remove" onConfirm={async () => {
        try { await api.deleteCareerStep(confirm!); refresh(); } catch (e) { toast.error(api.errorText(e)); }
      }} />
    </div>
  );
}

function StepRow({ step, onEdit, onDelete, onDone }: { step: any; onEdit: () => void; onDelete: () => void; onDone?: () => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      {step.status === 'done' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{step.title}</span>
          <Badge>{CAREER_CATEGORY_LABEL[step.category as keyof typeof CAREER_CATEGORY_LABEL] || step.category}</Badge>
          {step.status === 'in_progress' && <Badge tone="accent">In progress</Badge>}
        </p>
        {step.notes && <p className="mt-0.5 text-sm text-ink-2">{step.notes}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
          {step.due_date && <span>By <DateText value={step.due_date} /></span>}
          {step.source_label && (
            <span className="flex items-center gap-1">
              Source: {step.source_url ? <a href={step.source_url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 text-accent hover:underline">{step.source_label}<ExternalLink className="h-3 w-3" aria-hidden /></a> : step.source_label}
            </span>
          )}
          {step.source_label && (step.source_checked_on
            ? <span>checked <DateText value={step.source_checked_on} /></span>
            : <Badge tone="warn">Not verified</Badge>)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {onDone && <Button size="xs" variant="ghost" onClick={onDone}>Done</Button>}
        <Button size="icon-xs" variant="ghost" onClick={onEdit} aria-label={`Edit ${step.title}`}><Pencil className="h-3.5 w-3.5" /></Button>
        <Button size="icon-xs" variant="ghost" onClick={onDelete} aria-label={`Remove ${step.title}`}><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>
    </li>
  );
}

function StepDialog({ draft, onClose, onSaved }: { draft: StepDraft; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof StepDraft, v: string) => setD((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      if (d.id) await api.updateCareerStep(d.id, d as unknown as Record<string, unknown>);
      else await api.createCareerStep(d as unknown as Record<string, unknown>);
      toast.success('Saved.');
      onSaved();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={d.id ? 'Edit step' : 'Add a next step'} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!d.title.trim()} onClick={save}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Step" required><Input autoFocus value={d.title} onChange={(e) => set('title', e.target.value)} placeholder="Finish Corporals Course DEP" /></Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Kind"><Select value={d.category} onValueChange={(v) => set('category', v)} options={CAREER_CATEGORIES.map((c) => ({ value: c, label: CAREER_CATEGORY_LABEL[c] }))} /></Field>
          <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={CAREER_STATUSES.map((c) => ({ value: c, label: humanize(c) }))} /></Field>
          <Field label="By"><Input type="date" value={d.due_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
        </div>
        <Field label="Notes"><Textarea rows={2} value={d.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        <fieldset className="rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-medium text-ink-2">Where the guidance came from</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Source"><Input value={d.source_label} onChange={(e) => set('source_label', e.target.value)} placeholder="MARADMIN, order, issuing body" /></Field>
            <Field label="Link"><Input value={d.source_url} onChange={(e) => set('source_url', e.target.value)} placeholder="https://" inputMode="url" /></Field>
            <Field label="Last checked" hint="Leave empty if nobody has checked it"><Input type="date" value={d.source_checked_on} onChange={(e) => set('source_checked_on', e.target.value)} /></Field>
          </div>
        </fieldset>
      </div>
    </Dialog>
  );
}

function PlanDialog({ initial, onClose, onSaved }: { initial: { military_goal: string | null; civilian_interests: string | null } | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [military, setMilitary] = useState(initial?.military_goal || '');
  const [civilian, setCivilian] = useState(initial?.civilian_interests || '');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="What you are working toward" size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => {
        setBusy(true);
        try { await api.saveCareerProfile({ military_goal: military, civilian_interests: civilian }); toast.success('Saved.'); onSaved(); }
        catch (e) { toast.error(api.errorText(e)); }
        finally { setBusy(false); }
      }}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Military goal"><Textarea rows={2} value={military} onChange={(e) => setMilitary(e.target.value)} placeholder="Pick up Corporal and qualify as a lead analyst" /></Field>
        <Field label="Civilian interests"><Textarea rows={2} value={civilian} onChange={(e) => setCivilian(e.target.value)} placeholder="Federal financial management" /></Field>
      </div>
    </Dialog>
  );
}
