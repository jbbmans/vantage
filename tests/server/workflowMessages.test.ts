import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';
import { placeHold } from '../../server/services/retention.ts';
import { buildPersonalExport } from '../../server/services/personalExport.ts';
import { MENTION_MAX, PEOPLE_MAX } from '../../shared/workflowMessages.ts';

/**
 * Task 24 (ADR-0031): what is said is said on the record it is about, to people who already read it. A question or a
 * review request goes to one named person, who alone answers it; its asker alone withdraws it; its workflow closes it.
 * Only someone who reads the record by their own place in its Unit Instance speaks there: Vantage access reads and never
 * writes. Mentions and the people picker stay inside the record's Marine and its Unit Instance. A case takes questions
 * and review requests but no free comments, and leaving Verification required is a return for correction. What a
 * counselor and their Marine say before a counseling is final stays theirs, and a legal hold keeps a discussion as it is.
 */

type Who = { token: string; id: string };

let app: TestApp;
let op: Who & { unitId: string };
/** An SNCO of G-8: reads shared records, corrects them, and reviews duty. */
let sato: Who;
/** An NCO of G-8: reads shared work and posts unit tasks. Asks most questions here. */
let nunez: Who;
/** A Fire Team Leader of G-8: reads shared records and counsels, but does not review duty. */
let ford: Who;
/** A Marine of G-8 with no role: reads her own records and what is assigned to her, nothing else of the unit's. */
let mills: Who;
/** An NCO of G-8 who leaves the unit in one test. */
let leaver: Who;
/** A Vantage Administrator granted read-only access to G-8. */
let helper: Who;
/** Leads the other Unit Instance, G-1. */
let g1lead: Who;
/** An NCO of G-1. */
let gomez: Who;
/** NCOs of G-8 named Pick, more than the picker offers at a time. */
const pickers: Who[] = [];

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;

const rec = (table: string, id: string) => `/api/records/${table}/${id}`;
const ask = (token: string, base: string, kind: 'review_request' | 'clarification_request', addressee_id: string, body: string) =>
  post(token, `${base}/requests`, { kind, addressee_id, body });
const answer = (token: string, base: string, requestId: string, body: Record<string, unknown>) => post(token, `${base}/requests/${requestId}/answer`, body);
const withdraw = (token: string, base: string, requestId: string) => post(token, `${base}/requests/${requestId}/withdraw`);
const say = (token: string, base: string, body: string) => post(token, `${base}/comments`, { body });
const people = (token: string, base: string, q: string) => get(token, `${base}/people?q=${encodeURIComponent(q)}`);

