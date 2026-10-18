import { useId, useState } from 'react';
import { Award as AwardIcon, GraduationCap, PenLine } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input, NumberInput, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useMetrics, useMoveRecord, useUndoMove } from '@/lib/queries';
import * as api from '@/lib/api';
import { AWARD_NAMES, AWARD_STATUS, AWARD_TYPES, TRAINING_STATUS, TRAINING_TYPES, categoryNames } from '../../shared/constants';
import { MOVABLE_LABELS, MOVABLE_TABLES, kindText, movedFields, recordKindOf, type MovableTable } from '../../shared/recordKinds';
import { cn, humanize } from '@/lib/utils';

export interface MovedEntry { table: MovableTable; id: string }

/** Where an entry lives once it has moved: an activity has its own page; an award or a course opens on its Career page. */
export const entryHref = (table: MovableTable, id: string) =>
  table === 'activities' ? `/records/${encodeURIComponent(id)}` : `/career/${table === 'awards' ? 'awards' : 'training'}?open=${encodeURIComponent(id)}`;

const KINDS: Record<MovableTable, { label: string; hint: string; icon: typeof AwardIcon }> = {
  activities: { label: 'An activity', hint: 'Work you did. It counts in your reports and bullets.', icon: PenLine },
  awards: { label: 'An award', hint: 'A medal, letter, coin or other recognition you received.', icon: AwardIcon },
  trainings: { label: 'Training', hint: 'A course, PME, certification or school you completed.', icon: GraduationCap },
};

/** The fields the person checks before the move; the rest carry across as movedFields (shared/recordKinds.ts) sets them. */
const KEY_FIELDS: Record<MovableTable, readonly string[]> = {
  awards: ['name', 'type', 'status', 'date'],
  trainings: ['title', 'type', 'hours', 'status', 'date'],
  activities: ['title', 'category', 'date'],
};
const CARRIED: Record<MovableTable, ReadonlyArray<[string, string]>> = {
  awards: [['notes', 'Notes']],
  trainings: [['provider', 'Provider'], ['notes', 'Notes']],
  activities: [['status', 'Status'], ['quantity', 'Quantity'], ['organization', 'Organization'], ['notes', 'Notes']],
};

type Draft = Record<string, string>;
const draftOf = (to: MovableTable, fields: Record<string, unknown>): Draft => Object.fromEntries(KEY_FIELDS[to].map((k) => [k, fields[k] == null ? '' : String(fields[k])]));
const titleOf = (store: MovableTable, row: Record<string, unknown>) => String((store === 'awards' ? row.name : row.title) || '');

interface Props {
  store: MovableTable;
  /** An entry the viewer owns. The server decides whether it may move and says why not. */
  row: { id: string; version?: number } | null;
  /** The record type it most likely belongs in, such as the one a suggestion named. */
  suggested?: MovableTable;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onMoved?: (moved: MovedEntry) => void;
  /** After Undo on the toast puts the entry back where it was. */
  onUndone?: (restored: MovedEntry) => void;
}

/**
 * Moves an entry to the record type it belongs in: an activity that was really an award received or a course completed,
 * and back (ADR-0015). The owner picks the type and checks what the entry becomes; nothing moves until they press Move.
 */
export default function MoveRecordDialog(props: Props) {
  if (!props.row) return null;
  // A fresh form each time it opens, so a closed dialog never carries one entry's draft to the next.
  return <MoveForm key={`${props.row.id}:${props.open}`} {...props} row={props.row} />;
}

