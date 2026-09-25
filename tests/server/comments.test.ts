import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let rivera: { token: string; id: string };
let nguyen: { token: string; id: string };
let outsider: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  rivera = await app.register('rivera');
  nguyen = await app.register('nguyen', { rank_id: 'Sgt' });
  outsider = await app.register('outsider');
  await enroll(app, op.token, 'G8', rivera.id);
  await enroll(app, op.token, 'G8', nguyen.id, 'snco');
  rivera.token = (await app.login('rivera')).body.token;
  nguyen.token = (await app.login('nguyen')).body.token;
});
after(async () => { await app.close(); });

const comments = (table: string, id: string, token: string) => app.call('GET', `/api/records/${table}/${id}/comments`, { token });
const say = (table: string, id: string, token: string, body: string) => app.call('POST', `/api/records/${table}/${id}/comments`, { token, body: { body } });

test('a conversation hangs on a record and follows exactly its visibility', async () => {
  const task = await app.call('POST', '/api/records/tasks', { token: nguyen.token, body: { title: 'Reconcile October', visibility: 'unit' } });
  assert.equal(task.status, 201, JSON.stringify(task.body));

  const first = await say('tasks', task.body.id, nguyen.token, 'Starting on the first hundred rows.');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.author_username, 'nguyen');

  // Somebody who can read the record reads the conversation.
  const read = await comments('tasks', task.body.id, op.token);
  assert.equal(read.status, 200);
  assert.equal(read.body.comments.length, 1);

  // Somebody outside the unit gets neither.
  assert.equal((await comments('tasks', task.body.id, outsider.token)).status, 403);
  assert.equal((await say('tasks', task.body.id, outsider.token, 'let me in')).status, 403);
});

test('a comment on a private record is as private as the record', async () => {
  const secret = await app.call('POST', '/api/records/counselings', { token: rivera.token, body: { date: '2026-09-01', type: 'monthly', summary: 'Private note', visibility: 'private' } });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));
  assert.equal((await say('counselings', secret.body.id, rivera.token, 'My own note.')).status, 201);
  assert.equal((await comments('counselings', secret.body.id, nguyen.token)).status, 403);
  assert.equal((await comments('counselings', secret.body.id, rivera.token)).body.comments.length, 1);
});

test('a mention never tells somebody about a record they cannot see', async () => {
  const secret = await app.call('POST', '/api/records/tasks', { token: rivera.token, body: { title: 'Private tasking', visibility: 'private' } });
  const posted = await say('tasks', secret.body.id, rivera.token, 'Asking @nguyen about this one.');
  assert.equal(posted.status, 201, JSON.stringify(posted.body));

  assert.match(posted.body.body, /@nguyen/);
  assert.deepEqual(posted.body.mentions, [], 'nobody is mentioned into a record they cannot read');

  const inbox = await app.call('GET', '/api/me/notifications', { token: nguyen.token });
  const leaked = (inbox.body.rows as Array<{ kind: string }>).filter((n) => n.kind === 'comment_mention');
  assert.equal(leaked.length, 0, 'no notification about a record they cannot see');
});

test('a mention on a record they can read does reach them', async () => {
  const shared = await app.call('POST', '/api/records/tasks', { token: nguyen.token, body: { title: 'Shared tasking', visibility: 'unit' } });
  const posted = await say('tasks', shared.body.id, op.token, 'Handing this to @nguyen.');
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.mentions, [nguyen.id]);

  const inbox = await app.call('GET', '/api/me/notifications', { token: nguyen.token });
  const mentions = (inbox.body.rows as Array<{ kind: string; action_url: string }>).filter((n) => n.kind === 'comment_mention');
  assert.equal(mentions.length, 1, 'they hear about it exactly once');
  assert.equal(mentions[0].action_url, `/records/tasks/${shared.body.id}`, 'and the notification points at the record');
});

