import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import PublicSite from '@/pages/PublicSite';

export function renderPublicSite(url = '/'): string {
  return renderToStaticMarkup(
    <StaticRouter location={url}>
      <PublicSite />
    </StaticRouter>,
  );
}
