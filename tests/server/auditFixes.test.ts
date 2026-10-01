import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { slug } from '../../server/lib/ids.ts';
import { zonedDay } from '../../server/lib/clock.ts';
import { todayActions } from '../../shared/health.ts';
import { applyMapping } from '../../shared/csv.ts';
import { buildZip } from '../../server/lib/zip.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('peer', { email: 'peer@example.mil' });
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('peer')).body.token };
});
after(() => app.close());

const newItem = async (title: string, reference?: string) => {
  const made = await app.call('POST', '/api/work/items', { token: op.token, body: { unit_id: 'G8', title, reference } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body as { id: string; version: number };
};

/** Runs fn with the process in another timezone, the way a browser or a host in that zone would be. */
function inZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

test('a saved view too large to store is refused, and a cut-off one saved earlier cannot break the list', async () => {
  const huge = await app.call('POST', '/api/work/views', { token: op.token, body: { name: 'Everything', config: { q: 'x'.repeat(9000) } } });
  assert.equal(huge.status, 400, 'the view used to be cut off mid-JSON and saved');

  const ok = await app.call('POST', '/api/work/views', { token: op.token, body: { name: 'Mine', config: { claimed: 'me' } } });
  assert.equal(ok.status, 201);
  app.ctx.db.prepare('UPDATE work_views SET config = ? WHERE id = ?').run('{"q":"unterminated', ok.body.id);
  const list = await app.call('GET', '/api/work/views', { token: op.token });
  assert.equal(list.status, 200, 'one unreadable view used to fail the whole list for everyone it was shared with');
  assert.deepEqual(list.body.find((v: { id: string }) => v.id === ok.body.id).config, {});

  assert.equal((await app.call('DELETE', `/api/work/views/${ok.body.id}`, { token: peer.token })).status, 403, 'only its owner deletes a view');
  assert.equal((await app.call('DELETE', `/api/work/views/${ok.body.id}`, { token: op.token })).status, 204);
});

test('claiming work already held adds nothing to its history, and closed work cannot be claimed', async () => {
  const item = await newItem('Reconcile the travel ledger');
  const first = await app.call('POST', `/api/work/items/${item.id}/claim`, { token: op.token, body: {} });
  assert.equal(first.status, 200);
  const again = await app.call('POST', `/api/work/items/${item.id}/claim`, { token: op.token, body: {} });
  assert.equal(again.status, 200);
  assert.equal(again.body.version, first.body.version, 'a repeat claim must not bump the version');
  const claims = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM work_events WHERE work_item_id = ? AND kind = 'claimed'").get(item.id) as { n: number };
  assert.equal(claims.n, 1, 'the sealed history gained a second claim entry');

  const closed = await newItem('Duplicate request');
  const na = await app.call('PATCH', `/api/work/items/${closed.id}`, { token: op.token, body: { state: 'not_applicable' } });
  assert.equal(na.status, 200, JSON.stringify(na.body));
  assert.equal((await app.call('POST', `/api/work/items/${closed.id}/claim`, { token: op.token, body: {} })).status, 409, 'claiming used to reopen not-applicable work');
});

test('a leader can assign work nobody holds, through the hand-off with its note', async () => {
  const item = await newItem('Pull the Q4 obligations');
  const detail = await app.call('GET', `/api/work/items/${item.id}`, { token: op.token });
  assert.equal(detail.body.case.permissions.hand_off, true, 'the leader is offered the action on unheld work');
  const candidates = await app.call('GET', `/api/work/items/${item.id}/handoff-candidates`, { token: op.token });
  assert.ok(candidates.body.some((c: { id: string }) => c.id === peer.id));
  const handed = await app.call('POST', `/api/work/items/${item.id}/handoff`, { token: op.token, body: { to_user_id: peer.id, note: 'Yours: start with the September report.', version: detail.body.item.version } });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.claimed_by, peer.id);
  assert.equal((await app.call('POST', `/api/work/items/${item.id}/assign`, { token: op.token, body: { user_id: peer.id } })).status, 404, 'the weaker duplicate route is gone');
});

test('queue search treats % and _ as the characters they are', async () => {
  await newItem('Rate change 100% review');
  await newItem('Rate change review');
  const list = await app.call('GET', `/api/work/items?q=${encodeURIComponent('100%')}`, { token: op.token });
  assert.deepEqual(list.body.items.map((i: { title: string }) => i.title), ['Rate change 100% review']);
  const underscore = await app.call('GET', `/api/work/items?q=${encodeURIComponent('_')}`, { token: op.token });
  assert.equal(underscore.body.total, 0, '_ used to match every row');
});

test('an email confirmation link is not spent by the wrong account, and a taken address is refused cleanly', async () => {
  await app.call('POST', '/api/auth/sudo', { token: op.token, body: { password: PASSWORD } });
  assert.equal((await app.call('POST', '/api/me/email/verify', { token: op.token, body: { email: 'shared@example.mil' } })).status, 200);
  const link = decodeURIComponent(app.ctx.mailer.outbox.at(-1)!.text.match(/verify=([^\s]+)/)![1]);

  assert.equal((await app.call('POST', '/api/me/email/confirm', { token: peer.token, body: { token: link } })).status, 400);
  app.ctx.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('shared@example.mil', peer.id);
  const taken = await app.call('POST', '/api/me/email/confirm', { token: op.token, body: { token: link } });
  assert.equal(taken.status, 400, `a unique-index failure used to surface as ${taken.status}`);
  assert.match(taken.body.error, /already in use/);

  app.ctx.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('peer@example.mil', peer.id);
  const confirmed = await app.call('POST', '/api/me/email/confirm', { token: op.token, body: { token: link } });
  assert.equal(confirmed.status, 200, 'the link survived both refusals');
  assert.equal((await app.call('POST', '/api/me/email/confirm', { token: op.token, body: { token: link } })).status, 400, 'and works once');
});

test('failed password confirmations count against the same budget as sign-in, whatever the case of the username', async () => {
  const marine = await app.register('CaseSensitive');
  for (let i = 0; i < 10; i += 1) await app.call('POST', '/api/auth/sudo', { token: marine.token, body: { password: 'wrong-password-wrong' } });
  const login = await app.login('casesensitive');
  assert.equal(login.status, 429, 'ten failed confirmations should lock sign-in for the account too');
});

test('unit codes never end in a hyphen', () => {
  assert.equal(slug(`${'A'.repeat(39)} B`), 'A'.repeat(39));
  assert.equal(slug('  1st Bn, 8th Marines!  '), '1ST-BN-8TH-MARINES');
});

test('“today” is the day where the Marine is, not in Greenwich', () => {
  // 21:00 in Chicago on 29 September is already 30 September in UTC.
  const evening = new Date('2026-09-30T02:00:00Z');
  assert.equal(zonedDay('America/Chicago', 0, evening), '2026-09-29');
  const actions = inZone('America/Chicago', () => todayActions({ tasks: [{ status: 'open', due_date: '2026-09-29', title: 'Due today' }], now: evening }));
  assert.equal(actions.some((a) => a.key === 'overdue'), false, 'work due today was flagged overdue every evening');

  // Okinawa is ahead of UTC: a free-form date parses as local midnight, which is still the previous day in UTC.
  const { records } = inZone('Asia/Tokyo', () => applyMapping([{ When: 'Sep 29, 2026', What: 'Range brief' }], { date: 'When', title: 'What' }));
  assert.equal(records[0].date, '2026-09-29');
});

test('a preview of a sheet the workbook does not have is refused, not quietly read from the first sheet', async () => {
  const cells = (rows: string[][]) => `<?xml version="1.0"?><worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v) => `<c t="inlineStr"><is><t>${v}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const workbook = buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="Open items" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: cells([['Document', 'Note'], ['TOTAL', 'not a work item']]) },
    { name: 'xl/worksheets/sheet2.xml', data: cells([['Document', 'Note'], ['ULO-7001', 'clear it']]) },
  ]);
  const source = await app.call('POST', '/api/work/sources', { token: op.token, raw: workbook, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-filename': 'balances.xlsx', 'x-unit-id': '', 'x-visibility': 'private' } });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const plan = { source_file_id: source.body.id, header_row: 1, key_columns: ['Document'], mapping: {}, unit_id: null, visibility: 'private' };
  const renamed = await app.call('POST', '/api/work/imports/preview', { token: op.token, body: { ...plan, sheet_name: 'Open Items (old)' } });
  assert.equal(renamed.status, 400, 'a missing sheet used to fall back to the Summary sheet');
  assert.match(renamed.body.error, /no sheet named/);
  const named = await app.call('POST', '/api/work/imports/preview', { token: op.token, body: { ...plan, sheet_name: 'Open items' } });
  assert.deepEqual(named.body.will_insert.map((r: { natural_key: string }) => r.natural_key), ['ULO-7001']);
});
