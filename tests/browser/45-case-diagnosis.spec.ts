import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * The automatic financial case diagnoser (Task 16, ADR-0022). An import says what the diagnoser reads in the new rows
 * before anything is written; the queue says what an unprocessed case reads as; a case opens with its diagnosis in the
 * specification's order, every statement labelled, every recommendation naming its source and rank. A Unit Manager puts
 * the command's SOP on file and a Vantage Administrator official policy, and both reach the case ranked above the
 * training reference. A resolved, verified case is validated as an example by a leader who did not resolve it, is offered
 * to the next case like it, and is withdrawn with a reason. Every page reads cleanly to assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
/** An open dialog on its own: the page behind it is dimmed, and is checked before the dialog opens. */
const axeDialog = async (page: Page) => serious((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const ok = async (res: Awaited<ReturnType<APIRequestContext['post']>>) => { expect(res.ok(), await res.text()).toBeTruthy(); return res.json(); };

/** A UDOU case with the procedure applied, through the API, so a test starts on the case page. */
async function udouCase(request: APIRequestContext, reference: string) {
  const made = await ok(await request.post('/api/work/items', { headers: H, data: { unit_id: 'G8', title: 'Undelivered order on a GCSS-MC buy', reference } }));
  await ok(await request.post(`/api/work/items/${made.id}/procedure`, { headers: H, data: { key: 'udou_research' } }));
  return made.id as string;
}

test('an import is read before it is written, the queue says what a case reads as, and the case opens with its diagnosis', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const tag = unique('DX').toUpperCase();
  const csv = [
    'Document,Description,Method,Commitment,Obligation,Delivered,Paid',
    `${tag}-1,Balance on a GCSS-MC buy,GCSS-MC,"50,000.00","50,000.00","30,000.00","30,000.00"`,
    `${tag}-2,Commitment never obligated,GPC,"12,000.00",-,-,-`,
  ].join('\n');

  await page.goto('/work/queue');
  await page.getByRole('button', { name: 'Import work' }).first().click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('Spreadsheet to import').setInputFiles({ name: `${tag}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await dialog.getByRole('button', { name: 'Next' }).click();
  await dialog.getByRole('button', { name: 'Preview' }).click();
  const readings = dialog.getByRole('list', { name: 'What the case diagnoser reads in the new rows' });
  await expect(readings).toContainText('UDOU · 1');
  await expect(readings).toContainText('OCMT · 1');
  expect(await axeDialog(page), 'the import preview').toEqual([]);
  await dialog.getByRole('button', { name: /Import 2 rows/ }).click();
  await dialog.getByRole('button', { name: 'Open the queue' }).click();

  await page.getByLabel('Search the queue').fill(tag);
  const row = page.getByRole('row').filter({ hasText: `${tag}-1` });
  await expect(row.getByText('Reads as UDOU')).toBeVisible();
  await row.getByText(`${tag}-1`, { exact: true }).click();
  await expect(page).toHaveURL(/\/work\/items\//);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Balance on a GCSS-MC buy');

  const panel = page.locator('#diagnosis');
  await expect(panel.getByText('Rules v1.0.0')).toBeVisible();
  await expect(panel).toContainText('Undelivered order, unpaid (UDOU).');
  await expect(panel).toContainText('No AI wrote it.');
  const legend = panel.getByRole('list', { name: 'How each statement is known' });
  for (const label of ['Known fact', 'Derived value', 'Recommendation', 'Unknown', 'Human decision required']) await expect(legend).toContainText(label);
  // The figures are known facts that name the file, row and column they came from; the balance is derived from them.
  const issue = panel.getByRole('list', { name: 'Issue type' });
  await expect(issue).toContainText('Known fact');
  await expect(panel).toContainText(`Imported from ${tag}.csv, row 2`);
  await panel.getByText('Calculations', { exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Calculations' })).toContainText('$20,000.00');
  await expect(panel.getByRole('list', { name: 'Calculations' })).toContainText('Derived value');
  // A recommendation says where it comes from and how far it can be trusted.
  await expect(panel.getByRole('list', { name: 'Research needed' })).toContainText('Training reference (FMRAC), rank 5');
  await panel.getByText('Sources weighed, in order').click();
  const sources = panel.getByRole('list', { name: 'Sources weighed, in order' });
  await expect(sources.getByRole('listitem').first()).toContainText('1. Official policy');
  await expect(panel.getByRole('list', { name: 'Limits of this diagnosis' })).toBeVisible();
  expect(await axe(page), 'a case with its diagnosis').toEqual([]);

  // Under its procedure, with a figure recorded, the balance reading points to the diagnosis for its causes rather than repeating them.
  const id = page.url().split('/').pop()!;
  await ok(await page.request.post(`/api/work/items/${id}/procedure`, { headers: H, data: { key: 'udou_research' } }));
  await ok(await page.request.post(`/api/work/items/${id}/claim`, { headers: H, data: {} }));
  await ok(await page.request.post(`/api/work/items/${id}/entries`, { headers: H, data: { kind: 'observation', field: 'commitment_amount', amount: '50,000.00', system: 'OAS' } }));
  await page.reload();
  await expect(page.getByRole('link', { name: /are in the diagnosis/ })).toHaveAttribute('href', '#diagnosis');

  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'a case with its diagnosis at 390px');
  expect(errors).toEqual([]);
});

test('the command’s SOP and official policy reach the diagnosis, ranked above the training reference, and retire with a reason', async ({ page }) => {
  test.setTimeout(150_000);
  await loginAs(page, OPERATOR.username);
  const tag = unique('SOP').toUpperCase();
  const id = await udouCase(page.request, `${tag}-1`);
  const sop = { text: `Ask the supply chief for the back-order report (${tag}).`, citation: `G-8 SOP 7300.2 para 4.b (${tag})` };
  const policy = { text: `Confirm the correction posted before closing (${tag}).`, citation: `DoD FMR Vol 3 Ch 8, 080301 (${tag})` };

  // The Unit Manager console.
  await page.goto('/console/case-guidance');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Case guidance' })).toBeVisible();
  await page.getByRole('button', { name: 'Put guidance on file' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Put guidance on file' });
  await expect(dialog.getByRole('combobox', { name: 'Kind of source' })).toHaveText('Approved command SOP (rank 3)');
  await dialog.getByRole('combobox', { name: 'Issue type' }).click();
  await page.getByRole('option', { name: 'Undelivered order, unpaid (UDOU)' }).click();
  await dialog.getByRole('combobox', { name: 'Part of the diagnosis' }).click();
  await page.getByRole('option', { name: 'Research needed' }).click();
  await dialog.getByLabel('What it says to do').fill(sop.text);
  await dialog.getByLabel('Citation').fill(sop.citation);
  await expect(dialog.getByRole('button', { name: 'Put on file' }), 'an SOP names who approved it').toBeDisabled();
  await dialog.getByLabel('Approved by').fill('Comptroller, G-8');
  expect(await axeDialog(page), 'putting guidance on file').toEqual([]);
  await dialog.getByRole('button', { name: 'Put on file' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Guidance on file.');
  const command = page.getByRole('list', { name: 'Command guidance' });
  await expect(command).toContainText(sop.text);
  await expect(command).toContainText('Approved command SOP · rank 3');
  expect(await axe(page), 'the console’s case guidance').toEqual([]);

  // The Vantage Administrator console.
  await page.goto('/admin/guidance');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Official guidance' })).toBeVisible();
  await page.getByRole('button', { name: 'Put guidance on file' }).click();
  dialog = page.getByRole('dialog', { name: 'Put guidance on file' });
  await expect(dialog.getByRole('combobox', { name: 'Kind of source' })).toHaveText('Official policy (rank 1)');
  await dialog.getByRole('combobox', { name: 'Part of the diagnosis' }).click();
  await page.getByRole('option', { name: 'Verification' }).click();
  await dialog.getByLabel('What it says to do').fill(policy.text);
  await dialog.getByLabel('Citation').fill(policy.citation);
  await dialog.getByRole('button', { name: 'Put on file' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Guidance on file.');
  await expect(page.getByRole('list', { name: 'Official guidance on file' })).toContainText('Official policy · rank 1');
  expect(await axe(page), 'official guidance').toEqual([]);

  // Both reach the case, each with its source, rank and citation.
  await page.goto(`/work/items/${id}`);
  const panel = page.locator('#diagnosis');
  const research = panel.getByRole('list', { name: 'Research needed' });
  await expect(research.getByRole('listitem').filter({ hasText: sop.text })).toContainText(`Approved command SOP, rank 3 · ${sop.citation} · Binds this command only.`);
  await panel.getByText('Verification', { exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Verification' }).getByRole('listitem').filter({ hasText: policy.text })).toContainText(`Official policy, rank 1 · ${policy.citation}`);
  await panel.getByText('Sources weighed, in order').click();
  await expect(panel.getByRole('list', { name: 'Sources weighed, in order' }).getByRole('listitem').filter({ hasText: 'Approved command SOP' })).toContainText('1 used here');

  // Retired with a reason, kept and listed, and given to no case.
  await page.goto('/admin/guidance');
  await confirmSudoIfAsked(page);
  await page.getByRole('button', { name: `Retire ${policy.citation}` }).click();
  const retire = page.getByRole('dialog', { name: 'Retire this guidance' });
  await expect(retire.getByRole('button', { name: 'Retire it' })).toBeDisabled();
  await retire.getByLabel('Why').fill('Reissued');
  await retire.getByRole('button', { name: 'Retire it' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Retired. It is kept with your reason.');
  await expect(page.getByRole('list', { name: 'Retired official guidance' })).toContainText(policy.text);
  await page.goto('/console/case-guidance');
  await confirmSudoIfAsked(page);
  await page.getByRole('button', { name: `Retire ${sop.citation}` }).click();
  await page.getByRole('dialog', { name: 'Retire this guidance' }).getByLabel('Why').fill('Superseded');
  await page.getByRole('dialog', { name: 'Retire this guidance' }).getByRole('button', { name: 'Retire it' }).click();
  await confirmSudoIfAsked(page);
  await toast(page, 'Retired. It is kept with your reason.');
  await page.goto(`/work/items/${id}`);
  await expect(page.locator('#diagnosis')).toContainText('Rules v1.0.0');
  await expect(page.locator('#diagnosis')).not.toContainText(sop.text);
  await expect(page.locator('#diagnosis')).not.toContainText(policy.text);
});

test('a leader who did not resolve a verified case validates it as an example, the next case is offered it, and it is withdrawn', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await loginAs(page, OPERATOR.username);
  const tag = unique('EX').toUpperCase();
  const first = await udouCase(page.request, `${tag}-1`);
  const next = await udouCase(page.request, `${tag}-2`);

  // An SNCO of G8 works and resolves the first.
  const name = unique('exsnco');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const snco = await context.newPage();
  await registerAs(snco, name, { first_name: 'Sam', last_name: 'Senior' });
  const me = await (await snco.request.get('/api/me')).json();
  await joinUnit(page.request, snco.request);
  await ok(await page.request.post(`/api/org/team/${me.user.id}/roles`, { headers: H, data: { role_id: 'G8:snco', unit_id: 'G8' } }));
  await loginAs(snco, name);
  const s = snco.request;
  await ok(await s.post(`/api/work/items/${first}/claim`, { headers: H, data: {} }));
  await ok(await s.post(`/api/work/items/${first}/entries`, { headers: H, data: { kind: 'decision', decision: 'udou_cause', choice: 'valid_back_order', rationale: 'Vendor confirms the balance ships in December.', step: 'cause' } }));
  await ok(await s.post(`/api/work/items/${first}/entries`, { headers: H, data: { kind: 'verification', check: 'balance_validated', result: 'verified', reference: 'Vendor email', step: 'verify_valid' } }));
  await ok(await s.post(`/api/work/items/${first}/stage`, { headers: H, data: { stage: 'resolved', reason: 'Validated as a back-order.' } }));
  await snco.goto(`/work/items/${first}`);
  await expect(snco.locator('#diagnosis')).toContainText('Rules v1.0.0');
  await expect(snco.getByRole('button', { name: 'Validate as an example' }), 'the person who resolved it does not hold it up').toHaveCount(0);
  await context.close();

  await page.goto(`/work/items/${first}`);
  const panel = page.locator('#diagnosis');
  await expect(panel.getByRole('button', { name: 'Validate as an example' })).toBeVisible();
  expect(await axe(page), 'a resolved case a leader may validate').toEqual([]);
  await panel.getByRole('button', { name: 'Validate as an example' }).click();
  const dialog = page.getByRole('dialog', { name: 'Validate as an example' });
  await expect(dialog.getByRole('button', { name: 'Validate', exact: true })).toBeDisabled();
  const lesson = `A vendor’s ship date in writing is what made the balance valid (${tag}).`;
  await dialog.getByLabel('What it shows the next person').fill(lesson);
  expect(await axeDialog(page), 'validating an example').toEqual([]);
  await dialog.getByRole('button', { name: 'Validate', exact: true }).click();
  await toast(page, 'Validated. Cases like it will offer it.');
  await expect(panel.getByText('A validated example for the next case like it')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'This case as an example' })).toContainText('Validated historical case · rank 6');

  // The next case like it is offered it, ranked and cautioned, linked to the case it came from.
  await page.goto(`/work/items/${next}`);
  const offered = page.locator('#diagnosis').getByRole('list', { name: 'Probable cause' }).getByRole('listitem').filter({ hasText: lesson });
  await expect(offered).toContainText('Validated historical case, rank 6');
  await expect(offered).toContainText('One case. It shows what was true then, not a rule.');
  await offered.getByRole('link', { name: new RegExp(`^Case ${tag}-1, resolved`) }).click();
  await expect(page).toHaveURL(new RegExp(`/work/items/${first}$`));

  // It is listed in the console, and withdrawn from the case with a reason.
  await page.goto('/console/case-guidance');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('list', { name: 'Validated examples' })).toContainText(lesson);
  await page.goto(`/work/items/${first}`);
  await panel.getByRole('button', { name: new RegExp(`^Withdraw Case ${tag}-1`) }).click();
  const withdraw = page.getByRole('dialog', { name: 'Withdraw this example' });
  await withdraw.getByLabel('Why').fill('The vendor later cancelled');
  await withdraw.getByRole('button', { name: 'Withdraw it' }).click();
  await toast(page, 'Example withdrawn. It is kept with your reason.');
  await expect(panel.getByRole('button', { name: 'Validate as an example' })).toBeVisible();
  await page.goto(`/work/items/${next}`);
  await expect(page.locator('#diagnosis')).not.toContainText(lesson);
});

test('a procedure an import chose from the words alone is a lead until a person confirms it on the case', async ({ page }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  const tag = unique('WP').toUpperCase();
  const name = `${tag}.csv`;
  const src = await ok(await page.request.post('/api/work/sources', {
    headers: { ...H, 'content-type': 'text/csv', 'x-filename': name, 'x-unit-id': 'G8', 'x-visibility': 'unit' },
    data: ['Document,Description', `${tag}-1,Outstanding travel order`].join('\n'),
  }));
  const job = await ok(await page.request.post('/api/work/imports', { headers: H, data: {
    source_file_id: src.id, sheet_name: name, header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit', procedure: 'auto',
    mapping: { Document: 'reference', Description: 'title' },
  } }));
  expect(job.procedures_applied).toBe(1);
  const found = await ok(await page.request.get(`/api/work/items?q=${tag}-1`, { headers: H }));
  const id = found.items[0].id as string;
  await ok(await page.request.post(`/api/work/items/${id}/claim`, { headers: H, data: {} }));

  await page.goto(`/work/items/${id}`);
  const confirm = page.getByRole('region', { name: 'Confirm the issue type' });
  await expect(confirm).toContainText('The import chose this procedure from the words on the row alone');
  const panel = page.locator('#diagnosis');
  await expect(panel).toContainText('(a lead, not confirmed)');
  expect(await axe(page), 'the case with an unconfirmed pick').toEqual([]);

  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await toast(page, 'Confirmed. The diagnosis now builds on this procedure.');
  await expect(confirm).toHaveCount(0);
  await expect(panel).not.toContainText('(a lead, not confirmed)');

  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'the confirmed case');
});
