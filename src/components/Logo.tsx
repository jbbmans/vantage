import { cn } from '@/lib/utils';
import { MARK_FILLS, MARK_PATHS } from '../../shared/brand';

const PARTS = Object.keys(MARK_PATHS) as Array<keyof typeof MARK_PATHS>;

/** The mark from shared/brand.ts, the same geometry and fills as the favicon and every generated icon. */
export function Mark({ size = 26, reversed = false, className }: { size?: number; reversed?: boolean; className?: string }) {
  const fills = MARK_FILLS[reversed ? 'reversed' : 'primary'];
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={cn('shrink-0', className)} aria-hidden focusable="false">
      {PARTS.map((part) => <path key={part} fill={fills[part]} d={MARK_PATHS[part]} />)}
    </svg>
  );
}

export default function Logo({
  size = 26, reversed = false, descriptor = false, className, wordClassName,
}: { size?: number; reversed?: boolean; descriptor?: boolean; className?: string; wordClassName?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Mark size={size} reversed={reversed} />
      <span className="min-w-0">
        <span
          className={cn('block font-bold leading-none tracking-[-0.03em]', reversed ? 'text-white' : 'text-ink', wordClassName)}
          style={{ fontSize: Math.round(size * 0.78) }}
        >
          VANTAGE
        </span>
        {descriptor && (
          <span
            className={cn('mt-1 block font-medium leading-none', reversed ? 'text-white/70' : 'text-ink-3')}
            style={{ fontSize: Math.max(9, Math.round(size * 0.3)) }}
          >
            Performance <span aria-hidden className="text-accent">·</span> Productivity <span aria-hidden className="text-accent">·</span> Readiness
          </span>
        )}
      </span>
    </span>
  );
}
