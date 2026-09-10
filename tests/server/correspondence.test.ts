import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { syncMailbox, MICROSOFT_CLOUDS, authorizationPlan, type DeltaPage } from '../../server/services/connectors.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };

const H = { 'content-type': 'message/rfc822', 'x-unit-id': 'G8', 'x-visibility': 'unit' };
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const eml = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf8');

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('peer');
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('peer')).body.token };
  outsider = await app.register('outsider');
});
after(async () => { await app.close(); });

const thread = async (token: string, body: Record<string, unknown> = {}) => {
  const res = await app.call('POST', '/api/correspondence/threads', {
    token, body: { subject: 'Supporting documents for the aged obligations', unit_id: 'G8', visibility: 'unit', ...body },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const move = (token: string, id: string, state: string, extra: Record<string, unknown> = {}) =>
  app.call('POST', `/api/correspondence/threads/${id}/state`, { token, body: { state, ...extra } });

// The state machine ----------------------------------------------------

test('a reply, a document and a resolution are three different facts, each with its own date', async () => {
  const t = await thread(op.token);
  assert.equal(t.state, 'draft');

  assert.equal((await move(op.token, t.id, 'sent')).status, 200);
  assert.equal((await move(op.token, t.id, 'awaiting_reply')).status, 200);

  const replied = await move(op.token, t.id, 'response_received', { at: day(-5) });
  assert.equal(replied.status, 200, JSON.stringify(replied.body));
  assert.equal(replied.body.response_at.slice(0, 10), day(-5));
  assert.equal(replied.body.ksd_at, null, 'a reply is not a document');
  assert.equal(replied.body.resolved_at, null, 'a reply is not a resolution');

  const arrived = await move(op.token, t.id, 'ksd_received', { at: day(-2) });
  assert.equal(arrived.status, 200);
  assert.equal(arrived.body.ksd_at.slice(0, 10), day(-2));
  assert.equal(arrived.body.response_at.slice(0, 10), day(-5), 'the earlier fact keeps its own date');
  assert.equal(arrived.body.resolved_at, null, 'the document arriving does not settle the question');

  const done = await move(op.token, t.id, 'resolved', { at: day(-1) });
  assert.equal(done.body.resolved_at.slice(0, 10), day(-1));
  assert.equal(done.body.ksd_at.slice(0, 10), day(-2));
  assert.equal(done.body.response_at.slice(0, 10), day(-5));
});

test('a supporting document cannot arrive before anything was sent', async () => {
  const t = await thread(op.token);
  const res = await move(op.token, t.id, 'ksd_received');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot arrive before anything was sent/i);
});

test('a thread that was resolved can be reopened, and reopening clears only that', async () => {
  const t = await thread(op.token);
  await move(op.token, t.id, 'sent');
  await move(op.token, t.id, 'response_received', { at: day(-4) });
  await move(op.token, t.id, 'resolved');
  const reopened = await move(op.token, t.id, 'awaiting_reply');
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.resolved_at, null);
  assert.equal(reopened.body.response_at.slice(0, 10), day(-4), 'they still replied, whatever happens next');
});

test('a stale version is refused rather than overwriting a state someone else moved', async () => {
  const t = await thread(op.token);
  const sent = await move(op.token, t.id, 'sent', { version: t.version });
  assert.equal(sent.status, 200);
  const stale = await move(op.token, t.id, 'resolved', { version: t.version });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed while you were looking at it/i);
});

// Links ----------------------------------------------------------------

