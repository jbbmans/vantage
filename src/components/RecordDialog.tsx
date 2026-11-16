import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Lock, Trash2 } from 'lucide-react';
import { captureTimer } from '@/lib/telemetry';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Button, useRefusal } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import * as api from '@/lib/api';
import { errorText, type DraftRef, type Store } from '@/lib/api';
import { invalidateDomains, invalidateRecords, keys, useCreateRecord, useUpdateRecord } from '@/lib/queries';
import { ConflictDialog } from '@/components/ConflictDialog';
import { LeaveDialog, LostDraft, ResumedNote, lostFrom, type Lost } from '@/components/FormDrafts';
import type { FormDraft, RecordDraftKind } from '../../shared/drafts';

type Problem = string | { message: string; fieldErrors: Record<string, string> } | null;

/** A field the form needs filled: said at the field, which takes focus, rather than only in a passing toast. */
export const missing = (field: string, message: string) => ({ message, fieldErrors: { [field]: message } });

/**
 * One way to save the form, as its own button: a counseling saves as a draft, is shared with its Marine, or is finalized
 * (ADR-0027). `patch` goes with the save; `then` runs on what was saved, as the next step. Enter in a field takes the first.
 */
export interface SaveAction<T> { label: string; done: string; variant?: 'primary' | 'default'; patch?: Partial<T>; check?: (draft: T) => Problem; then?: (saved: any) => Promise<any> }

/**
 * A new record of this kind may be saved as a draft to finish later (ADR-0030): only its author can read it, and nothing
 * counts it or tells anyone of it. When it is finished it is sent through the kind's own route, which checks it as any new
 * record and removes the draft in the same step.
 */
export interface DraftOptions<T> {
  kind: RecordDraftKind;
  /** The Marine an award recommendation is about; the draft keeps the unit the form names, or this one. */
  subjectId?: string | null;
  unitId?: string | null;
  /** The saved draft this form was opened from. */
  saved?: FormDraft | null;
  /** The form again from a saved draft's values: to load a newer copy saved in another window. */
  restore: (payload: Record<string, unknown>) => T;
  /** Who is told when it is added now, by name: an award's Marine, a task's assignee. */
  told?: (draft: T) => string | null;
  /** After the draft is saved, sent or discarded: the page lets go of it. */
  onChange?: () => void;
}

/** A form's values as a draft keeps them: everything but the record's own id and version. */
const payloadOf = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k, v]) => k !== 'id' && k !== 'version' && v !== undefined));

