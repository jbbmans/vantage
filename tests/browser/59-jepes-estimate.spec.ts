import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, logout, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

/**
 * The JEPES estimate on Readiness (ADR-0046): the order's worksheet worked on the figures a Lance Corporal enters, each
 * pillar open to its lines and the reason for each, a what-if that is never saved, and the next steps ranked by the
 * points they add. A leader who sees the Marine's readiness sees the same estimate on the Marine's page.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });
const H = { 'x-vantage-client': '1' };

const panel = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

async function choose(page: Page, name: string, option: string) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** The figures of tests/server/jepesEstimate.test.ts's Lance Corporal, worked there by hand to 656. */
async function enterFigures(page: Page) {
  const fill = (label: string, value: string) => page.getByLabel(label, { exact: true }).fill(value);
  await fill('Rifle score', '310');
  await choose(page, 'MCMAP belt', 'Grey');
  await fill('PFT', '250');
  await fill('CFT', '280');
  await fill('MarineNet CEUs', '25');
  await choose(page, 'Degree', 'Associate');
  await fill('Off-duty courses in service', '2');
  await fill('Off-duty courses in grade', '3');
  await fill('MOS qualification points', '30');
  await fill('MOS / Mission Accomplishment', '4.2');
  await fill('Leadership', '4.0');
  await fill('Individual Character', '4.4');
  await fill('Recruiting referrals who enlisted', '1');
}

test.beforeEach(async ({ request }) => { await ensureSetup(request); });

test('a Lance Corporal sees the estimate, the reason for each line, a what-if that is never saved, and the steps by points', async ({ page }) => {
  const name = unique('jepes');
  await registerAs(page, name);
  await page.goto('/career/readiness');
  await expect(page.getByRole('heading', { level: 1, name: /JEPES readiness/ })).toBeVisible();
  const estimate = panel(page, 'Your JEPES estimate');
  await expect(estimate).toContainText('Lance Corporal and below tables');
  await expect(estimate).toContainText('Your score of record is the one on MOL.');
  await expect(page.getByText('Vantage never computes a JEPES score')).toHaveCount(0);
  // Nothing entered: every line is open, so the estimate is a range.
  await expect(estimate).toContainText('0 to 975');
  await expect(estimate).toContainText('a range until the blank figures are entered');

  await enterFigures(page);
  await expect(estimate.locator('.text-3xl')).toHaveText('656');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Readiness saved.')).toBeVisible();

  // Each pillar opens to its lines: the figure, the value the table gives it, the reason, and the order's page.
  await estimate.getByText('Warfighting', { exact: true }).click();
  await expect(estimate).toContainText('Rifle 310 is value 55 on Table 3 (Lance Corporal and below).');
  await expect(estimate).toContainText('Line 1d: 122 × 1.25 = 152.5, rounded to 153.');
  await expect(estimate.getByRole('link', { name: /MCO 1616.1 \(25 Nov 2020\), Appendix B, Table 3, p\. B-8/ })).toHaveAttribute('href', /marines\.mil/);
  await expect(estimate).toContainText('Line 6a: 153 + 160 + 113 + 210 + 20 = 656, of 1,000.');
  await estimate.getByText(/The tables this estimate reads/).click();
  await expect(estimate).toContainText('maradmin-367-21');

  // The steps, ranked by the points the estimator says each adds.
  const steps = panel(page, 'Where the points are');
  const points = (await steps.locator('li').filter({ hasText: 'From the order’s tables' }).locator('text=/^\\+\\d+ points?$/').allTextContents()).map((t) => Number(t.replace(/\D/g, '')));
  expect(points.length).toBeGreaterThan(2);
  expect(points).toEqual([...points].sort((a, b) => b - a));
  await expect(steps).toContainText('Also worth doing');

  // A step tried in the what-if: the answer is said where focus lands, and nothing is saved.
  const whatIf = panel(page, 'What if');
  await steps.getByRole('button', { name: /^Try it in the what-if: Advance to Green belt/ }).click();
  const result = whatIf.locator('[aria-live="polite"]');
  await expect(result).toBeFocused();
  // Grey 67 to Green 100 on Table 1: (55 + 100) x 1.25 = 193.75, 194, against 153.
  await expect(result).toHaveText('With these changes: 697 of 1,000, 41 more than now.');
  await expect(whatIf).toContainText('Warfighting');
  await whatIf.getByLabel('What if: PFT', { exact: true }).fill('300');
  await expect(result).toContainText('more than now');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await whatIf.getByRole('button', { name: 'Start over' }).click();
  await expect(result).toHaveText(/Type a figure above/);

  const scan = await new AxeBuilder({ page }).include('main').analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  await page.reload();
  await expect(panel(page, 'Your JEPES estimate').locator('.text-3xl')).toHaveText('656');
  await expect(panel(page, 'What if').locator('[aria-live="polite"]')).toHaveText(/Type a figure above/);

  // A leader in the Marine's unit sees the same estimate on the Marine's page, and the read is recorded.
  const me = await (await page.request.get('/api/me')).json();
  const leader = await playwrightRequest.newContext({ baseURL: page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1') });
  const signedIn = await leader.post('/api/auth/login', { headers: H, data: { username: OPERATOR.username, password: PASSWORD } });
  expect(signedIn.ok(), await signedIn.text()).toBeTruthy();
  await joinUnit(leader, page.request);
  await leader.dispose();
  await logout(page);
  await loginAs(page, OPERATOR.username);
  await page.goto(`/team/${me.user.id}`);
  await page.getByRole('tab', { name: 'Overview' }).click();
  const theirs = panel(page, 'JEPES estimate');
  await expect(theirs).toContainText('From the figures the Marine entered');
  await expect(theirs.locator('.text-3xl')).toHaveText('656');
  await expect(theirs).toContainText('The score of record is the one on MOL.');
});
