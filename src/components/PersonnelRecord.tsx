import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Lock, PenLine, Plus, Trash2, UserRound, History, ListChecks } from 'lucide-react';
import { Button, Field, Input, Select, Panel, EmptyState, Badge, RoleBadge, type Tone } from '@/components/ui/primitives';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText, DescriptionList } from '@/components/common';
import * as api from '@/lib/api';
import type { DraftRef } from '@/lib/api';
import { invalidateDomains, keys } from '@/lib/queries';
import { DraftStrip, LeaveDialog, LostDraft, ResumedNote, lostFrom, useResumeDraft, type Lost } from '@/components/FormDrafts';
import { formatStamp, fullName } from '@/lib/utils';
import { formatDate } from '../../shared/metrics';
import type { AssignmentDraftPayload, FormDraft } from '../../shared/drafts';
import type { AccountStatus, MembershipPeriod, PersonnelAssignment, PersonnelEvent, PersonnelInstance, PersonnelPersonRef, PersonnelRecordResponse } from '../../shared/types';

/** Plain words for why a membership period began or ended (server/services/membership.ts). */
const PERIOD_REASONS: Record<'start' | 'end', Record<string, string>> = {
  start: { enrolled: 'Added by a leader', invitation: 'Accepted an invitation', join_code: 'Joined with a code', roster: 'Seated from the personnel roster', roster_restored: 'Restored by the personnel roster', transfer: 'Moved in', account_import: 'Imported with accounts', unit_created: 'Founded the unit', leader_assigned: 'Named its leader', manager_assigned: 'Named Lead Unit Manager by Vantage', demo: 'Demo', billet_changed: 'Billet changed', primary_changed: 'Primary unit changed', recorded: 'Joined before history was kept' },
  end: { removed: 'Removed', removed_from_instance: 'Removed from the command', roster_separation: 'Separated on the personnel roster', transfer: 'Moved out', left: 'Left', billet_changed: 'Billet changed', primary_changed: 'Primary unit changed', superseded: 'Replaced' },
};
const periodReason = (reason: string | null, edge: 'start' | 'end') => (reason && PERIOD_REASONS[edge][reason]) || (edge === 'start' ? 'Joined' : 'Ended');

export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'good' },
  locked: { label: 'Locked', tone: 'warn' },
  never_signed_in: { label: 'Never signed in', tone: 'neutral' },
  must_change_password: { label: 'Must change password', tone: 'info' },
  deactivated: { label: 'Deactivated', tone: 'bad' },
};

const FIELD_LABELS: Record<string, string> = {
  rank: 'Rank', mos: 'MOS', eas: 'EAS', account: 'Account', supervisor: 'Supervisor', checked_in: 'Check-in', assignment_start: 'Assignment start', assignment_end: 'Assignment end',
};
const DATE_FIELDS = new Set(['eas', 'checked_in', 'assignment_start', 'assignment_end']);
const SOURCES: Record<string, string> = { self: 'by themselves', leader: 'by a leader', feed: 'from the personnel feed', support: 'by Vantage support', departure: 'on leaving the command' };
/** What a change saved, in the words a toast uses, in the order the dialog asks. */
const CHANGE_WORDS: Record<string, string> = { billet: 'billet', billet_id: 'billet', primary: 'primary unit', assignment_start: 'assignment start', assignment_end: 'assignment end', supervisor: 'supervisor', checked_in: 'check-in' };

const shortName = (p: { rank_abbr?: string | null; last_name: string }) => `${p.rank_abbr || ''} ${p.last_name}`.trim();
const unitName = (a: Pick<PersonnelAssignment, 'unit_short' | 'unit_name'>) => a.unit_short || a.unit_name;

