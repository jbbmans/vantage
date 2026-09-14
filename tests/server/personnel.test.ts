import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.ts';

const ROSTER = `DoD ID,Last,First,MI,Grade,PMOS,EAS,RUC,Status
1234567890,Boletz,John,B,Sgt,3451,2027-06-30,G8,Active
9876543210,Rivera,Ana,,LCpl,0311,2026-11-01,G8,Active`;

const post = (app: any, token: string, body: string, qs = '') =>
  app.call('POST', `/api/admin/personnel/sync?source=MCTFS${qs}`, { token, raw: Buffer.from(body), headers: { 'content-type': 'text/plain' } });

test('a roster plan reports what it would do and changes nothing', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const planned = await post(app, op.token, ROSTER);
    assert.equal(planned.status, 200);
    assert.equal(planned.body.applied, false);
    assert.equal(planned.body.plan.counts.creates, 2);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM personnel_roster').get() as { n: number }).n, 0, 'a plan writes nothing');

    const applied = await post(app, op.token, ROSTER, '&apply=1');
    assert.equal(applied.body.applied, true);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM personnel_roster').get() as { n: number }).n, 2);
  } finally { await app.close(); }
});

test('the feed takes over the fields it owns, and the person can no longer edit them', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);
    await post(app, op.token, ROSTER, '&apply=1');

    const me = await app.call('GET', '/api/me', { token: op.token });
    assert.equal(me.body.user.rank_id, 'Sgt', 'the roster rank is now the account rank');

    const edit = await app.call('PUT', '/api/me/profile', { token: op.token, body: { rank_id: 'MSgt' } });
    assert.equal(edit.status, 400);
    assert.equal(edit.body.code, 'field_is_sourced', 'refused by the server, not merely hidden in the client');

    // A field the roster does not carry stays the person's own.
    const ok = await app.call('PUT', '/api/me/profile', { token: op.token, body: { middle_initial: 'B' } });
    assert.equal(ok.status, 200);
  } finally { await app.close(); }
});

test('a changed rank is audited with where it came from and what it was', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890', rank_id = 'Cpl' WHERE id = ?").run(op.id);
    await post(app, op.token, ROSTER, '&apply=1');
    const entry = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'personnel_profile_updated' ORDER BY seq DESC LIMIT 1").get() as { detail: string } | undefined;
    assert.ok(entry, 'the profile change is on the audit trail');
    assert.match(entry!.detail, /MCTFS/);
    assert.match(entry!.detail, /rank_id Cpl → Sgt/);
  } finally { await app.close(); }
});

test('an extract that would empty the roster is refused until it is confirmed', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    await post(app, op.token, ROSTER, '&apply=1');

    const shrunk = 'DoD ID,Last,First,Grade\n1234567890,Boletz,John,Sgt';
    const refused = await post(app, op.token, shrunk, '&apply=1');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, 'mass_separation');
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM personnel_roster WHERE status = 'active'").get() as { n: number }).n, 2, 'nobody was separated');

    const confirmed = await post(app, op.token, shrunk, '&apply=1&confirm_separations=1');
    assert.equal(confirmed.status, 200);
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM personnel_roster WHERE status = 'separated'").get() as { n: number }).n, 1);
  } finally { await app.close(); }
});

test('separation deactivates the account but never deletes the record', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const member = await app.register('rivera');
    app.ctx.db.prepare("UPDATE users SET edipi = '9876543210' WHERE id = ?").run(member.id);
    await app.call('POST', '/api/records/activities', { token: member.token, body: { title: 'Their work', date: '2026-09-01', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment' } });
    await post(app, op.token, ROSTER, '&apply=1');

    await post(app, op.token, 'DoD ID,Last,First,Grade\n1234567890,Boletz,John,Sgt', '&apply=1&confirm_separations=1');
    const user = app.ctx.db.prepare('SELECT active FROM users WHERE id = ?').get(member.id) as { active: number };
    assert.equal(user.active, 0, 'the account is deactivated');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE user_id = ?').get(member.id) as { n: number }).n, 1, 'their record survives');
  } finally { await app.close(); }
});

test('a row without a usable EDIPI is rejected with its line, never guessed at', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const res = await post(app, op.token, 'DoD ID,Last,First\n123,Short,Id\n1234567890,Good,Row');
    assert.equal(res.body.plan.counts.rejected, 1);
    assert.equal(res.body.plan.counts.creates, 1);
    assert.match(res.body.plan.rejected[0].reason, /ten-digit/);
  } finally { await app.close(); }
});

test('two accounts cannot claim one EDIPI', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const member = await app.register('rivera');
    const first = await app.call('POST', '/api/admin/personnel/link', { token: op.token, body: { user_id: op.id, edipi: '1234567890' } });
    assert.equal(first.status, 200);
    const second = await app.call('POST', '/api/admin/personnel/link', { token: op.token, body: { user_id: member.id, edipi: '1234567890' } });
    assert.equal(second.status, 400, 'the second link is refused');
  } finally { await app.close(); }
});

test('the personnel feed is operator-only', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    const member = await app.register('member');
    const res = await post(app, member.token, ROSTER, '&apply=1');
    assert.ok(res.status === 403 || res.status === 404, `a member cannot run a sync (got ${res.status})`);
  } finally { await app.close(); }
});
