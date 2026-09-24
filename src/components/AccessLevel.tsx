import { ACCESS_LABEL, type AccessLevel } from '../../shared/access';
import { cn } from '@/lib/utils';

/**
 * The three access levels (shared/access.ts), each with one colour used everywhere it appears:
 * grey for Personal, the brand teal for Team leader, the accent for Administrator. Both colours
 * carry text at 4.5:1 or better in either theme.
 */
export const LEVEL_DOT: Record<AccessLevel, string> = { personal: 'bg-ink-3', leader: 'bg-accent-2', administrator: 'bg-accent' };
const LEVEL_CHIP: Record<AccessLevel, string> = { personal: 'bg-surface-2 text-ink-2', leader: 'bg-accent-2/10 text-accent-2', administrator: 'bg-accent-soft text-accent' };

export function LevelBadge({ level, className }: { level: AccessLevel; className?: string }) {
  return <span className={cn('chip', LEVEL_CHIP[level], className)}><span className={cn('h-1.5 w-1.5 rounded-full', LEVEL_DOT[level])} aria-hidden />{ACCESS_LABEL[level]}</span>;
}
