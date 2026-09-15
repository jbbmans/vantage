/**
 * Writes dist/public.html: index.html with the public page's markup already inside #root.
 *
 * Runs after `vite build`, so it picks up whatever asset hashes this build produced. That is the
 * reason it cannot be a committed artifact: a prerendered file checked into the repository would
 * reference the script tags of whichever build happened to make it, and would break silently on
 * the next one.
 *
 * The server hands this file to requests that carry no session cookie and falls back to the plain
 * shell when it is absent — so a build that skips this step degrades to the old behaviour rather
 * than serving a broken page.
 */

import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const SSR_OUT = join(ROOT, '.ssr-build');

const shell = join(DIST, 'index.html');
if (!existsSync(shell)) {
  console.error('dist/index.html is missing. Run `vite build` before prerendering.');
  process.exit(1);
}

// Bundle the entry for Node. Vite resolves the @ alias, compiles the JSX and pulls in the shared
// modules, none of which plain `node` can do with a .tsx file.
await build({
  // configFile: false rather than inheriting vite.config.ts. That config splits the client bundle
  // into react/radix manual chunks, which are externals in an SSR build, and rollup refuses to put
  // an external in a manual chunk. This build needs the React plugin and the path aliases and
  // nothing else, so it asks for exactly those.
  configFile: false,
  root: ROOT,
  logLevel: 'error',
  plugins: [react()],
  resolve: {
    alias: {
      '@': join(ROOT, 'src'),
      '@shared': join(ROOT, 'shared'),
    },
  },
  build: {
    ssr: join(ROOT, 'src', 'entry-prerender.tsx'),
    outDir: SSR_OUT,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'entry-prerender.mjs' } },
  },
});

const { renderPublicSite } = await import(pathToFileURL(join(SSR_OUT, 'entry-prerender.mjs')).href);
const markup = renderPublicSite('/');

const html = readFileSync(shell, 'utf8');
const anchor = '<div id="root"></div>';
if (!html.includes(anchor)) {
  console.error(`Could not find ${anchor} in dist/index.html; prerender skipped.`);
  process.exit(1);
}

/*
 * The markup goes inside #root rather than beside it. React's createRoot replaces the container's
 * children on its first render, so the static copy is swapped for the live one with no leftover
 * duplicate and nothing to clean up — and because the two render the same component from the same
 * data, the swap is not visible.
 */
writeFileSync(join(DIST, 'public.html'), html.replace(anchor, `<div id="root">${markup}</div>`));
rmSync(SSR_OUT, { recursive: true, force: true });

const bytes = Buffer.byteLength(markup);
const words = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length;
console.log(`dist/public.html  ${(bytes / 1024).toFixed(0)} KB of markup, ~${words} words in the first response`);
