import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('peer');
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('peer')).body.token };
});
after(async () => { await app.close(); });

async function activity(token: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await app.call('POST', '/api/records/activities', {
    token, body: { title, visibility: 'unit', date: day(-5), quantity: 10, unit_label: 'ULOs', ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function draft(token: string, overrides: Record<string, unknown> = {}) {
  const res = await app.call('POST', '/api/studio/reports', {
    token, body: { title: 'Quarterly input', period_start: day(-30), period_end: day(1), ...overrides },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const section = (body: string) => [{ heading: 'Mission', body, source_ids: [] }];

test('a revision records which version of each source the wording was built from', async () => {
  const record = await activity(op.token, 'Reconciled thirty obligations');
  const report = await draft(op.token);
  const saved = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token,
    body: { sections: section('Reconciled thirty obligations across two systems.'), sources: [{ table: 'activities', id: record.id, version: record.version }] },
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.revision.revision, 1);
  assert.equal(saved.body.revision.source_snapshots.length, 1);
  assert.equal(saved.body.revision.source_snapshots[0].version, record.version);
  assert.equal(saved.body.revision.source_snapshots[0].title, 'Reconciled thirty obligations');
});

test('a source that changed after the wording was written blocks the save, and says which one', async () => {
  const record = await activity(op.token, 'Cleared a funding document');
  const report = await draft(op.token);
  const stale = record.version;

  // The record moves while the author is still typing.
  const edited = await app.call('PUT', `/api/records/activities/${record.id}`, { token: op.token, body: { quantity: 99, version: record.version } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const refused = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token,
    body: { sections: section('Cleared a funding document worth ten.'), sources: [{ table: 'activities', id: record.id, version: stale }] },
  });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'stale_sources');
  assert.equal(refused.body.stale.length, 1);
  assert.equal(refused.body.stale[0].id, record.id);
  assert.equal(refused.body.stale[0].expected_version, stale);
  assert.equal(refused.body.stale[0].actual_version, edited.body.version);

  // Nothing was written.
  const after = await app.call('GET', `/api/studio/reports/${report.id}`, { token: op.token });
  assert.equal(after.body.draft.latest_revision, 0);

  // Once the author has looked at the new facts, the same save goes through.
  const accepted = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token,
    body: { sections: section('Cleared a funding document worth ninety-nine.'), sources: [{ table: 'activities', id: record.id, version: edited.body.version }] },
  });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
});

test('a deleted source blocks the save rather than quietly dropping the citation', async () => {
  const record = await activity(op.token, 'A record that will not survive');
  const report = await draft(op.token);
  await app.call('DELETE', `/api/records/activities/${record.id}`, { token: op.token });
  const refused = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token, body: { sections: section('Cites something that no longer exists.'), sources: [{ table: 'activities', id: record.id, version: record.version }] },
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.stale[0].reason, /deleted/i);
});

test('an export renders the saved revision, not the records as they are now', async () => {
  const record = await activity(op.token, 'Validated twelve reimbursables', { quantity: 12, unit_label: 'reimbursables' });
  const report = await draft(op.token);
  const saved = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token,
    body: { sections: section('Validated twelve reimbursable orders.'), sources: [{ table: 'activities', id: record.id, version: record.version }] },
  });
  assert.equal(saved.status, 201);

  // The source is edited after the package was reviewed.
  await app.call('PUT', `/api/records/activities/${record.id}`, { token: op.token, body: { title: 'Retitled after the fact', quantity: 999, version: record.version } });

  const exported = await app.call('GET', `/api/studio/reports/${report.id}/revisions/1/export.txt`, { token: op.token });
  assert.equal(exported.status, 200);
  assert.match(exported.text, /Validated twelve reimbursable orders\./);
  assert.match(exported.text, /Validated twelve reimbursables/, 'the snapshot title is what the export cites');
  assert.ok(!exported.text.includes('Retitled after the fact'), 'a later edit does not rewrite a package already handed over');
  assert.ok(!exported.text.includes('999'));
});