async function seedWork(token: string, count: number) {
  const rows = ['Document,Description', ...Array.from({ length: count }, (_, i) => `LINK-${i + 1},Piece of work ${i + 1}`)].join('\n');
  const source = await app.call('POST', '/api/work/sources', {
    token, raw: Buffer.from(rows),
    headers: { 'content-type': 'text/csv', 'x-filename': 'link.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const job = await app.call('POST', '/api/work/imports', {
    token,
    body: { source_file_id: source.body.id, sheet_name: 'link.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit', mapping: { Document: 'reference', Description: 'title' } },
  });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  const items = await app.call('GET', '/api/work/items?unit_id=G8&limit=500', { token });
  return items.body.items.filter((i: any) => i.natural_key.startsWith('LINK-'));
}

test('one email about a hundred documents is stored once and counted once', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const rows = ['Document,Description', ...Array.from({ length: 100 }, (_, i) => `MANY-${i + 1},Item ${i + 1}`)].join('\n');
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(rows), headers: { 'content-type': 'text/csv', 'x-filename': 'many.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
    await fresh.call('POST', '/api/work/imports', { token: owner.token, body: { source_file_id: source.body.id, sheet_name: 'many.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit', mapping: { Document: 'reference', Description: 'title' } } });
    const items = (await fresh.call('GET', '/api/work/items?unit_id=G8&limit=500', { token: owner.token })).body.items;
    assert.equal(items.length, 100);

    const t = (await fresh.call('POST', '/api/correspondence/threads', { token: owner.token, body: { subject: 'One request covering everything', unit_id: 'G8', visibility: 'unit' } })).body;
    await fresh.call('POST', `/api/correspondence/threads/${t.id}/messages`, { token: owner.token, body: { direction: 'outbound', body_text: 'Please send the supporting documents for all of the attached.' } });

    const linked = await fresh.call('POST', `/api/correspondence/threads/${t.id}/links`, { token: owner.token, body: { work_item_ids: items.map((i: any) => i.id) } });
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.linked, 100);

    const messages = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM thread_messages').get() as { n: number };
    assert.equal(messages.n, 1, 'one email, stored once, not copied per document');
    const threads = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    assert.equal(threads.n, 1);

    // It shows up on each piece of work without becoming a hundred emails.
    for (const item of [items[0], items[42], items[99]]) {
      const forItem = await fresh.call('GET', `/api/correspondence/items/${item.id}/threads`, { token: owner.token });
      assert.equal(forItem.body.length, 1);
      assert.equal(forItem.body[0].id, t.id);
      assert.equal(forItem.body[0].message_count, 1);
      assert.equal(forItem.body[0].linked_items, 100);
    }
  } finally { await fresh.close(); }
});

test('linking the same work twice adds one link, not two', async () => {
  const items = await seedWork(op.token, 2);
  const t = await thread(op.token);
  const first = await app.call('POST', `/api/correspondence/threads/${t.id}/links`, { token: op.token, body: { work_item_id: items[0].id } });
  assert.equal(first.body.linked, 1);
  const again = await app.call('POST', `/api/correspondence/threads/${t.id}/links`, { token: op.token, body: { work_item_id: items[0].id } });
  assert.equal(again.body.linked, 0, 'the link already existed');
  const detail = await app.call('GET', `/api/correspondence/threads/${t.id}`, { token: op.token });
  assert.equal(detail.body.links.length, 1);
});

// Importing ------------------------------------------------------------

test('a saved email imports into a thread and is sanitized before it is stored', async () => {
  const message = eml([
    'Message-ID: <import-1@vendor.example>',
    'Date: Mon, 01 Jun 2026 09:00:00 -0400',
    'From: "Vendor Support" <support@vendor.example>',
    'To: analyst@example.mil',
    'Subject: Re: Supporting document',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p onclick="steal()">Attached is the receiving report.</p><img src="https://tracker.example/p.gif"><script>steal()</script>',
  ]);
  const res = await app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw: message, headers: H });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.created, true);
  assert.equal(res.body.thread.subject, 'Re: Supporting document');

  const stored = String(res.body.message.body_html);
  assert.ok(!stored.includes('steal'), 'the script never reaches the database, let alone the page');
  assert.ok(!stored.includes('tracker.example'));
  assert.equal(res.body.message.blocked_remote_images, 1);
  assert.equal(res.body.message.blocked_active_content, 1);
  assert.match(String(res.body.message.body_text), /receiving report/);
});

