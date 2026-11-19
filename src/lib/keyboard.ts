/**
 * What the keyboard shortcuts read from the page before acting on a key: whether it is someone typing, whether it is in
 * a widget that takes typed keys of its own, and whether the person has single-key shortcuts on at all.
 */
import { useCallback, useEffect, useState } from 'react';

/** Inputs that take no typed text: a letter pressed on one is nobody's text, and the bar under a thumb stays put. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

/** A field that takes typed text: a text-like input, a textarea, a select (it finds an option by typing) or editable content. */
export function isTextEntry(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.tagName !== 'string') return false;
  if (node.isContentEditable || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  return node.tagName === 'INPUT' && !NOT_TEXT.has((node as HTMLInputElement).type);
}

// Dialogs, menus, lists and comboboxes read typed letters themselves (to find an option, say), and a dialog is its own
// place: a page's shortcut never acts inside one, nor stacks a second dialog on it.
const OWNS_KEYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"]';

/** Whether a key pressed here belongs to the widget it was pressed in, not to a shortcut. */
export function ownsKeys(target: EventTarget | null): boolean {
  const node = target as Element | null;
  return Boolean(node && typeof node.closest === 'function' && node.closest(OWNS_KEYS));
}

/** Single-key shortcuts are on unless the person turned them off (WCAG 2.1.4). ⌘K and Ctrl+K are not single keys. */
export const shortcutsOn = (prefs: { shortcuts?: boolean } | null | undefined) => prefs?.shortcuts !== false;

/**
 * Scrolls a strip that is wider than its box so this item sits in the middle of it. scrollIntoView would do the same,
 * but in Chromium it also moves where the next Tab starts, so the first Tab on a page skipped the skip link and
 * everything before the item; setting the strip's scrollLeft leaves that point alone.
 */
export function centerInStrip(item: Element | null | undefined, strip: Element | null | undefined = item?.parentElement) {
  if (!item || !strip || strip.scrollWidth <= strip.clientWidth) return;
  const at = item.getBoundingClientRect();
  const box = strip.getBoundingClientRect();
  strip.scrollLeft += at.left + at.width / 2 - (box.left + box.width / 2);
}

/**
 * Keeps the control that keyboard focus lands on clear of the sticky header, the phone's tab bar and an open tutorial
 * (WCAG 2.4.11).
 * Chromium scrolls a focused control just into view and does not apply scroll-padding to it, so a control at the edge
 * of the screen landed under the bar. A frame after focus moves, the page scrolls by what is still covered. Focus from
 * a pointer is left alone (nobody can tap through the bar), and so are controls that sit in the chrome themselves, in
 * a dialog, or fixed on top (the skip link). Returns the function that stops it.
 */
export function keepFocusClear(): () => void {
  let frame = 0;
  const GAP = 12;
  const check = () => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body || !el.matches(':focus-visible')) return;
    if (el.closest('header.sticky, nav.tabbar, aside, [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) return;
    for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return;
    const rect = el.getBoundingClientRect();
    if (!rect.height) return;
    const header = document.querySelector<HTMLElement>('header.sticky');
    const bar = document.querySelector<HTMLElement>('nav.tabbar');
    const top = header ? header.getBoundingClientRect().bottom + GAP : 0;
    let bottom = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().top - GAP : window.innerHeight;
    // An open tutorial sits at the foot of the screen (ADR-0034): a control in the columns it covers is kept above it.
    const tutorial = document.querySelector<HTMLElement>('[data-tutorial-panel]')?.getBoundingClientRect();
    if (tutorial?.height && tutorial.left < rect.right && tutorial.right > rect.left) bottom = Math.min(bottom, tutorial.top - GAP);
    // A control taller than the room between them shows its top.
    if (rect.top < top) window.scrollBy({ top: rect.top - top, behavior: 'instant' });
    else if (rect.bottom > bottom) window.scrollBy({ top: Math.min(rect.bottom - bottom, rect.top - top), behavior: 'instant' });
  };
  const moved = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(check); };
  document.addEventListener('focusin', moved);
  return () => { document.removeEventListener('focusin', moved); cancelAnimationFrame(frame); };
}

/**
 * Moves focus to an element once it is on the page: `focusWhenShown(id)` after a page of rows is fetched focuses the
 * first row it added, after React has drawn it, however long that takes. A frame alone could come before the row.
 */
export function useFocusWhenShown(): (id: string) => void {
  const [pending, setPending] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every render until the row is drawn, then stops
  useEffect(() => {
    if (!pending) return;
    const el = document.getElementById(pending);
    if (el) { el.focus(); setPending(null); }
  });
  return useCallback((id: string) => setPending(id), []);
}