test('a report says which of its sources have drifted since the revision was saved', async () => {
  const record = await activity(op.token, 'Something that will be edited later');
  const report = await draft(op.token);
  await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token, body: { sections: section('A claim about it.'), sources: [{ table: 'activities', id: record.id, version: record.version }] },
  });

  const clean = await app.call('GET', `/api/studio/reports/${report.id}`, { token: op.token });
  assert.deepEqual(clean.body.drift, [], 'nothing has moved yet');

  await app.call('PUT', `/api/records/activities/${record.id}`, { token: op.token, body: { result: 'changed', version: record.version } });
  const drifted = await app.call('GET', `/api/studio/reports/${report.id}`, { token: op.token });
  assert.equal(drifted.body.drift.length, 1);
  assert.match(drifted.body.drift[0].reason, /edited since/i);
  assert.equal(drifted.body.draft.latest_revision, 1, 'the revision itself did not change');
});

test('two saves from the same starting revision do not overwrite each other', async () => {
  const record = await activity(op.token, 'A record two people cite');
  const report = await draft(op.token);
  const sources = [{ table: 'activities', id: record.id, version: record.version }];
  const first = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, { token: op.token, body: { sections: section('First wording.'), sources, base_revision: 0 } });
  assert.equal(first.status, 201);
  const second = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, { token: op.token, body: { sections: section('Second wording, written from the old view.'), sources, base_revision: 0 } });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /now at revision 1/i);
});

test('a report cannot cite a record its author cannot read, or one belonging to someone else', async () => {
  const theirs = await app.call('POST', '/api/records/activities', {
    token: peer.token, body: { title: 'A private record of theirs', visibility: 'private', date: day(-3), quantity: 5, unit_label: 'files' },
  });
  assert.equal(theirs.status, 201);
  const report = await draft(op.token);
  const refused = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: op.token, body: { sections: section('Claims someone else’s private work.'), sources: [{ table: 'activities', id: theirs.body.id, version: theirs.body.version }] },
  });
  assert.equal(refused.status, 403);
});

