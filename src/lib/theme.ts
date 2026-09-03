export type ThemeMode = 'light' | 'dark' | 'system';

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode) {
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
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
