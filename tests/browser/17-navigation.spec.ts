import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, registerAs, unique, OPERATOR } from './fixtures';

test('old addresses, from bookmarks, emails and notifications, land on the page that took their place', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  const moved: Array<[string, string, string]> = [
    // Merged destinations from before the tabs.
    ['/queue', '/work/queue', 'Queue'],
    ['/correspondence', '/work/correspondence', 'Correspondence'],
    ['/studio', '/reports', 'Packages'],
    ['/activities', '/record/activities', 'Activities'],
    ['/records', '/record/activities', 'Activities'],
    ['/readiness', '/career/readiness', 'readiness'],
    // The tabs, which are pages now. The rest of the query comes along.
    ['/work', '/work/queue', 'Queue'],
    ['/work?tab=mail&mail=contacts', '/work/correspondence?mail=contacts', 'Correspondence'],
    ['/work?tab=projects', '/work/projects', 'Projects'],
    ['/record?tab=entries', '/record/activities', 'Activities'],
    ['/record?tab=drafts', '/record/drafts', 'Drafts'],
    ['/career?tab=awards', '/career/awards', 'Awards'],
    ['/career?tab=messages', '/maradmins', 'MARADMIN'],
    ['/reports?tab=analysis', '/reports/analysis', 'input'],
    ['/team?tab=workload', '/team/workload', 'Workload'],
    ['/team?tab=audit', '/team/access-log', 'Access log'],
  ];
  for (const [from, to, visible] of moved) {
    await page.goto(from);
    await expect(page, `${from} should move to ${to}`).toHaveURL(new RegExp(`${to.replace(/\?/g, '\\?')}$`));
    await expect(page.getByText(visible).first()).toBeVisible();
  }
});

test('the sidebar is grouped: each group lists its pages, and the one you are in is open', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const rail = page.getByRole('navigation', { name: 'Primary' });
  const top = (await rail.getByRole('link').allInnerTexts()).map((l) => l.trim().replace(/\s*G [A-Z]$/, ''));
  expect(top.slice(0, 7)).toEqual(['Today', 'Work', 'Record', 'Career', 'Reports', 'Team', 'Knowledge']);
  expect(top).toContain('Settings');

  await page.goto('/career/awards');
  const career = rail.getByRole('list', { name: 'Career pages' });
  await expect(career.getByRole('link')).toHaveText(['Plan', 'Training', 'Awards', 'Counseling', 'Readiness']);
  await expect(career.getByRole('link', { name: 'Awards' })).toHaveAttribute('aria-current', 'page');
  await expect(rail.getByRole('list', { name: 'Work pages' })).toHaveCount(0);

  // Open another group without leaving the page; the choice is remembered.
  await rail.getByRole('button', { name: 'Show the Work pages' }).click();
  await expect(rail.getByRole('list', { name: 'Work pages' }).getByRole('link')).toHaveText(['Queue', 'Tasks', 'Projects', 'Correspondence']);
  await page.reload();
  await expect(rail.getByRole('list', { name: 'Work pages' })).toBeVisible();
  await rail.getByRole('list', { name: 'Work pages' }).getByRole('link', { name: 'Projects' }).click();
  await expect(page).toHaveURL(/\/work\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  // A leader sees every part of Team; a Marine who leads nobody, only what they may open.
  await page.goto('/team/roster');
  await expect(rail.getByRole('list', { name: 'Team pages' }).getByRole('link')).toHaveText(['Overview', 'Workload', 'Roster', 'Unit dashboard', 'Invitations', 'Roles', 'Units', 'Access log']);
});

test('a Marine without a unit is not offered Team, and a collapsed sidebar puts the group’s pages along the top', async ({ page, request }) => {
  await ensureSetup(request);
  await registerAs(page, unique('loner'));
  const rail = page.getByRole('navigation', { name: 'Primary' });
  await expect(rail.getByRole('link', { name: 'Team' })).toHaveCount(0);

  await page.goto('/career/training');
  await expect(page.getByRole('navigation', { name: 'Career pages' })).toBeHidden();
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  const strip = page.getByRole('navigation', { name: 'Career pages' });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('link', { name: 'Training' })).toHaveAttribute('aria-current', 'page');
  await strip.getByRole('link', { name: 'Counseling' }).click();
  await expect(page).toHaveURL(/\/career\/counseling$/);
  await page.getByRole('button', { name: 'Expand navigation' }).click();
});

test('every page in the sidebar opens without an error boundary', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  for (const path of [
    '/', '/work/queue', '/work/tasks', '/work/projects', '/work/correspondence',
    '/record', '/record/activities', '/record/drafts', '/record/contributions', '/goals',
    '/career', '/career/training', '/career/awards', '/career/counseling', '/career/readiness',
    '/reports', '/reports/analysis',
    '/team', '/team/workload', '/team/roster', '/team/dashboard', '/team/invitations', '/team/roles', '/team/units', '/team/access-log',
    '/reference', '/maradmins', '/help', '/support', '/settings', '/operator',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible();
    await expect(page.getByText('This page hit an error')).toHaveCount(0);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('what changed is a click away, marked until it has been read', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  // Somebody who last read an older list sees the mark on their avatar.
  await page.evaluate(() => localStorage.setItem('vantage.seen-changes', '2000-01-01'));
  await page.reload();
  const account = page.getByRole('button', { name: /Account menu/ }).first();
  await expect(account).toHaveAccessibleName(/Something new/);

  await page.getByRole('button', { name: /^Vantage v/ }).click();
  const dialog = page.getByRole('dialog', { name: 'What’s new' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 3 }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(account).toHaveAccessibleName('Account menu');

  // ⌘K finds it too.
  await page.keyboard.press('Meta+k');
  await page.getByRole('combobox', { name: 'Search' }).fill("what's new");
  await page.getByRole('option', { name: /What’s new in Vantage/ }).click();
  await expect(dialog).toBeVisible();
});
