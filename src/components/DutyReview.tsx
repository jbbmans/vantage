import { useId, useRef, useState } from 'react';
import { Check, CornerUpLeft, History, RotateCcw, Send, SlidersHorizontal, X } from 'lucide-react';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useDutyReviews, useReviewDuty } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp } from '@/lib/utils';
import { formatNumber } from '../../shared/metrics';
import { DUTY_REVIEW_EVENT_LABELS, DUTY_REVIEW_LIMITS, hasReviewOptions, isOverridden, overridePoints, type DutyReviewAction, type DutyReviewEntry } from '../../shared/dutyReview';
import type { Duty } from '../../shared/types';

/**
 * Reviewing a duty (Task 18, ADR-0024). The server sends, with each duty, the decisions open to its reader (`review`);
 * these controls offer exactly those and nothing else, and the server decides again when one is asked. A decision that
 * takes a reason (a return, a rejection, a reopening, points apart from the calculated ones) asks for it first, and the
 * reason is kept with the duty where its Marine reads it.
 */

const points = (n: number | null | undefined) => (n == null ? 'no points' : `${formatNumber(n)} ${n === 1 ? 'point' : 'points'}`);
const nameOf = (r: Duty) => r.title || r.duty_type_name || 'this duty';

/** What a duty counts for, in a table: its approved points once approved, and nothing before. Calculated points stand beside it. */
export function ApprovedPoints({ row: r }: { row: Duty }) {
  if (r.approval_status !== 'approved') return <span className="text-ink-3"><span aria-hidden>–</span><span className="sr-only">Not counted</span></span>;
  return <>{r.approved_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.approved_points)}{isOverridden(r) && <span className="block text-2xs text-ink-3">override</span>}</>;
}

/** The decisions that say why before they are made. */
type Ask = 'approve_with_points' | 'return' | 'reject' | 'reopen' | 'change_points';

const ASKS: Record<Ask, { action: DutyReviewAction; title: string; confirm: string; reason: string; placeholder: string; withPoints: boolean; danger?: boolean; done: string; lede: (r: Duty, me?: string) => string }> = {
  approve_with_points: {
    action: 'approve', title: 'Approve with different points', confirm: 'Approve', reason: 'Why these points', placeholder: 'What the scoring could not know', withPoints: true, done: 'Approved.',
    lede: (r) => `The scoring gave this duty ${points(r.calculated_points)}${r.scoring_version != null ? ` under version ${r.scoring_version}` : ''}. Give the points it should count for, and why. Both are kept with the duty, and its Marine reads them.`,
  },
  return: {
    action: 'return', title: 'Return for correction', confirm: 'Return it', reason: 'What needs correcting', placeholder: 'What to fix before it comes back', withPoints: false, done: 'Returned for correction.',
    // A duty somebody recorded for its Marine is corrected by whoever recorded it, never by the Marine (ADR-0023 §4).
    lede: (r, me) => !r.recorded_by || r.recorded_by === r.user_id ? `It goes back to ${r.subject_name || 'its Marine'} to correct, and returns to review when they save it. They read what you write here.`
      : r.recorded_by === me ? `You recorded this duty for ${r.subject_name || 'its Marine'}, so it comes back to you to correct, and returns to review when you save it. Its Marine reads what you write here.`
        : `${r.recorder_name || 'A leader'} recorded this duty for ${r.subject_name || 'its Marine'}, so it goes back to them to correct, and returns to review when they save it. They and its Marine read what you write here.`,
  },
  reject: {
    action: 'reject', title: 'Reject this duty', confirm: 'Reject it', reason: 'Why it is rejected', placeholder: 'Why this duty does not count', withPoints: false, danger: true, done: 'Rejected.',
    lede: () => 'A rejected duty counts for nothing and stays as decided unless a reviewer reopens it. Its Marine reads your reason.',
  },
  reopen: {
    action: 'reopen', title: 'Reopen for review', confirm: 'Reopen it', reason: 'Why it is reopened', placeholder: 'What changed since it was decided', withPoints: false, done: 'Reopened. It waits for review again.',
    lede: (r) => r.approval_status === 'approved' ? `Its approved ${points(r.approved_points)} are withdrawn and it waits for review again. Its Marine and whoever decided it are told.`
      : r.approval_status === 'returned' ? 'It goes back to waiting for review as it stands, without a correction. Its Marine and whoever returned it are told.'
        : 'It waits for review again. Its Marine and whoever decided it are told.',
  },
  change_points: {
    action: 'change_points', title: 'Change approved points', confirm: 'Change points', reason: 'Why the points change', placeholder: 'What the scoring could not know', withPoints: true, done: 'Approved points changed.',
    lede: (r) => `It counts for ${points(r.approved_points)} now. The scoring gave it ${points(r.calculated_points)}${r.scoring_version != null ? ` under version ${r.scoring_version}` : ''}: setting it back to that withdraws the override.`,
  },
};

