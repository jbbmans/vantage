import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 9050 + (process.pid % 80);
const DB = `/tmp/browser-incidents-${process.pid}.db`;
for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
  try { rmSync(file, { force: true }); } catch {}
}

const server = spawn('node', ['server/index.js'], {
  env: {
    ...process.env,
    VANTAGE_DB: DB,
    PORT: String(PORT),
    VANTAGE_OPERATOR: 'operator',
    VANTAGE_MARADMIN_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve) => setTimeout(resolve, 2000));
const BASE = `http://localhost:${PORT}`;

try {
  const setup = await fetch(`${BASE}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'operator', password: 'operator-long-enough-passphrase-927',
      first_name: 'Ops', last_name: 'Operator', rank_id: 'Cpl', unit_code: 'MFR',
    }),
  });
  if (!setup.ok) throw new Error(`setup failed: ${setup.status} ${await setup.text()}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 375, height: 780 } });
  const page = await context.newPage();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.locator('input').first().fill('operator');
  await page.locator('input[type="password"]').fill('operator-long-enough-passphrase-927');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);

  await page.goto(`${BASE}/settings#security-reports`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /report concern/i }).waitFor();
  await page.getByRole('button', { name: /report concern/i }).click();
  await page.getByLabel('Title').fill('Browser disclosure case');
  await page.getByLabel('Description and reproduction details').fill(
    'A synthetic browser case used to verify the confidential reporting workflow.'
  );
  const dialogOverflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    document.body.scrollWidth - document.documentElement.clientWidth
  ));
  if (dialogOverflow > 1) throw new Error(`security-report dialog overflows by ${dialogOverflow}px`);
  await page.getByRole('button', { name: /submit confidential report/i }).click();
  await page.getByText('Browser disclosure case').waitFor({ timeout: 6000 });

  await page.goto(`${BASE}/operator#security-incidents`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser disclosure case').waitFor({ timeout: 6000 });
  await page.locator('#security-incidents').getByRole('button', { name: 'Manage' }).click();
  await page.getByLabel('Case status').click();
  await page.getByRole('option', { name: 'Acknowledged' }).click();
  await page.getByLabel('Update or note').fill('Synthetic case acknowledged by the Instance Operator.');
  await page.getByRole('button', { name: /save case update/i }).click();
  await page.getByText('Synthetic case acknowledged by the Instance Operator.').waitFor({ timeout: 6000 });
  await page.getByRole('button', { name: 'Close' }).click();

  await page.goto(`${BASE}/settings#security-reports`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Browser disclosure case').waitFor({ timeout: 6000 });
  await page.getByRole('button', { name: 'View case' }).click();
  await page.getByText('Synthetic case acknowledged by the Instance Operator.').waitFor({ timeout: 6000 });

  console.log('  ok    confidential incident workflow renders and completes at 375px');
  await browser.close();
} finally {
  server.kill();
  for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { rmSync(file, { force: true }); } catch {}
  }
}
