import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';
import { totpCode } from '../../server/auth/totp.ts';

/**
 * Two people for a takeover in the Vantage Administrator console (Task 7, ADR-0013): a temporary password on an account
 * that holds authority is refused alone and leads to a request with a reason; a second staff member approves it from the
 * approvals list; the one who asked carries it out, once.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const step = () => Math.floor(Date.now() / 1000 / 30);

async function openAccounts(page: Page) {
  await page.goto('/admin/accounts');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
}

test('a temporary password on an account with authority waits for a second staff member', async ({ page, browser }) => {
  test.setTimeout(120_000);
  // The account: it leads a unit of its own, so it holds authority.
  const leader = unique('ldr');
  const leaderContext = await browser.newContext();
  const leaderPage = await leaderContext.newPage();
  await registerAs(leaderPage, leader);
  const unit = await leaderPage.request.post('/api/org/units', { headers: H, data: { name: `${leader} Cell` } });
  expect(unit.ok(), await unit.text()).toBeTruthy();
  await leaderContext.close();

  // A second staff member who supports accounts, with an authenticator.
  const helper = unique('help');
  const helperContext = await browser.newContext();
  const helperPage = await helperContext.newPage();
  await registerAs(helperPage, helper);
  await helperPage.request.post('/api/auth/sudo', { headers: H, data: { password: PASSWORD } });
  const { secret } = await (await helperPage.request.post('/api/me/mfa/totp/start', { headers: H })).json() as { secret: string };
  const enrolled = await helperPage.request.post('/api/me/mfa/totp/confirm', { headers: H, data: { code: totpCode(secret, step()) } });
  expect(enrolled.ok(), await enrolled.text()).toBeTruthy();

  await loginAs(page, OPERATOR.username);
  await page.request.post('/api/auth/sudo', { headers: H, data: { password: PASSWORD } });
  const granted = await page.request.post('/api/platform/staff', { headers: H, data: { username: helper, role: 'support' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();

  // Refused alone: the console asks for approval with a reason instead.
  await openAccounts(page);
  await page.getByLabel('Search accounts').fill(leader);
  const row = page.getByRole('row').filter({ hasText: `@${leader}` });
  await row.getByRole('button', { name: 'Temp password' }).click();
  await page.getByRole('dialog', { name: 'Set a temporary password?' }).getByRole('button', { name: 'Set password' }).click();
  const ask = page.getByRole('dialog', { name: 'Ask a second staff member to approve' });
  await expect(ask).toContainText('holds authority');
  const send = ask.getByRole('button', { name: 'Ask for approval' });
  await expect(send, 'a reason comes first').toBeDisabled();
  await ask.getByLabel('Why').fill('Ticket 7731: locked out after a phone swap, identity confirmed by video call');
  await send.click();
  const approvals = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Approvals', level: 2 }) });
  const request = approvals.getByRole('row').filter({ hasText: `@${leader}` });
  await expect(request).toContainText('Waiting for approval');
  await expect(request.getByRole('button', { name: 'Approve' }), 'nobody approves their own request').toHaveCount(0);
  const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(results.violations)).toEqual([]);

  // The second staff member signs in with their second factor and approves it.
  await helperContext.clearCookies();
  const first = await helperPage.request.post('/api/auth/login', { headers: H, data: { username: helper, password: PASSWORD } });
  const { challenge } = await first.json() as { challenge: string };
  const second = await helperPage.request.post('/api/auth/login/mfa', { headers: H, data: { challenge, code: totpCode(secret, step() + 1) } });
  expect(second.ok(), await second.text()).toBeTruthy();
  await openAccounts(helperPage);
  const theirs = helperPage.locator('section').filter({ has: helperPage.getByRole('heading', { name: 'Approvals', level: 2 }) }).getByRole('row').filter({ hasText: `@${leader}` });
  await theirs.getByRole('button', { name: 'Approve' }).click();
  const decide = helperPage.getByRole('dialog', { name: 'Approve this change?' });
  await expect(decide).toContainText('Ticket 7731');
  await decide.getByLabel('Note').fill('Confirmed with their SNCOIC');
  await decide.getByRole('button', { name: 'Approve' }).click();
  await expect(theirs).toContainText('Approved');
  const helperResults = await new AxeBuilder({ page: helperPage }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(helperResults.violations)).toEqual([]);
  await helperContext.close();

  // The one who asked carries it out, once.
  await page.reload();
  await confirmSudoIfAsked(page);
  await expect(request).toContainText('Approved');
  await expect(request).toContainText(/approved by Help\w* Marine: “Confirmed with their SNCOIC”/);
  await request.getByRole('button', { name: 'Carry out' }).click();
  await page.getByRole('dialog', { name: 'Set a temporary password now?' }).getByRole('button', { name: 'Carry out' }).click();
  const shown = page.getByRole('dialog', { name: `Temporary password for ${leader}` });
  await expect(shown).toBeVisible();
  await expect(shown.locator('p.mono')).toHaveText(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{4}$/);
  await page.keyboard.press('Escape');
  await expect(request).toContainText('Done');
  await expect(request.getByRole('button', { name: 'Carry out' })).toHaveCount(0);

  const trail = await page.request.get('/api/platform/audit?action=temporary_password&limit=1', { headers: H });
  const [entry] = (await trail.json()).rows as Array<{ detail: string; category: string }>;
  expect(entry.detail).toMatch(/approved by Help\w* Marine/);
  expect(entry.category).toBe('enterprise');
});
