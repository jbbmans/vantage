/**
 * The defects the production readiness gate found (Task 28), each held by the test that fails without its fix. The
 * register (docs/engineering/readiness-gate.json) cites each test by its title.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { startApp, enroll, today, mockGenAi, PASSWORD, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { SCHEMA_VERSION, openDatabase } from '../../server/db/index.ts';
import { decryptSecret, encryptSecret } from '../../server/lib/crypto.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';
import { loadConfig } from '../../server/config.ts';
import { createContext } from '../../server/app.ts';

const day = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const EDIPI_RUN = /(?<!\d)\d{10}(?!\d)/;

// ——— Reach inside one Unit Instance: a role that does not reach down (position 0) reads its own unit alone ———

let app: TestApp;
let op: { id: string; token: string };
let kid: { id: string; token: string };
/** G8 holds VIEW_UNIT, VIEW_RECORDS, VIEW_MEMBER_DETAIL and EXPORT_DATA at position 0: G8's own records, not FISCAL's. */
let reader: { id: string; token: string };
/** G8 holds VIEW_UNIT and EXPORT_DATA, and may not view shared records. */
let exporter: { id: string; token: string };
const ids: Record<string, string> = {};

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  const k = await app.register('fiscalkid', { last_name: 'Zzbeneath' });
  await enroll(app, op.token, 'FISCAL', k.id);
  kid = { id: k.id, token: (await app.login('fiscalkid')).body.token };
  const entry = await post(kid.token, '/api/records/activities', { title: 'ZZFISCAL obligation', date: day(-2), dollar_amount: 98765.43, dollar_type: 'obligated', visibility: 'unit', unit_id: 'FISCAL' });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  ids.fiscalEntry = entry.body.id;
  const own = await post(op.token, '/api/records/activities', { title: 'G8 own entry', date: day(-2), visibility: 'unit', unit_id: 'G8' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  ids.g8Entry = own.body.id;
  const held = await post(op.token, '/api/work/items', { title: 'ZZFISCAL held case', unit_id: 'FISCAL', visibility: 'unit' });
  assert.equal(held.status, 201, JSON.stringify(held.body));
  assert.equal((await post(kid.token, `/api/work/items/${held.body.id}/claim`)).status, 200);
  assert.equal((await post(op.token, '/api/work/items', { title: 'ZZFISCAL open case', unit_id: 'FISCAL', visibility: 'unit' })).status, 201);
  assert.equal((await post(op.token, '/api/work/items', { title: 'G8 open case', unit_id: 'G8', visibility: 'unit' })).status, 201);

  const role = async (name: string, position: number, permissions: number) => {
    const r = await post(op.token, '/api/org/roles', { unit_id: 'G8', name, position, permissions });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const holder = async (username: string, roleId: string) => {
    const u = await app.register(username);
    await enroll(app, op.token, 'G8', u.id);
    assert.equal((await post(op.token, `/api/org/team/${u.id}/roles`, { role_id: roleId, unit_id: 'G8' })).status, 200);
    return { id: u.id, token: (await app.login(username)).body.token as string };
  };
  reader = await holder('staffreader', await role('Staff Reader', 0, PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL | PERMISSIONS.EXPORT_DATA));
  exporter = await holder('exportonly', await role('Export Only', 20, PERMISSIONS.VIEW_UNIT | PERMISSIONS.EXPORT_DATA));
});
after(async () => { await app?.close(); });

test('a unit export holds only the units its exporter reads: it needs View shared records, and a role that does not reach down exports its own unit', async () => {
  const mine = await app.call('GET', '/api/org/units/G8/export', { token: reader.token });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.units, ['G8'], 'the units beneath are not the reader’s to export');
  const titles = (mine.body.activities as Array<{ title: string }>).map((a) => a.title);
  assert.ok(titles.includes('G8 own entry'), 'its own unit’s shared entries are');
  assert.ok(!titles.includes('ZZFISCAL obligation'), 'FISCAL’s are not');
  assert.ok(!(mine.body.members as Array<{ id: string }>).some((m) => m.id === kid.id), 'nor FISCAL’s Marines');
  assert.equal((await app.call('GET', `/api/records/activities/${ids.fiscalEntry}`, { token: reader.token })).status, 403, 'as the entry itself is not');

  assert.equal((await app.call('GET', '/api/org/units/G8/export', { token: exporter.token })).status, 403, 'Export data without View shared records exports nothing');

  const full = await app.call('GET', '/api/org/units/G8/export', { token: op.token });
  assert.equal(full.status, 200);
  assert.deepEqual([...full.body.units].sort(), ['FISCAL', 'G8'], 'the unit’s leader exports the units beneath');
  assert.ok((full.body.activities as Array<{ title: string }>).some((a) => a.title === 'ZZFISCAL obligation'));
});

