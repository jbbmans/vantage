import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let rivera: { token: string; id: string };
let nguyen: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  rivera = await app.register('rivera', { email: 'rivera@example.mil' });
  nguyen = await app.register('nguyen', { rank_id: 'Sgt' });
  await enroll(app, op.token, 'G8', rivera.id);
  await enroll(app, op.token, 'G8', nguyen.id);
  rivera.token = (await app.login('rivera')).body.token;
  nguyen.token = (await app.login('nguyen')).body.token;
});
after(async () => { await app.close(); });

test('somebody who cannot sign in can still raise a ticket', async () => {
  const raised = await app.call('POST', '/api/public-support/tickets', {
    // The client header, which the real client always sends. It is not authority — there is none to
    // borrow here — but it keeps a cross-origin form POST from filing tickets.
    headers: { 'x-vantage-client': '1' },
    body: { subject: 'Cannot sign in', body: 'My password reset never arrives.', category: 'sign_in', requester_email: 'locked@example.mil', requester_name: 'Locked Out' },
  });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  assert.ok(raised.body.id);
  // Deliberately thin: nothing here confirms whether an account exists behind that address.
  assert.deepEqual(Object.keys(raised.body).sort(), ['id', 'ok']);
});

test('the queue is not readable by somebody who does not work it', async () => {
  const listed = await app.call('GET', '/api/support/tickets', { token: rivera.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.works_queue, false, 'a plain member does not work the queue');
  // They see only their own, which right now is none.
  assert.equal(listed.body.tickets.length, 0);
});

test('a ticket belongs to the person who raised it and to the queue, nobody else', async () => {
  const mine = await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Export is empty', body: 'My data export downloads a zip with nothing in it.', category: 'bug' } });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));

  // The requester reads their own.
  assert.equal((await app.call('GET', `/api/support/tickets/${mine.body.id}`, { token: rivera.token })).status, 200);
  // The operator works the queue and reads it.
  assert.equal((await app.call('GET', `/api/support/tickets/${mine.body.id}`, { token: op.token })).status, 200);
  // A third person, with no claim on it and no queue permission, does not.
  assert.equal((await app.call('GET', `/api/support/tickets/${mine.body.id}`, { token: nguyen.token })).status, 403);
});

/**
 * The line this whole feature is drawn around.
 *
 * A reset email carries a live single-use link, so anybody who could read one is a click from
 * taking the account. The queue is given the delivery *fact* instead — address, time, status — which
 * is what actually answers "why can this Marine not get in", and which email_log stores without any
 * body at all.
 */
test('the queue can see that a reset was sent, and never what it said', async () => {
  // Ask for a reset so there is something in the delivery log.
  const asked = await app.call('POST', '/api/auth/forgot', { body: { identifier: 'rivera@example.mil' } });
  assert.ok(asked.status === 200 || asked.status === 202, `reset request returned ${asked.status}: ${JSON.stringify(asked.body)}`);

  const ticket = await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Reset not arriving', body: 'I asked twice.', category: 'sign_in' } });
  const detail = await app.call('GET', `/api/support/tickets/${ticket.body.id}`, { token: op.token });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));

  const delivery = detail.body.delivery as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(delivery) && delivery.length >= 1, 'the queue sees the delivery attempt');
  const row = delivery.find((d) => d.kind === 'reset')!;
  assert.ok(row, 'including the reset itself');
  assert.equal(row.to_address, 'rivera@example.mil');
  assert.ok(row.status, 'and whether it went out');

  // What it must not contain, at any key: the body, the link, or the token.
  const serialized = JSON.stringify(detail.body);
  assert.ok(!/reset\?token=/.test(serialized), 'no reset link anywhere in the payload');
  for (const forbidden of ['body_html', 'html', 'text', 'token']) {
    assert.equal(row[forbidden], undefined, `delivery must not carry ${forbidden}`);
  }

  // And the requester themselves is not shown the delivery log either — it is a diagnostic for the
  // people working the queue, not a second place to read your own mail.
  const asRequester = await app.call('GET', `/api/support/tickets/${ticket.body.id}`, { token: rivera.token });
  assert.deepEqual(asRequester.body.delivery, []);
});

test('an internal note is invisible to the person who raised the ticket', async () => {
  const ticket = await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Something odd', body: 'The dashboard looks wrong.', category: 'bug' } });
  const id = ticket.body.id;

  const note = await app.call('POST', `/api/support/tickets/${id}/messages`, { token: op.token, body: { body: 'Probably the stale cache. Checking.', internal: true } });
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const reply = await app.call('POST', `/api/support/tickets/${id}/messages`, { token: op.token, body: { body: 'Looking into it now.' } });
  assert.equal(reply.status, 201);

  const asStaff = await app.call('GET', `/api/support/tickets/${id}`, { token: op.token });
  assert.equal(asStaff.body.messages.length, 3, 'the queue sees the note, the reply and the original');

  const asRequester = await app.call('GET', `/api/support/tickets/${id}`, { token: rivera.token });
  assert.equal(asRequester.body.messages.length, 2, 'the requester sees only what was addressed to them');
  assert.ok(!JSON.stringify(asRequester.body).includes('stale cache'), 'the internal note does not leak');

  // And they cannot write one.
  const attempt = await app.call('POST', `/api/support/tickets/${id}/messages`, { token: rivera.token, body: { body: 'sneaky', internal: true } });
  assert.equal(attempt.status, 403);
});

