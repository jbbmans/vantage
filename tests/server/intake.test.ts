import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { buildZip } from '../../server/lib/zip.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('analyst');
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('analyst')).body.token };
  outsider = await app.register('stranger');
});
after(async () => { await app.close(); });

const H = (filename: string, contentType: string, extra: Record<string, string> = {}) => ({
  'content-type': contentType, 'x-filename': filename, 'x-unit-id': 'G8', 'x-visibility': 'unit', ...extra,
});

const upload = (token: string, filename: string, body: Buffer | string, contentType = 'text/csv', extra: Record<string, string> = {}) =>
  app.call('POST', '/api/work/sources', { token, raw: Buffer.isBuffer(body) ? body : Buffer.from(body), headers: H(filename, contentType, extra) });

const CSV = [
  'Document,Description,Due,Amount,Type,Status',
  'ULO-0264,Clear an unliquidated obligation,2026-06-30,1118.38,deobligated,Open',
  'ULO-0265,Clear another one,2026-07-15,250.00,deobligated,In progress',
  'MIPR-9001,Reconcile a reimbursable,2026-08-01,50000,reconciled,Waiting',
].join('\n');

const PLAN = {
  sheet_name: '', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit' as const,
  mapping: { Document: 'reference', Description: 'title', Due: 'due_date', Amount: 'amount', Type: 'amount_type', Status: 'state' } as Record<string, string>,
};

async function importCsv(token: string, csv = CSV, planOverrides: Record<string, unknown> = {}, filename = 'work.csv') {
  const source = await upload(token, filename, csv);
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const plan = { ...PLAN, ...planOverrides, source_file_id: source.body.id, sheet_name: filename };
  const job = await app.call('POST', '/api/work/imports', { token, body: plan });
  return { source: source.body, job };
}

test('an upload is quarantined on arrival and the scan verdict is recorded honestly', async () => {
  const res = await upload(op.token, 'work.csv', CSV);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // With no scanner configured the verdict is "skipped", not "clean". The absence of a scan is stated.
  assert.equal(res.body.scan_status, 'skipped');
  assert.match(res.body.scan_detail, /no malware scanner is configured/i);
  assert.equal(res.body.scanner, 'none');
  assert.ok(res.body.sha256.length === 64);
  assert.ok(!('content' in res.body), 'the file bytes never come back in a listing');
});

test('a file whose name lies about its type is refused', async () => {
  const workbookBytes = buildZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);
  const lying = await upload(op.token, 'data.csv', workbookBytes, 'text/csv');
  assert.equal(lying.status, 400);
  assert.match(lying.body.error, /actually a workbook/i);

  const notAWorkbook = await upload(op.token, 'data.xlsx', 'just some text', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(notAWorkbook.status, 400);
  assert.match(notAWorkbook.body.error, /not one/i);
});

test('an .xls workbook is named rather than silently rejected', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)]);
  const res = await upload(op.token, 'legacy.xls', ole, 'application/vnd.ms-excel');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /save it as \.xlsx/i);
});

test('an import creates work items, and importing the identical file again changes nothing', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
    const plan = { ...PLAN, source_file_id: source.body.id, sheet_name: 'work.csv' };
    const first = await fresh.call('POST', '/api/work/imports', { token: owner.token, body: plan });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.inserted_rows, 3);
    assert.equal(first.body.updated_rows, 0);
    assert.equal(first.body.rejected_rows, 0);

    // The same bytes, uploaded again as a separate file: still the same three pieces of work.
    const again = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
    const second = await fresh.call('POST', '/api/work/imports', { token: owner.token, body: { ...plan, source_file_id: again.body.id } });
    assert.equal(second.body.inserted_rows, 0, 'an identical reimport creates no duplicate work');
    assert.equal(second.body.updated_rows, 0);
    assert.equal(second.body.unchanged_rows, 3);

    const list = await fresh.call('GET', '/api/work/items', { token: owner.token });
    assert.equal(list.body.total, 3);
  } finally { await fresh.close(); }
});

test('a changed row updates in place and keeps the claim on it', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
    const plan = { ...PLAN, source_file_id: source.body.id, sheet_name: 'work.csv' };
    await fresh.call('POST', '/api/work/imports', { token: owner.token, body: plan });

    const items = await fresh.call('GET', '/api/work/items', { token: owner.token });
    const target = items.body.items.find((i: any) => i.natural_key === 'ULO-0264');
    const claimed = await fresh.call('POST', `/api/work/items/${target.id}/claim`, { token: owner.token, body: { version: target.version } });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));

    const revised = CSV.replace('1118.38', '2236.76');
    const source2 = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(revised), headers: H('work-v2.csv', 'text/csv') });
    const job = await fresh.call('POST', '/api/work/imports', { token: owner.token, body: { ...plan, source_file_id: source2.body.id, sheet_name: 'work-v2.csv' } });
    assert.equal(job.body.updated_rows, 1);
    assert.equal(job.body.unchanged_rows, 2);
    assert.equal(job.body.inserted_rows, 0);

    const after = await fresh.call('GET', `/api/work/items/${target.id}`, { token: owner.token });
    assert.equal(after.body.item.amount, 2236.76);
    assert.equal(after.body.item.claimed_by, owner.id, 'a reimport describes the work, not who is doing it');
    assert.ok(after.body.item.source_changed_at, 'the person holding it is told the source moved under them');
  } finally { await fresh.close(); }
});

