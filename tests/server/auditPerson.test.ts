import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { audit, orgAuditWhere } from '../../server/services/audit.ts';

/**
 * One person's entries in an audit trail (ADR-0011, ADR-0012, ADR-0032): what they did and what was done about them,
 * by their id. The filter only narrows the trail it is given. It never reaches into another Unit Instance, never brings
 * a unit's access log an entry filed under no unit, and an id the trail holds nothing for reads exactly as a made-up one.
 */

type Person = { token: string; id: string };
type Row = { id: string; seq: number; action: string; actor_id: string | null; subject_id: string | null; unit_id?: string | null; org_id?: string | null; entity_id: string | null; detail: string | null; category?: string };
type Page = { rows: Row[]; next: number | null; chain: { ok: boolean; count: number } | null; actions: string[] | null };

let app: TestApp;
let op: Person & { unitId: string };
let g1lead: Person;
/** A Marine of G-8 only. */
let g8marine: Person;
/** A Marine of G-1 only, with entries there. */
let g1marine: Person;
/** A Marine serving in both instances. */
let dual: Person;
/** An account in no Unit Instance at all. */
let loner: Person;
let privateId: string;
let sharedId: string;
/** Entries about g8marine: one nobody wrote in FISCAL, one nobody wrote on the platform, and one they wrote about themselves in FISCAL. */
let provisionedId: string;
let failedSignInId: string;
let selfAboutId: string;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const utcDay = () => new Date().toISOString().slice(0, 10);

/** Runs fn while noting the SQL of every statement prepared on the app's database. */
async function preparing<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const db = app.ctx.db;
  const prepare = db.prepare;
  const sql: string[] = [];
  db.prepare = ((text: string) => { sql.push(text); return prepare.call(db, text); }) as typeof db.prepare;
  try { return { result: await fn(), sql }; } finally { db.prepare = prepare; }
}

/**
 * What the log holds for a person under a predicate over `al`, newest first: what a filtered read must return. Never
 * nothing, so a read that came back empty cannot pass for one that matched.
 */
const expected = (where: string, params: unknown[], person: string) => {
  const ids = (app.ctx.db.prepare(`SELECT al.id FROM audit_log al WHERE (${where}) AND (al.actor_id = ? OR al.subject_id = ?) ORDER BY al.seq DESC`).all(...params, person, person) as Array<{ id: string }>).map((r) => r.id);
  assert.ok(ids.length > 0, `the log holds something for ${person} under ${where}`);
  return ids;
};
/** The newest entry with this action about g8marine. */
const aboutG8marine = (action: string) => (app.ctx.db.prepare('SELECT id FROM audit_log WHERE action = ? AND subject_id = ? ORDER BY seq DESC LIMIT 1').get(action, g8marine.id) as { id: string }).id;

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  g1lead = await app.register('persong1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('persong1lead');
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  assert.equal((await post(g1lead.token, '/api/org/units', { name: 'G1 Manpower', short_name: 'MANPOWER', code: 'manpower', parent_id: 'G1' })).status, 201);

  g8marine = await app.register('persong8marine');
  await enroll(app, op.token, 'FISCAL', g8marine.id);
  g8marine.token = await login('persong8marine');
  g1marine = await app.register('persong1marine');
  await enroll(app, g1lead.token, 'MANPOWER', g1marine.id);
  g1marine.token = await login('persong1marine');
  dual = await app.register('persondual');
  await enroll(app, op.token, 'FISCAL', dual.id);
  await enroll(app, g1lead.token, 'MANPOWER', dual.id);
  dual.token = await login('persondual');
  loner = await app.register('personloner');

  const made = async (token: string, body: unknown) => {
    const res = await post(token, '/api/records/activities', body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  };
  sharedId = await made(g8marine.token, { title: 'ZZPERSON reconciled the ULO list', date: '2026-09-01', visibility: 'unit', unit_id: 'FISCAL' });
  privateId = await made(g8marine.token, { title: 'ZZPERSON notes to self', date: '2026-09-01', visibility: 'private', unit_id: 'FISCAL' });
  await made(dual.token, { title: 'ZZPERSON G8 close-out', date: '2026-09-02', visibility: 'unit', unit_id: 'FISCAL' });
  await made(dual.token, { title: 'ZZPERSON G1 orders', date: '2026-09-02', visibility: 'unit', unit_id: 'MANPOWER' });
  await made(g1marine.token, { title: 'ZZPERSON G1 roster check', date: '2026-09-03', visibility: 'unit', unit_id: 'MANPOWER' });
  // Each leader opens the Marine's page: an entry about them that someone else wrote, in each Unit Instance.
  assert.equal((await get(op.token, `/api/org/team/${g8marine.id}`)).status, 200);
  assert.equal((await get(op.token, `/api/org/team/${dual.id}`)).status, 200);
  assert.equal((await get(g1lead.token, `/api/org/team/${dual.id}`)).status, 200);
  assert.equal((await get(g1lead.token, `/api/org/team/${g1marine.id}`)).status, 200);
  // What nobody wrote about them, as the roster feed and a failed sign-in write it, and one entry they wrote about
  // themselves, which each branch of the person filter could return and only one may.
  audit(app.ctx, { actor_id: null, action: 'personnel_provisioned', entity: 'users', entity_id: g8marine.id, subject_id: g8marine.id, unit_id: 'FISCAL', detail: 'from the roster' });
  provisionedId = aboutG8marine('personnel_provisioned');
  audit(app.ctx, { actor_id: null, action: 'login_failed', subject_id: g8marine.id, detail: 'password' });
  failedSignInId = aboutG8marine('login_failed');
  audit(app.ctx, { actor_id: g8marine.id, action: 'invite_accepted', entity: 'user', entity_id: g8marine.id, subject_id: g8marine.id, unit_id: 'FISCAL', detail: 'existing account' });
  selfAboutId = aboutG8marine('invite_accepted');
});
after(async () => { await app.close(); });

