import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { runDigestTick, localClock } from '../../server/services/digest.ts';
import { upsertMaradmins } from '../../server/services/maradmins.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => { app = await startApp(); op = await app.setupOperator(); });
after(async () => { await app.close(); });

test('digest preview composes the week and sends on the configured slot only', async () => {
  await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Closed 12 UMTs', date: new Date().toISOString().slice(0, 10), dollar_amount: 500, dollar_type: 'saved' } });
  await app.call('POST', '/api/records/tasks', { token: op.token, body: { title: 'Late task', due_date: '2020-01-01' } });
  upsertMaradmins(app.ctx, [{ id: 'maradmin-001-26', number: '001/26', title: 'TEST MESSAGE', summary: 's', url: 'https://x', tags: ['General'], audience: ['All Marines'], published_at: new Date().toISOString(), source_hash: 'h' }]);
  const preview = await app.call('GET', '/api/me/digest/preview', { token: op.token });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.text.includes('Closed 12 UMTs'));
  assert.ok(preview.body.text.includes('Overdue: Late task'));
  assert.ok(preview.body.text.includes('001/26'));
  assert.equal(preview.body.stats.overdue, 1);

  const clock = localClock(app.ctx.config.timezone);
  await app.call('PUT', '/api/me/prefs', { token: op.token, body: { digest: { enabled: true, weekday: (clock.weekday + 1) % 7, hour: clock.hour } } });
  assert.equal((await runDigestTick(app.ctx)).sent, 0);
  await app.call('PUT', '/api/me/prefs', { token: op.token, body: { digest: { enabled: true, weekday: clock.weekday, hour: clock.hour } } });
  const before = app.ctx.mailer.outbox.length;
  assert.equal((await runDigestTick(app.ctx)).sent, 1);
  assert.equal(app.ctx.mailer.outbox.length, before + 1);
  assert.ok(app.ctx.mailer.outbox.at(-1)!.subject.startsWith('Vantage weekly'));
  assert.equal((await runDigestTick(app.ctx)).sent, 0, 'does not resend within the week');
  const now = await app.call('POST', '/api/me/digest/send-now', { token: op.token });
  assert.equal(now.status, 200);
});

test('operator email test and digest run endpoints', async () => {
  const t = await app.call('POST', '/api/admin/email/test', { token: op.token, body: {} });
  assert.equal(t.status, 200);
  assert.equal(app.ctx.mailer.outbox.at(-1)!.subject, 'Vantage email test');
  assert.equal((await app.call('POST', '/api/admin/digest/run', { token: op.token })).status, 200);
});

test('MARADMIN listing and per-user state', async () => {
  app.ctx.runtime.maradminsEnabled = false;
  const list = await app.call('GET', '/api/maradmins', { token: op.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.rows.length, 1);
  const st = await app.call('PUT', '/api/maradmins/maradmin-001-26/state', { token: op.token, body: { read: true, saved: true } });
  assert.ok(st.body.read_at && st.body.saved_at);
  assert.ok((await app.call('GET', '/api/maradmins', { token: op.token })).body.rows[0].saved_at);
  assert.equal((await app.call('PUT', '/api/maradmins/nope/state', { token: op.token, body: { read: true } })).status, 404);
});