test('team workload, and its report and export, read the units beneath only where the reader does, and name Marines only where they open member records', async () => {
  const has = (text: string) => ({ fiscalWork: /ZZFISCAL/.test(text), fiscalMarine: /Zzbeneath/.test(text) });
  const page = await app.call('GET', '/api/work/workload?unit_id=G8', { token: reader.token });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual(has(page.text), { fiscalWork: false, fiscalMarine: false }, 'no FISCAL work and no FISCAL Marine on the page');
  assert.equal(page.body.rolls_up, 0);
  assert.ok((page.body.unassigned as Array<{ title: string }>).some((i) => i.title === 'G8 open case'), 'G8’s own work is there');
  for (const path of ['/api/report-center/run?type=workload&subject=unit&unit_id=G8', '/api/report-center/export?type=workload&subject=unit&unit_id=G8&format=csv']) {
    const r = await app.call('GET', path, { token: reader.token });
    assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 200)}`);
    assert.deepEqual(has(r.text), { fiscalWork: false, fiscalMarine: false }, path);
  }

  const leader = await app.call('GET', '/api/work/workload?unit_id=G8', { token: op.token });
  assert.equal(leader.status, 200);
  assert.deepEqual(has(leader.text), { fiscalWork: true, fiscalMarine: true }, 'the unit’s leader sees the units beneath, by Marine');
  assert.equal((leader.body.members as Array<{ id: string; assigned: number }>).find((m) => m.id === kid.id)?.assigned, 1);
});

test('a unit-measured goal reads the units beneath only where its setter does, and its contributors only where their reader does', async () => {
  const goal = (token: string, visibility: 'private' | 'unit') => app.call('POST', '/api/records/goals', {
    token, body: { title: 'G8 obligations', status: 'active', visibility, unit_id: 'G8', measure_scope: 'unit', metric_id: 'money:obligated', direction: 'increase', target_value: 1, period_start: day(-30), period_end: day(30), filters: { user_id: kid.id } },
  });
  const narrow = await goal(reader.token, 'private');
  assert.equal(narrow.status, 201, JSON.stringify(narrow.body));
  assert.equal(narrow.body.progress.current, 0, 'a FISCAL Marine’s total is not the reader’s to measure');
  assert.deepEqual((await app.call('GET', `/api/records/goals/${narrow.body.id}/contributors`, { token: reader.token })).body, []);

  const wide = await goal(op.token, 'unit');
  assert.equal(wide.status, 201, JSON.stringify(wide.body));
  assert.equal(wide.body.progress.current, 98765.43, 'the unit’s leader measures the units beneath');
  const theirs = await app.call('GET', `/api/records/goals/${wide.body.id}/contributors`, { token: op.token });
  assert.deepEqual((theirs.body as Array<{ title: string }>).map((c) => c.title), ['ZZFISCAL obligation']);
  const shown = await app.call('GET', `/api/records/goals/${wide.body.id}/contributors`, { token: reader.token });
  assert.equal(shown.status, 200, 'the reader may open the leader’s shared goal');
  assert.deepEqual(shown.body, [], 'but not the FISCAL entries behind it, by title and amount');
});

test('a goal assigned in a unit shows its contributors, by title and amount, only to those who may open them: not to its unit’s other Marines', async () => {
  const marine = async (username: string) => {
    const u = await app.register(username);
    await enroll(app, op.token, 'G8', u.id);
    return { id: u.id, token: (await app.login(username)).body.token as string };
  };
  const subject = await marine('goalsubject');
  const peer = await marine('goalpeer');
  const entry = await app.call('POST', '/api/records/activities', { token: subject.token, body: { title: 'ZZSUBJECT shared obligation', date: day(-3), dollar_amount: 4321.09, dollar_type: 'obligated', visibility: 'unit', unit_id: 'G8' } });
  assert.equal(entry.status, 201, JSON.stringify(entry.body));
  const goal = await app.call('POST', '/api/records/goals', {
    token: op.token, body: { title: 'Obligate this quarter', status: 'active', visibility: 'unit', unit_id: 'G8', assignee_id: subject.id, metric_id: 'money:obligated', direction: 'increase', target_value: 10000, period_start: day(-30), period_end: day(30) },
  });
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  assert.equal(goal.body.progress.current, 4321.09, 'the goal measures its subject’s work');
  const contributors = (token: string) => app.call('GET', `/api/records/goals/${goal.body.id}/contributors`, { token });
  const titles = (r: { body: unknown }) => (r.body as Array<{ title: string }>).map((c) => c.title);

  assert.equal((await app.call('GET', `/api/records/goals/${goal.body.id}`, { token: peer.token })).status, 200, 'a Marine of the unit sees the goal set there');
  const theirs = await contributors(peer.token);
  assert.equal(theirs.status, 200);
  assert.deepEqual(theirs.body, [], 'but not the entries behind its total');
  assert.equal((await app.call('GET', `/api/records/activities/${entry.body.id}`, { token: peer.token })).status, 403, 'as they may not open the entry itself');

  assert.deepEqual(titles(await contributors(subject.token)), ['ZZSUBJECT shared obligation'], 'its subject sees their own');
  assert.deepEqual(titles(await contributors(op.token)), ['ZZSUBJECT shared obligation'], 'the unit’s leader, who reads shared records, sees them');
});

test('the AI command brief totals only the units its reader reads, and needs View shared records as well as Export data', async () => {
  const mock = await mockGenAi(() => ({ json: { model: 'm', choices: [{ message: { content: '{"executive_summary":"x","highlights":[],"watch_items":[],"recommended_questions":[],"caveats":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }));
  const local = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100', VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'test-key-123', VANTAGE_GENAI_BASE_URL: mock.url });
  try {
    const post = (token: string, path: string, body: unknown = {}) => local.call('POST', path, { token, body });
    const lead = await local.setupOperator();
    assert.equal((await post(lead.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
    const marine = await local.register('fiscalbrief');
    await enroll(local, lead.token, 'FISCAL', marine.id);
    const marineToken = (await local.login('fiscalbrief')).body.token as string;
    assert.equal((await post(marineToken, '/api/records/activities', { title: 'FISCAL entry', date: day(-2), category: 'ZZFISCALCAT', dollar_amount: 98765, dollar_type: 'obligated', visibility: 'unit', unit_id: 'FISCAL' })).status, 201);
    const holder = async (username: string, position: number, permissions: number) => {
      const r = await post(lead.token, '/api/org/roles', { unit_id: 'G8', name: username, position, permissions });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const u = await local.register(username);
      await enroll(local, lead.token, 'G8', u.id);
      assert.equal((await post(lead.token, `/api/org/team/${u.id}/roles`, { role_id: r.body.id, unit_id: 'G8' })).status, 200);
      return (await local.login(username)).body.token as string;
    };
    const brief = (token: string) => post(token, '/api/ai/assist', { workflow: 'command_brief', input: { unit_id: 'G8', from: day(-30), to: day(0) } });
    const sent = async (token: string) => { const before = mock.calls.length; const r = await brief(token); return { status: r.status, sent: mock.calls.slice(before).map((c) => JSON.stringify(c.body.messages)).join(' ') }; };

    const narrow = await sent(await holder('staffbrief', 0, PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.EXPORT_DATA));
    assert.equal(narrow.status, 200);
    assert.ok(!/ZZFISCALCAT|98765/.test(narrow.sent), 'FISCAL’s totals never reach the provider for a reader who does not reach FISCAL');
    assert.equal((await brief(await holder('exportbrief', 20, PERMISSIONS.VIEW_UNIT | PERMISSIONS.EXPORT_DATA))).status, 403, 'Export data alone briefs nothing');
    // Reading FISCAL as its NCO, who may not export there, does not carry FISCAL's totals out under G8's export permission.
    await holder('clerkbrief', 0, PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.EXPORT_DATA);
    const clerk = local.ctx.db.prepare("SELECT id FROM users WHERE username = 'clerkbrief'").get() as { id: string };
    await enroll(local, lead.token, 'FISCAL', clerk.id, 'nco');
    const clerkBrief = await sent((await local.login('clerkbrief')).body.token as string);
    assert.equal(clerkBrief.status, 200);
    assert.ok(!/ZZFISCALCAT|98765/.test(clerkBrief.sent), 'a unit read without its export permission is not briefed');
    const wide = await sent(lead.token);
    assert.equal(wide.status, 200);
    assert.match(wide.sent, /ZZFISCALCAT/, 'the unit’s leader’s brief rolls up the units beneath');
  } finally { await local.close(); mock.close(); }
});

test('a unit report leaves as a file only with the export permission in every unit it reads', async () => {
  const role = await app.call('POST', '/api/org/roles', { token: op.token, body: { unit_id: 'G8', name: 'Staff Exporter', position: 0, permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.EXPORT_DATA } });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const u = await app.register('fiscalclerk');
  await enroll(app, op.token, 'G8', u.id);
  assert.equal((await app.call('POST', `/api/org/team/${u.id}/roles`, { token: op.token, body: { role_id: role.body.id, unit_id: 'G8' } })).status, 200);
  await enroll(app, op.token, 'FISCAL', u.id, 'nco');
  const token = (await app.login('fiscalclerk')).body.token as string;
  const report = (unit: string, format?: string) => app.call('GET', `/api/report-center/${format ? 'export' : 'run'}?type=activity&subject=unit&unit_id=${unit}&period=all${format ? `&format=${format}` : ''}`, { token });

  assert.equal((await report('FISCAL', 'csv')).status, 403, 'FISCAL is read as its NCO, who may not export it');
  const run = await report('G8');
  assert.equal(run.status, 200, run.text.slice(0, 200));
  assert.match(run.text, /ZZFISCAL obligation/, 'the report on G8 reads FISCAL, as the clerk does');
  assert.deepEqual(run.body.files, [], 'so it offers no file');
  for (const format of ['csv', 'pdf', 'json']) {
    const file = await report('G8', format);
    assert.equal(file.status, 403, `${format}: ${file.text.slice(0, 120)}`);
    assert.doesNotMatch(file.text, /ZZFISCAL/);
  }

  const narrow = await app.call('GET', '/api/report-center/export?type=activity&subject=unit&unit_id=G8&period=all&format=csv', { token: reader.token });
  assert.equal(narrow.status, 200, 'a reader of G8 alone exports G8');
  assert.doesNotMatch(narrow.text, /ZZFISCAL/);
  const full = await app.call('GET', '/api/report-center/export?type=activity&subject=unit&unit_id=G8&period=all&format=csv', { token: op.token });
  assert.equal(full.status, 200);
  assert.match(full.text, /ZZFISCAL obligation/, 'the unit’s leader exports the units beneath');
});

test('a personal export holds a task someone else owns only while its read rule gives it: assigned, shared, and not in its owner’s bin', async () => {
  const task = async (title: string) => {
    const r = await app.call('POST', '/api/records/tasks', { token: op.token, body: { title, status: 'active', visibility: 'unit', unit_id: 'FISCAL', assignee_id: kid.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const live = await task('ZZLIVE assigned task');
  const binned = await task('ZZBINNED assigned task');
  const up = await app.call('POST', `/api/records/tasks/${binned}/attachments`, { token: op.token, raw: Buffer.from('%PDF-1.4\n% the leader’s own file\n%%EOF\n'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'leader-notes.pdf' } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal((await app.call('DELETE', `/api/records/tasks/${binned}`, { token: op.token })).status, 200);
  assert.equal((await app.call('GET', `/api/records/tasks/${binned}`, { token: kid.token })).status, 404, 'the bin is its owner’s alone');

  const mine = await app.call('GET', '/api/me/export?format=json', { token: kid.token });
  assert.equal(mine.status, 200, mine.text.slice(0, 200));
  const titles = (mine.body.records.tasks as Array<{ title: string }>).map((t) => t.title);
  assert.ok(titles.includes('ZZLIVE assigned task'), 'a task assigned to them is theirs to keep');
  assert.ok(!titles.includes('ZZBINNED assigned task'), 'one its owner binned is not');
  assert.ok(!(mine.body.attachments as Array<{ original_name: string }>).some((a) => a.original_name === 'leader-notes.pdf'), 'nor its owner’s file');
  assert.ok(live);
});

// ——— EDIPIs: a Unit Instance's trail is read by roles that never see one, and a personal export carries only the owner's ———

test('the Unit Instance audit trail never shows, matches or exports an EDIPI, whether a card was linked or the feed ran', async () => {
  const local = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  try {
    const lead = await local.setupOperator();
    const rivera = await local.register('rivera');
    await enroll(local, lead.token, 'G8', rivera.id);
    const aud = await local.register('auditor');
    await enroll(local, lead.token, 'G8', aud.id);
    assert.equal((await local.call('POST', '/api/orgs/G8/roles', { token: lead.token, body: { user_id: aud.id, role: 'auditor' } })).status, 201);
    const token = (await local.login('auditor')).body.token as string;
    assert.equal((await local.call('POST', '/api/orgs/G8/personnel/link', { token: lead.token, body: { user_id: rivera.id, edipi: '9876543210' } })).status, 200);
    const feed = (rows: string, extra = '') => local.call('POST', `/api/orgs/G8/personnel/sync?source=MCTFS&apply=1${extra}`, { token: lead.token, raw: Buffer.from(`DoD ID,Last,First,Grade,PMOS,Status\n${rows}`), headers: { 'content-type': 'text/plain' } });
    assert.equal((await feed('9876543210,Marine,Rivera,Cpl,0311,Active\n5550001111,Nobody,Pat,LCpl,0311,Active')).status, 200);
    assert.equal((await feed('9876543210,Marine,Rivera,Sgt,0311,Active\n5550001111,Nobody,Pat,LCpl,0311,Separated', '&confirm_separations=1')).status, 200);

    const page = await local.call('GET', '/api/orgs/G8/audit', { token });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    const rows = page.body.rows as Array<Record<string, unknown>>;
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['personnel_link', 'personnel_sync_update', 'personnel_separated']) assert.ok(actions.has(a), `the trail holds ${a}`);
    assert.deepEqual(rows.filter((r) => EDIPI_RUN.test(String(r.entity_id ?? '')) || EDIPI_RUN.test(String(r.detail ?? ''))).map((r) => r.action), [], 'no entry shows an EDIPI');
    assert.match(String(rows.find((r) => r.action === 'personnel_link')!.detail), /••••••3210/, 'a linked card shows as the screen masks it');
    for (const q of ['9876543210', '5550001111']) {
      const search = await local.call('GET', `/api/orgs/G8/audit?q=${q}`, { token });
      assert.equal(search.status, 200);
      assert.deepEqual(search.body.rows, [], `a search for ${q} matches nothing`);
    }
    const csv = await local.call('GET', '/api/orgs/G8/audit/export?format=csv', { token });
    assert.equal(csv.status, 200);
    assert.ok(!/9876543210|5550001111/.test(csv.text), 'nor does the downloaded trail carry one');
  } finally { await local.close(); }
});

const CAC_SECRET = 'proxy-secret-proxy-secret-proxy-secret';
const CAC_USER = readFileSync(new URL('../fixtures/cac-user.pem', import.meta.url), 'utf8'); // SAN 1234567890@mil (synthetic)

test('a personal export names other people by rank and name where their username is their card’s EDIPI', async () => {
  const local = await startApp({ CAC_MODE: 'proxy', CAC_PROXY_SECRET: CAC_SECRET, CAC_AUTO_PROVISION: 'true', VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  try {
    const lead = await local.setupOperator();
    const sync = await local.call('POST', '/api/orgs/G8/personnel/sync?source=MCTFS&apply=1', { token: lead.token, raw: Buffer.from('DoD ID,Last,First,Grade,RUC,Status\n1234567890,Avery,Jordan,Sgt,G8,Active'), headers: { 'content-type': 'text/plain' } });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    const card = await local.call('POST', '/api/auth/cac', { headers: { 'x-client-cert': encodeURIComponent(CAC_USER), 'x-client-verify': 'SUCCESS', 'x-cac-proxy-secret': CAC_SECRET } });
    assert.equal(card.status, 200, JSON.stringify(card.body));
    const sergeant = local.ctx.db.prepare("SELECT id, username FROM users WHERE edipi = '1234567890'").get() as { id: string; username: string };
    assert.equal(sergeant.username, 'edipi-1234567890', 'a card-provisioned account is named by its EDIPI');

    const marine = await local.register('plainmarine');
    await enroll(local, lead.token, 'G8', marine.id);
    const marineToken = (await local.login('plainmarine')).body.token as string;
    assert.equal((await local.call('PUT', `/api/org/units/G8/members/${marine.id}`, { token: lead.token, body: { supervisor_id: sergeant.id } })).status, 200);
    assert.equal((await local.call('GET', `/api/org/team/${sergeant.id}/personnel`, { token: lead.token })).status, 200);

    for (const [who, token] of [['the Marine', marineToken], ['their leader', lead.token]] as const) {
      assert.equal((await local.call('POST', '/api/auth/sudo', { token, body: { password: PASSWORD } })).status, 200);
      const exported = await local.call('GET', '/api/me/export?format=json', { token });
      assert.equal(exported.status, 200, exported.text.slice(0, 200));
      assert.ok(!exported.text.includes('1234567890'), `${who}’s export carries no other person’s EDIPI`);
      if (who === 'the Marine') assert.deepEqual(exported.body.personnel.records.map((r: { supervisor: string }) => r.supervisor), ['Sgt Avery, Jordan'], 'the supervisor is named as the screen names them');
    }
  } finally { await local.close(); }
});

test('a personal export gives the Marine where they acted from, never the address of anyone who acted on them', async () => {
  const local = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100', TRUST_PROXY: 'loopback' });
  try {
    const lead = await local.setupOperator();
    const marine = await local.register('ipmarine');
    await enroll(local, lead.token, 'G8', marine.id);
    const marineToken = (await local.login('ipmarine')).body.token as string;
    const entry = await local.call('POST', '/api/records/activities', { token: marineToken, body: { title: 'Shared entry', date: day(-1), visibility: 'unit', unit_id: 'G8' } });
    assert.equal(entry.status, 201);
    const away = { 'x-forwarded-for': '203.0.113.77' };
    assert.equal((await local.call('GET', `/api/records/activities/${entry.body.id}`, { token: lead.token, headers: away })).status, 200);
    assert.equal((await local.call('GET', `/api/org/team/${marine.id}/personnel`, { token: lead.token, headers: away })).status, 200);

    assert.equal((await local.call('POST', '/api/auth/sudo', { token: marineToken, body: { password: PASSWORD } })).status, 200);
    const json = await local.call('GET', '/api/me/export?format=json', { token: marineToken });
    assert.equal(json.status, 200);
    const trail = json.body.audit_trail as Array<{ actor: string; action: string; ip: string | null }>;
    assert.ok(trail.some((e) => e.actor !== 'me' && e.action === 'view_record'), 'the leader’s look at the entry is in the Marine’s trail');
    assert.deepEqual(trail.filter((e) => e.actor !== 'me' && e.ip != null), [], 'with no address');
    assert.ok(trail.some((e) => e.actor === 'me' && e.ip != null), 'the Marine’s own entries keep theirs');
    assert.ok(!json.text.includes('203.0.113.77'));
    const zip = await local.call('GET', '/api/me/export?format=zip', { token: marineToken, binary: true });
    assert.equal(zip.status, 200);
    assert.ok(!zip.buffer!.includes('203.0.113.77'), 'nor its audit-trail.csv');
  } finally { await local.close(); }
});

// ——— The service archive (POST /api/platform/import): only what this build can hold, with the trail it was exported with ———

test('a service archive from a newer build, or with its audit trail changed, removed or stripped, is refused and nothing is imported', async () => {
  const source = await startApp();
  try {
    const sourceOp = await source.setupOperator();
    assert.equal((await source.call('POST', '/api/records/activities', { token: sourceOp.token, body: { title: 'Kept', date: day(-3) } })).status, 201);
    const archive = (await source.call('GET', '/api/platform/export', { token: sourceOp.token })).body;
    type Archive = { tables: Record<string, Array<Record<string, unknown>>> };
    const variant = (change: (a: Archive) => void) => { const a = structuredClone(archive) as Archive; change(a); return a; };
    const cases: Array<[string, Archive, RegExp]> = [
      ['from a newer build', variant((a) => { a.tables.meta.find((m) => m.key === 'schema_version')!.value = String(SCHEMA_VERSION + 1); }), /newer than this build/],
      ['with one entry changed', variant((a) => { a.tables.audit_log[1].detail = 'rewritten in the file'; }), /audit trail does not verify/],
      ['with one entry removed', variant((a) => { a.tables.audit_log = a.tables.audit_log.filter((r) => r.action !== 'create'); }), /audit trail does not verify/],
      ['with its trail stripped', variant((a) => { a.tables.audit_log = []; a.tables.meta = a.tables.meta.filter((m) => !['audit_head', 'chain_key'].includes(String(m.key))); }), /holds no audit trail/],
    ];
    for (const [what, body, refusal] of cases) {
      const fresh = await startApp();
      try {
        const freshOp = await fresh.setupOperator();
        const res = await fresh.call('POST', '/api/platform/import', { token: freshOp.token, body });
        assert.equal(res.status, 400, `${what}: ${res.text.slice(0, 200)}`);
        assert.match(String(res.body.error), refusal, what);
        assert.equal((fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 0, `${what}: nothing came in`);
        assert.equal(verifyAuditChain(fresh.ctx).ok, true, `${what}: this host's own trail is as it was`);
      } finally { await fresh.close(); }
    }

    const fresh = await startApp();
    try {
      const freshOp = await fresh.setupOperator();
      const res = await fresh.call('POST', '/api/platform/import', { token: freshOp.token, body: archive });
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.equal(verifyAuditChain(fresh.ctx).ok, true, 'the archive as exported comes in, and its trail verifies');
    } finally { await fresh.close(); }
  } finally { await source.close(); }
});

