import type { CSSProperties } from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { cameraAt, cursorAt, framesAt, keysAt, takeOf, VH, VW, WIDE, type Cam } from '../lib/take';
import { Keycap, Pointer, Ripple } from './Cursor';

export function Screen({ take: key, width, offset = 0, startCam = WIDE, radius = 22, style, showKeys = true, chrome = true, lift = 0 }: {
  take: string; width: number; offset?: number; startCam?: Cam; radius?: number; style?: CSSProperties; showKeys?: boolean; chrome?: boolean; lift?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const take = takeOf(key);
  const t = Math.min(take.duration, Math.max(0, frame / fps + offset));
  const { current, under, mix } = framesAt(take, t);
  const cam = cameraAt(take, t, startCam);
  const cur = cursorAt(take, t);
  const keys = showKeys ? keysAt(take, t) : [];
  const b = width / VW;
  const height = VH * b;
  const s = b * cam.z;
  // Content transform: the camera's centre goes to the plate's centre.
  const tx = width / 2 - cam.cx * s;
  const ty = height / 2 - cam.cy * s;
  const pointerSize = 30 * (1 + 0.22 * (cam.z - 1));

  return (
    <div style={{ position: 'relative', width, height, ...style }}>
      {chrome && <div style={{ position: 'absolute', inset: -10, borderRadius: radius + 10, background: 'rgba(255,255,255,0.045)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.09), 0 70px 140px -40px rgba(0,0,0,0.75), 0 24px 50px -20px rgba(2,8,20,0.6)' }} />}
      <div style={{ position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden', background: '#f5f6f8', boxShadow: `inset 0 0 0 1px rgba(255,255,255,0.08), 0 ${lift}px ${lift * 2}px -${lift / 2}px rgba(0,0,0,.4)` }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: VW, height: VH, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${s})` }}>
          {under && <Img src={staticFile(under.src)} style={{ position: 'absolute', inset: 0, width: VW, height: VH }} />}
          <Img src={staticFile(current.src)} style={{ position: 'absolute', inset: 0, width: VW, height: VH, opacity: under ? mix : 1 }} />
          {cur.ripples.map((r, i) => <Ripple key={i} x={r.x} y={r.y} k={r.k} size={pointerSize / (s || 1)} />)}
          <div style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', transform: `scale(${1 / s})` }}>
            <Pointer x={cur.x * s} y={cur.y * s} size={pointerSize} press={cur.press} opacity={cur.visible} />
          </div>
        </div>
        {/* Glass: a faint sheen from the upper left, as on every plate in the film. */}
        <AbsoluteFill style={{ background: 'linear-gradient(125deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 30%, rgba(255,255,255,0) 72%, rgba(255,255,255,0.04) 100%)', pointerEvents: 'none' }} />
      </div>
      {keys.map((k, i) => <Keycap key={i} label={k.key} k={k.k} pressed={k.pressed} />)}
    </div>
  );
}
