import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, OPERATOR } from './fixtures';

/**
 * MCEN operations in both consoles (Task 8, ADR-0014): each Unit Instance's version, upgrades, health, backup and
 * restores for Vantage staff; Backup and restore, with the data exports that are not backups; a feature withheld from
 * one Unit Instance and given back; and the Unit Manager console's own Operations page. Each reads cleanly to
 * assistive technology.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const panel = (page: Page, name: string) => page.locator('section').filter({ has: page.getByRole('heading', { name, level: 2, exact: true }) });

async function openAdmin(page: Page, path: string, heading: string) {
  await page.goto(`/admin/${path}`);
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test('Unit Instance operations lists each Unit Instance, opens one, and reads cleanly', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openAdmin(page, 'instances', 'Unit Instance operations');
  await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Instance operations' })).toBeVisible();
  await expect(panel(page, 'The service they run on')).toContainText(/runs Vantage \d+\.\d+\.\d+ at schema \d+/);
  await expect(panel(page, 'Schema upgrades')).toBeVisible();
  const list = panel(page, 'Unit Instances');
  await list.getByRole('textbox', { name: 'Find a Unit Instance' }).fill('G-8');
  const open = list.getByRole('button', { name: OPERATOR.unit_name });
  await expect(open).toBeVisible();
  expect(await axe(page)).toEqual([]);

  await open.click();
  const dialog = page.getByRole('dialog', { name: OPERATOR.unit_name });
  await expect(dialog).toBeVisible();
  for (const name of ['Health', 'Version and upgrades', 'Backup and restore', 'Turned off by Vantage']) await expect(dialog.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(dialog.getByText('The service', { exact: true })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Backup and restore keeps infrastructure backups apart from the data exports, which are not backups', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openAdmin(page, 'data', 'Backup and restore');
  for (const name of ['Database backup', 'Restore', 'Restores', 'Service archive', 'Not backups: data exports']) await expect(panel(page, name), name).toBeVisible();
  await expect(panel(page, 'Restore')).toContainText('VANTAGE_RESTORE=1 npm run restore -- REPLACE-DATABASE');
  const exports = panel(page, 'Not backups: data exports');
  for (const name of ['Personal export', 'Unit configuration', 'Roster']) await expect(exports.getByRole('cell', { name: new RegExp(`^${name}`) }).first(), name).toBeVisible();
  await expect(exports).not.toContainText('Database backup');
  expect(await axe(page)).toEqual([]);
});

test('a feature withheld from one Unit Instance shows in both consoles and is given back', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openAdmin(page, 'flags', 'Feature flags');
  const withheld = panel(page, 'Withheld from one Unit Instance');
  await expect(withheld.getByText('Nothing is withheld.')).toBeVisible();
  await withheld.getByRole('combobox', { name: 'Unit Instance' }).click();
  await page.getByRole('option', { name: OPERATOR.unit_name }).click();
  await withheld.getByRole('combobox', { name: 'Feature' }).click();
  await page.getByRole('option', { name: 'Spreadsheet intake' }).click();
  await withheld.getByRole('textbox', { name: 'Why' }).fill('Imports paused for the quarterly data call');
  await withheld.getByRole('button', { name: 'Turn off for this Unit Instance' }).click();
  const confirm = page.getByRole('dialog', { name: `Turn spreadsheet intake off for ${OPERATOR.unit_name}?` });
  await confirm.getByRole('button', { name: 'Turn off' }).click();
  const row = withheld.getByRole('row', { name: /Imports paused for the quarterly data call/ });
  await expect(row).toBeVisible();
  expect(await axe(page)).toEqual([]);

  // The Unit Manager console says what Vantage turned off, and why.
  await page.goto('/console/G8/operations');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'Operations', level: 1 })).toBeVisible();
  const off = panel(page, 'Turned off by Vantage');
  await expect(off.getByText('Spreadsheet intake')).toBeVisible();
  await expect(off.getByText('Imports paused for the quarterly data call')).toBeVisible();
  await expect(panel(page, 'Backup and restore')).toContainText('they are not backups and restore nothing');
  expect(await axe(page)).toEqual([]);

  await openAdmin(page, 'flags', 'Feature flags');
  await panel(page, 'Withheld from one Unit Instance').getByRole('row', { name: /Imports paused/ }).getByRole('button', { name: 'Give it back' }).click();
  await page.getByRole('dialog', { name: `Give ${OPERATOR.unit_name} spreadsheet intake back?` }).getByRole('button', { name: 'Give it back' }).click();
  await expect(panel(page, 'Withheld from one Unit Instance').getByText('Nothing is withheld.')).toBeVisible();
});