test('an archive is taken only by a fresh instance: one account, one Unit Instance and no record of any kind', async () => {
  const source = await startApp();
  try {
    const sourceOp = await source.setupOperator();
    const archive = (await source.call('GET', '/api/platform/export', { token: sourceOp.token })).body;
    for (const [what, prepare] of [
      ['a training on file', async (t: TestApp, token: string) => { assert.equal((await t.call('POST', '/api/records/trainings', { token, body: { title: 'Annual training', date: day(-5) } })).status, 201); }],
      ['a second Unit Instance', async (t: TestApp, token: string) => { assert.equal((await t.call('POST', '/api/platform/orgs', { token, body: { name: 'MARFORRES G-1', code: 'G1' } })).status, 201); }],
    ] as const) {
      const busy = await startApp();
      try {
        const busyOp = await busy.setupOperator();
        await prepare(busy, busyOp.token);
        const before = (busy.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
        const res = await busy.call('POST', '/api/platform/import', { token: busyOp.token, body: archive });
        assert.equal(res.status, 400, `${what}: ${res.text.slice(0, 200)}`);
        assert.match(String(res.body.error), /fresh instance/, what);
        assert.ok((busy.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n >= before, `${what}: its trail is kept`);
      } finally { await busy.close(); }
    }
  } finally { await source.close(); }
});

test('an archive sealed under another secret, from before archives said so, is refused before anything is replaced', async () => {
  const source = await startApp({ VANTAGE_SECRET: 'another-secret-another-secret-another-0009' });
  try {
    const sourceOp = await source.setupOperator();
    assert.equal((await source.call('POST', '/api/records/activities', { token: sourceOp.token, body: { title: 'Elsewhere', date: day(-3) } })).status, 201);
    const archive = (await source.call('GET', '/api/platform/export', { token: sourceOp.token })).body;
    delete archive.key_check;
    const fresh = await startApp();
    try {
      const freshOp = await fresh.setupOperator();
      const res = await fresh.call('POST', '/api/platform/import', { token: freshOp.token, body: archive });
      assert.equal(res.status, 400, res.text.slice(0, 200));
      assert.equal((fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 0, 'nothing came in');
      assert.equal((fresh.ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'boletz'").get() as { n: number }).n, 1, 'its own account is still there');
      assert.equal((await fresh.call('POST', '/api/records/activities', { token: freshOp.token, body: { title: 'Still running', date: day(-1) } })).status, 201, 'and it carries on');
      assert.equal(verifyAuditChain(fresh.ctx).ok, true, 'with its own trail intact');
    } finally { await fresh.close(); }
  } finally { await source.close(); }
});

test('a settings change refused for its metrics changes nothing else either, so nothing is in force that is neither saved nor in the trail', async () => {
  const local = await startApp();
  try {
    const lead = await local.setupOperator();
    const was = local.ctx.runtime.attachmentsEnabled;
    const edits = () => (local.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'edit_configuration'").get() as { n: number }).n;
    const before = edits();
    const res = await local.call('PUT', '/api/platform/runtime', { token: lead.token, body: { attachmentsEnabled: !was, metrics: { ...local.ctx.runtime.metrics, value_types: [{ key: 'x', label: 'X', summable: false }] } } });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(local.ctx.runtime.attachmentsEnabled, was, 'the setting beside the refused metrics is not in force');
    assert.equal(edits(), before);
  } finally { await local.close(); }
});

test('moving a unit under another parent says where it sat before, in the trail', async () => {
  const local = await startApp();
  try {
    const lead = await local.setupOperator();
    for (const [name, short] of [['Alpha', 'ALPHA'], ['Bravo', 'BRAVO'], ['Team One', 'T1']]) {
      assert.equal((await local.call('POST', '/api/org/units', { token: lead.token, body: { name, short_name: short, parent_id: short === 'T1' ? 'ALPHA' : 'G8' } })).status, 201);
    }
    assert.equal((await local.call('PUT', '/api/org/units/T1', { token: lead.token, body: { parent_id: 'BRAVO' } })).status, 200);
    const entry = local.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'edit_unit' AND entity_id = 'T1' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
    assert.match(entry.detail, /parent_id: ALPHA → BRAVO/);
  } finally { await local.close(); }
});

test('the audit log is append-only from every start, even for a database copied without its triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-gate-'));
  try {
    const path = join(dir, 'vantage.db');
    const first = openDatabase(path);
    first.exec('DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;');
    first.close();
    const again = openDatabase(path);
    try {
      const triggers = (again.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_log' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
      assert.deepEqual(triggers, ['audit_log_no_delete', 'audit_log_no_update']);
    } finally { again.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a restore across a secret change seals the stored secrets again, so the service needs no previous secret afterwards', async () => {
  const OLD = 'old-secret-old-secret-old-secret-0001';
  const NEW = 'new-secret-new-secret-new-secret-0002';
  const dir = mkdtempSync(join(tmpdir(), 'vantage-gate-restore-'));
  try {
    const path = join(dir, 'vantage.db');
    const backupFile = join(dir, 'nightly.db');
    const env = { ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: path, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false' };
    const live = await startApp({ VANTAGE_DB: path, VANTAGE_SECRET: OLD });
    const lead = await live.setupOperator();
    live.ctx.db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encryptSecret(OLD, 'JBSWY3DPEHPK3PXP'), lead.id);
    execFileSync(process.execPath, ['scripts/backup.ts', backupFile], { env: { ...env, VANTAGE_SECRET: OLD }, stdio: 'pipe' });
    await live.close();

    const ran = spawnSync(process.execPath, ['scripts/restore.ts', 'REPLACE-DATABASE', '--from', backupFile, '--by', 'boletz', '--reason', 'Host rebuilt under the new secret'],
      { env: { ...env, VANTAGE_RESTORE: '1', VANTAGE_SECRET: NEW, VANTAGE_SECRET_PREVIOUS: OLD }, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    const db = new Database(path, { readonly: true });
    try {
      const sealed = (db.prepare('SELECT totp_secret FROM users WHERE id = ?').get(lead.id) as { totp_secret: string }).totp_secret;
      assert.equal(decryptSecret(NEW, sealed), 'JBSWY3DPEHPK3PXP', 'the authenticator opens under the current secret alone');
    } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the database, its write-ahead log and its directory are the service’s alone, whatever the umask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-gate-perm-'));
  const previous = process.umask(0o022);
  try {
    const path = join(dir, 'data', 'vantage.db');
    const db = openDatabase(path);
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES ('gate_probe', '1')").run();
      for (const file of [path, `${path}-wal`, `${path}-shm`]) assert.equal(statSync(file).mode & 0o777, 0o600, file);
      assert.equal(statSync(join(dir, 'data')).mode & 0o777, 0o700);
    } finally { db.close(); }
  } finally { process.umask(previous); rmSync(dir, { recursive: true, force: true }); }
});

test('a change of VANTAGE_SECRET is in the trail, once, with what it sealed again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-gate-rotate-'));
  const path = join(dir, 'vantage.db');
  const OLD = 'old-secret-old-secret-old-secret-0001';
  const NEW = 'new-secret-new-secret-new-secret-0002';
  const start = (env: Record<string, string>) => createContext(loadConfig({
    NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: path, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_PUBLIC_URL: 'http://localhost:5173', ...env,
  } as NodeJS.ProcessEnv));
  const rotations = (ctx: ReturnType<typeof start>) => (ctx.db.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'secret_rotated'").all() as Array<{ actor_id: string | null; detail: string }>);
  try {
    const first = start({ VANTAGE_SECRET: OLD });
    first.db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, totp_secret, created_at, updated_at) VALUES ('u1', 'avery', '', 'Jordan', 'Avery', ?, '2026-10-01', '2026-10-01')`).run(encryptSecret(OLD, 'JBSWY3DPEHPK3PXP'));
    assert.deepEqual(rotations(first), [], 'a first start rotates nothing');
    first.db.close();
    const rotating = start({ VANTAGE_SECRET: NEW, VANTAGE_SECRET_PREVIOUS: OLD });
    assert.deepEqual(rotations(rotating), [{ actor_id: null, detail: 'VANTAGE_SECRET changed: the audit chain key wrapped under it, 1 stored secret sealed again' }]);
    assert.equal(verifyAuditChain(rotating).ok, true);
    rotating.db.close();
    const again = start({ VANTAGE_SECRET: NEW, VANTAGE_SECRET_PREVIOUS: OLD });
    assert.equal(rotations(again).length, 1, 'a start with nothing left to seal writes nothing');
    again.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
