import { test, expect, type Page } from '@playwright/test';
import { ensureSetup, loginAs, logout, OPERATOR, PASSWORD } from './fixtures';

/**
 * The keyboard walk (Task 25, ADR-0032; WCAG 2.2 AA): where focus is can always be seen (2.4.7) and is never hidden under
 * the sticky header or the phone's tab bar (2.4.11); a dialog gives focus back to what opened it, and so does the phone
 * menu (2.4.3); a button that is busy keeps focus; a form that refuses a save puts focus on the first field to fix
 * (3.3.1); single-key shortcuts can be turned off (2.1.4).
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });

/** Tab `n` times; for each stop, what the page can say about it. */
async function walk(page: Page, n: number) {
  const stops: Array<{ name: string; outline: number; shadow: boolean; field: boolean; chrome: boolean; covered: string | null }> = [];
  for (let i = 0; i < n; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(async () => {
      // The page keeps focus clear of its chrome a frame after focus moves; read it after that.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { name: 'BODY', outline: 0, shadow: false, field: false, chrome: true, covered: null };
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      // What is drawn at the middle of the focused control: the sticky header or the tab bar there means it is hidden
      // under them (2.4.11). A control that is itself fixed on top, like the skip link, is never covered.
      const hit = document.elementFromPoint(Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1), Math.min(Math.max(rect.top + rect.height / 2, 0), innerHeight - 1));
      const over = hit && !el.contains(hit) && !hit.contains(el) ? hit.closest('header.sticky, nav.tabbar') : null;
      return {
        name: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 40) || ''}`,
        outline: style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth) || 0,
        shadow: style.boxShadow !== 'none',
        field: el.matches('input, select, textarea, .field'),
        chrome: Boolean(el.closest('header.sticky, nav.tabbar, [role=dialog], aside')),
        covered: over ? (over.matches('nav.tabbar') ? 'the tab bar' : 'the header') : null,
      };
    }));
  }
  return stops;
}

test('every Tab stop shows where focus is', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  for (const path of ['/', '/record/activities', '/team', '/settings']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    for (const stop of await walk(page, 30)) {
      if (stop.name === 'BODY') continue;
      expect(stop.outline >= 2 || (stop.field && stop.shadow), `${path}: ${stop.name}`).toBeTruthy();
    }
  }
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 640 } });

  test('focus never hides under the header or the tab bar', async ({ page, request }) => {
    await ensureSetup(request);
    await loginAs(page, OPERATOR.username);
    for (const path of ['/record/activities', '/team', '/settings', '/work/tasks']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      for (const stop of await walk(page, 40)) {
        if (stop.chrome) continue;
        expect(stop.covered, `${path}: ${stop.name} is under ${stop.covered}`).toBeNull();
      }
    }
  });

  test('the menu is a dialog that gives focus back', async ({ page, request }) => {
    await ensureSetup(request);
    await loginAs(page, OPERATOR.username);
    const opener = page.getByRole('button', { name: 'Open menu' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('dialog', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Today' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

test('a dialog gives focus back to what opened it', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  for (const [opener, dialog] of [['Log activity', 'Log activity'], ['Search', null]] as const) {
    const button = page.getByRole('banner').getByRole('button', { name: opener, exact: true });
    await button.focus();
    await page.keyboard.press('Enter');
    const open = dialog ? page.getByRole('dialog', { name: dialog }) : page.getByRole('dialog');
    await expect(open).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(open).toBeHidden();
    await expect(button, opener).toBeFocused();
  }
  await page.goto('/record/duty');
  const record = page.getByRole('button', { name: 'Record duty' }).first();
  await record.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Record duty' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(record).toBeFocused();
});

test('a busy button keeps focus, and a refused sign-in leaves it there', async ({ page, request }) => {
  await ensureSetup(request);
  await logout(page);
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Username' }).fill(OPERATOR.username);
  await page.locator('input[type=password]').fill(`${PASSWORD}-wrong`);
  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  await signIn.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: /incorrect/i })).toBeVisible();
  await expect(signIn).toBeFocused();
});

test('a refused save puts focus on the first field to fix', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/settings?tab=profile');
  const first = page.getByLabel('First name');
  await first.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  await expect(first).toBeFocused();
});

test('single-key shortcuts can be turned off, and on again', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/settings?tab=appearance');
  const toggle = page.getByRole('switch', { name: /Keyboard shortcuts/i });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog', { name: 'Log activity' })).toHaveCount(0);
  await page.goto('/settings?tab=appearance');
  await page.getByRole('switch', { name: /Keyboard shortcuts/i }).click();
  await expect(page.getByRole('switch', { name: /Keyboard shortcuts/i })).toBeChecked();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByRole('dialog', { name: 'Log activity' })).toBeVisible();
});

test('tabs move with the arrow keys and name their panel', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/settings');
  const list = page.getByRole('tablist', { name: 'Settings sections' });
  const tabs = list.getByRole('tab');
  await expect(tabs.first()).toBeVisible();
  const selected = list.getByRole('tab', { selected: true });
  await selected.focus();
  const before = await selected.textContent();
  await page.keyboard.press('ArrowRight');
  const now = list.getByRole('tab', { selected: true });
  await expect(now).toBeFocused();
  expect(await now.textContent()).not.toEqual(before);
  const panel = await now.getAttribute('aria-controls');
  expect(panel, 'the tab names its panel').toBeTruthy();
  await expect(page.locator(`[id="${panel}"]`)).toHaveAttribute('role', 'tabpanel');
});
