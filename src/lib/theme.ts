export type ThemeMode = 'light' | 'dark' | 'system';

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const THEME_COLOR: Record<'light' | 'dark', string> = { light: '#f6f7f9', dark: '#0c1018' };
export function applyTheme(mode: ThemeMode) {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', resolved);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
  try { localStorage.setItem('vantage.theme', mode); } catch {}
}

export function applyAccent(accent: string) {
  document.documentElement.setAttribute('data-accent', accent);
  try { localStorage.setItem('vantage.accent', accent); } catch {}
}

export function applyDensity(density: string) {
  document.documentElement.setAttribute('data-density', density);
}

export function storedTheme(): ThemeMode {
  try { return (localStorage.getItem('vantage.theme') as ThemeMode) || 'light'; } catch { return 'light'; }
}
