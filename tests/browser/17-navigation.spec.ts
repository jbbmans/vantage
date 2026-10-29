import { test, expect, type Locator } from '@playwright/test';
import { ensureSetup, loginAs, registerAs, unique, OPERATOR } from './fixtures';

// A group's page labels, without the "G X" hint the rail shows beside a hovered page.
const listed = (list: Locator) => expect.poll(async () => (await list.getByRole('link').allInnerTexts()).map((l) => l.trim().replace(/\s*G [A-Z]$/, '')));

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

test('the sidebar is the specification’s structure: each group lists its pages, and the one you are in is open', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const rail = page.getByRole('navigation', { name: 'Primary' });
  const top = (await rail.getByRole('link').allInnerTexts()).map((l) => l.trim().replace(/\s*G [A-Z]$/, ''));
  expect(top.slice(0, 7)).toEqual(['Today', 'Work', 'Records', 'Personnel', 'Training & Development', 'Reports & Analytics', 'Administration']);
  expect(top.slice(-2)).toEqual(['Help', 'Settings']);

  // Awards are a record: the page keeps its address and sits under Records.
  await page.goto('/career/awards');
  const records = rail.getByRole('list', { name: 'Records pages' });
  await listed(records).toEqual(['Overview', 'Timeline', 'Activities', 'Awards', 'Counseling', 'Drafts', 'Contributions']);
  await expect(records.getByRole('link', { name: 'Awards' })).toHaveAttribute('aria-current', 'page');
  await expect(rail.getByRole('list', { name: 'Training & Development pages' })).toHaveCount(0);
  await expect(page).toHaveTitle('Awards · Records · Vantage');
  // A trailing slash is the same address: /record/ marks Records → Overview, as /record does.
  await page.goto('/record/');
  await expect(records.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');

  // Open another group without leaving the page; the choice is remembered.
  await rail.getByRole('button', { name: 'Show the Training & Development pages' }).click();
  const development = rail.getByRole('list', { name: 'Training & Development pages' });
  // MARADMINs joins them when the feed is on; it is off here.
  await listed(development).toEqual(['Training', 'Career plan', 'Goals', 'Readiness']);
  await page.reload();
  await expect(development).toBeVisible();
  await development.getByRole('link', { name: 'Goals' }).click();
  await expect(page).toHaveURL(/\/goals$/);
  await expect(page.getByRole('heading', { name: 'Goals', level: 1 })).toBeVisible();

  await rail.getByRole('button', { name: 'Show the Work pages' }).click();
  await listed(rail.getByRole('list', { name: 'Work pages' })).toEqual(['Queue', 'Tasks', 'Projects', 'Error reports', 'Correspondence', 'Reference']);

  // A unit leader's people, figures and administration are three groups, not one list of eight.
  await page.goto('/team/roster');
  await listed(rail.getByRole('list', { name: 'Personnel pages' })).toEqual(['Overview', 'Roster', 'Workload']);
  await page.goto('/team/dashboard');
  await listed(rail.getByRole('list', { name: 'Reports & Analytics pages' })).toEqual(['Packages', 'Analysis', 'Report library', 'Unit dashboard']);
  await page.goto('/team/roles');
  const admin = rail.getByRole('list', { name: 'Administration pages' });
  await listed(admin).toEqual(['Invitations', 'Roles', 'Units', 'Access log', 'Unit Manager console', 'Vantage Administrator console']);
  await expect(admin.getByRole('link', { name: 'Roles' })).toHaveAttribute('aria-current', 'page');
  // Roles sits beneath /team, but it is Administration's page, so Personnel is not the page you are on.
  await expect(rail.getByRole('link', { name: 'Personnel', exact: true })).not.toHaveAttribute('aria-current', 'page');
});

