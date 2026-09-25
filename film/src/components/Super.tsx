import type { CSSProperties } from 'react';
import { useCurrentFrame } from 'remotion';
import { easeOut, p } from '../lib/motion';
import { FONT } from '../theme';

export function Super({ words, at, out, size = 96, weight = 600, color = '#fff', gradient, style, stagger = 3, rise = 26, lineHeight = 1.02, tracking = -0.045, align = 'left' }: {
  words: string[] | string; at: number | number[]; out?: number; size?: number; weight?: number; color?: string; gradient?: string;
  style?: CSSProperties; stagger?: number; rise?: number; lineHeight?: number; tracking?: number; align?: 'left' | 'center' | 'right';
}) {
  const f = useCurrentFrame();
  const list = Array.isArray(words) ? words : words.split(' ');
  const leave = out != null ? p(f, out, out + 14, easeOut) : 0;
  return (
    <div style={{ fontFamily: FONT, fontSize: size, fontWeight: weight, lineHeight, letterSpacing: `${tracking}em`, color, textAlign: align, ...style }}>
      {list.map((w, i) => {
        if (w === '\n') return <br key={i} />;
        const start = Array.isArray(at) ? (at[i] ?? at[at.length - 1]) : at + i * stagger;
        const t = p(f, start, start + 16, easeOut);
        const blur = (1 - t) * 12 + leave * 10;
        return (
          <span key={i} style={{
            display: 'inline-block', whiteSpace: 'pre',
            opacity: t * (1 - leave),
            transform: `translateY(${(1 - t) * rise - leave * 18}px)`,
            filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined,
            ...(gradient ? { backgroundImage: gradient, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' } : {}),
          }}>{w}{i < list.length - 1 && list[i + 1] !== '\n' ? ' ' : ''}</span>
        );
      })}
    </div>
  );
}

/** The small caps label above a statement. */
export function Eyebrow({ text, at, color = '#3fd0bd', style }: { text: string; at: number; color?: string; style?: CSSProperties }) {
  const f = useCurrentFrame();
  const t = p(f, at, at + 18);
  return (
    <div style={{ fontFamily: FONT, fontSize: 20, fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase', color, opacity: t, transform: `translateY(${(1 - t) * 10}px)`, display: 'flex', alignItems: 'center', gap: 16, ...style }}>
      <span style={{ width: 40 * t, height: 2, background: color, display: 'inline-block' }} />{text}
    </div>
  );
}
