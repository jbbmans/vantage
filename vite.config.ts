import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PUBLIC_ORIGIN = (process.env.VANTAGE_PUBLIC_URL || process.env.VITE_PUBLIC_ORIGIN || 'https://vantageusmc.com').replace(/\/$/, '');

function publicOrigin(): Plugin {
  const swap = (text: string) => text.replaceAll('https://vantageusmc.com', PUBLIC_ORIGIN);
  return {
    name: 'vantage-public-origin',
    transformIndexHtml: { order: 'pre', handler: swap },
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
