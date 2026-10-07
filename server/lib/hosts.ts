import type { Request, Response } from 'express';
import type { AppConfig } from '../config.ts';

/**
 * Vantage has four faces: the public site, the application, the owner console (an organization's owners) and the
 * admin dashboard (Vantage staff). A deployment serves them from one address, or gives each its own (www., app.,
 * console. and admin. under one domain, say). Every request is answered by what its host serves; a host the
 * deployment does not name is sent on to the one that does.
 */
export type Face = 'site' | 'app' | 'console' | 'admin';
const FACES: Face[] = ['site', 'app', 'console', 'admin'];
const ALL: ReadonlySet<Face> = new Set(FACES);

export interface HostPlan {
  /** True when the faces live on more than one host. */
  split: boolean;
  /** Where the console sits on its host: '' when no application or site shares the host, '/console' when one does. */
  consoleBase: string;
  /** Where the admin dashboard sits: '' when the host is its alone, '/admin' when it is shared. */
  adminBase: string;
  /** The faces a request's host serves, or null for a host this deployment does not answer to. */
  facesFor: (req: Request) => ReadonlySet<Face> | null;
  url: (face: Face, path?: string) => string;
  /** What the client needs to link from one face to another, for a meta tag in each HTML document. */
  links: { site: string; app: string; console: string; admin: string; split: boolean; publicSite: boolean };
}

export function hostPlan(config: AppConfig): HostPlan {
  const hostOf = (url: string) => new URL(url).host.toLowerCase();
  const byHost = new Map<string, Set<Face>>();
  for (const face of FACES) {
    const host = hostOf(config.urls[face]);
    byHost.set(host, (byHost.get(host) ?? new Set<Face>()).add(face));
  }
  const split = byHost.size > 1;
  // The bare domain of a www site is the site too. Redirecting it to www here could loop against a host (Render
  // does this) that redirects www to the bare domain; serving it can't, and its canonical link names www.
  const siteHost = hostOf(config.urls.site);
  const bare = siteHost.startsWith('www.') ? siteHost.slice(4) : '';
  if (split && bare && !byHost.has(bare)) byHost.set(bare, new Set<Face>(['site']));
  // The console may share its host with the admin dashboard (at /admin) and still own the root; never with the application.
  const consoleHost = byHost.get(hostOf(config.urls.console))!;
  const consoleBase = [...consoleHost].every((f) => f === 'console' || f === 'admin') ? '' : '/console';
  const adminBase = byHost.get(hostOf(config.urls.admin))!.size === 1 ? '' : '/admin';
  const url = (face: Face, path = '') => `${config.urls[face]}${path}`;
  return {
    split,
    consoleBase,
    adminBase,
    // One address answers to whatever name reaches it (localhost, an IP, a tunnel); only a split deployment is strict.
    facesFor: (req) => (split ? byHost.get(String(req.host || '').toLowerCase()) ?? null : ALL),
    url,
    links: {
      site: split && !byHost.get(hostOf(config.urls.app))!.has('site') ? config.urls.site : '',
      app: split ? config.urls.app : '',
      console: split ? url('console', consoleBase) : '/console',
      admin: split ? url('admin', adminBase) : '/admin',
      split,
      publicSite: config.deployment.publicSite,
    },
  };
}

export const facesOf = (res: Response): ReadonlySet<Face> => res.locals.faces ?? ALL;

/** The client reads where the other faces live from this tag; the server writes it into each document it serves. */
export function linksMeta(links: HostPlan['links']): string {
  return `<meta name="vantage-links" content="${JSON.stringify(links).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" />`;
}
