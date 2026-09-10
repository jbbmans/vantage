import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { listZip } from '../../server/lib/zip.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => { app = await startApp(); op = await app.setupOperator(); });
after(async () => { await app.close(); });

test('the personal export carries every dataset the Marine owns and none of their secrets', async () => {
  const act = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Reconciled 30 ULOs', date: '2026-08-20', quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled', visibility: 'unit', unit_id: 'G8', evidence_links: [{ label: 'ticket', url: 'https://example.mil/t/1' }] } });
  assert.equal(act.status, 201);
  await app.call('POST', '/api/records/goals', { token: op.token, body: { title: 'Reconcile 100 ULOs', metric: 'activity_quantity', target_value: 100, unit_label: 'ULOs' } });
  await app.call('POST', '/api/records/trainings', { token: op.token, body: { title: 'Fiscal law', date: '2026-08-01', hours: 4 } });
  await app.call('POST', '/api/records/awards', { token: op.token, body: { name: 'Certificate of Commendation', status: 'presented', date: '2026-07-04' } });
  const deleted = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Binned entry', date: '2026-08-21' } });
  await app.call('DELETE', `/api/records/activities/${deleted.body.id}`, { token: op.token });
  await app.call('PUT', '/api/me/readiness', { token: op.token, body: { pft_score: 285, cft_score: 290 } });
  const upload = await app.call('POST', `/api/records/activities/${act.body.id}/attachments`, { token: op.token, raw: Buffer.from('%PDF-1.4 test'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'proof.pdf' } });
  assert.ok([201, 400, 403].includes(upload.status), `attachment upload ${upload.status}`);

  const json = await app.call('GET', '/api/me/export?format=json', { token: op.token });
  assert.equal(json.status, 200, JSON.stringify(json.body).slice(0, 300));
  const archive = json.body;
  assert.equal(archive.format, 'vantage-personal/1');
  assert.equal(archive.profile.username, 'boletz');
  assert.equal(archive.profile.rank?.abbr, 'Cpl');
  assert.ok(archive.memberships.some((m: { unit_id: string }) => m.unit_id === 'G8'));
  assert.ok(archive.roles.some((r: { key: string; permission_names: string[] }) => r.key === 'unit-leader' && r.permission_names.includes('ADMINISTRATOR')));
  assert.equal(archive.readiness.pft_score, 285);
  assert.ok(archive.records.activities.some((a: { id: string; deleted_at: string | null }) => a.id === deleted.body.id && a.deleted_at));
  assert.ok(archive.records.activities.some((a: { evidence_links: Array<{ url: string }> }) => a.evidence_links?.[0]?.url === 'https://example.mil/t/1'));
  assert.equal(archive.records.goals.length, 1);
  assert.equal(archive.records.goals[0].current_value, 30);
  assert.equal(archive.records.trainings.length, 1);
  assert.equal(archive.records.awards.length, 1);
  assert.ok(archive.audit_trail.length > 0);
  assert.ok(Array.isArray(archive.notifications));
  const text = JSON.stringify(archive);
  assert.ok(!text.includes('password_hash') && !text.includes('totp_secret') && !text.includes('public_key') && !text.includes('"content"'));

  const zip = await app.call('GET', '/api/me/export?format=zip', { token: op.token, binary: true });
  assert.equal(zip.status, 200);
  const buf = zip.buffer as Buffer;
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const names = listZip(buf);
  for (const expected of ['README.txt', 'vantage-export.json', 'profile.csv', 'readiness.csv', 'units.csv', 'memberships.csv', 'roles.csv', 'activities.csv', 'tasks.csv', 'projects.csv', 'goals.csv', 'trainings.csv', 'awards.csv', 'counselings.csv', 'attachments.csv', 'notifications.csv', 'audit-trail.csv', 'ai-usage.csv', 'email-log.csv']) assert.ok(names.includes(expected), `zip lacks ${expected}: ${names.join(', ')}`);
  if (upload.status === 201) assert.ok(names.some((n) => n.startsWith('attachments/') && n.endsWith('proof.pdf')), names.join(', '));
  const audit = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export_personal' AND actor_id = ?").get(op.id) as { n: number };
  assert.equal(audit.n, 2);
});
