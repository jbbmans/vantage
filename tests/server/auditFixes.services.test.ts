import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { parseEml } from '../../server/lib/eml.ts';
import { composeDigest } from '../../server/services/digest.ts';
import { parseRoster, planSync, applySync } from '../../server/services/personnel.ts';
import { audit } from '../../server/services/audit.ts';
import { buildPersonalExportZip } from '../../server/services/personalExport.ts';
import { unitOverview } from '../../server/services/dashboard.ts';
import { readZip } from '../../server/lib/zip.ts';
import { parseCsvText, guessMapping, applyMapping } from '../../shared/csv.ts';
import { parseMoney } from '../../shared/money.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let bravo: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  bravo = await app.register('bravo');
  await enroll(app, op.token, 'G8', bravo.id);
  bravo = { ...bravo, token: (await app.login('bravo')).body.token };
});
after(() => app.close());

const eml = (headers: string[], body = 'body') => Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8');

test('B1: adjacent encoded-words join without the folding space, even when a character is split across them', () => {
  const folded = parseEml(eml(['From: a@b.mil', 'Subject: =?UTF-8?Q?Re=3A_R=C3=A9conciliation_d?=\r\n =?UTF-8?Q?u_compte?=']));
  assert.equal(folded.subject, 'Re: Réconciliation du compte');
  assert.equal(parseEml(eml(['From: a@b.mil', 'Subject: =?utf-8?B?SGVsbG8=?= =?utf-8?B?V29ybGQ=?='])).subject, 'HelloWorld');
  const bytes = Buffer.from('Réconciliation', 'utf8');
  const split = `=?UTF-8?B?${bytes.subarray(0, 2).toString('base64')}?= =?UTF-8?B?${bytes.subarray(2).toString('base64')}?=`;
  assert.equal(parseEml(eml(['From: a@b.mil', `Subject: ${split}`])).subject, 'Réconciliation');
  // Plain words between encoded-words keep their spaces.
  assert.equal(parseEml(eml(['From: a@b.mil', 'Subject: =?UTF-8?Q?caf=C3=A9?= and =?UTF-8?Q?th=C3=A9?='])).subject, 'café and thé');
});

test('B2: raw 8-bit UTF-8 header values decode as UTF-8, and latin1 bytes still read as latin1', () => {
  const parsed = parseEml(eml(['From: "Rémi Dupont" <rd@b.mil>', 'Subject: Réconciliation — FY27']));
  assert.equal(parsed.subject, 'Réconciliation — FY27');
  assert.deepEqual(parsed.from, { name: 'Rémi Dupont', email: 'rd@b.mil' });
  const latin1 = parseEml(Buffer.from('From: a@b.mil\r\nSubject: caf\xe9\r\n\r\nbody\r\n', 'latin1'));
  assert.equal(latin1.subject, 'café');
});

test('B3: an `addr (Comment Name)` sender is the address, named by the comment', () => {
  assert.deepEqual(parseEml(eml(['From: rd@b.mil (Remi Dupont)', 'Subject: x'])).from, { name: 'Remi Dupont', email: 'rd@b.mil' });
  const to = parseEml(eml(['From: a@b.mil', 'To: rd@b.mil (DUPONT, REMI), ap@vendor.com', 'Subject: x'])).to;
  assert.deepEqual(to, [{ name: 'DUPONT, REMI', email: 'rd@b.mil' }, { name: null, email: 'ap@vendor.com' }]);
});

