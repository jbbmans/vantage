import { useState } from 'react';
import { Check, ChevronDown, ChevronUp, CircleAlert, GraduationCap, ShieldCheck } from 'lucide-react';
import { Badge, Button, PageHeader, Panel, Skeleton } from '@/components/ui/primitives';
import { useIdentity, useSavePrefs } from '@/lib/queries';
import {
  FMRA_RESPONSIBILITIES,
  FMRA_STEP_ASSIGNMENTS,
  FMRA_SYSTEMS,
  fmraResponsibilityLabel,
  profileHasResponsibility,
  profileStatus,
  type FMRAProfileEntry,
  type FMRAResponsibilityStatus,
} from '../../shared/fmra';

const STATUS: Array<{ key: FMRAResponsibilityStatus; label: string; tone: 'good' | 'accent' | 'neutral' }> = [
  { key: 'assigned', label: 'Assigned', tone: 'good' },
  { key: 'training', label: 'Training', tone: 'accent' },
  { key: 'not_assigned', label: 'Not assigned', tone: 'neutral' },
];

const UMT_STEPS = [
  ['identify', 'Identify the item'],
  ['research_award', 'Research award and invoices'],
  ['record_funding', 'Record funding'],
  ['calculate', 'Calculate the gap'],
  ['funding_decision', 'Make the funding decision'],
  ['amend_requisition', 'Amend requisition'],
  ['amendment_effective', 'Verify amendment effective'],
  ['award_modification', 'Create award modification'],
  ['funds_check', 'Perform funds check'],
  ['submit_modification', 'Submit modification'],
  ['modification_posted', 'Verify modification posted'],
  ['verify_invoice', 'Verify invoice'],
  ['verify_cleared', 'Verify UMT cleared'],
  ['resolve', 'Resolve the case'],
] as const;

function statusTone(status: FMRAResponsibilityStatus): 'good' | 'accent' | 'neutral' {
  return STATUS.find((s) => s.key === status)?.tone || 'neutral';
}

function statusLabel(status: FMRAResponsibilityStatus): string {
  return STATUS.find((s) => s.key === status)?.label || 'Not assigned';
}

