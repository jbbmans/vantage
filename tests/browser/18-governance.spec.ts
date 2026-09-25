import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

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
