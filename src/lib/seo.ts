import { FAQS, SITE } from '@/config/site';
import { publishedVideos } from '@/config/videos';
import films from '@/config/films.generated.json';

const FEATURES = [
  'Performance and outcome records',
  'Work, task and project management',
  'Spreadsheet-driven work queues',
  'Readiness dates and requirements',
  'Goals with measurable progress',
  'JEPES and FITREP input traced to source records',
  'Correspondence tracking',
  'Role-aware team visibility',
];

/** ISO 8601, which is how video results read a running time. */
const duration = (seconds: number) => `PT${Math.floor(seconds / 60)}M${seconds % 60}S`;

/**
 * The public page's structured data as one linked graph, written into the prerendered HTML at build time
 * so every crawler reads it without running JavaScript.
 */
export function structuredData(origin: string) {
  const url = `${origin}/`;
  const abs = (path: string) => (/^https?:/.test(path) ? path : `${origin}${path}`);
  const organization = { '@id': `${origin}/#organization` };
  const card = { '@type': 'ImageObject', url: abs('/og.png'), width: 1200, height: 630 };
  const seconds = films as Record<string, { seconds: number }>;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization', ...organization, name: 'VANTAGE', alternateName: SITE.alternateName, url,
        logo: { '@type': 'ImageObject', url: abs('/icon-512.png'), width: 512, height: 512 },
        description: SITE.disclaimer,
      },
      {
        '@type': 'WebSite', '@id': `${origin}/#website`, url, name: SITE.name, alternateName: SITE.alternateName,
        description: SITE.description, publisher: organization, inLanguage: 'en-US',
      },
      {
        // FAQPage is a kind of WebPage, so the page and its questions are one node.
        '@type': 'FAQPage', '@id': `${origin}/#webpage`, url, name: SITE.title, description: SITE.description,
        isPartOf: { '@id': `${origin}/#website` }, about: { '@id': `${origin}/#software` },
        primaryImageOfPage: card, dateModified: SITE.updated, inLanguage: 'en-US',
        mainEntity: FAQS.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
      },
      {
        '@type': 'SoftwareApplication', '@id': `${origin}/#software`, name: SITE.name, url,
        applicationCategory: 'BusinessApplication', operatingSystem: 'Web', description: SITE.description,
        featureList: FEATURES, image: card, publisher: organization,
      },
      ...publishedVideos().map((v) => ({
        '@type': 'VideoObject', '@id': `${origin}/#video-${v.id}`, name: v.title, description: v.description,
        thumbnailUrl: abs(v.poster || '/og.png'), contentUrl: abs(v.src),
        // Noon UTC is the same calendar day from Hawaii to Japan.
        ...(v.published ? { uploadDate: `${v.published}T12:00:00Z` } : {}),
        ...(seconds[v.id] ? { duration: duration(seconds[v.id].seconds) } : {}),
        publisher: organization, inLanguage: 'en-US',
      })),
    ],
  };
}

/** Video entries for the sitemap, so video search finds the films as well as the page. */
export function sitemapVideos(origin: string) {
  const abs = (path: string) => (/^https?:/.test(path) ? path : `${origin}${path}`);
  const seconds = films as Record<string, { seconds: number }>;
  return publishedVideos().map((v) => ({
    title: v.title, description: v.description, thumbnail: abs(v.poster || '/og.png'), content: abs(v.src),
    seconds: seconds[v.id]?.seconds ?? null, published: v.published ?? null,
  }));
}