async function discussion(token: string, base: string) {
  const res = await get(token, `${base}/comments`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.comments as Array<Record<string, any>>;
}
async function asked(token: string, base: string, kind: 'review_request' | 'clarification_request', addressee: string, body: string) {
  const res = await ask(token, base, kind, addressee, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}
const requestNotice = (userId: string, requestId: string) =>
  app.ctx.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?').get(userId, `request:${requestId}`) as Record<string, any> | undefined;
const noticesAbout = (userId: string, kind: string, entityId: string) =>
  app.ctx.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND kind = ? AND entity_id = ? ORDER BY created_at, rowid').all(userId, kind, entityId) as Array<Record<string, any>>;
const myRequests = async (token: string) => {
  const res = await get(token, '/api/me/requests');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { asked_of_you: Array<Record<string, any>>; you_asked: Array<Record<string, any>> };
};
const stored = (id: string) => app.ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as Record<string, any> | undefined;
const day = (n: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let taskCount = 0;
/** A task Nunez posts to G-8, shared with the unit; nobody assigned unless the test says so. */
async function unitTask(token = nunez.token, extra: Record<string, unknown> = {}) {
  const res = await post(token, '/api/records/tasks', { title: `Reconcile batch ${++taskCount}`, visibility: 'unit', unit_id: 'G8', ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}

const DUTY_TYPE = 'wm-dnco';
const DUTY_DAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12'];
let dutyDay = 0;
/** Duty Mills stood in G-8, waiting for review. */
async function millsDuty() {
  const date = DUTY_DAYS[dutyDay++ % DUTY_DAYS.length];
  const res = await post(mills.token, '/api/records/duties', { duty_type_id: DUTY_TYPE, date, start_time: '0800', end_date: date, end_time: '1600', unit_id: 'G8' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}

/** A counseling Ford writes for Mills, shared with her for review. */
async function counselingInReview() {
  const res = await post(ford.token, '/api/records/counselings', {
    user_id: mills.id, type: 'quarterly', date: day(-3), summary: 'Discussed the reconciliation backlog and the close-out timeline.',
    strengths: 'Owned the UMT clean-up.', improvements: 'Brief the section chief before a deadline slips.',
    goals_set: 'Clear the remaining UMTs by the end of the month.', follow_up_date: day(27), visibility: 'unit', unit_id: 'G8', stage: 'review',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.stage, 'review');
  return res.body as Record<string, any>;
}

/** A case Op opens in G-8, shared with the unit. */
async function unitCase(title = 'Reconcile the October ULO list') {
  const res = await post(op.token, '/api/work/items', { unit_id: 'G8', title, visibility: 'unit' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}
const item = (id: string) => app.ctx.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Record<string, any>;
const stage = (token: string, id: string, body: Record<string, unknown>) => post(token, `/api/work/items/${id}/stage`, { version: item(id).version, ...body });

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  sato = await app.register('sato', { first_name: 'Kei', last_name: 'Sato', rank_id: 'SSgt' });
  nunez = await app.register('nunez', { first_name: 'Nadia', last_name: 'Nunez', rank_id: 'Sgt' });
  ford = await app.register('ford', { first_name: 'Owen', last_name: 'Ford', rank_id: 'Sgt' });
  mills = await app.register('mills', { first_name: 'Ada', last_name: 'Mills', rank_id: 'LCpl' });
  leaver = await app.register('leaver', { first_name: 'Lee', last_name: 'Lake', rank_id: 'Cpl' });
  await enroll(app, op.token, 'G8', sato.id, 'snco');
  await enroll(app, op.token, 'G8', nunez.id, 'nco');
  await enroll(app, op.token, 'G8', ford.id, 'fire-team-leader');
  await enroll(app, op.token, 'G8', mills.id);
  await enroll(app, op.token, 'G8', leaver.id, 'nco');
  for (let n = 1; n <= PEOPLE_MAX + 1; n++) {
    const p = await app.register(`pick${String(n).padStart(2, '0')}`, { first_name: 'Pick', last_name: `Picker${n}`, rank_id: 'Cpl' });
    await enroll(app, op.token, 'G8', p.id, 'nco');
    pickers.push(p);
  }
  sato.token = await login('sato'); nunez.token = await login('nunez'); ford.token = await login('ford');
  mills.token = await login('mills'); leaver.token = await login('leaver');

  // A second Unit Instance, with its own leader and an NCO.
  g1lead = await app.register('gonelead');
  const made = await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  g1lead.token = await login('gonelead');
  gomez = await app.register('gomez', { first_name: 'Gil', last_name: 'Gomez', rank_id: 'Sgt' });
  await enroll(app, g1lead.token, 'G1', gomez.id, 'nco');
  gomez.token = await login('gomez');

  // A Vantage Administrator (staff sign in with a second factor; the flag is lifted again to sign in here), granted
  // read-only access to G-8 by its owner.
  helper = await app.register('helper', { first_name: 'Hal', last_name: 'Helper' });
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(helper.id);
  assert.equal((await post(op.token, '/api/platform/staff', { user_id: helper.id, role: 'admin' })).status, 201);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(helper.id);
  helper.token = await login('helper');
  const access = await post(helper.token, '/api/platform/access', { org_id: 'G8', reason: 'Ticket 77: the G8 discussion counts look wrong', minutes: 240 });
  assert.equal(access.status, 201, JSON.stringify(access.body));
  const approved = await post(op.token, `/api/orgs/G8/access/${access.body.id}/approve`, { note: 'Discussions only.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  // Duty in G-8: one type, scored under one policy.
  const at = '2025-12-20T00:00:00.000Z';
  app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)').run(DUTY_TYPE, 'G8', 'DNCO', 'Duty NCO', at, at);
  app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('wm-v1', 'G8', 1, '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: DUTY_TYPE, method: 'fixed', points: 3, bands: null }], multipliers: [], combine: 'highest' }), 'First policy', op.id, at);
});
after(async () => { await app.close(); });
// Each test asks within the hourly request limit and the picker's lookup limit on its own.
beforeEach(() => { resetLimiters(); });

// ---------------------------------------------------------------------------------------------------------------------
// Requests

test('a question goes to one person, who alone answers it, and the asker hears it was answered without its words', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const q = await asked(nunez.token, base, 'clarification_request', sato.id, 'Which ledger does row 40 come from?');
  assert.equal(q.kind, 'clarification_request');
  assert.equal(q.state, 'open');
  assert.equal(q.author_id, nunez.id);
  assert.equal(q.addressee_id, sato.id);
  assert.match(q.addressee_name, /Sato/);

  // The person asked is told, by event and record, never in the question's words.
  const notice = requestNotice(sato.id, q.id);
  assert.ok(notice, 'the person asked is told');
  assert.equal(notice!.kind, 'clarification_request');
  assert.equal(notice!.entity, 'tasks');
  assert.equal(notice!.entity_id, task.id);
  assert.equal(notice!.read_at, null);
  assert.ok(!JSON.stringify(notice).includes('row 40'), 'a notice never carries what was asked');
  const inbox = (await get(sato.token, '/api/me/notifications')).body.rows as Array<Record<string, any>>;
  const shown = inbox.find((n) => n.id === notice!.id);
  assert.ok(shown, 'and sees it in their notices');
  assert.equal(shown!.message, null);
  assert.equal(shown!.label, task.title, 'named by the record as it is called now');

  // It is in both people's lists, and its addressee may answer it.
  const theirs = (await myRequests(sato.token)).asked_of_you.find((r) => r.id === q.id);
  assert.ok(theirs, 'asked of the addressee');
  assert.equal(theirs!.can_answer, true);
  assert.equal(theirs!.label, task.title);
  assert.equal(theirs!.url, `/records/tasks/${task.id}`);
  assert.ok((await myRequests(nunez.token)).you_asked.some((r) => r.id === q.id), 'asked by its author');
  assert.equal((await discussion(nunez.token, base)).find((c) => c.id === q.id)!.can_answer, true);

  // Only the person asked answers, and a question needs an answer written.
  assert.equal((await answer(op.token, base, q.id, { body: 'September.' })).status, 403, 'not somebody else who reads the record');
  assert.equal((await answer(nunez.token, base, q.id, { body: 'September.' })).status, 403, 'not its asker');
  const empty = await answer(sato.token, base, q.id, {});
  assert.equal(empty.status, 400);
  assert.ok(empty.body.fieldErrors?.body, JSON.stringify(empty.body));
  assert.equal((await answer(sato.token, base, q.id, { body: '   ' })).status, 400);

  const answered = await answer(sato.token, base, q.id, { body: 'The September ledger, line 12.' });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.request.state, 'answered');
  assert.ok(answered.body.request.closed_at);
  assert.equal(answered.body.answer.kind, 'answer');
  assert.equal(answered.body.answer.reply_to, q.id);
  assert.equal(answered.body.answer.author_id, sato.id);
  assert.equal(stored(q.id)!.closed_by, sato.id);

  // Answered once: neither answered again nor withdrawn.
  const again = await answer(sato.token, base, q.id, { body: 'Again.' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'request_closed');
  assert.equal((await withdraw(nunez.token, base, q.id)).body.code, 'request_closed');

  // Its asker hears it was answered; the notice asking is taken back, unread.
  const told = app.ctx.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND dedupe_key = ?').get(nunez.id, `request-answered:${q.id}`) as Record<string, any> | undefined;
  assert.ok(told, 'the asker hears it was answered');
  assert.equal(told!.kind, 'request_answered');
  assert.match(told!.title, /answered your question/);
  assert.ok(!JSON.stringify(told).includes('September'), 'without the answer’s words');
  assert.equal(requestNotice(sato.id, q.id), undefined, 'nothing is left asking the addressee');
  assert.ok(!(await myRequests(sato.token)).asked_of_you.some((r) => r.id === q.id), 'no longer asked of them');
  assert.equal((await myRequests(nunez.token)).you_asked.find((r) => r.id === q.id)?.state, 'answered', 'kept in its asker’s list for a while');

  // The discussion reads in order: the question, then its answer.
  const thread = await discussion(sato.token, base);
  assert.deepEqual(thread.map((c) => [c.kind, c.state, c.reply_to]), [['clarification_request', 'answered', null], ['answer', null, q.id]]);

  // Requests and answers are kept as they were said.
  for (const [token, id] of [[nunez.token, q.id], [sato.token, answered.body.answer.id]] as const) {
    const edited = await put(token, `${base}/comments/${id}`, { body: 'Rewritten.' });
    assert.equal(edited.status, 403);
    assert.equal(edited.body.code, 'kept_as_said');
    const removed = await del(token, `${base}/comments/${id}`);
    assert.equal(removed.status, 403);
    assert.equal(removed.body.code, 'kept_as_said');
  }
  const moderated = await del(op.token, `${base}/comments/${answered.body.answer.id}`);
  assert.equal(moderated.body.code, 'kept_as_said', 'a moderator does not remove an answer either');
  assert.equal(stored(answered.body.answer.id)!.deleted_at, null);
});

test('a review request comes back as looks right, or as needs changes with what to change', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const first = await asked(nunez.token, base, 'review_request', sato.id, 'Check the totals before I send it up.');
  assert.match(requestNotice(sato.id, first.id)!.title, /asked you to review/);

  const noOutcome = await answer(sato.token, base, first.id, { body: 'Fine.' });
  assert.equal(noOutcome.status, 400);
  assert.ok(noOutcome.body.fieldErrors?.outcome, JSON.stringify(noOutcome.body));
  const bare = await answer(sato.token, base, first.id, { outcome: 'needs_changes' });
  assert.equal(bare.status, 400, 'needs changes says what');
  assert.ok(bare.body.fieldErrors?.body, JSON.stringify(bare.body));
  assert.equal((await answer(sato.token, base, first.id, { outcome: 'approved' })).status, 400);

  const fine = await answer(sato.token, base, first.id, { outcome: 'looks_right' });
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.equal(fine.body.request.state, 'looks_right');
  assert.equal(fine.body.answer, null, 'looks right needs no note');

  const second = await asked(nunez.token, base, 'review_request', sato.id, 'And the revised totals?');
  const changes = await answer(sato.token, base, second.id, { outcome: 'needs_changes', body: 'Row 12 is counted twice.' });
  assert.equal(changes.status, 200, JSON.stringify(changes.body));
  assert.equal(changes.body.request.state, 'needs_changes');
  assert.equal(changes.body.answer.kind, 'answer');
  assert.equal(changes.body.answer.body, 'Row 12 is counted twice.');
  assert.equal(changes.body.answer.reply_to, second.id);

  const titles = noticesAbout(nunez.id, 'request_answered', task.id).map((n) => n.title);
  assert.equal(titles.length, 2);
  assert.match(titles[0], /looks right/);
  assert.match(titles[1], /needs changes/);
  assert.ok(!titles.some((t) => /Row 12/.test(t)), 'the note stays on the record');
});

test('only its asker withdraws a request, and withdrawing takes back the notice not yet read', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const q = await asked(nunez.token, base, 'clarification_request', sato.id, 'Is the October file in the share drive?');
  assert.ok(requestNotice(sato.id, q.id), 'the person asked is told');

  assert.equal((await withdraw(sato.token, base, q.id)).status, 403, 'not the person asked');
  assert.equal((await withdraw(op.token, base, q.id)).status, 403, 'not somebody else');
  assert.equal(stored(q.id)!.state, 'open');

  const gone = await withdraw(nunez.token, base, q.id);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.state, 'withdrawn');
  assert.equal(stored(q.id)!.closed_by, nunez.id);
  assert.equal(requestNotice(sato.id, q.id), undefined, 'its unread notice is taken back');
  const inbox = (await get(sato.token, '/api/me/notifications')).body.rows as Array<Record<string, any>>;
  assert.ok(!inbox.some((n) => n.kind === 'clarification_request' && n.action_url === `/records/tasks/${task.id}`));
  assert.ok(!(await myRequests(sato.token)).asked_of_you.some((r) => r.id === q.id));
  assert.equal((await withdraw(nunez.token, base, q.id)).body.code, 'request_closed', 'withdrawn once');
  assert.equal((await answer(sato.token, base, q.id, { body: 'Yes.' })).body.code, 'request_closed', 'and no longer answered');
});

test('one open request per asker, person asked, kind and record', async () => {
  const task = await unitTask();
  const other = await unitTask();
  const base = rec('tasks', task.id);
  const q = await asked(nunez.token, base, 'clarification_request', sato.id, 'Who signed the October DD 1131?');
  const twice = await ask(nunez.token, base, 'clarification_request', sato.id, 'Asking again.');
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'request_open');

  // Any of the four different, and it may be asked.
  await asked(nunez.token, base, 'review_request', sato.id, 'Another kind.');
  await asked(nunez.token, base, 'clarification_request', ford.id, 'Another person.');
  await asked(nunez.token, rec('tasks', other.id), 'clarification_request', sato.id, 'Another record.');
  await asked(op.token, base, 'clarification_request', sato.id, 'Another asker.');

  // Withdrawn, it may be asked again.
  assert.equal((await withdraw(nunez.token, base, q.id)).status, 200);
  await asked(nunez.token, base, 'clarification_request', sato.id, 'Who signed the October DD 1131, please?');
});

test('a request goes to someone who may speak on the record: never oneself, never someone who cannot read it', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const refusals: Array<[string, string]> = [
    [nunez.id, 'oneself'],
    [mills.id, 'a member of the unit who cannot read this record'],
    [gomez.id, 'a member of another Unit Instance'],
    [helper.id, 'Vantage staff who read it only through Vantage access'],
    ['no-such-person', 'nobody'],
  ];
  for (const [who, what] of refusals) {
    const res = await ask(nunez.token, base, 'clarification_request', who, 'Can you look at this?');
    assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.fieldErrors?.addressee_id, `${what} is refused on whom to ask`);
  }
  const unknownKind = await post(nunez.token, `${base}/requests`, { kind: 'comment', addressee_id: sato.id, body: 'Hello.' });
  assert.equal(unknownKind.status, 400);
  assert.equal((await ask(nunez.token, base, 'clarification_request', sato.id, '   ')).status, 400, 'a request says what it asks');
  assert.equal((await ask(nunez.token, base, 'clarification_request', sato.id, 'x'.repeat(2001))).status, 400);
  // Assigned to her, the Marine reads it, and may be asked.
  const assigned = await unitTask(nunez.token, { assignee_id: mills.id });
  await asked(nunez.token, rec('tasks', assigned.id), 'clarification_request', mills.id, 'Can you start on Monday?');
});

test('duty is asked for review only of someone who may decide it, never of its Marine; a counseling takes no review request', async () => {
  const duty = await millsDuty();
  const base = rec('duties', duty.id);
  const notReviewer = await ask(mills.token, base, 'review_request', ford.id, 'Please review my duty.');
  assert.equal(notReviewer.status, 400, 'a Fire Team Leader reads it but does not review duty');
  assert.ok(notReviewer.body.fieldErrors?.addressee_id);
  await asked(mills.token, base, 'clarification_request', ford.id, 'Did I log the right end time?');
  await asked(mills.token, base, 'review_request', sato.id, 'Please review my duty.');
  const toMarine = await ask(sato.token, base, 'review_request', mills.id, 'Review your own duty.');
  assert.equal(toMarine.status, 400, 'never its own Marine');
  assert.ok(toMarine.body.fieldErrors?.addressee_id);
  await asked(sato.token, base, 'clarification_request', mills.id, 'Which post did you stand?');

  const counseling = await counselingInReview();
  const cBase = rec('counselings', counseling.id);
  const review = await ask(ford.token, cBase, 'review_request', mills.id, 'Review this draft.');
  assert.equal(review.status, 400, 'sharing a counseling is its review');
  assert.ok(review.body.fieldErrors?.kind, JSON.stringify(review.body));
  await asked(ford.token, cBase, 'clarification_request', mills.id, 'Does the follow-up date work for you?');
});

test('a decided duty closes the review requests open on it, and takes back their notices', async () => {
  const duty = await millsDuty();
  const base = rec('duties', duty.id);
  const review = await asked(mills.token, base, 'review_request', sato.id, 'Please review my duty.');
  const question = await asked(mills.token, base, 'clarification_request', sato.id, 'Does the weekend multiplier apply?');
  assert.ok(requestNotice(sato.id, review.id));

  const version = (app.ctx.db.prepare('SELECT version FROM duties WHERE id = ?').get(duty.id) as { version: number }).version;
  const approved = await post(sato.token, `${base}/review`, { action: 'approve', reason: 'Matches the logbook.', version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const after = stored(review.id)!;
  assert.equal(after.state, 'closed', 'its decision closes the review request');
  assert.ok(after.closed_at);
  assert.equal(after.closed_by, sato.id);
  assert.equal(requestNotice(sato.id, review.id), undefined, 'and takes back its unread notice');
  assert.equal(stored(question.id)!.state, 'open', 'a question stays open: a decision answers no question');
  assert.equal((await answer(sato.token, base, review.id, { outcome: 'looks_right' })).body.code, 'request_closed');
  assert.ok(!(await myRequests(sato.token)).asked_of_you.some((r) => r.id === review.id));
});

test('a deleted record closes the requests open on it, and takes back their notices', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const q = await asked(nunez.token, base, 'clarification_request', sato.id, 'Is this one still needed?');
  assert.ok(requestNotice(sato.id, q.id));
  const deleted = await del(nunez.token, base);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(stored(q.id)!.state, 'closed');
  assert.equal(requestNotice(sato.id, q.id), undefined);
  assert.ok(!(await myRequests(sato.token)).asked_of_you.some((r) => r.id === q.id));
});

test('a frozen record keeps its discussion as it was: read, never spoken on', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const said = await say(nunez.token, base, 'Before it froze.');
  assert.equal(said.status, 201);
  const q = await asked(nunez.token, base, 'clarification_request', sato.id, 'Still open when it froze?');
  app.ctx.db.prepare('UPDATE tasks SET frozen_at = ? WHERE id = ?').run(new Date().toISOString(), task.id);
  try {
    assert.equal((await discussion(sato.token, base)).length, 2, 'it is still read');
    for (const res of [
      await say(nunez.token, base, 'After it froze.'),
      await ask(nunez.token, base, 'clarification_request', ford.id, 'After it froze?'),
      await answer(sato.token, base, q.id, { body: 'Yes.' }),
      await put(nunez.token, `${base}/comments/${said.body.id}`, { body: 'Rewritten after it froze.' }),
    ]) {
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.code, 'discussion_closed');
    }
    assert.equal((await discussion(nunez.token, base)).find((c) => c.id === q.id)!.can_answer, false, 'nobody can answer on it');
    assert.deepEqual((await people(nunez.token, base, 'sato')).body.people, [], 'nobody to name on it');
  } finally {
    app.ctx.db.prepare('UPDATE tasks SET frozen_at = NULL WHERE id = ?').run(task.id);
  }
});

test('a request whose addressee can no longer read the record says so, and its asker may withdraw it', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const q = await asked(nunez.token, base, 'clarification_request', leaver.id, 'Where did you leave the binder?');
  assert.equal((await discussion(nunez.token, base)).find((c) => c.id === q.id)!.can_answer, true);
  assert.equal((await myRequests(nunez.token)).you_asked.find((r) => r.id === q.id)!.can_answer, true);

  const removed = await del(op.token, `/api/org/units/G8/members/${leaver.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  assert.equal((await discussion(nunez.token, base)).find((c) => c.id === q.id)!.can_answer, false, 'it can no longer be answered');
  assert.equal((await myRequests(nunez.token)).you_asked.find((r) => r.id === q.id)!.can_answer, false);
  // Leaving the unit signed them out; signed in again, they no longer read the record.
  leaver.token = await login('leaver');
  assert.equal((await answer(leaver.token, base, q.id, { body: 'In the safe.' })).status, 403, 'they cannot read it, so cannot answer');
  assert.ok(!(await myRequests(leaver.token)).asked_of_you.some((r) => r.id === q.id), 'nor is it listed for them');
  const gone = await withdraw(nunez.token, base, q.id);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  assert.equal(gone.body.state, 'withdrawn');
});

test('one person sends at most thirty questions and review requests an hour', async () => {
  const tasks = [await unitTask(), await unitTask()];
  let sent = 0;
  outer: for (const t of tasks) {
    for (const kind of ['clarification_request', 'review_request'] as const) {
      for (const p of pickers) {
        if (sent === 30) break outer;
        await asked(nunez.token, rec('tasks', t.id), kind, p.id, `Request ${sent + 1}.`);
        sent++;
      }
    }
  }
  const over = await ask(nunez.token, rec('tasks', tasks[1].id), 'review_request', sato.id, 'One too many.');
  assert.equal(over.status, 429, JSON.stringify(over.body));
  assert.ok(Number(over.headers.get('retry-after')) > 0, 'and says when to try again');
});

// ---------------------------------------------------------------------------------------------------------------------
// Who speaks

test('someone who reads only through Vantage access reads the discussion and says nothing in it', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  assert.equal((await say(nunez.token, base, 'Starting on the first hundred rows.')).status, 201);

  assert.equal((await discussion(helper.token, base)).length, 1, 'Vantage access reads');
  const comment = await say(helper.token, base, 'Staff note.');
  assert.equal(comment.status, 403);
  assert.equal(comment.body.code, 'not_a_speaker');
  const first = (await discussion(helper.token, base))[0];
  assert.equal((await del(helper.token, `${base}/comments/${first.id}`)).status, 403, 'nor removes what others said');
  assert.equal(stored(first.id)!.deleted_at, null);
  const request = await ask(helper.token, base, 'clarification_request', nunez.id, 'Why is this open?');
  assert.equal(request.status, 403);
  assert.equal(request.body.code, 'not_a_speaker');
  const picker = await people(helper.token, base, 'nunez');
  assert.equal(picker.status, 200);
  assert.deepEqual(picker.body.people, [], 'nobody to name or ask, for one who may not speak');
  assert.deepEqual((await people(nunez.token, base, 'helper')).body.people, [], 'and never offered to those who may');
  const named = await say(nunez.token, base, 'Copying @helper.');
  assert.equal(named.status, 201);
  assert.deepEqual(named.body.mentions, []);
  assert.deepEqual(named.body.not_told, ['@helper']);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ?').get(helper.id) as { n: number }).n, 0, 'nothing was written');

  // A staff member who is also a plain member of the unit still reads it only through Vantage access, and still says nothing.
  await enroll(app, op.token, 'G8', helper.id);
  const member = await say(helper.token, base, 'Staff note, as a member.');
  assert.equal(member.status, 403, JSON.stringify(member.body));
  assert.equal(member.body.code, 'not_a_speaker');
  assert.deepEqual((await people(nunez.token, base, 'helper')).body.people, [], 'a member who cannot read the record is not offered');
});

test('a mention reaches only the record’s Marine and the members of its Unit Instance who read it, and the answer says who was told', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const posted = await say(nunez.token, base, 'Over to @sato, copying @gomez, @mills, @nobodyhere and myself (@nunez).');
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.mentions, [sato.id]);
  assert.deepEqual(posted.body.told.map((t: { id: string }) => t.id), [sato.id]);
  assert.match(posted.body.told[0].name, /Sato/);
  assert.deepEqual(posted.body.not_told, ['@gomez', '@mills', '@nobodyhere'], 'the names that reached nobody, without saying why; naming oneself is neither');
  assert.equal(noticesAbout(sato.id, 'comment_mention', task.id).length, 1, 'the one named is told');
  assert.equal(noticesAbout(gomez.id, 'comment_mention', task.id).length, 0, 'never someone of another Unit Instance');
  assert.equal(noticesAbout(mills.id, 'comment_mention', task.id).length, 0, 'never someone who cannot read the record');
  assert.equal(noticesAbout(sato.id, 'comment_mention', task.id)[0].message, null);

  // A run-together first and last name names its one person.
  const byName = await say(nunez.token, base, 'And @OwenFord too.');
  assert.deepEqual(byName.body.told.map((t: { id: string }) => t.id), [ford.id]);

  // An edit says who it newly told, and which names still reached nobody.
  const edited = await put(nunez.token, `${base}/comments/${posted.body.id}`, { body: 'Over to @sato and @pick01, copying @gomez.' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.told.map((t: { id: string }) => t.id), [pickers[0].id], 'only the newly named');
  assert.deepEqual(edited.body.not_told, ['@gomez']);
  assert.deepEqual(new Set(edited.body.mentions), new Set([sato.id, pickers[0].id]));
  assert.equal(noticesAbout(sato.id, 'comment_mention', task.id).length, 1, 'naming somebody again is not a second notice');

  // On a record of the other Unit Instance, G-8 is nobody to name or ask.
  const theirs = await post(gomez.token, '/api/records/tasks', { title: 'G-1 roster check', visibility: 'unit', unit_id: 'G1' });
  assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
  const g1base = rec('tasks', theirs.body.id);
  const across = await say(gomez.token, g1base, 'Asking @nunez and @sato.');
  assert.equal(across.status, 201, JSON.stringify(across.body));
  assert.deepEqual(across.body.mentions, []);
  assert.deepEqual(across.body.not_told, ['@nunez', '@sato']);
  assert.deepEqual((await people(gomez.token, g1base, 'n')).body.people.filter((p: { id: string }) => [nunez.id, sato.id, op.id].includes(p.id)), []);
  assert.equal((await ask(gomez.token, g1base, 'clarification_request', nunez.id, 'Can you help?')).status, 400);
  assert.equal((await say(nunez.token, g1base, 'Let me in.')).status, 403, 'nor does G-8 speak there');
});

test('at most ten people in one message, and an e-mail address is no mention', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const handles = pickers.map((_, i) => `@pick${String(i + 1).padStart(2, '0')}`);
  assert.equal(handles.length, MENTION_MAX + 1);
  const many = await say(nunez.token, base, `Calling ${handles.join(' ')}.`);
  assert.equal(many.status, 400, JSON.stringify(many.body));
  assert.ok(many.body.fieldErrors?.body);
  assert.equal((await discussion(nunez.token, base)).length, 0, 'refused, never quietly cut');

  const ten = await say(nunez.token, base, `Calling ${handles.slice(0, MENTION_MAX).join(' ')}.`);
  assert.equal(ten.status, 201, JSON.stringify(ten.body));
  assert.equal(ten.body.told.length, MENTION_MAX);
  assert.deepEqual(ten.body.not_told, []);
  const edited = await put(nunez.token, `${base}/comments/${ten.body.id}`, { body: `Calling ${handles.join(' ')}.` });
  assert.equal(edited.status, 400, 'nor by an edit');

  const mail = await say(nunez.token, base, 'Send it to sato@example.mil, or to nunez@sato.mil.');
  assert.equal(mail.status, 201, JSON.stringify(mail.body));
  assert.deepEqual(mail.body.mentions, []);
  assert.deepEqual(mail.body.told, []);
  assert.deepEqual(mail.body.not_told, [], 'an address is not a name that reached nobody either');
  assert.equal(app.ctx.db.prepare('SELECT 1 FROM notifications WHERE dedupe_key LIKE ?').get(`comment-mention:${mail.body.id}:%`), undefined);
});

test('the picker offers at most ten people, and only those who may speak on the record', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const picks = await people(nunez.token, base, 'pick');
  assert.equal(picks.status, 200, JSON.stringify(picks.body));
  assert.equal(picks.body.people.length, PEOPLE_MAX, `${PEOPLE_MAX + 1} match; ${PEOPLE_MAX} are offered`);
  const pickerIds = new Set(pickers.map((p) => p.id));
  assert.ok(picks.body.people.every((p: { id: string }) => pickerIds.has(p.id)));
  assert.deepEqual(Object.keys(picks.body.people[0]).sort(), ['id', 'name', 'rank', 'username']);
  assert.ok((await people(nunez.token, base, '')).body.people.length <= PEOPLE_MAX);

  const one = (await people(nunez.token, base, 'sato')).body.people;
  assert.deepEqual(one.map((p: { id: string }) => p.id), [sato.id]);
  assert.equal(one[0].username, 'sato');
  assert.match(one[0].name, /Kei Sato/);
  assert.deepEqual((await people(nunez.token, base, 'Kei Sato')).body.people.map((p: { id: string }) => p.id), [sato.id], 'by first and last name');
  assert.deepEqual((await people(nunez.token, base, 'Picker1')).body.people.length, 3, 'Picker1, Picker10 and Picker11');
  for (const [q, what] of [['nunez', 'oneself'], ['mills', 'a member who cannot read it'], ['gomez', 'another Unit Instance'], ['helper', 'Vantage staff']] as const) {
    assert.deepEqual((await people(nunez.token, base, q)).body.people, [], `never ${what}`);
  }
  assert.equal((await people(mills.token, base, 'sato')).status, 403, 'nobody to offer one who cannot read the record');
  assert.equal((await people(nunez.token, base, '%')).body.people.length, 0, 'what is typed is matched as typed');

  // Assigned to her, the Marine reads it, and is offered.
  const assigned = await unitTask(nunez.token, { assignee_id: mills.id });
  assert.deepEqual((await people(nunez.token, rec('tasks', assigned.id), 'mills')).body.people.map((p: { id: string }) => p.id), [mills.id]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Work cases

test('a case takes questions and review requests, never free comments, and closing it closes what is open', async () => {
  const c = await unitCase();
  const base = `/api/work/items/${c.id}`;
  const comment = await post(nunez.token, `/api/records/work_items/${c.id}/comments`, { body: 'Free comment on a case.' });
  assert.equal(comment.status, 400, JSON.stringify(comment.body));
  assert.equal(comment.body.code, 'case_comment');

  const q = await asked(op.token, base, 'clarification_request', nunez.id, 'Which mod is the award total from?');
  assert.equal(q.record_table, 'work_items');
  assert.equal(requestNotice(nunez.id, q.id)?.entity, 'work_items');
  const answered = await answer(nunez.token, base, q.id, { body: 'Mod P00004.' });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual((await discussion(mills.token, base)).map((e) => e.kind).sort(), ['answer', 'clarification_request'], 'any member of the unit reads a shared case’s discussion');
  assert.deepEqual((await people(op.token, base, 'sato')).body.people.map((p: { id: string }) => p.id), [sato.id]);
  assert.equal((await get(gomez.token, `${base}/comments`)).status, 403, 'another Unit Instance does not');

  const review = await asked(op.token, base, 'review_request', sato.id, 'Check the candidate correction.');
  const closed = await stage(op.token, c.id, { stage: 'not_applicable' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(stored(review.id)!.state, 'closed', 'closing a case closes its open requests');
  assert.equal(requestNotice(sato.id, review.id), undefined);
});

test('leaving Verification required for a working stage is a return for correction, with what needs correcting', async () => {
  const c = await unitCase('2-Way UMT: PO open qty below DCAS qty');
  const claimed = await post(mills.token, `/api/work/items/${c.id}/claim`, {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const toVerify = await stage(mills.token, c.id, { stage: 'verification_required' });
  assert.equal(toVerify.status, 200, JSON.stringify(toVerify.body));
  // Nunez asked Sato to verify it: a return tells whoever asked for a review still open, as well as its holder.
  await asked(nunez.token, `/api/work/items/${c.id}`, 'review_request', sato.id, 'Verify the correction, please.');

  const bare = await stage(op.token, c.id, { stage: 'researching' });
  assert.equal(bare.status, 400, JSON.stringify(bare.body));
  assert.ok(bare.body.fieldErrors?.reason, 'a leader says what needs correcting');
  assert.equal(item(c.id).stage, 'verification_required');
  // The same move by an edit of the case's state, which carries no reason, is sent to its stage instead.
  const patched = await app.call('PATCH', `/api/work/items/${c.id}`, { token: op.token, body: { state: 'in_progress', version: item(c.id).version } });
  assert.equal(patched.status, 409, JSON.stringify(patched.body));
  assert.equal(patched.body.code, 'reason_required');
  assert.equal(item(c.id).stage, 'verification_required');
  assert.equal(noticesAbout(mills.id, 'work_returned', c.id).length, 0);

  const returned = await stage(op.token, c.id, { stage: 'researching', reason: 'The award total is from the wrong mod.' });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.stage, 'researching');
  for (const who of [mills, nunez]) {
    const told = noticesAbout(who.id, 'work_returned', c.id);
    assert.equal(told.length, 1, 'its holder and whoever asked for a review are told');
    assert.match(told[0].title, /returned work for correction/);
    assert.equal(told[0].entity, 'work_items');
    assert.ok(!JSON.stringify(told[0]).includes('wrong mod'), 'without the reason’s words');
  }
  assert.equal(noticesAbout(op.id, 'work_returned', c.id).length, 0, 'never the person returning it');

  // Its holder takes it back to work on their own say.
  assert.equal((await stage(mills.token, c.id, { stage: 'verification_required' })).status, 200);
  const own = await stage(mills.token, c.id, { stage: 'researching' });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.stage, 'researching');
  assert.equal(noticesAbout(mills.id, 'work_returned', c.id).length, 1, 'nobody is told of their own return');
});

// ---------------------------------------------------------------------------------------------------------------------
// Assignment notes

test('an assignment carries a note, kept on the record for its assignee, and a note goes only with an assignment', async () => {
  const note = 'Start with the October file; September is done.';
  const task = await unitTask(nunez.token, { assignee_id: mills.id, assignment_note: note });
  const kept = app.ctx.db.prepare("SELECT * FROM comments WHERE record_table = 'tasks' AND record_id = ?").all(task.id) as Array<Record<string, any>>;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].kind, 'assignment_note');
  assert.equal(kept[0].addressee_id, mills.id);
  assert.equal(kept[0].author_id, nunez.id);
  assert.equal(kept[0].body, note);
  const seen = await discussion(mills.token, rec('tasks', task.id));
  assert.deepEqual(seen.map((e) => [e.kind, e.addressee_id, e.body]), [['assignment_note', mills.id, note]]);
  const told = noticesAbout(mills.id, 'assignment', task.id);
  assert.equal(told.length, 1, 'the assignee is told of the assignment');
  assert.ok(!JSON.stringify(told[0]).includes('October'), 'never in the note’s words');

  // Kept as said.
  assert.equal((await put(nunez.token, `${rec('tasks', task.id)}/comments/${kept[0].id}`, { body: 'Rewritten.' })).body.code, 'kept_as_said');
  assert.equal((await del(nunez.token, `${rec('tasks', task.id)}/comments/${kept[0].id}`)).body.code, 'kept_as_said');

  // Reassigned with a note: another note, for the new assignee.
  const reassigned = await put(nunez.token, rec('tasks', task.id), { assignee_id: sato.id, assignment_note: 'Sato takes it from here.', version: task.version });
  assert.equal(reassigned.status, 200, JSON.stringify(reassigned.body));
  const second = app.ctx.db.prepare("SELECT * FROM comments WHERE record_table = 'tasks' AND record_id = ? AND addressee_id = ?").get(task.id, sato.id) as Record<string, any> | undefined;
  assert.equal(second?.kind, 'assignment_note');
  assert.equal(second?.body, 'Sato takes it from here.');
  const unchanged = await put(nunez.token, rec('tasks', task.id), { assignee_id: sato.id, assignment_note: 'Still Sato.', version: reassigned.body.version });
  assert.equal(unchanged.status, 400, 'no assignment changed, so no note');
  assert.ok(unchanged.body.fieldErrors?.assignment_note);

  // No note without an assignment to someone else, and nothing written when it is refused.
  for (const [body, what] of [
    [{ title: 'Unassigned with a note', assignment_note: 'For whoever.' }, 'nobody assigned'],
    [{ title: 'Self-assigned with a note', assignee_id: nunez.id, assignment_note: 'For me.' }, 'assigned to oneself'],
  ] as const) {
    const res = await post(nunez.token, '/api/records/tasks', { visibility: 'unit', unit_id: 'G8', ...body });
    assert.equal(res.status, 400, `${what}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.fieldErrors?.assignment_note);
    assert.equal(app.ctx.db.prepare('SELECT 1 FROM tasks WHERE title = ?').get(body.title), undefined, `${what}: nothing is written`);
  }
  const tooLong = await post(nunez.token, '/api/records/tasks', { title: 'Long note', visibility: 'unit', unit_id: 'G8', assignee_id: mills.id, assignment_note: 'x'.repeat(1001) });
  assert.equal(tooLong.status, 400);
  const activity = await post(nunez.token, '/api/records/activities', { title: 'Noted activity', date: day(-1), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8', assignment_note: 'Not here.' });
  assert.equal(activity.status, 400, 'only a task or a goal carries one');
});

// ---------------------------------------------------------------------------------------------------------------------
// Counseling, holds and the personal export

test('what a counselor and their Marine say before a counseling is final stays between them', async () => {
  const c = await counselingInReview();
  const base = rec('counselings', c.id);
  const fromCounselor = await say(ford.token, base, 'Let us go over the GTCC item before I finalize.');
  assert.equal(fromCounselor.status, 201, JSON.stringify(fromCounselor.body));
  assert.equal(fromCounselor.body.private, true);
  const fromMarine = await say(mills.token, base, 'I would like the follow-up moved a week.');
  assert.equal(fromMarine.body.private, true);
  const q = await asked(mills.token, base, 'clarification_request', ford.id, 'Can the follow-up be on a Monday?');
  assert.equal(q.private, true);
  const a = await answer(ford.token, base, q.id, { body: 'Monday works.' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.answer.private, true, 'the answer to a private question is private too');
  const outside = await ask(ford.token, base, 'clarification_request', sato.id, 'Should I add the GTCC item?');
  assert.equal(outside.status, 400, 'while in review, only its two parties speak on it');
  assert.deepEqual((await people(ford.token, base, '')).body.people.map((p: { id: string }) => p.id), [mills.id], 'its counselor names or asks only its Marine');
  const copied = await say(ford.token, base, 'Copying @sato on this.');
  assert.equal(copied.status, 201, JSON.stringify(copied.body));
  assert.deepEqual(copied.body.not_told, ['@sato'], 'and nobody else is named into it');
  assert.equal(noticesAbout(sato.id, 'comment_mention', c.id).length, 0);

  const current = app.ctx.db.prepare('SELECT version FROM counselings WHERE id = ?').get(c.id) as { version: number };
  const final = await post(ford.token, `${base}/finalize`, { version: current.version });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.stage, 'final');

  // Final, the unit reads the counseling, but not what was said before.
  assert.equal((await get(sato.token, base)).status, 200);
  assert.deepEqual(await discussion(sato.token, base), [], 'the unit does not read what was said in review');
  const privateIds = [fromCounselor.body.id, fromMarine.body.id, q.id, a.body.answer.id, copied.body.id];
  for (const who of [ford, mills]) {
    assert.deepEqual((await discussion(who.token, base)).map((e) => e.id).sort(), [...privateIds].sort(), 'its counselor and its Marine still do');
  }
  assert.equal((await put(sato.token, `${base}/comments/${fromMarine.body.id}`, { body: 'Edited.' })).status, 404, 'what the reader cannot read is no such comment');
  assert.equal((await del(sato.token, `${base}/comments/${fromMarine.body.id}`)).status, 404, 'not even to a moderator');

  // What is said once it is final is the unit's to read.
  const later = await say(sato.token, base, 'Noted for the quarterly review.');
  assert.equal(later.status, 201, JSON.stringify(later.body));
  assert.equal(later.body.private, false);
  for (const who of [ford, mills]) assert.ok((await discussion(who.token, base)).some((e) => e.id === later.body.id));
  assert.deepEqual((await discussion(sato.token, base)).map((e) => e.id), [later.body.id]);

  // The personal export: the parties' words travel with each of them, the unit's reader takes none of them.
  assert.ok(buildPersonalExport(app.ctx, mills.id).comments.some((r: any) => r.id === fromCounselor.body.id), 'the Marine takes what was said to her on her record');
  assert.ok(!buildPersonalExport(app.ctx, sato.id).comments.some((r: any) => privateIds.includes(r.id)));
});

test('a legal hold keeps a discussion as it is: nobody edits a comment while it stands', async () => {
  const task = await unitTask();
  const base = rec('tasks', task.id);
  const said = await say(nunez.token, base, 'Totals as of Friday.');
  assert.equal(said.status, 201);
  const release = (id: string) => app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?').run(new Date().toISOString(), op.id, id);

  for (const input of [
    { scope: 'record_type' as const, record_type: 'tasks', reason: 'IG inquiry 2026-21' },
    { scope: 'user' as const, subject_id: nunez.id, reason: 'Personnel action' },
  ]) {
    const hold = placeHold(app.ctx, 'G8', input, op.id);
    try {
      const edited = await put(nunez.token, `${base}/comments/${said.body.id}`, { body: 'Totals as of Monday.' });
      assert.equal(edited.status, 403, `${input.scope}: ${JSON.stringify(edited.body)}`);
      assert.equal(edited.body.code, 'held');
      assert.equal(stored(said.body.id)!.body, 'Totals as of Friday.', 'its words stay as they were');
    } finally { release(hold.id); }
  }
  const free = await put(nunez.token, `${base}/comments/${said.body.id}`, { body: 'Totals as of Monday.' });
  assert.equal(free.status, 200, 'released, it may be edited again');
  assert.equal(free.body.body, 'Totals as of Monday.');
});

test('the personal export carries a person’s words with their kinds, and not what others removed from their records', async () => {
  const activity = await post(mills.token, '/api/records/activities', { title: 'Closed out 14 ULOs', date: day(-2), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8' });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const aBase = rec('activities', activity.body.id);
  const mine = await say(mills.token, aBase, 'Evidence is in the share drive.');
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const hers = await asked(mills.token, aBase, 'clarification_request', sato.id, 'Should I attach the DD 1131?');
  const kept = await say(sato.token, aBase, 'Good work.');
  const removed = await say(sato.token, aBase, 'Wrong record, sorry.');
  assert.equal((await del(sato.token, `${aBase}/comments/${removed.body.id}`)).status, 200);

  const task = await unitTask(nunez.token, { assignee_id: mills.id });
  const tBase = rec('tasks', task.id);
  const toHer = await asked(nunez.token, tBase, 'clarification_request', mills.id, 'Can you start on Monday?');
  const reply = await answer(mills.token, tBase, toHer.id, { body: 'Yes, Monday.' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));

  const rows = buildPersonalExport(app.ctx, mills.id).comments as Array<Record<string, any>>;
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual(
    [mine.body.id, hers.id, reply.body.answer.id].map((id) => [byId.get(id)?.kind, byId.get(id)?.author_id]),
    [['comment', mills.id], ['clarification_request', mills.id], ['answer', mills.id]],
    'everything she said, each with its kind',
  );
  assert.equal(byId.get(hers.id)!.state, 'open');
  assert.equal(byId.get(hers.id)!.addressee_id, sato.id);
  assert.equal(byId.get(reply.body.answer.id)!.reply_to, toHer.id);
  assert.ok(byId.has(kept.body.id), 'what others said on her record, as it stands');
  assert.ok(!byId.has(removed.body.id), 'not what its author removed');
});
