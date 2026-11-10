import { useEffect, useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input, Select, Textarea, Badge } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { DateText, DescriptionList, onText } from '@/components/common';
import { invalidateDomains, useDutyOptions, useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { TIME_HINT, militaryTime, parseTime } from '../../shared/timeframe';
import {
  CLAIMED_CONDITIONS, CONDITION_HINTS, CONDITION_LABELS, DUTY_STATUS_LABELS, describeScore, dutyConditions, dutyFacts, dutyProblems, formatHours, isDecidedDuty, scoreDuty,
  type ClaimedCondition, type DutyCandidate,
} from '../../shared/duty';
import type { ScoringCondition } from '../../shared/dutyScoring';
import { formatNumber } from '../../shared/metrics';
import type { Duty } from '../../shared/types';
import { formatStamp, todayIso } from '@/lib/utils';

/** How each review status reads on a badge. */
export const DUTY_TONE = { pending: 'info', approved: 'good', returned: 'warn', rejected: 'bad' } as const;

/**
 * Recording a duty (Task 17, ADR-0023): for oneself, for a Marine one counsels in a unit, a correction to one not yet
 * decided, or an activity its owner says was a duty. The form shows what the server will work out (its length, its
 * conditions and its points under the Unit Instance's scoring version of its first day) before anything is sent; the
 * server works it out again and keeps its own answer.
 */
export type DutyMode =
  | { kind: 'new'; forUser?: { id: string; name: string } | null }
  | { kind: 'edit'; row: Duty }
  | { kind: 'move'; activity: DutyCandidate };

interface Draft {
  unit_id: string; duty_type_id: string; title: string; location: string;
  date: string; start_time: string; end_date: string; end_time: string;
  conditions: ClaimedCondition[]; notes: string;
}

const claimed = (list: readonly unknown[] | null | undefined) => (list ?? []).filter((c): c is ClaimedCondition => (CLAIMED_CONDITIONS as readonly unknown[]).includes(c));

function draftOf(mode: DutyMode, today: string): Draft {
  if (mode.kind === 'edit') {
    const r = mode.row;
    return {
      unit_id: r.unit_id || '', duty_type_id: r.duty_type_id, title: r.title || '', location: r.location || '',
      date: r.date, start_time: militaryTime(r.start_time), end_date: r.end_date, end_time: militaryTime(r.end_time),
      conditions: claimed(r.conditions), notes: r.notes || '',
    };
  }
  if (mode.kind === 'move') {
    const a = mode.activity;
    return {
      unit_id: a.unit_id || '', duty_type_id: '', title: a.title.slice(0, 200), location: '',
      date: a.date || today, start_time: militaryTime(a.start_time), end_date: a.end_date || a.date || today, end_time: militaryTime(a.end_time),
      conditions: [], notes: a.notes || '',
    };
  }
  return { unit_id: '', duty_type_id: '', title: '', location: '', date: today, start_time: '', end_date: today, end_time: '', conditions: [], notes: '' };
}

const TITLES: Record<DutyMode['kind'], string> = { new: 'Record duty', edit: 'Change duty', move: 'Record this activity as duty' };

export default function DutyDialog({ mode, open, onOpenChange, onSaved }: { mode: DutyMode | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: (saved: { id: string }) => void }) {
  if (!mode) return null;
  // A fresh form each time it opens, so one duty's draft never carries to the next.
  const key = `${mode.kind}:${mode.kind === 'edit' ? mode.row.id : mode.kind === 'move' ? mode.activity.id : mode.forUser?.id ?? ''}:${open}`;
  return <DutyForm key={key} mode={mode} open={open} onOpenChange={onOpenChange} onSaved={onSaved} />;
}

function DutyForm({ mode, open, onOpenChange, onSaved }: { mode: DutyMode; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: (saved: { id: string }) => void }) {
  const uid = useId();
  const toast = useToast();
  const qc = useQueryClient();
  // Another Marine's duty is recorded with what the reader may record for them; one's own with one's own units.
  const subject = mode.kind === 'new' ? mode.forUser?.id ?? null : mode.kind === 'edit' && mode.row.subject_name ? mode.row.user_id : null;
  const options = useDutyOptions(subject, open);
  const { data: identity } = useIdentity();
  const opts = options.data;
  const today = opts?.today || todayIso();
  const [d, setDraft] = useState<Draft>(() => draftOf(mode, today));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reason, setReason] = useState('');

  // A new duty starts in the first unit the reader may record it in: their home unit, when it is one.
  useEffect(() => {
    if (!opts || d.unit_id || !opts.units[0]) return;
    setDraft((x) => ({ ...x, unit_id: opts.units[0].id }));
  }, [opts, d.unit_id]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setDraft((x) => {
      const next = { ...x, [k]: v };
      // A one-day duty ends on the day it began, until the person says otherwise.
      if (k === 'date' && (!x.end_date || x.end_date === x.date || x.end_date < String(v))) next.end_date = String(v);
      return next;
    });
    setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; });
  };

  const unit = opts?.units.find((u) => u.id === d.unit_id) ?? null;
  // A correction by a records manager who may not record duty for this Marine keeps its unit and type as they are; and
  // only its Marine moves a duty to another unit (the server refuses anyone else), so for others its unit stays put.
  const fixedPlace = mode.kind === 'edit' && !unit;
  const notTheirs = mode.kind === 'edit' && Boolean(identity) && mode.row.user_id !== identity?.user.id;
  const fixedUnit = fixedPlace || notTheirs;
  const types = useMemo(() => (opts?.types ?? []).filter((t) => t.org_id === unit?.org_id), [opts, unit]);
  const keptType = mode.kind === 'edit' && !types.some((t) => t.id === mode.row.duty_type_id)
    ? [{ id: mode.row.duty_type_id, name: `${mode.row.duty_type_name || 'Its duty type'}${mode.row.duty_type_active === false ? ' (retired)' : ''}` }] : [];
  const versions = useMemo(() => (opts?.versions ?? []).filter((v) => v.org_id === unit?.org_id), [opts, unit]);

  const times = { date: d.date, start_time: parseTime(d.start_time), end_date: d.end_date, end_time: parseTime(d.end_time) };
  const facts = dutyFacts(times);
  const conditions = dutyConditions(facts, d.conditions);
  const score = facts && d.duty_type_id && unit ? scoreDuty(versions, { duty_type_id: d.duty_type_id, date: d.date, facts, conditions }) : null;

  const check = (): { message: string; fieldErrors: Record<string, string> } | null => {
    const unreadable = (['start_time', 'end_time'] as const).filter((f) => d[f].trim() && !parseTime(d[f]));
    if (unreadable.length) return { message: TIME_HINT, fieldErrors: Object.fromEntries(unreadable.map((f) => [f, TIME_HINT])) };
    const found = dutyProblems(times, today);
    if (found) return found;
    if (!d.unit_id) return { message: 'Choose the unit this duty was stood for.', fieldErrors: { unit_id: 'Required.' } };
    if (!d.duty_type_id) return { message: 'Choose the duty type.', fieldErrors: { duty_type_id: 'Required.' } };
    return null;
  };

  const save = async () => {
    const found = check();
    if (found) { setErrors(found.fieldErrors); setProblem(found.message); return; }
    const fields = {
      duty_type_id: d.duty_type_id, unit_id: d.unit_id, title: d.title.trim() || null, location: d.location.trim() || null,
      date: d.date, start_time: times.start_time, end_date: d.end_date, end_time: times.end_time, conditions: d.conditions, notes: d.notes.trim() || null,
    };
    setSaving(true); setProblem(null); setErrors({});
    try {
      let saved: { id: string };
      if (mode.kind === 'edit') {
        saved = await api.updateRecord('duties', mode.row.id, { ...fields, version: mode.row.version }) as { id: string };
        toast.success('Duty updated.');
      } else if (mode.kind === 'move') {
        const moved = await api.moveRecord('activities', mode.activity.id, { to: 'duties', fields, reason: reason.trim() || null, version: mode.activity.version });
        saved = { id: moved.id };
        qc.removeQueries({ queryKey: ['record', 'activities', mode.activity.id] });
        qc.invalidateQueries({ queryKey: ['record-lineage'] });
        invalidateDomains(qc, 'activity');
        toast.success('Recorded as duty. You can undo the move from the duty.');
      } else {
        saved = await api.createRecord('duties', { ...fields, visibility: 'unit', ...(mode.forUser ? { user_id: mode.forUser.id } : {}) }) as { id: string };
        toast.success(mode.forUser ? `Duty recorded for ${mode.forUser.name}.` : 'Duty recorded and submitted for review.');
      }
      invalidateDomains(qc, 'duty');
      onOpenChange(false);
      onSaved?.(saved);
    } catch (e) {
      setErrors((e instanceof api.ApiError && e.fieldErrors) || {});
      setProblem(api.errorText(e));
      setSaving(false);
    }
  };

  const ran = facts ? [formatHours(facts.hours), `${facts.days} duty ${facts.days === 1 ? 'day' : 'days'}`, facts.overnight ? 'overnight' : '', facts.multi_day ? 'more than a day' : '', facts.weekend ? 'on a weekend' : ''].filter(Boolean).join(' · ') : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={TITLES[mode.kind]} size="lg"
      description={mode.kind === 'new' && mode.forUser ? <>For {mode.forUser.name}. They are told, and they cannot change it: you or a records manager can.</>
        : mode.kind === 'move' ? <>“{mode.activity.title}” moves from Activities to Duty with its files and comments. Give what an activity does not hold: the duty type and its times.</>
          : 'Duty is recorded once it has been stood, and waits for a reviewer before it counts.'}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={save} loading={saving} disabled={options.isLoading}>{mode.kind === 'edit' ? 'Save changes' : mode.kind === 'move' ? 'Move to Duty' : 'Record duty'}</Button></>}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {options.isError && !fixedPlace && <p role="alert" className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-ink-2">{api.errorText(options.error)}</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fixedUnit ? <Field label="Unit" hint={notTheirs && unit ? 'only its Marine moves it' : undefined}><Input value={unit?.name ?? 'As recorded'} disabled /></Field> : (
            <Field label="Unit" required error={errors.unit_id}>
              <Select aria-label="Unit" value={d.unit_id} onValueChange={(v) => { set('unit_id', v); set('duty_type_id', ''); }} placeholder={opts && !opts.units.length ? 'No unit to record duty in' : 'Choose the unit'} options={(opts?.units ?? []).map((u) => ({ value: u.id, label: u.name }))} />
            </Field>
          )}
          <Field label="Duty type" required error={errors.duty_type_id}>
            <Select aria-label="Duty type" value={d.duty_type_id} onValueChange={(v) => set('duty_type_id', v)} disabled={fixedPlace} placeholder={unit && !types.length ? 'This Unit Instance has no duty types yet' : 'Choose the duty'}
              options={[...keptType.map((t) => ({ value: t.id, label: t.name })), ...types.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))]} />
          </Field>
          <Field label="Title" hint="optional" error={errors.title}><Input value={d.title} maxLength={200} onChange={onText(set, 'title')} placeholder="Barracks duty, building 1221" /></Field>
          <Field label="Location" hint="optional" error={errors.location}><Input value={d.location} maxLength={200} onChange={onText(set, 'location')} placeholder="Post, building or event" /></Field>
          <Field label="Start date" required error={errors.date}><Input type="date" value={d.date} max={today} onChange={onText(set, 'date')} /></Field>
          <Field label="Start time" hint="24-hour" required error={errors.start_time}><Input inputMode="numeric" maxLength={5} placeholder="0800" value={d.start_time} onChange={onText(set, 'start_time')} /></Field>
          <Field label="End date" required error={errors.end_date}><Input type="date" value={d.end_date} min={d.date || undefined} max={today} onChange={onText(set, 'end_date')} /></Field>
          <Field label="End time" hint="24-hour" required error={errors.end_time}><Input inputMode="numeric" maxLength={5} placeholder="0800" value={d.end_time} onChange={onText(set, 'end_time')} /></Field>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-xs font-semibold text-ink-2">Conditions</legend>
          <p className="mb-2 text-xs text-ink-3">Weekend and overnight come from its times. Check the others that applied; a reviewer confirms them.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {CLAIMED_CONDITIONS.map((c) => (
              <label key={c} className="flex items-start gap-2 rounded-md border border-line px-3 py-2 text-sm">
                <input type="checkbox" className="mt-1" checked={d.conditions.includes(c)} onChange={(e) => set('conditions', e.target.checked ? [...d.conditions, c] : d.conditions.filter((x) => x !== c))} />
                <span className="min-w-0"><span className="block font-medium text-ink">{CONDITION_LABELS[c]}</span><span className="block text-xs text-ink-3">{CONDITION_HINTS[c]}</span></span>
              </label>
            ))}
          </div>
        </fieldset>

        <Field label="Notes" hint="optional" error={errors.notes}><Textarea rows={3} value={d.notes} maxLength={4000} onChange={onText(set, 'notes')} placeholder="Turnover, log entries, anything the reviewer should know" /></Field>
        {mode.kind === 'move' && <Field label="Why you are moving it" hint="optional; only you see this"><Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="It was a duty I stood, not work I did" /></Field>}

        <section aria-labelledby={`${uid}-preview`} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm">
          <h3 id={`${uid}-preview`} className="eyebrow mb-1">What Vantage will record</h3>
          {ran ? <p className="fig text-ink">{ran}</p> : <p className="text-ink-3">Give its start and end to see how long it ran.</p>}
          {conditions.length > 0 && <p className="mt-1 flex flex-wrap gap-1">{conditions.map((c) => <Badge key={c}>{CONDITION_LABELS[c]}</Badge>)}</p>}
          {score && <p className="mt-1 text-ink-2" aria-live="polite">{describeScore(score.points, score.basis)}{score.basis.rule ? `: ${score.basis.rule}` : ''}{score.basis.applied.length ? `, × ${score.basis.factor} for ${score.basis.applied.map((c) => CONDITION_LABELS[c].toLowerCase()).join(' and ')}` : ''}.</p>}
          <p className="mt-1 text-xs text-ink-3">Submitted, not yet counted: a reviewer approves, returns or rejects it.</p>
        </section>
        {problem && <p role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{problem}</p>}
        <button type="submit" className="hidden" aria-hidden />
      </form>
    </Dialog>
  );
}