/** "Billet and supervisor saved for LCpl Okafor." from what the server says it changed. */
export function savedSentence(changed: string[], name: string): string {
  const words = [...new Set(changed.map((c) => CHANGE_WORDS[c]).filter(Boolean))];
  if (!words.length) return 'Nothing changed.';
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} saved for ${name}.`;
}

function eventSentence(e: PersonnelEvent): string {
  const field = FIELD_LABELS[e.field] || e.field;
  const shown = (label: string | null) => (label == null ? null : DATE_FIELDS.has(e.field) ? formatDate(label) : label);
  const from = shown(e.from_label); const to = shown(e.to_label);
  if (e.field === 'account') return e.to_value === 'active' ? 'Account reactivated' : 'Account deactivated';
  if (to == null) return `${field} cleared${from ? ` (was ${from})` : ''}`;
  if (from == null) return `${field} set to ${to}`;
  return `${field} changed from ${from} to ${to}`;
}

/** A Marine named by a search of the Unit Instance, for a supervisor. Only another active member the reader can see. */
export function SupervisorPicker({ unitId, exceptId, value, onChange, label = 'Supervisor', error }: { unitId: string; exceptId?: string; value: PersonnelPersonRef | null; onChange: (p: PersonnelPersonRef | null) => void; label?: string; error?: string | null }) {
  const [q, setQ] = useState('');
  const listId = useId();
  const term = q.trim();
  const { data, isFetching } = useQuery({ queryKey: ['supervisor-candidates', unitId, term, exceptId], queryFn: () => api.supervisorCandidates(unitId, term, exceptId), enabled: !value && term.length >= 2, staleTime: 30_000 });
  const results = value || term.length < 2 ? [] : data?.results ?? [];
  return (
    <div>
      <Field label={label} error={error} hint={value ? undefined : 'Type two letters of their name.'}>
        <Input value={value ? fullName(value) : q} readOnly={Boolean(value)} onChange={(e) => setQ(e.target.value)} placeholder={value ? undefined : 'Name'} aria-controls={results.length ? listId : undefined} />
      </Field>
      {value ? <Button size="xs" variant="ghost" className="mt-1" onClick={() => { onChange(null); setQ(''); }}>Clear the supervisor</Button>
        : term.length >= 2 && (
          <ul id={listId} aria-label={`Marines matching ${term}`} className="mt-1 max-h-48 overflow-auto rounded-md border border-line">
            {results.map((p) => <li key={p.id}><button type="button" className="w-full px-3 py-1.5 text-left text-sm text-ink hover:bg-surface-2 focus-visible:bg-surface-2" onClick={() => { onChange(p); setQ(''); }}>{fullName(p)}</button></li>)}
            {!results.length && <li className="px-3 py-1.5 text-xs text-ink-3">{isFetching ? 'Searching…' : 'Nobody in this command by that name.'}</li>}
          </ul>
        )}
    </div>
  );
}

/** Whose assignment, in which unit, and what it says now. */
export interface AssignmentTarget {
  userId: string;
  name: string;
  assignment: PersonnelAssignment;
  unitLabel: string;
  supervisor: PersonnelPersonRef | null;
  checked_in_on: string | null;
  billets: PersonnelInstance['billets'];
  /** The draft of a change to it this form opens from (ADR-0030). */
  saved?: FormDraft | null;
  /** After a draft of it is saved, sent or discarded. */
  onDraft?: () => void;
}

/**
 * One Marine's assignment in one unit: the billet (from the unit's list, or a title typed in), the dates, their supervisor
 * and the day they checked in. Only what changed is sent, so the history names only that.
 */
export function AssignmentDialog({ target, onClose, onSaved }: { target: AssignmentTarget | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const listId = useId();
  const [billet, setBillet] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [start, setStart] = useState(''); const [end, setEnd] = useState('');
  const [supervisor, setSupervisor] = useState<PersonnelPersonRef | null>(null);
  const [checkedIn, setCheckedIn] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'draft' | null>(null);
  // A change saved as a draft (ADR-0030): the draft it was opened from, as last read, beside the form and never in it.
  const savedRef = useRef<DraftRef | null>(null);
  const [lost, setLost] = useState<Lost | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [inPlace, setInPlace] = useState(false);
  const [baseline, setBaseline] = useState('');
  const fill = (t: AssignmentTarget, changes: AssignmentDraftPayload['changes'] = {}, supervisorLabel?: string | null) => {
    const a = t.assignment;
    const has = (f: string) => Object.prototype.hasOwnProperty.call(changes, f);
    const listedBillet = has('billet_id') ? t.billets.find((b) => b.id === changes.billet_id) : undefined;
    const b = listedBillet ? listedBillet.title : has('billet') ? String(changes.billet ?? '') : a.billet || '';
    const s = has('assignment_start') ? String(changes.assignment_start ?? '') : a.assignment_start || '';
    const e = has('assignment_end') ? String(changes.assignment_end ?? '') : a.assignment_end || '';
    const sup = has('supervisor_id') ? (changes.supervisor_id ? { id: String(changes.supervisor_id), first_name: '', last_name: supervisorLabel || 'The supervisor you chose', rank_abbr: null } : null) : t.supervisor;
    const c = has('checked_in_on') ? String(changes.checked_in_on ?? '') : t.checked_in_on || '';
    const r = has('reason') ? String(changes.reason ?? '') : '';
    setBillet(b); setPicked(listedBillet?.id ?? null); setStart(s); setEnd(e); setSupervisor(sup); setCheckedIn(c); setReason(r);
    setBaseline(JSON.stringify([b, listedBillet?.id ?? null, s, e, sup?.id ?? null, c, r]));
  };
  // Built once each time it is opened, from the assignment as it was then and the draft's changes, if it came from one:
  // the page reading the record again never puts back what was typed.
  useEffect(() => {
    if (!target) return;
    const saved = target.saved;
    const p = saved?.payload as unknown as AssignmentDraftPayload | undefined;
    fill(target, p?.changes, p?.supervisor_label);
    savedRef.current = saved ? { id: saved.id, version: saved.version } : null;
    setErrors({}); setLost(null); setLeaving(false); setInPlace(false);
  }, [target]);
  const options = useMemo(() => (target?.billets || []).filter((b) => !b.unit_id || b.unit_id === target?.assignment.unit_id), [target]);
  // A title that is on the unit's list fills that billet; anything else is kept as typed, off the list. The command's list
  // and the unit's own can share a title, so then the billet is chosen by name and where it belongs, starting from the
  // one the Marine holds, and a save that changes only a date never swaps one for the other.
  const matches = options.filter((b) => b.title.trim().toLowerCase() === billet.trim().toLowerCase());
  const listed = matches.find((b) => b.id === (picked ?? target?.assignment.billet_id)) ?? matches[0];
  const resumed = Boolean(target?.saved);
  // A draft its author may no longer send is theirs to read and discard.
  const blocked = Boolean(target?.saved?.blocked);
  const dirty = JSON.stringify([billet, picked, start, end, supervisor?.id ?? null, checkedIn, reason]) !== baseline;
  /** What this form changes, against the assignment as the page read it when the form opened. */
  const changes = (): Record<string, unknown> => {
    if (!target) return {};
    const a = target.assignment;
    const payload: Record<string, unknown> = {};
    const text = billet.trim();
    if (listed) { if (listed.id !== a.billet_id) payload.billet_id = listed.id; } else if (text !== (a.billet || '')) payload.billet = text || null;
    if ((start || null) !== a.assignment_start) payload.assignment_start = start || null;
    if ((end || null) !== a.assignment_end) payload.assignment_end = end || null;
    if ((supervisor?.id ?? null) !== (target.supervisor?.id ?? null)) payload.supervisor_id = supervisor?.id ?? null;
    if ((checkedIn || null) !== target.checked_in_on) payload.checked_in_on = checkedIn || null;
    return payload;
  };
  // Drafts, the menu count and the record overview count it (ADR-0030).
  const draftsChanged = (id?: string) => { invalidateDomains(qc, 'draft'); if (id) qc.removeQueries({ queryKey: keys.formDraft(id) }); target?.onDraft?.(); };
  const close = () => { setLeaving(false); onClose(); };
  const askToClose = () => { if (busy) return; if (dirty) setLeaving(true); else close(); };
  const saveDraft = async () => {
    if (!target) return;
    const payload = changes();
    if (!Object.keys(payload).length) { toast.info('Change something before saving it as a draft.'); setLeaving(false); return; }
    if (reason.trim()) payload.reason = reason.trim();
    const body = { changes: payload, ...(payload.supervisor_id && supervisor ? { supervisor_label: fullName(supervisor) } : {}) };
    setBusy('draft');
    try {
      const ref = savedRef.current;
      const saved = ref
        ? await api.updateFormDraft(ref.id, { payload: body, version: ref.version })
        : await api.createFormDraft({ kind: 'personnel_change', subject_id: target.userId, unit_id: target.assignment.unit_id, payload: body });
      savedRef.current = { id: saved.id, version: saved.version };
      // Opened again, it is this version, not the one read before.
      qc.setQueryData(keys.formDraft(saved.id), saved);
      draftsChanged();
      toast.success('Saved to Drafts. Only you can see it, and nothing changes until you save it.');
      close();
    } catch (e) {
      const l = savedRef.current ? lostFrom(e) : null;
      // From the leave check too: it closes, so the form says what happened.
      if (l) { setLost(l); setLeaving(false); }
      else { if (e instanceof api.ApiError && e.fieldErrors) setErrors(e.fieldErrors); toast.error(api.errorText(e)); }
    } finally { setBusy(null); }
  };
  const discardDraft = async () => {
    const ref = savedRef.current;
    if (!ref) return;
    try { await api.discardFormDraft(ref.id); toast.success('Draft discarded.'); }
    catch (e) { if (lostFrom(e)?.why !== 'gone') { toast.error(api.errorText(e)); return; } toast.info('That draft was already sent or discarded.'); }
    savedRef.current = null;
    draftsChanged(ref.id);
    close();
  };
  const save = async (withDraft = true) => {
    if (!target) return;
    const a = target.assignment;
    const payload = changes();
    if (!Object.keys(payload).length) {
      // A drafted change someone else already made: say so, and offer to let the draft go.
      if (withDraft && savedRef.current) { setInPlace(true); return; }
      toast.info('Nothing changed.'); close(); return;
    }
    if (reason.trim()) payload.reason = reason.trim();
    const ref = withDraft ? savedRef.current : null;
    setBusy('save'); setErrors({});
    try {
      const r = await api.updateMembership(a.unit_id, target.userId, payload, ref);
      toast.success(savedSentence(r.changed, target.name));
      if (ref) { savedRef.current = null; draftsChanged(ref.id); }
      onSaved(); close();
    } catch (e) {
      const l = ref ? lostFrom(e) : null;
      if (l) setLost(l);
      else {
        if (e instanceof api.ApiError && e.fieldErrors) setErrors(e.fieldErrors);
        toast.error(api.errorText(e));
      }
    } finally { setBusy(null); }
  };
  // What moved since the draft was saved: each field the draft changes whose value then is not its value now.
  const drift = useMemo(() => {
    const was = (target?.saved?.payload as unknown as AssignmentDraftPayload | undefined)?.was;
    if (!target || !was) return [];
    const a = target.assignment;
    const now: Record<string, unknown> = { billet: a.billet, billet_id: a.billet_id, assignment_start: a.assignment_start, assignment_end: a.assignment_end, supervisor_id: target.supervisor?.id ?? null, checked_in_on: target.checked_in_on, primary: Boolean(a.is_primary) };
    return [...new Set(Object.entries(was).filter(([f, v]) => f in now && (v ?? null) !== (now[f] ?? null)).map(([f]) => DRIFT_WORDS[f]).filter(Boolean))];
  }, [target]);
  return (
    <>
    <Dialog open={Boolean(target)} onOpenChange={(o) => { if (!o) askToClose(); }} size="md"
      title={target ? `${target.name}’s billet and assignment` : ''}
      description={target ? `In ${target.unitLabel}. Leave a field empty to clear it. Their history keeps what it said before.` : ''}
      footer={<>
        <span className="mr-auto basis-full text-xs text-ink-3 sm:basis-auto">Save draft keeps it to you and changes nothing. Save changes their assignment now, and their history records it.</span>
        {resumed && <Button variant="ghost" onClick={() => setDiscarding(true)} disabled={Boolean(busy)}><Trash2 className="h-4 w-4" />Discard draft</Button>}
        <Button variant="ghost" onClick={askToClose} disabled={Boolean(busy)}>Cancel</Button>
        <Button onClick={saveDraft} loading={busy === 'draft'} disabled={blocked || busy === 'save'}><Lock className="h-3.5 w-3.5" aria-hidden />Save draft</Button>
        <Button variant="primary" onClick={() => save()} loading={busy === 'save'} disabled={blocked || busy === 'draft'}>Save</Button>
      </>}>
      {resumed && !lost && <ResumedNote blocked={target?.saved?.blocked} />}
      {resumed && drift.length > 0 && !lost && <p role="note" className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/[.06] px-3 py-2 text-xs text-ink-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden /><span>Since you saved this draft, someone changed their {listWords(drift)}. The form shows your draft; check it against their record before you save.</span></p>}
      {inPlace && <div role="alert" className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-2"><p>This change is already in place: their record says what your draft says.</p><div className="mt-2 flex gap-2"><Button size="sm" onClick={discardDraft}>Discard the draft</Button><Button size="sm" variant="ghost" onClick={() => setInPlace(false)}>Keep it</Button></div></div>}
      {lost && <LostDraft lost={lost} busy={Boolean(busy)} addLabel="Save the change now" onAddNew={() => { savedRef.current = null; setLost(null); save(false); }} onSaveNew={() => { savedRef.current = null; setLost(null); saveDraft(); }}
        onLoadNewer={(d) => { const p = d.payload as unknown as AssignmentDraftPayload; if (target) fill(target, p.changes, p.supervisor_label); savedRef.current = { id: d.id, version: d.version }; setLost(null); }}
        onKeepMine={(d) => { if (d && savedRef.current) savedRef.current = { id: d.id, version: d.version }; setLost(null); toast.info('Kept what you have here. Saving replaces the copy saved elsewhere.'); }} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Billet" className="sm:col-span-2" error={errors.billet_id || errors.billet} hint={options.length ? 'Choose one from the unit’s billet list, or type a title that is not on it.' : 'This unit lists no billets yet; type a title.'}>
          <Input autoFocus maxLength={80} list={options.length ? listId : undefined} value={billet} onChange={(e) => setBillet(e.target.value)} placeholder="Budget analyst" />
        </Field>
        {options.length > 0 && <datalist id={listId}>{options.map((b) => <option key={b.id} value={b.title}>{b.code || undefined}</option>)}</datalist>}
        {matches.length > 1 && listed && (
          <Field label="Which billet" className="sm:col-span-2" hint="Two billets on the list have this title">
            <Select aria-label="Which billet" value={listed.id} onValueChange={setPicked}
              options={matches.map((b) => ({ value: b.id, label: `${b.title}${b.code ? ` (${b.code})` : ''} · ${b.unit_id ? `only ${target?.unitLabel}` : 'every unit'}` }))} />
          </Field>
        )}
        <Field label="Assignment start" error={errors.assignment_start}><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Assignment end" error={errors.assignment_end} hint="When the assignment is due to end"><Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        <div className="sm:col-span-2"><SupervisorPicker unitId={target?.assignment.unit_id || ''} exceptId={target?.userId} value={supervisor} onChange={setSupervisor} error={errors.supervisor_id} /></div>
        <Field label="Checked in" error={errors.checked_in_on} hint="The day they reported to this command"><Input type="date" value={checkedIn} onChange={(e) => setCheckedIn(e.target.value)} /></Field>
        <Field label="Why (optional)" error={errors.reason} hint="Kept with the change in their history"><Input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="PCS orders" /></Field>
      </div>
    </Dialog>
    <LeaveDialog open={leaving} resumed={resumed} noun="change" saving={busy === 'draft'} canSave={!blocked} onStay={() => setLeaving(false)} onSave={saveDraft} onLeave={close} />
    <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title="Discard this draft?" confirmLabel="Discard"
      body="It is removed and cannot be brought back. Nothing was changed on their record, so nobody is affected." onConfirm={discardDraft} />
    </>
  );
}

const DRIFT_WORDS: Record<string, string> = { billet: 'billet', billet_id: 'billet', assignment_start: 'assignment start', assignment_end: 'assignment end', supervisor_id: 'supervisor', checked_in_on: 'check-in date', primary: 'primary unit' };
const listWords = (w: string[]) => (w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`);

