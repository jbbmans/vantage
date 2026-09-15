import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import PublicSite from '@/pages/PublicSite';

/**
 * Renders the public page to static HTML at build time.
 *
 * Why this exists: Vantage is a client-rendered application, so an empty `<div id="root">` is
 * everything a request returns. Google will usually execute the JavaScript and find the page
 * eventually, but "usually" and "eventually" are doing real work in that sentence — and the other
 * crawlers that matter (Bing, and the ones feeding AI answers) are markedly worse at it. Shipping
 * the words in the first response removes the question entirely.
 *
 * Deliberately `react-dom/server` rather than a headless browser. A browser-based prerender only
 * runs where a browser is installed, which is not the deploy host — so the one environment that
 * actually serves the page would be the one environment that never got the benefit. This runs
 * anywhere Node runs.
 *
 * Effects do not run during this render, which is exactly right: `applySeo` and the scroll-reveal
 * observer both live in `useEffect`, so the static output is the page's resting state with the
 * static `<head>` from index.html around it.
 */
export function renderPublicSite(url = '/'): string {
  return renderToStaticMarkup(
    <StaticRouter location={url}>
      <PublicSite />
    </StaticRouter>,
  );
}
