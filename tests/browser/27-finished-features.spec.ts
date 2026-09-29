import { test, expect, type Browser, type Page } from '@playwright/test';
import { ensureSetup, loginAs, confirmSudoIfAsked, unique, OPERATOR, PASSWORD } from './fixtures';

const H = { 'x-vantage-client': '1' };

/** A Marine registered on their own, then enrolled in G8 by the owner signed in on `page`. */
async function enrolledMarine(page: Page, browser: Browser, last: string) {
  const username = unique(last.toLowerCase());
  const other = await browser.newContext();
  const res = await other.request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: 'Sam', last_name: last, rank_id: 'LCpl' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const me = await (await other.request.get('/api/me')).json();
  await other.close();
  const enrolled = await page.request.post('/api/org/units/G8/members', { headers: H, data: { user_id: me.user.id } });
  expect(enrolled.ok(), await enrolled.text()).toBeTruthy();
  return { id: me.user.id as string, username };
}

test.beforeEach(async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
});

test('a leader corrects a billet and removes a Marine from the unit, told what follows first', async ({ page, browser }) => {
  const last = `Okafor${unique('')}`;
  await enrolledMarine(page, browser, last);
  await page.goto('/team?tab=roster&unit=G8');
  const row = page.getByRole('row').filter({ hasText: last });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: `Change ${last}’s billet` }).click();
  const billet = page.getByRole('dialog', { name: /billet/ });
  await billet.getByLabel('Billet').fill('Disbursing Clerk');
  await billet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Billet saved' })).toBeVisible();
  await expect(row).toContainText('Disbursing Clerk');

  await row.getByRole('button', { name: `Remove ${last} from G8` }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'signed out everywhere' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('status').filter({ hasText: `left G8` })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: last })).toHaveCount(0);
});

test('a leader assigns work nobody holds, with a note, from the item itself', async ({ page, browser }) => {
  const last = `Delgado${unique('')}`;
  const marine = await enrolledMarine(page, browser, last);
  const made = await page.request.post('/api/work/items', { headers: H, data: { unit_id: 'G8', title: `Chase the endorsement ${unique('')}` } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const item = await made.json();

  await page.goto(`/work/items/${item.id}`);
  await page.getByRole('button', { name: 'Assign' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign this' });
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: new RegExp(last) }).click();
  await dialog.getByLabel(/What they need to know/).fill('Start with the September report.');
  await dialog.getByRole('button', { name: 'Assign' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Assigned.' })).toBeVisible();
  const detail = await (await page.request.get(`/api/work/items/${item.id}`)).json();
  expect(detail.item.claimed_by).toBe(marine.id);
  await expect(page.getByRole('button', { name: 'Hand off' })).toBeVisible();
});

test('a saved queue view can be deleted, and applying one fills in its search', async ({ page }) => {
  const name = unique('Endorsements ');
  await page.goto('/work?tab=queue');
  await page.getByLabel('Search the queue').fill('endorsement');
  await page.getByRole('button', { name: 'Save this view' }).click();
  const save = page.getByRole('dialog', { name: 'Save this view' });
  await save.getByLabel('Name').fill(name);
  await save.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'View saved.' })).toBeVisible();

  await page.getByLabel('Search the queue').fill('');
  await page.getByRole('combobox', { name: 'Saved views' }).click();
  await page.getByRole('option', { name }).click();
  await expect(page.getByLabel('Search the queue')).toHaveValue('endorsement');

  await page.getByRole('button', { name: `Delete the saved view “${name}”` }).click();
  await page.getByRole('alertdialog').or(page.getByRole('dialog')).filter({ hasText: 'The work in it is not touched' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('status').filter({ hasText: `Deleted the view “${name}”` })).toBeVisible();
});

test('a contact can be corrected after it is saved', async ({ page }) => {
  const name = unique('Maj Reyes ');
  const made = await page.request.post('/api/correspondence/contacts', { headers: H, data: { name, email: 'reyes@example.mil', organization: 'DFAS', visibility: 'unit', unit_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  await page.goto('/work?tab=mail&mail=contacts');
  await page.getByRole('button', { name: `Edit ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit contact' });
  await expect(dialog.getByLabel('Name')).toHaveValue(name);
  await dialog.getByLabel('Organization').fill('DFAS Indianapolis');
  await dialog.getByRole('button', { name: 'Save contact' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Contact saved.' })).toBeVisible();
  await expect(page.getByText('DFAS Indianapolis')).toBeVisible();
});

test('the owner links an account to its EDIPI so it can sign in with a CAC', async ({ page, browser }) => {
  const last = `Nguyen${unique('')}`;
  const marine = await enrolledMarine(page, browser, last);
  await page.goto('/operator?tab=users');
  await page.getByLabel('Search accounts').fill(marine.username);
  await page.getByRole('button', { name: `EDIPI for ${marine.username}` }).click();
  const dialog = page.getByRole('dialog', { name: `EDIPI for ${marine.username}` });
  await dialog.getByLabel('EDIPI').fill(`12${Date.now().toString().slice(-8)}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('status').filter({ hasText: `EDIPI linked to ${marine.username}` })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: marine.username })).toContainText('CAC linked');
});
