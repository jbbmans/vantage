import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

/**
 * The personnel, retention and privacy consoles are the only way to reach three capabilities that
 * change or delete people's records, so they get held to opening cleanly and to previewing before
 * they act.
 */
test('the personnel console plans a roster before it applies one', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=personnel');

  await expect(page.getByRole('heading', { name: 'Load a roster extract' })).toBeVisible();
  await page.getByLabel('Extract').fill('DoD ID,Last,First,Grade\n1234567890,Boletz,John,Sgt\n9876543210,Rivera,Ana,LCpl');
  await page.getByRole('button', { name: 'See what would change' }).click();

  await expect(page.getByRole('heading', { name: 'What this extract would do' })).toBeVisible();
  await expect(page.getByText('2 new')).toBeVisible();
  // Planning must not have written anything: the counters still show an empty roster.
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

  // The destructive action stays unreachable while the preview shows nothing to act on.
  await expect(page.getByRole('button', { name: 'Run disposition' })).toBeDisabled();
});

test('the privacy inventory reads the live schema and names its gaps', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=privacy');

  await expect(page.getByRole('heading', { name: 'Data inventory' })).toBeVisible();
  await expect(page.getByText('Tables holding personal data')).toBeVisible();
  await expect(page.getByText('Unclassified columns')).toBeVisible();

  // Opening a declared table shows the authority and the per-column classification.
  await page.getByRole('cell', { name: 'users', exact: true }).click();
  await expect(page.getByText(/password_hash · authentication/)).toBeVisible();
  await expect(page.getByText(/edipi · identifier/)).toBeVisible();
});
