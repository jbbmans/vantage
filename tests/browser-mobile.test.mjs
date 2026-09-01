import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8700 + (process.pid % 90);
const DB = `/tmp/mobile-${process.pid}.db`;
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch {  } }

const srv = spawn('node', ['server/index.js'], { env: { ...process.env, VANTAGE_DB: DB, PORT: String(PORT), VANTAGE_MARADMIN_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => setTimeout(r, 2000));
const BASE = `http://localhost:${PORT}`;

await fetch(`${BASE}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'boletz', password: 'a-long-enough-passphrase', first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', unit_code: 'MFR' }),
});

const problems = [];
const checks = [];
const check = (n, ok, d = '') => {
  checks.push(ok);
  if (!ok) problems.push(`${n}${d ? ' — ' + d : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}${ok || !d ? '' : ' — ' + d}`);
};

const browser = await chromium.launch();

const ROUTES = ['/', '/activities', '/work', '/goals', '/career', '/readiness', '/maradmins', '/reports', '/team', '/units', '/settings', '/operator', '/help'];

for (const width of [375, 768]) {
  const context = await browser.newContext({ viewport: { width, height: 780 } });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.locator('input').first().fill('boletz');
  await page.locator('input[type="password"]').fill('a-long-enough-passphrase');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1400);

  for (const path of ROUTES) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(650);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return Math.max(doc.scrollWidth - doc.clientWidth, document.body.scrollWidth - doc.clientWidth);
    });
    check(`${width}px ${path} fits the viewport`, overflow <= 1, `overflows by ${overflow}px`);
  }

  if (width === 375) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(650);
    const opened = await page.getByRole('button', { name: 'Open menu' }).click()
      .then(() => true).catch((e) => { problems.push('menu click: ' + e.message.slice(0, 80)); return false; });
    await page.waitForTimeout(450);
    const navLink = page.getByRole('link', { name: /Readiness/ }).first();
    const linkVisible = opened && await navLink.isVisible().catch(() => false);
    check('375px drawer opens with navigation', linkVisible);
    if (linkVisible) {
      await navLink.click();
      await page.waitForTimeout(800);
      check('375px drawer navigates', page.url().includes('/readiness'));
    }

    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(650);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    check('375px notification center opens', await page.getByText('Notifications', { exact: true }).isVisible());
    const notificationOverflow = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.documentElement.clientWidth
    ));
    check('375px notification center fits', notificationOverflow <= 1, `overflows by ${notificationOverflow}px`);
    await page.keyboard.press('Escape');

    await page.keyboard.press('Control+k');
    check('375px command menu opens', await page.getByText('Quick actions', { exact: true }).isVisible());
    await page.getByRole('button', { name: /Request a rank update/ }).click();
    await page.waitForTimeout(700);
    check('quick command opens rank settings', page.url().includes('/settings#rank'));

    await page.getByRole('button', { name: /Request update/ }).click();
    const rankDialog = page.getByRole('dialog');
    const dialogBox = await rankDialog.boundingBox();
    check('375px rank request dialog fits', Boolean(dialogBox && dialogBox.x >= 0 && dialogBox.width <= 375 && dialogBox.height <= 780));
    await page.keyboard.press('Escape');
  }

  await context.close();
}

await browser.close();
srv.kill();
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f, { force: true }); } catch {  } }

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
process.exit(0);
