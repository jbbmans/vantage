import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { C } from '../theme';

const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; };

export function Backdrop({ glow = 1, contours = 0.07, hue = 'cool', accent = '#3fd0bd' }: { glow?: number; contours?: number; hue?: 'cool' | 'warm' | 'black'; accent?: string }) {
  const f = useCurrentFrame();
  const a = f / 300;
  const x1 = 72 + Math.sin(a * 0.9) * 6;
  const y1 = 8 + Math.cos(a * 0.7) * 5;
  const x2 = 10 + Math.cos(a * 0.6) * 5;
  const y2 = 86 + Math.sin(a * 0.8) * 4;
  const base = hue === 'black' ? '#02060d' : C.ink;
  return (
    <AbsoluteFill style={{ background: base, overflow: 'hidden' }}>
      <AbsoluteFill style={{
        opacity: glow,
        background: `radial-gradient(1200px 700px at ${x1}% ${y1}%, rgba(47,107,255,${hue === 'warm' ? 0.18 : 0.26}), transparent 62%),
          radial-gradient(900px 620px at ${x2}% ${y2}%, rgba(${rgb(accent)},0.15), transparent 60%),
          linear-gradient(180deg, ${base} 0%, ${C.navy} 100%)`,
      }} />
      {contours > 0 && (
        <Img src={staticFile('brand/mission-contours.webp')} style={{
          position: 'absolute', width: 2600, left: -340 + Math.sin(a * 0.5) * 40, top: -520 + Math.cos(a * 0.4) * 30,
          opacity: contours, mixBlendMode: 'screen', filter: 'blur(0.4px)',
        }} />
      )}
    </AbsoluteFill>
  );
}