test('only the author saves revisions; the subject can read the report but not rewrite it', async () => {
  const record = await activity(peer.token, 'Work the subject did');
  const report = await draft(op.token, { subject_id: peer.id, unit_id: 'G8', visibility: 'unit' });
  const readable = await app.call('GET', `/api/studio/reports/${report.id}`, { token: peer.token });
  assert.equal(readable.status, 200, JSON.stringify(readable.body));
  const refused = await app.call('POST', `/api/studio/reports/${report.id}/revisions`, {
    token: peer.token, body: { sections: section('Written by the subject.'), sources: [{ table: 'activities', id: record.id, version: record.version }] },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /person writing this report/i);
});

test('a leader cannot open a report for a Marine outside their reach', async () => {
  const stranger = await app.register('stranger');
  const refused = await app.call('POST', '/api/studio/reports', {
    token: stranger.token, body: { title: 'Someone else’s report', period_start: day(-30), period_end: day(1), subject_id: op.id },
  });
  assert.equal(refused.status, 403);
});

test('every revision stays readable, so the history is a history', async () => {
  const record = await activity(op.token, 'A record cited across revisions');
  const report = await draft(op.token);
  const sources = [{ table: 'activities', id: record.id, version: record.version }];
  await app.call('POST', `/api/studio/reports/${report.id}/revisions`, { token: op.token, body: { sections: section('First pass.'), sources } });
  await app.call('POST', `/api/studio/reports/${report.id}/revisions`, { token: op.token, body: { sections: section('Second pass, tighter.'), sources } });

  const first = await app.call('GET', `/api/studio/reports/${report.id}/revisions/1`, { token: op.token });
  const second = await app.call('GET', `/api/studio/reports/${report.id}/revisions/2`, { token: op.token });
  assert.equal(first.body.revision.sections[0].body, 'First pass.');
  assert.equal(second.body.revision.sections[0].body, 'Second pass, tighter.');
  const list = await app.call('GET', `/api/studio/reports/${report.id}`, { token: op.token });
  assert.equal(list.body.revisions.length, 2);
  assert.equal(list.body.revisions[0].revision, 2, 'newest first');
});

test('the evaluation track follows the rank of the Marine the report is about', async () => {
  const cpl = await app.register('cpl-track', { rank_id: 'Cpl' });
  const sgt = await app.register('sgt-track', { rank_id: 'Sgt' });
  const gunner = await app.register('cwo-track', { rank_id: 'CWO3' });
  for (const person of [cpl, sgt, gunner]) await enroll(app, op.token, 'G8', person.id);

  for (const [person, expected] of [[cpl, 'jepes'], [sgt, 'fitrep'], [gunner, 'fitrep']] as const) {
    const token = (await app.login(person === cpl ? 'cpl-track' : person === sgt ? 'sgt-track' : 'cwo-track')).body.token;
    const own = await draft(token);
    assert.equal(own.track, expected, `${expected} expected for their own draft`);

    const forThem = await draft(op.token, { subject_id: person.id, unit_id: 'G8' });
    assert.equal(forThem.track, expected, `${expected} expected when a leader writes it`);
  }
});

test('an explicit track still overrides what the rank would have chosen', async () => {
  const sgt = await app.register('sgt-override', { rank_id: 'Sgt' });
  await enroll(app, op.token, 'G8', sgt.id);
  const token = (await app.login('sgt-override')).body.token;
  assert.equal((await draft(token, { track: 'jepes' })).track, 'jepes');
});

test('a package’s period follows the one range rule, and the refusal names the field it was sent in', async () => {
  const addDays = (from: string, n: number) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const start = (period_start: unknown, period_end: unknown) => app.call('POST', '/api/studio/reports', { token: op.token, body: { title: 'Range check', period_start, period_end } });
  for (const [what, from, to, field] of [
    ['732 days', '2024-01-01', addDays('2024-01-01', 731), 'period_end'],
    ['a backwards period', '2024-06-30', '2024-06-01', 'period_end'],
    ['a day that does not exist', '2024-02-30', '2024-03-10', 'period_start'],
    ['a word for a day', '2024-03-01', 'soon', 'period_end'],
    ['a year out of reach', '1939-12-31', '1940-01-10', 'period_start'],
    ['no first day', '', '2024-03-10', 'period_start'],
    ['no last day', '2024-03-01', undefined, 'period_end'],
  ] as const) {
    const res = await start(from, to);
    assert.equal(res.status, 400, `${what}: ${res.text.slice(0, 200)}`);
    assert.equal(res.body.code, 'validation', what);
    assert.ok(res.body.fieldErrors?.[field], `${what}: ${field} is named in ${JSON.stringify(res.body)}`);
  }
  const longest = await start('2024-01-01', addDays('2024-01-01', 730));
  assert.equal(longest.status, 201, `731 days, both ends counted: ${longest.text}`);
  assert.equal(longest.body.period_end, addDays('2024-01-01', 730), 'the days are kept exactly as sent');

  // A revision that names a period meets the same rule; one that does not keeps the package's own.
  const revise = (period: Record<string, string>) => app.call('POST', `/api/studio/reports/${longest.body.id}/revisions`, { token: op.token, body: { sections: section('Within the rule.'), sources: [], ...period } });
  const tooLong = await revise({ period_end: addDays('2024-01-01', 731) });
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.body.fieldErrors?.period_end, JSON.stringify(tooLong.body));
  assert.equal((await revise({ period_start: '2024-02-01' })).status, 201, 'a shorter period is a revision');
});

test('a package stored before the two-year rule still opens and saves', async () => {
  const older = await draft(op.token, { title: 'Older long package', period_start: '2023-01-01', period_end: '2023-12-31' });
  // A package created before the rule may cover more than two years.
  app.ctx.db.prepare('UPDATE report_drafts SET period_start = ?, period_end = ? WHERE id = ?').run('2020-01-01', '2024-12-31', older.id);
  assert.equal((await app.call('GET', `/api/studio/reports/${older.id}`, { token: op.token })).status, 200);
  const saved = await app.call('POST', `/api/studio/reports/${older.id}/revisions`, { token: op.token, body: { sections: section('Saved as it was.'), sources: [] } });
  assert.equal(saved.status, 201, saved.text);
  const read = await app.call('GET', `/api/studio/reports/${older.id}/revisions/1`, { token: op.token });
  assert.equal(read.body.revision.period_start, '2020-01-01');
  assert.equal(read.body.revision.period_end, '2024-12-31');
});
