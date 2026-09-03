import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let rivera: { token: string; id: string };
let nguyen: { token: string; id: string };
let outsider: { token: string; id: string };
before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  rivera = await app.register('rivera');
  nguyen = await app.register('nguyen', { rank_id: 'Sgt' });
  outsider = await app.register('outsider');
  await enroll(app, op.token, 'G8', rivera.id);
  await enroll(app, op.token, 'G8', nguyen.id, 'snco');
  // Enrollment revokes sessions so the new authority is picked up.
  rivera.token = (await app.login('rivera')).body.token;
  nguyen.token = (await app.login('nguyen')).body.token;
});
after(async () => { await app.close(); });

test('validation rejects bad records with field errors', async () => {
  const res = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: '', date: '2026-13-01', quantity: -1 } });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.title && res.body.fieldErrors.date && res.body.fieldErrors.quantity);
  assert.equal((await app.call('POST', '/api/records/nonsense', { token: rivera.token, body: {} })).status, 404);
});

test('private records stay owner-only; unit records reach authorized readers', async () => {
  const priv = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Private thing', date: '2026-09-01', visibility: 'private' } });
  const shared = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Shared thing', date: '2026-09-01', visibility: 'unit', quantity: 3, unit_label: 'reports', result: 'on time' } });
  assert.equal(priv.status, 201); assert.equal(shared.status, 201);
  assert.equal(priv.body.unit_id, 'G8');
  const asLeader = await app.call('GET', '/api/records/activities', { token: nguyen.token });
  const titles = asLeader.body.map((r: any) => r.title);
  assert.ok(titles.includes('Shared thing'));
  assert.ok(!titles.includes('Private thing'));
  assert.equal((await app.call('GET', `/api/records/activities/${priv.body.id}`, { token: nguyen.token })).status, 403);
  assert.equal((await app.call('GET', `/api/records/activities/${shared.body.id}`, { token: nguyen.token })).status, 200);
  const asOutsider = await app.call('GET', '/api/records/activities', { token: outsider.token });
  assert.equal(asOutsider.body.length, 0);
  assert.equal((await app.call('GET', `/api/records/activities/${shared.body.id}`, { token: outsider.token })).status, 403);
  // Operators do not get a magic view into private records.
  const asOp = await app.call('GET', '/api/records/activities', { token: op.token });
  assert.ok(!asOp.body.some((r: any) => r.title === 'Private thing'));
  const audit = app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_record' AND actor_id = ? AND subject_id = ?`).get(nguyen.id, rivera.id) as { n: number };
  assert.equal(audit.n, 1);
});

test('managers can correct shared content but not change scope or touch private rows', async () => {
  const shared = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Needs fix', date: '2026-09-02', visibility: 'unit' } });
  const fix = await app.call('PUT', `/api/records/activities/${shared.body.id}`, { token: nguyen.token, body: { result: 'corrected outcome', version: shared.body.version } });
  assert.equal(fix.status, 200);
  assert.equal(fix.body.result, 'corrected outcome');
  assert.equal(fix.body.version, 2);
  const scope = await app.call('PUT', `/api/records/activities/${shared.body.id}`, { token: nguyen.token, body: { visibility: 'private' } });
  assert.equal(scope.status, 403);
  assert.equal(scope.body.code, 'scope_owner_only');
  const stale = await app.call('PUT', `/api/records/activities/${shared.body.id}`, { token: rivera.token, body: { title: 'Stale edit', version: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  assert.equal(stale.body.current.version, 2);
  const priv = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Mine', visibility: 'private' } });
  assert.equal((await app.call('PUT', `/api/records/activities/${priv.body.id}`, { token: nguyen.token, body: { title: 'Hacked' } })).status, 403);
  assert.equal((await app.call('DELETE', `/api/records/activities/${priv.body.id}`, { token: nguyen.token })).status, 403);
  assert.equal((await app.call('PUT', `/api/records/activities/${shared.body.id}`, { token: outsider.token, body: { title: 'x' } })).status, 403);
});

test('members cannot share into a unit they do not belong to', async () => {
  const res = await app.call('POST', '/api/records/activities', { token: outsider.token, body: { title: 'Sneak', visibility: 'unit', unit_id: 'G8' } });
  assert.equal(res.status, 403);
  const own = await app.call('POST', '/api/records/activities', { token: outsider.token, body: { title: 'Solo', visibility: 'private' } });
  assert.equal(own.status, 201);
  assert.equal(own.body.unit_id, null);
  assert.equal((await app.call('POST', '/api/records/activities', { token: outsider.token, body: { title: 'Nowhere', visibility: 'unit' } })).status, 400);
});

test('delete is soft and restorable by the author', async () => {
  const rec = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Temporary' } });
  assert.equal((await app.call('DELETE', `/api/records/activities/${rec.body.id}`, { token: rivera.token })).status, 200);
  assert.ok(!(await app.call('GET', '/api/records/activities', { token: rivera.token })).body.some((r: any) => r.id === rec.body.id));
  assert.equal((await app.call('POST', `/api/records/activities/${rec.body.id}/restore`, { token: nguyen.token })).status, 403);
  assert.equal((await app.call('POST', `/api/records/activities/${rec.body.id}/restore`, { token: rivera.token })).status, 200);
});

test('identical activity on the same day is rejected as a duplicate', async () => {
  const a = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Processed 12 MIPRs', date: '2026-08-15', quantity: 12 } });
  assert.equal(a.status, 201);
  const b = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'processed 12  MIPRs', date: '2026-08-15', quantity: 12 } });
  assert.equal(b.status, 409);
});

