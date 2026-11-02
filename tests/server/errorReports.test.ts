import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { writeWorkbook } from '../../server/lib/workbook.ts';
import { errorReportTypesOf } from '../../server/services/unitConfig.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { primaryTable, type ReportDocument } from '../../shared/reportCatalog.ts';
import {
  STANDARD_ERROR_REPORT_TYPES, ageOf, compareRows, daysToResolve, groupLines, groupValue, inDrill, summarize,
  type ComparisonResult, type DrillResult, type ErrorReportPreview, type ErrorReportsOverview, type SeriesHistory, type SnapshotRow,
} from '../../shared/errorReports.ts';

/**
 * Financial error reports (Task 15, ADR-0021): a unit files the ULO, OCMT, UMT, IOH and sync-error reports it is sent,
 * each kept as it stood on its day; any two of a series compare, and every figure opens exactly the rows it counts. Who
 * may read, file, withdraw or take a comparison away is decided on the server, in the reader's own Unit Instance.
 */

let app: TestApp;
let op: { token: string; id: string };
/** G8's people: an NCO reads shared records and posts work; a Fire Team Leader also opens member records; an SNCO also exports. */
let nco: { token: string; id: string };
let ftl: { token: string; id: string };
let snco: { token: string; id: string };
/** Reads G8's shared records and nothing more; a Marine of G8's Fiscal section; a leader of another Unit Instance. */
let reader: { token: string; id: string };
let marine: { token: string; id: string };
let g1lead: { token: string; id: string };
let ulo: string;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const patch = (token: string, path: string, body: unknown = {}) => app.call('PATCH', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
const auditSince = (seq: number) => app.ctx.db.prepare('SELECT action, actor_id, unit_id, entity_id, detail FROM audit_log WHERE seq > ? ORDER BY seq').all(seq) as Array<{ action: string; actor_id: string | null; unit_id: string | null; entity_id: string | null; detail: string }>;
const count = (sql: string, ...args: unknown[]) => (app.ctx.db.prepare(sql).get(...args) as { n: number }).n;
const qs = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as Array<[string, string]>).toString();

const CSV = 'text/csv';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const upload = (token: string, filename: string, body: Buffer | string, unit = 'G8', contentType = filename.endsWith('.xlsx') ? XLSX : CSV) =>
  app.call('POST', '/api/work/sources', { token, raw: Buffer.isBuffer(body) ? body : Buffer.from(body), headers: { 'content-type': contentType, 'x-filename': filename, 'x-unit-id': unit, 'x-visibility': 'unit' } });

const HEAD = 'Document,Line,Description,Error,Amount,Owner,Status,Opened,Office';
const COLUMNS = { Document: 'reference', Line: 'keep', Description: 'description', Error: 'category', Amount: 'amount', Owner: 'owner', Status: 'status', Opened: 'opened', Office: 'unit' };
const D = today();
const R1_DAY = dayAfter(D, -14);
const R2_DAY = dayAfter(D, -7);
const OPENED = dayAfter(D, -60);
/** Three reports of one series: what changed between them is worked out by hand in the tests below. */
const R1 = [HEAD,
  `D1,1,Obligation not liquidated,Unmatched,"1,000.00",nco,Open,${OPENED},FISCAL`,
  'D2,1,Duplicate invoice,Duplicate,250.50,Ftl Marine,In research,,G8',
  'D3,1,Unposted receipt,Unmatched,75.25,Somebody Else,Open,,FISCAL',
  'D4,1,Overage,Overage,10.00,,Closed,,G8',
  ',1,A row with no identifier,Unmatched,5.00,,Open,,G8',
].join('\n');
const R2 = [HEAD,
  `D1,1,Obligation not liquidated,Unmatched,900.00,Ftl Marine,Open,${OPENED},FISCAL`,
  'D3,1,Unposted receipt,Unmatched,75.25,Somebody Else,In research,,FISCAL',
  'D4,1,Overage,Overage,10.00,,Open,,G8',
  'D5,1,New sync error,Sync,40.00,nco,Open,,G8',
].join('\n');
const R3 = writeWorkbook([{ name: 'ULO', rows: [
  HEAD.split(','),
  ['D1', 1, 'Obligation not liquidated', 'Unmatched', 900, 'Ftl Marine', 'Open', OPENED, 'FISCAL'],
  ['D2', 1, 'Duplicate invoice', 'Duplicate', 250.5, 'Ftl Marine', 'Open', '', 'G8'],
  ['D3', 1, 'Unposted receipt', 'Unmatched', 75.25, 'Somebody Else', 'Closed', '', 'FISCAL'],
  ['D5', 1, 'New sync error', 'Sync', 40, 'nco', 'Open', '', 'G8'],
] }]);

