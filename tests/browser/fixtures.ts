import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const PASSWORD = 'cobalt-orbit-velvet-anchor-927';
export const OPERATOR = { username: 'boletz', first_name: 'John', last_name: 'Boletz', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' };
const H = { 'x-vantage-client': '1' };

/** Idempotent: creates the owner account through the API if the instance is still empty. */
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

/** Step-up auth is only demanded once the sign-in grace period has passed; answer it if it appears. */
export async function confirmSudoIfAsked(page: Page) {
  const sudo = page.getByRole('dialog', { name: 'Confirm it is you' });
  try { await sudo.waitFor({ state: 'visible', timeout: 1500 }); } catch { return; }
  await sudo.getByLabel('Current password').fill(PASSWORD);
  await sudo.getByRole('button', { name: 'Confirm' }).click();
}

export const unique = (prefix: string) => `${prefix}${Date.now().toString(36).slice(-5)}`;

export async function quickLog(page: Page, text: string) {
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('What did you do?').fill(text);
  return dialog;
}
