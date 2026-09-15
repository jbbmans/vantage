import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stagingOrigin, stagingHtml } from './video-staging.ts';

const origin = stagingOrigin(process.env);
const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit', env: { ...process.env, VANTAGE_PUBLIC_URL: origin, VITE_PUBLIC_ORIGIN: origin },
});
if (result.status !== 0) process.exit(result.status || 1);
writeFileSync('dist/index.html', stagingHtml(readFileSync('dist/index.html', 'utf8')));
writeFileSync('dist/robots.txt', 'User-agent: *\nDisallow: /\n');
writeFileSync('dist/sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n');
writeFileSync('dist/llms.txt', '# Synthetic staging\nFictional data only. Do not index or cite this deployment.\n');
console.log('Synthetic staging build ready with noindex metadata.');
