// Finishes dist/public.html after `vite build`: renders the public page into it, so the first response
// carries the whole page, adds the structured data, and writes the sitemap from the same sources.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SSR_OUT = join(ROOT, '.ssr-build');
const ORIGIN = (process.env.VANTAGE_PUBLIC_URL || process.env.VITE_PUBLIC_ORIGIN || 'https://vantageusmc.com').replace(/\/$/, '');

const page = join(DIST, 'public.html');
if (!existsSync(page)) {
  console.error('dist/public.html is missing. Run `vite build` before prerendering.');
  process.exit(1);
}

await build({
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  plugins: [react()],
  define: { 'import.meta.env.VITE_PUBLIC_ORIGIN': JSON.stringify(ORIGIN) },
  resolve: { alias: { '@': join(ROOT, 'src'), '@shared': join(ROOT, 'shared') } },
  build: {
    ssr: join(ROOT, 'src', 'entry-prerender.tsx'),
    outDir: SSR_OUT,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry-prerender.mjs' } },
  },
});

const { renderPublicSite, structuredData, sitemapVideos, SITE } = await import(pathToFileURL(join(SSR_OUT, 'entry-prerender.mjs')).href);
rmSync(SSR_OUT, { recursive: true, force: true });

const fill = (html, marker, content) => {
  if (!html.includes(marker)) { console.error(`Could not find ${marker} in dist/public.html.`); process.exit(1); }
  return html.replace(marker, () => content);
};
const markup = renderPublicSite('/');
// "<" is escaped so no text in the data can close the script element early.
const graph = JSON.stringify(structuredData(ORIGIN)).replace(/</g, '\\u003c');
let html = readFileSync(page, 'utf8');
html = fill(html, '<div id="root"></div>', `<div id="root">${markup}</div>`);
html = fill(html, '<!--structured-data-->', `<script type="application/ld+json">${graph}</script>`);
writeFileSync(page, html);

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const card = html.match(/property="og:image" content="([^"]+)"/)?.[1] || `${ORIGIN}/og.png`;
const videos = sitemapVideos(ORIGIN).map((v) => [
  '    <video:video>',
  `      <video:thumbnail_loc>${xml(v.thumbnail)}</video:thumbnail_loc>`,
  `      <video:title>${xml(v.title)}</video:title>`,
  `      <video:description>${xml(v.description)}</video:description>`,
  `      <video:content_loc>${xml(v.content)}</video:content_loc>`,
  v.seconds ? `      <video:duration>${v.seconds}</video:duration>` : null,
  v.published ? `      <video:publication_date>${xml(v.published)}</video:publication_date>` : null,
  '    </video:video>',
].filter(Boolean).join('\n'));
writeFileSync(join(DIST, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by scripts/prerender.mjs. Only canonical URLs belong here: /display and /about are the same page with a canonical pointing at /. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
  <url>
    <loc>${xml(`${ORIGIN}/`)}</loc>
    <lastmod>${xml(SITE.updated)}</lastmod>
    <image:image><image:loc>${xml(card)}</image:loc></image:image>
${videos.join('\n')}
  </url>
</urlset>
`);

const words = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length;
console.log(`dist/public.html  ${(Buffer.byteLength(markup) / 1024).toFixed(0)} KB of markup, ~${words} words in the first response; sitemap lists ${videos.length} films`);
