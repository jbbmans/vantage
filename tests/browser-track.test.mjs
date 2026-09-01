import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8900 + (process.pid % 90);
const DB = `/tmp/track-${process.pid}.db`;
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  try { rmSync(f, { force: true }); } catch {  }
}

const srv = spawn('node', ['tests/browser-server.mjs'], {
  env: {
    ...process.env,
    VANTAGE_DB: DB,
    PORT: String(PORT),



    VANTAGE_OPERATOR: 'cpl',
    VANTAGE_MARADMIN_ENABLED: 'false',


    VANTAGE_TEST: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => process.stdout.write('[srv-err] ' + d));
await new Promise((r) => setTimeout(r, 1500));

const BASE = `http://localhost:${PORT}`;
const problems = [];
const checks = [];
const check = (n, ok, d = '') => {
  checks.push([ok, n, d]);
  if (!ok) problems.push(`${n}${d ? ' — ' + d : ''}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${n}`);
};

const api = async (method, path, body, token) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${payload?.error || text || 'no response body'}`);
  return payload;
};

await api('POST', '/api/setup', {
  username: 'cpl', password: 'a-long-enough-passphrase', first_name: 'John', last_name: 'Boletz',
  rank_id: 'Cpl', mos: '3451', unit_code: 'MFR', billet_title: 'Accounting Chief',
});
const cplToken = (await api('POST', '/api/login', { username: 'cpl', password: 'a-long-enough-passphrase' })).token;
await api('POST', '/api/team', {
  username: 'sgt', password: 'sergeant-long-enough-pass', first_name: 'Dale', last_name: 'Kramer',
  rank_id: 'Sgt', mos: '3451', unit_id: 'MFR', billet_id: 'budget-chief', role_id: 'MFR:nco',
}, cplToken);
const sgtToken = (await api('POST', '/api/login', { username: 'sgt', password: 'sergeant-long-enough-pass' })).token;
for (const [title, area] of [
  ['Mentored two analysts through certification', 'Leadership'],
  ['Closed the fiscal year across the section', 'MOS / Mission Accomplishment'],
]) {
  await api('POST', '/api/activities', {
    title, date: '2026-08-01', jepes_area: area, quantity: 2, unit_label: 'Marines',
    result: 'completed ahead of schedule', visibility: 'unit',
  }, sgtToken);
}

const browser = await chromium.launch();
process.on('exit', () => { try { srv.kill(); } catch {  } });

const signIn = async (user, pass) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message.slice(0, 140)));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  await page.locator('input[autocomplete="username"]').fill(user);
  await page.locator('input[type="password"]').fill(pass);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForTimeout(1500);
  return page;
};

const sgt = await signIn('sgt', 'sergeant-long-enough-pass');

await sgt.goto(BASE + '/readiness', { waitUntil: 'domcontentloaded' });
await sgt.waitForTimeout(1000);
let t = await sgt.textContent('body');
check('Sgt gets the FITREP readiness page', t.includes('FITREP readiness'));
check('Sgt is never shown a JEPES pillar', !t.includes('Mental Agility') && !t.includes('Warfighting'));
check('Sgt sees attribute coverage across D–H', t.includes('Attribute coverage') && t.includes('Leading Subordinates'));
check('Sgt is told the RS is the lever', /Reporting Senior/.test(t));
check('Sgt gets a reporting period field', t.includes('Reporting period'));
check('FITREP cites the current order', t.includes('MCO 1610.7B'));
check('FITREP advice is labeled', t.includes('Coaching heuristic'));

await sgt.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
await sgt.waitForTimeout(1200);
t = await sgt.textContent('body');
check('Sgt gets a FITREP input, not a JEPES one', t.includes('FITREP accomplishment narrative'));
check('Sgt narrative uses the FITREP ceiling', /\/2000 characters/.test(t));

await sgt.keyboard.press('n');
await sgt.waitForTimeout(500);
await sgt.locator('textarea').first().fill('Briefed the comptroller on FY close today');
await sgt.waitForTimeout(900);
t = await sgt.textContent('body');
check('Sgt entry form says FITREP section', t.includes('FITREP section'));
check('Sgt area options are FITREP sections', t.includes('Mission Accomplishment') || t.includes('Intellect'));

const cpl = await signIn('cpl', 'a-long-enough-passphrase');
await cpl.goto(BASE + '/readiness', { waitUntil: 'domcontentloaded' });
await cpl.waitForTimeout(1000);
t = await cpl.textContent('body');
check('Cpl still gets the JEPES advisor', t.includes('JEPES readiness') && t.includes('Warfighting'));
check('Cpl is never shown FITREP attributes', !t.includes('Attribute coverage'));

await cpl.goto(BASE + '/team', { waitUntil: 'domcontentloaded' });
await cpl.waitForTimeout(900);
await cpl.getByText('Kramer, Dale').click();
await cpl.waitForTimeout(1400);
t = await cpl.textContent('body');
check("Cpl leader sees the Sgt's FITREP input, not their own track", t.includes('FITREP input'));

await browser.close();
srv.kill();
try { for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true }); } catch {  }

const fails = checks.filter((c) => !c[0]).length;
console.log(`\n${checks.length - fails}/${checks.length} checks passed`);
if (problems.length) { console.log('\nProblems:'); problems.slice(0, 8).forEach((p) => console.log('  - ' + p)); }
process.exit(fails || problems.length ? 1 : 0);
