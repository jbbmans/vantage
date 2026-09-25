import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

test('links to the destinations that were merged still land on the right tab', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  const moved: Array<[string, string, string]> = [
    ['/queue', '/work?tab=queue', 'Queue'],
    ['/correspondence', '/work?tab=mail', 'Correspondence'],
    ['/studio', '/reports?tab=packages', 'Packages'],
    ['/activities', '/record?tab=entries', 'Activities you recorded'],
    // Activities became a tab of Record, and Readiness a tab of Career.
    ['/records', '/record?tab=entries', 'Activities you recorded'],
    ['/readiness', '/career?tab=readiness', 'readiness'],
    ['/career?tab=messages', '/maradmins', 'MARADMIN'],
  ];
  for (const [from, to, visible] of moved) {
    await page.goto(from);
    await expect(page, `${from} should move to ${to}`).toHaveURL(new RegExp(`${to.replace('?', '\\?')}$`));
    await expect(page.getByText(visible).first()).toBeVisible();
  }
});

test('the rail offers the five destinations in order, and Team to people who lead', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const rail = page.getByRole('navigation', { name: 'Primary' });
  const labels = await rail.getByRole('link').allInnerTexts();
  expect(labels.slice(0, 5).map((l) => l.trim())).toEqual(['Today', 'Work', 'Record', 'Goals', 'Career']);
  expect(labels.map((l) => l.trim())).toContain('Team');
});

test('every navigation destination opens without an error boundary', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  for (const path of ['/', '/work', '/record', '/record?tab=contributions', '/record?tab=drafts', '/record?tab=entries', '/career', '/career?tab=readiness', '/maradmins', '/goals', '/reports', '/team', '/team?tab=workload', '/settings', '/operator', '/help']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(page.getByText('This page hit an error')).toHaveCount(0);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});
