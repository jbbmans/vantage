export type ThemeMode = 'light' | 'dark' | 'system';

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The browser's own chrome (the address bar on a phone) takes the page's colour, whatever palette is on. */
function syncThemeColor() {
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  if (canvas) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `rgb(${canvas.split(/\s+/).join(', ')})`);
}

export function applyTheme(mode: ThemeMode) {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', resolved);
  syncThemeColor();
  try { localStorage.setItem('vantage.theme', mode); } catch {}
}

/** The palette for the whole app: page, cards, lines, text, navigation and the signal colour. */
export function applyAccent(accent: string) {
  document.documentElement.setAttribute('data-accent', accent);
  syncThemeColor();
  try { localStorage.setItem('vantage.accent', accent); } catch {}
}

export function applyDensity(density: string) {
  document.documentElement.setAttribute('data-density', density);
}

export function storedTheme(): ThemeMode {
  try { return (localStorage.getItem('vantage.theme') as ThemeMode) || 'light'; } catch { return 'light'; }
}
