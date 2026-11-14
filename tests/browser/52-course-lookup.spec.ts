import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Course lookup (Task 22, ADR-0029). A Vantage Administrator registers an approved course source with the document that
 * approves it, loads the catalog it publishes, reads what it would change and applies it. A Marine typing a course code
 * on a training sees what that catalog lists, fills the form from it, and sees beside each value whether it is verified
 * (what the catalog lists) or manual (what they entered). The training says which catalog verified what, and when; once
 * the source is withdrawn it says so. Every page reads cleanly to assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const axeDialog = async (page: Page) => serious((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

test('an approved catalog verifies a Marine’s course code and what it lists; anything else they enter is manual', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const tag = unique('CRS').toUpperCase();
  const name = `MarineNet catalog ${tag}`;
  const course = 'Sergeants Course Distance Education Program';

  // The Vantage Administrator registers the source, with the approval it is registered under.
  await page.goto('/admin/courses');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Approved course sources' })).toBeVisible();
  await page.getByRole('button', { name: 'Register a source' }).click();
  const register = page.getByRole('dialog', { name: 'Register an approved course source' });
  await register.getByRole('textbox', { name: /^Source/ }).fill(name);
  await register.getByRole('textbox', { name: /^Published by/ }).fill('TECOM, College of Distance Education and Training');
  await expect(register.getByRole('button', { name: 'Register it' }), 'a source names the approval it is registered under').toBeDisabled();
  await register.getByRole('textbox', { name: /^Approval/ }).fill(`G-8 memo 1500 (${tag})`);
  await register.getByRole('textbox', { name: /^Approved by/ }).fill('Comptroller, G-8');
  await register.getByLabel(/^Approved on/).fill(day(30));
  expect(await axeDialog(page), 'registering a source').toEqual([]);
  await register.getByRole('button', { name: 'Register it' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Registered.');
  const card = page.getByRole('article', { name });
  await expect(card).toContainText('No catalog applied yet: it answers no lookup.');
  await expect(card).toContainText(`G-8 memo 1500 (${tag})`);

  // Its catalog is read, and what it would change is shown before it answers anything.
  await card.getByRole('button', { name: 'Load its catalog' }).click();
  const load = page.getByRole('dialog', { name: `Load the catalog of ${name}` });
  const csv = [
    'Course Number,Course Title,School,Contact Hours,CEU,Course Type,Notes to self',
    `${tag} 8010,${course},CDET,40,4,PME,ignored`,
    `${tag} 8020,Career Course,CDET,30,,PME,`,
    ',No code here,CDET,1,,,',
  ].join('\n');
  await load.getByLabel(/^Catalog file/).setInputFiles({ name: `${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await load.getByLabel(/^Catalog as of/).fill(day(1));
  await load.getByRole('button', { name: 'Read it' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Read. Look at what it would change, then apply it.');
  const staged = card.getByRole('region', { name: 'Catalog waiting to be applied' });
  await expect(staged).toContainText('2 courses from 3 rows. Against the catalog in use: 2 added, 0 changed, 0 unchanged, 0 no longer listed.');
  await expect(staged).toContainText('1 row left out.');
  await expect(staged).toContainText('Course code from “Course Number”');
  await expect(staged).toContainText('Not used: Notes to self.');
  await staged.getByText('Rows left out').click();
  await expect(staged.getByRole('table')).toContainText('No course code.');
  expect(await axe(page), 'a catalog waiting to be applied').toEqual([]);
  await staged.getByRole('button', { name: 'Apply it' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Applied.');
  await expect(card.getByRole('region', { name: 'Catalog waiting to be applied' })).toHaveCount(0);
  await expect(card).toContainText(`Catalog as of ${day(1)}: 2 courses, from ${tag}.csv`);
  await card.getByRole('button', { name: 'Browse' }).click();
  const browse = page.getByRole('dialog', { name: `${name}, catalog as of ${day(1)}` });
  await browse.getByRole('textbox', { name: /^Find a course/ }).fill('career');
  await expect(browse.getByRole('table')).toContainText(`${tag} 8020`);
  await expect(browse.getByRole('table')).not.toContainText(`${tag} 8010`);
  expect(await axeDialog(page), 'browsing a catalog').toEqual([]);
  await page.keyboard.press('Escape');

  // A Marine types the code as they have it; the catalog's listing is offered and fills the form.
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const marine = await context.newPage();
  marine.on('pageerror', (e) => errors.push(String(e.message)));
  await registerAs(marine, unique('crsm'));
  await joinUnit(page.request, marine.request);
  await marine.goto('/career/training');
  await marine.getByRole('button', { name: 'New training' }).first().click();
  const form = marine.getByRole('dialog', { name: 'New training' });
  const code = form.getByRole('textbox', { name: /^Course code/ });
  await expect(code).toBeFocused();
  await expect(form).toContainText('Enter the course code to look it up in the approved catalogs.');
  await code.fill(`${tag.toLowerCase()}-8010`);
  await expect(form).toContainText(`Listed by ${name}`);
  await expect(code).toHaveAccessibleName(/Course code Verified/);
  await form.getByRole('button', { name: 'Use these details' }).click();
  await expect(form.getByRole('textbox', { name: /^Title/ })).toHaveValue(course);
  await expect(code).toHaveValue(`${tag} 8010`);
  for (const field of ['Title', 'Provider']) await expect(form.getByRole('textbox', { name: new RegExp(`^${field}`) })).toHaveAccessibleName(new RegExp(`${field} Verified`));
  await expect(form).toContainText('course code, title, provider, hours, CEUs would be verified');
  // What they change from the listing is theirs: manual.
  await form.getByRole('textbox', { name: /^Provider/ }).fill('MarineNet');
  await expect(form.getByRole('textbox', { name: /^Provider/ })).toHaveAccessibleName(/Provider Manual/);
  await expect(form).toContainText('course code, title, hours, CEUs would be verified');
  // Tall enough that no field scrolls out of the dialog: axe reads a label scrolled out of sight as no label.
  await marine.setViewportSize({ width: 1280, height: 1600 });
  expect(await axeDialog(marine), 'a training form with a course looked up').toEqual([]);
  await form.getByRole('button', { name: 'Add training' }).click();
  await toast(marine, 'Training added.');

  // The training says what was verified, against which catalog, and what is manual.
  const row = marine.getByRole('row').filter({ hasText: course });
  await expect(row).toContainText(`${tag} 8010`);
  await expect(row.getByRole('img', { name: 'verified against an approved catalog' })).toBeVisible();
  await row.getByRole('button', { name: course }).click();
  const view = marine.getByRole('dialog', { name: course });
  const provenance = view.getByTestId('course-provenance');
  await expect(provenance).toContainText('Verified: course code, title, hours, CEUs');
  await expect(provenance).toContainText(`Against ${name}`);
  await expect(provenance).toContainText('Manual: provider.');
  await expect(view).toContainText('What the catalog says');
  await expect(view).toContainText('CDET');
  expect(await axe(marine), 'a training with its course verified').toEqual([]);
  await marine.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(marine, 'a training with its course at 390px');
  await marine.keyboard.press('Escape');

  // Opened again, it says what saving keeps: what was verified, not a fresh guess. Changing a value checks it again.
  await marine.setViewportSize({ width: 1280, height: 900 });
  await marine.getByRole('row').filter({ hasText: course }).getByRole('button', { name: 'Edit' }).click();
  const edit = marine.getByRole('dialog', { name: 'Edit training' });
  await expect(edit).toContainText(`saving keeps what was verified against ${name}`);
  await expect(edit).toContainText(': course code, title, hours, CEUs.');
  await expect(edit.getByRole('textbox', { name: /^Provider/ })).toHaveAccessibleName(/Provider Manual/);
  await expect(edit.getByRole('textbox', { name: /^Title/ })).toHaveAccessibleName(/Title Verified/);
  await edit.getByRole('textbox', { name: /^Title/ }).fill(`${course} (resident)`);
  await expect(edit).not.toContainText('saving keeps what was verified');
  await expect(edit.getByRole('textbox', { name: /^Title/ })).toHaveAccessibleName(/Title Manual/);
  await expect(edit).toContainText('course code, hours, CEUs would be verified');
  await marine.keyboard.press('Escape');

  // A code no catalog lists is kept, and every value is manual.
  await marine.getByRole('button', { name: 'New training' }).first().click();
  await form.getByRole('textbox', { name: /^Course code/ }).fill(`${tag} 9999`);
  await expect(form).toContainText(`No approved catalog lists ${tag} 9999. What you enter is kept as manual.`);
  await expect(form.getByRole('textbox', { name: /^Course code/ })).toHaveAccessibleName(/Course code Manual/);
  await marine.keyboard.press('Escape');

  // The source is withdrawn with a reason; what it verified says so, and it verifies nothing new.
  await page.goto('/admin/courses');
  await confirmSudoIfAsked(page);
  await page.getByRole('article', { name }).getByRole('button', { name: 'Withdraw' }).click();
  const withdraw = page.getByRole('dialog', { name: `Withdraw ${name}` });
  await expect(withdraw.getByRole('button', { name: 'Withdraw it' })).toBeDisabled();
  await withdraw.getByRole('textbox', { name: /^Why/ }).fill('The approval was rescinded.');
  expect(await axeDialog(page), 'withdrawing a source').toEqual([]);
  await withdraw.getByRole('button', { name: 'Withdraw it' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Withdrawn.');
  await expect(page.getByRole('article', { name })).toContainText('The approval was rescinded.');
  await expect(page.getByRole('article', { name }).getByRole('button', { name: 'Load its catalog' })).toHaveCount(0);
  await expect(page.getByRole('article', { name })).toContainText(`Verifies nothing now Its last catalog, as of ${day(1)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'approved course sources at 390px');
  expect(await axe(page), 'approved course sources').toEqual([]);

  await marine.reload();
  await marine.getByRole('row').filter({ hasText: course }).getByRole('button', { name: course }).click();
  await expect(marine.getByRole('dialog', { name: course }).getByTestId('course-provenance')).toContainText('That source has since been withdrawn: The approval was rescinded.');
  await context.close();
  expect(errors).toEqual([]);
});
