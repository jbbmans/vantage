import type { CSSProperties, ReactNode } from 'react';
import { Img, staticFile, useCurrentFrame } from 'remotion';
import { easeOut, p, rand } from '../lib/motion';
import { C, FONT, MONO } from '../theme';

/** Dark glass: the film's card material. */
export function Glass({ children, style, radius = 28, pad = 36 }: { children?: ReactNode; style?: CSSProperties; radius?: number; pad?: number }) {
  return (
    <div style={{
      position: 'relative', borderRadius: radius, padding: pad,
      background: 'linear-gradient(160deg, rgba(255,255,255,0.075), rgba(255,255,255,0.025) 60%)',
      boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.10), inset 0 1px 0 rgba(255,255,255,0.12), 0 50px 120px -40px rgba(0,0,0,0.8)',
      backdropFilter: 'blur(18px)', ...style,
    }}>{children}</div>
  );
}

export function Shot({ src, width, natural, radius = 20, style, glow }: { src: string; width: number; natural: [number, number]; radius?: number; style?: CSSProperties; glow?: number }) {
  const h = (width * natural[1]) / natural[0];
  return (
    <div style={{ position: 'relative', width, height: h, ...style }}>
      <div style={{ position: 'absolute', inset: -9, borderRadius: radius + 9, background: 'rgba(255,255,255,0.04)', boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.09), 0 60px 130px -40px rgba(0,0,0,0.8)${glow ? `, 0 0 ${80 * glow}px rgba(63,208,189,${0.25 * glow})` : ''}` }} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden', background: '#fff' }}>
        <Img src={staticFile(`screens/${src}.png`)} style={{ width, height: h, display: 'block' }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(125deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 32%, rgba(255,255,255,0) 72%, rgba(255,255,255,0.05) 100%)' }} />
      </div>
    </div>
  );
}

export const money = (cents: number, sign = false) => `${sign && cents > 0 ? '+' : cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A number that rolls up to its value. */
export function Counter({ to, at, frames = 26, style, format = (n: number) => String(Math.round(n)) }: { to: number; at: number; frames?: number; style?: CSSProperties; format?: (n: number) => string }) {
  const f = useCurrentFrame();
  const k = p(f, at, at + frames, easeOut);
  return <span style={{ fontVariantNumeric: 'tabular-nums', ...style }}>{format(to * k)}</span>;
}

/** Fades a block in (from below, out of a blur) and optionally out again. */
export function Reveal({ at, out, children, y = 24, style, dur = 18 }: { at: number; out?: number; children: ReactNode; y?: number; style?: CSSProperties; dur?: number }) {
  const f = useCurrentFrame();
  const i = p(f, at, at + dur, easeOut);
  const o = out != null ? p(f, out, out + 14, easeOut) : 0;
  const blur = (1 - i) * 10 + o * 10;
  return <div style={{ opacity: i * (1 - o), transform: `translateY(${(1 - i) * y - o * 14}px)`, filter: blur > 0.05 ? `blur(${blur}px)` : undefined, ...style }}>{children}</div>;
}

/** Soft dust drifting through the light: depth for dark scenes. */
export function Dust({ n = 60, seed = 1, color = '255,255,255', max = 0.35, rise = 0.25 }: { n?: number; seed?: number; color?: string; max?: number; rise?: number }) {
  const f = useCurrentFrame();
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
      {Array.from({ length: n }, (_, i) => {
        const r1 = rand(seed * 100 + i); const r2 = rand(seed * 200 + i * 3); const r3 = rand(seed * 300 + i * 7);
        const size = 1 + r3 * 3;
        const x = (r1 * 1920 + Math.sin(f / 90 + i) * 30) % 1920;
        const y = ((r2 * 1200 - f * rise * (0.5 + r3)) % 1200 + 1200) % 1200 - 60;
        const tw = 0.5 + 0.5 * Math.sin(f / (20 + r3 * 30) + i);
        return <div key={i} style={{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: size, background: `rgba(${color},${max * tw * (0.3 + r3 * 0.7)})`, filter: size > 3 ? 'blur(1px)' : undefined }} />;
      })}
    </div>
  );
}

/** A small caps label in mono, for figures and system names. */
export const Mono = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <span style={{ fontFamily: MONO, fontSize: 16, letterSpacing: '0.04em', color: C.mute, ...style }}>{children}</span>
);

export const Wordmark = ({ size = 34, spacing = 0.34, style }: { size?: number; spacing?: number; style?: CSSProperties }) => (
  <div style={{ fontFamily: FONT, fontSize: size, fontWeight: 600, letterSpacing: `${spacing}em`, marginRight: `-${spacing}em`, color: '#fff', ...style }}>VANTAGE</div>
);