test('an identifier the spreadsheet destroyed is refused rather than reconstructed', async () => {
  const damaged = [
    'Document,Description',
    '1.23457E+14,A contract number Excel turned into a float',
    '9007199254740993456,A number too long to hold exactly',
    '#REF!,A cell holding an error',
    'GOOD-1,A row that is fine',
  ].join('\n');
  const { job } = await importCsv(op.token, damaged, { mapping: { Document: 'reference', Description: 'title' } }, 'damaged.csv');
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal(job.body.inserted_rows, 1, 'only the intact row is imported');
  assert.equal(job.body.rejected_rows, 3);
  const reasons = JSON.parse(job.body.rejections).map((r: any) => r.reason).join(' ');
  assert.match(reasons, /scientific notation/i);
  assert.match(reasons, /rounded/i);
  assert.match(reasons, /spreadsheet error/i);
  assert.ok(!/1234570000000/.test(JSON.stringify(job.body)), 'no expanded guess at the real number appears anywhere');
});

test('two rows sharing an identifier import once, and the second says which row it clashed with', async () => {
  const dupes = ['Document,Description', 'DUP-1,First', 'DUP-1,Second'].join('\n');
  const { job } = await importCsv(op.token, dupes, { mapping: { Document: 'reference', Description: 'title' } }, 'dupes.csv');
  assert.equal(job.body.inserted_rows, 1);
  assert.equal(job.body.rejected_rows, 1);
  assert.match(JSON.parse(job.body.rejections)[0].reason, /row 2 of this sheet/i);
});

test('a retried import with the same idempotency key does not import twice', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
    const plan = { ...PLAN, source_file_id: source.body.id, sheet_name: 'work.csv' };
    const key = { 'idempotency-key': 'retry-me-once' };
    const first = await fresh.call('POST', '/api/work/imports', { token: owner.token, body: plan, headers: key });
    const second = await fresh.call('POST', '/api/work/imports', { token: owner.token, body: plan, headers: key });
    assert.equal(first.body.id, second.body.id, 'the retry returns the original job');
    const list = await fresh.call('GET', '/api/work/imports', { token: owner.token });
    assert.equal(list.body.length, 1);
  } finally { await fresh.close(); }
});

test('a preview says exactly what an import would do, without doing it', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
    const plan = { ...PLAN, source_file_id: source.body.id, sheet_name: 'work.csv' };
    const preview = await fresh.call('POST', '/api/work/imports/preview', { token: owner.token, body: plan });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.will_insert.length, 3);
    assert.equal(preview.body.will_update.length, 0);
    const after = await fresh.call('GET', '/api/work/items', { token: owner.token });
    assert.equal(after.body.total, 0, 'a preview writes nothing');
  } finally { await fresh.close(); }
});

test('a member cannot bring shared work into a unit they cannot post work to', async () => {
  const denied = await app.call('POST', '/api/work/sources', { token: outsider.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  const own = await app.call('POST', '/api/work/sources', { token: peer.token, raw: Buffer.from(CSV), headers: H('work.csv', 'text/csv') });
  assert.equal(own.status, 201);
  const asMember = await app.call('POST', '/api/work/imports', { token: peer.token, body: { ...PLAN, source_file_id: own.body.id, sheet_name: 'work.csv' } });
  assert.equal(asMember.status, 403, 'membership alone does not let someone post work for the whole unit');
  assert.match(asMember.body.error, /cannot bring shared work/i);
});

test('an upload is not readable by someone outside its unit', async () => {
  const mine = await upload(op.token, 'private.csv', CSV, 'text/csv', { 'x-visibility': 'private', 'x-unit-id': '' });
  assert.equal(mine.status, 201);
  const peek = await app.call('GET', `/api/work/sources/${mine.body.id}`, { token: peer.token });
  assert.equal(peek.status, 403);
});

test('columns that were not mapped are still kept, so nothing in the source is lost', async () => {
  const { job } = await importCsv(op.token, CSV, {}, 'kept.csv');
  assert.equal(job.status, 201);
  const items = await app.call('GET', '/api/work/items?q=reimbursable', { token: op.token });
  const row = items.body.items[0];
  assert.ok(row, 'the item was found');
  assert.equal(row.data.Document, 'MIPR-9001');
  assert.equal(row.data.Status, 'Waiting');
});

test('status words in the source map onto the states Vantage uses', async () => {
  const items = await app.call('GET', '/api/work/items?unit_id=G8', { token: op.token });
  const byKey = new Map(items.body.items.map((i: any) => [i.natural_key, i.state]));
  assert.equal(byKey.get('ULO-0264'), 'open');
  assert.equal(byKey.get('ULO-0265'), 'in_progress');
  assert.equal(byKey.get('MIPR-9001'), 'waiting');
});
