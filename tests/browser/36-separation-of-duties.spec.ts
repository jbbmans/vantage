import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, OPERATOR } from './fixtures';

/**
 * The separation-of-duties report in the Vantage Administrator console (Task 7, ADR-0013): read-only, one section per
 * kind of crossing, each saying whether anybody is in it. The account that set Vantage up is a Lead Vantage
 * Administrator and the first Unit Instance's Lead Unit Manager and leader, so it appears twice.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

test('the separation-of-duties page lists each crossing, read-only and accessible', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto('/admin/audit');
  await confirmSudoIfAsked(page);
  await page.getByRole('link', { name: 'Separation of duties' }).first().click();
  await expect(page).toHaveURL(/\/admin\/separation$/);
  await expect(page.getByRole('heading', { name: 'Separation of duties', level: 1 })).toBeVisible();

  const section = (name: string) => page.locator('section').filter({ has: page.getByRole('heading', { name, level: 2 }) });
  for (const name of ['Vantage staff with a Unit Instance role', 'Unit Instance roles that also read records', 'Unit Managers in more than one Unit Instance', 'Unit leaders who are not members', 'Roles from the person who created the account']) {
    await expect(section(name), name).toBeVisible();
  }
  const staff = section('Vantage staff with a Unit Instance role');
  await expect(staff.getByRole('cell', { name: new RegExp(`${OPERATOR.first_name} ${OPERATOR.last_name}`) })).toBeVisible();
  await expect(staff.getByText(/to review/)).toBeVisible();
  const reading = section('Unit Instance roles that also read records');
  await expect(reading.getByText(/Unit leader in /).first()).toBeVisible();
  // It changes nothing: no form, no button but checking again.
  await expect(page.locator('main form')).toHaveCount(0);
  await page.getByRole('button', { name: 'Check again' }).focus();
  await page.keyboard.press('Enter');
  await expect(staff).toBeVisible();

  const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(results.violations)).toEqual([]);
});
