import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';

const PORT = 8900 + (process.pid % 90);
const DB = `/tmp/smoke-${process.pid}.db`;
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  try { rmSync(f, { force: true }); } catch { /* not there yet */ }
}

const srv = spawn('node', ['tests/browser-server.mjs'], {
  // The bootstrap account is the Instance Operator so the fixtures below can
  // claim the seeded units they exercise (v3.4 finding 4).
  env: {
    ...process.env,
    VANTAGE_DB: DB,
    PORT: String(PORT),
    VANTAGE_OPERATOR: 'boletz',
    // Browser fixtures create additional accounts that must be able to sign
    // in immediately. Production still forces operator-created accounts to
    // replace their temporary password on first use.
    VANTAGE_TEST: '1',
  },
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
// Refusals the flows deliberately provoke (stale 409, a deactivated member's
// 404, a scoped 403, an expired 401) are the UX under test, not breakage — everything else
// in the console still fails the run.
const allowed404Paths = new Set();
page.on('response', (response) => {
  if (response.status() !== 404) return;
  const path = new URL(response.url()).pathname;
  if (!allowed404Paths.has(path)) problems.push(`unexpected 404: ${path}`);
});
page.on('console', m => {
  if (m.type()==='error' && !/status of (401|403|404|409)/.test(m.text())) {
    problems.push('console: '+m.text().slice(0,160));
  }
});
page.on('pageerror', e => problems.push('pageerror: '+e.message.slice(0,200)));

// 1. first-run setup screen. domcontentloaded fires before React has painted,
// so give the shell a bounded window to reach first render rather than racing it.
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
const setupVisible = await page.getByText('Set up this command')
  .waitFor({ timeout: 6000 }).then(() => true).catch(() => false);
check('setup screen renders', setupVisible);

await page.getByLabel(/username/i).fill('boletz').catch(async () => {
  await page.locator('input[autocomplete="username"]').fill('boletz');
});
await page.locator('input[type="password"]').fill('a-long-enough-passphrase');
const inputs = page.locator('input');
// first/last name fields
await page.locator('input').nth(2).fill('John');
await page.locator('input').nth(3).fill('Boletz');
await page.getByRole('button', { name: /create unit leader and sign in/i }).click();
await page.getByRole('button', { name: 'Open account menu' }).waitFor({ timeout: 6000 });

check('signed in to the shell', await page.locator('text=VANTAGE').first().isVisible());
await page.getByRole('button', { name: 'Open account menu' }).click();
check('account menu shows the signed-in name', (await page.textContent('body')).includes('John Boletz'));
await page.keyboard.press('Escape');

/* Production starts with only MFR. Build the two browser-test units through
 * the same endpoint a Unit Leader uses in the real interface. */
const createdUnits = await page.evaluate(async () => {
  const out = {};
  for (const unit of [
    { code: 'G8-FMRAC', name: 'Fiscal Management Resource Analysis Cell', short_name: 'FMRAC', echelon: 'fire_team' },
    { code: 'G8-BUDGET', name: 'Budget Branch', short_name: 'Budget', echelon: 'section' },
  ]) {
    const res = await fetch('/api/org/units', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vantage-client': '1' },
      body: JSON.stringify({ ...unit, parent_id: 'MFR', template_id: 'default' }),
    });
    out[unit.code] = res.status;
  }
  return out;
});
check('fixture units created', Object.values(createdUnits).every((s) => s >= 200 && s < 300), JSON.stringify(createdUnits));

// 2. log an activity through the real UI
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

// 3. walk the routes
for (const [path, expect] of [
  ['/', 'Command'], ['/activities', 'Log'], ['/work', 'Work'],
  ['/goals', 'Goals'], ['/development', 'Development'],
  ['/recognition', 'Recognition'], ['/reports', 'Reports'],
  ['/settings', 'Settings'], ['/team', 'Team'],
  ['/readiness', 'Readiness'], ['/units', 'Units'],
  ['/career', 'Career'], ['/help', 'Help'],
]) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(350);
  const txt = await page.textContent('body');
  check(`route ${path} renders`, txt.length > 400 && !txt.includes('Something in the interface broke'));
}

// 4. the account-security surfaces (v3.3 findings 16 / 28)
await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
const settingsTxt = await page.textContent('body');
check('settings offers a password change', settingsTxt.includes('Change your password'));
check('settings lists active sessions', settingsTxt.includes('Active sessions'));
check('the current session is marked', settingsTxt.includes('This device'));
check('admin database panel renders with a backup action', settingsTxt.includes('Database') && settingsTxt.includes('Download backup'));

