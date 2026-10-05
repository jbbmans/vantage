import { Link } from 'react-router-dom';
import { ArrowRight, Clock, Hourglass, OctagonAlert } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/primitives';
import { DueText } from '@/components/common';
import { STAGE_LABEL, WAITING_LABEL, type Stage, type WaitingCategory } from '../../shared/caseModel';
import { cn, todayIso } from '@/lib/utils';
import type { AssignedItem } from '../../shared/caseView';

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
  return <Badge tone={STAGE_TONE[s] || 'neutral'} className={className}>{label}</Badge>;
}

export function elapsed(since: string | null | undefined): string {
  if (!since) return '';
  const hours = Math.max(0, (Date.now() - Date.parse(since)) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)} ${Math.round(hours) === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

export const personName = (p: { name: string; rank?: string | null } | undefined | null) => (p ? [p.rank, p.name].filter(Boolean).join(' ') : 'Someone');

/** What a row needs: an assigned item has all of it; other lists may not carry the next step or the waiting details. */
export type WorkRowItem = Pick<AssignedItem, 'id' | 'title' | 'reference' | 'natural_key' | 'due_date' | 'stage'>
  & Partial<Pick<AssignedItem, 'waiting_category' | 'waiting_since' | 'blocked_reason' | 'next_step'>>;

export function WorkRow({ item, showNext = true, trailing }: { item: WorkRowItem; showNext?: boolean; trailing?: React.ReactNode }) {
  const overdue = item.due_date && item.due_date < todayIso() && !['resolved', 'not_applicable'].includes(item.stage);
  return (
    <li>
      {/* On a phone the due date goes under the title instead of beside it, so the title gets the width. */}
      <Link to={`/work/items/${item.id}`} className="group flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-start sm:gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="fig text-sm font-semibold text-ink">{item.reference || item.natural_key}</span>
            <StageBadge stage={item.stage} waiting={item.waiting_category} />
            {overdue && <Badge tone="bad">Overdue</Badge>}
          </span>
          <span className="mt-0.5 line-clamp-2 text-sm text-ink-2 sm:line-clamp-1" title={item.title}>{item.title}</span>
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
        <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3 sm:flex-col sm:flex-nowrap sm:items-end sm:gap-1">
          {item.due_date && <span className={cn('flex items-center gap-1', overdue && 'text-bad')}><Clock className="h-3 w-3" aria-hidden /><DueText value={item.due_date} done={['resolved', 'not_applicable'].includes(item.stage)} /></span>}
          {trailing}
        </span>
      </Link>
    </li>
  );
}