test('importing the same saved email twice does not store it twice', async () => {
  const message = eml(['Message-ID: <once@vendor.example>', 'From: a@vendor.example', 'Subject: Only once', 'Date: Mon, 01 Jun 2026 09:00:00 -0400', '', 'body']);
  const first = await app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw: message, headers: H });
  assert.equal(first.status, 201);
  const again = await app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw: message, headers: { ...H, 'x-thread-id': first.body.thread.id } });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.message.id, first.body.message.id);
});

test('an imported reply records that they replied, and nothing more', async () => {
  const t = await thread(op.token);
  await move(op.token, t.id, 'sent');
  const message = eml(['Message-ID: <reply@vendor.example>', 'From: vendor@vendor.example', 'Subject: Re: looking into it', 'Date: Mon, 01 Jun 2026 09:00:00 -0400', '', 'We are looking into it and will get back to you.']);
  const res = await app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw: message, headers: { ...H, 'x-thread-id': t.id } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.thread.state, 'response_received');
  assert.equal(res.body.thread.ksd_at, null, 'a reply saying they are looking into it is not a document arriving');
  assert.equal(res.body.thread.resolved_at, null);
});

test('an Outlook .msg is refused with the step that would fix it', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
  const res = await app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw: ole, headers: H });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Save As and choose the \.eml format/i);
});

// Authorization --------------------------------------------------------

test('correspondence never reaches someone outside its unit', async () => {
  const t = await thread(op.token);
  assert.equal((await app.call('GET', `/api/correspondence/threads/${t.id}`, { token: outsider.token })).status, 403);
  assert.equal((await move(outsider.token, t.id, 'resolved')).status, 403);
  const theirList = await app.call('GET', '/api/correspondence/threads', { token: outsider.token });
  assert.deepEqual(theirList.body, []);
});

test('a private thread stays with its author even inside the unit', async () => {
  const mine = await thread(op.token, { visibility: 'private', unit_id: null, subject: 'Something I am handling alone' });
  const peerList = await app.call('GET', '/api/correspondence/threads', { token: peer.token });
  assert.ok(!peerList.body.some((x: any) => x.id === mine.id));
  assert.equal((await app.call('GET', `/api/correspondence/threads/${mine.id}`, { token: peer.token })).status, 403);
});

test('a member can read shared correspondence but not move someone else’s thread', async () => {
  const t = await thread(op.token);
  const read = await app.call('GET', `/api/correspondence/threads/${t.id}`, { token: peer.token });
  assert.equal(read.status, 200);
  const moved = await move(peer.token, t.id, 'resolved');
  assert.equal(moved.status, 403);
  assert.match(moved.body.error, /owns this thread/i);
});

// Connectors -----------------------------------------------------------

