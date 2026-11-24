import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, logout, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

/**
 * FITREP standing on Readiness (ADR-0047): a Staff Sergeant adds the reports on their Master Brief Sheet and sees each
 * one's average, relative value and third with the working, the coming report in an RS profile, and evidence strength
 * for its period. A leader who sees their readiness reads only the reports they share.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });
const H = { 'x-vantage-client': '1' };

const panel = (page: Page, title: string) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

async function choose(page: Page, name: string, option: string) {
  await page.getByRole('combobox', { name, exact: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const axe = async (page: Page, where: string) => {
  const scan = await new AxeBuilder({ page }).include(where).analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
};
/** A dialog is scanned for serious and critical violations, as the other dialog specs do: its header is the shared one. */
const axeDialog = async (page: Page) => {
  const scan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
};

async function addReport(page: Page, r: Record<string, string>) {
  await panel(page, 'Your fitness reports').getByRole('button', { name: 'Add a report' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a fitness report' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Period from', { exact: true }).fill(r.from);
  await dialog.getByLabel('Period to', { exact: true }).fill(r.to);
  await choose(page, 'Occasion', r.occasion);
  for (const [label, key] of [['Reporting senior', 'rs'], ['Marks', 'marks'], ['RS Avg', 'avg'], ['RS High', 'high'], ['Reports when processed', 'processed'], ['Reports now', 'now'], ['RV at processing', 'rv'], ['Cum RV', 'cum']] as const) {
    if (r[key]) await dialog.getByLabel(label, { exact: true }).fill(r[key]);
  }
  return dialog;
}

test.beforeEach(async ({ request }) => { await ensureSetup(request); });

test('a Staff Sergeant adds their reports, sees where each stands and what the coming one needs, and shares one with a leader', async ({ page }) => {
  const name = unique('fitrep');
  await registerAs(page, name, { rank_id: 'SSgt' });
  await page.goto('/career/readiness');
  await expect(page.getByRole('heading', { level: 1, name: /FITREP readiness/ })).toBeVisible();
  const reports = panel(page, 'Your fitness reports');
  await expect(reports).toContainText('No reports yet.');
  await expect(page.getByRole('heading', { name: 'Attribute coverage' })).toHaveCount(0);

  // The figures of tests/server/fitrepStanding.test.ts: 45 over 13 observed is 3.46, valued 92.91 in a profile of 11.
  const first = await addReport(page, { from: '2025-06-01', to: '2026-05-31', occasion: 'AN, Annual', rs: 'Capt Alvarez', marks: 'ddcdcdccdccdch', avg: '3.30', high: '3.85', processed: '6', now: '11', rv: '93.64', cum: '92.91' });
  await expect(first).toContainText('These marks average 3.46 (45 over 13 observed).');
  await expect(first.getByRole('combobox', { name: 'Your grade on the report' })).toHaveText('E-6');
  await axeDialog(page);
  await first.getByRole('button', { name: 'Add report' }).click();
  await expect(page.getByText('Report added.')).toBeVisible();
  const alvarez = reports.getByRole('article', { name: 'Fitness report 2025-06-01 to 2026-05-31' });
  await expect(alvarez).toContainText('Middle third');
  await expect(alvarez).toContainText('93.64 / 92.91');
  await expect(alvarez).toContainText('Cumulative RV: 90 + 10 × 0.16 ÷ 0.55 = 92.91.');
  await expect(alvarez).toContainText('0.16 above the RS Avg (3.30) and 0.39 below the RS High (3.85)');

  // A new RS with two reports on the grade: no relative value yet, and the page says why.
  const second = await addReport(page, { from: '2026-06-01', to: '2026-10-31', occasion: 'CH, Change of reporting senior', rs: 'Maj Okafor', marks: 'DDCDCCDCDCCCCH', avg: '3.41', high: '3.79', processed: '2', now: '2' });
  await second.getByRole('button', { name: 'Add report' }).click();
  const okafor = reports.getByRole('article', { name: 'Fitness report 2026-06-01 to 2026-10-31' });
  await expect(okafor).toContainText('The RS profile holds 2 reports on the grade. A report has a relative value once the RS has written 3.');
  const byThird = reports.getByLabel('Your reports by third');
  await expect(byThird).toContainText('Middle third1');
  await expect(byThird).toContainText('No relative value1');

  // A mistake is refused at the field, and nothing is saved.
  const wrong = await addReport(page, { from: '2026-11-01', to: '2026-11-20', occasion: 'AN, Annual', marks: 'DDCD' });
  await wrong.getByRole('button', { name: 'Add report' }).click();
  await expect(wrong.getByLabel('Marks', { exact: true })).toBeFocused();
  await expect(wrong).toContainText('Fourteen marks, A to G, or H where not observed');
  await wrong.getByRole('button', { name: 'Cancel' }).click();
  await expect(reports.getByRole('article')).toHaveCount(2);

  // The coming report in the newest profile counts in it: three reports, so it has a value.
  const coming = panel(page, 'The coming report');
  await expect(coming.getByRole('combobox', { name: 'RS profile' })).toContainText('Maj Okafor, E-6 (RS Avg 3.41, High 3.79, 2 reports)');
  await coming.getByLabel('Average you expect', { exact: true }).fill('3.60');
  const answer = coming.locator('[aria-live="polite"]');
  await expect(answer).toHaveText('Processed now, it would be valued 94.06, in the upper third. The profile would read RS Avg 3.47, RS High 3.79, 3 reports.');
  await expect(coming).toContainText('Your report of 2026-06-01 to 2026-10-31: cumulative RV none now, 87.19 after.');
  await expect(coming).toContainText('The upper third (93.34)');
  await expect(coming).toContainText('Nothing here is saved.');

  // Evidence strength, by section and attribute, for the coming report's period.
  const evidence = panel(page, 'Evidence strength');
  await expect(evidence).toContainText('For the coming report: entries from 2026-11-01');
  for (const section of ['Section D: Mission Accomplishment', 'Section F: Leadership', 'Section H: Fulfillment of Evaluation Responsibilities']) {
    await expect(evidence.getByRole('region', { name: section })).toBeVisible();
  }
  await expect(evidence).toContainText('Nothing logged in the period speaks to it.');

  await axe(page, 'main');

  // Shared, the leader who sees this Marine's readiness reads that one report and its standing; the other stays private.
  await alvarez.getByRole('button', { name: 'Share the report of 2025-06-01 to 2026-05-31' }).click();
  await expect(page.getByText('Shared with the leaders who see your readiness.')).toBeVisible();
  await expect(alvarez).toContainText('Shared');

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
  const theirs = panel(page, 'Shared fitness reports');
  await expect(theirs).toContainText('The record is the Master Brief Sheet.');
  await expect(theirs.getByRole('article')).toHaveCount(1);
  await expect(theirs.getByRole('article', { name: 'Fitness report 2025-06-01 to 2026-05-31' })).toContainText('92.91');
  await expect(theirs).not.toContainText('Maj Okafor');
  await axe(page, 'main');
});