function MoveForm({ store, row, suggested, open, onOpenChange, onMoved, onUndone }: Props & { row: NonNullable<Props['row']> }) {
  const uid = useId();
  const toast = useToast();
  const cfg = useMetrics();
  const move = useMoveRecord(store);
  const undo = { activities: useUndoMove('activities'), awards: useUndoMove('awards'), trainings: useUndoMove('trainings') };
  const data = row as Record<string, unknown>;
  const others = MOVABLE_TABLES.filter((t) => t !== store);
  const reading = store === 'activities' ? recordKindOf(kindText(store, data)) : null;
  const read: MovableTable | undefined = reading ? (reading.kind === 'award' ? 'awards' : 'trainings') : undefined;
  const [to, setTo] = useState<MovableTable>(() => [suggested, read].find((t): t is MovableTable => Boolean(t) && t !== store) ?? others[0]);
  const [drafts, setDrafts] = useState<Partial<Record<MovableTable, Draft>>>(() => Object.fromEntries(others.map((t) => [t, draftOf(t, movedFields(store, data, t))])));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const d = drafts[to] ?? draftOf(to, movedFields(store, data, to));
  const set = (k: string, v: string) => {
    setDrafts((all) => ({ ...all, [to]: { ...d, [k]: v } }));
    setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; });
  };
  const text = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value);
  const proposed = movedFields(store, data, to);
  const carried = CARRIED[to].filter(([k]) => proposed[k] != null && proposed[k] !== '');
  const categories = categoryNames(cfg);

  const submit = async () => {
    const nameKey = to === 'awards' ? 'name' : 'title';
    if (!d[nameKey].trim()) { setErrors({ [nameKey]: to === 'awards' ? 'The award name is required.' : 'A title is required.' }); return; }
    const fields: Record<string, unknown> = Object.fromEntries(KEY_FIELDS[to].map((k) => [k, d[k].trim() || null]));
    // An award's presented date follows its status, so a corrected status does not leave a presentation behind.
    if (to === 'awards') fields.presented_at = d.status === 'presented' ? fields.date : null;
    setSaving(true); setProblem(null); setErrors({});
    try {
      const moved = await move.mutateAsync({ id: row.id, to, fields, reason: reason.trim() || null, version: row.version });
      toast.success(`Moved to ${MOVABLE_LABELS[moved.table].place}.`, {
        label: 'Undo',
        onClick: () => undo[moved.table].mutateAsync(moved.id)
          .then((back) => { toast.success(`Move undone. It is back in ${MOVABLE_LABELS[back.table].place}.`); onUndone?.({ table: back.table, id: back.id }); })
          .catch((e) => toast.error(api.errorText(e))),
      });
      onOpenChange(false);
      onMoved?.({ table: moved.table, id: moved.id });
    } catch (e) {
      setErrors((e instanceof api.ApiError && e.fieldErrors) || {});
      setProblem(api.errorText(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Move to another record type" size="md"
      description={<>“{titleOf(store, data)}” is in {MOVABLE_LABELS[store].place}. Awards and training each keep a record of their own; the move keeps this entry’s history, and you can undo it.</>}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={submit} loading={saving}>Move to {MOVABLE_LABELS[to].place}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div>
          <p id={`${uid}-to`} className="mb-1.5 text-xs font-semibold text-ink-2">What it really is</p>
          <div role="radiogroup" aria-labelledby={`${uid}-to`} className="grid gap-2 sm:grid-cols-2">
            {others.map((t) => {
              const Icon = KINDS[t].icon;
              return (
                <button key={t} type="button" role="radio" aria-checked={to === t} onClick={() => { setTo(t); setErrors({}); setProblem(null); }}
                  className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors', to === t ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong')}>
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', to === t ? 'text-accent' : 'text-ink-3')} />
                  <span className="min-w-0"><span className="block text-sm font-medium text-ink">{KINDS[t].label}</span><span className="block text-xs leading-snug text-ink-3">{KINDS[t].hint}</span></span>
                </button>
              );
            })}
          </div>
          {reading && read === to && <p className="mt-1.5 text-xs text-ink-3">{reading.why}</p>}
        </div>

        <div className="space-y-3">
          <p className="eyebrow">What it becomes</p>
          {to === 'awards' && <>
            <Field label="Award" required error={errors.name}><><Input list={`${uid}-award-names`} value={d.name} onChange={text('name')} /><datalist id={`${uid}-award-names`}>{AWARD_NAMES.map((n) => <option key={n} value={n} />)}</datalist></></Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Type" error={errors.type}><Select value={d.type} onValueChange={(v) => set('type', v)} options={AWARD_TYPES.map((t) => ({ value: t, label: t === 'loa' ? 'Letter of Appreciation' : humanize(t) }))} /></Field>
              <Field label="Status" error={errors.status}><Select value={d.status} onValueChange={(v) => set('status', v)} options={AWARD_STATUS.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
              <Field label="Date" error={errors.date}><Input type="date" value={d.date} onChange={text('date')} /></Field>
            </div>
          </>}
          {to === 'trainings' && <>
            <Field label="Title" required error={errors.title}><Input value={d.title} onChange={text('title')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type" error={errors.type}><Select value={d.type} onValueChange={(v) => set('type', v)} options={TRAINING_TYPES.map((t) => ({ value: t, label: t === 'pme' ? 'PME' : humanize(t) }))} /></Field>
              <Field label="Status" error={errors.status}><Select value={d.status} onValueChange={(v) => set('status', v)} options={TRAINING_STATUS.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
              <Field label="Hours" error={errors.hours}><NumberInput value={d.hours} onChange={text('hours')} /></Field>
              <Field label="Date" error={errors.date}><Input type="date" value={d.date} onChange={text('date')} /></Field>
            </div>
          </>}
          {to === 'activities' && <>
            <Field label="Title" required error={errors.title}><Input value={d.title} onChange={text('title')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category" error={errors.category}><Select value={d.category} onValueChange={(v) => set('category', v)} placeholder="Pick a category" options={[...categories, ...(d.category && !categories.includes(d.category) ? [d.category] : [])].map((c) => ({ value: c, label: c }))} /></Field>
              <Field label="Date" error={errors.date}><Input type="date" value={d.date} onChange={text('date')} /></Field>
            </div>
          </>}
          {carried.length > 0 && (
            <dl className="space-y-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs">
              {carried.map(([k, label]) => (
                <div key={k} className="flex gap-2"><dt className="w-24 shrink-0 text-ink-3">{label}</dt><dd className="line-clamp-3 min-w-0 whitespace-pre-wrap text-ink-2">{k === 'status' ? humanize(String(proposed.status)) : k === 'quantity' ? `${proposed.quantity} ${proposed.unit_label || ''}`.trim() : String(proposed[k])}</dd></div>
              ))}
            </dl>
          )}
        </div>

        <Field label="Why you are moving it" hint="optional; only you see this"><Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="It was my NAM, not work I did" /></Field>
        <p className="text-xs leading-relaxed text-ink-3">It keeps who can see it, its files and its comments. Anything that has no place in {MOVABLE_LABELS[to].place} is kept with the move, so Undo puts the entry back exactly as it was.</p>
        {problem && <p role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{problem}</p>}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Dialog>
  );
}