test('tasks and goals: assignment requires shared unit; assignee sees the task', async () => {
  const t = await app.call('POST', '/api/records/tasks', { token: nguyen.token, body: { title: 'Close ULOs', visibility: 'unit', assignee_id: rivera.id, due_date: '2026-09-30' } });
  assert.equal(t.status, 201);
  const mine = await app.call('GET', '/api/records/tasks', { token: rivera.token });
  assert.ok(mine.body.some((r: any) => r.id === t.body.id));
  const notes = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = ?').get(rivera.id, 'assignment') as { n: number };
  assert.equal(notes.n, 1);
  const bad = await app.call('POST', '/api/records/tasks', { token: rivera.token, body: { title: 'Nope', visibility: 'unit', assignee_id: outsider.id } });
  assert.equal(bad.status, 400);
  const g = await app.call('POST', '/api/records/goals', { token: rivera.token, body: { title: 'Clear 100 ULOs', metric: 'activity_quantity', category: 'Fiscal & Financial', target_value: 100, period_end: '2026-12-31' } });
  assert.equal(g.status, 201);
  assert.equal(g.body.visibility, 'private');
});

test('projects and trainings and awards follow the same policy', async () => {
  const p = await app.call('POST', '/api/records/projects', { token: rivera.token, body: { name: 'Audit prep', visibility: 'unit' } });
  assert.equal(p.status, 201);
  const tr = await app.call('POST', '/api/records/trainings', { token: rivera.token, body: { title: 'MarineNet Cyber', hours: 2, type: 'pme' } });
  assert.equal(tr.status, 201);
  const aw = await app.call('POST', '/api/records/awards', { token: rivera.token, body: { name: 'Navy and Marine Corps Achievement Medal', status: 'recommended', type: 'personal_award' } });
  assert.equal(aw.status, 201);
  assert.ok((await app.call('GET', '/api/records/projects', { token: nguyen.token })).body.some((r: any) => r.id === p.body.id));
  await app.call('DELETE', `/api/records/projects/${p.body.id}`, { token: rivera.token });
});

test('counselings: leaders with COUNSEL record for members; members acknowledge', async () => {
  const c = await app.call('POST', '/api/records/counselings', { token: nguyen.token, body: { user_id: rivera.id, type: 'monthly', date: '2026-09-01', summary: 'Solid month. Push outcomes on every entry.', follow_up_date: '2026-10-01', visibility: 'unit' } });
  assert.equal(c.status, 201);
  assert.equal(c.body.user_id, rivera.id);
  assert.equal(c.body.counselor_id, nguyen.id);
  const mine = await app.call('GET', '/api/records/counselings', { token: rivera.token });
  assert.ok(mine.body.some((r: any) => r.id === c.body.id));
  assert.ok((await app.call('GET', '/api/records/counselings', { token: nguyen.token })).body.some((r: any) => r.id === c.body.id));
  assert.equal((await app.call('GET', '/api/records/counselings', { token: outsider.token })).body.length, 0);
  assert.equal((await app.call('POST', `/api/records/counselings/${c.body.id}/acknowledge`, { token: nguyen.token })).status, 403);
  const ack = await app.call('POST', `/api/records/counselings/${c.body.id}/acknowledge`, { token: rivera.token });
  assert.equal(ack.status, 200);
  assert.ok(ack.body.acknowledged_at);
  const denied = await app.call('POST', '/api/records/counselings', { token: rivera.token, body: { user_id: nguyen.id, summary: 'Reverse counseling' } });
  assert.equal(denied.status, 403);
  const self = await app.call('POST', '/api/records/counselings', { token: rivera.token, body: { summary: 'Notes from my own counseling' } });
  assert.equal(self.status, 201);
  assert.equal(self.body.counselor_id, null);
});

