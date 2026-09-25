import { Easing, interpolate, spring } from 'remotion';

export const easeOut = Easing.bezier(0.32, 0.72, 0, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const easeIn = Easing.bezier(0.55, 0, 0.9, 0.3);

/** 0→1 across [from, to] frames, eased and clamped. */
export const p = (frame: number, from: number, to: number, ease = easeOut) =>
  interpolate(frame, [from, to], [0, 1], { easing: ease, extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/** Linear map with clamping. */
export const lerp = (t: number, a: number, b: number) => a + (b - a) * t;

/** A settle with a touch of weight: for things that land. */
export const land = (frame: number, fps: number, delay = 0, damping = 18) =>
  spring({ frame: frame - delay, fps, config: { damping, mass: 0.9, stiffness: 120 } });

export const rand = (seed: number) => {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
};
