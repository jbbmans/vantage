/**
 * Automated accessibility scan (v3.3 finding 42).
 *
 * axe-core over every signed-in route plus the login screen, failing on any
 * violation axe rates serious or critical: missing accessible names, broken
 * label associations, ARIA misuse, keyboard traps it can detect statically.
 * This is the floor, not the ceiling — contrast and full keyboard walks are
 * called out in the README as the remaining manual pass.
 *
 * Run with: node tests/browser-a11y.test.mjs   (after npm run build)
 */

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8800 + (process.pid % 90);
const DB = `/tmp/a11y-${process.pid}.db`;
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch { /* fresh */ } }

const srv = spawn('node', ['server/index.js'], { env: { ...process.env, VANTAGE_DB: DB, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 2000));
const BASE = `http://localhost:${PORT}`;

await fetch(`${BASE}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'boletz', password: 'a-long-enough-passphrase', first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', unit_code: 'MFR' }),
});

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const problems = [];
let checks = 0;
const scan = async (label) => {
  checks += 1;
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  if (bad.length === 0) {
    console.log(`  ok    ${label} — no serious/critical violations`);
  } else {
    for (const v of bad) {
      const where = v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ');
      problems.push(`${label}: [${v.impact}] ${v.id} — ${v.help} @ ${where}`);
      console.log(`  FAIL  ${label} — [${v.impact}] ${v.id} (${v.nodes.length}×) ${where}`);
    }
  }
};

// login screen first
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByText(/Set up this command|Sign in/).waitFor({ timeout: 6000 }).catch(() => {});
await scan('login/setup');

// sign in
await page.locator('input').first().fill('boletz');
await page.locator('input[type="password"]').fill('a-long-enough-passphrase');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);

for (const [path, label] of [
  ['/', 'command center'], ['/activities', 'activities'], ['/work', 'work'],
  ['/goals', 'goals'], ['/readiness', 'readiness'], ['/reports', 'reports'],
  ['/team', 'team'], ['/roles', 'roles'], ['/units', 'units'],
  ['/settings', 'settings'], ['/help', 'help'],
]) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await scan(label);
}

await browser.close();
srv.kill();
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch { /* gone */ } }

console.log(`\n${checks - new Set(problems.map((p) => p.split(':')[0])).size}/${checks} pages clean`);
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
process.exit(0);
