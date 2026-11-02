import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { guidanceForCase } from '../../server/services/caseGuidance.ts';
import type { SessionUser } from '../../server/context.ts';
import type { Scope } from '../../server/authz/scope.ts';
import type { WorkItemRow } from '../../server/services/work.ts';
import type { CaseDiagnosis, Statement } from '../../shared/caseDiagnosis.ts';

/**
 * The automatic financial case diagnoser on the server (Task 16, ADR-0022): every case a reader opens is diagnosed from what
 * that reader may see; guidance is put on file by the people who answer for it, never edited or removed, every change
 * audited; a past case is an example only at the hands of a leader who did not resolve it, offered only to its readers;
 * and nothing crosses a Unit Instance.
 */

type Who = { token: string; id: string };
let app: TestApp;
let op: Who & { unitId: string };
/** G8: an NCO works and resolves cases; an SNCO also reassigns; a Marine of G8 cannot read the unit's records. */
let nco: Who;
let snco: Who;
let plain: Who;
/** A Marine of G8 Fiscal only, and the Lead Unit Manager of another Unit Instance. */
let fiscal: Who;
let g1lead: Who;
const ids: Record<string, string> = {};

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
const auditSince = (seq: number) => app.ctx.db.prepare('SELECT action, actor_id, org_id, unit_id, category, detail FROM audit_log WHERE seq > ? ORDER BY seq').all(seq) as Array<{ action: string; actor_id: string | null; org_id: string | null; unit_id: string | null; category: string | null; detail: string }>;
const diagnosis = async (token: string, id: string) => {
  const res = await get(token, `/api/work/items/${id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.case as { diagnosis: CaseDiagnosis; example: { current: any; may_validate: boolean; reason: string | null; may_withdraw: boolean } };
};
const statements = (d: CaseDiagnosis) => d.sections.flatMap((s) => s.statements);
const has = (d: CaseDiagnosis, text: string) => statements(d).some((s) => s.text.includes(text));
const upload = (token: string, filename: string, csv: string, unit = 'G8') =>
  app.call('POST', '/api/work/sources', { token, raw: Buffer.from(csv), headers: { 'content-type': 'text/csv', 'x-filename': filename, 'x-unit-id': unit, 'x-visibility': 'unit' } });

const CSV = [
  'Document,Condition,Method,Commitment,Obligation,Delivered,Paid,Error',
  'OB-1,Open commitment,GPC,100.00,-,-,-,',
  'OB-2,Undelivered order,GCSS-MC,100.00,100.00,50.00,50.00,',
  'OB-5,Row five,,,,,,Invoice on hold: quantity billed exceeds quantity received',
  'OB-6,Staff a birthday card,,,,,,',
].join('\n');
const MAPPING = { Document: 'reference', Condition: 'title', Method: 'purchase_method', Commitment: 'commitment', Obligation: 'obligation', Delivered: 'delivered', Paid: 'paid', Error: 'error_text' };
const SOP = { authority: 'approved_local_sop', issue: 'udou', section: 'research', text: 'Ask the supply chief for the back-order report before touching the obligation.', citation: 'G-8 SOP 7300.2 para 4.b', approved_by: 'Comptroller, G-8' };

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  nco = await app.register('nco'); await enroll(app, op.token, 'G8', nco.id, 'nco'); nco.token = await login('nco');
  snco = await app.register('snco'); await enroll(app, op.token, 'G8', snco.id, 'snco'); snco.token = await login('snco');
  plain = await app.register('plain'); await enroll(app, op.token, 'G8', plain.id); plain.token = await login('plain');
  fiscal = await app.register('fiscal'); await enroll(app, op.token, 'FISCAL', fiscal.id, 'nco'); fiscal.token = await login('fiscal');
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');
});
after(async () => { await app.close(); });

test('an import is read before it is brought in, each case opens with its diagnosis, and the queue carries a line of it', async () => {
  const src = await upload(op.token, 'balances.csv', CSV);
  assert.equal(src.status, 201, JSON.stringify(src.body));
  const plan = { source_file_id: src.body.id, sheet_name: 'balances.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit', mapping: MAPPING };
  const preview = await post(op.token, '/api/work/imports/preview', plan);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const readings = Object.fromEntries((preview.body.readings as Array<{ issue: string | null; how: string | null; rows: number }>).map((r) => [`${r.issue}/${r.how}`, r.rows]));
  assert.deepEqual(readings, { 'ocmt/figures': 1, 'udou/figures': 1, 'invoice_hold/error_label': 1, 'null/null': 1 });
  assert.equal((await post(op.token, '/api/work/imports', plan)).status, 201);

  const list = await get(nco.token, '/api/work/items?q=OB-');
  assert.equal(list.status, 200);
  for (const row of list.body.items) ids[row.reference] = row.id;
  const line = Object.fromEntries(list.body.items.map((r: any) => [r.reference, r.diagnosis]));
  assert.equal(line['OB-2'].issue, 'UDOU');
  assert.match(line['OB-2'].headline, /^Undelivered order, unpaid \(UDOU\)\./);
  assert.equal(line['OB-6'].issue, null);
  assert.ok(line['OB-1'].unknown > 0 && line['OB-1'].decisions > 0);

  const { diagnosis: d } = await diagnosis(nco.token, ids['OB-2']);
  assert.equal(d.issue.key, 'udou');
  assert.equal(d.issue.how, 'figures');
  assert.equal(d.issue.applied, false);
  assert.equal(d.ai, false);
  const commitment = statements(d).find((s) => s.text === 'Commitment: $100.00.')!;
  assert.equal(commitment.label, 'known_fact');
  assert.equal(commitment.from, 'Imported from balances.csv, row 3, column “Commitment”', 'a fact names the file, row and column it came from');
  assert.ok(statements(d).every((s) => s.label !== 'recommendation' || s.basis), 'every recommendation names its source');
});

test('a Unit Manager puts the command’s SOPs on file; nobody else does, and nothing on file is ever edited or removed', async () => {
  const seq = lastSeq();
  assert.equal((await post(nco.token, '/api/orgs/G8/case-guidance', SOP)).status, 404, 'a member with no Unit Instance role is not told the console exists');
  assert.equal((await get(g1lead.token, '/api/orgs/G8/case-guidance')).status, 404, 'another Unit Instance’s manager reads nothing here');
  const asPolicy = await post(op.token, '/api/orgs/G8/case-guidance', { ...SOP, authority: 'official_policy' });
  assert.equal(asPolicy.status, 400, 'a command does not put official policy on file for itself');
  assert.equal((await post(op.token, '/api/orgs/G8/case-guidance', { ...SOP, approved_by: '' })).status, 400, 'an SOP names who approved it');
  assert.equal((await post(op.token, '/api/orgs/G8/case-guidance', { ...SOP, citation: '' })).status, 400, 'and is cited');

  const added = await post(op.token, '/api/orgs/G8/case-guidance', SOP);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const first = added.body.id as string;
  const entry = auditSince(seq).find((e) => e.action === 'case_guidance_added')!;
  assert.equal(entry.org_id, 'G8');
  assert.equal(entry.category, 'unit');
  assert.match(entry.detail, /approved_local_sop · udou · research: G-8 SOP 7300.2 para 4\.b/);

  let { diagnosis: d } = await diagnosis(nco.token, ids['OB-2']);
  const given = statements(d).find((s) => s.text === SOP.text)!;
  assert.equal(given.label, 'recommendation');
  assert.equal(given.basis!.authority, 'approved_local_sop');
  assert.equal(given.basis!.rank, 3);
  assert.equal(given.basis!.citation, SOP.citation);
  assert.equal(d.sources.find((s) => s.authority === 'approved_local_sop')!.on_file, 1);
  assert.ok(!has((await diagnosis(nco.token, ids['OB-1'])).diagnosis, SOP.text), 'a UDOU SOP is not given to an OCMT case');

  // A change is a new wording that retires the old; the old keeps its words.
  const reworded = await post(op.token, '/api/orgs/G8/case-guidance', { ...SOP, text: 'Ask the supply chief for the back-order report first.', supersedes_id: first });
  assert.equal(reworded.status, 201, JSON.stringify(reworded.body));
  const old = app.ctx.db.prepare('SELECT text, retired_at, retired_reason FROM case_guidance WHERE id = ?').get(first) as { text: string; retired_at: string | null; retired_reason: string };
  assert.equal(old.text, SOP.text);
  assert.ok(old.retired_at);
  assert.equal(old.retired_reason, 'Replaced by a new wording.');
  d = (await diagnosis(nco.token, ids['OB-2'])).diagnosis;
  assert.ok(!has(d, SOP.text) && has(d, 'Ask the supply chief for the back-order report first.'));
  assert.equal((await post(op.token, '/api/orgs/G8/case-guidance', { ...SOP, supersedes_id: first })).status, 409, 'a retired entry is not replaced twice');

  const db = app.ctx.db;
  assert.throws(() => db.prepare("UPDATE case_guidance SET text = 'Edited' WHERE id = ?").run(reworded.body.id), /never changed/);
  assert.throws(() => db.prepare("UPDATE case_guidance SET retired_reason = 'Rewritten' WHERE id = ?").run(first), /stays retired/);
  assert.throws(() => db.prepare('DELETE FROM case_guidance WHERE id = ?').run(first), /never removed/);

  assert.equal((await post(nco.token, `/api/orgs/G8/case-guidance/${reworded.body.id}/retire`, { reason: 'No.' })).status, 404);
  assert.equal((await post(op.token, `/api/orgs/G8/case-guidance/${reworded.body.id}/retire`, { reason: '' })).status, 400, 'a retirement says why');
  const retired = await post(op.token, `/api/orgs/G8/case-guidance/${reworded.body.id}/retire`, { reason: 'Superseded by the 2027 SOP.' });
  assert.equal(retired.status, 200, JSON.stringify(retired.body));
  assert.equal(retired.body.retired_reason, 'Superseded by the 2027 SOP.');
  assert.ok(auditSince(seq).some((e) => e.action === 'case_guidance_retired' && e.org_id === 'G8' && /Superseded by the 2027 SOP/.test(e.detail)));
  assert.ok(!has((await diagnosis(nco.token, ids['OB-2'])).diagnosis, 'back-order report first'));
  const listed = await get(op.token, '/api/orgs/G8/case-guidance');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.entries.length, 2, 'both wordings are kept, retired');
  assert.ok(listed.body.entries.every((g: any) => g.retired_at));

  // A command's SOP binds its own Unit Instance only.
  const live = await post(op.token, '/api/orgs/G8/case-guidance', { ...SOP, text: 'A live G-8 SOP step.' });
  assert.equal(live.status, 201);
  const other = guidanceForCase(app.ctx, { id: g1lead.id } as SessionUser, { unitIds: [], permissions: {}, orgs: {} } as unknown as Scope, { id: 'elsewhere', unit_id: 'G1' } as WorkItemRow);
  assert.ok(!other.some((g) => g.text === 'A live G-8 SOP step.'), 'never given to a case in another Unit Instance');
});

test('a Vantage Administrator puts official guidance on file for every Unit Instance, and only official guidance', async () => {
  const seq = lastSeq();
  const body = { authority: 'official_system_guidance', issue: 'any', section: 'verification', text: 'Confirm the correction posted in DAI before closing.', citation: 'DAI Desk Guide 4.1, sec. 7' };
  assert.equal((await post(nco.token, '/api/platform/case-guidance', body)).status, 403);
  assert.equal((await post(op.token, '/api/platform/case-guidance', { ...body, authority: 'approved_local_sop', approved_by: 'Someone' })).status, 400, 'a command’s SOP is not the service’s');
  const added = await post(op.token, '/api/platform/case-guidance', body);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.enterprise, true);
  const entry = auditSince(seq).find((e) => e.action === 'official_guidance_added')!;
  assert.equal(entry.category, 'enterprise');
  assert.equal(entry.org_id, null);

  const given = statements((await diagnosis(nco.token, ids['OB-6'])).diagnosis).find((s) => s.text === body.text)!;
  assert.equal(given.basis!.authority, 'official_system_guidance');
  assert.equal(given.basis!.rank, 2);
  const elsewhere = guidanceForCase(app.ctx, { id: g1lead.id } as SessionUser, { unitIds: [], permissions: {}, orgs: {} } as unknown as Scope, { id: 'elsewhere', unit_id: 'G1' } as WorkItemRow);
  assert.ok(elsewhere.some((g) => g.text === body.text), 'given in every Unit Instance');
  assert.ok((await get(op.token, '/api/orgs/G8/case-guidance')).body.enterprise.some((g: any) => g.id === added.body.id), 'and shown, read-only, in each console');

  const retired = await post(op.token, `/api/platform/case-guidance/${added.body.id}/retire`, { reason: 'Desk guide reissued.' });
  assert.equal(retired.status, 200);
  assert.ok(auditSince(seq).some((e) => e.action === 'official_guidance_retired' && e.category === 'enterprise'));
  assert.ok(!has((await diagnosis(nco.token, ids['OB-6'])).diagnosis, body.text));
});

test('a resolved, verified case becomes an example only at the hands of another leader, and is offered only to its readers', async () => {
  const id = ids['OB-2'];
  assert.equal((await post(op.token, `/api/work/items/${id}/procedure`, { key: 'udou_research' })).status, 200);
  assert.equal((await post(snco.token, `/api/work/items/${id}/claim`)).status, 200);
  const entry = (body: Record<string, unknown>) => post(snco.token, `/api/work/items/${id}/entries`, body);
  assert.equal((await entry({ kind: 'decision', decision: 'udou_cause', choice: 'valid_back_order', rationale: 'Vendor confirms the balance ships in December.', step: 'cause' })).status, 201);
  assert.equal((await entry({ kind: 'verification', check: 'balance_validated', result: 'verified', reference: 'Vendor email 2026-11-01', step: 'verify_valid' })).status, 201);
  const resolved = await post(snco.token, `/api/work/items/${id}/stage`, { stage: 'resolved', reason: 'Validated as a back-order.' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));

  const mine = (await diagnosis(snco.token, id)).example;
  assert.equal(mine.may_validate, false);
  assert.match(mine.reason!, /You resolved this case/);
  const refused = await post(snco.token, `/api/work/items/${id}/example`, { text: 'Back-orders look like this.' });
  assert.equal(refused.status, 403, 'the person who closed a case does not also hold it up as the way to close the next');
  assert.equal(refused.body.code, 'example_refused');
  assert.equal((await post(nco.token, `/api/work/items/${id}/example`, { text: 'x' })).status, 403, 'only a leader who reassigns the unit’s work validates one');
  assert.equal((await diagnosis(op.token, id)).example.may_validate, true);

  const seq = lastSeq();
  assert.equal((await post(op.token, `/api/work/items/${id}/example`, { text: '' })).status, 400);
  const validated = await post(op.token, `/api/work/items/${id}/example`, { text: 'A vendor’s ship date in writing is what made the balance valid.', section: 'probable_cause' });
  assert.equal(validated.status, 201, JSON.stringify(validated.body));
  assert.equal(validated.body.authority, 'historical_case');
  assert.equal(validated.body.cause, 'valid_back_order');
  assert.match(validated.body.citation, /^Case OB-2, resolved \d{4}-\d{2}-\d{2}$/);
  const audited = auditSince(seq).find((e) => e.action === 'case_example_validated')!;
  assert.equal(audited.unit_id, 'G8');
  assert.equal(audited.category, 'unit');
  assert.equal((await post(op.token, `/api/work/items/${id}/example`, { text: 'Again.' })).status, 409);
  assert.ok((await diagnosis(op.token, id)).diagnosis.sections.every((s) => !s.statements.some((x) => x.basis?.case_id === id)), 'a case is not its own example');

  // Another UDOU case, in G8 Fiscal: its readers who may open OB-2 are offered the example, linked; others are not.
  const made = await post(op.token, '/api/work/items', { unit_id: 'FISCAL', title: 'Undelivered order on a GCSS-MC buy', reference: 'FX-1' });
  assert.equal(made.status, 201);
  assert.equal((await post(op.token, `/api/work/items/${made.body.id}/procedure`, { key: 'udou_research' })).status, 200);
  const offered = statements((await diagnosis(op.token, made.body.id)).diagnosis).find((s: Statement) => s.basis?.authority === 'historical_case')!;
  assert.ok(offered, 'offered to a reader who may open the example');
  assert.equal(offered.basis!.case_id, id);
  assert.equal(offered.basis!.rank, 6);
  assert.ok(!statements((await diagnosis(fiscal.token, made.body.id)).diagnosis).some((s) => s.basis?.authority === 'historical_case'), 'never to a reader who may not open it');

  // A Unit Instance role that reads no unit's work sees the lesson, not which case it was.
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: fiscal.id, role: 'auditor' })).status, 201);
  fiscal.token = await login('fiscal');
  const consoleView = await get(fiscal.token, '/api/orgs/G8/case-guidance');
  assert.equal(consoleView.status, 200, JSON.stringify(consoleView.body));
  assert.equal(consoleView.body.examples[0].case, null);
  assert.equal(consoleView.body.examples[0].citation, 'A resolved case of the unit');
  assert.equal((await post(fiscal.token, `/api/orgs/G8/case-guidance/${validated.body.id}/retire`, { reason: 'x' })).status, 403, 'an auditor changes nothing');

  assert.equal((await post(nco.token, `/api/work/items/${id}/example/withdraw`, { reason: 'No.' })).status, 403);
  const withdrawn = await post(op.token, `/api/work/items/${id}/example/withdraw`, { reason: 'The vendor later cancelled; not a clean example.' });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.ok(auditSince(seq).some((e) => e.action === 'case_example_withdrawn' && e.unit_id === 'G8'));
  assert.ok(!statements((await diagnosis(op.token, made.body.id)).diagnosis).some((s) => s.basis?.authority === 'historical_case'));
  const after = (await diagnosis(op.token, id)).example;
  assert.equal(after.current, null);
  assert.equal(after.may_validate, true, 'it may be validated again, as a new entry');

  // A validated example cites a case of its own Unit Instance, and that case does not move out of it.
  assert.throws(() => app.ctx.db.prepare(
    `INSERT INTO case_guidance (id, org_id, authority, issue, section, text, citation, work_item_id, unit_id, cause, recorded_by, recorded_at)
     VALUES ('smuggled', 'G1', 'historical_case', 'udou', 'probable_cause', 'x', 'x', ?, 'G8', 'valid_back_order', ?, ?)`
  ).run(id, op.id, new Date().toISOString()), /cross_instance|one Unit Instance/);
});

test('what the unit’s error reports say about a case is given to readers of its error reports, and to nobody else', async () => {
  const overview = await get(op.token, '/api/error-reports?unit_id=G8');
  assert.equal(overview.status, 200, JSON.stringify(overview.body));
  const ulo = overview.body.types.find((t: any) => t.code === 'ULO').id as string;
  const report = [
    'Document,Condition,Method,Commitment,Obligation,Delivered,Paid,Error,Status',
    'OB-1,Open commitment,GPC,100.00,-,-,-,,Open',
  ].join('\n');
  const src = await upload(op.token, 'ulo.csv', report);
  assert.equal(src.status, 201, JSON.stringify(src.body));
  const filed = await post(op.token, '/api/error-reports/snapshots', {
    unit_id: 'G8', type_id: ulo, as_of: today(), source_file_id: src.body.id, sheet_name: 'ulo.csv', header_row: 1, key_columns: ['Document'],
    columns: { Document: 'reference', Condition: 'description', Method: 'keep', Commitment: 'keep', Obligation: 'amount', Delivered: 'keep', Paid: 'keep', Error: 'category', Status: 'status' },
    closed_statuses: ['closed'],
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));

  const read = (await diagnosis(nco.token, ids['OB-1'])).diagnosis;
  const listed = statements(read).find((s) => s.text.startsWith('Listed on the Unliquidated obligations report'))!;
  assert.equal(listed.label, 'known_fact');
  assert.ok(statements(read).some((s) => s.label === 'derived_value' && s.text.startsWith('Still open on the latest Unliquidated obligations report')));
  const unread = (await diagnosis(plain.token, ids['OB-1'])).diagnosis;
  assert.ok(!statements(unread).some((s) => /Unliquidated obligations report/.test(s.text)), 'a member who may not read the unit’s records is not told what its reports say');
});
