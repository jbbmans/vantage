import { useCurrentFrame, useVideoConfig } from 'remotion';
import { land, p } from '../lib/motion';

/**
 * The Vantage mark, assembled: the chevron rises, the crown settles onto it, the diamonds open in
 * the middle. Four pieces, the same four paths as public/brand/mark-reversed.svg.
 */
export function Mark({ size = 220, at = 0, still = false }: { size?: number; at?: number; still?: boolean }) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const k = (d: number) => (still ? 1 : land(f, fps, at + d, 16));
  const v = k(0); const crown = k(5); const d1 = k(10); const d2 = k(14);
  const glow = still ? 1 : p(f, at + 8, at + 40);
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} style={{ overflow: 'visible', filter: `drop-shadow(0 0 ${30 * glow}px rgba(63,208,189,${0.35 * glow}))` }}>
      <path fill="#FFFFFF" d="M7 34h28l25 43 25-43h28L60 118 7 34Z" style={{ transform: `translateY(${(1 - v) * 40}px)`, opacity: v }} />
      <path fill="#14B8A6" d="M60 2 90 32 74 48 60 34 46 48 30 32 60 2Z" style={{ transform: `translateY(${(1 - crown) * -34}px)`, opacity: crown }} />
      <path fill="#0B2D5B" d="M60 33 82 58 60 90 38 58 60 33Z" style={{ transformOrigin: '60px 60px', transform: `scale(${d1})`, opacity: d1 }} />
      <path fill="#2563EB" d="M60 43 72 58 60 78 48 58 60 43Z" style={{ transformOrigin: '60px 60px', transform: `scale(${d2})`, opacity: d2 }} />
    </svg>
  );
}
