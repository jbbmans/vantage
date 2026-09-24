/**
 * One motion policy for the four animation libraries Vantage uses.
 *
 * Each library has one job, chosen for what it does best, so no two of them animate the same thing:
 *
 *   CSS (experience-motion.css)  page entrances, hover and press feedback. Unchanged.
 *   Motion (motion/react)        layout: tab and step indicators that slide, list rows that enter and
 *                                leave, toasts that make room for each other, a new step's form.
 *   React Spring                 values that move under a person's hand: progress meters spring to a
 *                                new reading when goal progress or a procedure step changes.
 *   GSAP                         the one sequenced timeline: a fresh candidate calculation shows its
 *                                arithmetic in order, inputs first, adjustment last.
 *   Anime.js                     small imperative touches: a completed step's check draws itself, and
 *                                a stage badge pulses once when the stage it names changes.
 *
 * The rules all four follow:
 *
 *  1. Motion explains a change. Nothing animates at rest, on a timer, or just because a page loaded.
 *  2. Figures are records. A money amount or a count is never tweened through wrong values: the text
 *     is exact from the first frame, and only its position, opacity or emphasis moves.
 *  3. Nothing waits on an animation. Every control works mid-animation, and content is never hidden
 *     until something finishes.
 *  4. Reduced motion is honoured everywhere: the operating-system setting turns every one of these
 *     off, not just the CSS ones.
 *  5. While a JS animation runs, its element carries data-motion="running", so a test or a screen
 *     capture can wait for the settled state instead of guessing at a delay.
 */

import { Globals } from '@react-spring/web';
import type { gsap as Gsap } from 'gsap';
import type * as Anime from 'animejs';

/** Seconds. The same values as --motion-fast / --motion-base / --motion-slow in the CSS layer. */
export const DURATION = { fast: 0.12, base: 0.19, slow: 0.32 } as const;

/** The CSS layer's two curves, as cubic-bezier control points. */
export const EASE = {
  standard: [0.2, 0.75, 0.2, 1] as [number, number, number, number],
  spring: [0.16, 1, 0.3, 1] as [number, number, number, number],
};

const query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

/** True when the person asked their operating system for less motion. Read at the moment of use. */
export function reducedMotion(): boolean {
  return Boolean(query?.matches);
}

/**
 * Applies the reduced-motion setting to the libraries that keep global state, and keeps it current
 * if the setting changes while the app is open. Motion reads it through <MotionConfig
 * reducedMotion="user">; GSAP and Anime.js check reducedMotion() before each run.
 */
export function installMotionPolicy() {
  const apply = () => Globals.assign({ skipAnimation: reducedMotion() });
  apply();
  query?.addEventListener?.('change', apply);
  return () => query?.removeEventListener?.('change', apply);
}

/** Marks an element as animating for the length of a run. Safe to call on a detached node. */
export function markRunning(el: Element | null | undefined, running: boolean) {
  if (!el) return;
  if (running) el.setAttribute('data-motion', 'running');
  else el.removeAttribute('data-motion');
}

// GSAP and Anime.js are only needed after a person does something, so they load on first use and
// stay out of the bundle every page pays for.
let gsapLoad: Promise<typeof Gsap> | null = null;
export function loadGsap() {
  gsapLoad ??= import('gsap').then((m) => m.gsap);
  return gsapLoad;
}

// Only the three Anime.js modules in use, not the whole library.
type AnimeParts = { animate: typeof Anime.animate; svg: { createDrawable: typeof Anime.svg.createDrawable }; stagger: typeof Anime.stagger };
let animeLoad: Promise<AnimeParts> | null = null;
export function loadAnime(): Promise<AnimeParts> {
  animeLoad ??= Promise.all([import('animejs/animation'), import('animejs/svg'), import('animejs/utils')])
    .then(([animation, svg, utils]) => ({ animate: animation.animate, svg: { createDrawable: svg.createDrawable }, stagger: utils.stagger }));
  return animeLoad;
}

// Motion's layout and gesture features (shared layout, exit animations) load after the first paint.
// Until they arrive nothing animates and everything is already where it belongs.
export const loadMotionFeatures = () => import('./motionFeatures').then((m) => m.default);
