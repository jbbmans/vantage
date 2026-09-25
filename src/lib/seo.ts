/**
 * Everything a search engine and a link preview read, in one place.
 *
 * This exists because the tags were previously set from three directions — static markup in
 * index.html, an ad-hoc `setMeta` inside the landing page, and nothing at all on the routes in
 * between — which is how `/`, `/display` and `/about` ended up serving identical content under
 * three URLs with no canonical between them. Three URLs competing for the same query is not three
 * chances to rank; it is one ranking divided by three.
 *
 * The rules this enforces:
 *   - Exactly one canonical per page, and the duplicates all point at it.
 *   - Every signed-in route is `noindex`. The application is not content.
 *   - Structured data is emitted from the same strings the page renders, so the two cannot drift.
 *     A FAQ block whose schema disagrees with its visible text is a manual action waiting to happen.
 */

/** The public origin. Overridable so a staging host never claims the production canonical. */
export const SITE_ORIGIN = (import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined)?.replace(/\/$/, '')
  || 'https://vantageusmc.com';

const abs = (path: string) => `${SITE_ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;

function upsert<T extends HTMLElement>(selector: string, create: () => T): T {
  const found = document.head.querySelector<T>(selector);
  if (found) return found;
  const el = create();
  document.head.appendChild(el);
  return el;
}

function meta(nameOrProperty: string, content: string, asProperty = false) {
  const attr = asProperty ? 'property' : 'name';
  const el = upsert<HTMLMetaElement>(`meta[${attr}="${nameOrProperty}"]`, () => {
    const m = document.createElement('meta');
    m.setAttribute(attr, nameOrProperty);
    return m;
  });
  el.setAttribute('content', content);
}

function link(rel: string, href: string) {
  const el = upsert<HTMLLinkElement>(`link[rel="${rel}"]`, () => {
    const l = document.createElement('link');
    l.rel = rel;
    return l;
  });
  el.href = href;
}

/**
 * Structured data blocks this module owns. Keyed so a route can replace its own block without
 * disturbing the site-wide ones, and so navigating away removes what no longer applies — a stale
 * FAQPage left behind on a page with no FAQ on it is exactly the mismatch Google penalises.
 */
function jsonLd(key: string, data: unknown | null) {
  const id = `ld-${key}`;
  const existing = document.getElementById(id);
  if (!data) { existing?.remove(); return; }
  const el = existing instanceof HTMLScriptElement ? existing : document.createElement('script');
  el.id = id;
  el.type = 'application/ld+json';
  el.textContent = JSON.stringify(data);
  if (!el.isConnected) document.head.appendChild(el);
}

export interface PageSeo {
  title: string;
  description: string;
  /** Path this page should be indexed under. Duplicates pass the path of the page they defer to. */
  canonicalPath: string;
  indexable: boolean;
  image?: string;
  imageAlt?: string;
}

export function applySeo({ title, description, canonicalPath, indexable, image = '/og.png', imageAlt = 'Vantage — performance, productivity and readiness' }: PageSeo) {
  document.title = title;
  meta('description', description);
  meta('robots', indexable
    ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
    : 'noindex, nofollow');
  link('canonical', abs(canonicalPath));

  const imageUrl = image.startsWith('http') ? image : abs(image);
  meta('og:type', 'website', true);
  meta('og:site_name', 'Vantage', true);
  meta('og:title', title, true);
  meta('og:description', description, true);
  meta('og:url', abs(canonicalPath), true);
  meta('og:image', imageUrl, true);
  meta('og:image:alt', imageAlt, true);
  meta('og:image:width', '1200', true);
  meta('og:image:height', '630', true);
  meta('og:locale', 'en_US', true);
  meta('twitter:card', 'summary_large_image');
  meta('twitter:title', title);
  meta('twitter:description', description);
  meta('twitter:image', imageUrl);
  meta('twitter:image:alt', imageAlt);
}

/** Who publishes this, and what the thing is. Emitted once, on the public pages only. */
export function applyPublicStructuredData(faqs: ReadonlyArray<readonly [string, string]>, videos: ReadonlyArray<{ name: string; description: string; url: string; thumbnail?: string; uploadDate?: string }> = []) {
  jsonLd('org', {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_ORIGIN}/#organization`,
    name: 'VANTAGE',
    alternateName: 'VANTAGE USMC',
    url: SITE_ORIGIN,
    logo: abs('/icon-512.png'),
    description: 'An independent, self-hosted platform for performance records, work management, readiness and reporting. Not a Department of Defense or U.S. Marine Corps system of record.',
  });

  jsonLd('website', {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    name: 'VANTAGE',
    alternateName: 'VANTAGE USMC',
    publisher: { '@id': `${SITE_ORIGIN}/#organization` },
    url: SITE_ORIGIN,
  });

  jsonLd('software', {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Vantage',
    url: SITE_ORIGIN,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: 'A self-hosted platform for performance records, work management, readiness tracking, goals, correspondence, reporting and team visibility.',
    featureList: [
      'Performance and outcome records',
      'Work, task and project management',
      'Spreadsheet-driven work queues',
      'Readiness dates and requirements',
      'Goals with measurable progress',
      'Report drafting traced to source records',
      'Correspondence tracking',
      'Role-aware team visibility',
    ],
  });

  // Built from the same array the page renders, so the answer Google quotes is the answer on screen.
  jsonLd('faq', faqs.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(([question, answer]) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  } : null);

  // Only real, playable videos belong here. A VideoObject pointing at a placeholder is structured
  // data that lies, so the caller filters before it reaches this function.
  jsonLd('video', videos.length ? videos.map((v) => ({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: v.name,
    description: v.description,
    contentUrl: v.url.startsWith('http') ? v.url : abs(v.url),
    thumbnailUrl: v.thumbnail ? (v.thumbnail.startsWith('http') ? v.thumbnail : abs(v.thumbnail)) : abs('/og.png'),
    uploadDate: v.uploadDate || undefined,
  })) : null);
}

/** Drop the page-scoped blocks when leaving a public page for the application. */
export function clearPublicStructuredData() {
  for (const key of ['faq', 'video']) jsonLd(key, null);
}
