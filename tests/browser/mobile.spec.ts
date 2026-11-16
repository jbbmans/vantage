import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, OPERATOR } from './fixtures';

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const focusIn = (page: Page, selector: string) => page.evaluate((s) => Boolean(document.activeElement?.closest(s)), selector);

test('phone layout: drawer navigation, card records, and the tab bar log button', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Records', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your record' })).toBeVisible();
  // On a phone the group's pages run along the top of the page.
  await page.getByRole('navigation', { name: 'Records pages' }).getByRole('link', { name: 'Activities' }).click();
  await expect(page.getByRole('heading', { name: 'Activities', level: 1 })).toBeVisible();
  // On a phone, logging sits in the tab bar at the bottom, where a thumb reaches. The owner leads a unit, so the bar
  // offers Personnel beside Today and Work; a Marine's bar offers Records there instead.
  const bar = page.getByRole('navigation', { name: 'Quick navigation' });
  await expect(bar.getByRole('link', { name: 'Personnel' })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Today' })).toBeVisible();
  await bar.getByRole('button', { name: 'Log activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  await dialog.getByLabel('What did you do?').fill('Ran a 3 mile route with 8 Marines this morning');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Ran a 3 mile route/ })).toBeVisible();
  const box = await page.locator('body').boundingBox();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(Math.ceil(box!.width) + 1);
});

test('F1/KB-04: the phone menu is a dialog named Menu that holds focus while open and hands it back when it closes', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const opener = page.getByRole('button', { name: 'Open menu' });
  await opener.click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu).toBeVisible();
  // Focus starts on the page you are on, and Tab goes round the menu, never behind it.
  await expect(menu.getByRole('link', { name: 'Today', exact: true })).toBeFocused();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab');
    expect(await focusIn(page, '[role="dialog"]'), `Tab ${i + 1} left the menu`).toBe(true);
  }
  expect(await axe(page)).toEqual([]);
  await noSidewaysScroll(page, 'the open menu');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(opener).toBeFocused();

  // The same from the tab bar's More, and the close button says what it closes.
  const more = page.getByRole('navigation', { name: 'Quick navigation' }).getByRole('button', { name: 'More' });
  await more.click();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Close menu' }).click();
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();

  // Choosing a page closes the menu and puts focus at the top of the page it opened.
  await opener.click();
  await menu.getByRole('link', { name: 'Records', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(/\/record$/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('main');
});

test('KB-07: on a phone the first Tab is the skip link, wherever the page’s strip is scrolled to', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/console/G8/people');
  await confirmSudoIfAsked(page);
  for (const path of ['/work/queue', '/record', '/career/awards', '/team/access-log', '/settings', '/console/G8/people']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus'), path).toHaveText('Skip to content');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.id), path).toBe('main');
  }
  // The strip still shows the page you are on.
  await page.goto('/team/access-log');
  const active = page.getByRole('navigation', { name: 'Administration pages' }).getByRole('link', { name: 'Access log' });
  await expect(active).toBeVisible();
  const box = await active.boundingBox();
  expect(box && box.x >= -1 && box.x + box.width <= (page.viewportSize()?.width ?? 0) + 1, 'the page you are on is in view').toBe(true);
});