async function plan(token: string, filename: string, body: Buffer | string, extra: Record<string, unknown> = {}) {
  const source = await upload(token, filename, body);
  assert.equal(source.status, 201, JSON.stringify(source.body));
  return {
    unit_id: 'G8', type_id: ulo, as_of: D, source_file_id: source.body.id as string, sheet_name: filename.endsWith('.xlsx') ? 'ULO' : filename,
    header_row: 1, key_columns: ['Document'], columns: COLUMNS, closed_statuses: ['closed'], ...extra,
  };
}
async function fileReport(token: string, filename: string, body: Buffer | string, extra: Record<string, unknown> = {}) {
  const res = await post(token, '/api/error-reports/snapshots', await plan(token, filename, body, extra));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; as_of: string; row_count: number; open_count: number; open_cents: number; rejected_rows: number };
}
const series = async (token: string, params: Record<string, string | undefined> = {}) => {
  const res = await get(token, `/api/error-reports/series?${qs({ unit_id: 'G8', type_id: ulo, ...params })}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as ComparisonResult;
};
const drill = (token: string, params: Record<string, string | undefined>) => get(token, `/api/error-reports/rows?${qs({ unit_id: 'G8', type_id: ulo, ...params })}`);
const figure = (r: ComparisonResult, id: string) => r.summary.figures.find((f) => f.id === id)!;

const ids: Record<'r1' | 'r2' | 'r3', string> = { r1: '', r2: '', r3: '' };

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  nco = await app.register('nco'); await enroll(app, op.token, 'G8', nco.id, 'nco'); nco.token = await login('nco');
  ftl = await app.register('ftl'); await enroll(app, op.token, 'G8', ftl.id, 'fire-team-leader'); ftl.token = await login('ftl');
  snco = await app.register('snco'); await enroll(app, op.token, 'G8', snco.id, 'snco'); snco.token = await login('snco');
  app.ctx.db.prepare("INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES ('G8:reader', 'G8', 'reader', 'Reader', ?, 5, ?)")
    .run(PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS, new Date().toISOString());
  reader = await app.register('reader'); await enroll(app, op.token, 'G8', reader.id, 'reader'); reader.token = await login('reader');
  marine = await app.register('rifleman'); await enroll(app, op.token, 'FISCAL', marine.id); marine.token = await login('rifleman');
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');
});
after(async () => { await app.close(); });

// ——— The arithmetic, from rows alone ———

const row = (key: string, over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  key, source_row: 2, reference: null, description: null, category: null, unit: null, owner: null, owner_user_id: null, status: 'Open', closed: false,
  amount_cents: 100, opened_on: null, age_days: null, ...over,
});

test('two reports compare: new, still open, reopened and resolved, and what changed on the errors on both', () => {
  const before = [row('A', { amount_cents: 1000, owner: 'Smith, J.' }), row('B'), row('C', { closed: true, status: 'Closed' }), row('E', { closed: true, status: 'Closed' })];
  const after = [row('A', { amount_cents: 900, owner: 'smith j' }), row('C'), row('D'), row('F'), row('E', { closed: true, status: 'Closed', amount_cents: 5 })];
  const compared = compareRows(before, after, new Set(['A', 'B', 'C', 'E', 'F']));
  const by = Object.fromEntries(compared.map((r) => [r.key, r]));
  assert.equal(by.A.standing, 'still_open');
  assert.deepEqual(by.A.flags, ['amount_changed'], 'case, spacing and punctuation are not a change of owner');
  assert.equal(by.B.standing, 'resolved', 'open before and gone now');
  assert.equal(by.C.standing, 'reopened', 'closed on the earlier report, open now');
  assert.deepEqual(by.C.flags, ['status_changed']);
  assert.equal(by.D.standing, 'new', 'on no earlier report');
  assert.equal(by.F.standing, 'reopened', 'gone from the earlier report, but on one before it');
  assert.equal(by.E.standing, null, 'closed on both: no standing, but its change is still seen');
  assert.deepEqual(by.E.flags, ['amount_changed']);
});

test('ages run from the opened day, else the stated age, else the first report it was open on', () => {
  assert.deepEqual(ageOf(row('A', { opened_on: '2026-09-01', age_days: 5 }), '2026-10-01', '2026-09-20'), { days: 30, basis: 'opened' });
  assert.deepEqual(ageOf(row('A', { age_days: 12 }), '2026-10-01', '2026-09-20'), { days: 12, basis: 'stated' });
  assert.deepEqual(ageOf(row('A'), '2026-10-01', '2026-09-20'), { days: 11, basis: 'first_seen' });
  assert.deepEqual(ageOf(row('A'), '2026-10-01', null), { days: null, basis: null });
  assert.equal(ageOf(row('A', { opened_on: '2026-10-05' }), '2026-10-01', null).days, 0, 'an opened day after the report is no negative age');
  assert.equal(daysToResolve(row('A', { age_days: 10 }), '2026-10-01', '2026-10-08', null), 17, 'the age it had, and the days since');
  assert.equal(daysToResolve(row('A', { opened_on: '2026-09-01' }), '2026-10-01', '2026-10-08', null), 37);
  assert.equal(daysToResolve(row('A'), '2026-10-01', '2026-10-08', '2026-09-24'), 14);
});

test('every count is the number of rows its drill holds, and the groups add up to the figures', () => {
  const before = [row('A', { category: 'Unmatched', amount_cents: 1000 }), row('B', { category: 'Duplicate', amount_cents: 250 }), row('C', { category: 'Unmatched', amount_cents: 75 })];
  const after = [row('A', { category: 'Unmatched', amount_cents: 900 }), row('D', { category: '', amount_cents: 40 }), row('C', { category: 'Unmatched', closed: true, status: 'Closed', amount_cents: 75 })];
  const compared = compareRows(before, after, new Set(['A', 'B', 'C']));
  const facts = { firstOpenOn: new Map([['A', '2026-09-24'], ['B', '2026-09-24'], ['C', '2026-09-24'], ['D', '2026-10-01']]), persistent: new Set(['A']), recurring: new Set<string>(), persistentKnown: true };
  const s = summarize(compared, { before: '2026-09-24', after: '2026-10-01' }, facts);
  const sets = { persistent: facts.persistent, recurring: facts.recurring };
  for (const f of s.figures.filter((x) => x.kind === 'count' && x.drill && x.value != null)) {
    assert.equal(compared.filter((r) => inDrill(r, f.drill!, sets)).length, f.value, `${f.id} counts the rows it drills to`);
  }
  const value = (id: string) => s.figures.find((f) => f.id === id)!;
  assert.deepEqual([value('open').value, value('open').cents], [2, 940]);
  assert.deepEqual([value('before').value, value('before').cents], [3, 1325]);
  assert.deepEqual([value('resolved').value, value('resolved').cents], [2, 325], 'resolved is valued as the earlier report had it');
  assert.equal(value('amount_changed').cents, -100, 'the net change');
  assert.equal(value('resolution_rate').value, 66.7);
  assert.equal(value('velocity').value, 2, 'two resolved in a week');
  assert.equal(value('persistent').value, 1);
  const lines = groupLines(compared, 'category', (_r, v) => v || 'Not stated');
  assert.deepEqual(lines.map((l) => [l.label, l.open, l.resolved]), [['Unmatched', 1, 1], ['Not stated', 1, 0], ['Duplicate', 0, 1]]);
  assert.equal(lines.reduce((n, l) => n + l.open, 0), value('open').value);
  assert.equal(lines.reduce((n, l) => n + l.resolved, 0), value('resolved').value);
  assert.equal(groupValue(row('X', { owner: 'Smith,  J.' }), 'owner'), 'text:smith j');
  assert.equal(groupValue(row('X', { owner: 'Smith', owner_user_id: 'u1' }), 'owner'), 'user:u1', 'a Marine the owner names is grouped as that Marine');
  const first = summarize(compareRows([], after, new Set()), { before: null, after: '2026-10-01' }, { ...facts, persistentKnown: false });
  assert.deepEqual(first.figures.map((f) => f.id), ['open', 'average_age', 'oldest', 'recurring', 'persistent'], 'the first report of a series has nothing to compare');
  assert.equal(first.figures.find((f) => f.id === 'persistent')!.value, null, 'not known until the series has three reports');
});

// ——— Report types ———

test('a Unit Instance is given the five standard reports, and its Unit Managers keep its own', async () => {
  const seq = lastSeq();
  const overview = await get(op.token, '/api/error-reports?unit_id=G8');
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  const types = (overview.body as ErrorReportsOverview).types;
  assert.deepEqual(types.map((t) => t.code).sort(), STANDARD_ERROR_REPORT_TYPES.map((t) => t.code).sort());
  ulo = types.find((t) => t.code === 'ULO')!.id;
  const given = auditSince(seq).filter((e) => e.action === 'error_report_types_standard_added');
  assert.equal(given.length, 1, 'given once');
  assert.equal(given[0].actor_id, null, 'nobody is named as having added them');
  assert.match(given[0].detail, /given the first time/);
  await get(op.token, '/api/error-reports?unit_id=G8');
  assert.equal(auditSince(seq).filter((e) => e.action === 'error_report_types_standard_added').length, 1, 'and never again');

  const own = await post(op.token, '/api/orgs/G8/error-report-types', { name: 'Travel card delinquencies', code: 'gtcc' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.code, 'GTCC');
  assert.equal((await post(op.token, '/api/orgs/G8/error-report-types', { name: 'Again', code: 'GTCC' })).status, 409, 'a code once per Unit Instance');
  assert.equal((await patch(op.token, `/api/orgs/G8/error-report-types/${own.body.id}`, { active: false })).body.active, 0);
  assert.deepEqual((await post(op.token, '/api/orgs/G8/error-report-types/standard')).body.added, [], 'the standard list is all here');
  for (const who of [nco, reader, marine]) assert.equal((await post(who.token, '/api/orgs/G8/error-report-types', { name: 'Not theirs' })).status, 404, 'no Unit Instance role, no console');
  assert.equal((await post(g1lead.token, '/api/orgs/G8/error-report-types', { name: 'Not theirs' })).status, 404, 'another Unit Instance is not there');
  assert.equal(count("SELECT COUNT(*) AS n FROM error_report_types WHERE name = 'Not theirs'"), 0);
  const config = await get(op.token, '/api/orgs/G8/configuration');
  assert.ok(config.body.errorReportTypes.some((t: { code: string; active: number }) => t.code === 'GTCC' && t.active === 0), 'a retired type stays, retired');
  assert.equal(config.body.catalog.standardErrorReportTypes.length, 5);
  const actions = auditSince(seq).map((e) => e.action);
  for (const action of ['error_report_type_created', 'error_report_type_retired']) assert.ok(actions.includes(action), action);
});

// ——— Filing ———

test('a report is previewed against the one before it, then filed as it stood, its rows and columns kept', async () => {
  const p1 = await plan(nco.token, 'ULO 14 days ago.csv', R1, { as_of: R1_DAY });
  const preview = await post(nco.token, '/api/error-reports/preview', p1);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const pv = preview.body as ErrorReportPreview;
  assert.deepEqual([pv.rows, pv.open, pv.open_cents, pv.rejected], [4, 3, 132575, 1], 'the row without an identifier is refused; Closed closes D4');
  assert.equal(pv.previous, null, 'the first report of its series');
  assert.deepEqual(pv.statuses.map((s) => [s.status, s.rows, s.closed]), [['Open', 2, false], ['In research', 1, false], ['Closed', 1, true]]);
  assert.deepEqual(pv.owners, { named: 3, matched: 2 }, 'nco by username, Ftl Marine by name; Somebody Else is nobody here');
  assert.equal(count('SELECT COUNT(*) AS n FROM error_snapshots'), 0, 'a preview writes nothing');

  const seq = lastSeq();
  const r1 = await post(nco.token, '/api/error-reports/snapshots', p1);
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  ids.r1 = r1.body.id;
  assert.deepEqual([r1.body.as_of, r1.body.row_count, r1.body.open_count, r1.body.open_cents, r1.body.rejected_rows], [R1_DAY, 4, 3, 132575, 1]);
  const filed = auditSince(seq).filter((e) => e.action === 'error_snapshot_filed');
  assert.equal(filed.length, 1);
  assert.deepEqual([filed[0].actor_id, filed[0].unit_id, filed[0].entity_id], [nco.id, 'G8', ids.r1]);
  assert.match(filed[0].detail, /ULO as of .*4 rows, 3 open \(1325\.75\), 1 refused/);
  const kept = app.ctx.db.prepare('SELECT * FROM error_snapshot_rows WHERE snapshot_id = ? AND natural_key = ?').get(ids.r1, 'D1') as Record<string, any>;
  assert.equal(kept.amount_cents, 100000, '"1,000.00" is a thousand dollars');
  assert.equal(kept.owner_user_id, nco.id);
  assert.equal(kept.opened_on, OPENED);
  assert.equal(kept.source_row, 2);
  assert.equal(JSON.parse(kept.data).Line, '1', 'every column is kept as the file had it');

  const layout = await get(nco.token, `/api/error-reports/layout?unit_id=G8&type_id=${ulo}`);
  assert.deepEqual(layout.body.layout.key_columns, ['Document']);
  assert.equal(layout.body.layout.columns.Amount, 'amount');
  assert.deepEqual(layout.body.layout.closed_statuses, ['closed'], 'the next report starts as this one was filed');
});

test('the same file, a second report for one day, a day to come and a retired type are each refused', async () => {
  const again = await post(nco.token, '/api/error-reports/snapshots', await plan(nco.token, 'ULO copy.csv', R1, { as_of: dayAfter(D, -13) }));
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'snapshot_duplicate');
  const sameDay = await post(nco.token, '/api/error-reports/snapshots', await plan(nco.token, 'ULO other.csv', R2, { as_of: R1_DAY }));
  assert.equal(sameDay.status, 409);
  assert.equal(sameDay.body.code, 'snapshot_exists');
  const preview = await post(nco.token, '/api/error-reports/preview', await plan(nco.token, 'ULO other.csv', R2, { as_of: R1_DAY }));
  assert.equal(preview.body.same_day.id, ids.r1, 'the preview says so first');
  const future = await post(nco.token, '/api/error-reports/preview', await plan(nco.token, 'ULO later.csv', R2, { as_of: dayAfter(D, 2) }));
  assert.equal(future.status, 400);
  assert.match(future.body.error, /day that has come/);
  const ioh = (await get(op.token, '/api/error-reports?unit_id=G8')).body.types.find((t: { code: string }) => t.code === 'IOH');
  assert.equal((await patch(op.token, `/api/orgs/G8/error-report-types/${ioh.id}`, { active: false })).status, 200);
  const retired = await post(nco.token, '/api/error-reports/preview', await plan(nco.token, 'IOH.csv', R2, { type_id: ioh.id }));
  assert.equal(retired.status, 400);
  assert.match(retired.body.error, /retired/);
  assert.equal((await patch(op.token, `/api/orgs/G8/error-report-types/${ioh.id}`, { active: true })).status, 200);
  const twice = await post(nco.token, '/api/error-reports/preview', await plan(nco.token, 'ULO twice.csv', R2, { columns: { ...COLUMNS, Description: 'amount' } }));
  assert.equal(twice.status, 400, 'one column per role');
  const missing = await post(nco.token, '/api/error-reports/preview', await plan(nco.token, 'ULO missing.csv', R2, { key_columns: ['Doc'] }));
  assert.equal(missing.status, 400, 'an identifier the sheet does not have');
  const noted = await post(nco.token, '/api/error-reports/preview', await plan(nco.token, 'ULO noted.csv', [HEAD, 'Z1,1,Bad amount,Unmatched,lots,,Open,someday,G8'].join('\n')));
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.deepEqual(noted.body.rejections.map((r: { reason: string }) => (/amount/.test(r.reason) ? 'amount' : /opened/.test(r.reason) ? 'opened' : r.reason)), ['amount', 'opened']);
  assert.equal(noted.body.rows, 1, 'an unreadable amount or date is noted, and the row filed without it');
});

test('the second and third reports compare as worked out by hand, a workbook as a CSV', async () => {
  ids.r2 = (await fileReport(ftl.token, 'ULO 7 days ago.csv', R2, { as_of: R2_DAY })).id;
  const two = await series(op.token, { snapshot: ids.r2 });
  assert.equal(two.before!.id, ids.r1, 'compared with the one before');
  const c2 = two.summary.counts;
  assert.deepEqual([c2.open, c2.before, c2.new, c2.still_open, c2.reopened, c2.resolved], [4, 3, 1, 2, 1, 1]);
  assert.deepEqual([c2.amount_changed, c2.owner_changed, c2.status_changed], [1, 1, 2], 'D1 moved and was handed on; D3 and D4 changed status');
  assert.equal(figure(two, 'amount_changed').cents, -10000, 'D1 went from $1,000.00 to $900.00');
  assert.equal(figure(two, 'resolved').cents, 25050, 'D2, valued as the earlier report had it');
  assert.equal(figure(two, 'resolution_rate').value, 33.3);
  assert.equal(figure(two, 'velocity').value, 1);
  assert.equal(figure(two, 'days_to_resolve').value, 7, 'D2 was open from the first report, a week before');
  assert.equal(figure(two, 'average_age').value, 15, 'D1 53 days from its opened day; D3 7 since the first report; D4 and D5 none yet');
  assert.equal(figure(two, 'oldest').value, 53);
  assert.equal(figure(two, 'persistent').value, null, 'not known until the series has three reports');

  ids.r3 = (await fileReport(nco.token, 'ULO today.xlsx', R3)).id;
  const three = await series(op.token);
  assert.deepEqual([three.after.id, three.before!.id], [ids.r3, ids.r2], 'the latest against the one before');
  const c3 = three.summary.counts;
  assert.deepEqual([c3.open, c3.before, c3.new, c3.still_open, c3.reopened, c3.resolved], [3, 4, 0, 2, 1, 2]);
  assert.deepEqual([c3.amount_changed, c3.owner_changed, c3.status_changed], [0, 0, 1], 'the workbook’s 900 is the CSV’s 900.00');
  assert.deepEqual([figure(three, 'persistent').value, figure(three, 'recurring').value], [1, 1], 'D1 open on all three; D2 came back after it was resolved');
  assert.equal(figure(three, 'resolution_rate').value, 50);
  assert.equal(figure(three, 'value_resolved').value, 8525);
  assert.equal(figure(three, 'velocity').value, 2);
  assert.equal(figure(three, 'days_to_resolve').value, 10.5, 'D3 14 days, D4 7');
  assert.equal(figure(three, 'average_age').value, 27, 'D1 60, D2 14, D5 7');
  assert.deepEqual(three.oldest.map((o) => [o.identifier, o.days, o.basis]), [['D1', 60, 'opened'], ['D2', 14, 'first_seen'], ['D5', 7, 'first_seen']]);
  assert.deepEqual(three.groups.category.map((l) => [l.label, l.open, l.still_open, l.reopened, l.resolved]),
    [['Unmatched', 1, 1, 0, 1], ['Duplicate', 1, 0, 1, 0], ['Sync', 1, 1, 0, 0], ['Overage', 0, 0, 0, 1]]);
  assert.deepEqual(three.groups.owner!.map((l) => [l.label, l.open, l.resolved]),
    [['LCpl Ftl Marine', 2, 0], ['LCpl Nco Marine', 1, 0], ['No Marine named', 0, 1], ['Somebody Else', 0, 1]], 'a Marine by name, else the owner as written');
  assert.deepEqual(three.trend.map((t) => t.open_count), [3, 4, 3]);

  const span = await series(op.token, { against: ids.r1 });
  assert.equal(span.before!.id, ids.r1, 'any earlier report of the series');
  assert.deepEqual([span.summary.counts.still_open, span.summary.counts.resolved, span.summary.counts.new], [2, 1, 1], 'D1 and D2 open on both; D3 resolved; D5 new');
  const backwards = await get(op.token, `/api/error-reports/series?${qs({ unit_id: 'G8', type_id: ulo, snapshot: ids.r1, against: ids.r3 })}`);
  assert.equal(backwards.status, 400, 'compared only with an earlier report');
});

test('every figure opens exactly the rows it counts, each with its file, row and every column', async () => {
  const three = await series(op.token);
  for (const f of three.summary.figures.filter((x) => x.kind === 'count' && x.value != null && x.drill)) {
    const res = await drill(op.token, { drill: f.drill! });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body as DrillResult;
    assert.equal(d.total, f.value, `${f.id}: as many rows as the figure`);
    if (f.id !== 'amount_changed') assert.equal(d.cents, f.cents, `${f.id}: the value of those rows`);
  }
  const resolved = (await drill(op.token, { drill: 'resolved' })).body as DrillResult;
  assert.deepEqual(resolved.rows.map((r) => [r.identifier, r.filename, r.as_of, r.source_row]).sort(), [['D3', 'ULO 7 days ago.csv', R2_DAY, 3], ['D4', 'ULO 7 days ago.csv', R2_DAY, 4]], 'a resolved row is shown as the earlier report had it');
  const open = (await drill(op.token, { drill: 'open' })).body as DrillResult;
  const d1 = open.rows.find((r) => r.identifier === 'D1')!;
  assert.equal(d1.filename, 'ULO today.xlsx');
  assert.equal(d1.data.Description, 'Obligation not liquidated');
  assert.equal(d1.marine, 'LCpl Ftl Marine');
  assert.deepEqual(open.rows.map((r) => r.identifier), ['D1', 'D2', 'D5'], 'oldest first');
  const byGroup = (await drill(op.token, { drill: 'open', group: 'owner', value: `user:${ftl.id}` })).body as DrillResult;
  assert.deepEqual(byGroup.rows.map((r) => r.identifier).sort(), ['D1', 'D2'], 'a group line opens its own rows');
  assert.equal(byGroup.group_label, 'LCpl Ftl Marine');
  const unstated = (await drill(op.token, { drill: 'resolved', group: 'owner', value: '' })).body as DrillResult;
  assert.deepEqual(unstated.rows.map((r) => r.identifier), ['D4']);

  // A row whose identifier is a case in the unit's queue links to it.
  const item = await post(op.token, '/api/work/items', { title: 'ULO D1', reference: 'D1', unit_id: 'G8', visibility: 'unit' });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  app.ctx.db.prepare("UPDATE work_items SET natural_key = 'D1' WHERE id = ?").run(item.body.id);
  const linked = (await drill(op.token, { drill: 'persistent' })).body as DrillResult;
  assert.deepEqual(linked.rows.map((r) => [r.identifier, r.case_id]), [['D1', item.body.id]]);
  // A case brought in from this report links; one another report keys the same way does not, as the import decides.
  const caseOf = async (key: string, data: Record<string, string>) => {
    const made = await post(op.token, '/api/work/items', { title: `Case ${key}`, reference: key, unit_id: 'G8', visibility: 'unit' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    app.ctx.db.prepare('UPDATE work_items SET natural_key = ?, data = ? WHERE id = ?').run(key, JSON.stringify(data), made.body.id);
    return made.body.id as string;
  };
  app.ctx.db.prepare('UPDATE work_items SET data = ? WHERE id = ?').run(JSON.stringify({ Document: 'D1', Line: '1', Description: 'Obligation not liquidated', Error: 'Unmatched', Amount: '900', Owner: 'Ftl Marine', Status: 'Open', Office: 'FISCAL' }), item.body.id);
  await caseOf('D5', { PIIN: 'D5', Vendor: 'Acme', 'Amount Due': '40.00', 'Days Unmatched': '12' });
  const d2 = await caseOf('D2', { Document: 'D2', Line: '1', Description: 'Duplicate invoice', Error: 'Duplicate', Amount: '250.50', Status: 'Open' });
  const cased = (await drill(op.token, { drill: 'open' })).body as DrillResult;
  assert.deepEqual(cased.rows.map((r) => [r.identifier, r.case_id]), [['D1', item.body.id], ['D2', d2], ['D5', null]], 'D5 is another report’s case, so it is not offered');
});

test('a report filed in error is withdrawn with a reason, kept, and left out of every comparison', async () => {
  const wrong = await fileReport(nco.token, 'ULO wrong day.csv', R2.replace('40.00', '41.00'), { as_of: dayAfter(D, -3) });
  assert.equal((await series(op.token)).before!.id, wrong.id, 'until withdrawn it is the report before the latest');
  assert.equal((await post(nco.token, `/api/error-reports/snapshots/${wrong.id}/withdraw`, { reason: 'no' })).status, 400, 'a reason in words');
  assert.equal((await post(reader.token, `/api/error-reports/snapshots/${wrong.id}/withdraw`, { reason: 'Not mine to withdraw' })).status, 403);
  assert.equal((await post(g1lead.token, `/api/error-reports/snapshots/${wrong.id}/withdraw`, { reason: 'Not mine to withdraw' })).status, 404, 'from another Unit Instance it is not there');
  const seq = lastSeq();
  const done = await post(nco.token, `/api/error-reports/snapshots/${wrong.id}/withdraw`, { reason: 'Filed against the wrong day' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.withdrawn.reason, 'Filed against the wrong day');
  assert.equal(auditSince(seq).filter((e) => e.action === 'error_snapshot_withdrawn' && e.entity_id === wrong.id).length, 1);
  assert.equal((await post(nco.token, `/api/error-reports/snapshots/${wrong.id}/withdraw`, { reason: 'And again, for luck' })).status, 409);
  const after = await series(op.token);
  assert.equal(after.before!.id, ids.r2, 'the comparison skips it');
  assert.ok(after.reports.find((r) => r.id === wrong.id)!.withdrawn, 'and the series still lists it, withdrawn');
  assert.equal((await get(op.token, `/api/error-reports/series?${qs({ unit_id: 'G8', type_id: ulo, against: wrong.id })}`)).status, 400, 'in no comparison');
  assert.equal(count('SELECT COUNT(*) AS n FROM error_snapshot_rows WHERE snapshot_id = ?', wrong.id), 4, 'its rows are kept');
  const refiled = await fileReport(nco.token, 'ULO wrong day.csv', R2.replace('40.00', '41.00'), { as_of: dayAfter(D, -2) });
  assert.ok(refiled.id, 'its file may be filed again, for the right day');
  assert.equal((await post(nco.token, `/api/error-reports/snapshots/${refiled.id}/withdraw`, { reason: 'Only proving it could be filed again' })).status, 200);

  // A series whose every report was withdrawn still reads, as its history: nothing to compare, and each kept with why.
  const ocmt = ((await get(op.token, '/api/error-reports?unit_id=G8')).body as ErrorReportsOverview).types.find((t) => t.code === 'OCMT')!;
  const only = await fileReport(nco.token, 'OCMT.csv', R1, { type_id: ocmt.id, as_of: R1_DAY });
  assert.equal((await post(nco.token, `/api/error-reports/snapshots/${only.id}/withdraw`, { reason: 'Filed as OCMT, but it was the ULO' })).status, 200);
  const seq2 = lastSeq();
  const history = await get(op.token, `/api/error-reports/series?${qs({ unit_id: 'G8', type_id: ocmt.id })}`);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  const h = history.body as SeriesHistory;
  assert.equal(h.after, null);
  assert.deepEqual(h.reports.map((r) => [r.id, r.withdrawn?.reason]), [[only.id, 'Filed as OCMT, but it was the ULO']]);
  assert.match(h.notes[0], /withdrawn/);
  assert.match(auditSince(seq2).find((e) => e.action === 'view_error_report')!.detail, /^OCMT: every report withdrawn \(1\)$/);
  const none = await drill(op.token, { type_id: ocmt.id, drill: 'open' });
  assert.equal(none.status, 404, 'and no figure to open');
  assert.match(none.body.error, /withdrawn/);
});

test('a filed report is never changed or deleted, in the database itself', async () => {
  const db = app.ctx.db;
  assert.throws(() => db.prepare('UPDATE error_snapshot_rows SET amount_cents = 1 WHERE snapshot_id = ?').run(ids.r1));
  assert.throws(() => db.prepare('DELETE FROM error_snapshot_rows WHERE snapshot_id = ?').run(ids.r1));
  assert.throws(() => db.prepare('UPDATE error_snapshots SET open_count = 0 WHERE id = ?').run(ids.r1));
  assert.throws(() => db.prepare('DELETE FROM error_snapshots WHERE id = ?').run(ids.r1));
  const withdrawn = db.prepare('SELECT id FROM error_snapshots WHERE withdrawn_at IS NOT NULL LIMIT 1').get() as { id: string };
  assert.throws(() => db.prepare("UPDATE error_snapshots SET withdrawn_reason = 'rewritten' WHERE id = ?").run(withdrawn.id), 'a withdrawal is final too');
  assert.throws(() => db.prepare('UPDATE error_snapshots SET withdrawn_at = ?, withdrawn_by = ? WHERE id = ?').run(new Date().toISOString(), op.id, ids.r1), 'a withdrawal needs its reason');
  assert.equal(count('SELECT COUNT(*) AS n FROM error_snapshot_rows WHERE snapshot_id = ? AND amount_cents = 100000', ids.r1), 1, 'nothing changed');
  // A report, its type and its unit are one Unit Instance's.
  const g1Type = errorReportTypesOf(app.ctx, 'G1')[0].id;
  const r1 = db.prepare('SELECT * FROM error_snapshots WHERE id = ?').get(ids.r1) as Record<string, any>;
  assert.throws(() => db.prepare(`INSERT INTO error_snapshots (id, org_id, unit_id, type_id, source_file_id, filename, sha256, as_of, sheet_name, header_row, key_columns, columns, closed_statuses, row_count, open_count, open_cents, rejected_rows, rejections, filed_by, filed_at)
    VALUES ('x-1', 'G8', 'G8', ?, ?, 'x.csv', 'abc', '2026-01-01', 'x', 1, '[]', '{}', '[]', 0, 0, 0, 0, '[]', ?, ?)`).run(g1Type, r1.source_file_id, op.id, new Date().toISOString()), /cross_instance/);
});

// ——— Who may do what ———

test('reading needs the unit’s shared records, filing posting its work, and figures by Marine its member records', async () => {
  for (const who of [nco, ftl, snco, reader, op]) assert.equal((await get(who.token, '/api/error-reports?unit_id=G8')).status, 200);
  assert.equal((await get(marine.token, '/api/error-reports?unit_id=FISCAL')).status, 403, 'a Marine without the unit’s shared records reads none of its error reports');
  for (const path of [`/api/error-reports/series?unit_id=G8&type_id=${ulo}`, `/api/error-reports/rows?unit_id=G8&type_id=${ulo}&drill=open`, '/api/error-reports/choices?unit_id=G8', `/api/error-reports/layout?unit_id=G8&type_id=${ulo}`]) {
    assert.equal((await get(marine.token, path)).status, 403, path);
    const other = await get(g1lead.token, path);
    assert.ok([403, 404].includes(other.status), `another Unit Instance's leader: ${path} ${other.status}`);
  }
  const fiscal = await get(op.token, '/api/error-reports?unit_id=FISCAL');
  assert.equal(fiscal.body.series.length, 0, 'a unit sees the series filed for it and beneath it, not those above');
  assert.ok((await get(op.token, '/api/error-reports?unit_id=G8')).body.series.length >= 1);

  const asReader = (await get(reader.token, '/api/error-reports?unit_id=G8')).body as ErrorReportsOverview;
  assert.deepEqual(asReader.can, { file: false, detail: false, files: false });
  const p = await plan(op.token, 'ULO by reader.csv', R2, { as_of: dayAfter(D, -1) });
  assert.equal((await post(reader.token, '/api/error-reports/preview', p)).status, 403, 'reading is not filing');
  assert.equal((await post(reader.token, '/api/error-reports/snapshots', p)).status, 403);

  const asNco = await series(nco.token);
  assert.equal(asNco.groups.owner, null, 'figures by Marine need opening member records');
  assert.ok(!('oldest' in asNco.summary), 'the oldest go out without the rows they were read from');
  for (const id of [nco.id, ftl.id]) assert.ok(!JSON.stringify(asNco).includes(id), 'nothing in the comparison says which Marine an owner names');
  const samplePlan = await plan(nco.token, 'ULO sample.csv', R2, { as_of: dayAfter(D, -1) });
  const sampleAsNco = (await post(nco.token, '/api/error-reports/preview', samplePlan)).body as ErrorReportPreview;
  assert.ok(sampleAsNco.sample.length && sampleAsNco.sample.every((r) => r.owner_user_id === null), 'nor does the preview, to a filer who may not open member records');
  assert.equal(sampleAsNco.owners.matched, 2, 'only how many were matched');
  const sampleAsFtl = (await post(ftl.token, '/api/error-reports/preview', samplePlan)).body as ErrorReportPreview;
  assert.equal(sampleAsFtl.sample.find((r) => r.key === 'D1')!.owner_user_id, ftl.id, 'one who may sees the Marine');
  assert.equal((await drill(nco.token, { drill: 'open', group: 'owner', value: `user:${ftl.id}` })).status, 403);
  const rows = (await drill(nco.token, { drill: 'open' })).body as DrillResult;
  assert.ok(rows.rows.every((r) => r.marine === null), 'nor does a row name the Marine it was matched to');
  assert.ok(rows.rows.some((r) => r.owner === 'Ftl Marine'), 'the owner as the report wrote it is the report’s');
  assert.ok((await series(ftl.token)).groups.owner, 'a Fire Team Leader sees them');

  // Vantage can withhold spreadsheet intake from one Unit Instance: no report is filed there, and those filed stay readable.
  app.ctx.db.prepare("INSERT INTO instance_feature_flags (org_id, flag, reason, set_by, set_at) VALUES ('G8', 'intake', 'Paused for a records review', ?, ?)").run(op.id, new Date().toISOString());
  try {
    const refused = await post(nco.token, '/api/error-reports/preview', p);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'feature_withheld');
    assert.equal((await get(nco.token, `/api/error-reports/series?unit_id=G8&type_id=${ulo}`)).status, 200);
  } finally {
    app.ctx.db.prepare("DELETE FROM instance_feature_flags WHERE org_id = 'G8' AND flag = 'intake'").run();
  }

  // A file uploaded in another Unit Instance is filed there, never here.
  const g1file = await upload(g1lead.token, 'G1 ULO.csv', R2, 'G1');
  assert.equal(g1file.status, 201, JSON.stringify(g1file.body));
  assert.equal((await post(g1lead.token, '/api/error-reports/preview', { ...p, source_file_id: g1file.body.id })).status, 403, 'not a reader of G8');
  assert.equal((await post(op.token, '/api/error-reports/preview', { ...p, source_file_id: g1file.body.id })).status, 403, 'nor is another Unit Instance’s upload readable here');
});