// 5. reports: the three views
await page.goto(BASE + '/reports', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);
let t = await page.textContent('body');
check('JEPES narrative panel present', t.includes('JEPES accomplishment narrative'));
check('character counter present', /\/1000 characters/.test(t));

await page.getByRole('tab', { name: /change report/i }).click();
await page.waitForTimeout(450);
t = await page.textContent('body');
check('change report renders', t.includes('What changed') || t.includes('This period'));

await page.getByRole('tab', { name: /^bullets$/i }).click();
await page.waitForTimeout(450);
t = await page.textContent('body');
check('bullet package renders', t.includes('Bullet package'));

// 4b. tablist is keyboard navigable
await page.getByRole('tab', { name: /jepes input/i }).focus();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(350);
check('arrow keys move between report views', (await page.textContent('body')).includes('Bullet package'));

// 5. team page as a leader
await page.goto(BASE + '/team', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(450);
t = await page.textContent('body');
check('roster or add-marine available', t.includes('Add Marine') || t.includes('Marine'));

// 5b. JEPES readiness: enter figures and confirm the advisor responds
await page.goto(BASE + '/readiness', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(450);
t = await page.textContent('body');
check('four pillars render', ['Warfighting','Physical Toughness','Mental Agility','Command Input'].every(x=>t.includes(x)));
check('empty profile asks for data first', t.includes('Enter your'));

await page.getByLabel('PFT score').fill('268').catch(async () => {
  await page.locator('input[type=number]').first().fill('268');
});
await page.waitForTimeout(450);
t = await page.textContent('body');
check('advisor reacts to entered figures', t.includes('1st class') && (t.includes('Push the PFT') || t.includes('Get the PFT')));
check('no invented composite is displayed', !/\/\s*1000/.test(t) && t.includes('No estimated score'));
check('advice is labeled as policy, data, or coaching', t.includes('Coaching heuristic') && t.includes('Official reference'));
check('MOS qualification pointer is present', t.includes('MOS Qualification'));

// 5c. Team editing owns the role permission model and hierarchy.
await page.goto(BASE + '/team', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(450);
await page.getByRole('button', { name: /edit team/i }).first().click();
await page.waitForTimeout(350);
t = await page.textContent('body');
// was: ['Marine','Fire Team Leader','NCOIC','Section Head','Administrator'] —
// the six org-wide rows every install shipped. Finding 1 replaced them with a
// template COPIED into each unit. The approved default ladder now ends in the
// named Unit Leader role; ownership itself remains a separate unit property.
check('the unit\'s own role set is listed', ['Marine','NCO','SNCOIC','Unit Leader'].every(x=>t.includes(x)));
check('hierarchy rule explained', t.includes('at or above your own'));
await page.getByRole('button', { name: /new role/i }).click();
await page.waitForTimeout(300);
t = await page.textContent('body');
check('permission checkboxes render', t.includes('Open member records') && t.includes('Manage roles'));
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

// 5d. Units: create one through the UI
await page.goto(BASE + '/units', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(450);
check('unit tree renders', (await page.textContent('body')).includes('MARFORRES'));
await page.getByRole('button', { name: /new unit/i }).click();
await page.waitForTimeout(300);
await page.locator('input').first().fill('Browser Test Cell');
await page.getByRole('button', { name: /create unit/i }).click();
await page.waitForTimeout(900);
check('unit created through the UI', (await page.textContent('body')).includes('Browser Test Cell'));

// 6. keyboard shortcuts dialog
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(250);
await page.keyboard.press('?');
await page.waitForTimeout(300);
check('shortcuts dialog opens', (await page.textContent('body')).includes('Keyboard'));

// ── v3.3 finding 41: the security-sensitive flows, through the real UI ──

// A stale edit: someone else saves first; the UI must offer the choice, not
// silently overwrite (finding 36 end-to-end).
const staleSetup = await page.evaluate(async () => {
  const mk = await fetch('/api/activities', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vantage-client': '1' },
    body: JSON.stringify({ title: 'Contested UI entry', date: '2026-08-11', visibility: 'private' }),
  });
  const row = await mk.json();
  // a second editor wins the race
  const put = await fetch(`/api/activities/${row.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-vantage-client': '1' },
    body: JSON.stringify({ title: 'Second editor won', version: row.version }),
  });
  return { id: row.id, bumped: put.ok };
});
check('stale-edit fixture prepared', Boolean(staleSetup.id && staleSetup.bumped));
await page.goto(`${BASE}/activities/${staleSetup.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(900);
// The page loaded the newest copy; make it stale in the form by racing again.
await page.evaluate(async (id) => {
  const cur = await (await fetch(`/api/activities`, { headers: { 'x-vantage-client': '1' } })).json();
  const row = cur.find((a) => a.id === id);
  await fetch(`/api/activities/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-vantage-client': '1' },
    body: JSON.stringify({ title: 'Third editor won', version: row.version }),
  });
}, staleSetup.id);
await page.getByLabel('Title').fill('My conflicting edit').catch(async () => {
  await page.locator('main input').first().fill('My conflicting edit');
});
await page.getByRole('button', { name: 'Save changes' }).click();
await page.waitForTimeout(700);
t = await page.textContent('body');
check('stale edit raises the conflict dialog in the UI', t.includes('changed while you were editing'));
check('the dialog shows the winning copy', t.includes('Third editor won'));
await page.getByRole('button', { name: 'Overwrite with mine' }).click();
await page.waitForTimeout(700);
t = await page.textContent('body');
check('overwrite-with-mine completes the save', t.includes('Entry saved.') || !t.includes('changed while you were editing'));

// Deactivation, through the member page (finding 4 end-to-end).
const uiMember = await page.evaluate(async () => {
  const res = await fetch('/api/team', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vantage-client': '1' },
    body: JSON.stringify({
      username: 'uitest', password: 'uitest-long-enough-pass', first_name: 'U', last_name: 'Itest',
      rank_id: 'LCpl', mos: '3451', unit_id: 'G8-FMRAC',
    }),
  });
  return res.json();
});
check('UI member fixture created', Boolean(uiMember.id));
// Once deactivated, the ordinary member-detail route intentionally disappears;
// the page switches to the operator-only access-review card instead.
allowed404Paths.add(`/api/team/${uiMember.id}`);
await page.goto(`${BASE}/team/${uiMember.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1100);
t = await page.textContent('body');
check('member page shows Account and access to an administrator', t.includes('Account and access'));
await page.getByRole('button', { name: 'Deactivate', exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Deactivate account' }).click();
await page.waitForTimeout(1100);
t = await page.textContent('body');
check('deactivation lands on the management card', t.includes('Deactivated account'));
await page.getByRole('button', { name: 'Reactivate account' }).click();
await page.waitForTimeout(1100);
t = await page.textContent('body');
check('reactivation restores the member page', t.includes('Account and access'));

// ── v3.3 finale (finding 41): role escalation and transfer through the UI ──

// Fixtures via the admin's live session: a scoped manager who can edit roles
// but holds no EXPORT_DATA / MANAGE_UNITS / ADMINISTRATOR, and a low clerk
// role for them to try to corrupt.
const escFixture = await page.evaluate(async () => {
  const hdrs = { 'content-type': 'application/json', 'x-vantage-client': '1' };
  const mgr = await (await fetch('/api/roles', {
    method: 'POST', headers: hdrs,
    // was: inherits_down: 1. Nothing cascades (finding 2); the manager is
    // granted in each unit they act in.
    body: JSON.stringify({ name: 'UI Manager', unit_id: 'MFR', position: 25, permissions: 767 }),
  })).json();
  const clerk = await (await fetch('/api/roles', {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({ name: 'UI Clerk', unit_id: 'MFR', position: 5, permissions: 1 }),
  })).json();
  const hayes = await (await fetch('/api/team', {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({
      username: 'uihayes', password: 'uihayes-long-enough-passphrase', first_name: 'U', last_name: 'Hayes',
      rank_id: 'GySgt', mos: '3451', unit_id: 'MFR', role_id: mgr.id,
    }),
  })).json();
  return { mgrId: mgr.id, clerkId: clerk.id, hayesId: hayes.id };
});
check('escalation fixture prepared', Boolean(escFixture.mgrId && escFixture.clerkId && escFixture.hayesId));

const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page2 = await ctx2.newPage();
await page2.goto(BASE, { waitUntil: 'domcontentloaded' });
await page2.waitForTimeout(800);
await page2.locator('input').first().fill('uihayes');
await page2.locator('input[type="password"]').fill('uihayes-long-enough-passphrase');
await page2.keyboard.press('Enter');
await page2.waitForTimeout(1400);
await page2.goto(BASE + '/team', { waitUntil: 'domcontentloaded' });
await page2.waitForTimeout(900);
await page2.getByRole('button', { name: /edit team/i }).first().click();
await page2.waitForTimeout(350);
await page2.locator('div,li,tr').filter({ hasText: 'UI Clerk' }).last()
  .getByRole('button', { name: 'Edit' }).click();
await page2.waitForTimeout(500);
let t2 = await page2.textContent('body');
// The permission the manager does not hold renders disabled — the UI-side
// half of no-escalation. (The server-side half is the security suite's job.)
const exportBox = page2.locator('label').filter({ hasText: 'Export unit data' }).locator('input[type="checkbox"]');
check('ungrantable permission is disabled in the role editor',
  t2.includes('Edit UI Clerk') && await exportBox.isDisabled());
// The always-visible path: push the role's position above their authority.
await page2.getByLabel('Position').fill('40');
await page2.getByRole('button', { name: 'Save changes' }).click();
await page2.waitForTimeout(700);
t2 = await page2.textContent('body');
check('position escalation through the UI is refused', !t2.includes('Role updated.'));
const clerkAfter = await page2.evaluate(async (id) => {
  const data = await (await fetch('/api/roles', { headers: { 'x-vantage-client': '1' } })).json();
  return (data.roles || data).find((r) => r.id === id);
}, escFixture.clerkId);
check('the clerk role is unchanged after the attempt',
  clerkAfter && clerkAfter.position === 5 && clerkAfter.permissions === 1);
await ctx2.close();

// Transfer through the Team page: reassign out of G8-FMRAC and prove the
// old-unit role grant died with the assignment (finding 2 end-to-end).
const moveFixture = await page.evaluate(async () => {
  const hdrs = { 'content-type': 'application/json', 'x-vantage-client': '1' };
  const res = await (await fetch('/api/team', {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({
      username: 'uimove', password: 'uimove-long-enough-passphrase', first_name: 'M', last_name: 'Zztransfer',
      rank_id: 'LCpl', mos: '3451', unit_id: 'G8-FMRAC',
    }),
  })).json();
  // Roles are unit-local copies (finding 1); there is no global role id.
  await fetch(`/api/team/${res.id}/roles`, {
    method: 'POST', headers: hdrs,
    body: JSON.stringify({ role_id: 'G8-FMRAC:nco', unit_id: 'G8-FMRAC' }),
  });
  const before = await (await fetch(`/api/team/${res.id}`, { headers: { 'x-vantage-client': '1' } })).json();
  res.preGrants = (before.roles || []).filter((r) => r.unit_id === 'G8-FMRAC').length;
  return res;
});
check('transfer fixture prepared with an old-unit grant', Boolean(moveFixture.id) && moveFixture.preGrants >= 1);
await page.goto(BASE + '/team', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1000);
await page.locator('div,li,tr').filter({ hasText: 'Zztransfer' }).last()
  .getByRole('button', { name: 'Reassign' }).click();
await page.waitForTimeout(500);
await page.getByRole('combobox').first().click();
await page.getByRole('option', { name: /Budget/ }).click();
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.waitForTimeout(900);
t = await page.textContent('body');
check('transfer through the UI completes', t.includes('Assignment updated.'));
const moved = await page.evaluate(async (id) => {
  const detail = await (await fetch(`/api/team/${id}`, { headers: { 'x-vantage-client': '1' } })).json();
  return {
    unit: detail.assignments?.find((a) => a.is_primary)?.unit_id || detail.unit_id,
    oldGrants: (detail.roles || []).filter((r) => r.unit_id === 'G8-FMRAC').length,
  };
}, moveFixture.id);
check('the assignment moved to Budget Branch', moved.unit === 'G8-BUDGET');
check('the old-unit role grant was revoked by the transfer', moved.oldGrants === 0);

await browser.close();
srv.kill();

const fails = checks.filter(c=>!c[0]).length;
console.log(`\n${checks.length-fails}/${checks.length} checks passed`);
if (problems.length) { console.log('\nProblems:'); problems.slice(0,12).forEach(p=>console.log('  - '+p)); }
process.exit(fails||problems.length?1:0);
