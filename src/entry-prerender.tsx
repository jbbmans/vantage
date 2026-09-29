import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import PublicSite from '@/pages/PublicSite';

export { structuredData, sitemapVideos } from '@/lib/seo';
export { SITE } from '@/config/site';

/** The public page as HTML, rendered by the same tree src/public-main.tsx hydrates. */
export function renderPublicSite(url = '/'): string {
  return renderToString(
    <StaticRouter location={url}>
      <PublicSite />
    </StaticRouter>,
  );
}
