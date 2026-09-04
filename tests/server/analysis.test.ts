import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { startApp, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => { app = await startApp(); op = await app.setupOperator(); });
after(async () => { await app.close(); });

test('the analysis compares the period with the prior one and breaks the record down every way an evaluator reads it', async () => {
  const post = (body: Record<string, unknown>) => app.call('POST', '/api/records/activities', { token: op.token, body });
  // Current window: 1 Jul to 30 Sep 2026. Prior window: April to June.
  for (const a of [
    { title: 'Reconciled 30 ULOs in DAI', date: '2026-07-06', quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled', result: 'cleared the backlog', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', system: 'DAI', organization: 'G-8', evidence_links: [{ url: 'https://example.mil/1' }] },
    { title: 'Processed 12 MIPRs', date: '2026-08-11', quantity: 12, unit_label: 'MIPRs', dollar_amount: 240000, dollar_type: 'obligated', result: 'zero returns', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', system: 'DAI' },
    { title: 'Reviewed the FY close package', date: '2026-09-01', dollar_amount: 5000000, dollar_type: 'reviewed', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment' },
    { title: 'Led PT for 22 Marines', date: '2026-09-02', quantity: 22, unit_label: 'Marines', category: 'Leadership', eval_area: 'Leadership' },
    { title: 'Planned brief', date: '2026-09-20', status: 'planned', category: 'Communications' },
    { title: 'Prior period MIPRs', date: '2026-05-03', quantity: 4, unit_label: 'MIPRs', dollar_amount: 50000, dollar_type: 'obligated', result: 'done', eval_area: 'MOS / Mission Accomplishment' },
  ]) assert.equal((await post(a)).status, 201);
  await app.call('POST', '/api/records/trainings', { token: op.token, body: { title: 'Fiscal law', date: '2026-08-01', hours: 4, type: 'course' } });
  await app.call('POST', '/api/records/awards', { token: op.token, body: { name: 'Certificate of Commendation', status: 'presented', date: '2026-08-15' } });
  await app.call('POST', '/api/records/goals', { token: op.token, body: { title: 'Reconcile 100 ULOs', metric: 'activity_quantity', target_value: 100, unit_label: 'ULOs', period_start: '2026-07-01', period_end: '2026-09-30', status: 'active' } });

  const res = await app.call('GET', '/api/reports/analysis?from=2026-07-01&to=2026-09-30', { token: op.token });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const a = res.body;
  assert.equal(a.counts.current, 4, 'planned entries are excluded');
  assert.equal(a.counts.prior, 1);
  const kpi = (k: string) => a.kpis.find((x: { key: string }) => x.key === k);
  assert.equal(kpi('entries').movement.diff, 3);
  assert.equal(Math.round(kpi('value').value), 241118);
  assert.equal(kpi('reviewed').value, 5000000);
  assert.equal(kpi('training').value, 4);
  assert.equal(kpi('awards').value, 1);
  assert.equal(a.monthly.length, 3);
  assert.deepEqual(a.monthly.map((m: { entries: number }) => m.entries), [1, 1, 2]);
  assert.equal(a.byArea.find((x: { name: string }) => x.name === 'Leadership').entries, 1);
  assert.ok(a.coverage.emptyAreas.includes('Individual Character'));
  const obligated = a.byValueType.find((t: { key: string }) => t.key === 'obligated');
  assert.equal(obligated.amount, 240000);
  assert.equal(obligated.movement.prior, 50000);
  assert.equal(a.byValueType.find((t: { key: string }) => t.key === 'reviewed').summable, false);
  assert.equal(a.bySystem[0].name, 'DAI');
  assert.equal(a.concentration.topByValue[0].title, 'Processed 12 MIPRs');
  assert.ok(a.concentration.top3ValueShare === 100);
  assert.equal(a.coverage.fields.find((f: { key: string }) => f.key === 'evidence').count, 1);
  assert.equal(a.consistency.activeDays, 4);
  assert.equal(a.goals.items[0].current, 64);
  assert.equal(a.career.hoursByType[0].type, 'course');
  assert.ok(a.summary.length >= 3 && a.summary[0].includes('4 entries'));
  assert.equal(a.appendix.length, 4);
  assert.ok(a.appendix.every((e: { strength: number }) => e.strength >= 1 && e.strength <= 5));

  const pdf = await app.call('GET', '/api/reports/analysis.pdf?from=2026-07-01&to=2026-09-30', { token: op.token, binary: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer!.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.buffer!.length > 8000, `pdf is only ${pdf.buffer!.length} bytes`);
  if (process.env.VANTAGE_SAVE_PDF) writeFileSync(process.env.VANTAGE_SAVE_PDF, pdf.buffer!);
  const audit = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'export_pdf' AND actor_id = ? ORDER BY seq DESC LIMIT 1").get(op.id) as { detail: string };
  assert.match(audit.detail, /^analysis;/);
});
