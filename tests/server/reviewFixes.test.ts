import { test, after, before } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startApp, enroll, mockGenAi, type TestApp } from './helpers.ts';
import { exportInstance } from '../../server/services/exports.ts';
import { pruneSources, storedBytesFor } from '../../server/services/intake.ts';
import { buildPersonalExport } from '../../server/services/personalExport.ts';

/**
 * The findings from the review of this branch, each turned into a test that fails on the old
 * behaviour. A bug that was found once and fixed silently is a bug that comes back.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };
let ai: Awaited<ReturnType<typeof mockGenAi>>;

before(async () => {
  ai = await mockGenAi((body) => ({ json: { model: body.model, choices: [{ message: { content: '{"executive_summary":"ok"}' } }], usage: { total_tokens: 10 } } }));
  app = await startApp({ VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'test-key-123', VANTAGE_GENAI_BASE_URL: ai.url, VANTAGE_GENAI_MODELS: 'gemini-2.5-flash' });
  op = await app.setupOperator();
  peer = await app.register('analyst');
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('analyst')).body.token };
});
after(async () => { await app.close(); ai.close(); });

const CSV = [
  'Document,Description,Due,Amount',
  'ULO-7001,Clear an unliquidated obligation,2026-06-30,1118.38',
].join('\n');

const upload = (token: string, filename: string, body: string, extra: Record<string, string> = {}) =>
  app.call('POST', '/api/work/sources', {
    token,
    raw: Buffer.from(body),
    headers: { 'content-type': 'text/csv', 'x-filename': filename, 'x-unit-id': '', 'x-visibility': 'private', ...extra },
  });

async function importPrivately(token: string, csv = CSV, filename = 'private.csv') {
  const source = await upload(token, filename, csv);
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const plan = {
    source_file_id: source.body.id, sheet_name: filename, header_row: 1, key_columns: ['Document'],
    unit_id: null, visibility: 'private' as const,
    mapping: { Document: 'reference', Description: 'title', Due: 'due_date', Amount: 'amount' } as Record<string, string>,
  };
  const job = await app.call('POST', '/api/work/imports', { token, body: plan });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  return job.body;
}

test('two people importing the same identifier privately each get their own row', async () => {
  const first = await importPrivately(op.token);
  assert.equal(first.inserted_rows, 1);

  // The identifier is the same. The row is not: it belongs to somebody else, and is invisible here.
  const second = await importPrivately(peer.token, CSV, 'theirs.csv');
  assert.equal(second.inserted_rows, 1, "a second person's private import must create their own row, not edit the first person's");
  assert.equal(second.updated_rows, 0);

  const mine = await app.call('GET', '/api/work/items?q=ULO-7001', { token: op.token });
  const theirs = await app.call('GET', '/api/work/items?q=ULO-7001', { token: peer.token });
  assert.equal(mine.body.items.length, 1);
  assert.equal(theirs.body.items.length, 1);
  assert.notEqual(mine.body.items[0].id, theirs.body.items[0].id, 'two private rows, not one shared one');
});

test('a reimport of my own private file still updates my own row', async () => {
  const changed = CSV.replace('1118.38', '2000.00');
  const again = await importPrivately(op.token, changed, 'private.csv');
  assert.equal(again.inserted_rows, 0, 'my own identifier is still my own row');
  assert.equal(again.updated_rows, 1);
});

test('a date that cannot exist is refused rather than stored', async () => {
  const csv = ['Document,Description,Due', 'ULO-7100,Impossible date,2026-99-99', 'ULO-7101,Rolled-over date,2026-02-31'].join('\n');
  const source = await upload(op.token, 'dates.csv', csv);
  const plan = {
    source_file_id: source.body.id, sheet_name: 'dates.csv', header_row: 1, key_columns: ['Document'],
    unit_id: null, visibility: 'private' as const,
    mapping: { Document: 'reference', Description: 'title', Due: 'due_date' } as Record<string, string>,
  };
  const preview = await app.call('POST', '/api/work/imports/preview', { token: op.token, body: plan });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  for (const row of preview.body.will_insert) {
    assert.equal(row.due_date, null, 'a shaped-but-impossible day is not a day');
  }
});

test('an upload is refused once one person is holding their share of the file store', async () => {
  const before = storedBytesFor(app.ctx, op.id);
  assert.ok(before > 0, 'uploads are counted against the person who made them');

  // Squeeze the quota down to what is already held; the next byte is one too many.
  const original = app.ctx.config.intake.maxBytesPerUser;
  app.ctx.config.intake.maxBytesPerUser = before;
  try {
    const refused = await upload(op.token, 'one-too-many.csv', CSV);
    assert.equal(refused.status, 507, JSON.stringify(refused.body));
    assert.match(refused.body.error, /limit here is/i);
    assert.equal(refused.body.code, 'storage_quota');
  } finally {
    app.ctx.config.intake.maxBytesPerUser = original;
  }
});

test('retention releases the bytes of an old workbook and keeps the record of where work came from', () => {
  const items = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_items').get() as { n: number }).n;
  app.ctx.db.prepare("UPDATE source_files SET created_at = '2019-01-01T00:00:00.000Z'").run();
  const released = pruneSources(app.ctx);
  assert.ok(released > 0, 'a workbook past the retention window does not keep its bytes forever');
  const remaining = app.ctx.db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS n FROM source_files').get() as { n: number };
  assert.equal(Number(remaining.n), 0);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_items').get() as { n: number }).n, items, 'the work the workbook produced survives its retention');
  assert.ok((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM source_files').get() as { n: number }).n > 0, 'the row stays so a row of work can still say where it came from');
});

test('the portable archive carries the work, the reports, and the correspondence', () => {
  const archive = exportInstance(app.ctx);
  for (const table of ['source_files', 'import_jobs', 'work_items', 'work_actions', 'work_views',
    'report_drafts', 'report_revisions', 'contacts', 'connectors', 'threads', 'thread_messages', 'thread_links', 'product_events']) {
    assert.ok(table in archive.tables, `${table} is missing from the archive, so moving an instance would lose it`);
  }
  assert.ok((archive.tables.work_items as unknown[]).length > 0, 'the queue is in the archive, not merely named by it');
});

test('a personal export carries attachments on every record it contains, not only activities', async () => {
  const training = await app.call('POST', '/api/records/trainings', {
    token: peer.token,
    body: { title: 'Defense Financial Management course', date: '2026-03-04', hours: 40, visibility: 'unit', unit_id: 'G8' },
  });
  assert.equal(training.status, 201, JSON.stringify(training.body));

  // Uploaded by somebody else. It is still evidence about this Marine's own record.
  const at = new Date().toISOString();
  app.ctx.db.prepare(
    `INSERT INTO attachments (id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at)
     VALUES (?, 'trainings', ?, ?, 'certificate.pdf', 'application/pdf', 4, ?, ?, ?)`
  ).run('att-review-1', training.body.id, op.id, 'a'.repeat(64), Buffer.from('%PDF'), at);

  const exported = buildPersonalExport(app.ctx, peer.id, { attachments: false });
  const names = (exported.attachments as Array<{ original_name: string }>).map((a) => a.original_name);
  assert.ok(names.includes('certificate.pdf'), "an attachment on the Marine's own training must be in their own archive");
});

test('step-up refuses to be an unmetered password oracle, and success clears the count', async () => {
  let sawLimit = false;
  for (let i = 0; i < 12; i += 1) {
    const res = await app.call('POST', '/api/auth/sudo', { token: peer.token, body: { password: 'not-the-password' } });
    if (res.status === 429) { sawLimit = true; break; }
    assert.equal(res.status, 403, JSON.stringify(res.body));
  }
  assert.ok(sawLimit, 'repeated wrong confirmations must hit the same limiter they feed');
});

test('the app shell precaches fonts that actually ship', () => {
  // The old list named two fonts this rewrite deleted. cache.addAll is all-or-nothing, so a single
  // 404 left the whole shell uncached and the app with nothing to show offline.
  const sw = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
  const urls = /const SHELL_URLS = \[([\s\S]*?)\];/.exec(sw)![1].match(/'([^']+)'/g)!.map((q) => q.slice(1, -1));
  assert.ok(urls.includes('/'));
  for (const url of urls) {
    if (url === '/') continue;
    assert.ok(existsSync(new URL(`../../public${url}`, import.meta.url)), `${url} is precached but does not ship`);
  }
  assert.ok(!/cache\.addAll\(SHELL_URLS\)/.test(sw), 'one missing file must not take the whole shell down with it');
});

test('the command brief counts the value types the instance actually configured', async () => {
  await app.call('POST', '/api/records/activities', {
    token: op.token,
    body: { title: 'Recovered expiring funds', date: new Date().toISOString().slice(0, 10), visibility: 'unit', unit_id: 'G8', dollar_amount: 4000, dollar_type: 'reviewed' },
  });

  // "reviewed" is not summable by default, so it starts outside the headline figure.
  const before = briefTotal(await brief());
  // The owner makes it summable. The brief must follow the instance, not a list frozen in the code.
  app.ctx.runtime.metrics = {
    ...app.ctx.runtime.metrics,
    value_types: app.ctx.runtime.metrics.value_types.map((v) => (v.key === 'reviewed' ? { ...v, summable: true } : v)),
  };
  const after = briefTotal(await brief());
  assert.equal(after - before, 4000, 'a newly summable type must reach the brief the operator sees on the dashboard');
});

const brief = async () => {
  const res = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'command_brief', input: { unit_id: 'G8' } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return ai.calls.at(-1)!.body as Record<string, any>;
};

function briefTotal(sent: Record<string, any>): number {
  const evidence = JSON.parse(String(sent.messages.at(-1).content));
  const categories = evidence.evidence.categories as Array<{ headline_transaction_value: number }>;
  return categories.reduce((n, c) => n + Number(c.headline_transaction_value || 0), 0);
}
