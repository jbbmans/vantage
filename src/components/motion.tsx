import { useEffect, useRef } from 'react';
import { loadAnime, markRunning, reducedMotion } from '@/lib/motion';

/**
 * React hooks over the Anime.js half of the motion policy (see src/lib/motion.ts). Both animate a
 * change the person can already read in the text; neither ever changes what the text says.
 */

/**
 * Pulses the element once when `value` changes, never on first render. Used on a stage badge so
 * that "Researching" becoming "Waiting on approval" is noticed without anything flashing at rest.
 */
export function usePulseOnChange<T extends HTMLElement>(value: unknown) {
  const ref = useRef<T | null>(null);
  const previous = useRef(value);
  useEffect(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    const el = ref.current;
    if (!el || reducedMotion()) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    markRunning(el, true);
    void loadAnime().then(({ animate }) => {
      if (cancelled) return;
      const run = animate(el, {
        scale: [1, 1.07, 1],
        duration: 420,
        ease: 'outQuad',
        onComplete: () => markRunning(el, false),
      });
      stop = () => { run.revert(); markRunning(el, false); };
    });
    return () => { cancelled = true; stop?.(); };
  }, [value]);
  return ref;
}

/**
 * Draws the check mark of each step that has just become done. `statuses` maps a step key to its
 * status; a step counts as newly done only if an earlier render saw it as something else, so
 * opening a case that is already half finished draws nothing.
 *
 * The icon to draw is the first <svg> inside the element marked data-step="<key>".
 */
export function useDrawOnComplete(container: React.RefObject<HTMLElement | null>, statuses: Record<string, string>) {
  const previous = useRef<Record<string, string> | null>(null);
  // A new object arrives on every render; the effect should only run when a status actually moved.
  const signature = Object.entries(statuses).map(([k, v]) => `${k}:${v}`).join('|');
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);
  useEffect(() => {
    const now = Object.fromEntries(signature ? signature.split('|').map((pair) => pair.split(':') as [string, string]) : []);
    const before = previous.current;
    previous.current = now;
    if (!before || reducedMotion()) return;
    const done = Object.keys(now).filter((k) => now[k] === 'done' && before[k] && before[k] !== 'done');
    const root = container.current;
    if (!done.length || !root) return;
    const icons = done
      .map((k) => root.querySelector<HTMLElement>(`[data-step="${CSS.escape(k)}"]`))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!icons.length) return;
    icons.forEach((el) => markRunning(el, true));
    void loadAnime().then(({ animate, svg, stagger }) => {
      if (unmounted.current) return;
      for (const el of icons) {
        const shapes = el.querySelectorAll('svg circle, svg path');
        if (!shapes.length) { markRunning(el, false); continue; }
        animate(svg.createDrawable(shapes), {
          draw: ['0 0', '0 1'],
          duration: 360,
          delay: stagger(140),
          ease: 'inOutQuad',
          onComplete: () => markRunning(el, false),
        });
        animate(el, { scale: [0.85, 1.12, 1], duration: 460, ease: 'outQuad' });
      }
    });
  }, [container, signature]);
}
