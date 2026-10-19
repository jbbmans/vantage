import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, quickLog, registerAs, unique } from './fixtures';

/**
 * The Core Record Architecture screens (Task 9, ADR-0015). Nothing moves out of Activities on its own: Quick Log says
 * when an entry reads like an award or a course and offers to save it there; the Activities page lists the entries that
 * read that way for their owner to move or keep; a move keeps the entry's lineage and can be undone; and the Timeline
 * reads every kind from its own record. Each Marine here is new, so what they see is only what the test gave them.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page, include?: string) => {
  const builder = new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]');
  return serious((await (include ? builder.include(include) : builder).analyze()).violations);
};

async function signUp(page: Page, who: string) {
  await registerAs(page, unique(who));
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

async function make(page: Page, table: string, data: Record<string, unknown>) {
  const res = await page.request.post(`/api/records/${table}`, { headers: H, data: { visibility: 'private', ...data } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { id: string; version: number };
}

async function list(page: Page, table: string) {
  const res = await page.request.get(`/api/records/${table}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as Array<Record<string, unknown>>;
}

const toast = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text });

test('Quick Log says when an entry reads like an award, and Save as award files it under Records → Awards', async ({ page }) => {
  await signUp(page, 'pinned');
  const dialog = await quickLog(page, 'Received the Navy and Marine Corps Achievement Medal from the CO for the FY26 close-out');
  await expect(dialog.getByText('Reads like an award you received.')).toBeVisible();
  await expect(dialog.getByText(/Awards have their own record in Records → Awards/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep as activity' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Save as award' }).click();
  await expect(dialog).toBeHidden();
  const saved = toast(page, 'Saved to Records → Awards.');
  await expect(saved).toBeVisible();

  // It is an award, not an activity.
  const awards = await list(page, 'awards');
  expect(awards.map((a) => a.name)).toEqual(['Navy and Marine Corps Achievement Medal']);
  expect(awards[0].status).toBe('presented');
  expect((await list(page, 'activities')).length).toBe(0);

  await saved.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/career/awards\\?open=${awards[0].id}$`));
  const view = page.getByRole('dialog', { name: 'Navy and Marine Corps Achievement Medal' });
  await expect(view).toBeVisible();
  await expect(view.getByText('Presented', { exact: true }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Navy and Marine Corps Achievement Medal', level: 3 })).toBeVisible();
});

test('Quick Log saves a course as training, and Open opens that course under Training & Development → Training', async ({ page }) => {
  await signUp(page, 'course');
  const dialog = await quickLog(page, 'Completed the Sergeants Course distance education program');
  await expect(dialog.getByText('Reads like training you completed.')).toBeVisible();
  await expect(dialog.getByText(/Courses, PME and qualifications have their own record in Training & Development → Training/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save as training' }).click();
  await expect(dialog).toBeHidden();
  const saved = toast(page, 'Saved to Training & Development → Training.');
  await expect(saved).toBeVisible();
  const trainings = await list(page, 'trainings');
  expect(trainings.map((t) => [t.title, t.type, t.status])).toEqual([['Completed the Sergeants Course distance education program', 'pme', 'completed']]);
  expect((await list(page, 'activities')).length).toBe(0);

  await saved.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/career/training\\?open=${trainings[0].id}$`));
  await expect(page.getByRole('dialog', { name: 'Completed the Sergeants Course distance education program' })).toBeVisible();
});

test('Quick Log keeps an ordinary entry an activity and says nothing about awards', async ({ page }) => {
  await signUp(page, 'plain');
  const dialog = await quickLog(page, 'Reconciled 30 ULOs totaling $1,118.38 in DAI');
  await expect(dialog.getByLabel('Action amount')).toHaveValue('30');
  await expect(dialog.getByText(/Reads like/)).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^Save as / })).toHaveCount(0);

  // An award-like line, kept as an activity on purpose, saves as one.
  await dialog.getByLabel('What did you do?').fill('Received a challenge coin from the Sergeant Major');
  await expect(dialog.getByText('Reads like an award you received.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep as activity' }).click();
  await expect(dialog.getByText('Reads like an award you received.')).toHaveCount(0);
  await expect(dialog.getByLabel('What did you do?')).toBeFocused();
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(toast(page, 'Activity logged.')).toBeVisible();
  expect((await list(page, 'activities')).map((a) => a.title)).toEqual(['Received a challenge coin from the Sergeant Major']);
  expect((await list(page, 'awards')).length).toBe(0);
  // Kept on purpose, it is not offered for a move later.
  const offered = await page.request.get('/api/record/move-candidates');
  expect(offered.ok(), await offered.text()).toBeTruthy();
  expect((await offered.json()).candidates).toEqual([]);
});

test('the Activities suggestions move an award-like entry to Awards, and Undo brings it back', async ({ page }) => {
  await signUp(page, 'mover');
  const coin = await make(page, 'activities', { title: 'Received a challenge coin from the Sergeant Major', date: '2026-09-12', result: 'for the audit close-out' });
  await make(page, 'activities', { title: 'Reconciled 30 ULOs in DAI', date: '2026-09-10', quantity: 30, unit_label: 'ULOs', result: 'cleared the backlog' });

  await page.goto('/record/activities?period=all');
  const suggestions = page.getByRole('region', { name: 'One of your activities reads like an award' });
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole('listitem')).toHaveCount(1);
  const entry = suggestions.getByRole('listitem').filter({ hasText: 'Received a challenge coin' });
  await expect(entry).toContainText('Reads like an award you received.');
  // The ordinary entry is not suggested.
  await expect(suggestions).not.toContainText('Reconciled 30 ULOs');

  await entry.getByRole('button', { name: 'Move to Awards' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to another record type' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /An award/ })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByRole('radio', { name: /Training/ })).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByLabel('Award', { exact: true })).toHaveValue('Received a challenge coin from the Sergeant Major');
  await expect(dialog.getByRole('combobox', { name: 'Type' })).toHaveText(/Coin/);
  await expect(dialog.getByText('for the audit close-out')).toBeVisible();
  await dialog.getByLabel('Award', { exact: true }).fill('Challenge coin from the Sergeant Major');
  await dialog.getByRole('button', { name: 'Move to Awards' }).click();
  await expect(dialog).toBeHidden();

  const moved = toast(page, 'Moved to Awards.');
  await expect(moved).toBeVisible();
  await expect(suggestions).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Received a challenge coin/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Reconciled 30 ULOs in DAI/ })).toBeVisible();
  const awards = await list(page, 'awards');
  expect(awards.map((a) => [a.name, a.type])).toEqual([['Challenge coin from the Sergeant Major', 'coin']]);

  await moved.getByRole('button', { name: 'Undo' }).click();
  await expect(toast(page, 'Move undone. It is back in Activities.')).toBeVisible();
  const back = page.getByRole('link', { name: /Received a challenge coin from the Sergeant Major/ });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute('href', `/records/${coin.id}`);
  expect((await list(page, 'awards')).length).toBe(0);
  // Put back by its owner, it is work they did: it is not suggested again.
  await expect(page.getByRole('region', { name: /of your activities read/ })).toHaveCount(0);

  await back.click();
  await expect(page.getByRole('heading', { name: 'Received a challenge coin from the Sergeant Major' })).toBeVisible();
  const lineage = page.getByRole('region', { name: 'Where this entry came from' });
  await expect(lineage).toContainText('Moved back here from Awards');
  await expect(lineage).toContainText('Moved from Activities to Awards');
});

test('Keep as activity takes an entry off the suggestions for good', async ({ page }) => {
  await signUp(page, 'keeper');
  await make(page, 'activities', { title: 'Received a challenge coin from the Sergeant Major', date: '2026-09-12' });
  await make(page, 'activities', { title: 'Completed the Sergeants Course distance education program', date: '2026-08-02' });

  await page.goto('/record/activities?period=all');
  const suggestions = page.getByRole('region', { name: '2 of your activities read like awards or training' });
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole('listitem')).toHaveCount(2);
  const course = suggestions.getByRole('listitem').filter({ hasText: 'Sergeants Course' });
  await expect(course.getByRole('button', { name: 'Move to Training' })).toBeVisible();

  await suggestions.getByRole('listitem').filter({ hasText: 'challenge coin' }).getByRole('button', { name: 'Keep as activity' }).click();
  await expect(toast(page, 'Kept as an activity. It will not be suggested again.')).toBeVisible();
  const left = page.getByRole('region', { name: 'One of your activities reads like training' });
  await expect(left).toBeVisible();
  await expect(left.getByRole('listitem')).toHaveCount(1);
  await expect(left).not.toContainText('challenge coin');
  // It stays an activity, and stays off the list after a reload.
  await expect(page.getByRole('link', { name: 'Received a challenge coin from the Sergeant Major' }).first()).toBeVisible();
  await page.reload();
  await expect(left.getByRole('listitem')).toHaveCount(1);
  await expect(left).toContainText('Sergeants Course');

  // Hidden, the list stays folded away for this Marine.
  await left.getByRole('button', { name: 'Hide suggestions' }).click();
  await expect(left.getByRole('listitem')).toHaveCount(0);
  await page.reload();
  await expect(left.getByRole('button', { name: 'Show suggestions' })).toHaveAttribute('aria-expanded', 'false');
});

test('the New activity form saves an award-like title as an award or keeps it, and a spreadsheet import says which rows read that way', async ({ page }) => {
  await signUp(page, 'importer');
  await page.goto('/record/activities?period=all');
  await page.getByRole('button', { name: 'New activity' }).click();
  const form = page.getByRole('dialog', { name: 'New activity' });
  const title = form.getByRole('textbox', { name: 'Title' });
  await title.fill('Received the Navy and Marine Corps Achievement Medal from the CO');
  await expect(form.getByText('Reads like an award you received.')).toBeVisible();
  await form.getByRole('button', { name: 'Save as award' }).click();
  await expect(form).toBeHidden();
  await expect(toast(page, 'Saved to Records → Awards.')).toBeVisible();
  const awards = await list(page, 'awards');
  expect(awards.map((a) => a.name)).toEqual(['Navy and Marine Corps Achievement Medal']);
  // The title's own words stay with the award it was named from.
  expect(awards[0].notes).toBe('Received the Navy and Marine Corps Achievement Medal from the CO');
  expect((await list(page, 'activities')).length).toBe(0);

  // Kept as an activity on purpose, it saves as one and is not suggested for a move later.
  await page.getByRole('button', { name: 'New activity' }).click();
  await expect(form).toBeVisible();
  await title.fill('Coined by the Sergeant Major for the audit close-out');
  await expect(form.getByText('Reads like an award you received.')).toBeVisible();
  await form.getByRole('button', { name: 'Keep as activity' }).click();
  await expect(form.getByText('Reads like an award you received.')).toHaveCount(0);
  await expect(title).toBeFocused();
  await form.getByRole('button', { name: 'Add activity' }).click();
  await expect(form).toBeHidden();
  await expect(toast(page, 'Activity added.')).toBeVisible();
  expect((await list(page, 'activities')).map((a) => a.title)).toEqual(['Coined by the Sergeant Major for the audit close-out']);

  const csv = 'Date,Title,Result\n2026-09-01,Received a challenge coin from the Sergeant Major,\n2026-09-02,Completed the Sergeants Course distance education program,\n2026-09-03,Reconciled 30 ULOs in DAI,cleared the backlog\n';
  await page.getByRole('button', { name: 'Import activities' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import activities from CSV' });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await dialog.getByRole('button', { name: /Import 3 rows/ }).click();
  // The dialog stays open to say so, and nothing moved: all three are activities.
  await expect(dialog.getByText(/2 rows read like an award you received or training you completed\. They are in your Activities for now\./)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  expect((await list(page, 'activities')).length).toBe(4);
  expect((await list(page, 'awards')).length + (await list(page, 'trainings')).length).toBe(1);
  await dialog.getByRole('link', { name: 'Review them in Activities' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/record\/activities$/);
  const suggestions = page.getByRole('region', { name: '2 of your activities read like awards or training' });
  await expect(suggestions.getByRole('listitem')).toHaveCount(2);
  await expect(suggestions).not.toContainText('Reconciled 30 ULOs');
  await expect(suggestions).not.toContainText('Coined by');
});

test('Move to… on an entry’s page makes it training, which opens at /career/training?open=<id>, and the move reads cleanly', async ({ page }) => {
  await signUp(page, 'student');
  const course = await make(page, 'activities', { title: 'Completed Corporals Course via MarineNet', date: '2026-09-05', quantity: 40, unit_label: 'hours', organization: 'MarineNet', result: 'graduated with honors' });

  // Once it has moved, its old page stops asking for it rather than fetching a 404 and saying it is not available.
  const missing: string[] = [];
  page.on('response', (r) => { if (r.status() === 404 && r.url().endsWith(`/api/records/activities/${course.id}`)) missing.push(r.url()); });
  await page.goto(`/records/${course.id}`);
  await expect(page.getByRole('heading', { name: 'Completed Corporals Course via MarineNet' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Where this entry came from' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Move to…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Move to another record type' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Training/ })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByText('Reads like training you completed.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue('Completed Corporals Course via MarineNet');
  await expect(dialog.getByRole('combobox', { name: 'Type' })).toHaveText('PME');
  await expect(dialog.getByRole('combobox', { name: 'Status' })).toHaveText('Completed');
  await expect(dialog.getByLabel('Hours')).toHaveValue('40');
  await expect(dialog.getByText('MarineNet', { exact: true })).toBeVisible();
  expect(await axe(page, '[role="dialog"]')).toEqual([]);

  // The title is required, and the dialog says so.
  await dialog.getByRole('textbox', { name: 'Title' }).fill('');
  await dialog.getByRole('button', { name: 'Move to Training' }).click();
  await expect(dialog.getByText('A title is required.')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Title' }).fill('Corporals Course (DEP)');
  await dialog.getByRole('textbox', { name: 'Why you are moving it' }).fill('It was PME, not work I did');
  await dialog.getByRole('button', { name: 'Move to Training' }).click();

  await expect(page).toHaveURL(/\/career\/training\?open=[^&]+$/);
  const trainingId = new URL(page.url()).searchParams.get('open');
  expect(trainingId).toBeTruthy();
  expect(trainingId).not.toBe(course.id);
  const view = page.getByRole('dialog', { name: 'Corporals Course (DEP)' });
  await expect(view).toBeVisible();
  await expect(view.getByText('PME', { exact: true })).toBeVisible();
  await expect(view.getByText('MarineNet', { exact: true })).toBeVisible();
  const lineage = view.getByRole('region', { name: 'Where this entry came from' });
  await expect(lineage).toContainText('Moved here from Activities');
  await expect(lineage).toContainText('“It was PME, not work I did”');
  const trainings = await list(page, 'trainings');
  expect(trainings.map((t) => [t.id, t.title, t.type, t.hours])).toEqual([[trainingId, 'Corporals Course (DEP)', 'pme', 40]]);
  expect((await list(page, 'activities')).length).toBe(0);
  expect(missing).toEqual([]);
  expect(await axe(page, '[role="dialog"]')).toEqual([]);

  // Undo from its history puts the activity back, on its own page, as it was.
  await lineage.getByRole('button', { name: 'Undo move' }).click();
  await expect(page).toHaveURL(new RegExp(`/records/${course.id}$`));
  await expect(page.getByRole('heading', { name: 'Completed Corporals Course via MarineNet' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Where this entry came from' })).toContainText('Moved back here from Training');
  expect((await list(page, 'trainings')).length).toBe(0);
});

test('the Timeline lists each kind from its own record, filters by kind, and reads cleanly', async ({ page }) => {
  await signUp(page, 'historian');
  const activity = await make(page, 'activities', { title: 'Reconciled 30 ULOs in DAI', date: '2026-09-20', quantity: 30, unit_label: 'ULOs', result: 'cleared the backlog' });
  const pme = await make(page, 'trainings', { title: 'Corporals Course', date: '2026-08-15', type: 'pme', hours: 40, status: 'completed' });
  await make(page, 'trainings', { title: 'Records Management Course', date: '2026-08-02', type: 'course', hours: 8, provider: 'MarineNet', status: 'completed' });
  const award = await make(page, 'awards', { name: 'Navy and Marine Corps Achievement Medal', date: '2026-07-01', type: 'personal_award', status: 'presented', presented_at: '2026-07-04' });
  await make(page, 'awards', { name: 'Coin from the Sergeant Major', date: '2026-06-20', type: 'coin', status: 'presented' });
  await make(page, 'counselings', { summary: 'Notes from my quarterly counseling', date: '2026-06-01', type: 'quarterly', counselor_name: 'SSgt Reyes' });

  await page.goto('/record');
  await page.getByRole('link', { name: 'Timeline' }).first().click();
  await expect(page).toHaveURL(/\/record\/timeline$/);
  await expect(page.getByRole('heading', { name: 'Timeline', level: 1 })).toBeVisible();

  const kinds = page.getByRole('group', { name: 'Kinds of record' });
  const chip = (name: string) => kinds.getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
  await expect(chip('Everything')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('Everything')).toContainText('6');
  for (const [name, n] of [['Activities', 1], ['Training', 1], ['PME', 1], ['Awards', 1], ['Recognition', 1], ['Counselings', 1]] as const) {
    await expect(chip(name), name).toContainText(String(n));
  }
  // Nothing in a kind it does not have: no Goals reached, no Certifications.
  await expect(kinds.getByRole('button', { name: /^Goals reached/ })).toHaveCount(0);
  await expect(kinds.getByRole('button', { name: /^Certifications/ })).toHaveCount(0);

  const entries = page.locator('main ol > li');
  await expect(entries).toHaveCount(6);
  for (const month of ['September 2026', 'August 2026', 'July 2026', 'June 2026']) await expect(page.getByRole('heading', { name: month, level: 2 })).toBeVisible();
  // Newest first, each linked to its own record.
  await expect(entries.first()).toContainText('Reconciled 30 ULOs in DAI');
  await expect(page.getByRole('link', { name: /Reconciled 30 ULOs in DAI/ })).toHaveAttribute('href', `/records/${activity.id}`);
  await expect(page.getByRole('link', { name: /Corporals Course/ })).toHaveAttribute('href', `/career/training?open=${pme.id}`);
  await expect(page.getByRole('link', { name: /Navy and Marine Corps Achievement Medal/ })).toHaveAttribute('href', `/career/awards?open=${award.id}`);
  await expect(page.getByRole('link', { name: /Quarterly counseling/ })).toContainText('by SSgt Reyes');
  await expect(page.getByText(/not on your timeline yet, because Vantage does not record/)).toBeVisible();
  expect(await axe(page)).toEqual([]);

  await chip('Awards').click();
  await expect(page).toHaveURL(/kind=award$/);
  await expect(chip('Awards')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip('Everything')).toHaveAttribute('aria-pressed', 'false');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Navy and Marine Corps Achievement Medal');

  // While the next kind is on its way, the last kind's entries are neither shown as its own nor read as none of it.
  const pmeAsked = /\/api\/record\/timeline\?.*kind=pme/;
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  await page.route(pmeAsked, async (route) => { await answered; await route.continue(); });
  await chip('PME').click();
  await expect(chip('PME')).toHaveAttribute('aria-pressed', 'true');
  await expect(entries).toHaveCount(0);
  await expect(page.getByText(/No pme in these dates/i)).toHaveCount(0);
  answer();
  await expect(entries).toHaveCount(1);
  await page.unroute(pmeAsked);
  await expect(entries.first()).toContainText('Corporals Course');
  await expect(page.getByRole('link', { name: /Records Management Course/ })).toHaveCount(0);

  await chip('Training').click();
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Records Management Course');
  await expect(entries.first()).toContainText('MarineNet');

  await chip('Counselings').click();
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Quarterly counseling');
  expect(await axe(page)).toEqual([]);

  await chip('Everything').click();
  await expect(page).toHaveURL(/\/record\/timeline$/);
  await expect(entries).toHaveCount(6);

  // A date window narrows every kind at once, and the counts follow it.
  await page.getByLabel('From', { exact: true }).fill('2026-08-01');
  await expect(entries).toHaveCount(3);
  await expect(chip('Everything')).toContainText('3');
  await expect(kinds.getByRole('button', { name: /^Awards/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear dates' }).click();
  await expect(entries).toHaveCount(6);

  // Opening an entry opens its own record.
  await page.getByRole('link', { name: /Navy and Marine Corps Achievement Medal/ }).click();
  await expect(page).toHaveURL(new RegExp(`/career/awards\\?open=${award.id}$`));
  await expect(page.getByRole('dialog', { name: 'Navy and Marine Corps Achievement Medal' })).toBeVisible();
});