test('CSV export round-trips through import with id-based updates', async () => {
  const csv = await fetch(`${app.base}/api/reports/csv?period=all`, { headers: { authorization: `Bearer ${rivera.token}` } });
  assert.equal(csv.status, 200);
  const text = await csv.text();
  const { parseCsvText, guessMapping, applyMapping } = await import('../../shared/csv.ts');
  const parsed = parseCsvText(text);
  const { records } = applyMapping(parsed.rows, guessMapping(parsed.columns));
  assert.ok(records.length >= 3);
  const target = records.find((r) => r.title === 'Shared thing')!;
  target.result = 'updated via csv';
  const res = await app.call('POST', '/api/records/activities/import', { token: rivera.token, body: { rows: [...records, { title: 'Brand new from CSV', date: '2026-07-04' }] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.created, 1);
  assert.ok(res.body.updated >= 3);
  const after = await app.call('GET', '/api/records/activities', { token: rivera.token });
  assert.equal(after.body.find((r: any) => r.title === 'Shared thing').result, 'updated via csv');
  const dup = await app.call('POST', '/api/records/activities/import', { token: rivera.token, body: { rows: [{ title: 'Brand new from CSV', date: '2026-07-04' }] } });
  assert.equal(dup.body.duplicates, 1);
  const foreignId = await app.call('POST', '/api/records/activities/import', { token: outsider.token, body: { rows: [{ id: target.id, title: 'Steal', date: '2026-07-05' }] } });
  assert.equal(foreignId.status, 200);
  assert.equal(foreignId.body.created, 1);
  assert.equal(foreignId.body.updated, 0);
});

test('attachments validate content, enforce ownership, and download', async () => {
  const rec = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'With file', visibility: 'unit' } });
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40, 1), Buffer.from('0000000049454e44ae426082', 'hex')]);
  const up = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: rivera.token, raw: png, headers: { 'content-type': 'image/png', 'x-vantage-filename': 'proof.png' } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const badExt = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: rivera.token, raw: png, headers: { 'content-type': 'image/png', 'x-vantage-filename': 'proof.exe' } });
  assert.equal(badExt.status, 400);
  const fake = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: rivera.token, raw: Buffer.from('not a pdf'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'x.pdf' } });
  assert.equal(fake.status, 400);
  const dupe = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: rivera.token, raw: png, headers: { 'content-type': 'image/png', 'x-vantage-filename': 'again.png' } });
  assert.equal(dupe.status, 409);
  const list = await app.call('GET', `/api/records/activities/${rec.body.id}/attachments`, { token: nguyen.token });
  assert.equal(list.body.attachments.length, 1);
  const dl = await fetch(`${app.base}/api/records/activities/${rec.body.id}/attachments/${up.body.id}`, { headers: { authorization: `Bearer ${nguyen.token}` } });
  assert.equal(dl.status, 200);
  assert.ok(dl.headers.get('content-disposition')!.startsWith('attachment'));
  assert.equal((await dl.arrayBuffer()).byteLength, png.length);
  assert.equal((await app.call('GET', `/api/records/activities/${rec.body.id}/attachments`, { token: outsider.token })).status, 403);
  assert.equal((await app.call('DELETE', `/api/records/activities/${rec.body.id}/attachments/${up.body.id}`, { token: outsider.token })).status, 403);
  assert.equal((await app.call('DELETE', `/api/records/activities/${rec.body.id}/attachments/${up.body.id}`, { token: rivera.token })).status, 200);
});

test('readiness is self-editable and leader-readable within detail units', async () => {
  const save = await app.call('PUT', '/api/me/readiness', { token: rivera.token, body: { pft_score: 265, cft_score: '280', rifle_qual: 'Expert', mcmap_belt: 'Grey', pme_complete: 'distance' } });
  assert.equal(save.status, 200);
  assert.equal(save.body.pft_score, 265);
  assert.equal(save.body.cft_score, 280);
  assert.equal((await app.call('PUT', '/api/me/readiness', { token: rivera.token, body: { pft_score: 400 } })).status, 400);
  const asLeader = await app.call('GET', `/api/me/readiness/${rivera.id}`, { token: nguyen.token });
  assert.equal(asLeader.status, 200);
  assert.equal(asLeader.body.rifle_qual, 'Expert');
  assert.equal((await app.call('GET', `/api/me/readiness/${rivera.id}`, { token: outsider.token })).status, 403);
  assert.equal((await app.call('GET', `/api/me/readiness/${nguyen.id}`, { token: rivera.token })).status, 403);
});