/** A functional responsibility carried beside the billet: Safety NCO, Voting Assistance Officer. It grants nothing. */
export function ResponsibilityDialog({ target, onClose, onSaved }: { target: { userId: string; name: string; unitId: string; unitLabel: string } | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(''); const [start, setStart] = useState(''); const [end, setEnd] = useState(''); const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(''); setStart(''); setEnd(''); setReason(''); setErrors({}); }, [target]);
  const save = async () => {
    if (!target) return;
    if (!title.trim()) { setErrors({ title: 'Name the responsibility.' }); return; }
    setBusy(true); setErrors({});
    try {
      await api.addResponsibility(target.unitId, target.userId, { title: title.trim(), starts_on: start || null, ends_on: end || null, reason: reason.trim() || null });
      toast.success(`${title.trim()} added for ${target.name}.`);
      onSaved(); onClose();
    } catch (e) {
      if (e instanceof api.ApiError && e.fieldErrors) setErrors(e.fieldErrors);
      toast.error(api.errorText(e));
    } finally { setBusy(false); }
  };
  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => { if (!o) onClose(); }} size="sm"
      title={target ? `New responsibility for ${target.name}` : ''}
      description={target ? `In ${target.unitLabel}. A duty they carry beside their billet. It gives no access in Vantage.` : ''}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} loading={busy}>Add</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Responsibility" className="col-span-2" error={errors.title} required><Input autoFocus maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Safety NCO" /></Field>
        <Field label="From" error={errors.starts_on}><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Until" error={errors.ends_on}><Input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Why (optional)" className="col-span-2" error={errors.reason}><Input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Appointed by the commander’s letter" /></Field>
      </div>
    </Dialog>
  );
}

