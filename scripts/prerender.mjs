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

await build({
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

writeFileSync(join(DIST, 'public.html'), html.replace(anchor, `<div id="root">${markup}</div>`));
rmSync(SSR_OUT, { recursive: true, force: true });

const bytes = Buffer.byteLength(markup);
const words = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length;
console.log(`dist/public.html  ${(bytes / 1024).toFixed(0)} KB of markup, ~${words} words in the first response`);
