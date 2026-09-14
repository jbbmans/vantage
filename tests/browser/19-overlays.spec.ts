import { test, expect, devices } from '@playwright/test';
import type { Locator } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

/**
 * Overlays have to stay inside the screen.
 *
 * Two of them did not, twice, for the same reason: an entrance animation that sets `transform`
 * replaces the translate that was centring the element, so it lands offset by half its own width.
 * It is invisible on a desktop, where there is room to be wrong in, and it puts half the panel off
 * a phone. A scrollWidth check does not catch it either, because a fixed element does not extend
 * the document. So the assertion has to be the geometry of the panel itself.
 */
test.use({ ...devices['Pixel 7'] });

async function assertOnScreen(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label} should be rendered`).not.toBeNull();
  const width = (await locator.page().viewportSize())!.width;
  expect(box!.x, `${label} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} runs past the right edge (${Math.round(box!.x + box!.width)} > ${width})`).toBeLessThanOrEqual(width + 1);
}

test('every overlay opens fully inside a phone screen', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog').first();
  await palette.waitFor();
  await assertOnScreen(palette, 'the command palette');
  await page.keyboard.press('Escape');

  await page.goto('/records');
  await page.getByRole('button', { name: 'New entry' }).click();
  const form = page.getByRole('dialog', { name: 'New activity' });
  await form.waitFor();
  await assertOnScreen(form, 'a form dialog');
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  const shortcuts = page.getByRole('dialog').first();
  await shortcuts.waitFor();
  await assertOnScreen(shortcuts, 'the shortcuts dialog');
  await page.keyboard.press('Escape');
});

test('a tab strip too wide for the screen scrolls, and shows the tab you are on', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  // The owner console has more tabs than fit any phone.
  await page.goto('/operator?tab=privacy');
  const active = page.getByRole('tab', { name: 'Privacy' });
  await active.waitFor();

  const box = (await active.boundingBox())!;
  const width = (await page.viewportSize())!.width;
  expect(box.x, 'the active tab was left off the left of the strip').toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, 'the active tab was left off the right of the strip').toBeLessThanOrEqual(width + 1);
});
