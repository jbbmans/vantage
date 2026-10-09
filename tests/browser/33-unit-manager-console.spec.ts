import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, unique, OPERATOR, PASSWORD } from './fixtures';

/**
 * The Unit Manager console's structure and configuration pages (Task 6, ADR-0012): each opens and reads cleanly to
 * assistive technology at every width, a Unit Manager runs billets, duty types and their scoring, training requirements,
 * teams and work settings from them, and a Unit Auditor sees the same pages without a control that changes anything.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const PAGES: Array<[string, string]> = [
  ['units', 'Units and teams'], ['billets', 'Billets'], ['unit-roles', 'Unit roles'], ['duty', 'Duty'], ['training', 'Training'],
  ['work', 'Work and reports'], ['data', 'Imports and exports'], ['audit', 'Audit trail'], ['settings', 'Settings'],
];

async function openConsole(page: Page, path: string, heading: string) {
  await page.goto(`/console/G8/${path}`);
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();

test('the configuration pages open for a Lead Unit Manager and have no serious accessibility violations', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await openConsole(page, '', OPERATOR.unit_name);
  for (const [, label] of PAGES) await expect(sections.getByRole('link', { name: label, exact: true })).toBeVisible();
  for (const [path, heading] of PAGES) {
    await openConsole(page, path, heading);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), `/console/G8/${path}`).toEqual([]);
  }
  // Settings show what Vantage sets for every Unit Instance, read-only.
  await openConsole(page, 'settings', 'Settings');
  await expect(page.getByRole('heading', { name: 'Set by Vantage' })).toBeVisible();
  await expect(page.getByText('Idle sign-out')).toBeVisible();
});

test('a Unit Manager lists a billet, sees it vacant, and assigns it to a member of the unit', async ({ page, request }) => {
  await loginAs(page, OPERATOR.username);
  const last = unique('Billeted');
  const reg = await request.post('/api/auth/register', { headers: H, data: { username: last.toLowerCase(), password: PASSWORD, first_name: 'Pat', last_name: last, rank_id: 'LCpl' } });
  expect(reg.ok(), await reg.text()).toBeTruthy();
  await joinUnit(page.request, request);

  const title = unique('Budget Analyst ');
  await openConsole(page, 'billets', 'Billets');
  await page.getByRole('button', { name: 'New billet' }).click();
  const dialog = page.getByRole('dialog', { name: 'New billet' });
  await dialog.getByLabel('Title', { exact: true }).fill(title);
  await dialog.getByLabel(/^Code/).fill('0105');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Billet added.');
  await expect(page.getByRole('cell', { name: title, exact: true })).toBeVisible();

  const roster = page.getByRole('list', { name: 'Billet roster' });
  const line = roster.getByRole('listitem').filter({ hasText: title });
  await expect(line).toContainText('Vacant');
  await line.getByRole('button', { name: `Assign ${title}` }).click();
  const assign = page.getByRole('dialog', { name: `Assign ${title}` });
  await assign.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(last) }).click();
  await assign.getByRole('button', { name: 'Assign' }).click();
  await toast(page, `${title} assigned.`);
  await expect(line).toContainText(last);
  await expect(line).not.toContainText('Vacant');

  // Retiring it keeps the trail of it, and it can come back.
  await page.getByRole('button', { name: `Retire ${title}` }).click();
  await toast(page, /Billet retired/);
  await page.getByRole('button', { name: `Restore ${title}` }).click();
  await toast(page, 'Billet restored.');
});

test('a Unit Manager starts the duty list, adds training and changes the claim window within its limits', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openConsole(page, 'duty', 'Duty');
  const standard = page.getByRole('button', { name: 'Add the standard list' });
  if (await standard.isVisible()) { await standard.click(); await toast(page, /Added \d+ duty types/); }
  await expect(page.getByRole('cell', { name: 'Funeral Detail', exact: true })).toBeVisible();
  const duty = unique('Gate Sentry ');
  await page.getByRole('button', { name: 'New duty type' }).click();
  const dutyDialog = page.getByRole('dialog', { name: 'New duty type' });
  await dutyDialog.getByLabel('Name', { exact: true }).fill(duty);
  await dutyDialog.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Duty type added.');
  await page.getByRole('button', { name: `Retire ${duty}` }).click();
  await expect(page.getByRole('row').filter({ hasText: duty })).toContainText('Retired');

  await openConsole(page, 'training', 'Training');
  const course = unique('Fiscal Law ');
  await page.getByRole('button', { name: 'New requirement' }).click();
  const trainingDialog = page.getByRole('dialog', { name: 'New training requirement' });
  await trainingDialog.getByLabel('Title', { exact: true }).fill(course);
  await trainingDialog.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Requirement added.');
  await expect(page.getByRole('row').filter({ hasText: course })).toContainText('Every year');

  await openConsole(page, 'work', 'Work and reports');
  const hours = page.getByLabel('A claim lapses after');
  // The work queue's Save comes first; the report default's second.
  const save = page.getByRole('button', { name: 'Save' }).first();
  await hours.fill('2');
  await expect(page.getByRole('alert').filter({ hasText: 'Between 4 and 336 hours.' })).toBeVisible();
  await expect(save).toBeDisabled();
  await hours.fill('48');
  await save.click();
  await toast(page, 'Saved. The next sweep uses it.');
  await page.reload();
  await confirmSudoIfAsked(page);
  await expect(page.getByLabel('A claim lapses after')).toHaveValue('48');
  // Back to the default, for the specs that follow.
  const reset = await page.request.patch('/api/orgs/G8/configuration/settings', { headers: H, data: { work: { claimExpiryHours: 72 } } });
  expect(reset.ok(), await reset.text()).toBeTruthy();
});

test('a Unit Manager publishes a duty scoring version after trying it, and it is on the record', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openConsole(page, 'duty', 'Duty');
  const standard = page.getByRole('button', { name: 'Add the standard list' });
  if (await standard.isVisible()) { await standard.click(); await toast(page, /Added \d+ duty types/); }
  await page.getByRole('button', { name: 'New version' }).click();
  const dialog = page.getByRole('dialog', { name: 'New scoring version' });
  // Checked as it opens: axe counts a label scrolled out of view inside the dialog as hidden.
  await expect(dialog.getByLabel('Takes effect')).toBeVisible();
  const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(results.violations), 'the new scoring version dialog').toEqual([]);
  // DNCO, 5 points; a holiday multiplies it by 1.5 (VANTAGE_CLAUDE_MASTER §13's example).
  await dialog.getByRole('combobox', { name: 'How DNCO is scored', exact: true }).click();
  await page.getByRole('option', { name: 'Fixed', exact: true }).click();
  await dialog.getByLabel('Points for DNCO', { exact: true }).fill('5');
  const multipliers = dialog.getByRole('group', { name: 'Multipliers' });
  await multipliers.getByRole('checkbox', { name: 'Holiday' }).check();
  await multipliers.getByLabel('Holiday multiplier').fill('1.5');
  const trial = dialog.getByRole('group', { name: 'Try it' });
  await trial.getByRole('combobox').click();
  await page.getByRole('option', { name: 'DNCO', exact: true }).click();
  await trial.getByRole('checkbox', { name: 'Holiday' }).check();
  await expect(dialog.getByTestId('scoring-trial')).toContainText('7.5 points');

  // It says why before it can be published.
  const publish = dialog.getByRole('button', { name: 'Publish' });
  await expect(publish).toBeDisabled();
  const note = unique('Policy letter ');
  await dialog.getByLabel('Why it changes').fill(note);
  await publish.click();
  await toast(page, 'Scoring version published.');
  const versions = page.getByRole('list', { name: 'Scoring versions' });
  const item = versions.getByRole('listitem').filter({ hasText: note });
  // It takes effect tomorrow at the soonest, so it is scheduled, and can be withdrawn until then; it stays on the record.
  await expect(item).toContainText('Scheduled');
  await expect(item).toContainText(OPERATOR.last_name);
  await item.getByRole('button', { name: /^Withdraw version / }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Withdraw' }).click();
  await toast(page, /withdrawn/);
  await expect(item).toContainText('Withdrawn');
});

test('a Unit Manager creates a team beneath a unit, finds it under Teams, and archives it', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openConsole(page, 'units', 'Units and teams');
  const team = unique('Alpha Team ');
  await page.getByRole('button', { name: 'New team' }).click();
  const dialog = page.getByRole('dialog', { name: 'New team' });
  await dialog.getByLabel('Name', { exact: true }).fill(team);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toast(page, `${team} created.`);
  await page.getByRole('tab', { name: 'Teams' }).click();
  const row = page.getByRole('row').filter({ hasText: team });
  // The Lead Unit Manager here also leads G8 through the chain of command, so the team they create is theirs to lead.
  await expect(row).toContainText('Fire Team');
  await expect(row).toContainText(OPERATOR.last_name);
  await row.getByRole('button', { name: `Archive ${team}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
  await toast(page, 'Unit archived.');
});

test('the Unit Instance’s audit trail filters on the server by action', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  // Something to find.
  const made = await page.request.post('/api/orgs/G8/billets', { headers: H, data: { title: unique('Audited Billet ') } });
  expect(made.ok(), await made.text()).toBeTruthy();
  await openConsole(page, 'audit', 'Audit trail');
  await expect(page.getByRole('combobox', { name: 'Unit' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Action' }).click();
  await page.getByRole('option', { name: 'Billet created' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/shown, filtered/)).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('Billet created');
  for (const text of await rows.allInnerTexts()) expect(text).toContain('Billet created');
});

test('a Unit Auditor reads the configuration pages and finds no control that changes anything', async ({ page, browser, request }) => {
  await loginAs(page, OPERATOR.username);
  const username = unique('auditor');
  const reg = await request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: 'Audrey', last_name: 'Auditor', rank_id: 'Sgt' } });
  expect(reg.ok(), await reg.text()).toBeTruthy();
  const me = await (await request.get('/api/me')).json();
  await joinUnit(page.request, request);
  const granted = await page.request.post('/api/orgs/G8/roles', { headers: H, data: { user_id: me.user.id, role: 'auditor' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();

  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const auditor = await context.newPage();
  await loginAs(auditor, username);
  const sections = auditor.getByRole('navigation', { name: 'Sections' });
  await openConsole(auditor, 'billets', 'Billets');
  await expect(sections.getByRole('link', { name: 'Unit roles' }), 'a Unit Auditor manages no unit roles').toHaveCount(0);
  await expect(auditor.getByRole('button', { name: 'New billet' })).toHaveCount(0);
  await expect(auditor.getByRole('button', { name: /^Retire / })).toHaveCount(0);
  await openConsole(auditor, 'duty', 'Duty');
  await expect(auditor.getByRole('button', { name: 'New duty type' })).toHaveCount(0);
  await expect(auditor.getByRole('heading', { name: 'Scoring' })).toBeVisible();
  await expect(auditor.getByRole('button', { name: 'New version' })).toHaveCount(0);
  await openConsole(auditor, 'work', 'Work and reports');
  await expect(auditor.getByLabel('A claim lapses after')).toBeDisabled();
  await expect(auditor.getByText('a Unit Manager changes them')).toBeVisible();
  // And the server says the same as the page.
  const refused = await auditor.request.post('/api/orgs/G8/billets', { headers: H, data: { title: 'Not mine to add' } });
  expect(refused.status()).toBe(403);
  await context.close();
});

test('the configuration pages fit a tablet and a phone without scrolling sideways', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  for (const [w, h] of [[768, 1024], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const [path, heading] of PAGES) {
      await openConsole(page, path, heading);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `/console/G8/${path} at ${w}px`).toBeLessThanOrEqual(1);
    }
  }
});
