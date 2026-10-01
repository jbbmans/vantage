/** Where the other faces of Vantage live, as the server wrote them into this document (server/lib/hosts.ts). */
export interface Links { site: string; app: string; console: string; split: boolean }

const ONE_HOST: Links = { site: '', app: '', console: '/console', split: false };

export const LINKS: Links = (() => {
  if (typeof document === 'undefined') return ONE_HOST;
  try {
    const raw = document.querySelector<HTMLMetaElement>('meta[name="vantage-links"]')?.content;
    return raw ? { ...ONE_HOST, ...(JSON.parse(raw) as Partial<Links>) } : ONE_HOST;
  } catch { return ONE_HOST; }
})();

/** A path on the public site, the application or the owner console: absolute when it lives on another host. */
export const siteHref = (path = '/') => `${LINKS.site}${path}`;
export const appHref = (path = '/') => `${LINKS.app}${path}`;
export const consoleHref = (path = '/') => `${LINKS.console}${path}`;
