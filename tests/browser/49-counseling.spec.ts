import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { confirmSudoIfAsked, ensureSetup, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Counseling (Task 20, ADR-0027). A counselor drafts a counseling only they see, may share it with its Marine for review,
 * and finalizes it; its Marine reads it, answers in its comments and acknowledges it. A final counseling changes only by
 * amendment, which keeps what it said before and asks the Marine to acknowledge the new text. It prints as a worksheet in
 * the layout of NAVMC 2795 Appendix A, on a page without the app around it, and downloads as a PDF of the same worksheet.
 * Every view reads cleanly to assistive technology and fits a phone.
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

/** The G-8 operator (its Unit Leader, who counsels its members), signed in on a page of their own. */
async function leader(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await loginAs(page, OPERATOR.username);
  return { context, page };
}

/** A new Marine of G-8, a Lance Corporal, signed in on `page`. */
async function marine(page: Page, lead: Page) {
  await registerAs(page, unique('cnsl'));
  await joinUnit(lead.request, page.request);
  return (await (await page.request.get('/api/me')).json()).user.id as string;
}

test('a counselor drafts, shares, finalizes and amends a counseling; its Marine reviews, acknowledges and prints it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const lead = await leader(browser);
  const id = await marine(page, lead.page);
  const summary = `Discussed the GTCC delinquency report ${unique('s')}`;

  // ——— The counselor writes a draft: only they see it ———
  await lead.page.goto(`/team/${id}?tab=counseling`);
  await lead.page.getByRole('button', { name: 'New counseling' }).first().click();
  const form = lead.page.getByRole('dialog', { name: /New counseling for Marine/ });
  await expect(form.getByRole('button', { name: 'Save draft' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Share with Marine' })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Finalize' })).toBeVisible();
  await expect(form).toContainText('Only you see a draft.');
  await form.getByLabel('Summary').fill(summary);
  await form.getByLabel('Strengths').fill('Owns the reconciliation; every MIPR traced.');
  await form.getByLabel('Goals set').fill('Close the three oldest delinquencies by the 15th.');
  expect(await axe(lead.page), 'the counseling form').toEqual([]);
  await form.getByRole('button', { name: 'Save draft' }).click();
  await toast(lead.page, 'Draft saved. Only you can see it.');
  const card = lead.page.locator('article').filter({ hasText: summary });
  await expect(card.getByText('Draft', { exact: true })).toBeVisible();

  await page.goto('/career/counseling');
  await expect(page.getByRole('heading', { name: 'Counseling', exact: true })).toBeVisible();
  await expect(page.getByText(summary)).toHaveCount(0);

  // ——— Shared for review: the Marine reads it and answers in its comments, but cannot acknowledge a draft ———
  await card.getByRole('button', { name: 'Share with Marine' }).click();
  await toast(lead.page, 'Shared with the Marine for review.');
  await expect(card.getByText('Shared for review', { exact: true })).toBeVisible();

  await page.reload();
  const row = page.getByRole('row').filter({ hasText: summary });
  await expect(row.getByText('Shared for review', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  await row.getByRole('button', { name: summary }).click();
  let view = page.getByRole('dialog', { name: /counseling/i });
  await expect(view.getByTestId('counseling-standing')).toContainText('shared with you for review');
  await expect(view.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  await view.getByRole('textbox', { name: 'Write a remark' }).fill('Can we move the target to the 20th? Two of the three are TAD.');
  await view.getByRole('button', { name: 'Post' }).click();
  await expect(view.getByText('Can we move the target to the 20th?')).toBeVisible();
  expect(await axe(page), 'a counseling shared for review').toEqual([]);
  await page.keyboard.press('Escape');

  // ——— Finalized, after saying what that means; then the Marine acknowledges what they read ———
  await card.getByRole('button', { name: 'Finalize' }).click();
  const ask = lead.page.getByRole('dialog', { name: 'Finalize this counseling?' });
  await expect(ask).toContainText('change only by amendment');
  await ask.getByRole('button', { name: 'Finalize' }).click();
  await toast(lead.page, 'Finalized. The Marine is asked to acknowledge it.');
  await expect(card.getByText('Awaiting acknowledgement', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Amend…' })).toBeVisible();

  await page.reload();
  await expect(row.getByText('To acknowledge', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: summary }).click();
  view = page.getByRole('dialog', { name: /counseling/i });
  await expect(view.getByTestId('counseling-standing')).toContainText('Acknowledge it to confirm you read it');
  // Its worksheet, previewed: a Lance Corporal's is Figure A-1, with no SSN.
  await view.getByRole('tab', { name: 'Worksheet (NAVMC 2795)' }).click();
  const sheet = view.getByRole('article', { name: 'Counseling worksheet' });
  await expect(sheet.getByRole('heading', { name: 'COUNSELING WORKSHEET - LANCE CORPORAL AND BELOW' })).toBeVisible();
  await expect(sheet).toContainText('Figure A-1 layout. Not an official form.');
  await expect(sheet.getByRole('heading', { name: 'Tasks Assigned Next Period' })).toBeVisible();
  await expect(sheet).toContainText('Close the three oldest delinquencies by the 15th.');
  await expect(sheet).toContainText('Vantage does not record or print an SSN');
  expect(await axe(page), 'the worksheet preview').toEqual([]);
  await view.getByRole('button', { name: 'Acknowledge' }).click();
  await toast(page, 'Acknowledged.');
  await expect(view.getByTestId('counseling-standing')).toContainText('You acknowledged it on');
  await page.keyboard.press('Escape');
  await expect(row.getByText('Acknowledged', { exact: true })).toBeVisible();

  // ——— Amended: what changed and why is kept; the Marine acknowledges the new text ———
  await lead.page.reload();
  await card.getByRole('button', { name: 'Amend…' }).click();
  const amend = lead.page.getByRole('dialog', { name: 'Amend counseling' });
  await amend.getByRole('button', { name: 'Amend' }).click();
  await expect(amend.getByRole('alert')).toContainText('Nothing in the counseling changed.');
  // Checked on a tall screen, where the whole form shows: axe reads a label scrolled out of a dialog's view as no label.
  await lead.page.setViewportSize({ width: 1280, height: 1600 });
  expect(await axe(lead.page), 'the amendment form').toEqual([]);
  await lead.page.setViewportSize({ width: 1280, height: 720 });
  await amend.getByLabel('Goals set').fill('Close the three oldest delinquencies by the 20th.');
  await amend.getByRole('button', { name: 'Amend' }).click();
  await expect(amend.getByRole('alert')).toContainText('Say why the counseling is amended.');
  await amend.getByLabel('Why it is amended').fill('Target moved to the 20th: two of the three are TAD.');
  await amend.getByRole('button', { name: 'Amend' }).click();
  await toast(lead.page, /Amended. Revision 2 is the counseling now/);
  await expect(card.getByText('Amended', { exact: true })).toBeVisible();
  const history = card.getByRole('region', { name: 'Amendment history' });
  await expect(history).toContainText('Revision 1 replaced on');
  await expect(history).toContainText('Target moved to the 20th');

  await page.reload();
  await expect(row.getByText('To acknowledge', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: summary }).click();
  view = page.getByRole('dialog', { name: /counseling/i });
  await expect(view.getByRole('region', { name: 'Amendment history' })).toContainText('Changed Goals set; the Marine had acknowledged revision 1');
  await expect(view).toContainText('by the 20th');
  await view.getByRole('button', { name: 'Acknowledge' }).click();
  await toast(page, 'Acknowledged.');

  // ——— Print opens the worksheet laid out for paper, in its own tab, without the app around it ———
  const opened = page.context().waitForEvent('page');
  await view.getByRole('button', { name: 'Print' }).click();
  const printed = await opened;
  await printed.waitForLoadState();
  expect(new URL(printed.url()).pathname).toMatch(/^\/career\/counseling\/[^/]+\/print$/);
  await expect(printed.getByRole('heading', { level: 1, name: 'COUNSELING WORKSHEET - LANCE CORPORAL AND BELOW' })).toBeVisible();
  await expect(printed.getByText('AMENDED - REVISION 2', { exact: true })).toBeVisible();
  await expect(printed.locator('aside, header.sticky, footer, nav.tabbar')).toHaveCount(0);
  await expect(printed.getByRole('toolbar', { name: 'Print' })).toBeVisible();
  expect(await axe(printed), 'the print page').toEqual([]);

  // The PDF is the same worksheet, named for the record and its revision.
  const downloading = printed.waitForEvent('download');
  await printed.getByRole('button', { name: 'PDF' }).click();
  await confirmSudoIfAsked(printed);
  const file = await downloading;
  expect(file.suggestedFilename()).toMatch(/^vantage-counseling-[0-9a-f]{8}-r2\.pdf$/);
  const bytes = await (await import('node:fs/promises')).readFile((await file.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');

  // On paper: the buttons are gone, and Chromium prints it on Letter, upright.
  await printed.emulateMedia({ media: 'print' });
  await expect(printed.getByRole('toolbar', { name: 'Print' })).toBeHidden();
  // The handling line heads and foots every printed page, as the PDF's does.
  const frame = await printed.evaluate(() => ({
    head: getComputedStyle(document.querySelector('.cw .report-frame > thead')!).display,
    foot: getComputedStyle(document.querySelector('.cw .report-frame > tfoot')!).display,
    running: [document.querySelector('.cw .report-frame > thead')!.textContent, document.querySelector('.cw .report-frame > tfoot')!.textContent],
  }));
  expect(frame.head, 'the handling line heads every page').toBe('table-header-group');
  expect(frame.foot, 'and foots every page').toBe('table-footer-group');
  for (const line of frame.running) expect(line).toContain('Working paper');
  const paper = (await printed.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
  expect(paper, 'Letter, portrait').toMatch(/\/MediaBox\s*\[\s*0 0 612 792\s*\]/);
  await printed.emulateMedia({ media: 'screen' });

  // The text it replaced reads as it was, and says it was replaced.
  await printed.goto(`${new URL(printed.url()).pathname}?revision=1`);
  await expect(printed.getByText(/^REVISION 1 OF 2 - REPLACED BY AN AMENDMENT/)).toBeVisible();
  await expect(printed.getByRole('article', { name: 'Counseling worksheet' })).toContainText('by the 15th');

  // On a phone, the worksheet and the counseling list fit the width.
  await printed.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(printed, 'the worksheet at 390px');
  await printed.close();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await noSidewaysScroll(page, 'the counseling list at 390px');
  await lead.context.close();
});

test('a counseling still in draft is no such record to its Marine, and their own notes keep no workflow', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  const id = await marine(page, lead.page);
  const made = await lead.page.request.post('/api/records/counselings', { headers: H, data: { user_id: id, unit_id: 'G8', visibility: 'unit', summary: 'Draft only the counselor sees', date: '2026-11-01', type: 'monthly', stage: 'draft' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const draft = await made.json() as { id: string };

  // A link to it opens nothing for its Marine, and its worksheet is no such record.
  await page.goto(`/career/counseling?open=${draft.id}`);
  await expect(page.getByRole('heading', { name: 'Counseling', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`/career/counseling/${draft.id}/print`);
  await expect(page.getByText('Could not prepare the worksheet')).toBeVisible();
  expect((await page.request.get(`/api/records/counselings/${draft.id}/worksheet`, { headers: H })).status()).toBe(404);

  // A Marine's own notes save as they always have, and say they are self-recorded.
  await page.goto('/career/counseling');
  await page.getByRole('button', { name: 'New counseling' }).first().click();
  const form = page.getByRole('dialog', { name: 'New counseling' });
  await expect(form.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await form.getByLabel('Summary').fill('My notes from the quarterly with SSgt Reyes');
  await form.getByLabel('Counselor').fill('SSgt Reyes');
  await form.getByRole('button', { name: 'Add counseling' }).click();
  await toast(page, 'Counseling added.');
  const row = page.getByRole('row').filter({ hasText: 'My notes from the quarterly' });
  await expect(row.getByText('Self-recorded', { exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit counseling' });
  await edit.getByLabel('Goals set').fill('Finish the SNCO distance course.');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toast(page, 'Counseling updated.');
  await row.getByRole('button', { name: /My notes from the quarterly/ }).click();
  const view = page.getByRole('dialog', { name: /counseling/i });
  await expect(view.getByTestId('counseling-standing')).toContainText('Your own notes of a counseling.');
  await view.getByRole('tab', { name: 'Worksheet (NAVMC 2795)' }).click();
  await expect(view.getByRole('article', { name: 'Counseling worksheet' })).toContainText('No counselor finalized or signed them in Vantage.');
  expect(await axe(page), 'own counseling notes').toEqual([]);

  // Its counselor shares the draft from its form on their own counseling list: the list says where it now stands.
  await lead.page.goto('/career/counseling');
  const mine = lead.page.getByRole('row').filter({ hasText: 'Draft only the counselor sees' });
  await expect(mine.getByText('Draft', { exact: true })).toBeVisible();
  await mine.getByRole('button', { name: 'Edit' }).click();
  const editing = lead.page.getByRole('dialog', { name: 'Edit draft counseling' });
  await editing.getByLabel('Goals set').fill('Clear the oldest UMT first.');
  await editing.getByRole('button', { name: 'Share with Marine' }).click();
  await toast(lead.page, 'Shared with the Marine for review.');
  await expect(mine.getByText('Shared for review', { exact: true })).toBeVisible();
  await lead.context.close();
});
