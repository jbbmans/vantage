import { useCurrentFrame, useVideoConfig } from 'remotion';
import { MARK_FILLS, MARK_PATHS } from '../../../shared/brand';
import { land } from '../lib/motion';

export function Mark({ size = 220, at = 0, still = false }: { size?: number; at?: number; still?: boolean }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = (d: number) => (still ? 1 : land(f, fps, at + d, 16));
  const v = k(0);
  const rise = k(5);
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} style={{ overflow: 'visible' }}>
      <path fill={MARK_FILLS.reversed.v} d={MARK_PATHS.v} style={{ transform: `translateY(${(1 - v) * 24}px)`, opacity: v }} />
      <path fill={MARK_FILLS.reversed.rise} d={MARK_PATHS.rise} style={{ transform: `translateY(${(1 - rise) * -18}px)`, opacity: rise }} />
    </svg>
  );
}
