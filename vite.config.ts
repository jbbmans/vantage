import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The public origin, written into everything that has to name it absolutely.
 *
 * These URLs cannot be relative: a canonical, an og:url and a sitemap entry are all meaningless
 * without a host. Hard-coding the reference deployment meant every self-hosted instance told
 * crawlers its public page really lived at vantageusmc.com — which asks Google to consolidate
 * somebody else's site into ours, and makes every shared link advertise the wrong host.
 *
 * Set VANTAGE_PUBLIC_URL (or VITE_PUBLIC_ORIGIN) at build time. The reference deployment is only
 * the default.
 */
const PUBLIC_ORIGIN = (process.env.VANTAGE_PUBLIC_URL || process.env.VITE_PUBLIC_ORIGIN || 'https://vantageusmc.com').replace(/\/$/, '');

/** Rewrites the origin into index.html and into the static files served beside it. */
function publicOrigin(): Plugin {
  const swap = (text: string) => text.replaceAll('https://vantageusmc.com', PUBLIC_ORIGIN);
  return {
    name: 'vantage-public-origin',
    transformIndexHtml: { order: 'pre', handler: swap },
    // robots/sitemap/llms live in publicDir, which Vite copies straight to the output without
    // routing through the bundle — so they have to be rewritten on disk after that copy happens.
    closeBundle() {
      const out = fileURLToPath(new URL('./dist', import.meta.url));
      for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
        const file = join(out, name);
        if (!existsSync(file)) continue;
        writeFileSync(file, swap(readFileSync(file, 'utf8')));
      }
    },
  };
}

/**
 * Stamps each build's identity into the service worker.
 *
 * The browser only notices a new service worker when sw.js's bytes change, and the update prompt
 * hangs off that. A version string somebody had to remember to bump meant most releases never
 * announced themselves. The identity is the hash of the built index.html, which names every hashed
 * asset — so any change to the client changes it, and an identical rebuild does not. The server
 * derives the same value from the same file and reports it from /api/health.
 */
function buildIdentity(): Plugin {
  return {
    name: 'vantage-build-identity',
    closeBundle() {
      const out = fileURLToPath(new URL('./dist', import.meta.url));
      const index = join(out, 'index.html');
      const sw = join(out, 'sw.js');
      if (!existsSync(index) || !existsSync(sw)) return;
      const id = createHash('sha256').update(readFileSync(index)).digest('hex').slice(0, 16);
      writeFileSync(sw, readFileSync(sw, 'utf8').replaceAll('__VANTAGE_BUILD__', id));
    },
  };
}

export default defineConfig({
  define: { 'import.meta.env.VITE_PUBLIC_ORIGIN': JSON.stringify(PUBLIC_ORIGIN) },
  plugins: [react(), publicOrigin(), buildIdentity()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    allowedHosts: ['terminal.local'],
    proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
          radix: ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', '@radix-ui/react-popover', '@radix-ui/react-select', '@radix-ui/react-tooltip'],
        },
      },
    },
  },
});