export default function Responsibilities() {
  const { data: identity, isPending } = useIdentity();
  const save = useSavePrefs();
  const [system, setSystem] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isPending || !identity) return <div className="page max-w-6xl"><Skeleton className="h-12 w-72" /><Skeleton className="mt-4 h-64" /></div>;

  const entries = identity.prefs.fmraResponsibilities || [];
  const visible = FMRA_RESPONSIBILITIES.filter((r) => system === 'all' || r.system === system);
  const assignedCount = entries.filter((e) => e.status === 'assigned').length;
  const trainingCount = entries.filter((e) => e.status === 'training').length;

  const setStatus = (key: string, nextStatus: FMRAResponsibilityStatus) => {
    const next: FMRAProfileEntry[] = entries.filter((e) => e.key !== key);
    if (nextStatus !== 'not_assigned') next.push({ key, status: nextStatus, verified: false });
    save.mutate({ fmraResponsibilities: next });
  };

  return (
    <div className="page max-w-6xl space-y-4">
      <PageHeader
        eyebrow="FMRA / DAI"
        title="Responsibilities"
        lede="Keep your system responsibilities separate from your Vantage rank or application role. This profile routes work and shows where unit verification is still needed."
        action={<Badge tone={assignedCount ? 'good' : 'neutral'}>{assignedCount} assigned · {trainingCount} training</Badge>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="How routing works" className="lg:col-span-2">
          <div className="space-y-2 text-sm text-ink-2">
            <p>Each FMRA procedure step names who may perform it, who must approve it, and who should verify the result.</p>
            <p>Marking yourself assigned is a routing signal, not proof of access. A leader or administrator should verify the responsibility against your local DAI role, delegation, and SOP.</p>
            <div className="flex flex-wrap gap-2 pt-1"><Badge tone="good"><Check className="h-3 w-3" /> Assigned</Badge><Badge tone="accent"><GraduationCap className="h-3 w-3" /> Training</Badge><Badge tone="neutral"><CircleAlert className="h-3 w-3" /> Verification required</Badge></div>
          </div>
        </Panel>
        <Panel title="Financial lifecycle">
          <div className="flex flex-wrap gap-1.5">{['Authority', 'Commitment', 'Obligation', 'Delivered', 'Paid', 'Reconciliation'].map((phase) => <Badge key={phase} tone="neutral">{phase}</Badge>)}</div>
          <p className="mt-3 text-xs text-ink-3">The profile describes who may act at a step. The case record still needs the source evidence, decision, action, wait, and verification events.</p>
        </Panel>
      </div>

      <Panel title="UMT 2-Way routing" subtitle="The current walkthrough procedure is labelled SME walkthrough, not an approved SOP.">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead><tr className="border-b border-line text-xs uppercase tracking-wide text-ink-3"><th className="py-2 pr-4">Step</th><th className="py-2 pr-4">Perform</th><th className="py-2 pr-4">Approve</th><th className="py-2">Verify</th></tr></thead>
            <tbody>{UMT_STEPS.map(([stepKey, title]) => {
              const route = FMRA_STEP_ASSIGNMENTS.umt_2way_po_qty[stepKey] || {};
              const names = (keys?: string[]) => (keys || []).map((key) => <Badge key={key} tone={profileHasResponsibility(entries, key) ? 'good' : 'neutral'}>{fmraResponsibilityLabel(key)}</Badge>);
              return <tr key={stepKey} className="border-b border-line last:border-0"><td className="py-2 pr-4 font-medium text-ink">{title}</td><td className="py-2 pr-4"><div className="flex flex-wrap gap-1">{names(route.perform)}</div></td><td className="py-2 pr-4"><div className="flex flex-wrap gap-1">{names(route.approve)}</div></td><td className="py-2"><div className="flex flex-wrap gap-1">{names(route.verify)}</div></td></tr>;
            })}</tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Your DAI and system responsibilities"
        subtitle="Select the status that reflects your current assignment. Unit verification can be added in the next admin layer."
        action={<div className="flex flex-wrap gap-1">{[['all', 'All'], ...FMRA_SYSTEMS.map((s) => [s.key, s.name])].map(([key, label]) => <Button key={key} size="xs" variant={system === key ? 'primary' : 'ghost'} onClick={() => setSystem(key)}>{label}</Button>)}</div>}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visible.map((r) => {
            const current = profileStatus(entries, r.key);
            const open = expanded === r.key;
            return <div key={r.key} className="rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-start justify-between gap-3">
                <div><div className="text-xs uppercase tracking-wide text-ink-3">{FMRA_SYSTEMS.find((s) => s.key === r.system)?.name || r.system}</div><h3 className="mt-1 font-semibold text-ink">{r.name}</h3><p className="mt-1 text-sm text-ink-2">{r.summary}</p></div>
                <Badge tone={statusTone(current)}>{statusLabel(current)}</Badge>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {STATUS.map((s) => <Button key={s.key} size="xs" variant={current === s.key ? 'primary' : 'ghost'} onClick={() => setStatus(r.key, s.key)}>{s.label}</Button>)}
                <Button size="xs" variant="ghost" onClick={() => setExpanded(open ? null : r.key)}>{open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} Details</Button>
              </div>
              {open && <div className="mt-3 grid grid-cols-1 gap-3 border-t border-line pt-3 text-xs sm:grid-cols-3">
                <div><p className="font-semibold uppercase tracking-wide text-ink-3">Can do</p><ul className="mt-1 list-disc space-y-1 pl-4 text-ink-2">{r.can.map((x) => <li key={x}>{x}</li>)}</ul></div>
                <div><p className="font-semibold uppercase tracking-wide text-ink-3">Must not</p><ul className="mt-1 list-disc space-y-1 pl-4 text-ink-2">{r.mustNot.map((x) => <li key={x}>{x}</li>)}</ul></div>
                <div><p className="font-semibold uppercase tracking-wide text-ink-3">Evidence</p><ul className="mt-1 list-disc space-y-1 pl-4 text-ink-2">{r.evidence.map((x) => <li key={x}>{x}</li>)}</ul></div>
              </div>}
              {current === 'assigned' && <p className="mt-2 flex items-center gap-1 text-2xs text-ink-3"><ShieldCheck className="h-3 w-3" /> Self-reported until verified by the unit.</p>}
            </div>;
          })}
        </div>
      </Panel>
    </div>
  );
}
