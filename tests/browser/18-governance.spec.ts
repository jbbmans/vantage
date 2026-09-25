import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR, confirmSudoIfAsked } from './fixtures';

test('the personnel console plans a roster before it applies one', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=personnel');

  await expect(page.getByRole('heading', { name: 'Load a roster extract' })).toBeVisible();
  await page.getByLabel('Extract').fill('DoD ID,Last,First,Grade\n1234567890,Boletz,John,Sgt\n9876543210,Rivera,Ana,LCpl');
  await page.getByRole('button', { name: 'See what would change' }).click();

  await expect(page.getByRole('heading', { name: 'What this extract would do' })).toBeVisible();
  await expect(page.getByText('2 new')).toBeVisible();
  await expect(page.getByText('On the roster', { exact: true })).toBeVisible();
});

test('retention shows every record type as unset and disposition previews before it runs', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=retention');

  await expect(page.getByRole('heading', { name: 'Retention schedules' })).toBeVisible();
  await expect(page.getByText('not set').first()).toBeVisible();

  await page.getByRole('button', { name: 'See what is eligible' }).click();
  await expect(page.getByRole('heading', { name: 'What disposition would do now' })).toBeVisible();
  await expect(page.getByText('No schedule is enabled')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Run disposition' })).toBeDisabled();
});

test('the privacy inventory reads the live schema and names its gaps', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=privacy');

  await expect(page.getByRole('heading', { name: 'Data inventory' })).toBeVisible();
  await expect(page.getByText('Tables holding personal data')).toBeVisible();
  await expect(page.getByText('Unclassified columns')).toBeVisible();

  await page.getByRole('cell', { name: 'users', exact: true }).click();
  await expect(page.getByText(/password_hash · authentication/)).toBeVisible();
  await expect(page.getByText(/edipi · identifier/)).toBeVisible();
});

test('the owner imports accounts from a roster: a preview first, then the accounts', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=users');
  const tag = Date.now().toString(36);
  const roster = [
    'Rank,First Name,Last Name,L2 Command,Fire Team,Username,Temporary Password,Role',
    `Sgt,Riley,Import,Roster Command ${tag},Cell ${tag},riley.${tag},QuartzHarborLane4!,Fire Team Leader`,
    `LCpl,Sam,Import,Roster Command ${tag},Cell ${tag},sam.${tag},CedarMeadowRun7#,Marine`,
  ].join('\n');

  await page.getByRole('button', { name: 'Import accounts' }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(roster) });
  await confirmSudoIfAsked(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('2 to create')).toBeVisible();
  await expect(dialog.getByText(`@riley.${tag}`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Create 2 accounts' }).click();
  await confirmSudoIfAsked(page);
  await expect(dialog.getByRole('heading', { name: 'Accounts created' })).toBeVisible();
  await expect(dialog.getByText('Created', { exact: true })).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(`@riley.${tag}`)).toBeVisible();
});