/** The decisions open to the reader on one duty, as buttons. `brief` keeps to the three a queue is worked with. */
export function DutyReviewActions({ row, me, onDone, onCorrect, brief = false, className }: {
  row: Duty; me?: string;
  /** The duty as it stands after a decision, or as the server holds it when the decision was refused because it had changed. */
  onDone?: (saved: Duty) => void;
  /** Opens the form on a returned duty, where saving the correction sends it back. */
  onCorrect?: () => void;
  brief?: boolean; className?: string;
}) {
  const toast = useToast();
  const decide = useReviewDuty();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [confirmOwn, setConfirmOwn] = useState(false);
  const o = row.review;
  if (!o || !hasReviewOptions(o)) return null;
  const own = row.user_id === me;
  const what = nameOf(row);

  const send = async (action: DutyReviewAction, done: string) => {
    try {
      const saved = await decide.mutateAsync({ id: row.id, action, version: row.version });
      toast.success(done);
      onDone?.(saved);
    } catch (e) {
      toast.error(api.errorText(e));
      const current = e instanceof api.ApiError ? (e.extra.current as Duty | undefined) : undefined;
      if (current) onDone?.(current);
    }
  };
  const busy = decide.isPending;
  const size = brief ? 'xs' : 'sm';

  return (
    <div className={className ?? 'flex flex-wrap items-center gap-1.5'}>
      {o.approve && (own
        ? <Button size={size} variant="soft" onClick={() => setConfirmOwn(true)} disabled={busy}><Check className="h-3.5 w-3.5" />Approve my own duty</Button>
        : <Button size={size} variant={brief ? 'soft' : 'primary'} onClick={() => send('approve', `Approved for ${points(row.calculated_points)}.`)} loading={busy && decide.variables?.action === 'approve'} disabled={busy} aria-label={`Approve ${what} for ${points(row.calculated_points)}`}><Check className="h-3.5 w-3.5" />Approve{row.calculated_points != null ? ` · ${formatNumber(row.calculated_points)}` : ''}</Button>)}
      {o.approve_with_points && !brief && <Button size={size} onClick={() => setAsk('approve_with_points')} disabled={busy}><SlidersHorizontal className="h-3.5 w-3.5" />Different points…</Button>}
      {o.return && <Button size={size} variant={brief ? 'ghost' : 'default'} onClick={() => setAsk('return')} disabled={busy} aria-label={`Return ${what} for correction`}><CornerUpLeft className="h-3.5 w-3.5" />Return…</Button>}
      {o.reject && <Button size={size} variant={brief ? 'ghost' : 'default'} onClick={() => setAsk('reject')} disabled={busy} aria-label={`Reject ${what}`}><X className="h-3.5 w-3.5" />Reject…</Button>}
      {o.resubmit && !brief && onCorrect && <Button size={size} variant="primary" onClick={onCorrect} disabled={busy}>Correct it</Button>}
      {o.resubmit && !brief && <Button size={size} onClick={() => send('resubmit', 'Sent back for review.')} loading={busy && decide.variables?.action === 'resubmit'} disabled={busy}><Send className="h-3.5 w-3.5" />Send back as it is</Button>}
      {o.change_points && !brief && <Button size={size} onClick={() => setAsk('change_points')} disabled={busy}><SlidersHorizontal className="h-3.5 w-3.5" />Change points…</Button>}
      {o.reopen && !brief && <Button size={size} variant="ghost" onClick={() => setAsk('reopen')} disabled={busy}><RotateCcw className="h-3.5 w-3.5" />Reopen…</Button>}

      {ask && <AskDialog key={`${row.id}:${ask}:${row.version}`} ask={ask} row={row} me={me} onClose={() => setAsk(null)} onDone={onDone} />}
      <ConfirmDialog open={confirmOwn} onOpenChange={setConfirmOwn} title="Approve your own duty?" danger={false} confirmLabel="Approve"
        body={<>A role you hold lets you approve duty you stood yourself. {what === 'this duty' ? 'It' : `“${what}”`} is approved for {points(row.calculated_points)}, the points the scoring gave it, and the record shows that you approved it yourself.</>}
        onConfirm={async () => { setConfirmOwn(false); await send('approve', `Approved for ${points(row.calculated_points)}.`); }} />
    </div>
  );
}

