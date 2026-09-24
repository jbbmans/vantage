import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { ArrowRight, Clock, Hourglass, OctagonAlert } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/primitives';
import { DateText } from '@/components/common';
import { usePulseOnChange } from '@/components/motion';
import { DURATION, EASE } from '@/lib/motion';
import { STAGE_LABEL, WAITING_LABEL, type Stage, type WaitingCategory } from '../../shared/caseModel';
import { cn } from '@/lib/utils';

export const STAGE_TONE: Record<Stage, Tone> = {
  not_started: 'neutral',
  researching: 'accent',
  ready_for_action: 'info',
  submitted: 'info',
  waiting: 'warn',
  blocked: 'bad',
  verification_required: 'accent',
  resolved: 'good',
  not_applicable: 'neutral',
};

export function StageBadge({ stage, waiting, className }: { stage: string | null | undefined; waiting?: string | null; className?: string }) {
  const s = (stage || 'not_started') as Stage;
  const label = s === 'waiting' && waiting ? `Waiting on ${WAITING_LABEL[waiting as WaitingCategory]?.toLowerCase() || waiting.replace(/_/g, ' ')}` : STAGE_LABEL[s] || s;
  // One pulse when the stage it names changes, so a move is noticed; nothing at rest.
  const pulse = usePulseOnChange<HTMLSpanElement>(label);
  return <span ref={pulse} data-stage-badge className="inline-flex"><Badge tone={STAGE_TONE[s] || 'neutral'} className={className}>{label}</Badge></span>;
}

/** "3 days", "5 hours": how long something has been sitting, never framed as time worked. */
export function elapsed(since: string | null | undefined): string {
  if (!since) return '';
  const hours = Math.max(0, (Date.now() - Date.parse(since)) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)} ${Math.round(hours) === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

export const personName = (p: { name: string; rank?: string | null } | undefined | null) => (p ? [p.rank, p.name].filter(Boolean).join(' ') : 'Someone');

/**
 * A list of work rows. Rows that arrive after the list first rendered slide in, rows that leave fold
 * away, and the rest close the gap, so claiming something visibly moves it off "Open to claim" and
 * onto "Your work". What is already there when the page opens does not animate.
 */
export function WorkList({ items, showNext, trailing, className = 'divide-y divide-line' }: { items: any[]; showNext?: boolean; trailing?: (item: any) => React.ReactNode; className?: string }) {
  return (
    <ul className={className}>
      <AnimatePresence initial={false}>
        {items.map((item) => <WorkRow key={item.id} item={item} showNext={showNext} trailing={trailing?.(item)} />)}
      </AnimatePresence>
    </ul>
  );
}

/**
 * One row of work in a list: what it is, where it stands, and the next thing to do. Used on Today,
 * in Record, and in a leader's workload, so a piece of work reads the same wherever it appears.
 * Render it inside WorkList, or inside an AnimatePresence with initial={false}, so rows only move
 * when the list changes.
 */
export function WorkRow({ item, showNext = true, trailing }: { item: any; showNext?: boolean; trailing?: React.ReactNode }) {
  const overdue = item.due_date && item.due_date < new Date().toISOString().slice(0, 10) && !['resolved', 'not_applicable'].includes(item.stage);
  return (
    <m.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
      transition={{ duration: DURATION.base, ease: EASE.standard }}
    >
      <Link to={`/work/items/${item.id}`} className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="fig text-sm font-semibold text-ink">{item.reference || item.natural_key}</span>
            <StageBadge stage={item.stage} waiting={item.waiting_category} />
            {overdue && <Badge tone="bad">Overdue</Badge>}
          </span>
          <span className="mt-0.5 block truncate text-sm text-ink-2">{item.title}</span>
          {showNext && item.stage === 'waiting' && item.waiting_since && (
            <span className="mt-1 flex items-center gap-1.5 text-xs text-ink-3"><Hourglass className="h-3.5 w-3.5" aria-hidden />Waiting {elapsed(item.waiting_since)}. Elapsed time, not work.</span>
          )}
          {showNext && item.stage === 'blocked' && item.blocked_reason && (
            <span className="mt-1 flex items-center gap-1.5 text-xs text-bad"><OctagonAlert className="h-3.5 w-3.5" aria-hidden />{item.blocked_reason}</span>
          )}
          {showNext && item.next_step && !['waiting', 'blocked'].includes(item.stage) && (
            <span className="mt-1 flex items-center gap-1.5 text-xs text-accent"><ArrowRight className="h-3.5 w-3.5" aria-hidden />Next: {item.next_step.title}{item.next_step.note ? ` · ${item.next_step.note}` : ''}</span>
          )}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-ink-3">
          {item.due_date && <span className={cn('flex items-center gap-1', overdue && 'text-bad')}><Clock className="h-3 w-3" aria-hidden />Due <DateText value={item.due_date} /></span>}
          {trailing}
        </span>
      </Link>
    </m.li>
  );
}