test('only the queue can retitle, reprioritise, assign or close a ticket', async () => {
  const ticket = await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Please close me', body: 'Sorted it myself.', category: 'other' } });
  const id = ticket.body.id;

  const byRequester = await app.call('PATCH', `/api/support/tickets/${id}`, { token: rivera.token, body: { state: 'closed' } });
  assert.equal(byRequester.status, 403, 'the requester does not move their own ticket through the queue');

  const byStaff = await app.call('PATCH', `/api/support/tickets/${id}`, { token: op.token, body: { state: 'resolved', priority: 'high', assigned_to: op.id } });
  assert.equal(byStaff.status, 200, JSON.stringify(byStaff.body));
  assert.equal(byStaff.body.ticket.state, 'resolved');
  assert.ok(byStaff.body.ticket.resolved_at);
  assert.equal(byStaff.body.ticket.assigned_to, op.id);
});

test('a ticket needs something to say', async () => {
  assert.equal((await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: '  ', body: 'x' } })).status, 400);
  assert.equal((await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Real', body: '   ' } })).status, 400);
});

/**
 * The escalation that nearly shipped.
 *
 * Anybody may stand up a unit of their own and owns it, and an owner holds every permission inside
 * it — VIEW_SUPPORT included. Treating "holds VIEW_SUPPORT anywhere" as authority over the whole
 * queue therefore meant any signed-in person could create a throwaway unit and read every ticket on
 * the instance, with the email-delivery diagnostics attached. Two features that are each fine alone.
 */
test('creating your own unit does not hand you everybody else’s tickets', async () => {
  // A ticket that belongs to nobody's unit: raised from the sign-in page.
  const anonymous = await app.call('POST', '/api/public-support/tickets', {
    headers: { 'x-vantage-client': '1' },
    body: { subject: 'Locked out of my account', body: 'No reset arrives.', category: 'sign_in', requester_email: 'someone@example.mil' },
  });
  assert.equal(anonymous.status, 201, JSON.stringify(anonymous.body));

  // And one raised by a member of G8.
  const theirs = await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Private trouble', body: 'Something personal.', category: 'other' } });
  assert.equal(theirs.status, 201, JSON.stringify(theirs.body));

  // Now somebody makes a unit of their own, which makes them its owner and its administrator.
  const outsider = await app.register('opportunist');
  const made = await app.call('POST', '/api/org/units', { token: outsider.token, body: { name: 'Opportunist Team' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const token = (await app.login('opportunist')).body.token;

  // They hold VIEW_SUPPORT — inside their own unit.
  const listed = await app.call('GET', '/api/support/tickets', { token });
  assert.equal(listed.status, 200);
  const ids = (listed.body.tickets as Array<{ id: string }>).map((t) => t.id);
  assert.ok(!ids.includes(anonymous.body.id), 'a sign-in ticket is not theirs to read');
  assert.ok(!ids.includes(theirs.body.id), 'another unit’s ticket is not theirs to read');

  // And asking for one directly is refused rather than merely filtered out of a list.
  assert.equal((await app.call('GET', `/api/support/tickets/${theirs.body.id}`, { token })).status, 403);
  assert.equal((await app.call('PATCH', `/api/support/tickets/${theirs.body.id}`, { token, body: { state: 'closed' } })).status, 403);

  // The operator still sees both.
  const asOperator = await app.call('GET', '/api/support/tickets', { token: op.token });
  const opIds = (asOperator.body.tickets as Array<{ id: string }>).map((t) => t.id);
  assert.ok(opIds.includes(anonymous.body.id) && opIds.includes(theirs.body.id));
});

test('a ticket cannot be assigned to somebody who cannot open it', async () => {
  const ticket = await app.call('POST', '/api/support/tickets', { token: rivera.token, body: { subject: 'Assignment', body: 'x', category: 'other' } });
  const refused = await app.call('PATCH', `/api/support/tickets/${ticket.body.id}`, { token: op.token, body: { assigned_to: rivera.id } });
  assert.equal(refused.status, 400, 'assigning to somebody outside the queue leaves it unworkable');
  assert.match(refused.body.error, /cannot work this queue/i);
});

test('the anonymous route still refuses a request with no client header', async () => {
  const bare = await app.call('POST', '/api/public-support/tickets', {
    headers: { 'x-vantage-client': '' },
    body: { subject: 'Drive-by', body: 'From another origin.', category: 'other' },
  });
  assert.equal(bare.status, 403);
});