function AskDialog({ ask, row, me, onClose, onDone }: { ask: Ask; row: Duty; me?: string; onClose: () => void; onDone?: (saved: Duty) => void }) {
  const uid = useId();
  const toast = useToast();
  const decide = useReviewDuty();
  const spec = ASKS[ask];
  const [reason, setReason] = useState('');
  const [value, setValue] = useState(() => (ask === 'change_points' && row.approved_points != null ? String(row.approved_points) : ''));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  // One decision per answer: Enter in a field submits the form again while the first request is still out, and the
  // second would come back as a duty that changed under its reviewer.
  const sending = useRef(false);
  const submit = async () => {
    if (sending.current) return;
    const found: Record<string, string> = {};
    if (!reason.trim()) found.reason = 'Required.';
    if (spec.withPoints && value.trim() === '') found.points = 'Required.';
    else if (spec.withPoints && overridePoints(value) == null) found.points = `A number from 0 to ${DUTY_REVIEW_LIMITS.points.toLocaleString('en-US')}.`;
    if (Object.keys(found).length) { setErrors(found); setProblem(null); return; }
    setErrors({}); setProblem(null);
    sending.current = true;
    try {
      const saved = await decide.mutateAsync({ id: row.id, action: spec.action, version: row.version, reason: reason.trim(), ...(spec.withPoints ? { points: overridePoints(value) } : {}) });
      toast.success(spec.done);
      onClose();
      onDone?.(saved);
    } catch (e) {
      const current = e instanceof api.ApiError ? (e.extra.current as Duty | undefined) : undefined;
      if (current) { toast.error(api.errorText(e)); onClose(); onDone?.(current); return; }
      setErrors((e instanceof api.ApiError && e.fieldErrors) || {});
      setProblem(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      sending.current = false;
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !decide.isPending) onClose(); }} title={spec.title} description={spec.lede(row, me)} size="md"
      footer={<><Button variant="ghost" onClick={onClose} disabled={decide.isPending}>Cancel</Button><Button variant={spec.danger ? 'danger' : 'primary'} onClick={submit} loading={decide.isPending}>{spec.confirm}</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(); }} aria-describedby={problem ? `${uid}-problem` : undefined}>
        {spec.withPoints && (
          <Field label="Approved points" required error={errors.points} hint={`calculated: ${row.calculated_points == null ? 'none' : formatNumber(row.calculated_points)}`}>
            <Input inputMode="decimal" autoComplete="off" value={value} maxLength={9} onChange={(e) => { setValue(e.target.value); if (errors.points) setErrors(({ points: _p, ...rest }) => rest); }} className="max-w-[10rem]" />
          </Field>
        )}
        <Field label={spec.reason} required error={errors.reason} hint={`${reason.length} of ${DUTY_REVIEW_LIMITS.reason}`}>
          <Textarea rows={3} value={reason} maxLength={DUTY_REVIEW_LIMITS.reason} placeholder={spec.placeholder} onChange={(e) => { setReason(e.target.value); if (errors.reason) setErrors(({ reason: _r, ...rest }) => rest); }} />
        </Field>
        {problem && <p id={`${uid}-problem`} role="alert" className="rounded-md border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">{problem}</p>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

const who = (e: DutyReviewEntry) => (e.by_me ? 'You' : e.actor_name || (e.by_owner ? 'Its Marine' : 'A reviewer'));

function outcome(e: DutyReviewEntry): string | null {
  if (e.event === 'approved') return e.override ? `${points(e.approved_points)}, set apart from the calculated ${points(e.calculated_points)}` : `${points(e.approved_points)}${e.scoring_version != null ? `, as scored under version ${e.scoring_version}` : ''}`;
  if (e.event === 'points_changed') return e.override ? `now ${points(e.approved_points)}; the scoring gave ${points(e.calculated_points)}` : `back to the calculated ${points(e.approved_points)}`;
  return null;
}

/** Every decision made on a duty, oldest first: who, when, what it counted for after, and the reason given. */
export function DutyReviewHistory({ id, className }: { id: string; className?: string }) {
  const uid = useId();
  const { data, isError, error } = useDutyReviews(id);
  const reviews = data?.reviews ?? [];
  if (isError) return <p role="alert" className={className ? `${className} text-xs text-ink-3` : 'text-xs text-ink-3'}>Its review history could not be read: {api.errorText(error)}</p>;
  if (!reviews.length) return null;
  return (
    <section aria-labelledby={`${uid}-history`} className={className}>
      <h3 id={`${uid}-history`} className="eyebrow mb-1.5 flex items-center gap-1.5"><History className="h-3.5 w-3.5" aria-hidden />Review history</h3>
      <ol className="divide-y divide-line rounded-md border border-line">
        {reviews.map((e) => {
          const result = outcome(e);
          return (
            <li key={e.id} className="px-3 py-2 text-sm">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-ink"><span className="font-medium">{DUTY_REVIEW_EVENT_LABELS[e.event]}</span> <span className="text-ink-2">by {who(e)}{e.by_owner && e.event === 'approved' ? `, under ${e.by_me ? 'your' : 'their'} own self-approval authority` : ''}</span></span>
                <time dateTime={e.at} className="fig text-xs text-ink-3">{formatStamp(e.at)}</time>
              </p>
              {result && <p className="fig text-xs text-ink-2">{result}</p>}
              {e.reason && <p className="mt-1 whitespace-pre-wrap border-l-2 border-line-strong pl-2 text-ink-2">{e.reason}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
