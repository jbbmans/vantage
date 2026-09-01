import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8800 + (process.pid % 90);
const DB = `/tmp/a11y-${process.pid}.db`;
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch {  } }

const srv = spawn('node', ['server/index.js'], { env: { ...process.env, VANTAGE_DB: DB, PORT: String(PORT), VANTAGE_MARADMIN_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.getByText(/Set up this command|Sign in/).waitFor({ timeout: 6000 }).catch(() => {});
await scan('login/setup');

await page.locator('input').first().fill('boletz');
await page.locator('input[type="password"]').fill('a-long-enough-passphrase');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);

for (const [path, label] of [
  ['/', 'command center'], ['/activities', 'activities'], ['/work', 'work'],
  ['/goals', 'goals'], ['/career', 'career'], ['/readiness', 'readiness'], ['/maradmins', 'MARADMINs'], ['/reports', 'reports'],
  ['/team', 'team'], ['/units', 'units'],
  ['/settings', 'settings'], ['/operator', 'owner console'], ['/help', 'help'],
]) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await scan(label);
}

await browser.close();
srv.kill();
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch {  } }

console.log(`\n${checks - new Set(problems.map((p) => p.split(':')[0])).size}/${checks} pages clean`);
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
process.exit(0);
