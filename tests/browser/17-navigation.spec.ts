import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

/**
 * Destinations have been merged and, in one case, un-merged. Anything a person saved a link to — a
 * bookmark, a link pasted into a message a year ago — has to land where that screen lives now,
 * never on a not-found page. That includes links to a tab that has since been promoted back out
 * into a destination of its own.
 */
test('links to the destinations that were merged still land on the right tab', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  const moved: Array<[string, string, string]> = [
    ['/queue', '/work?tab=queue', 'Case queue'],
    ['/correspondence', '/work?tab=mail', 'Correspondence'],
    ['/studio', '/reports?tab=packages', 'Packages'],
    ['/activities', '/records', 'Activities'],
    // MARADMINs went the other way: it was a tab under Career and is a destination again.
    ['/career?tab=messages', '/maradmins', 'MARADMIN'],
  ];
  for (const [from, to, visible] of moved) {
    await page.goto(from);
    await expect(page, `${from} should move to ${to}`).toHaveURL(new RegExp(`${to.replace('?', '\\?')}$`));
    await expect(page.getByText(visible).first()).toBeVisible();
  }
});

test('every navigation destination opens without an error boundary', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  for (const path of ['/', '/work', '/records', '/career', '/maradmins', '/goals', '/readiness', '/reports', '/team', '/settings', '/operator', '/help']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByText('This page hit an error')).toHaveCount(0);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
