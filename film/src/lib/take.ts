import takesData from '../generated/takes.json';

/**
 * Playing back a take: which captured frame is on screen, where the camera is, where the cursor is.
 *
 * A take is the product recorded on a virtual clock (tools/capture.mjs): keyframes stamped with the
 * second they belong at, and an event log of camera moves, pointer moves, clicks, keys and cuts.
 * Everything here is a pure function of the take and a time, so any frame renders identically.
 */

export interface TakeFrame { src: string; t: number }
export interface Box { x: number; y: number; width: number; height: number }
export type TakeEvent =
  | { t: number; type: 'focus'; box: Box; zoom: number; ease: number }
  | { t: number; type: 'wide'; ease: number }
  | { t: number; type: 'move'; x: number; y: number; dur: number }
  | { t: number; type: 'click'; x: number; y: number }
  | { t: number; type: 'key'; key: string }
  | { t: number; type: 'cut' }
  | { t: number; type: 'char'; ch: string };
export interface Take { film: string; scene: string; duration: number; view: { width: number; height: number }; cursor0: { x: number; y: number }; frames: TakeFrame[]; events: TakeEvent[] }

export const TAKES = takesData as unknown as Record<string, Take>;
export const takeOf = (key: string) => {
  const t = TAKES[key];
  if (!t) throw new Error(`No take ${key}; run tools/shots.mjs`);
  return t;
};

export const VW = 1440;
export const VH = 810;
const DISSOLVE = 0.32;

const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; };

/** The frame on screen at time t, and during a cut, the frame being dissolved away from. */
export function framesAt(take: Take, t: number) {
  let i = 0;
  for (let k = 0; k < take.frames.length; k++) if (take.frames[k].t <= t + 1e-6) i = k;
  const current = take.frames[i];
  let under: TakeFrame | null = null;
  let mix = 1;
  for (const e of take.events) {
    if (e.type !== 'cut' || e.t > t || t - e.t > DISSOLVE) continue;
    let j = -1;
    for (let k = 0; k < take.frames.length; k++) if (take.frames[k].t < e.t - 1e-6) j = k;
    if (j >= 0 && take.frames[j].src !== current.src) { under = take.frames[j]; mix = smooth((t - e.t) / DISSOLVE); }
  }
  return { current, under, mix };
}

export interface Cam { z: number; cx: number; cy: number }
export const WIDE: Cam = { z: 1, cx: VW / 2, cy: VH / 2 };

function targetOf(e: TakeEvent): Cam {
  if (e.type !== 'focus') return WIDE;
  const b = e.box;
  const z = Math.max(1, Math.min(e.zoom, (VW * 0.94) / b.width, (VH * 0.9) / b.height));
  const hw = VW / 2 / z; const hh = VH / 2 / z;
  const cx = Math.min(VW - hw, Math.max(hw, b.x + b.width / 2));
  const cy = Math.min(VH - hh, Math.max(hh, b.y + b.height / 2));
  return { z, cx, cy };
}
const mixCam = (a: Cam, b: Cam, k: number): Cam => ({
  z: Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * k),
  cx: a.cx + (b.cx - a.cx) * k,
  cy: a.cy + (b.cy - a.cy) * k,
});

/** Camera at time t: each focus eases from wherever the camera was when it was called. */
export function cameraAt(take: Take, t: number, start: Cam = WIDE): Cam {
  const evs = take.events.filter((e) => e.type === 'focus' || e.type === 'wide') as Array<Extract<TakeEvent, { type: 'focus' | 'wide' }>>;
  let from = start;
  let prev: (typeof evs)[number] | null = null;
  const at = (ev: (typeof evs)[number], time: number, f: Cam) => mixCam(f, targetOf(ev), smooth((time - ev.t) / Math.max(ev.ease, 1e-3)));
  for (const e of evs) {
    if (e.t > t) break;
    if (prev) from = at(prev, e.t, from);
    prev = e;
  }
  return prev ? at(prev, t, from) : start;
}

/** The camera a take ends on, so the next take can begin there. */
export const endCamera = (take: Take, start: Cam = WIDE) => cameraAt(take, take.duration, start);

/** Pointer at time t: position, press (0..1), and how visible it is. */
export function cursorAt(take: Take, t: number) {
  let x = take.cursor0.x; let y = take.cursor0.y;
  const moves = take.events.filter((e) => e.type === 'move') as Array<Extract<TakeEvent, { type: 'move' }>>;
  for (const m of moves) {
    if (m.t > t) break;
    const k = Math.min(1, (t - m.t) / Math.max(m.dur, 1e-3));
    const eased = smooth(k);
    x += (m.x - x) * eased; y += (m.y - y) * eased;
  }
  const pointerEvents = take.events.filter((e) => e.type === 'move' || e.type === 'click');
  let visible = 0;
  if (pointerEvents.length) {
    const first = pointerEvents[0].t;
    const last = Math.max(...pointerEvents.map((e) => (e.type === 'move' ? e.t + e.dur : e.t)));
    const fadeIn = smooth((t - (first - 0.35)) / 0.3);
    const fadeOut = 1 - smooth((t - (last + 1.6)) / 0.5);
    visible = Math.min(fadeIn, fadeOut);
  }
  let press = 0;
  const ripples: Array<{ x: number; y: number; k: number }> = [];
  for (const e of take.events) {
    if (e.type !== 'click' || e.t > t + 0.001) continue;
    const dt = t - e.t;
    if (dt < 0.22) press = Math.max(press, Math.sin((dt / 0.22) * Math.PI));
    if (dt < 0.6) ripples.push({ x: e.x, y: e.y, k: dt / 0.6 });
  }
  return { x, y, press, visible, ripples };
}

/** A key shown on screen while it is pressed. */
export function keysAt(take: Take, t: number) {
  return (take.events.filter((e) => e.type === 'key') as Array<Extract<TakeEvent, { type: 'key' }>>)
    .filter((e) => t >= e.t - 0.15 && t <= e.t + 1.3)
    .map((e) => ({ key: e.key, k: (t - (e.t - 0.15)) / 1.45, pressed: t >= e.t && t <= e.t + 0.18 }));
}
