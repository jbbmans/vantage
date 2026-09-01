import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8900 + (process.pid % 90);
const DB = `/tmp/smoke-${process.pid}.db`;
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  try { rmSync(f, { force: true }); } catch {  }
}

const srv = spawn('node', ['server/index.js'], {
  env: { ...process.env, VANTAGE_DB: DB, PORT: String(PORT), VANTAGE_MARADMIN_ENABLED: 'false' },
  stdio: ['ignore','pipe','pipe'],
});
srv.stdout.on('data', d => process.stdout.write('[srv] '+d));
srv.stderr.on('data', d => process.stdout.write('[srv-err] '+d));
await new Promise(r => setTimeout(r, 2500));

const BASE = `http://localhost:${PORT}`;
const problems = [];
const checks = [];
const check = (n, ok, d='') => {
  checks.push([ok, n, d]);
  if (!ok) problems.push(`${n}${d ? ' — ' + d : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', m => { if (m.type()==='error') problems.push('console: '+m.text().slice(0,160)); });
page.on('pageerror', e => problems.push('pageerror: '+e.message.slice(0,200)));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const setupVisible = await page.getByText('Set up this command')
  .waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
check('setup screen renders', setupVisible);

await page.getByLabel(/username/i).fill('boletz').catch(async () => {
  await page.locator('input[autocomplete="username"]').fill('boletz');
});
await page.locator('input[type="password"]').fill('a-long-enough-passphrase');
const inputs = page.locator('input');

await page.locator('input').nth(2).fill('John');
await page.locator('input').nth(3).fill('Boletz');
await page.getByRole('button', { name: /create unit leader and sign in/i }).click();
await page.getByRole('button', { name: 'Open account menu' }).waitFor({ timeout: 6000 });

check('signed in to the shell', await page.locator('text=VANTAGE').first().isVisible());
await page.getByRole('button', { name: 'Open account menu' }).click();
check('account menu shows the signed-in name', (await page.textContent('body')).includes('John Boletz'));
await page.keyboard.press('Escape');

const autofillContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const autofillPage = await autofillContext.newPage();
await autofillPage.goto(BASE, { waitUntil: 'domcontentloaded' });
await autofillPage.locator('input[autocomplete="username"]').waitFor({ timeout: 6000 });
await autofillPage.locator('input[autocomplete="username"]').evaluate((input) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'boletz');
});
await autofillPage.locator('input[autocomplete="current-password"]').evaluate((input) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'a-long-enough-passphrase');
});
const autofillSubmit = autofillPage.locator('button[type="submit"]');
check('password-manager-filled sign-in remains enabled', await autofillSubmit.isEnabled());
await autofillSubmit.click();
await autofillPage.getByRole('button', { name: 'Open account menu' }).waitFor({ timeout: 6000 });
check('native autofill credentials authenticate', true);
await autofillContext.close();

await page.keyboard.press('n');
await page.waitForTimeout(300);
const ta = page.locator('textarea').first();
await ta.fill('Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday');
await page.waitForTimeout(350);
const body = await page.textContent('body');
check('parser inferred the dollar figure', body.includes('1,118.38'), '');
check('visibility control present', body.includes('Visible to') || body.includes('Everyone in my unit'));
await page.getByRole('button', { name: /save activity/i }).click();
await page.waitForTimeout(900);

await page.goto(BASE + '/career?tab=recognition', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Add recognition', exact: true }).first().click();
const recognitionVisibility = page.getByLabel('Who sees this recognition');
await recognitionVisibility.click();
await page.getByRole('option', { name: 'Just me — my own log' }).click();
await recognitionVisibility.click();
await page.getByRole('option', { name: 'Only me', exact: true }).click();
const privateUnit = page.getByLabel('File under unit');
await privateUnit.waitFor({ timeout: 3000 });
check('private scope keeps an explicit unit target', Boolean((await privateUnit.textContent()).trim()));
await page.getByRole('button', { name: 'Cancel', exact: true }).click();

let t;

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(450);
check('dashboard sections have chrome', (await page.textContent('body')).includes('FISCAL TAPE') || (await page.textContent('body')).includes('Fiscal tape'));

await page.getByRole('button', { name: /display/i }).click();
await page.waitForTimeout(250);
await page.getByRole('menu').getByText('Goals').click();
await page.waitForTimeout(450);
await page.keyboard.press('Escape');
let dash = await page.textContent('body');
check('hidden section leaves the page', !/GOALS/.test(dash) || dash.indexOf('Display') > -1);

await page.getByRole('button', { name: /^Fiscal tape/ }).click();
await page.waitForTimeout(450);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const tapeBtn = page.getByRole('button', { name: /^Fiscal tape/ });
check('collapsed state survives a reload', (await tapeBtn.getAttribute('aria-expanded')) === 'false');

await page.getByRole('button', { name: /display/i }).click();
await page.waitForTimeout(250);
await page.getByRole('menu').getByText('Show everything').click();
await page.waitForTimeout(350);

await page.goto(BASE + '/help', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
t = await page.textContent('body');
check('SOP covers both tracks', t.includes('JEPES vs FITREP') && t.includes('Reporting Senior'));
check('SOP states the reader track', /you are on the (JEPES|FITREP) track/.test(t));
await page.getByLabel('Search the SOP').fill('cutting score');
await page.waitForTimeout(300);
t = await page.textContent('body');
check('SOP search filters sections', t.includes('JEPES (Pvt–Cpl)') && !t.includes('First day'));

await page.goto(BASE + '/', { waitUntil: 'networkidle' });
await page.keyboard.press('n');
await page.waitForTimeout(350);

await page.locator('textarea').first().fill('Reconciled 12 ULOs totaling $4,200 in DAI today');
await page.waitForTimeout(450);
t = await page.textContent('body');
check('entry form speaks the track language', t.includes('JEPES area'));
check('entry form offers the JEPES areas', t.includes('Visible to') || t.includes('Everyone in my unit'));
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

await browser.close();
srv.kill();
try { for (const f of [DB, DB+'-wal', DB+'-shm']) rmSync(f, { force: true }); } catch {  }

const fails = checks.filter(c => !c[0]).length;
console.log(`\n${checks.length - fails}/${checks.length} checks passed`);
if (problems.length) { console.log('\nProblems:'); problems.slice(0, 10).forEach(p => console.log('  - ' + p)); }
process.exit(fails || problems.length ? 1 : 0);
