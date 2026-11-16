/**
 * What the keyboard shortcuts read from the page before acting on a key: whether it is someone typing, whether it is in
 * a widget that takes typed keys of its own, and whether the person has single-key shortcuts on at all.
 */

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