test('a Marine without a unit is not offered Personnel or Administration, and a collapsed sidebar puts the group’s pages along the top', async ({ page, request }) => {
  await ensureSetup(request);
  await registerAs(page, unique('loner'));
  const rail = page.getByRole('navigation', { name: 'Primary' });
  await expect(rail.getByRole('link', { name: 'Personnel' })).toHaveCount(0);
  await expect(rail.getByRole('link', { name: 'Administration' })).toHaveCount(0);

  await page.goto('/career/training');
  await expect(page.getByRole('navigation', { name: 'Training & Development pages' })).toBeHidden();
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  const strip = page.getByRole('navigation', { name: 'Training & Development pages' });
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('link', { name: 'Training' })).toHaveAttribute('aria-current', 'page');
  // The group's icon opens Training, so here it is the page; on the group's other pages it is the group you are in.
  await expect(rail.getByRole('link', { name: 'Training & Development' })).toHaveAttribute('aria-current', 'page');
  await strip.getByRole('link', { name: 'Readiness' }).click();
  await expect(page).toHaveURL(/\/career\/readiness$/);
  // The collapsed rail marks the group the page is in, wherever its address sits: Awards is under Records.
  await expect(rail.getByRole('link', { name: 'Training & Development' })).toHaveAttribute('aria-current', 'true');
  await expect(strip.getByRole('link', { name: 'Readiness' })).toHaveAttribute('aria-current', 'page');
  await page.goto('/career/awards');
  await expect(rail.getByRole('link', { name: 'Records' })).toHaveAttribute('aria-current', 'true');
  await expect(rail.getByRole('link', { name: 'Training & Development' })).not.toHaveAttribute('aria-current');
  await expect(page.locator('[aria-current="page"]:visible')).toHaveCount(1);
  await page.getByRole('button', { name: 'Expand navigation' }).click();
});

test('every page in the sidebar opens without an error boundary, headed as the menu names it', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  // [address, its group (the eyebrow), its heading]. A heading is the menu's label, or that label made specific.
  const pages: Array<[string, string | null, string | RegExp]> = [
    ['/', null, 'Today'],
    ['/work/queue', 'Work', 'Queue'], ['/work/tasks', 'Work', 'Tasks'], ['/work/projects', 'Work', 'Projects'],
    ['/work/error-reports', 'Work', 'Error reports'], ['/work/correspondence', 'Work', 'Correspondence'], ['/reference', 'Work', 'Reference'],
    ['/record', 'Records', 'Your record'], ['/record/timeline', 'Records', 'Timeline'], ['/record/activities', 'Records', 'Activities'],
    ['/career/awards', 'Records', 'Awards'], ['/career/counseling', 'Records', 'Counseling'], ['/record/drafts', 'Records', 'Drafts'],
    ['/record/contributions', 'Records', 'Contributions'],
    ['/team', 'Personnel', /.+/], ['/team/roster', 'Personnel', 'Roster'], ['/team/workload', 'Personnel', 'Workload'],
    ['/career/training', 'Training & Development', 'Training'], ['/career', 'Training & Development', 'Your career plan'],
    ['/goals', 'Training & Development', 'Goals'], ['/career/readiness', 'Training & Development', /readiness$/],
    ['/maradmins', 'Training & Development', 'MARADMINs'],
    ['/reports', 'Reports & Analytics', 'Packages'], ['/reports/analysis', 'Reports & Analytics', /input$/],
    ['/team/dashboard', 'Reports & Analytics', 'Unit dashboard'],
    ['/team/invitations', 'Administration', 'Invitations'], ['/team/roles', 'Administration', 'Roles'], ['/team/units', 'Administration', 'Units'],
    ['/team/access-log', 'Administration', 'Access log'],
    ['/help', 'Help', 'Field guide'], ['/support', 'Help', 'Support'], ['/settings', 'Settings', /.+/],
  ];
  for (const [path, group, heading] of pages) {
    await page.goto(path);
    const h1 = page.getByRole('main').getByRole('heading', { level: 1 }).first();
    await expect(h1, path).toBeVisible();
    await expect(h1, path).toHaveText(heading);
    if (group) await expect(page.getByRole('main').locator('.eyebrow').first(), path).toHaveText(new RegExp(`^${group}`));
    await expect(page.getByText('This page hit an error')).toHaveCount(0);
  }
  await page.goto('/operator');
  await expect(page.getByText('This page hit an error')).toHaveCount(0);
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
