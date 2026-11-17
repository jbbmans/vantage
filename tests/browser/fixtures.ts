import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'cobalt-orbit-velvet-anchor-927';
export const OPERATOR = { username: 'boletz', first_name: 'John', last_name: 'Boletz', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' };
const H = { 'x-vantage-client': '1' };

export async function ensureSetup(request: APIRequestContext) {
  const status = await (await request.get('/api/auth/setup')).json();
  if (!status.needsSetup) return;
  const res = await request.post('/api/auth/setup', { headers: H, data: { ...OPERATOR, password: PASSWORD, rank_id: 'Cpl', mos: '3451', email: 'boletz@example.mil' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await request.post('/api/auth/logout', { headers: H });
}

export async function loginAs(page: Page, username: string, password = PASSWORD) {
  const res = await page.request.post('/api/auth/login', { headers: H, data: { username, password } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  expect(body.ok, 'login needed MFA').toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

export async function registerAs(page: Page, username: string, extra: Record<string, unknown> = {}) {
  const res = await page.request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: username.charAt(0).toUpperCase() + username.slice(1), last_name: 'Marine', rank_id: 'LCpl', ...extra } });
  expect(res.ok(), await res.text()).toBeTruthy();
  await page.goto('/');
}

export async function logout(page: Page) {
  await page.request.post('/api/auth/logout', { headers: H }).catch(() => undefined);
  await page.context().clearCookies();
}

export async function confirmSudoIfAsked(page: Page) {
  const sudo = page.getByRole('dialog', { name: 'Confirm it is you' });
  try { await sudo.waitFor({ state: 'visible', timeout: 1500 }); } catch { return; }
  await sudo.getByLabel('Current password').fill(PASSWORD);
  await sudo.getByRole('button', { name: 'Confirm' }).click();
}

export const unique = (prefix: string) => `${prefix}${Date.now().toString(36).slice(-5)}`;

/** The test server's timezone (tests/browser/server.ts pins it): the calendar its "today" is reckoned in. */
export const INSTANCE_TIMEZONE = 'America/New_York';
/**
 * The day `offset` days before today as the server reckons it, YYYY-MM-DD. Not the UTC date: from 7pm Eastern (8pm in
 * summer) the UTC date is already tomorrow, a day the server refuses as one that has not come.
 */
export function instanceDay(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: INSTANCE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return new Date(Date.parse(`${get('year')}-${get('month')}-${get('day')}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
}

export async function quickLog(page: Page, text: string) {
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('What did you do?').fill(text);
  return dialog;
}

/**
 * Seat an account in a unit the way the product does: a leader (signed in on `leader`) makes a join code and the Marine
 * (signed in on `member`) joins with it. Nobody is pulled into a unit without their own step.
 */
export async function joinUnit(leader: APIRequestContext, member: APIRequestContext, unitId = 'G8') {
  const made = await leader.post(`/api/org/units/${unitId}/join-codes`, { headers: H, data: { max_uses: 1 } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { code } = await made.json();
  const joined = await member.post(`/api/org/join-codes/${encodeURIComponent(code)}/join`, { headers: H });
  expect(joined.ok(), await joined.text()).toBeTruthy();
}
