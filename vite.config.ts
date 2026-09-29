import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PUBLIC_ORIGIN = (process.env.VANTAGE_PUBLIC_URL || process.env.VITE_PUBLIC_ORIGIN || 'https://vantageusmc.com').replace(/\/$/, '');
const ICON_FILES = ['favicon.ico', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'manifest.webmanifest'];

/** Content hash of the icon set, so a changed icon is a changed URL and no browser keeps showing the old one. */
function iconVersion(): string {
  const hash = createHash('sha256');
  for (const name of ICON_FILES) hash.update(readFileSync(fileURLToPath(new URL(`./public/${name}`, import.meta.url))));
  return hash.digest('hex').slice(0, 10);
}

/**
 * Finishes the files served as-is: points them at this deployment's origin, stamps the icon version into
 * the page and the manifest, and stamps the build identity into the service worker, whose changed bytes
 * are what make an open copy of the app offer the new release. Nobody has to remember to bump either.
 */
function publicFiles(): Plugin {
  const icons = iconVersion();
  const finish = (text: string) => text.replaceAll('https://vantageusmc.com', PUBLIC_ORIGIN).replaceAll('__ICONS__', icons);
  return {
    name: 'vantage-public-files',
    transformIndexHtml: { order: 'pre', handler: finish },
    closeBundle() {
      const out = fileURLToPath(new URL('./dist', import.meta.url));
      for (const name of ['robots.txt', 'sitemap.xml', 'llms.txt', 'manifest.webmanifest']) {
        const file = join(out, name);
        if (existsSync(file)) writeFileSync(file, finish(readFileSync(file, 'utf8')));
      }
      const index = join(out, 'index.html');
      const sw = join(out, 'sw.js');
      if (!existsSync(index) || !existsSync(sw)) return;
      const build = createHash('sha256').update(readFileSync(index)).digest('hex').slice(0, 16);
      writeFileSync(sw, readFileSync(sw, 'utf8').replaceAll('__VANTAGE_BUILD__', build).replaceAll('__ICONS__', icons));
    },
  };
}

export default defineConfig({
  define: { 'import.meta.env.VITE_PUBLIC_ORIGIN': JSON.stringify(PUBLIC_ORIGIN) },
  plugins: [react(), publicFiles()],
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
