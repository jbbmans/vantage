/**
 * The cursor spotlight on cards (src/styles/premium.css → `.card::before`).
 *
 * One delegated listener for the whole app rather than one per card: it finds the card under the
 * pointer, writes the pointer's position into that card's --mx/--my once per frame, and marks it
 * with data-spot so its border can light. Touch screens have no hover, so nothing is installed there.
 */
export function installSpotlight(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return () => {};
  let lit: HTMLElement | null = null;
  let frame = 0;
  let last: PointerEvent | null = null;

  const paint = () => {
    frame = 0;
    const e = last;
    if (!e) return;
    const card = (e.target as Element | null)?.closest?.<HTMLElement>('.app-shell .card') ?? null;
    if (card !== lit) {
      lit?.removeAttribute('data-spot');
      lit = card;
      card?.setAttribute('data-spot', '');
    }
    if (card) {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
  };
  const onMove = (e: PointerEvent) => { last = e; if (!frame) frame = requestAnimationFrame(paint); };
  const onLeave = () => { lit?.removeAttribute('data-spot'); lit = null; };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  return () => {
    document.removeEventListener('pointermove', onMove);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    if (frame) cancelAnimationFrame(frame);
    onLeave();
  };
}
