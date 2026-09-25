import { cn } from '@/lib/utils';

const NAVY = '#0B2D5B';
const TEAL = '#14B8A6';
const COBALT = '#2563EB';
const TEAL_UP = '#2DD4BF';
const COBALT_UP = '#5B8DEF';

export function Mark({ size = 26, reversed = false, className }: { size?: number; reversed?: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className={cn('shrink-0', className)} aria-hidden focusable="false">
      <path fill={reversed ? '#FFFFFF' : NAVY} d="M7 34h28l25 43 25-43h28L60 118 7 34Z" />
      <path fill={reversed ? TEAL_UP : TEAL} d="M60 2 90 32 74 48 60 34 46 48 30 32 60 2Z" />
      <path fill={reversed ? NAVY : '#FFFFFF'} d="M60 33 82 58 60 90 38 58 60 33Z" />
      <path fill={reversed ? COBALT_UP : COBALT} d="M60 43 72 58 60 78 48 58 60 43Z" />
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

export const TAGLINE = 'Higher insight. Greater impact.';