test('a mailbox connector must state which Microsoft cloud it is in', async () => {
  const guess = await app.call('POST', '/api/correspondence/connectors', { token: op.token, body: { cloud: '', account_label: 'analyst@example.mil' } });
  assert.equal(guess.status, 400);
  assert.match(guess.body.error, /will not guess this from an email address/i);

  const made = await app.call('POST', '/api/correspondence/connectors', { token: op.token, body: { cloud: 'usgovdod', account_label: 'analyst@example.mil' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.cloud, 'usgovdod');
  assert.equal(made.body.status, 'needs_authorization');
  assert.equal(made.body.access, 'read_only');
});

test('each national cloud has its own endpoints, and the DoD one is not the commercial one', async () => {
  assert.notEqual(MICROSOFT_CLOUDS.usgovdod.graph, MICROSOFT_CLOUDS.global.graph);
  assert.notEqual(MICROSOFT_CLOUDS.usgov.graph, MICROSOFT_CLOUDS.global.graph);
  assert.match(MICROSOFT_CLOUDS.usgovdod.graph, /dod-graph\.microsoft\.us/);
  assert.match(MICROSOFT_CLOUDS.usgov.authority, /login\.microsoftonline\.us/);

  const plan = authorizationPlan({ cloud: 'usgovdod', scopes: JSON.stringify(['offline_access', 'Mail.Read']), access: 'read_only' } as never);
  assert.match(plan.delta_url, /dod-graph\.microsoft\.us/);
  assert.ok(plan.scopes.includes('https://dod-graph.microsoft.us/Mail.Read'));
  assert.ok(!plan.scopes.some((s: string) => /Mail\.Send|Mail\.ReadWrite/.test(s)), 'Vantage never asks for permission to send');
});

test('the authorization plan is shown before anything is authorized, and holds no secret', async () => {
  const connector = (await app.call('POST', '/api/correspondence/connectors', { token: op.token, body: { cloud: 'usgov', account_label: 'gcc@example.mil' } })).body;
  const res = await app.call('GET', `/api/correspondence/connectors/${connector.id}/authorization`, { token: op.token });
  assert.equal(res.status, 200);
  assert.match(res.body.plan.authorize_url, /login\.microsoftonline\.us/);
  assert.equal(res.body.connector.has_delta_cursor, false);
  assert.ok(!JSON.stringify(res.body).includes('delta_token'));
  assert.ok(!JSON.stringify(res.body).toLowerCase().includes('access_token'));
});

test('a mailbox connection belongs to one person and is not readable by another', async () => {
  const connector = (await app.call('POST', '/api/correspondence/connectors', { token: op.token, body: { cloud: 'global', account_label: 'shared@example.mil' } })).body;
  const theirs = await app.call('GET', `/api/correspondence/connectors/${connector.id}/authorization`, { token: peer.token });
  assert.equal(theirs.status, 403);
  const theirList = await app.call('GET', '/api/correspondence/connectors', { token: peer.token });
  assert.deepEqual(theirList.body.connectors, []);
});

test('syncing an unauthorized mailbox says so rather than reporting an empty inbox', async () => {
  const connector = (await app.call('POST', '/api/correspondence/connectors', { token: op.token, body: { cloud: 'usgov', account_label: 'not-yet@example.mil' } })).body;
  const res = await app.call('POST', `/api/correspondence/connectors/${connector.id}/sync`, { token: op.token, body: {} });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'connector_not_authorized');
  assert.match(res.body.error, /no token for it/i);
});

test('a sync threads on provider ids, imports each message once, and resumes where it stopped', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const created = await fresh.call('POST', '/api/correspondence/connectors', { token: owner.token, body: { cloud: 'usgovdod', account_label: 'analyst@example.mil' } });
    const connectorId = created.body.id;
    // Standing in for the authorization this build does not yet perform.
    fresh.ctx.db.prepare("UPDATE connectors SET status = 'connected' WHERE id = ?").run(connectorId);
    const user = fresh.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(owner.id) as never;

    const page = (messages: unknown[], extra: Record<string, unknown> = {}): DeltaPage => ({ value: messages as never, ...extra });
    const message = (id: string, conversationId: string, subject: string) => ({
      id, conversationId, internetMessageId: `<${id}@vendor.example>`, subject,
      receivedDateTime: '2026-06-01T13:00:00Z',
      from: { emailAddress: { name: 'Vendor', address: 'vendor@vendor.example' } },
      toRecipients: [{ emailAddress: { address: 'analyst@example.mil' } }],
      body: { contentType: 'html', content: '<p>Body text</p><img src="https://tracker.example/x.gif">' },
    });

    // Two messages in one conversation, one in another, then a delta cursor.
    const pages = [
      page([message('m1', 'c1', 'Aged obligations'), message('m2', 'c1', 'Re: Aged obligations')], { '@odata.nextLink': `${MICROSOFT_CLOUDS.usgovdod.graph}/v1.0/me/messages/delta?$skiptoken=2` }),
      page([message('m3', 'c2', 'A separate question')], { '@odata.deltaLink': `${MICROSOFT_CLOUDS.usgovdod.graph}/v1.0/me/messages/delta?$deltatoken=abc` }),
    ];
    let call = 0;
    const first = await syncMailbox(fresh.ctx, user, connectorId, async () => pages[call++], { visibility: 'private' });
    assert.equal(first.fetched, 3);
    assert.equal(first.stored, 3);
    assert.equal(first.threadsCreated, 2, 'the conversation id groups a thread, not the subject line');
    assert.equal(first.deltaStored, true);

    // The remote image in every synced body was blocked on the way in.
    const blocked = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM thread_messages WHERE blocked_remote_images = 1').get() as { n: number };
    assert.equal(blocked.n, 3);
    assert.ok(!JSON.stringify(fresh.ctx.db.prepare('SELECT body_html FROM thread_messages').all()).includes('tracker.example'));

    // Running it again over the same messages stores nothing new.
    call = 0;
    const second = await syncMailbox(fresh.ctx, user, connectorId, async () => pages[call++], { visibility: 'private' });
    assert.equal(second.stored, 0);
    assert.equal(second.skipped, 3);
    assert.equal(second.threadsCreated, 0);

    const threads = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number };
    assert.equal(threads.n, 2);
  } finally { await fresh.close(); }
});