test('a leader files for a unit beneath theirs from their own upload, and a role held only in G8 reads no series beneath it', async () => {
  // The intake shares a file only with a unit its uploader belongs to, so the page uploads it as the filer's own.
  assert.equal((await upload(nco.token, 'FISCAL ULO.csv', R2, 'FISCAL')).status, 403, 'the NCO is not a member of FISCAL');
  const own = await app.call('POST', '/api/work/sources', { token: nco.token, raw: Buffer.from(R2), headers: { 'content-type': CSV, 'x-filename': 'FISCAL ULO.csv', 'x-visibility': 'private' } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(((await get(nco.token, '/api/error-reports?unit_id=FISCAL')).body as ErrorReportsOverview).can.file, true, 'authority in G8 reaches FISCAL');
  const filed = await post(nco.token, '/api/error-reports/snapshots', {
    unit_id: 'FISCAL', type_id: ulo, as_of: D, source_file_id: own.body.id, sheet_name: 'FISCAL ULO.csv', header_row: 1, key_columns: ['Document'], columns: COLUMNS, closed_statuses: ['closed'],
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  assert.ok(((await get(op.token, '/api/error-reports?unit_id=G8')).body as ErrorReportsOverview).series.some((s) => s.unit_id === 'FISCAL'), 'G8’s overview lists it');

  // A role with no authority (position 0) views G8's shared records and nothing beneath: so does the overview.
  app.ctx.db.prepare("INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES ('G8:viewer', 'G8', 'viewer', 'Viewer', ?, 0, ?)")
    .run(PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS, new Date().toISOString());
  const viewer = await app.register('viewer'); await enroll(app, op.token, 'G8', viewer.id, 'viewer'); viewer.token = await login('viewer');
  assert.equal((await get(viewer.token, '/api/error-reports?unit_id=FISCAL')).status, 403);
  const g8 = (await get(viewer.token, '/api/error-reports?unit_id=G8')).body as ErrorReportsOverview;
  assert.ok(g8.series.length >= 1, 'G8’s own series');
  assert.ok(g8.series.every((s) => s.unit_id === 'G8'), 'and none of FISCAL’s');
});

test('every read is in the audit trail, with what was read', async () => {
  const seq = lastSeq();
  await get(snco.token, '/api/error-reports?unit_id=G8');
  await series(snco.token);
  await drill(snco.token, { drill: 'resolved' });
  const reads = auditSince(seq).filter((e) => e.action === 'view_error_report');
  assert.equal(reads.length, 3);
  assert.ok(reads.every((e) => e.actor_id === snco.id && e.unit_id === 'G8'));
  assert.match(reads[0].detail, /overview/);
  assert.match(reads[1].detail, /^ULO as of .* against /);
  assert.match(reads[2].detail, /resolved rows \(2\)/);
  const choices = await get(snco.token, '/api/error-reports/choices?unit_id=G8');
  assert.equal(choices.status, 200);
  assert.equal(auditSince(seq).filter((e) => e.action === 'view_error_report').length, 3, 'the report library’s choices are names and days, no figures');
  const uloChoice = choices.body.types.find((t: { code: string }) => t.code === 'ULO');
  const withdrawn = new Set((app.ctx.db.prepare('SELECT id FROM error_snapshots WHERE withdrawn_at IS NOT NULL').all() as Array<{ id: string }>).map((r) => r.id));
  assert.ok(withdrawn.size > 0 && !uloChoice.reports.some((r: { id: string }) => withdrawn.has(r.id)), 'a withdrawn report is not offered');
});

// ——— The report library ———

test('the report library prints and files the comparison, and its figures are the page’s', async () => {
  const run = (token: string, params: Record<string, string>) => get(token, `/api/report-center/run?${qs({ type: 'comparison', unit_id: 'G8', ...params })}`);
  const brief = await run(snco.token, {});
  assert.equal(brief.status, 200, JSON.stringify(brief.body));
  assert.equal(primaryTable(brief.body as ReportDocument)!.id, 'series', 'without a type, the unit’s series in brief');

  const doc = (await run(snco.token, { error_type: ulo })).body as ReportDocument & { files: string[] };
  assert.equal(doc.type, 'comparison');
  assert.deepEqual(doc.files, ['pdf', 'csv', 'xlsx', 'json'], 'an SNCO may take the unit’s data away');
  const page = await series(snco.token);
  const shown = (label: string) => doc.summary.find((f) => f.label === label)?.value;
  assert.equal(shown('Open'), page.summary.counts.open);
  assert.equal(shown('Resolved'), page.summary.counts.resolved);
  assert.equal(shown('Resolved, value'), 85.25);
  assert.equal(shown('Resolution rate'), 50);
  const changes = primaryTable(doc)!;
  assert.equal(changes.id, 'changes');
  assert.deepEqual(changes.rows.map((r) => r.identifier), ['D2', 'D1', 'D5', 'D3', 'D4'], 'reopened, still open, then resolved');
  assert.ok(doc.sections.flatMap((s) => s.tables).some((t) => t.id === 'by_marine'), 'an SNCO opens member records');
  assert.equal(doc.filters.find((f) => f.label === 'Compared with')!.value, R2_DAY);

  const asNco = (await run(nco.token, { error_type: ulo })).body as ReportDocument & { files: string[] };
  assert.deepEqual(asNco.files, [], 'no file for a reader without the export permission; it prints');
  assert.ok(!asNco.sections.flatMap((s) => s.tables).some((t) => t.id === 'by_marine'));
  assert.equal((await run(marine.token, { unit_id: 'FISCAL', error_type: ulo })).status, 403);
  const csv = await get(snco.token, `/api/report-center/export?${qs({ type: 'comparison', unit_id: 'G8', error_type: ulo, format: 'csv' })}`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /D1/);
  assert.equal((await get(nco.token, `/api/report-center/export?${qs({ type: 'comparison', unit_id: 'G8', error_type: ulo, format: 'csv' })}`)).status, 403);
});

test('the Unit Instance’s report types travel in its configuration file', async () => {
  const exported = await get(op.token, '/api/orgs/G8/configuration/export');
  assert.equal(exported.status, 200);
  const file = exported.body;
  assert.ok(file.errorReportTypes.some((t: { code: string }) => t.code === 'ULO'));
  assert.ok(!file.errorReportTypes.some((t: { code: string }) => t.code === 'GTCC'), 'a retired one is not carried');
  const planG1 = await post(g1lead.token, '/api/orgs/G1/configuration/import', { ...file, errorReportTypes: [...file.errorReportTypes, { code: 'GTCC', name: 'Travel card delinquencies', description: null }] });
  assert.equal(planG1.status, 200, JSON.stringify(planG1.body));
  const lines = planG1.body.lines.filter((l: { kind: string }) => l.kind === 'error_report_type');
  assert.ok(lines.some((l: { label: string; outcome: string }) => l.label.startsWith('GTCC') && l.outcome === 'add'));
});
