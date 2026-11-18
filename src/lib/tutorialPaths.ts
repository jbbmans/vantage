import { pageFor } from '../config/nav.ts';

/**
 * The tab a page shows when its address names none: each page's own useParam fallback, which useParam also takes out of
 * the address once chosen. So "/settings" is Settings → Profile, and a step at "/settings?tab=profile" is on it.
 * tests/server/tutorials.test.ts checks these against the pages.
 */
export const DEFAULT_QUERY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  '/settings': { tab: 'profile' },
  '/reference': { tab: 'diagnose' },
  '/record/duty': { who: 'mine' },
  '/team/:id': { tab: 'personnel' },
};

/**
 * Whether the address in view is the page a tutorial names (ADR-0034). A pattern is an app path whose segments may be
 * parameters ("/team/:id", a Marine's page) and which may name a query ("/settings?tab=data", one tab of a page; a tab
 * missing from the address is the page's default, DEFAULT_QUERY). A parameter never stands for a page of the menu, so
 * "/team/:id" is not Personnel → Roster at "/team/roster". A trailing slash is ignored, as the router ignores it.
 */
export function onPage(pattern: string, pathname: string, search = ''): boolean {
  const [path, query] = pattern.split('?');
  const here = pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
  const want = path.split('/');
  const have = here.split('/');
  if (want.length !== have.length) return false;
  let param = false;
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) { if (!have[i]) return false; param = true; continue; }
    if (want[i] !== have[i]) return false;
  }
  if (param && pageFor(here)?.to === here) return false;
  if (!query) return true;
  const asked = new URLSearchParams(query);
  const given = new URLSearchParams(search);
  const fallback = DEFAULT_QUERY[path] ?? {};
  for (const [key, value] of asked) if ((given.get(key) ?? fallback[key] ?? null) !== value) return false;
  return true;
}

/** Whether a pattern holds a parameter: "Go to" cannot open it, and opens the page it is reached from instead. */
export const hasParam = (pattern: string) => pattern.split('?')[0].split('/').some((s) => s.startsWith(':'));
