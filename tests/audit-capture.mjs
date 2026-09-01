import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const PORT = 8877;
const DB = '/tmp/vantage-wcag-audit.db';
const OUT = 'audit-evidence';
mkdirSync(OUT, { recursive: true });
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch {} }
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT: String(PORT), VANTAGE_DB: DB, VANTAGE_TEST: '1', VANTAGE_OPERATOR: 'audit.owner', VANTAGE_MARADMIN_ENABLED: 'false' }, stdio: 'inherit' });
await new Promise(r => setTimeout(r, 2200));
const base = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const evidence = [];
async function capture(step, name) {
  await page.waitForTimeout(500);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();
  const file = `${OUT}/${String(step).padStart(2,'0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  evidence.push({ step, name, url: page.url(), screenshot: file, violations: result.violations.map(v => ({ id:v.id, impact:v.impact, help:v.help, helpUrl:v.helpUrl, nodes:v.nodes.map(n => ({ target:n.target, failureSummary:n.failureSummary })) })) });
}
await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.getByText('Set up this command').waitFor({ timeout: 8000 });
await capture(1, 'setup');
await page.getByLabel(/username/i).fill('audit.owner');
await page.locator('input[type=password]').fill('synthetic-audit-passphrase');
await page.locator('input').nth(2).fill('Avery');
await page.locator('input').nth(3).fill('Auditor');
await page.getByRole('button', { name: /create unit leader/i }).click();
await page.getByRole('button', { name: 'Open account menu' }).waitFor({ timeout: 8000 });
await capture(2, 'command-center');
await page.keyboard.press('n');
await page.getByRole('dialog').waitFor();
await capture(3, 'quick-log');
await page.keyboard.press('Escape');
await page.goto(base + '/reports', { waitUntil: 'networkidle' });
await capture(4, 'report-studio');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(base + '/', { waitUntil: 'networkidle' });
await capture(5, 'command-center-mobile');
const focus = [];
await page.keyboard.press('Tab');
for (let i=0;i<12;i+=1) {
  focus.push(await page.evaluate(() => ({ tag: document.activeElement?.tagName, text: (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim().slice(0,80) })));
  await page.keyboard.press('Tab');
}
writeFileSync(`${OUT}/wcag-results.json`, JSON.stringify({ generatedAt:new Date().toISOString(), standard:'WCAG 2.2 AA automated subset', evidence, focusOrder:focus }, null, 2));
await browser.close();
srv.kill();