/** One duty in full: what it was, what it ran to, how it was scored and where it stands. */
export function DutyDetail({ row: r, me }: { row: Duty; me?: string }) {
  const basis = r.scoring_basis;
  const conditions = (r.conditions || []) as ScoringCondition[];
  return (
    <div className="space-y-3">
      <DescriptionList items={[
        ['Status', <Badge tone={DUTY_TONE[r.approval_status]}>{DUTY_STATUS_LABELS[r.approval_status]}</Badge>],
        ['Duty type', r.duty_type_name ? `${r.duty_type_name}${r.duty_type_code ? ` (${r.duty_type_code})` : ''}${r.duty_type_active === false ? ', since retired' : ''}` : null],
        ['Marine', r.user_id !== me ? r.subject_name || null : null],
        ['Location', r.location],
        ['Length', `${formatHours(r.hours)} · ${r.days} duty ${r.days === 1 ? 'day' : 'days'}${r.overnight ? ' · overnight' : ''}${r.multi_day ? ' · more than a day' : ''}`],
        ['Conditions', conditions.length ? conditions.map((c) => CONDITION_LABELS[c] || c).join(', ') : 'None'],
        ['Calculated points', <span>{describeScore(r.calculated_points, basis)}{basis?.rule ? <span className="block text-xs text-ink-3">{basis.rule}{basis.applied?.length ? `, × ${basis.factor} for ${basis.applied.map((c) => (CONDITION_LABELS[c] || c).toLowerCase()).join(' and ')}` : ''}; the version in force on <DateText value={basis.day} /></span> : null}</span>],
        ['Approved points', r.approved_points != null ? formatNumber(r.approved_points) : null],
        ['Recorded by', r.recorded_by && r.recorded_by !== r.user_id ? (r.recorded_by === me ? 'You' : r.recorder_name || 'A leader') : null],
        ['Submitted', r.submitted_at ? formatStamp(r.submitted_at) : null],
        ['Reviewed by', r.reviewer_name || null],
        ['Reviewed', r.reviewed_at ? formatStamp(r.reviewed_at) : null],
        [r.approval_status === 'returned' ? 'Why it was returned' : 'Why it was rejected', r.review_reason ? <span className="whitespace-pre-wrap">{r.review_reason}</span> : null],
        ['Notes', r.notes ? <span className="whitespace-pre-wrap">{r.notes}</span> : null],
      ]} />
      {r.user_id === me && r.recorded_by && r.recorded_by !== r.user_id && <p className="text-xs text-ink-3">{r.recorder_name || 'A leader'} recorded this duty for you, so only they or a records manager can change it. Ask them if something needs correcting.</p>}
      {isDecidedDuty(r.approval_status) && <p className="text-xs text-ink-3">Its reviewer decided it, so it stays as it was decided.</p>}
    </div>
  );
}
