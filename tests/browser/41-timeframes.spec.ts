import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, unique, OPERATOR } from './fixtures';

/**
 * Record timeframes (ADR-0018): an activity, a course or an award takes a start and an end, an activity or a
 * course a time at each end and "ongoing". The form says which date to fix before anything is sent, the lists and the
 * record show the range, and the form reads cleanly to assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const literally = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
/**
 * A refusal marks the field to fix and moves focus to it, and its message is said once: the field's own alert, with no
 * toast repeating it.
 */
async function refused(page: Page, field: Locator, text: string) {
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(literally(text));
  await expect(page.locator('[role="alert"]').filter({ hasText: text })).toHaveCount(1);
}
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};

test('an activity takes a start, an end and times, is refused when it ends first, and becomes ongoing from its page', async ({ page }) => {
  const title = unique('Audit support to G-8 ');
  await page.goto('/records?period=all');
  await page.getByRole('button', { name: 'New activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'New activity' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Start date', { exact: true }).fill('2026-03-02');
  await dialog.getByLabel('End date', { exact: true }).fill('2026-02-27');
  await dialog.getByRole('button', { name: 'Add activity' }).click();
  // Refused before anything is sent, with the date to fix marked and focused.
  await refused(page, dialog.getByLabel('End date', { exact: true }), 'On or after the start.');
  expect(serious((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations), 'the form with its error').toEqual([]);

  await dialog.getByLabel('End date', { exact: true }).fill('2026-03-13');
  await dialog.getByRole('button', { name: 'Add times' }).click();
  await dialog.getByLabel('Start time', { exact: true }).fill('0730');
  await dialog.getByLabel('End time', { exact: true }).fill('1630');
  await dialog.getByRole('button', { name: 'Add activity' }).click();
  await toast(page, 'Activity added.');
  await expect(dialog).toBeHidden();

  await page.getByLabel('Search records').fill(title);
  await expect(page.getByText('02 Mar 26 0730 – 13 Mar 26 1630').first()).toBeVisible();
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByText('02 Mar 26 0730 – 13 Mar 26 1630').first()).toBeVisible();

  // Still going on after all: the end goes, and the record reads "present".
  await page.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit activity' });
  await edit.getByRole('switch', { name: /Ongoing/ }).click();
  await expect(edit.getByLabel('End date', { exact: true })).toBeDisabled();
  await expect(edit.getByLabel('End date', { exact: true })).toHaveValue('');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toast(page, 'Activity updated.');
  await expect(page.getByText('02 Mar 26 0730 – present').first()).toBeVisible();
  expect(serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations), 'the record').toEqual([]);
});

test('a time that is not one is named before anything is sent', async ({ page }) => {
  await page.goto('/records?period=all');
  await page.getByRole('button', { name: 'New activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'New activity' });
  await dialog.getByLabel('Title').fill(unique('Night watch '));
  await dialog.getByLabel('Start date', { exact: true }).fill('2026-05-01');
  await dialog.getByRole('button', { name: 'Add times' }).click();
  await dialog.getByLabel('Start time', { exact: true }).fill('2500');
  await dialog.getByRole('button', { name: 'Add activity' }).click();
  await refused(page, dialog.getByLabel('Start time', { exact: true }), 'Use a 24-hour time: 0800 or 08:00.');
  // Past midnight, it ends the next day.
  await dialog.getByLabel('Start time', { exact: true }).fill('2200');
  await dialog.getByLabel('End time', { exact: true }).fill('0600');
  await dialog.getByRole('button', { name: 'Add activity' }).click();
  await refused(page, dialog.getByLabel('End time', { exact: true }), 'After the start time. If it ran past midnight, set the end date to the next day.');
  await dialog.getByLabel('End date', { exact: true }).fill('2026-05-02');
  await dialog.getByRole('button', { name: 'Add activity' }).click();
  await toast(page, 'Activity added.');
});

test('KB-09: a duty time that is not one takes focus, and the form says it once', async ({ page }) => {
  await page.goto('/record/duty');
  await page.getByRole('button', { name: 'Record duty' }).first().click();
  const form = page.getByRole('dialog', { name: 'Record duty' });
  await form.getByLabel('Start date').fill('2026-05-01');
  await form.getByLabel('Start time').fill('1600');
  await form.getByLabel('End time').fill('25:99');
  await form.getByRole('button', { name: 'Record duty' }).focus();
  await page.keyboard.press('Enter');
  await refused(page, form.getByLabel('End time'), 'Use a 24-hour time: 0800 or 08:00.');
  // The summary under the form says it too, but is not a second announcement.
  await expect(form.getByText('Use a 24-hour time: 0800 or 08:00.', { exact: true })).toHaveCount(2);
  await expect(form.locator('[role="alert"]')).toHaveCount(1);
});

test('a course runs from its first day to its last, and an award names the period it recognizes', async ({ page }) => {
  const course = unique('Sergeants Course ');
  await page.goto('/career/training');
  await page.getByRole('button', { name: 'New training' }).first().click();
  const training = page.getByRole('dialog', { name: 'New training' });
  await training.getByLabel('Title').fill(course);
  await training.getByLabel('Start date', { exact: true }).fill('2026-04-06');
  await training.getByLabel('End date', { exact: true }).fill('2026-05-15');
  await training.getByRole('button', { name: 'Add training' }).click();
  await toast(page, 'Training added.');
  await expect(page.getByRole('row').filter({ hasText: course }).getByText('06 Apr 26 – 15 May 26')).toBeVisible();

  const name = unique('Certificate of Commendation ');
  await page.goto('/career/awards');
  await page.getByRole('button', { name: 'New award' }).first().click();
  const award = page.getByRole('dialog', { name: 'New award' });
  await award.getByLabel('Award', { exact: true }).fill(name);
  await award.getByLabel('Period start').fill('2026-07-01');
  await award.getByLabel('Period end / award date').fill('2026-06-30');
  await award.getByRole('button', { name: 'Add award' }).click();
  await refused(page, award.getByLabel('Period end / award date'), 'On or after the start.');
  await award.getByLabel('Period start').fill('2026-01-01');
  await award.getByRole('button', { name: 'Add award' }).click();
  await toast(page, 'Award added.');
  await expect(page.getByText('01 Jan 26 – 30 Jun 26').first()).toBeVisible();
});

test('on a phone the dates stack and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/records?period=all');
  await page.getByRole('button', { name: 'New activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'New activity' });
  await dialog.getByRole('button', { name: 'Add times' }).click();
  const [start, end] = await Promise.all([dialog.getByLabel('Start date', { exact: true }).boundingBox(), dialog.getByLabel('End date', { exact: true }).boundingBox()]);
  expect(end!.y, 'the end date sits under the start date').toBeGreaterThan(start!.y);
  await noSidewaysScroll(page, 'the activity form');
  // Phone width, tall enough that the whole form is in view: axe takes a label scrolled out of the dialog for a hidden one.
  await page.setViewportSize({ width: 390, height: 2400 });
  expect(serious((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations), 'the form on a phone').toEqual([]);
});
