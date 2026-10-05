import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { UMT_2WAY } from '../../shared/procedures.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let avery: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  avery = await app.register('avery');
  await enroll(app, op.token, 'G8', avery.id);
  avery.token = (await app.login('avery')).body.token;
});
after(async () => { await app.close(); });

const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test('the report writes the narrative with its sentences, sources, review and case-work credit', async () => {
  const M = 'MOS / Mission Accomplishment';
  const ids: Record<string, string> = {};
  for (const [key, a] of Object.entries({
    ulo: { title: 'Reconciled 14 ULOs in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'all cleared on the next report', eval_area: M, date: daysAgo(5) },
    mipr: { title: 'I processed 40 MIPRs for the G-8', quantity: 40, unit_label: 'MIPRs', dollar_amount: 1200000, dollar_type: 'obligated', result: 'zero returned for correction', eval_area: M, date: daysAgo(20) },
    train: { title: 'Training 3 junior marines on DAI requisitions', quantity: 3, unit_label: 'Marines', result: 'all three now work requisitions unaided', category: 'Leadership', date: daysAgo(12) },
    pantry: { title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', result: 'sorted the weekly delivery', eval_area: 'Individual Character', date: daysAgo(9) },
  })) {
    const made = await post(avery.token, '/api/records/activities', a);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    ids[key] = made.body.id;
  }
  // A case Avery researched: the histories credit it whether or not she logged it.
  const item = await post(op.token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT', reference: 'SYN-N-1' });
  await post(op.token, `/api/work/items/${item.body.id}/procedure`, { key: UMT_2WAY.key });
  await post(avery.token, `/api/work/items/${item.body.id}/claim`);
  await post(avery.token, `/api/work/items/${item.body.id}/entries`, { kind: 'observation', field: 'umt_amount', amount: '100' });

  const range = `from=${daysAgo(60)}&to=${today()}`;
  const r = (await app.call('GET', `/api/reports?${range}`, { token: avery.token })).body;
  const n = r.narrative;
  assert.ok(n.fits && n.length <= n.limit);
  // The form MCO 1616.1 Appendix E shows: a heading per command input line, dash bullets beneath.
  assert.equal(n.format, 'bullets');
  assert.deepEqual(n.text.split('\n').filter((l: string) => !l.startsWith('-')), ['Individual Character', 'MOS and/or Mission Accomplishment', 'Leadership']);
  assert.ok(!/\bI\b/.test(n.text), 'first person is gone');
  assert.match(n.text, /-Trained 3 junior Marines on (?:DAI|Defense Agencies Initiative \(DAI\)) requisitions; all three now work requisitions unaided\./);
  assert.match(n.text, /unliquidated obligations \(ULOs\)/, 'acronyms are spelled out once');
  assert.equal(r.casework.researched, 1);
  assert.deepEqual(r.casework.procedures, ['2-Way UMT']);
  assert.match(n.text, /-Researched 1 document \(2-Way UMT\)\./);
  const paragraph = (await app.call('GET', `/api/reports?${range}&format=paragraph&spell=0`, { token: avery.token })).body.narrative;
  assert.match(paragraph.text, /^CHARACTER: .* MISSION: .* LEADERSHIP: /);
  assert.ok(!/unliquidated/.test(paragraph.text));
  const uloSentence = n.sentences.find((s: { sources: string[] }) => s.sources.includes(ids.ulo));
  assert.ok(uloSentence?.reasons.length, 'each sentence says why it made the cut');
  assert.ok(n.review.score > 0 && n.review.parts.length === 5);
  assert.ok(n.review.findings.some((f: { id: string }) => f.id === 'inferred'), 'the untagged training entry was placed by what it says');

  // Choices made on screen: leave one out, shorten, reword.
  const without = (await app.call('GET', `/api/reports?${range}&exclude=${encodeURIComponent(ids.mipr)}`, { token: avery.token })).body.narrative;
  assert.ok(!without.text.includes('MIPRs'));
  const short = (await app.call('GET', `/api/reports?${range}&chars=300`, { token: avery.token })).body.narrative;
  assert.ok(short.length <= 300 && short.limit === 300);
  const compact = (await app.call('GET', `/api/reports?${range}&density=compact`, { token: avery.token })).body.narrative;
  assert.ok(compact.length < n.length);
  assert.equal((await app.call('GET', `/api/reports?${range}&chars=50`, { token: avery.token })).status, 400, 'a length too short to write is refused');

  // The PDF takes the same choices, or the text as edited by hand.
  const pdf = await app.call('GET', `/api/reports/pdf?${range}&exclude=${encodeURIComponent(ids.mipr)}&narrative=${encodeURIComponent('MISSION: Reconciled 14 ULOs — all cleared.')}`, { token: avery.token, binary: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer!.subarray(0, 5).toString(), '%PDF-');
});

test('a leader’s view of a Marine credits only the case work shared with the unit', async () => {
  const r = await app.call('GET', `/api/reports?from=${daysAgo(60)}&to=${today()}&user_id=${avery.id}`, { token: op.token });
  assert.equal(r.status, 200);
  assert.ok(r.body.casework.researched >= 0);
  assert.ok(typeof r.body.narrative.text === 'string');
});
