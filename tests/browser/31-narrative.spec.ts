import { test, expect } from '@playwright/test';
import { ensureSetup, registerAs, unique } from './fixtures';

const H = { 'x-vantage-client': '1' };

test('the narrative studio writes JEPES input in the order’s form, explains each sentence, and takes the Marine’s choices', async ({ page, request }) => {
  await ensureSetup(request);
  await registerAs(page, unique('writer'));
  const today = new Date().toISOString().slice(0, 10);
  const M = 'MOS / Mission Accomplishment';
  for (const data of [
    { title: 'Reconciled 31 ULOs in DAI', quantity: 31, unit_label: 'ULOs', dollar_amount: 77000, dollar_type: 'reconciled', result: 'all cleared on the next report', eval_area: M },
    { title: 'Processing 18 MIPRs for G-8', quantity: 18, unit_label: 'MIPRs', dollar_amount: 240000, dollar_type: 'obligated', result: 'zero returned for correction', eval_area: M },
    { title: 'Trained 4 junior Marines on requisitions', quantity: 4, unit_label: 'Marines', result: 'all four now reconcile unaided', eval_area: 'Leadership' },
    { title: 'Volunteered 10 hours coaching base little league', quantity: 10, unit_label: 'hours', result: 'team finished the season', eval_area: 'Individual Character' },
    { title: 'Completed annual Cyber Awareness training', eval_area: 'Individual Character' },
  ]) {
    const res = await page.request.post('/api/records/activities', { headers: H, data: { ...data, date: today, visibility: 'private' } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  await page.goto('/reports/analysis');
  const narrative = page.getByTestId('narrative');
  await expect(narrative).toBeVisible();
  // The order's form: a heading per command input line, dash bullets, the tense put right, acronyms spelled out once.
  await expect(narrative.getByRole('heading', { name: 'MOS and/or Mission Accomplishment' })).toBeVisible();
  await expect(narrative.getByRole('heading', { name: 'Leadership' })).toBeVisible();
  await expect(narrative).toContainText('-Processed 18 military interdepartmental purchase requests (MIPRs)');
  await expect(narrative).toContainText('unliquidated obligations (ULOs)');
  await expect(narrative).not.toContainText('Cyber Awareness');
  // Required annual training is held back, with the rule, and offered back.
  await expect(page.getByText('Required annual training is not a billet accomplishment (MCO 1616.1, Appendix E).').first()).toBeVisible();

  // A sentence opens onto where it came from and why it made the cut.
  const mipr = narrative.getByRole('button', { name: /Processed 18/ });
  await mipr.click();
  await expect(mipr).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Why it made the cut:/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Processed 18 MIPRs for G-8' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave out' }).click();
  await expect(narrative).not.toContainText('Processed 18');
  await expect(page.getByText('1 left out by you.')).toBeVisible();
  await page.getByRole('button', { name: 'Put them back' }).click();
  await expect(narrative).toContainText('Processed 18');

  // Paragraph form, and another wording that keeps every figure.
  await page.getByRole('tab', { name: 'Paragraph' }).click();
  await expect(narrative).toContainText('MISSION:');
  await page.getByRole('button', { name: 'Another wording' }).click();
  await expect(narrative).toContainText('$77,000');
  await expect(page.getByText(/Reviewer/).first()).toBeVisible();

  // Edited by hand, it is reviewed as typed.
  await page.getByRole('button', { name: 'Edit text' }).click();
  const box = page.getByRole('textbox', { name: 'Narrative text' });
  await box.fill('MISSION: I helped with several ULOs. Outstanding Marine.');
  await expect(page.getByText(/leaves out the first person/)).toBeVisible();
  await expect(page.getByText(/rates the work instead of stating it/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to the written version' }).click();
  await expect(narrative).toBeVisible();
});
