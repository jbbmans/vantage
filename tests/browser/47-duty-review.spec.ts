import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Duty review (Task 18, ADR-0024). Duty a Marine submitted waits under To review for the people who review it. A reviewer
 * approves it, returns it with a reason or rejects it with one; the Marine reads the reason, corrects a returned duty and
 * it goes back by itself. Calculated points and approved points stand side by side, points apart from the calculated
 * ones take a reason, and every decision is in the duty's review history. Nobody decides their own duty by reviewing:
 * approving one's own takes a role that names it, which someone else grants. Every view reads cleanly to assistive
 * technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const VIEW_UNIT = 1, APPROVE_OWN_DUTY = 1 << 20;
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const closeDialogs = async (page: Page) => { await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); };

/** The G-8 operator (its Unit Leader), signed in on a page of their own, with duty types and a scoring version in force. */
async function leader(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await loginAs(page, OPERATOR.username);
  const types = await page.request.post('/api/orgs/G8/duty-types/standard', { headers: H });
  expect(types.ok(), await types.text()).toBeTruthy();
  const scoring = await page.request.post('/api/__test/duty-scoring?org=G8', { headers: H });
  expect(scoring.ok(), await scoring.text()).toBeTruthy();
  return { context, page };
}

/** Records a duty over the API as whoever `page` is signed in as, for themselves or for a Marine they lead: 0800 to 1600 on a day of its own, three points. */
async function stand(page: Page, code: string, title: string, offset: number, forMarine?: string) {
  const options = await (await page.request.get('/api/record/duty/options')).json();
  const type = (options.types as Array<{ id: string; code: string }>).find((t) => t.code === code);
  expect(type, `duty type ${code}`).toBeTruthy();
  const res = await page.request.post('/api/records/duties', { headers: H, data: { duty_type_id: type!.id, unit_id: 'G8', title, date: day(offset), start_time: '0800', end_date: day(offset), end_time: '1600', visibility: 'unit', ...(forMarine ? { user_id: forMarine } : {}) } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = await res.json();
  expect(body.calculated_points, 'scored under the version in force').toBe(3);
  return body as { id: string; version: number };
}

test('a reviewer approves, returns and rejects duty waiting for review; the Marine corrects what was returned; points apart from the calculated ones take a reason', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const lead = await leader(browser);
  await registerAs(page, unique('reviewed'));
  await joinUnit(lead.page.request, page.request);
  const tag = unique('rv');
  const A = `DNCO ${tag}`, B = `SAF ${tag}`, C = `Barracks ${tag}`;
  await stand(page, 'DNCO', A, 3);
  await stand(page, 'SAF', B, 4);
  await stand(page, 'BARRACKS', C, 5);

  // The Marine: three duties submitted, nine points calculated, none counted yet, and no decision of theirs to make.
  await page.goto('/record/duty');
  await expect(page.getByRole('heading', { name: 'Duty', level: 1 })).toBeVisible();
  await expect(page.getByText('9 calculated')).toBeVisible();
  const mineA = page.getByRole('row').filter({ hasText: A });
  await expect(mineA).toContainText('Submitted');
  await expect(mineA).toContainText('Not counted');
  await expect(page.getByRole('tab', { name: /^To review/ })).toHaveCount(0);
  await mineA.getByRole('button', { name: 'View' }).click();
  const own = page.getByRole('dialog', { name: A });
  await expect(own).toContainText('Waiting for review. It counts once a reviewer approves it.');
  await expect(own.getByRole('button', { name: /Approve|Return|Reject/ })).toHaveCount(0);
  await closeDialogs(page);

  // The reviewer is told what waits, and works the queue from the longest-waiting.
  await lead.page.goto('/record/duty');
  const waitingNotice = lead.page.getByRole('region', { name: 'Duty waiting for your review' });
  await expect(waitingNotice).toContainText(/waiting for your review/);
  await waitingNotice.getByRole('button', { name: /^Review (it|them)$/ }).click();
  await expect(lead.page.getByRole('tab', { name: /^To review \(\d+\)$/ })).toHaveAttribute('aria-selected', 'true');
  const queued = (title: string) => lead.page.getByRole('row').filter({ hasText: title });
  await expect(queued(A)).toBeVisible();
  await expect(queued(B)).toBeVisible();
  await expect(queued(C)).toBeVisible();
  expect(await axe(lead.page), 'the review queue').toEqual([]);

  // Approved at its calculated points, in one step.
  await queued(A).getByRole('button', { name: `Approve ${A} for 3 points` }).click();
  await toast(lead.page, 'Approved for 3 points.');
  await expect(queued(A)).toHaveCount(0);

  // Returned: it says why, and without a reason nothing is sent.
  await queued(B).getByRole('button', { name: `Return ${B} for correction` }).click();
  const returning = lead.page.getByRole('dialog', { name: 'Return for correction' });
  await expect(returning).toContainText('They read what you write here.');
  expect(await axe(lead.page), 'the return dialog').toEqual([]);
  await returning.getByRole('button', { name: 'Return it' }).click();
  await expect(returning.getByRole('alert')).toContainText('Required.');
  await returning.getByLabel('What needs correcting').fill('Give the time you were relieved, not the scheduled end.');
  await returning.getByRole('button', { name: 'Return it' }).click();
  await toast(lead.page, 'Returned for correction.');
  await expect(queued(B)).toHaveCount(0);

  // Rejected from the duty itself, where every decision open to the reviewer is offered and the history is kept.
  await queued(C).getByRole('button', { name: C, exact: true }).click();
  const deciding = lead.page.getByRole('dialog', { name: C });
  const decision = deciding.getByRole('region', { name: 'Your decision' });
  for (const name of [/^Approve .* for 3 points$/, 'Different points…', /^Return .* for correction$/, /^Reject /]) await expect(decision.getByRole('button', { name })).toBeVisible();
  expect(await axe(lead.page), 'a duty with its decision').toEqual([]);
  await decision.getByRole('button', { name: /^Reject / }).click();
  const rejecting = lead.page.getByRole('dialog', { name: 'Reject this duty' });
  await rejecting.getByLabel('Why it is rejected').fill('Not on the duty roster for that day.');
  await rejecting.getByRole('button', { name: 'Reject it' }).click();
  await toast(lead.page, 'Rejected.');
  await expect(deciding).toContainText('Rejected');
  const history = deciding.getByRole('region', { name: 'Review history' });
  await expect(history).toContainText('Rejected by You');
  await expect(history).toContainText('Not on the duty roster for that day.');
  // A decision is taken back with a reason, and the duty waits again.
  await decision.getByRole('button', { name: 'Reopen…' }).click();
  const reopening = lead.page.getByRole('dialog', { name: 'Reopen for review' });
  await reopening.getByLabel('Why it is reopened').fill('The roster was amended.');
  await reopening.getByRole('button', { name: 'Reopen it' }).click();
  await toast(lead.page, 'Reopened. It waits for review again.');
  await expect(history).toContainText('Reopened for review by You');
  await decision.getByRole('button', { name: /^Approve .* for 3 points$/ }).click();
  await toast(lead.page, 'Approved for 3 points.');
  await expect(history).toContainText('3 points, as scored under version');
  await closeDialogs(lead.page);

  // The Marine reads why it came back, corrects it, and it goes back for review with the correction.
  await page.goto('/record/duty');
  await expect(page.getByText('1 returned to you')).toBeVisible();
  const mineB = page.getByRole('row').filter({ hasText: B });
  await expect(mineB).toContainText('Returned');
  await mineB.getByRole('button', { name: 'View' }).click();
  const returned = page.getByRole('dialog', { name: B });
  await expect(returned).toContainText('Give the time you were relieved, not the scheduled end.');
  await expect(returned.getByRole('region', { name: 'Review history' })).toContainText(/Returned for correction by (\S+ )?Boletz/);
  const itsReview = returned.getByRole('region', { name: 'Its review' });
  await expect(itsReview.getByRole('button', { name: 'Send back as it is' })).toBeVisible();
  expect(await axe(page), 'a returned duty').toEqual([]);
  await itsReview.getByRole('button', { name: 'Correct it' }).click();
  const correcting = page.getByRole('dialog', { name: 'Correct this duty' });
  await expect(correcting.getByRole('region', { name: /Returned for correction by (\S+ )?Boletz/ })).toContainText('Give the time you were relieved');
  await correcting.getByLabel('End time').fill('1700');
  expect(await axe(page), 'the correction form').toEqual([]);
  await correcting.getByRole('button', { name: 'Save and send back' }).click();
  await toast(page, 'Corrected and sent back for review.');
  const resent = page.getByRole('dialog', { name: B });
  await expect(resent).toContainText('Submitted');
  await expect(resent.getByRole('region', { name: 'Review history' })).toContainText('Submitted again by You');
  await closeDialogs(page);

  // Back in the queue. Approved at other points: the points and the reason are both asked for, and both are kept.
  await lead.page.goto('/record/duty?who=review');
  await queued(B).getByRole('button', { name: B, exact: true }).click();
  const again = lead.page.getByRole('dialog', { name: B });
  await again.getByRole('region', { name: 'Your decision' }).getByRole('button', { name: 'Different points…' }).click();
  const override = lead.page.getByRole('dialog', { name: 'Approve with different points' });
  await expect(override).toContainText('The scoring gave this duty 3 points');
  await override.getByRole('button', { name: 'Approve' }).click();
  await expect(override.getByRole('alert')).toHaveCount(2);
  await override.getByLabel('Approved points').fill('lots');
  await override.getByLabel('Why these points').fill('Stood on two hours’ notice.');
  await override.getByRole('button', { name: 'Approve' }).click();
  await expect(override.getByRole('alert')).toContainText('A number from 0 to 100,000.');
  await override.getByLabel('Approved points').fill('5');
  expect(await axe(lead.page), 'the override dialog').toEqual([]);
  await override.getByRole('button', { name: 'Approve' }).click();
  await toast(lead.page, 'Approved.');
  await expect(again).toContainText('set apart from the calculated points by you');
  await expect(again).toContainText('Stood on two hours’ notice.');
  await expect(again.getByRole('region', { name: 'Review history' })).toContainText('5 points, set apart from the calculated 3 points');
  // Changed afterwards, the same way.
  await again.getByRole('region', { name: 'Your decision' }).getByRole('button', { name: 'Change points…' }).click();
  const changing = lead.page.getByRole('dialog', { name: 'Change approved points' });
  await expect(changing.getByLabel('Approved points')).toHaveValue('5');
  await changing.getByLabel('Approved points').fill('4');
  await changing.getByLabel('Why the points change').fill('One hour of it was on the roster.');
  await changing.getByRole('button', { name: 'Change points' }).click();
  await toast(lead.page, 'Approved points changed.');
  await expect(again.getByRole('region', { name: 'Review history' })).toContainText('now 4 points; the scoring gave 3 points');
  await closeDialogs(lead.page);

  // The Marine: calculated and approved side by side, and what counts is what was approved.
  await page.goto('/record/duty');
  await expect(page.getByText('9 calculated')).toBeVisible();
  const approvedB = page.getByRole('row').filter({ hasText: B });
  await expect(approvedB).toContainText('Approved');
  await expect(approvedB).toContainText('override');
  await approvedB.getByRole('button', { name: 'View' }).click();
  const final = page.getByRole('dialog', { name: B });
  await expect(final).toContainText(/set apart from the calculated points by (\S+ )?Boletz/);
  await expect(final).toContainText('One hour of it was on the roster.');
  await expect(final).toContainText('stays as it was decided unless a reviewer reopens it');
  await expect(final.getByRole('button', { name: /Edit|Correct|Approve|Reopen|Change points/ })).toHaveCount(0);
  expect(await axe(page), 'an approved duty').toEqual([]);
  await closeDialogs(page);

  // The Marine's page carries the same decisions for the reviewer.
  const me = await (await page.request.get('/api/me')).json();
  const extra = await stand(page, 'DNCO', `Later ${tag}`, 6);
  await lead.page.goto(`/team/${me.user?.id ?? me.id}?tab=duty`);
  const onPage = lead.page.getByRole('row').filter({ hasText: `Later ${tag}` });
  await expect(onPage).toContainText('Submitted');
  await onPage.getByRole('button', { name: 'Review' }).click();
  const fromPage = lead.page.getByRole('dialog', { name: `Later ${tag}` });
  await fromPage.getByRole('region', { name: 'Your decision' }).getByRole('button', { name: /^Approve .* for 3 points$/ }).click();
  await toast(lead.page, 'Approved for 3 points.');
  await expect(fromPage.getByRole('region', { name: 'Review history' })).toContainText('Approved by You');
  await closeDialogs(lead.page);
  await expect(lead.page.getByRole('row').filter({ hasText: `Later ${tag}` })).toContainText('Approved');
  expect(await axe(lead.page), 'the Marine’s duty tab').toEqual([]);
  expect(extra.id).toBeTruthy();

  // An approval that carries a note shows it as the reviewer's note, never as a reason it was rejected.
  const noted = await stand(page, 'DNCO', `Noted ${tag}`, 8);
  const note = await lead.page.request.post(`/api/records/duties/${noted.id}/review`, { headers: H, data: { action: 'approve', reason: 'Relieved on time.', version: noted.version } });
  expect(note.ok(), await note.text()).toBeTruthy();
  await page.goto('/record/duty');
  await page.getByRole('row').filter({ hasText: `Noted ${tag}` }).getByRole('button', { name: 'View' }).click();
  const notedView = page.getByRole('dialog', { name: `Noted ${tag}` });
  await expect(notedView).toContainText('Reviewer’s note');
  await expect(notedView).toContainText('Relieved on time.');
  await expect(notedView).not.toContainText('Why it was rejected');
  await closeDialogs(page);

  // Deciding a duty from the queue takes its row away. Focus goes to the next duty waiting, so a reviewer working down
  // the list by keyboard keeps their place.
  await stand(page, 'DNCO', `First ${tag}`, 9);
  await stand(page, 'DNCO', `Second ${tag}`, 10);
  await stand(lead.page, 'SAF', `Recorded ${tag}`, 11, me.user?.id ?? me.id);
  await lead.page.goto('/record/duty?who=review');
  const waitingGroup = lead.page.getByRole('group', { name: 'Duty waiting for your review' });
  const duties = waitingGroup.locator('tbody tr td:first-child button');
  await expect(duties.filter({ hasText: `First ${tag}` })).toBeVisible();
  const order = await duties.allTextContents();
  const next = order[order.indexOf(`First ${tag}`) + 1];
  expect(next, 'a duty waits after it').toBeTruthy();
  await waitingGroup.getByRole('button', { name: `Approve First ${tag} for 3 points` }).click();
  await toast(lead.page, 'Approved for 3 points.');
  await expect(duties.filter({ hasText: `First ${tag}` })).toHaveCount(0);
  await expect(duties.filter({ hasText: next }).first()).toBeFocused();

  // A duty its reviewer recorded for the Marine is the reviewer's to correct, and returning it says so. After the
  // dialog closes and the row goes, focus is still in the queue.
  await waitingGroup.getByRole('button', { name: `Return Recorded ${tag} for correction` }).click();
  const ownReturn = lead.page.getByRole('dialog', { name: 'Return for correction' });
  await expect(ownReturn).toContainText('You recorded this duty for');
  await expect(ownReturn).toContainText('it comes back to you to correct');
  await ownReturn.getByLabel('What needs correcting').fill('The post was the gate, not the barracks.');
  await ownReturn.getByRole('button', { name: 'Return it' }).click();
  await toast(lead.page, 'Returned for correction.');
  await expect(duties.filter({ hasText: `Recorded ${tag}` })).toHaveCount(0);
  await expect.poll(() => lead.page.evaluate(() => {
    const group = document.querySelector('[aria-label="Duty waiting for your review"]');
    return Boolean(group && document.activeElement && group.contains(document.activeElement));
  }), { message: 'focus stays in the queue' }).toBe(true);
  expect(await axe(lead.page), 'the queue after a decision').toEqual([]);

  // A phone: the queue and a decision fit.
  await stand(page, 'SAF', `Phone ${tag}`, 7);
  await lead.page.setViewportSize({ width: 390, height: 844 });
  await lead.page.goto('/record/duty?who=review');
  await expect(lead.page.getByRole('tab', { name: /^To review/ })).toHaveAttribute('aria-selected', 'true');
  await expect(lead.page.getByRole('row').filter({ hasText: `Phone ${tag}` })).toBeVisible();
  await noSidewaysScroll(lead.page, 'the review queue');
  await lead.page.getByRole('row').filter({ hasText: `Phone ${tag}` }).getByRole('button', { name: `Return Phone ${tag} for correction` }).click();
  await expect(lead.page.getByRole('dialog', { name: 'Return for correction' })).toBeVisible();
  await noSidewaysScroll(lead.page, 'the return dialog');
  await lead.context.close();
});

test('nobody decides their own duty by reviewing; a role that names Approve own duty, granted by someone else, lets its holder approve theirs', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const lead = await leader(browser);
  const username = unique('selfap');
  await registerAs(page, username);
  await joinUnit(lead.page.request, page.request);
  const tag = unique('own');

  // The Unit Leader reviews everyone's duty but their own: no decision on it, and it is not in their queue.
  const mine = await stand(lead.page, 'DNCO', `Leader ${tag}`, 3);
  await lead.page.goto(`/record/duty?open=${mine.id}`);
  const leaders = lead.page.getByRole('dialog', { name: `Leader ${tag}` });
  await expect(leaders).toContainText('Waiting for review');
  await expect(leaders.getByRole('button', { name: /Approve|Return|Reject|Different points/ })).toHaveCount(0);
  await closeDialogs(lead.page);
  await lead.page.goto('/record/duty?who=review');
  await expect(lead.page.getByRole('tab', { name: /^To review/ })).toHaveAttribute('aria-selected', 'true');
  await expect(lead.page.getByRole('row').filter({ hasText: `Leader ${tag}` })).toHaveCount(0);
  const refused = await lead.page.request.post(`/api/records/duties/${mine.id}/review`, { headers: H, data: { action: 'approve', version: 1 } });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('duty_own_review');

  // The role editor names the three duty permissions, and marks the one that removes the second reviewer.
  await lead.page.goto('/team/roles');
  await lead.page.getByRole('button', { name: 'New role' }).click();
  const editor = lead.page.getByRole('dialog', { name: 'New role' });
  const dutyGroup = editor.getByRole('group', { name: 'Duty' });
  for (const name of [/^Review duty/, /^Override duty points/, /^Approve own duty/]) await expect(dutyGroup.getByRole('checkbox', { name })).toBeVisible();
  await expect(dutyGroup).toContainText('nobody gives it to themselves');
  await expect(dutyGroup.getByRole('checkbox', { name: /^Approve own duty/ })).toBeEnabled();
  expect(await axe(lead.page), 'the role editor').toEqual([]);
  await closeDialogs(lead.page);
  // A role names it when it is made. One that exists never gains it, a standard role included: the box is closed there.
  await lead.page.getByRole('article').filter({ has: lead.page.getByRole('heading', { name: 'SNCO', exact: true }) }).getByRole('button', { name: 'Edit' }).click();
  const existing = lead.page.getByRole('dialog', { name: 'Edit SNCO' }).getByRole('group', { name: 'Duty' });
  await expect(existing.getByRole('checkbox', { name: /^Approve own duty/ })).toBeDisabled();
  await expect(existing.getByRole('checkbox', { name: /^Review duty/ })).toBeEnabled();
  await expect(existing).toContainText('Not for a role that exists. Make a new role that names it.');
  expect(await axe(lead.page), 'the role editor on a role that exists').toEqual([]);
  await closeDialogs(lead.page);
  const snco = (await (await lead.page.request.get('/api/org/roles')).json()).roles.find((r: { id: string }) => r.id === 'G8:snco') as { permissions: number };
  const late = await lead.page.request.put('/api/org/roles/G8:snco', { headers: H, data: { permissions: snco.permissions | APPROVE_OWN_DUTY } });
  expect(late.status()).toBe(403);
  expect((await late.json()).code).toBe('named_when_made');

  // The Unit Leader defines a role that names it, and cannot take it; another Marine can be given it.
  const role = await lead.page.request.post('/api/org/roles', { headers: H, data: { unit_id: 'G8', name: `Duty self-approval ${tag}`, position: 0, permissions: VIEW_UNIT | APPROVE_OWN_DUTY } });
  expect(role.ok(), await role.text()).toBeTruthy();
  const roleId = (await role.json()).id as string;
  const idOf = async (p: Page) => { const me = await (await p.request.get('/api/me')).json(); return (me.user?.id ?? me.id) as string; };
  const leaderId = await idOf(lead.page);
  const toSelf = await lead.page.request.post(`/api/org/team/${leaderId}/roles`, { headers: H, data: { role_id: roleId, unit_id: 'G8' } });
  expect(toSelf.status()).toBe(403);
  expect((await toSelf.json()).code).toBe('self_grant');

  const own = await stand(page, 'SAF', `Mine ${tag}`, 4);
  await page.goto(`/record/duty?open=${own.id}`);
  const before = page.getByRole('dialog', { name: `Mine ${tag}` });
  await expect(before).toContainText('Waiting for review');
  await expect(before.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  const marineId = await idOf(page);
  const granted = await lead.page.request.post(`/api/org/team/${marineId}/roles`, { headers: H, data: { role_id: roleId, unit_id: 'G8' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();

  // A grant signs its Marine out, so the new authority starts with a new session.
  await loginAs(page, username);
  await page.goto(`/record/duty?open=${own.id}`);
  const after = page.getByRole('dialog', { name: `Mine ${tag}` });
  const review = after.getByRole('region', { name: 'Its review' });
  await expect(review.getByRole('button', { name: 'Approve my own duty' })).toBeVisible();
  await expect(review.getByRole('button', { name: /Return|Reject|Different points/ })).toHaveCount(0);
  await review.getByRole('button', { name: 'Approve my own duty' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Approve your own duty?' }).or(page.getByRole('dialog', { name: 'Approve your own duty?' }));
  await expect(confirm).toContainText('the record shows that you approved it yourself');
  expect(await axe(page), 'the self-approval confirmation').toEqual([]);
  await confirm.getByRole('button', { name: 'Approve' }).click();
  await toast(page, 'Approved for 3 points.');
  await expect(after).toContainText('Approved');
  await expect(after.getByRole('region', { name: 'Review history' })).toContainText('Approved by You, under your own self-approval authority');
  await expect(after.getByRole('button', { name: /Approve|Reopen|Change points/ })).toHaveCount(0);
  await closeDialogs(page);
  // It is authority over their own duty, and nobody else's: they have no queue.
  await expect(page.getByRole('tab', { name: /^To review/ })).toHaveCount(0);
  // Their reviewers read whose decision it was.
  await lead.page.goto(`/record/duty?open=${own.id}`);
  await expect(lead.page.getByRole('dialog', { name: `Mine ${tag}` }).getByRole('region', { name: 'Review history' })).toContainText('under their own self-approval authority');
  await lead.context.close();
});