test('a message deleted in the mailbox does not delete the record of the work', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const connectorId = (await fresh.call('POST', '/api/correspondence/connectors', { token: owner.token, body: { cloud: 'global', account_label: 'a@b.mil' } })).body.id;
    fresh.ctx.db.prepare("UPDATE connectors SET status = 'connected' WHERE id = ?").run(connectorId);
    const user = fresh.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(owner.id) as never;

    const base = MICROSOFT_CLOUDS.global.graph;
    await syncMailbox(fresh.ctx, user, connectorId, async () => ({
      value: [{ id: 'k1', conversationId: 'c1', subject: 'Kept', receivedDateTime: '2026-06-01T00:00:00Z', body: { contentType: 'text', content: 'hello' } }],
      '@odata.deltaLink': `${base}/v1.0/me/messages/delta?$deltatoken=1`,
    }), { visibility: 'private' });

    const removal = await syncMailbox(fresh.ctx, user, connectorId, async () => ({
      value: [{ id: 'k1', '@removed': { reason: 'deleted' } } as never],
      '@odata.deltaLink': `${base}/v1.0/me/messages/delta?$deltatoken=2`,
    }), { visibility: 'private' });
    assert.equal(removal.removed, 1);

    const kept = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM thread_messages').get() as { n: number };
    assert.equal(kept.n, 1, 'the message stays: it is a record of work that happened');
  } finally { await fresh.close(); }
});

test('removing a connector keeps the correspondence it brought in', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const connectorId = (await fresh.call('POST', '/api/correspondence/connectors', { token: owner.token, body: { cloud: 'global', account_label: 'a@b.mil' } })).body.id;
    fresh.ctx.db.prepare("UPDATE connectors SET status = 'connected' WHERE id = ?").run(connectorId);
    const user = fresh.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(owner.id) as never;
    await syncMailbox(fresh.ctx, user, connectorId, async () => ({
      value: [{ id: 'x1', conversationId: 'cx', subject: 'Work happened', receivedDateTime: '2026-06-01T00:00:00Z', body: { contentType: 'text', content: 'hello' } }],
      '@odata.deltaLink': `${MICROSOFT_CLOUDS.global.graph}/v1.0/me/messages/delta?$deltatoken=1`,
    }), { visibility: 'private' });

    const gone = await fresh.call('DELETE', `/api/correspondence/connectors/${connectorId}`, { token: owner.token });
    assert.equal(gone.status, 204);
    const messages = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM thread_messages').get() as { n: number };
    assert.equal(messages.n, 1);
    const threads = fresh.ctx.db.prepare('SELECT connector_id FROM threads').all() as Array<{ connector_id: string | null }>;
    assert.deepEqual(threads.map((t) => t.connector_id), [null], 'the thread survives, detached from the connection');
  } finally { await fresh.close(); }
});