test('reports, PDF, delta, and leader-built reports honor detail authority', async () => {
  const mine = await app.call('GET', '/api/reports?period=all', { token: rivera.token });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.narrative.text.length > 20);
  assert.equal(mine.body.track, 'jepes');
  const leaderView = await app.call('GET', `/api/reports?period=all&user_id=${rivera.id}`, { token: nguyen.token });
  assert.equal(leaderView.status, 200);
  assert.ok(leaderView.body.activities.every((a: any) => a.visibility === 'unit'));
  assert.equal((await app.call('GET', `/api/reports?period=all&user_id=${rivera.id}`, { token: outsider.token })).status, 403);
  const pdf = await fetch(`${app.base}/api/reports/pdf?period=all`, { headers: { authorization: `Bearer ${rivera.token}` } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.ok(bytes.subarray(0, 5).toString() === '%PDF-');
  assert.ok(bytes.length > 1500);
  const delta = await app.call('GET', '/api/reports/delta?period=month', { token: rivera.token });
  assert.equal(delta.status, 200);
  assert.ok('headline' in delta.body);
  const fitrep = await app.call('GET', '/api/reports?period=all', { token: nguyen.token });
  assert.equal(fitrep.body.track, 'fitrep');
});

test('search returns only what the caller may see', async () => {
  const res = await app.call('GET', '/api/search?q=shared', { token: nguyen.token });
  assert.equal(res.status, 200);
  assert.ok(!res.body.results.some((r: any) => r.title === 'Private thing'));
  const people = await app.call('GET', '/api/search?q=rivera', { token: nguyen.token });
  assert.ok(people.body.results.some((r: any) => r.type === 'person'));
  assert.equal((await app.call('GET', '/api/search?q=rivera', { token: outsider.token })).body.results.length, 0);
});

test('preferences validate and persist; profile email change needs sudo', async () => {
  const bad = await app.call('PUT', '/api/me/prefs', { token: rivera.token, body: { theme: 'purple' } });
  assert.equal(bad.status, 400);
  const ok = await app.call('PUT', '/api/me/prefs', { token: rivera.token, body: { theme: 'dark', accent: 'ocean', digest: { enabled: true, weekday: 1, hour: 6 } } });
  assert.equal(ok.status, 200);
  assert.equal((await app.call('GET', '/api/me', { token: rivera.token })).body.prefs.accent, 'ocean');
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
  const email = await app.call('PUT', '/api/me/profile', { token: rivera.token, body: { email: 'rivera@example.mil' } });
  assert.equal(email.status, 403);
  await app.call('POST', '/api/auth/sudo', { token: rivera.token, body: { password: PASSWORD } });
  assert.equal((await app.call('PUT', '/api/me/profile', { token: rivera.token, body: { email: 'rivera@example.mil', mos: '3451' } })).status, 200);
  await app.call('POST', '/api/auth/sudo', { token: nguyen.token, body: { password: PASSWORD } });
  assert.equal((await app.call('PUT', '/api/me/profile', { token: nguyen.token, body: { email: 'rivera@example.mil' } })).status, 400);
});

test('the recycle bin purges records deleted more than 30 days ago and keeps the rest', async () => {
  const { purgeDeleted } = await import('../../server/services/records.ts');
  const old = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Old deleted thing', date: '2026-01-05' } });
  const fresh = await app.call('POST', '/api/records/activities', { token: rivera.token, body: { title: 'Recently deleted thing', date: '2026-01-06' } });
  await app.call('DELETE', `/api/records/activities/${old.body.id}`, { token: rivera.token });
  await app.call('DELETE', `/api/records/activities/${fresh.body.id}`, { token: rivera.token });
  app.ctx.db.prepare('UPDATE activities SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), old.body.id);
  const result = purgeDeleted(app.ctx);
  assert.equal(result.records, 1);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE id = ?').get(old.body.id) as { n: number }).n, 0);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE id = ?').get(fresh.body.id) as { n: number }).n, 1);
  assert.equal((await app.call('POST', `/api/records/activities/${fresh.body.id}/restore`, { token: rivera.token })).status, 200);
});