export default function RecordDialog<T extends Record<string, any>>({ store, open, onOpenChange, initial, title, noun, fields, size = 'md', validate, onSaved, actions, note, fromCurrent, formDraft }: {
  store: Store; open: boolean; onOpenChange: (o: boolean) => void; initial: T | null; title: string; noun: string; size?: 'sm' | 'md' | 'lg';
  fields: (draft: T, set: (k: keyof T & string, v: unknown) => void, errors: Record<string, string>) => React.ReactNode;
  /** What stops the save, in words, or with the fields it is about (a timeframe out of order marks its end date). */
  validate?: (draft: T) => Problem; onSaved?: (saved: any) => void;
  /** The ways to save, in place of the one Save button. */
  actions?: Array<SaveAction<T>>;
  /** A line beside the buttons: what saving does. */
  note?: React.ReactNode;
  /** The newest copy of the record, after a conflict, as this form edits it (null columns as empty fields). It is given the server's row. */
  fromCurrent?: (current: never) => Partial<T>;
  /** A new record of this kind may be saved as a draft (ADR-0030). */
  formDraft?: DraftOptions<T>;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useCreateRecord(store);
  const update = useUpdateRecord(store);
  const [draft, setDraft] = useState<T | null>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // A refused save is said at the fields it is about, and focus goes to the first; only a refusal no field shows is a toast.
  const form = useRef<HTMLFormElement | null>(null);
  const refuse = useRefusal(form, toast.error);
  const refused = (message: string, fieldErrors: Record<string, string> | null | undefined) => { setErrors(fieldErrors || {}); refuse(message); };
  const [conflict, setConflict] = useState<any>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // The saved draft this form came from, and the version of it last read: kept beside the form, never in it, so a record
  // conflict can never mistake it for the record's own id.
  const savedRef = useRef<DraftRef | null>(null);
  // The unit a draft about a Marine was saved in: it is sent there, or not at all.
  const savedUnit = useRef<string | null>(null);
  const [resumed, setResumed] = useState(false);
  const [lost, setLost] = useState<Lost | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // What the form held when it was opened or last saved as a draft: closing with anything else asks first.
  const [baseline, setBaseline] = useState('');
  // The action a conflict interrupted, so overwriting finishes what was asked.
  const pending = useRef<SaveAction<T> | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    setDraft(initial); setErrors({}); setConflict(null); setLost(null); setLeaving(false);
    setBaseline(JSON.stringify(initial));
    // Seeded once per opening: a page reading its lists again never puts the form back to what was saved.
    const saved = formDraft?.saved;
    savedRef.current = saved ? { id: saved.id, version: saved.version } : null;
    savedUnit.current = saved?.unit_id ?? null;
    setResumed(Boolean(saved));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);
  const capture = useRef<ReturnType<typeof captureTimer> | null>(null);
  useEffect(() => {
    if (open) capture.current = captureTimer('record_form');
    return () => { capture.current?.abandoned('closed_immediately'); capture.current = null; };
  }, [open]);
  if (!draft) return null;
  // Only a new record is drafted: an edit is already in the record.
  const drafting = Boolean(formDraft) && !draft.id;
  const dirty = JSON.stringify(draft) !== baseline;
  const set = (k: keyof T & string, v: unknown) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; }); };
  const draftsChanged = (id?: string) => {
    invalidateDomains(qc, 'draft');
    if (id) qc.removeQueries({ queryKey: keys.formDraft(id) });
  };
  const close = () => { setLeaving(false); onOpenChange(false); };
  const askToClose = (o: boolean) => {
    if (o) return onOpenChange(true);
    if (saving) return;
    if (drafting && dirty) return setLeaving(true);
    close();
  };

  const saveDraft = async () => {
    if (!formDraft) return;
    setSaving('draft');
    try {
      const payload = payloadOf(draft);
      const ref = savedRef.current;
      const saved = ref
        ? await api.updateFormDraft(ref.id, { payload, version: ref.version })
        : await api.createFormDraft({ kind: formDraft.kind, subject_id: formDraft.subjectId ?? null, unit_id: formDraft.subjectId ? (draft.unit_id || formDraft.unitId || null) : null, payload });
      savedRef.current = { id: saved.id, version: saved.version };
      savedUnit.current = saved.unit_id;
      capture.current?.abandoned('saved_draft');
      capture.current = null;
      // Opened again, it is this version, not the one read before (a refetch would come too late to seed the form).
      qc.setQueryData(keys.formDraft(saved.id), saved);
      draftsChanged();
      toast.success('Saved to Drafts. Only you can see it.', { label: 'Open Drafts', onClick: () => navigate('/record/drafts') });
      formDraft.onChange?.();
      close();
    } catch (err) {
      const l = savedRef.current ? lostFrom(err) : null;
      // From the leave check too: it closes, so the form says what happened and what can be done with what was typed.
      if (l) { setLost(l); setLeaving(false); }
      else refused(errorText(err), err instanceof api.ApiError ? err.fieldErrors : null);
    } finally { setSaving(null); }
  };

  const discardDraft = async () => {
    const ref = savedRef.current;
    if (!ref) return;
    try {
      await api.discardFormDraft(ref.id);
      toast.success('Draft discarded.');
    } catch (err) {
      if (lostFrom(err)?.why !== 'gone') { toast.error(errorText(err)); return; }
      toast.info('That draft was already sent or discarded.');
    }
    capture.current?.abandoned('typed_then_left');
    capture.current = null;
    savedRef.current = null;
    draftsChanged(ref.id);
    formDraft?.onChange?.();
    close();
  };

  const save = async (versionOverride?: number, action: SaveAction<T> | undefined = actions?.[0]) => {
    const problem = validate?.(draft) || action?.check?.(draft);
    if (problem) {
      capture.current?.abandoned('validation_blocked', { fields_filled: Object.values(draft).filter(Boolean).length });
      capture.current = captureTimer('record_form');
      if (typeof problem === 'string') refused(problem, null);
      else refused(problem.message, problem.fieldErrors);
      return;
    }
    setSaving(action?.label ?? 'save');
    pending.current = action;
    // A form opened from a saved draft is sent with it, so the draft is removed as the record is made, or neither happens.
    const fromSaved = !draft.id && drafting ? savedRef.current : null;
    try {
      const body: Record<string, unknown> = { ...draft, ...action?.patch };
      // A recommendation is placed in a unit whatever the form says (createRecord); from a draft, in the draft's, which was
      // fixed when it was saved where its author may counsel the Marine.
      if (fromSaved && formDraft?.subjectId && savedUnit.current) body.unit_id = savedUnit.current;
      let saved = draft.id
        ? await update.mutateAsync({ id: draft.id, patch: { ...body, version: versionOverride ?? draft.version } })
        : fromSaved
          ? await api.createRecord(store, body, fromSaved).then((r) => { invalidateRecords(qc, store); return r; })
          : await create.mutateAsync(body);
      if (fromSaved) { savedRef.current = null; draftsChanged(fromSaved.id); formDraft?.onChange?.(); }
      if (action?.then) {
        // What was saved stays saved if the next step is refused: the form carries on from it, at its new version.
        try { saved = await action.then(saved); }
        catch (err: any) { setDraft((d) => (d ? { ...d, id: saved.id, version: saved.version } : d)); refused(errorText(err), err?.fieldErrors); onSaved?.(saved); return; }
      }
      capture.current?.completed({
        had_measure: draft.quantity != null || draft.dollar_amount != null,
        had_outcome: Boolean(draft.result),
        ai_assisted: false,
        source: fromSaved ? 'saved_form' : 'manual',
      });
      capture.current = null;
      toast.success(action?.done ?? `${noun} ${draft.id ? 'updated' : 'added'}.`);
      onSaved?.(saved);
      close();
    } catch (err: any) {
      const l = fromSaved ? lostFrom(err) : null;
      if (l) setLost(l);
      else if (err?.status === 409 && err?.code === 'stale' && err?.extra?.current) setConflict(err.extra.current);
      else {
        capture.current?.abandoned('save_failed');
        capture.current = captureTimer('record_form');
        refused(errorText(err), err?.fieldErrors);
      }
    } finally { setSaving(null); }
  };

  const loadNewer = (current: FormDraft) => {
    const next = formDraft!.restore(current.payload);
    setDraft(next);
    setBaseline(JSON.stringify(next));
    savedRef.current = { id: current.id, version: current.version };
    setLost(null);
  };
  const keepMine = (current: FormDraft | null) => {
    if (current && savedRef.current) savedRef.current = { id: current.id, version: current.version };
    setLost(null);
    toast.info('Kept what you have here. Saving or adding it replaces the copy saved elsewhere.');
  };
  const startOver = () => { savedRef.current = null; savedUnit.current = null; setResumed(false); setLost(null); };

  const busy = saving !== null;
  // A draft its author may no longer send is theirs to read and discard, not to save or add.
  const blocked = drafting && resumed && Boolean(formDraft?.saved?.blocked);
  const told = drafting ? formDraft?.told?.(draft) : null;
  const draftNote = drafting ? `Save draft keeps it to you. Adding it puts it in the record now${told ? `, and ${told} is told` : ''}.` : null;
  const footNote = note || draftNote ? <span className="mr-auto basis-full text-xs text-ink-3 sm:basis-auto">{note}{note && draftNote ? ' ' : ''}{draftNote}</span> : null;
  return (
    <>
      <Dialog open={open} onOpenChange={askToClose} title={title} size={size} footer={<>{footNote}
        {drafting && resumed && <Button variant="ghost" onClick={() => setDiscarding(true)} disabled={busy}><Trash2 className="h-4 w-4" />Discard draft</Button>}
        <Button variant="ghost" onClick={() => askToClose(false)} disabled={busy}>Cancel</Button>
        {drafting && <Button onClick={saveDraft} loading={saving === 'draft'} disabled={blocked || (busy && saving !== 'draft')}><Lock className="h-3.5 w-3.5" aria-hidden />Save draft</Button>}
        {actions ? actions.map((a) => <Button key={a.label} variant={a.variant ?? 'default'} onClick={() => save(undefined, a)} loading={saving === a.label} disabled={busy && saving !== a.label}>{a.label}</Button>)
          : <Button variant="primary" onClick={() => save()} loading={busy && saving !== 'draft'} disabled={blocked || saving === 'draft'}>{draft.id ? 'Save changes' : `Add ${noun.toLowerCase()}`}</Button>}</>}>
        {drafting && resumed && !lost && <ResumedNote blocked={formDraft?.saved?.blocked} />}
        {lost && <LostDraft lost={lost} busy={busy} addLabel={`Add it as a new ${noun.toLowerCase()}`} onAddNew={() => { startOver(); save(); }} onSaveNew={() => { startOver(); saveDraft(); }} onLoadNewer={loadNewer} onKeepMine={keepMine} />}
        <form ref={form} className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>{fields(draft, set, errors)}<button type="submit" className="hidden" aria-hidden /></form>
      </Dialog>
      <ConflictDialog conflict={conflict} onClose={() => setConflict(null)} onOverwrite={() => { const v = conflict.version; setConflict(null); save(v, pending.current); }} onReload={() => { setDraft({ ...draft, ...(fromCurrent ? fromCurrent(conflict as never) : conflict) }); setConflict(null); }} />
      <LeaveDialog open={leaving} resumed={resumed} noun={noun.toLowerCase()} saving={saving === 'draft'} canSave={!blocked} onStay={() => setLeaving(false)} onSave={saveDraft}
        onLeave={() => { capture.current?.abandoned('typed_then_left'); capture.current = null; close(); }} />
      <ConfirmDialog open={discarding} onOpenChange={setDiscarding} title="Discard this draft?" confirmLabel="Discard"
        body="It is removed and cannot be brought back. Nothing was sent, so nobody else is affected." onConfirm={discardDraft} />
    </>
  );
}