test('your words are yours: anyone may remove their own, only a record steward may remove another', async () => {
  const task = await app.call('POST', '/api/records/tasks', { token: nguyen.token, body: { title: 'Moderation', visibility: 'unit' } });
  const mine = await say('tasks', task.body.id, nguyen.token, 'First draft, badly worded.');

  const edit = await app.call('PUT', `/api/records/tasks/${task.body.id}/comments/${mine.body.id}`, { token: op.token, body: { body: 'rewritten' } });
  assert.equal(edit.status, 403, 'nobody rewrites another person’s words');

  // The author may.
  const own = await app.call('PUT', `/api/records/tasks/${task.body.id}/comments/${mine.body.id}`, { token: nguyen.token, body: { body: 'Second draft.' } });
  assert.equal(own.status, 200);
  assert.equal(own.body.body, 'Second draft.');
  assert.ok(own.body.edited_at, 'an edit is visible as an edit');

  const removed = await app.call('DELETE', `/api/records/tasks/${task.body.id}/comments/${mine.body.id}`, { token: op.token });
  assert.equal(removed.status, 200);
  assert.equal((await comments('tasks', task.body.id, nguyen.token)).body.comments.length, 0);
});

test('an empty or oversized comment is refused', async () => {
  const task = await app.call('POST', '/api/records/tasks', { token: nguyen.token, body: { title: 'Limits', visibility: 'unit' } });
  assert.equal((await say('tasks', task.body.id, nguyen.token, '   ')).status, 400);
  assert.equal((await say('tasks', task.body.id, nguyen.token, 'x'.repeat(4001))).status, 400);
});

test('a record type that takes no comments says so', async () => {
  assert.equal((await say('nonsense', 'whatever', nguyen.token, 'hi')).status, 404);
});

test('naming somebody in an edit reaches them, and editing a typo does not ping again', async () => {
  const task = await app.call('POST', '/api/records/tasks', { token: nguyen.token, body: { title: 'Edited mentions', visibility: 'unit' } });
  const posted = await say('tasks', task.body.id, op.token, 'Starting on this.');
  assert.equal(posted.status, 201);
  assert.deepEqual(posted.body.mentions, [], 'nobody named in the first draft');

  const before = (await app.call('GET', '/api/me/notifications', { token: nguyen.token })).body.rows as Array<{ kind: string }>;
  const countBefore = before.filter((n) => n.kind === 'comment_mention').length;

  const edited = await app.call('PUT', `/api/records/tasks/${task.body.id}/comments/${posted.body.id}`, {
    token: op.token, body: { body: 'Starting on this. @nguyen can you check the second column?' },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.mentions, [nguyen.id]);

  const after = (await app.call('GET', '/api/me/notifications', { token: nguyen.token })).body.rows as Array<{ kind: string }>;
  assert.equal(after.filter((n) => n.kind === 'comment_mention').length, countBefore + 1, 'they hear about being named in an edit');

  // Editing again without changing who is named sends nothing further.
  const again = await app.call('PUT', `/api/records/tasks/${task.body.id}/comments/${posted.body.id}`, {
    token: op.token, body: { body: 'Starting on this. @nguyen can you check the second column, please?' },
  });
  assert.equal(again.status, 200);
  const final = (await app.call('GET', '/api/me/notifications', { token: nguyen.token })).body.rows as Array<{ kind: string }>;
  assert.equal(final.filter((n) => n.kind === 'comment_mention').length, countBefore + 1, 'fixing a typo is not a second ping');
});

test('a comment on a career record points somewhere that can actually open it', async () => {
  const award = await app.call('POST', '/api/records/awards', { token: rivera.token, body: { name: 'NAM', date: '2026-09-01', visibility: 'unit' } });
  assert.equal(award.status, 201, JSON.stringify(award.body));
  const posted = await say('awards', award.body.id, op.token, 'Submitted the citation.');
  assert.equal(posted.status, 201, JSON.stringify(posted.body));

  const inbox = (await app.call('GET', '/api/me/notifications', { token: rivera.token })).body.rows as Array<{ kind: string; action_url: string }>;
  const note = inbox.find((n) => n.kind === 'comment_added');
  assert.ok(note, 'the record owner hears about it');
  // /records/awards/:id has no page; the career screen does.
  assert.match(note!.action_url, /^\/career\?tab=awards#/, 'and is sent where the record can be opened');
});