type HistoryItem = { at: string; key: string; period?: MembershipPeriod; event?: PersonnelEvent };

/**
 * The Personnel tab of a Marine's page (ADR-0017): where they serve, in what billet, under whom, since when and until
 * when, what they are responsible for, their roles and account, links to their records, and what changed. Each part
 * shows only what the server sent, which is what the reader may see.
 */
export function PersonnelPanel({ record, onTab, onChanged }: { record: PersonnelRecordResponse; onTab?: (tab: string) => void; onChanged: () => void }) {
  const toast = useToast();
  const { person } = record;
  const name = shortName(person);
  const [editing, setEditing] = useState<AssignmentTarget | null>(null);
  const [adding, setAdding] = useState<{ userId: string; name: string; unitId: string; unitLabel: string } | null>(null);
  const [ending, setEnding] = useState<{ id: string; title: string } | null>(null);
  const editTarget = (inst: PersonnelInstance, a: PersonnelAssignment): AssignmentTarget => ({ userId: person.id, name, assignment: a, unitLabel: unitName(a), supervisor: inst.supervisor, checked_in_on: inst.checked_in_on, billets: inst.billets });
  // A change to their assignment saved as a draft (ADR-0030) opens here from ?draft=, over the assignment as it is now.
  const resume = useResumeDraft('personnel_change', (d, done) => {
    for (const inst of record.instances) {
      const a = inst.assignments.find((x) => x.unit_id === d.unit_id && x.canManage);
      if (a) { setEditing({ ...editTarget(inst, a), saved: d, onDraft: done }); return; }
    }
    toast.info('You can no longer change that assignment. The draft is in Drafts, where you can read it and discard it.');
    done();
  }, { subjectId: person.id, quiet: true, enabled: !record.self });
  const end = async () => {
    if (!ending) return;
    try { await api.endResponsibility(ending.id); toast.success(`${ending.title} ended for ${name}.`); onChanged(); } catch (e) { toast.error(api.errorText(e)); }
  };
  const history = useMemo<HistoryItem[]>(() => {
    if (!record.history) return [];
    return [
      ...record.history.periods.map((p) => ({ at: p.started_at, key: `p${p.id}`, period: p })),
      ...record.history.events.map((e) => ({ at: e.at, key: `e${e.id}`, event: e })),
    ].sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  }, [record.history]);
  const sourced = new Set(record.sourced);
  const fromFeed = (field: string) => (sourced.has(field) ? <span className="ml-1 text-2xs text-ink-3">from the personnel feed</span> : null);
  const counts = record.records;
  const links: Array<[string, number, string, string?]> = counts ? [
    ['Training', counts.trainings, 'career'], ['Education', counts.education, 'career'], ['Awards', counts.awards, 'career'], ['Counseling', counts.counselings, 'counseling'],
    ['Duty', counts.duty, 'duty'], ['Activities', counts.activities, 'activities'], ['Goals', counts.goals, 'overview'], ['Open tasks', counts.tasks, 'overview'],
  ] : [];
  // A name opens that Marine's page for a reader who sees Marines on a roster; the Marine reading their own record
  // may not, so for them it is a name.
  const personLink = (p: PersonnelPersonRef) => (record.self ? <span>{fullName(p)}</span> : <Link to={`/team/${p.id}`} className="hover:underline">{fullName(p)}</Link>);
  const who = (e: PersonnelEvent) => (e.actor ? `by ${record.self && e.actor.id === person.id ? 'you' : fullName(e.actor)}` : e.source ? (record.self && e.source === 'self' ? 'by you' : SOURCES[e.source] || '') : '');
  const responsibilities = record.instances.flatMap((i) => i.responsibilities);
  const manageable = record.instances.flatMap((i) => i.assignments.filter((a) => a.canManage));
  const addIn = manageable.find((a) => a.is_primary) || manageable[0];

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        {!record.self && <DraftStrip kind="personnel_change" subjectId={person.id} onContinue={resume.open} className="card overflow-hidden border border-dashed border-line-strong p-0" />}
        {!record.instances.length && <div className="card"><EmptyState icon={UserRound} title="Not assigned to a unit" description={record.self ? 'Ask a leader for an invitation or a join code.' : 'They serve in no unit you can see.'} /></div>}
        {record.instances.map((inst) => (
          <Panel key={inst.org_id} title={record.instances.length > 1 ? `Assignment in ${inst.org_name}` : 'Assignment'} subtitle={inst.team ? `Their team: ${inst.team.label}` : undefined} padded={false}>
            <div className="p-4 pb-3">
              <DescriptionList items={[
                ['Supervisor', inst.supervisor ? personLink(inst.supervisor) : <span className="text-ink-3">None named</span>],
                ['Checked in', <DateText key="c" value={inst.checked_in_on} fallback="Not recorded" />],
                ...(inst.supervises.length ? [['Supervises', inst.supervises.map((p) => shortName(p)).join(', ')] as [string, React.ReactNode]] : []),
              ]} />
            </div>
            <ul aria-label="Assignments">
              {inst.assignments.map((a) => (
                <li key={a.unit_id} className="row flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block text-ink">{unitName(a)}{a.is_primary ? <Badge tone="accent" className="ml-2">Primary</Badge> : <Badge className="ml-2">Secondary</Badge>}</span>
                    <span className="block text-xs text-ink-3">{a.billet || 'No billet'}{a.billet && !a.billet_id ? ' (not on the billet list)' : ''} · {a.assignment_start || a.assignment_end ? `assigned ${a.assignment_start ? formatDate(a.assignment_start) : '?'} – ${a.assignment_end ? formatDate(a.assignment_end) : 'open'}` : `joined ${formatDate(a.joined_at)}`}</span>
                  </span>
                  {a.canManage && <Button size="xs" variant="ghost" onClick={() => setEditing(editTarget(inst, a))} aria-label={`Change ${person.last_name}’s assignment in ${unitName(a)}`}><PenLine className="h-3.5 w-3.5" />Change</Button>}
                </li>
              ))}
            </ul>
          </Panel>
        ))}

        {record.instances.length > 0 && (
          <Panel title="Functional responsibilities" subtitle="Duties beside the billet; none of them grants access" padded={false}
            action={addIn ? <Button size="xs" onClick={() => setAdding({ userId: person.id, name, unitId: addIn.unit_id, unitLabel: unitName(addIn) })}><Plus className="h-3.5 w-3.5" />Add</Button> : undefined}>
            {!responsibilities.length ? <EmptyState icon={ListChecks} title="No responsibilities" className="py-6" /> : <ul>{responsibilities.map((r) => (
              <li key={r.id} className="row flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="block text-ink">{r.title}{r.ended_at && <Badge className="ml-2">Ended</Badge>}</span>
                  <span className="block text-xs text-ink-3">{[r.unit_label, r.starts_on || r.ends_on ? `${r.starts_on ? formatDate(r.starts_on) : '?'} – ${r.ends_on ? formatDate(r.ends_on) : 'open'}` : null, r.ended_at ? `ended ${formatDate(r.ended_at)}${r.end_reason === 'left' ? ' on leaving the command' : ''}` : null, r.assigned_by ? `assigned by ${shortName(r.assigned_by)}` : null].filter(Boolean).join(' · ')}</span>
                </span>
                {r.canEnd && <Button size="xs" variant="ghost" onClick={() => setEnding({ id: r.id, title: r.title })} aria-label={`End ${r.title}`}>End</Button>}
              </li>
            ))}</ul>}
          </Panel>
        )}

        {record.history && (
          <Panel title="History" subtitle={record.self ? 'Every unit you have belonged to and every change to your personnel record' : 'Their units and changes in this command; the same account throughout'} padded={false}>
            {!history.length ? <EmptyState icon={History} title="No history yet" className="py-6" /> : <ol aria-label="History">{history.map((h) => h.period ? (
              <li key={h.key} className="row flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="min-w-0"><span className="block text-ink">{h.period.unit_short || h.period.unit_name}{h.period.billet ? ` · ${h.period.billet}` : ''}{h.period.is_primary ? <Badge tone="accent" className="ml-2">Primary</Badge> : null}</span><span className="block text-xs text-ink-3">{periodReason(h.period.start_reason, 'start')}{h.period.ended_at ? ` · ${periodReason(h.period.end_reason, 'end')}` : ''}</span></span>
                <span className="fig text-xs text-ink-3">{formatDate(h.period.started_at)} – {h.period.ended_at ? formatDate(h.period.ended_at) : 'present'}</span>
              </li>
            ) : h.event ? (
              <li key={h.key} className="row flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span className="min-w-0"><span className="block text-ink">{eventSentence(h.event)}</span><span className="block text-xs text-ink-3">{[who(h.event), h.event.unit_label, h.event.reason ? `“${h.event.reason}”` : null, h.event.batch_id ? 'part of a bulk change' : null].filter(Boolean).join(' · ')}</span></span>
                <span className="fig text-xs text-ink-3">{formatStamp(h.event.at)}</span>
              </li>
            ) : null)}</ol>}
          </Panel>
        )}
      </div>

      <div className="min-w-0 space-y-4">
        <Panel title="Service">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2"><dt className="text-ink-3">Rank</dt><dd className="text-right text-ink">{person.rank_name ? `${person.rank_name}${person.rank_grade ? ` (${person.rank_grade})` : ''}` : <span className="text-ink-3">None</span>}{fromFeed('rank_id')}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-ink-3">MOS</dt><dd className="fig text-right text-ink">{person.mos || <span className="text-ink-3">None</span>}{fromFeed('mos')}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-ink-3">EAS</dt><dd className="text-right text-ink"><DateText value={person.eas} fallback="None" />{fromFeed('eas')}</dd></div>
          </dl>
        </Panel>
        {record.account && (
          <Panel title="Account">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-2"><dt className="text-ink-3">Status</dt><dd><Badge tone={ACCOUNT_STATUS[record.account.status].tone}>{ACCOUNT_STATUS[record.account.status].label}</Badge></dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-3">Last signed in</dt><dd className="text-right text-ink">{record.account.last_login_at ? formatStamp(record.account.last_login_at) : <span className="text-ink-3">Never</span>}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-3">Second factor</dt><dd className="text-ink">{record.account.mfa ? 'On' : 'Off'}</dd></div>
              <div className="flex justify-between gap-2"><dt className="text-ink-3">CAC</dt><dd className="text-ink">{record.account.cac ? 'Proven' : 'Not proven'}</dd></div>
            </dl>
          </Panel>
        )}
        {record.instances.some((i) => i.chain.length) && (
          <Panel title="Leadership chain" subtitle="Their supervisors, then the leaders of their unit and those above it">
            {record.instances.map((inst) => inst.chain.length > 0 && (
              <ol key={inst.org_id} className="space-y-1.5 text-sm" aria-label={`Leadership chain in ${inst.org_name}`}>
                {inst.chain.map((p, i) => <li key={`${p.id}-${i}`} className="flex justify-between gap-2"><span className="truncate text-ink">{personLink(p)}</span><span className="shrink-0 text-xs text-ink-3">{p.relation === 'supervisor' ? (i === 0 ? 'Supervisor' : 'Their supervisor') : `Leads ${p.unit_label || 'a unit'}`}</span></li>)}
              </ol>
            ))}
          </Panel>
        )}
        <Panel title="Roles in Vantage">
          {!record.instances.some((i) => i.roles.length || i.orgRoles.length) ? <p className="text-sm text-ink-3">Only the default Marine role.</p> : (
            <ul className="space-y-1.5 text-sm">
              {record.instances.flatMap((i) => [
                ...i.orgRoles.map((r) => <li key={`${i.org_id}-${r}`} className="flex items-center justify-between gap-2"><Badge tone="info">{r}</Badge><span className="text-xs text-ink-3">{i.org_name}</span></li>),
                ...i.roles.map((r) => <li key={`${r.unit_id}-${r.name}`} className="flex items-center justify-between gap-2"><RoleBadge color={r.color}>{r.name}</RoleBadge><span className="text-xs text-ink-3">{r.unit_label}</span></li>),
              ])}
            </ul>
          )}
        </Panel>
        {counts && (
          <Panel title="Records" subtitle={record.self ? 'Everything you have recorded' : 'What they shared that you may open'} padded={false}>
            <ul>{links.map(([label, n, tab, hint]) => (
              <li key={label}>{onTab ? (
                <button type="button" className="row flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-surface-2" onClick={() => onTab(tab)}>
                  <span><span className="block text-ink">{label}</span>{hint && <span className="block text-2xs text-ink-3">{hint}</span>}</span><span className="fig text-xs text-ink-3">{n}</span>
                </button>
              ) : <span className="row flex items-center justify-between gap-2 px-4 py-2 text-sm"><span className="text-ink">{label}</span><span className="fig text-xs text-ink-3">{n}</span></span>}</li>
            ))}</ul>
          </Panel>
        )}
      </div>

      <AssignmentDialog target={editing} onClose={() => { setEditing(null); resume.done(); }} onSaved={onChanged} />
      <ResponsibilityDialog target={adding} onClose={() => setAdding(null)} onSaved={onChanged} />
      <ConfirmDialog open={Boolean(ending)} onOpenChange={(o) => { if (!o) setEnding(null); }} title={ending ? `End ${ending.title} for ${name}?` : ''} confirmLabel="End it"
        body="It stays in their record as ended today, with your name." onConfirm={end} />
    </div>
  );
}