test('B22: the same .eml imported twice is one thread, and a reply joins the thread it answers', async () => {
  const send = (raw: Buffer) => app.call('POST', '/api/correspondence/messages/import', { token: op.token, raw, headers: { 'content-type': 'message/rfc822', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
  const original = eml(['From: "Vendor" <ap@vendor.com>', 'To: boletz@example.mil', 'Subject: Invoice 4471', 'Message-ID: <inv4471@vendor.com>', 'Date: Fri, 2 Oct 2026 10:00:00 -0400'], 'Please see attached.');
  const first = await send(original);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.created, true);
  const again = await send(original);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.created, false);
  assert.equal(again.body.thread.id, first.body.thread.id);

  const reply = eml(['From: "Vendor" <ap@vendor.com>', 'To: boletz@example.mil', 'Subject: Re: Invoice 4471', 'Message-ID: <inv4471-2@vendor.com>',
    'In-Reply-To: <inv4471@vendor.com>', 'References: <inv4471@vendor.com>', 'Date: Sat, 3 Oct 2026 10:00:00 -0400'], 'Paid.');
  const joined = await send(reply);
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  assert.equal(joined.body.created, false);
  assert.equal(joined.body.thread.id, first.body.thread.id);
  const count = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM threads WHERE subject LIKE '%Invoice 4471%' AND deleted_at IS NULL").get() as { n: number };
  assert.equal(count.n, 1);

  // Someone who cannot see that thread gets their own copy rather than a view into it.
  const outsider = await app.register('outsider');
  const theirs = await app.call('POST', '/api/correspondence/messages/import', { token: outsider.token, raw: original, headers: { 'content-type': 'message/rfc822', 'x-visibility': 'private' } });
  assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
  assert.notEqual(theirs.body.thread.id, first.body.thread.id);
});

test('B9: the weekly digest counts every overdue task, not just the five it lists', async () => {
  for (let i = 0; i < 9; i += 1) {
    const r = await app.call('POST', '/api/records/tasks', { token: op.token, body: { title: `Overdue task ${i}`, due_date: `2026-01-0${i + 1}`, status: 'active' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const user = app.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(op.id) as Parameters<typeof composeDigest>[1];
  const digest = composeDigest(app.ctx, user);
  assert.equal(digest.stats.overdue, 9);
  assert.match(digest.subject, /, 9 overdue$/);
  assert.equal(digest.text.match(/Overdue: Overdue task/g)?.length, 5, 'only five are listed');
});

const UMT = 'Document Number,Condition,UMT Amount,Due Date\r\nN0001,UMT open,1118.38,2026-10-15\r\nN0002,UMT open,50.00,2026-10-20\r\n';
const umtPlan = (id: string, unit: string | null, visibility: string) => ({
  source_file_id: id, sheet_name: '', header_row: 1, key_columns: ['Document Number'],
  mapping: { 'Document Number': 'reference', Condition: 'title', 'UMT Amount': 'amount', 'Due Date': 'due_date' }, unit_id: unit, visibility,
});
const uploadUmt = async (token: string, unit: string | null, visibility: string) => {
  const r = await app.call('POST', '/api/work/sources', { token, raw: Buffer.from(UMT), headers: { 'content-type': 'text/csv', 'x-filename': 'umt.csv', ...(unit ? { 'x-unit-id': unit } : {}), 'x-visibility': visibility } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id as string;
};

test('B11: a private import never lands in a unit, so preview and commit agree; a key clash is a 409, not a 500', async () => {
  const mine = await app.call('POST', '/api/work/imports', { token: op.token, body: umtPlan(await uploadUmt(op.token, 'G8', 'private'), 'G8', 'private') });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal(mine.body.unit_id, null);
  const source = await uploadUmt(bravo.token, 'G8', 'private');
  const preview = await app.call('POST', '/api/work/imports/preview', { token: bravo.token, body: umtPlan(source, 'G8', 'private') });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.will_insert.length, 2);
  const theirs = await app.call('POST', '/api/work/imports', { token: bravo.token, body: umtPlan(source, 'G8', 'private') });
  assert.equal(theirs.status, 201, JSON.stringify(theirs.body));
  assert.equal(theirs.body.inserted_rows, 2);
  const placed = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM work_items WHERE owner_id = ? AND visibility = 'private' AND unit_id IS NULL").get(bravo.id) as { n: number };
  assert.equal(placed.n, 2);

  // A private row left in the unit by an older build still holds its keys there; a shared import that meets it is told so.
  app.ctx.db.prepare("UPDATE work_items SET unit_id = 'G8' WHERE owner_id = ? AND visibility = 'private'").run(bravo.id);
  const shared = await app.call('POST', '/api/work/imports', { token: op.token, body: umtPlan(await uploadUmt(op.token, 'G8', 'unit'), 'G8', 'unit') });
  assert.equal(shared.status, 409, JSON.stringify(shared.body));
  assert.equal(shared.body.code, 'import_key_conflict');
  assert.equal(shared.body.keys.length, 2);
  const job = app.ctx.db.prepare("SELECT status FROM import_jobs WHERE user_id = ? AND visibility = 'unit' ORDER BY created_at DESC LIMIT 1").get(op.id) as { status: string };
  assert.equal(job.status, 'failed');
});

test('B11b: a different report keyed by the same document number does not overwrite the case; a re-export of the same report still updates it', async () => {
  const upload = async (csv: string, name: string) => {
    const r = await app.call('POST', '/api/work/sources', { token: op.token, raw: Buffer.from(csv), headers: { 'content-type': 'text/csv', 'x-filename': name, 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const plan = (id: string, mapping: Record<string, string>) => ({ source_file_id: id, sheet_name: '', header_row: 1, key_columns: ['Document Number'], mapping, unit_id: 'G8', visibility: 'unit' });
  const umt = { 'Document Number': 'reference', Condition: 'title', 'UMT Amount': 'amount', 'Due Date': 'due_date' };
  const first = await app.call('POST', '/api/work/imports', { token: op.token, body: plan(await upload('Document Number,Condition,UMT Amount,Due Date\r\nX0001,UMT open,1118.38,2026-10-15\r\nX0002,UMT open,50.00,2026-10-20\r\n', 'umt.csv'), umt) });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const amountOf = (key: string) => (app.ctx.db.prepare("SELECT amount, title FROM work_items WHERE unit_id = 'G8' AND natural_key = ? AND deleted_at IS NULL").get(key) as { amount: number; title: string });

  // An open-obligations report that also keys by document number, with its own columns.
  const ulo = await upload('Document Number,Vendor,Obligated,Expended,Fund Code,Line\r\nX0001,ACME Corp,9000.00,0.00,DH,1\r\n', 'ulo.csv');
  const uloPlan = plan(ulo, { 'Document Number': 'reference', Vendor: 'title', Obligated: 'amount', Expended: 'keep', 'Fund Code': 'keep', Line: 'keep' });
  const preview = await app.call('POST', '/api/work/imports/preview', { token: op.token, body: uloPlan });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.will_update.length, 0);
  assert.equal(preview.body.rejections.length, 1);
  assert.match(preview.body.rejections[0].reason, /different report/);
  const committed = await app.call('POST', '/api/work/imports', { token: op.token, body: uloPlan });
  assert.equal(committed.status, 201, JSON.stringify(committed.body));
  assert.equal(committed.body.updated_rows, 0);
  assert.deepEqual(amountOf('X0001'), { amount: 1118.38, title: 'UMT open' }, 'the UMT case is untouched');

  // The UMT report again, re-exported with a column added: the same report, so its change lands.
  const again = await upload('Document Number,Condition,UMT Amount,Due Date,Remarks\r\nX0001,UMT open,1000.00,2026-10-15,partial\r\nX0002,UMT open,50.00,2026-10-20,\r\n', 'umt2.csv');
  const updated = await app.call('POST', '/api/work/imports', { token: op.token, body: plan(again, { ...umt, Remarks: 'keep' }) });
  assert.equal(updated.status, 201, JSON.stringify(updated.body));
  assert.equal(amountOf('X0001').amount, 1000);
});

test('B12: the case action form reads typed figures like Quick Log and refuses text that is not a number', () => {
  const page = readFileSync('src/pages/WorkItemPage.tsx', 'utf8');
  const form = page.slice(page.indexOf('function ActionForm'), page.indexOf('const FREE_KINDS'));
  assert.ok(form.length > 0);
  assert.doesNotMatch(form, /Number\(amount\)|Number\(quantity\)/, 'Number("1,118.38") is NaN, which JSON sends as null');
  assert.match(form, /parseMoney\(amount\)/);
  assert.match(form, /error=\{amountError\}/);
  assert.match(form, /error=\{countError\}/);
  const money = parseMoney('$1,118.38');
  assert.ok(money.ok && money.cents === 111838);
  assert.equal(parseMoney('about 1k').ok, false);
});

const newItem = async (body: Record<string, unknown> = {}) => app.call('POST', '/api/work/items', { token: op.token, body: { title: 'Clear ULO', unit_id: 'G8', visibility: 'unit', ...body } });

test('B13: a drafted record entry from a case action is held to the activity rules', async () => {
  const item = await newItem();
  assert.equal(item.status, 201);
  const act = (body: Record<string, unknown>) => app.call('POST', `/api/work/items/${item.body.id}/actions`, { token: op.token, body: { kind: 'reconciled', draft_record: true, ...body } });
  const before = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n;
  const actionsBefore = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_actions').get() as { n: number }).n;

  const negative = await act({ dollar_amount: -5000, dollar_type: 'reconciled', occurred_at: today() });
  assert.equal(negative.status, 400, JSON.stringify(negative.body));
  assert.match(negative.body.error, /dollar_amount/);
  assert.equal((await act({ quantity: -3, occurred_at: today() })).status, 400);
  const impossible = await act({ occurred_at: '2026-02-31' });
  assert.equal(impossible.status, 400);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, before, 'nothing reached the record');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_actions').get() as { n: number }).n, actionsBefore, 'and no half-recorded action');

  const ok = await act({ dollar_amount: 1118.38, dollar_type: 'reconciled', quantity: 3, occurred_at: '2026-09-30', eval_area: 'Not an area' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const row = app.ctx.db.prepare('SELECT date, dollar_amount, quantity, eval_area FROM activities WHERE id = ?').get(ok.body.activity_id);
  assert.deepEqual({ ...(row as object) }, { date: '2026-09-30', dollar_amount: 1118.38, quantity: 3, eval_area: 'Unassigned' });
});

test('B14: a work item due date must be a real YYYY-MM-DD date', async () => {
  assert.equal((await newItem({ due_date: '10/15/2026' })).status, 400);
  assert.equal((await newItem({ due_date: '2026-02-31' })).status, 400);
  const item = await newItem({ due_date: '2026-10-15' });
  assert.equal(item.status, 201);
  assert.equal(item.body.due_date, '2026-10-15');
  assert.equal((await app.call('PATCH', `/api/work/items/${item.body.id}`, { token: op.token, body: { due_date: '10/15/2026' } })).status, 400);
  const cleared = await app.call('PATCH', `/api/work/items/${item.body.id}`, { token: op.token, body: { due_date: '' } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.due_date, null);
});

test('B15: separation by the roster is undone when the next extract lists the Marine as active', async () => {
  const edipi = (i: number) => String(2000000000 + i);
  const people: Record<string, string> = {};
  for (const [i, name] of [[1, 'alphaR'], [2, 'bravoR'], [3, 'charlieR']] as const) {
    people[name] = (await app.register(name.toLowerCase())).id;
    app.ctx.db.prepare('UPDATE users SET edipi = ? WHERE id = ?').run(edipi(i), people[name]);
  }
  const roster = (statuses: Record<number, string | null>) => ['EDIPI,Last,First,Rank,Status',
    ...Array.from({ length: 15 }, (_, k) => k + 1).filter((i) => statuses[i] !== null).map((i) => `${edipi(i)},M${i},Joe,Sgt,${statuses[i] ?? 'Active'}`)].join('\n');
  const sync = (text: string) => { const p = parseRoster(text); const plan = planSync(app.ctx, 'G8', p.rows, 'MCTFS', p.rejected); applySync(app.ctx, plan, null); return plan; };
  const active = (name: string) => (app.ctx.db.prepare('SELECT active FROM users WHERE id = ?').get(people[name]) as { active: number }).active;

  sync(roster({}));
  // Four of fifteen leaving trips the mass-separation guard, explicit statuses included, and changes nothing.
  const held = planSync(app.ctx, 'G8', parseRoster(roster({ 1: 'Separated', 2: null, 3: null, 4: 'Discharged' })).rows, 'MCTFS');
  assert.equal(held.massSeparation?.count, 4);
  assert.equal(held.separations.length, 0);
  assert.ok(!held.updates.some((u) => u.changes.some((c) => c.field === 'status')), 'a held-back separation stays active on the roster');

  // Alpha is marked separated; Bravo and Charlie are missing (three of fifteen, at the guard but not past it).
  const v2 = sync(roster({ 1: 'Separated', 2: null, 3: null }));
  assert.deepEqual(v2.separations.map((s) => s.edipi).sort(), [edipi(1), edipi(2), edipi(3)]);
  assert.equal(active('alphaR'), 0, 'an explicit Separated status deactivates the account');
  assert.equal(active('bravoR'), 0);
  assert.equal(active('charlieR'), 0);
  // An operator then deactivates Charlie in their own right.
  audit(app.ctx, { actor_id: op.id, action: 'deactivate_member', entity: 'user', entity_id: people.charlieR, subject_id: people.charlieR });

  const v3 = sync(roster({}));
  assert.equal(v3.updates.length, 3, 'a returning Marine is a change, not "unchanged"');
  const statuses = app.ctx.db.prepare('SELECT status FROM personnel_roster WHERE edipi IN (?, ?, ?)').all(edipi(1), edipi(2), edipi(3)) as Array<{ status: string }>;
  assert.deepEqual(statuses.map((s) => s.status), ['active', 'active', 'active']);
  assert.equal(active('alphaR'), 1);
  assert.equal(active('bravoR'), 1);
  assert.equal(active('charlieR'), 0, 'an operator’s deactivation is not the roster’s to undo');
  const reactivated = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'personnel_reactivated'").get() as { n: number };
  assert.equal(reactivated.n, 2);
});

test('B15b: a first sighting already marked Separated turns off the account it matches, within the guard', async () => {
  const edipi = (i: number) => String(3000000000 + i);
  const ids: string[] = [];
  // A command new to roster sync: nobody on it yet, six accounts that carry an EDIPI.
  app.ctx.db.prepare('DELETE FROM personnel_roster').run();
  for (let i = 1; i <= 6; i += 1) {
    const id = (await app.register(`first${i}`)).id;
    app.ctx.db.prepare('UPDATE users SET edipi = ? WHERE id = ?').run(edipi(i), id);
    ids.push(id);
  }
  const active = (i: number) => (app.ctx.db.prepare('SELECT active FROM users WHERE id = ?').get(ids[i - 1]) as { active: number }).active;
  const roster = (statuses: Record<number, string>, count: number) => ['EDIPI,Last,First,Rank,Status',
    ...Array.from({ length: count }, (_, k) => k + 1).map((i) => `${edipi(i)},F${i},Joe,Sgt,${statuses[i] ?? 'Active'}`)].join('\n');
  // Every account this extract first lists, marked separated: the guard holds it, and nothing is written.
  const held = planSync(app.ctx, 'G8', parseRoster(roster({ 1: 'Separated', 2: 'Separated', 3: 'Separated' }, 6)).rows, 'MCTFS');
  assert.equal(held.massSeparation?.count, 3);
  assert.equal(held.massSeparation?.activeBefore, 6);
  applySync(app.ctx, held, null);
  assert.equal(active(1), 1);
  assert.ok(!app.ctx.db.prepare('SELECT 1 FROM personnel_roster WHERE edipi = ?').get(edipi(1)), 'a held-back first sighting is not written, so the next extract raises it again');

  // One of six: written as separated, and the account turned off.
  const plan = planSync(app.ctx, 'G8', parseRoster(roster({ 1: 'Separated' }, 6)).rows, 'MCTFS');
  assert.equal(plan.massSeparation, undefined);
  assert.deepEqual(plan.separations.map((s) => [s.edipi, s.listed]), [[edipi(1), true]]);
  applySync(app.ctx, plan, null);
  assert.equal(active(1), 0, 'a first sighting marked Separated deactivates the matching account');
  assert.equal(active(2), 1);
  assert.equal((app.ctx.db.prepare('SELECT status FROM personnel_roster WHERE edipi = ?').get(edipi(1)) as { status: string }).status, 'separated');

  // Listed active the next time, the roster's deactivation is undone.
  applySync(app.ctx, planSync(app.ctx, 'G8', parseRoster(roster({}, 6)).rows, 'MCTFS'), null);
  assert.equal(active(1), 1);
});

test('B19: the personal activities.csv can be imported back', async () => {
  const made = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Reconciled 30 ULOs', date: '2026-08-20', quantity: 30, unit_label: 'ULOs', visibility: 'unit', unit_id: 'G8' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const csv = readZip(buildPersonalExportZip(app.ctx, op.id).buffer).get('activities.csv')!.toString('utf8');
  const { columns, rows } = parseCsvText(csv);
  assert.equal(columns.filter((c) => c === 'Visibility').length, 1);
  assert.ok(columns.includes('Unit ID') && !columns.includes('Unit'));
  const mapping = guessMapping(columns);
  assert.equal(mapping.unit_label, 'Action Unit');
  const back = applyMapping(rows, mapping).records.find((r) => r.title === 'Reconciled 30 ULOs');
  assert.equal(back?.unit_label, 'ULOs');
  assert.equal(back?.visibility, 'unit');
});

test('B20: a unit total is withheld when subtracting the shown teams would reveal a withheld one', async () => {
  const db = app.ctx.db;
  const at = new Date().toISOString();
  db.prepare("INSERT INTO units (id, code, name, parent_id, created_at) VALUES ('OV', 'OV', 'Overview Section', 'G8', ?)").run(at);
  for (const t of ['OVT1', 'OVT2']) db.prepare("INSERT INTO units (id, code, name, parent_id, created_at) VALUES (?, ?, ?, 'OV', ?)").run(t, t, `Team ${t}`, at);
  const log = async (name: string, unit: string, dollars: number) => {
    const u = await app.register(name);
    db.prepare('INSERT INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES (?, ?, 1, ?)').run(u.id, unit, at);
    db.prepare("INSERT INTO activities (id, user_id, unit_id, visibility, date, title, dollar_amount, dollar_type, created_at, updated_at) VALUES (?, ?, ?, 'unit', ?, 'x', ?, 'reconciled', ?, ?)")
      .run(`ov-${name}`, u.id, unit, today(), dollars, at, at);
  };
  await log('ovlone', 'OVT1', 7777);
  for (const [i, d] of [100, 200, 300].entries()) await log(`ovteam${i}`, 'OVT2', d);
  const view = (full = false) => unitOverview(app.ctx, 'OV', { from: '2026-01-01', to: '2099-12-31', full, goalUnits: [] });

  const o = view();
  const teams = Object.fromEntries(o.teams.map((t) => [t.unit_id, t]));
  assert.equal(teams.OVT1.withheld, true);
  assert.equal(teams.OVT2.dollars, 600);
  assert.equal(o.totals.withheld, true, 'total − OVT2 would be the lone Marine’s $7,777');
  assert.equal(o.totals.dollars, null);
  assert.equal(view(true).totals.dollars, 8377, 'someone who can read the records sees everything');

  // With enough other people in the remainder, the subtraction no longer singles anyone out.
  await log('ovdirect1', 'OV', 50);
  await log('ovdirect2', 'OV', 50);
  const later = view();
  assert.equal(later.totals.withheld, false);
  assert.equal(later.totals.dollars, 8477);
  assert.equal(later.teams.find((t) => t.unit_id === 'OVT1')?.withheld, true);
});
