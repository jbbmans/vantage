import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// The public site's address: canonical links, the sitemap and the social card name it.
const PUBLIC_ORIGIN = (process.env.VANTAGE_SITE_URL || process.env.VANTAGE_PUBLIC_URL || process.env.VITE_PUBLIC_ORIGIN || 'https://www.vantageusmc.com').replace(/\/$/, '');
const ICON_FILES = ['favicon.ico', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'manifest.webmanifest', 'og.png'];

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
  const finish = (text: string) => text.replaceAll('https://www.vantageusmc.com', PUBLIC_ORIGIN).replaceAll('__ICONS__', icons);
  return {
    name: 'vantage-public-files',
    transformIndexHtml: { order: 'pre', handler: finish },
    closeBundle() {
      const out = fileURLToPath(new URL('./dist', import.meta.url));
      for (const name of ['robots.txt', 'llms.txt', 'manifest.webmanifest']) {
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
      // Four documents: the application, the public page (which loads only what it renders), the Unit Manager console (a
      // Unit Instance's Unit Managers) and the Vantage Administrator console (Vantage staff).
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        public: fileURLToPath(new URL('./public.html', import.meta.url)),
        console: fileURLToPath(new URL('./console.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
      output: {
        // The framework both documents share changes least, so it is cached on its own.
        manualChunks: { react: ['react', 'react-dom', 'react-dom/client', 'react-router-dom'] },
      },
    },
  },
});
