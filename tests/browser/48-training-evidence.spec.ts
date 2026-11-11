import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { confirmSudoIfAsked, ensureSetup, joinUnit, loginAs, logout, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Training evidence (Task 19, ADR-0025). A training holds its evidence as files: each says what it is, and in a line
 * what it shows, beside its name, its type, who added it and when. The Marine adds, corrects and removes their own;
 * whoever reads the unit's shared records opens a shared training's evidence from the Marine's page, and only someone
 * who may correct the record changes it. Every view reads cleanly to assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const closeDialogs = async (page: Page) => { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); };

let made = 0;
/** A new PDF each time: the same file twice on one training is one file. */
const pdf = (note: string) => Buffer.from(`%PDF-1.7\n% ${note} ${Date.now()} ${(made += 1)}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

/** The G-8 operator (its Unit Leader), signed in on a page of their own. */
async function leader(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await loginAs(page, OPERATOR.username);
  return { context, page };
}

/** Records a training over the API as whoever `page` is signed in as: shared with G-8 unless told otherwise. */
async function train(page: Page, title: string, extra: Record<string, unknown> = {}) {
  const res = await page.request.post('/api/records/trainings', { headers: H, data: { title, type: 'pme', status: 'completed', date: day(3), hours: 40, provider: 'SNCO Academy', visibility: 'unit', unit_id: 'G8', ...extra } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return await res.json() as { id: string };
}

/** Chooses what the file is, in the form or the details it is asked in. */
async function choose(page: Page, within: ReturnType<Page['getByRole']>, kind: string) {
  await within.getByRole('combobox', { name: 'What it is' }).click();
  await page.getByRole('option', { name: kind, exact: true }).click();
}

test('a Marine adds evidence to a training, says what it is, corrects it, and removes it only after confirming', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  await registerAs(page, unique('evid'));
  await joinUnit(lead.page.request, page.request);
  const title = `Corporals Course ${unique('t')}`;
  await train(page, title);

  await page.goto('/career/training');
  await expect(page.getByRole('columnheader', { name: 'Evidence' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText('None');
  await row.getByRole('button', { name: title }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.getByRole('heading', { name: 'Evidence' })).toBeVisible();
  await expect(dialog).toContainText('No evidence yet.');
  await expect(dialog).toContainText('PDF, JPEG, PNG, TXT or CSV, up to 10 MB each');

  // Nothing is kept until it says what it is and a file is chosen; the form opens with the keyboard on its first field.
  await dialog.getByRole('button', { name: 'Add evidence' }).click();
  const form = dialog.getByRole('group', { name: 'Add evidence' });
  await expect(form.getByRole('combobox', { name: 'What it is' })).toBeFocused();
  await form.getByRole('button', { name: 'Attach' }).click();
  await expect(form).toContainText('Choose what this file is.');
  await expect(form).toContainText('Choose a file.');
  expect(await axe(page), 'the evidence form with its errors').toEqual([]);

  // The server checks the file's contents against what it says it is, and says so beside the file.
  await choose(page, form, 'Certificate');
  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'corporals-course.pdf', mimeType: 'application/pdf', buffer: Buffer.from('This is not a PDF at all.') });
  await form.getByRole('button', { name: 'Attach' }).click();
  await expect(form.getByRole('alert')).toContainText('The file contents do not match the declared type.');
  await expect(dialog.getByRole('listitem').filter({ hasText: 'corporals-course.pdf' })).toHaveCount(0);

  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'corporals-course.pdf', mimeType: 'application/pdf', buffer: pdf('certificate') });
  await form.getByLabel('Description').fill('Signed by the course director');
  await form.getByRole('button', { name: 'Attach' }).click();
  await toast(page, 'Attached corporals-course.pdf.');
  await expect(form).toHaveCount(0);
  const file = dialog.getByRole('listitem').filter({ hasText: 'corporals-course.pdf' });
  await expect(file).toContainText('Certificate');
  await expect(file).toContainText('Signed by the course director');
  await expect(file).toContainText('PDF');
  await expect(file).toContainText('added by you');

  // A roster as a CSV, with nothing written about it.
  await dialog.getByRole('button', { name: 'Add evidence' }).click();
  await choose(page, form, 'Roster');
  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'class-roster.csv', mimeType: 'text/csv', buffer: Buffer.from('Name,Rank\nMarine,LCpl\n') });
  await form.getByRole('button', { name: 'Attach' }).click();
  await toast(page, 'Attached class-roster.csv.');
  await expect(dialog.getByRole('listitem').filter({ hasText: 'class-roster.csv' })).toContainText('Roster');

  // A download is saved under its own name and never shown as a page.
  const href = await file.getByRole('link', { name: 'corporals-course.pdf' }).getAttribute('href');
  const got = await page.request.get(href!);
  expect(got.ok()).toBeTruthy();
  expect(got.headers()['content-disposition']).toContain('attachment; filename="corporals-course.pdf"');
  expect(got.headers()['x-content-type-options']).toBe('nosniff');
  expect(got.headers()['content-security-policy']).toBe("sandbox; default-src 'none'");

  // What it is and what it shows are corrected in place; focus returns to the button that opened the details.
  await file.getByRole('button', { name: 'Edit details of corporals-course.pdf' }).click();
  const details = dialog.getByRole('group', { name: 'Details of corporals-course.pdf' });
  await expect(details.getByRole('combobox', { name: 'What it is' })).toBeFocused();
  await choose(page, details, 'Completion document');
  await details.getByLabel('Description').fill('Completion letter, class 3-26');
  await details.getByRole('button', { name: 'Save details' }).click();
  await toast(page, 'Details saved.');
  await expect(file).toContainText('Completion document');
  await expect(file).toContainText('Completion letter, class 3-26');
  await expect(file).not.toContainText('Signed by the course director');
  await expect(file.getByRole('button', { name: 'Edit details of corporals-course.pdf' })).toBeFocused();
  expect(await axe(page), 'a training with its evidence').toEqual([]);

  // On a phone the panel and its form fit the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'a training’s evidence on a phone');
  await dialog.getByRole('button', { name: 'Add evidence' }).click();
  await expect(form).toBeVisible();
  await noSidewaysScroll(page, 'the evidence form on a phone');
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog.getByRole('button', { name: 'Add evidence' })).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 720 });

  // Removing asks first, with the keyboard on Keep; the file goes only on Yes.
  await file.getByRole('button', { name: 'Remove corporals-course.pdf', exact: true }).click();
  const ask = file.getByRole('group', { name: 'Remove corporals-course.pdf?' });
  await expect(ask.getByRole('button', { name: 'Keep corporals-course.pdf' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(ask).toHaveCount(0);
  await expect(file).toBeVisible();
  await expect(file.getByRole('button', { name: 'Remove corporals-course.pdf', exact: true })).toBeFocused();
  await file.getByRole('button', { name: 'Remove corporals-course.pdf', exact: true }).click();
  await ask.getByRole('button', { name: 'Yes, remove corporals-course.pdf' }).click();
  await toast(page, 'Removed corporals-course.pdf.');
  await expect(file).toHaveCount(0);
  await expect(dialog.getByRole('listitem').filter({ hasText: 'class-roster.csv' })).toBeVisible();

  // The list says how much evidence the training holds.
  await closeDialogs(page);
  await expect(row).toContainText('1 file');
  await lead.context.close();
});

test('whoever reads a unit’s shared records opens a Marine’s training evidence from their page; only someone who may correct the record changes it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  await registerAs(page, unique('held'));
  await joinUnit(lead.page.request, page.request);
  const me = await (await page.request.get('/api/me')).json();
  const marineId = me.user?.id ?? me.id;
  const tag = unique('s');
  const shared = await train(page, `Sergeants Course ${tag}`);
  await train(page, `Private course ${tag}`, { visibility: 'private', unit_id: null });
  const up = await page.request.post(`/api/records/trainings/${shared.id}/attachments`, {
    headers: { ...H, 'content-type': 'application/pdf', 'x-vantage-filename': encodeURIComponent('sergeants-course.pdf'), 'x-vantage-evidence-kind': 'certificate', 'x-vantage-description': encodeURIComponent('Completion certificate') },
    data: pdf('sergeants course'),
  });
  expect(up.ok(), await up.text()).toBeTruthy();

  // A fire team leader reads the unit's shared records and its Marines' pages, and corrects nobody's record.
  const reader = await browser.newContext({ reducedMotion: 'reduce' });
  const readerPage = await reader.newPage();
  const readerName = unique('ftl');
  await registerAs(readerPage, readerName);
  await joinUnit(lead.page.request, readerPage.request);
  const them = await (await readerPage.request.get('/api/me')).json();
  const granted = await lead.page.request.post(`/api/org/team/${them.user?.id ?? them.id}/roles`, { headers: H, data: { role_id: 'G8:fire-team-leader', unit_id: 'G8' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();
  // A grant resets their sessions, so the new authority is picked up at the next sign-in.
  await logout(readerPage);
  await loginAs(readerPage, readerName);

  await readerPage.goto(`/team/${marineId}?tab=career`);
  const listed = readerPage.getByRole('listitem').filter({ hasText: `Sergeants Course ${tag}` });
  await expect(listed).toContainText('Evidence: 1 file');
  await expect(readerPage.getByText(`Private course ${tag}`)).toHaveCount(0);
  await listed.getByRole('button', { name: `Sergeants Course ${tag}` }).click();
  const read = readerPage.getByRole('dialog', { name: `Sergeants Course ${tag}` });
  await expect(read.getByRole('heading', { name: 'Evidence' })).toBeVisible();
  const theirs = read.getByRole('listitem').filter({ hasText: 'sergeants-course.pdf' });
  await expect(theirs).toContainText('Certificate');
  await expect(theirs).toContainText('Completion certificate');
  await expect(theirs).toContainText('added by LCpl Marine');
  const link = await theirs.getByRole('link', { name: 'sergeants-course.pdf' }).getAttribute('href');
  expect((await readerPage.request.get(link!)).ok(), 'whoever reads the training opens its evidence').toBeTruthy();
  // Nothing is offered that the server would refuse.
  await expect(read.getByRole('button', { name: /Add evidence|Edit details|Remove/ })).toHaveCount(0);
  const refused = await readerPage.request.put(link!, { headers: H, data: { description: 'Mine now' } });
  expect(refused.status()).toBe(403);
  expect(await axe(readerPage), 'a Marine’s evidence, read by a leader').toEqual([]);
  await readerPage.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(readerPage, 'a Marine’s evidence on a phone');
  await reader.close();

  // The unit leader may correct shared records: they add to the Marine's training, and correct what a file is said to show.
  await lead.page.goto(`/team/${marineId}?tab=career`);
  await lead.page.getByRole('button', { name: `Sergeants Course ${tag}` }).click();
  const open = lead.page.getByRole('dialog', { name: `Sergeants Course ${tag}` });
  await open.getByRole('button', { name: 'Add evidence' }).click();
  const form = open.getByRole('group', { name: 'Add evidence' });
  await choose(lead.page, form, 'Roster');
  await form.getByLabel('File', { exact: true }).setInputFiles({ name: 'graduation-roster.pdf', mimeType: 'application/pdf', buffer: pdf('roster') });
  await form.getByLabel('Description').fill('Graduation roster, class 1-27');
  await form.getByRole('button', { name: 'Attach' }).click();
  await toast(lead.page, 'Attached graduation-roster.pdf.');
  await expect(open.getByRole('listitem').filter({ hasText: 'graduation-roster.pdf' })).toContainText('added by you');
  const existing = open.getByRole('listitem').filter({ hasText: 'sergeants-course.pdf' });
  await existing.getByRole('button', { name: 'Edit details of sergeants-course.pdf' }).click();
  const details = open.getByRole('group', { name: 'Details of sergeants-course.pdf' });
  await details.getByLabel('Description').fill('Completion certificate, verified against the roster');
  await details.getByRole('button', { name: 'Save details' }).click();
  await toast(lead.page, 'Details saved.');
  await closeDialogs(lead.page);
  await expect(lead.page.getByRole('listitem').filter({ hasText: `Sergeants Course ${tag}` })).toContainText('Evidence: 2 files');

  // The Marine sees who added what on their own training.
  await page.goto('/career/training');
  await page.getByRole('row').filter({ hasText: `Sergeants Course ${tag}` }).getByRole('button', { name: `Sergeants Course ${tag}` }).click();
  const mine = page.getByRole('dialog', { name: `Sergeants Course ${tag}` });
  await expect(mine.getByRole('listitem').filter({ hasText: 'graduation-roster.pdf' })).toContainText(/added by \S+ Boletz/);
  await expect(mine.getByRole('listitem').filter({ hasText: 'sergeants-course.pdf' })).toContainText('Completion certificate, verified against the roster');
  await lead.context.close();
});

test('a retention preview counts the files an anonymize run would remove, and a run takes a file an earlier run left behind', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  // A shared training that ended eleven years ago, with its certificate. A ten-year schedule reaches it and nothing else here.
  const old = await train(page, `Course long past ${unique('t')}`, { date: day(11 * 365) });
  const add = (name: string) => page.request.post(`/api/records/trainings/${old.id}/attachments`, {
    headers: { ...H, 'content-type': 'application/pdf', 'x-vantage-filename': encodeURIComponent(name), 'x-vantage-evidence-kind': 'certificate' }, data: pdf(name),
  });
  const onFile = async () => (await (await page.request.get(`/api/records/trainings/${old.id}/attachments`)).json()).attachments.length as number;
  const schedule = (enabled: boolean) => page.request.put('/api/orgs/G8/retention/schedule', { headers: H, data: { record_type: 'trainings', retain_days: 3650, disposition: 'anonymize', authority: 'Browser test', enabled } });
  const first = await add('old-certificate.pdf');
  expect(first.ok(), await first.text()).toBeTruthy();
  const saved = await schedule(true);
  expect(saved.ok(), await saved.text()).toBeTruthy();

  const confirm = page.getByRole('dialog', { name: 'Run disposition now?' });
  const run = async () => {
    await page.getByRole('button', { name: 'Run disposition' }).click();
    await expect(confirm).toContainText('removes 1 attached file and cannot be undone.');
    await confirm.getByRole('button', { name: 'Run disposition' }).click();
    await confirmSudoIfAsked(page);
    await expect(page.getByText('1 attached file removed')).toBeVisible();
  };
  try {
    await page.goto('/operator?tab=retention');
    await confirmSudoIfAsked(page);
    await expect(page.getByRole('heading', { name: 'Retention schedules' })).toBeVisible();

    // The preview says what a run would take with the words, before anything is taken.
    await page.getByRole('button', { name: 'See what is eligible' }).click();
    await confirmSudoIfAsked(page);
    await expect(page.getByText('1 attached file would be removed')).toBeVisible();
    expect(await onFile(), 'a preview removes nothing').toBe(1);
    expect(await axe(page), 'the retention preview').toEqual([]);
    await run();
    expect(await onFile()).toBe(0);

    // A file on a training an earlier run anonymized: no record is left to count, and the run is still offered.
    const later = await add('added-later.pdf');
    expect(later.ok(), await later.text()).toBeTruthy();
    await page.getByRole('button', { name: 'See what is eligible' }).click();
    await confirmSudoIfAsked(page);
    await expect(page.getByText('1 attached file would be removed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run disposition' })).toBeEnabled();
    await run();
    expect(await onFile()).toBe(0);
  } finally {
    await schedule(false);
  }
});
