import type { CSSProperties } from 'react';
import { useCurrentFrame } from 'remotion';
import { easeInOut, easeOut, p } from '../lib/motion';
import { FONT } from '../theme';

/** Figures stand out in the film's accent: a number is usually the point of the sentence. */
const isFigure = (w: string) => /\d/.test(w) || /^\$/.test(w);

/**
 * A card of on-screen text. Words rise out of a blur one after another, hold, and leave together as the next
 * card arrives. Sized from its length so a long sentence still sits on two lines.
 */
export function Caption({ text, from, to, accent, size, maxWidth = 1460, align = 'left', style, color = '#fff', leave = true }: {
  text: string; from: number; to: number; accent: string; size?: number; maxWidth?: number; align?: 'left' | 'center';
  style?: CSSProperties; color?: string; leave?: boolean;
}) {
  const f = useCurrentFrame();
  if (!text.trim() || f < from - 1 || f > to + 12) return null;
  const words = text.split(' ');
  const fontSize = size ?? (text.length > 78 ? 44 : text.length > 56 ? 50 : 56);
  const out = leave ? p(f, to - 8, to + 6, easeInOut) : 0;
  return (
    <div style={{
      fontFamily: FONT, fontSize, fontWeight: 600, lineHeight: 1.14, letterSpacing: '-0.028em', color, maxWidth, textAlign: align,
      opacity: 1 - out, transform: `translateY(${-out * 16}px)`, filter: out > 0.01 ? `blur(${out * 8}px)` : undefined, textWrap: 'balance', ...style,
    } as CSSProperties}>
      {words.map((w, i) => {
        const t = p(f, from + i * 1.6, from + i * 1.6 + 15, easeOut);
        const blur = (1 - t) * 10;
        return (
          <span key={i} style={{
            display: 'inline-block', whiteSpace: 'pre', opacity: t, transform: `translateY(${(1 - t) * 20}px)`,
            filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined, color: isFigure(w) ? accent : undefined,
          }}>{w}{i < words.length - 1 ? ' ' : ''}</span>
        );
      })}
    </div>
  );
}

/** The small caps line above a caption: where in the film this is. */
export function Kicker({ children, accent, at = 0, style }: { children: React.ReactNode; accent: string; at?: number; style?: CSSProperties }) {
  const f = useCurrentFrame();
  const t = p(f, at, at + 16);
  return (
    <div style={{ fontFamily: FONT, fontSize: 17, fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', color: accent, opacity: t, display: 'flex', alignItems: 'center', gap: 14, ...style }}>
      {children}
    </div>
  );
}

/** Honest in every product shot: the data is invented. */
export function DemoTag({ style }: { style?: CSSProperties }) {
  return (
    <div style={{ fontFamily: FONT, fontSize: 15, letterSpacing: '0.08em', color: 'rgba(201,213,232,0.6)', display: 'flex', alignItems: 'center', gap: 9, ...style }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: 'rgba(63,208,189,0.85)' }} />Demo data
    </div>
  );
}
