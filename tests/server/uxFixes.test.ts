import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.ts';

const CSV = 'Document,Title,Due\nSYN-UX-0082,2WAY PO MATCH PO open Qty 8 is less than the DCAS qty 9,2026-09-30\nSYN-UX-0083,OCMT on a MIPR,2026-12-01\n';

test('global search finds a case by its document number and by words in its title, within what the person can read', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const source = await app.call('POST', '/api/work/sources', { token: op.token, raw: Buffer.from(CSV), headers: { 'content-type': 'text/csv', 'x-filename': 'q4.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    const imported = await app.call('POST', '/api/work/imports', { token: op.token, body: { source_file_id: source.body.id, sheet_name: 'q4.csv', header_row: 1, unit_id: 'G8', visibility: 'unit', mapping: { Document: 'reference', Title: 'title', Due: 'due_date' }, key_columns: ['Document'] } });
    assert.ok([200, 201].includes(imported.status), JSON.stringify(imported.body));

    const byNumber = await app.call('GET', '/api/search?q=SYN-UX-0082', { token: op.token });
    const hit = byNumber.body.results.find((r: { type: string }) => r.type === 'work');
    assert.ok(hit, JSON.stringify(byNumber.body));
    assert.match(hit.to, /^\/work\/items\//);
    assert.match(hit.title, /SYN-UX-0082/);
    assert.ok((await app.call('GET', '/api/search?q=dcas', { token: op.token })).body.results.some((r: { type: string }) => r.type === 'work'));

    const outsider = await app.register('outsider');
    assert.equal((await app.call('GET', '/api/search?q=SYN-UX', { token: outsider.token })).body.results.filter((r: { type: string }) => r.type === 'work').length, 0, 'nothing outside their units');
  } finally { await app.close(); }
});

test('a person can set their own timezone, and their Record window is days on their own calendar', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const bad = await app.call('PUT', '/api/me/profile', { token: op.token, body: { timezone: 'Mars/Olympus_Mons' } });
    assert.equal(bad.status, 400);
    const ok = await app.call('PUT', '/api/me/profile', { token: op.token, body: { timezone: 'Pacific/Guam' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const me = await app.call('GET', '/api/me', { token: op.token });
    assert.equal(me.body.user.timezone, 'Pacific/Guam');
    assert.ok(me.body.instance.timezone);
    assert.equal(me.body.user.failed_sign_ins, undefined, 'lockout bookkeeping is not sent to the client');
    const summary = await app.call('GET', '/api/record/summary?from=2026-10-01&to=2026-10-01', { token: op.token });
    assert.equal(summary.status, 200);
  } finally { await app.close(); }
});

test('the demo shows a Marine figures for their team, a section goal, a report to open, and the governance tour', async () => {
  const app = await startApp({ VANTAGE_ACCESS_MODE: 'demo', VANTAGE_EMAIL_PROVIDER: 'none' });
  try {
    const start = await app.call('POST', '/api/demo/start', { headers: { 'x-vantage-client': '1' } });
    const token = start.body.token as string;
    const me = (await app.call('GET', '/api/me', { token })).body;
    const unit = me.memberships[0].unit_id;
    const overview = await app.call('GET', `/api/org/units/${unit}/overview`, { token });
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.totals.withheld, false, 'enough Marines share entries for the totals to show');
    assert.ok(overview.body.totals.contributors >= 3);
    assert.ok(overview.body.goals.length >= 1, 'a section goal');
    const reports = await app.call('GET', '/api/studio/reports', { token });
    assert.equal(reports.status, 200, JSON.stringify(reports.body));
    assert.ok(JSON.stringify(reports.body).includes('Q4 JEPES input'), 'a report package is waiting in Reports');
    const governance = await app.call('GET', '/api/demo/governance', { token });
    assert.equal(governance.status, 200);
    assert.ok(governance.body.inventory.tables.length > 10);
    assert.ok(governance.body.inventory.tables.every((t: { rows: unknown }) => t.rows === null), 'no row counts: the instance is shared');
    assert.equal(governance.body.auditChain, true);
  } finally { await app.close(); }
});