test('a person filter in one Unit Instance’s trail says nothing of a person who acted only in another: the same empty page as an id nobody has', async () => {
  const page = async (person: string) => {
    const res = await get(g1lead.token, `/api/orgs/G1/audit?person=${encodeURIComponent(person)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Page;
  };
  const g8Only = await page(g8marine.id);
  assert.deepEqual(g8Only.rows, []);
  assert.equal(g8Only.next, null);
  // The trail's own action list, as its unfiltered first page gives it: one person narrows the rows alone.
  const unfiltered = (await get(g1lead.token, '/api/orgs/G1/audit')).body as Page;
  assert.ok(unfiltered.actions && unfiltered.actions.length > 0);
  assert.deepEqual(g8Only.actions, unfiltered.actions, 'a page narrowed to one person still carries the trail’s action list');
  assert.deepEqual(g8Only.chain, unfiltered.chain);
  for (const other of [randomUUID(), loner.id, 'nobody']) assert.deepEqual(await page(other), g8Only, `${other}: the same page, chain and all`);
  // And the other way: G-8's trail says nothing of a Marine who serves in G-1 alone, whose entries G-1's trail holds.
  assert.ok((await page(g1marine.id)).rows.length > 0);
  const g8Page = async (person: string) => (await get(op.token, `/api/orgs/G8/audit?person=${encodeURIComponent(person)}`)).body as Page;
  const g8Nobody = await g8Page(randomUUID());
  assert.deepEqual(g8Nobody.rows, []);
  assert.deepEqual(await g8Page(g1marine.id), g8Nobody, 'a G-1 Marine in G-8’s trail');
  assert.deepEqual(await g8Page(g1lead.id), g8Nobody, 'and G-1’s lead');
  // There is a G-8 trail that holds them, and it is not G-1’s to read, filtered or not.
  assert.equal((await get(g1lead.token, `/api/orgs/G8/audit?person=${g8marine.id}`)).status, 404);
  assert.equal((await get(g1lead.token, `/api/orgs/G8/audit/export?format=csv&person=${g8marine.id}`)).status, 404);
  assert.equal((await get(g1lead.token, `/api/orgs/G1/audit?person=${g8marine.id}&unit=FISCAL`)).status, 404, 'nor a unit of it');
});

test('every entry a person filter returns is that person’s, inside the trail, once, newest first, and one the trail already shows', async () => {
  const g8 = orgAuditWhere(app.ctx, 'G8');
  const g1 = orgAuditWhere(app.ctx, 'G1');
  const read = async (token: string, org: string, extra = '') => {
    const res = await get(token, `/api/orgs/${org}/audit?limit=1000&person=${dual.id}${extra}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Page;
  };

  const inG8 = await read(op.token, 'G8');
  assert.deepEqual(inG8.rows.map((r) => r.id), expected(g8.where, g8.params, dual.id), 'what they did and what was done about them in G-8, newest first');
  assert.equal(new Set(inG8.rows.map((r) => r.id)).size, inG8.rows.length, 'each entry once, even one they wrote about themselves');
  assert.ok(inG8.rows.length > 0 && inG8.rows.every((r) => r.org_id === 'G8' && (r.actor_id === dual.id || r.subject_id === dual.id)));
  assert.ok(inG8.rows.some((r) => r.actor_id === dual.id && r.action === 'create'), 'what they did');
  assert.ok(inG8.rows.some((r) => r.actor_id === op.id && r.subject_id === dual.id && r.action === 'view_member'), 'and what was done about them');
  assert.ok(!JSON.stringify(inG8.rows).includes('MANPOWER') && !JSON.stringify(inG8.rows).includes(g1lead.id), 'nothing of G-1');

  const inG1 = await read(g1lead.token, 'G1');
  assert.deepEqual(inG1.rows.map((r) => r.id), expected(g1.where, g1.params, dual.id));
  assert.ok(inG1.rows.length > 0 && inG1.rows.every((r) => r.org_id === 'G1'));
  assert.ok(inG1.rows.some((r) => r.actor_id === g1lead.id && r.action === 'view_member'));
  assert.ok(!inG1.rows.some((r) => inG8.rows.some((e) => e.id === r.id)), 'the two trails share no entry');

  // The filter adds nothing a reader of the whole trail does not already read.
  const whole = new Set(((await get(op.token, '/api/orgs/G8/audit?limit=1000')).body as Page).rows.map((r) => r.id));
  assert.ok(inG8.rows.length > 0 && inG8.rows.every((r) => whole.has(r.id)));

  // The platform trail: their sign-ins and their own account, never an entry of a Unit Instance.
  const platform = await get(op.token, `/api/platform/audit?limit=1000&person=${dual.id}`);
  assert.equal(platform.status, 200, JSON.stringify(platform.body));
  assert.deepEqual(platform.body.rows.map((r: Row) => r.id), expected('al.org_id IS NULL AND al.unit_id IS NULL', [], dual.id));
  assert.ok(platform.body.rows.some((r: Row) => r.action === 'login'));
  assert.ok(platform.body.rows.length > 0 && platform.body.rows.every((r: Row) => r.org_id === null && r.unit_id === null));
  assert.deepEqual(platform.body.actions, ((await get(op.token, '/api/platform/audit')).body as Page).actions, 'the platform trail’s own action list');
  assert.equal((await get(g1lead.token, `/api/platform/audit?person=${dual.id}`)).status, 403, 'a Unit Manager reads no platform trail');
});

test('a unit’s access log filtered to a Marine holds only the unit’s entries about them, never one about a private entry', async () => {
  const log = async (unit: string, person: string, token = op.token) => {
    const res = await get(token, `/api/org/units/${unit}/audit?limit=500&person=${encodeURIComponent(person)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Page & { unit_id: string };
  };
  const fiscal = await log('FISCAL', g8marine.id);
  assert.equal(fiscal.unit_id, 'FISCAL');
  assert.deepEqual(fiscal.rows.map((r) => r.id), expected("al.unit_id = 'FISCAL'", [], g8marine.id), 'each entry once, newest first, one they wrote about themselves too');
  assert.ok(fiscal.rows.some((r) => r.entity_id === sharedId && r.action === 'create'), 'their shared entry is the unit’s');
  assert.ok(fiscal.rows.some((r) => r.actor_id === op.id && r.subject_id === g8marine.id), 'and who opened their page, with whose it was');
  assert.ok(fiscal.rows.length > 0 && fiscal.rows.every((r) => r.actor_id === g8marine.id || r.subject_id === g8marine.id), 'each row carries its subject');
  assert.ok(!fiscal.rows.some((r) => r.entity_id === privateId || (r.detail || '').includes(privateId)), 'nothing about the private entry');
  // The Unit Instance trail keeps what was done to the private entry (ADR-0040), as it does unfiltered.
  const instance = (await get(op.token, `/api/orgs/G8/audit?limit=1000&person=${g8marine.id}`)).body as Page;
  assert.ok(instance.rows.some((r) => r.entity_id === privateId && r.unit_id === null));

  // Another instance’s Marine, or nobody, reads as an empty log, page for page; another instance’s unit is not this
  // reader’s to read.
  const nobody = await log('FISCAL', randomUUID());
  assert.deepEqual(nobody, { unit_id: 'FISCAL', rows: [], next: null });
  assert.deepEqual(await log('FISCAL', g1marine.id), nobody, 'a G-1 Marine in a G-8 unit’s log');
  assert.deepEqual(await log('FISCAL', g1lead.id), nobody, 'and G-1’s lead');
  const manpowerNobody = await log('MANPOWER', randomUUID(), g1lead.token);
  assert.deepEqual(manpowerNobody.rows, []);
  assert.deepEqual(await log('MANPOWER', g8marine.id, g1lead.token), manpowerNobody, 'a G-8 Marine in a G-1 unit’s log');
  // A Marine of both: each unit's log holds its own entries about them, and nothing the other instance wrote.
  const dualFiscal = (await log('FISCAL', dual.id)).rows;
  assert.deepEqual(dualFiscal.map((r) => r.id), expected("al.unit_id = 'FISCAL'", [], dual.id));
  assert.ok(dualFiscal.some((r) => r.actor_id === op.id && r.subject_id === dual.id), 'what G-8 wrote about them');
  assert.ok(!dualFiscal.some((r) => r.actor_id === g1lead.id), 'never what G-1 did');
  const dualManpower = (await log('MANPOWER', dual.id, g1lead.token)).rows;
  assert.deepEqual(dualManpower.map((r) => r.id), expected("al.unit_id = 'MANPOWER'", [], dual.id));
  assert.ok(dualManpower.some((r) => r.actor_id === g1lead.id && r.subject_id === dual.id), 'what G-1 wrote about them');
  assert.ok(!dualManpower.some((r) => r.actor_id === op.id), 'never what G-8 did');
  assert.equal((await get(g1lead.token, `/api/org/units/FISCAL/audit?person=${dual.id}`)).status, 403);
  // Refused before a single entry is read.
  const refused = await preparing(() => get(g8marine.token, `/api/org/units/FISCAL/audit?person=${g8marine.id}`));
  assert.equal(refused.result.status, 403);
  assert.ok(!refused.sql.some((s) => s.includes('FROM audit_log al')), 'no entry read');

  // A page at a time, to the oldest entry.
  const seen: string[] = [];
  let before: number | null = null;
  for (let i = 0; i < 50; i++) {
    const res = await get(op.token, `/api/org/units/FISCAL/audit?limit=1&person=${g8marine.id}${before ? `&before=${before}` : ''}`);
    assert.equal(res.status, 200);
    seen.push(...res.body.rows.map((r: Row) => r.id));
    before = res.body.next;
    if (!before) break;
  }
  assert.deepEqual(seen, fiscal.rows.map((r) => r.id));
  for (const bad of ['person=', `person=${'x'.repeat(65)}`]) assert.equal((await get(op.token, `/api/org/units/FISCAL/audit?${bad}`)).status, 400, bad);
});

test('a person filter combines with the trail’s other filters, pages back with before, and leaves the chain count and action list the trail’s', async () => {
  const g8 = orgAuditWhere(app.ctx, 'G8');
  const read = async (query: string) => {
    const res = await get(op.token, `/api/orgs/G8/audit?person=${g8marine.id}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Page;
  };
  const all = (await read('&limit=1000')).rows;
  assert.ok(all.length >= 3);
  const user = (await read('&limit=1000&category=user')).rows;
  assert.ok(user.length > 0 && user.every((r) => r.category === 'user'));
  assert.deepEqual(user.map((r) => r.id), all.filter((r) => r.category === 'user').map((r) => r.id));
  const created = (await read('&limit=1000&action=create')).rows;
  assert.deepEqual(created.map((r) => r.entity_id).sort(), [privateId, sharedId].sort());
  assert.deepEqual((await read(`&limit=1000&from=${utcDay()}&to=${utcDay()}`)).rows.map((r) => r.id), all.map((r) => r.id));
  assert.deepEqual((await read('&from=2020-01-01&to=2020-12-31')).rows, []);
  // One unit narrows them to some of their entries: the private entry's are filed under no unit.
  const inFiscal = (await read('&limit=1000&unit=FISCAL')).rows;
  const wantFiscal = all.filter((r) => r.unit_id === 'FISCAL').map((r) => r.id);
  assert.ok(wantFiscal.length > 0 && wantFiscal.length < all.length);
  assert.deepEqual(inFiscal.map((r) => r.id), wantFiscal);
  assert.ok(inFiscal.some((r) => r.entity_id === sharedId && r.action === 'create'));
  assert.deepEqual((await read('&limit=1000&q=view_member')).rows.map((r) => r.id), all.filter((r) => r.action === 'view_member').map((r) => r.id));
  assert.equal((await get(op.token, `/api/orgs/G8/audit?person=${g8marine.id}&from=2026-02-01&to=2026-01-01`)).status, 400, 'the one range rule still holds');

  // Back a page at a time, every entry once, to the oldest.
  const pages: Page[] = [];
  let before: number | null = null;
  do {
    pages.push(await read(`&limit=2${before ? `&before=${before}` : ''}`));
    before = pages.at(-1)!.next;
  } while (before && pages.length < 50);
  assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.id)), all.map((r) => r.id));
  assert.ok(pages.length > 1 && pages.slice(1).every((p) => p.chain === null && p.actions === null), 'only the first page says how the chain stands');

  // The chain is counted for the whole trail, filtered or not. The action list is the trail's too: a first page narrowed
  // to one person carries it as the unfiltered one does, with actions the person is in no entry of, and a page narrowed
  // by anything more keeps the list it was given.
  const unfiltered = (await get(op.token, '/api/orgs/G8/audit')).body as Page;
  const filtered = await read('');
  assert.deepEqual(filtered.chain, unfiltered.chain);
  assert.equal(filtered.chain!.count, (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log al WHERE ${g8.where}`).get(...g8.params) as { n: number }).n);
  assert.ok(unfiltered.actions!.includes('view_member'));
  assert.deepEqual(filtered.actions, unfiltered.actions, 'the trail’s action list, not the person’s');
  assert.ok(filtered.actions!.some((a) => !all.some((r) => r.action === a)), 'it names actions none of their entries has');
  for (const more of ['&action=create', '&category=user', '&unit=FISCAL', '&q=view_member', `&from=${utcDay()}&to=${utcDay()}`]) assert.equal((await read(more)).actions, null, more);
  assert.deepEqual(((await get(op.token, '/api/orgs/G8/audit')).body as Page).actions, unfiltered.actions, 'and a person filter in between changed nothing of it');
  const platform = (await get(op.token, '/api/platform/audit')).body as Page;
  const platformPerson = (await get(op.token, `/api/platform/audit?person=${g8marine.id}`)).body as Page;
  assert.deepEqual(platformPerson.chain?.ok, platform.chain?.ok);
  assert.ok(platform.actions && platform.actions.length > 0);
  assert.deepEqual(platformPerson.actions, platform.actions);
  assert.equal(((await get(op.token, `/api/platform/audit?person=${g8marine.id}&action=login`)).body as Page).actions, null);

  for (const bad of ['person=', `person=${'x'.repeat(65)}`]) {
    assert.equal((await get(op.token, `/api/orgs/G8/audit?${bad}`)).status, 400, bad);
    assert.equal((await get(op.token, `/api/platform/audit?${bad}`)).status, 400, bad);
  }
});

test('an export filtered to one person holds only their entries and names the filter by id, never by name or username', async () => {
  const lastEntry = (action: string) => app.ctx.db.prepare('SELECT detail, subject_id FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action) as { detail: string; subject_id: string | null };
  const words = ['persong8marine', 'Persong8marine', 'Marine'];

  const csv = await get(op.token, `/api/orgs/G8/audit/export?format=csv&person=${g8marine.id}`);
  assert.equal(csv.status, 200, csv.text);
  const [header, ...lines] = csv.text.trim().split('\r\n');
  const cols = header.split(',').map((c) => c.replace(/"/g, ''));
  const [actorCol, subjectCol, idCol] = [cols.indexOf('actor_id'), cols.indexOf('subject_id'), cols.indexOf('entry_hash')];
  assert.ok(actorCol >= 0 && subjectCol >= 0 && idCol >= 0);
  const g8 = orgAuditWhere(app.ctx, 'G8');
  assert.equal(lines.length, expected(g8.where, g8.params, g8marine.id).length);
  assert.ok(lines.length > 0 && lines.every((l) => l.includes(`"${g8marine.id}"`)), 'every line is theirs');
  const exported = lastEntry('organization_audit_exported');
  assert.match(exported.detail, new RegExp(`; person=${g8marine.id}$`), 'the export’s own entry names whose entries left, by id');
  for (const w of words) assert.ok(!exported.detail.includes(w), `and not by ${w}`);

  const json = await get(op.token, `/api/orgs/G8/audit/export?format=json&person=${g8marine.id}&action=create`);
  assert.equal(json.status, 200);
  assert.equal(json.body.filter.person, g8marine.id);
  assert.deepEqual(json.body.rows.map((r: Row) => r.entity_id).sort(), [privateId, sharedId].sort());
  assert.match(lastEntry('organization_audit_exported').detail, new RegExp(`^2 rows as json; action=create person=${g8marine.id}$`));

  const platform = await get(op.token, `/api/platform/audit/export?format=json&person=${g8marine.id}`);
  assert.equal(platform.status, 200);
  assert.equal(platform.body.filter.person, g8marine.id);
  assert.deepEqual(platform.body.rows.map((r: Row) => r.id), expected('al.org_id IS NULL AND al.unit_id IS NULL', [], g8marine.id));
  const platformEntry = lastEntry('platform_audit_exported');
  assert.match(platformEntry.detail, new RegExp(`; person=${g8marine.id}$`));
  for (const w of words) assert.ok(!platformEntry.detail.includes(w));

  // Exporting nothing for an id the trail does not hold is an empty file, not a refusal that says the id is elsewhere.
  const none = await get(g1lead.token, `/api/orgs/G1/audit/export?format=json&person=${g8marine.id}`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.rows, []);
});

test('an entry nobody wrote about a person, and one they wrote about themselves, each comes back once from every trail that holds it', async () => {
  const once = (rows: Row[], id: string, what: string) => assert.equal(rows.filter((r) => r.id === id).length, 1, what);
  const instance = (await get(op.token, `/api/orgs/G8/audit?limit=1000&person=${g8marine.id}`)).body as Page;
  const unit = (await get(op.token, `/api/org/units/FISCAL/audit?limit=500&person=${g8marine.id}`)).body as Page;
  const platform = (await get(op.token, `/api/platform/audit?limit=1000&person=${g8marine.id}`)).body as Page;

  // Nobody wrote it: found by whom it is about.
  once(instance.rows, provisionedId, 'the Unit Instance trail');
  once(unit.rows, provisionedId, 'the unit’s access log');
  assert.equal(instance.rows.find((r) => r.id === provisionedId)!.actor_id, null);
  assert.equal(unit.rows.find((r) => r.id === provisionedId)!.actor_id, null);
  once(platform.rows, failedSignInId, 'the platform trail');
  assert.equal(platform.rows.find((r) => r.id === failedSignInId)!.actor_id, null);
  assert.ok(!instance.rows.some((r) => r.id === failedSignInId) && !platform.rows.some((r) => r.id === provisionedId), 'each only in the trail it is filed in');

  // They wrote it about themselves: once, not once from each branch.
  once(instance.rows, selfAboutId, 'the Unit Instance trail');
  once(unit.rows, selfAboutId, 'the unit’s access log');
  for (const rows of [instance.rows, unit.rows, platform.rows]) assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'no entry twice');

  // A page at a time, the same entries, each once.
  const paged: string[] = [];
  let before: number | null = null;
  for (let i = 0; i < 50; i++) {
    const res = await get(op.token, `/api/orgs/G8/audit?limit=1&person=${g8marine.id}${before ? `&before=${before}` : ''}`);
    paged.push(...(res.body as Page).rows.map((r) => r.id));
    before = (res.body as Page).next;
    if (!before) break;
  }
  assert.deepEqual(paged, instance.rows.map((r) => r.id));
  // And the file holds each once too.
  const file = await get(op.token, `/api/orgs/G8/audit/export?format=json&person=${g8marine.id}`);
  assert.equal(file.status, 200);
  for (const id of [provisionedId, selfAboutId]) assert.equal((file.body.rows as Row[]).filter((r) => r.id === id).length, 1);
});
