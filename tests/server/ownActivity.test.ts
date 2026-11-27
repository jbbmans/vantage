import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { audit } from '../../server/services/audit.ts';
import { auditActionsIn } from '../../shared/auditCatalog.ts';
import { apiAllowed } from '../../server/app.ts';

/**
 * A Marine's own activity (GET /api/me/activity): what they did, in every Unit Instance they did it in, and what
 * happened on their account with nobody signed in. Nothing anyone else did, no address, no other person's id, no unit
 * or Unit Instance field, no EDIPI. G8 is one Unit Instance and G1 another, and Dual serves in a team of each.
 */

type Person = { token: string; id: string };
type Row = { seq: number; id: string; at: string; action: string; category: string | null; entity: string | null; detail: string | null; by: 'you' | 'account' };
let app: TestApp;
let op: Person;
let g1lead: Person;
let dual: Person;
const ids: Record<string, string> = {};
/** The EDIPIs the entries below carry in their words: the card replaced, the one linked, and one presented that was not theirs. */
const EDIPIS = ['1234567890', '2234567891', '3234567892'];
/**
 * A person's id whose last group holds ten digits in a row. About one id in 120 that randomUUID makes is like it, and
 * read alone, those ten digits look like an EDIPI.
 */
const TEN_DIGITS_ID = '3f2a1b4c-5d6e-4f70-8a9b-c9876543210d';
/** The start of an id as Vantage makes one: none of it goes out in an entry's words. */
const ID_START = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const activity = async (token: string, query = '') => {
  const res = await get(token, `/api/me/activity${query ? `?${query}` : ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { rows: Row[]; next: number | null };
};
const head = () => (app.ctx.db.prepare('SELECT MAX(seq) AS seq FROM audit_log').get() as { seq: number }).seq;
const entry = (id: string) => app.ctx.db.prepare('SELECT actor_id, subject_id, unit_id, org_id, ip FROM audit_log WHERE id = ?').get(id) as { actor_id: string | null; subject_id: string | null; unit_id: string | null; org_id: string | null; ip: string | null };
/** An entry's words as the trail holds them, before anything is blanked or masked. */
const written = (id: string) => (app.ctx.db.prepare('SELECT detail FROM audit_log WHERE id = ?').get(id) as { detail: string | null }).detail ?? '';
/** Every user id there is: none of them is in what the reader is sent. */
const everyone = () => (app.ctx.db.prepare('SELECT id FROM users').all() as Array<{ id: string }>).map((u) => u.id);
const plan = (sql: string, ...params: unknown[]) =>
  (app.ctx.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');

/** Runs fn while noting the SQL of every statement prepared on the app's database. */
async function preparing<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const db = app.ctx.db;
  const prepare = db.prepare;
  const sql: string[] = [];
  db.prepare = ((text: string) => { sql.push(text); return prepare.call(db, text); }) as typeof db.prepare;
  try { return { result: await fn(), sql }; } finally { db.prepare = prepare; }
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  g1lead = await app.register('actg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('actg1lead');
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  assert.equal((await post(g1lead.token, '/api/org/units', { name: 'G1 Manpower', short_name: 'MANPOWER', code: 'manpower', parent_id: 'G1' })).status, 201);

  dual = await app.register('actdual');
  await enroll(app, op.token, 'FISCAL', dual.id);
  await enroll(app, g1lead.token, 'MANPOWER', dual.id);
  dual.token = await login('actdual');

  const made = async (token: string, path: string, body: unknown) => {
    const res = await post(token, path, body);
    assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  // Dual's own entries: one shared in each Unit Instance, and one kept private.
  ids.fiscal = await made(dual.token, '/api/records/activities', { title: 'Reconciled the travel ledger', date: '2026-09-01', visibility: 'unit', unit_id: 'FISCAL' });
  ids.manpower = await made(dual.token, '/api/records/activities', { title: 'Processed drill orders', date: '2026-09-02', visibility: 'unit', unit_id: 'MANPOWER' });
  ids.private = await made(dual.token, '/api/records/activities', { title: 'Studied for the board', date: '2026-09-03', visibility: 'private' });
  // A question Dual asks of G-8's leader: its entry is Dual's, and names the leader by id in its words.
  const asked = await post(dual.token, `/api/records/activities/${ids.fiscal}/requests`, { kind: 'clarification_request', addressee_id: op.id, body: 'Is this the right fund?' });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));

  // A leader of each Unit Instance opens Dual's entries, and G-8's opens Dual's page.
  assert.equal((await get(op.token, `/api/records/activities/${ids.fiscal}`)).status, 200);
  assert.equal((await get(g1lead.token, `/api/records/activities/${ids.manpower}`)).status, 200);
  assert.equal((await get(op.token, `/api/org/team/${dual.id}`)).status, 200);
  // Entries whose words name somebody by id: G-8's leader asks Dual a question, then hands FISCAL to a Marine whose id
  // holds ten digits in a row (which signs G-8's leader out), and Dual asks that Marine one.
  const toDual = await post(op.token, `/api/records/activities/${ids.fiscal}/requests`, { kind: 'clarification_request', addressee_id: dual.id, body: 'Which fund did this come from?' });
  assert.equal(toDual.status, 201, JSON.stringify(toDual.body));
  const at = new Date().toISOString();
  app.ctx.db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, rank_id, created_at, updated_at) VALUES (?, 'actten', 'x', 'Tenney', 'Marine', 'LCpl', ?, ?)").run(TEN_DIGITS_ID, at, at);
  await enroll(app, op.token, 'FISCAL', TEN_DIGITS_ID);
  const led = await post(op.token, '/api/orgs/G8/units/FISCAL/leader', { user_id: TEN_DIGITS_ID });
  assert.equal(led.status, 200, JSON.stringify(led.body));
  op.token = await login('boletz');
  const toLeader = await post(dual.token, `/api/records/activities/${ids.fiscal}/requests`, { kind: 'clarification_request', addressee_id: TEN_DIGITS_ID, body: 'Is this the right fund?' });
  assert.equal(toLeader.status, 201, JSON.stringify(toLeader.body));
  // Vantage support corrects the CAC linked to Dual's account, naming the card it replaced and the new one.
  audit(app.ctx, { actor_id: op.id, action: 'edipi_corrected', entity: 'user', entity_id: dual.id, subject_id: dual.id, detail: '1234567890 → 2234567891; wrong card linked; sessions revoked: 0', ip: '192.0.2.10' });

  // On the account with nobody signed in: a wrong password, a session Vantage ended, a password reset someone asked
  // for by name, and the lockout failed sign-ins set off (written as server/routes/auth.ts and server/auth/lockout.ts do).
  assert.equal((await app.login('actdual', 'not-the-password-at-all-0')).status, 401);
  audit(app.ctx, { actor_id: null, action: 'session_expired', entity: 'sessions', entity_id: 'abcdef12', subject_id: dual.id, detail: 'idle' });
  audit(app.ctx, { actor_id: dual.id, action: 'password_reset_requested', subject_id: dual.id, ip: '203.0.113.7' });
  audit(app.ctx, { actor_id: dual.id, action: 'login_lockout', ip: '198.51.100.4', detail: '10 consecutive failures (password); locked until 2026-11-26T12:00:00.000Z' });
  // A card presented to confirm it is them that was not theirs: the words carry that card's EDIPI.
  audit(app.ctx, { actor_id: dual.id, action: 'cac_step_up_refused', subject_id: dual.id, ip: '203.0.113.8', detail: 'cac_mismatch edipi=3234567892' });
  // Something nobody did on another account, and something nobody did on no account: neither is Dual's.
  audit(app.ctx, { actor_id: null, action: 'session_expired', entity: 'sessions', entity_id: 'fedcba21', subject_id: g1lead.id, detail: 'idle' });
  audit(app.ctx, { actor_id: null, action: 'login_failed', ip: '203.0.113.9', detail: 'password; no account has that name' });
});
after(async () => { await app.close(); });

test('a Marine sees what they did in both Unit Instances, and nothing a leader of either did about them', async () => {
  const { rows, next } = await activity(dual.token);
  assert.equal(next, null);
  assert.deepEqual(rows.map((r) => r.seq), [...rows.map((r) => r.seq)].sort((a, b) => b - a), 'newest first');
  const shown = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const e = entry(r.id);
    assert.ok(e.actor_id === dual.id || (e.actor_id === null && e.subject_id === dual.id), `${r.action} is Dual's, or on Dual's account with nobody signed in`);
  }

  // Each entry Dual made, in G-8, in G-1 and in no unit.
  const creates = app.ctx.db.prepare("SELECT id, entity_id, org_id FROM audit_log WHERE actor_id = ? AND action = 'create'").all(dual.id) as Array<{ id: string; entity_id: string; org_id: string | null }>;
  assert.deepEqual(new Set(creates.map((c) => c.entity_id)), new Set([ids.fiscal, ids.manpower, ids.private]));
  assert.ok(creates.every((c) => shown.has(c.id)), 'every entry Dual made shows');
  assert.deepEqual(new Set(creates.filter((c) => c.org_id).map((c) => c.org_id)), new Set(['G8', 'G1']), 'from both Unit Instances');
  // Every entry Dual wrote at all.
  const wrote = (app.ctx.db.prepare('SELECT id FROM audit_log WHERE actor_id = ?').all(dual.id) as Array<{ id: string }>).map((r) => r.id);
  assert.ok(wrote.every((id) => shown.has(id)), 'every entry Dual wrote, whatever its Unit Instance');
  assert.ok(rows.some((r) => r.action === 'login' && r.by === 'you'));
  assert.ok(rows.some((r) => r.action === 'request_sent' && r.by === 'you'));

  // What G-8's and G-1's leaders did about Dual: in who has looked at their record, never in their own activity.
  const byOthers = (app.ctx.db.prepare('SELECT id, action FROM audit_log WHERE subject_id = ? AND actor_id IS NOT NULL AND actor_id <> ?').all(dual.id, dual.id) as Array<{ id: string; action: string }>);
  assert.ok(byOthers.some((e) => e.action === 'view_record') && byOthers.some((e) => e.action === 'view_member') && byOthers.some((e) => e.action === 'edipi_corrected'));
  assert.ok(byOthers.every((e) => !shown.has(e.id)), 'nothing a leader of either Unit Instance did about Dual shows');
  const looked = (await get(dual.token, '/api/me/audit')).body.rows as Array<{ id: string }>;
  assert.ok(byOthers.every((e) => looked.some((l) => l.id === e.id)), 'and every one of them is where it belongs');
  // Nothing on another account, nor on none.
  const elsewhere = app.ctx.db.prepare("SELECT id FROM audit_log WHERE actor_id IS NULL AND (subject_id IS NULL OR subject_id <> ?)").all(dual.id) as Array<{ id: string }>;
  assert.ok(elsewhere.length >= 2 && elsewhere.every((e) => !shown.has(e.id)));

  // A leader's own activity holds what they did, and no entry of Dual's.
  const lead = await activity(op.token);
  assert.ok(lead.rows.some((r) => r.action === 'view_member' && r.by === 'you'));
  assert.ok(lead.rows.every((r) => entry(r.id).actor_id === op.id || entry(r.id).subject_id === op.id));
  assert.ok(!lead.rows.some((r) => wrote.includes(r.id)));
});

test('what happened on the account with nobody signed in is marked as on the account, and says where from to nobody', async () => {
  const { rows } = await activity(dual.token);
  const of = (action: string) => rows.filter((r) => r.action === action);
  assert.equal(of('login_failed').length, 1, 'the wrong password on Dual’s account, and not the one on no account');
  assert.equal(of('login_failed')[0].by, 'account');
  assert.equal(of('session_expired').length, 1);
  assert.equal(of('session_expired')[0].by, 'account');
  // Written with Dual as their actor, but anyone may have set them off from anywhere.
  assert.equal(of('password_reset_requested')[0].by, 'account');
  assert.equal(of('login_lockout')[0].by, 'account');
  assert.ok(of('login').every((r) => r.by === 'you'));
  assert.ok(of('create').every((r) => r.by === 'you'));
  assert.equal(of('cac_step_up_refused')[0].by, 'you');
});

test('no entry carries an address, another person’s id, or a unit or Unit Instance field, and an EDIPI is masked', async () => {
  const { rows } = await activity(dual.token);
  const sent = JSON.stringify(rows);
  for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ['action', 'at', 'by', 'category', 'detail', 'entity', 'id', 'seq']);
  const addresses = (app.ctx.db.prepare('SELECT DISTINCT ip FROM audit_log WHERE ip IS NOT NULL').all() as Array<{ ip: string }>).map((r) => r.ip);
  assert.ok(addresses.includes('203.0.113.7') && addresses.length >= 4);
  for (const ip of addresses) assert.ok(!sent.includes(ip), `no address: ${ip}`);
  // Nobody's id: not the leader the question named, not any other account, and not Dual's own.
  assert.match(String(rows.find((r) => r.action === 'request_sent')!.detail), /^comment …: clarification_request to …$/);
  // Nor any part of one: an id whose last group holds ten digits in a row is blanked whole, before an EDIPI is masked.
  const questions = rows.filter((r) => r.action === 'request_sent');
  assert.equal(questions.length, 2, 'the question to G-8’s leader and the one to FISCAL’s');
  assert.ok(questions.some((r) => written(r.id).endsWith(` to ${TEN_DIGITS_ID}`)), 'as written, one names FISCAL’s leader by id');
  for (const r of questions) assert.equal(r.detail, 'comment …: clarification_request to …');
  assert.doesNotMatch(rows.map((r) => r.detail ?? '').join(' '), ID_START);
  for (const part of [TEN_DIGITS_ID.slice(0, 23), '3210d', '9876543210']) assert.ok(!sent.includes(part), `no part of an id: ${part}`);
  for (const id of everyone()) assert.ok(!sent.includes(id), `no person's id: ${id}`);
  for (const id of [ids.fiscal, ids.manpower, ids.private]) assert.ok(!sent.includes(id), 'no record id either');
  // Dual's own entries name no unit in their words either; a leader's may (creating a unit names it), as the export's do.
  for (const unit of ['G8', 'G1', 'FISCAL', 'MANPOWER']) assert.ok(!sent.includes(`"${unit}"`) && !new RegExp(`\\b${unit}\\b`).test(sent), `no unit or Unit Instance: ${unit}`);
  assert.ok(!/hash|seal|ip|actor|subject|unit_id|org_id|username/.test(Object.keys(rows[0]).join(' ')));
  // The card's EDIPI goes out as its last four digits, as every screen shows one (ADR-0033).
  assert.equal(rows.find((r) => r.action === 'cac_step_up_refused')!.detail, 'cac_mismatch edipi=••••••7892');
  // An id may hold ten digits in a row; an entry's words never do, and no EDIPI is anywhere in what is sent.
  assert.doesNotMatch(rows.map((r) => r.detail ?? '').join(' '), /\d{10}/);
  for (const edipi of EDIPIS) assert.ok(!sent.includes(edipi), edipi);

  // A leader's activity names nobody by id either, though running a unit names people in its words: as written, G-8's
  // leader's entries name the Marine they asked and the one they handed FISCAL to, whose id holds ten digits in a row.
  const leadRows = (await activity(op.token, 'limit=1000')).rows;
  const named = leadRows.filter((r) => ID_START.test(written(r.id)));
  assert.ok(named.some((r) => written(r.id).includes(dual.id)), 'as written, a leader’s entry names Dual by id');
  assert.ok(named.some((r) => written(r.id).includes(TEN_DIGITS_ID)), 'and one names FISCAL’s new leader by id');
  assert.equal(leadRows.find((r) => r.action === 'request_sent')!.detail, 'comment …: clarification_request to …');
  assert.equal(leadRows.find((r) => r.action === 'unit_leader_set')!.detail, '… -> …');
  const leadWords = leadRows.map((r) => r.detail ?? '').join(' ');
  assert.doesNotMatch(leadWords, ID_START);
  assert.doesNotMatch(leadWords, /\d{10}/);
  const lead = JSON.stringify(leadRows);
  for (const part of [TEN_DIGITS_ID.slice(0, 23), '3210d', '9876543210']) assert.ok(!lead.includes(part), `no part of an id in a leader's activity: ${part}`);
  for (const id of everyone()) assert.ok(!lead.includes(id), `no person's id in a leader's activity: ${id}`);
});

test('who has looked at a Marine’s record masks an EDIPI in its words, and reads as it always has', async () => {
  const { rows } = (await get(dual.token, '/api/me/audit')).body as { rows: Array<{ action: string; detail: string | null }> };
  const corrected = rows.find((r) => r.action === 'edipi_corrected')!;
  assert.equal(corrected.detail, '••••••7890 → ••••••7891; wrong card linked; sessions revoked: 0');
  // This list's words keep their ids, and an id may hold ten digits in a row: look past the ids for an EDIPI.
  assert.doesNotMatch(rows.map((r) => (r.detail ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…')).join(' '), /\d{10}/);
  for (const edipi of EDIPIS) assert.ok(!JSON.stringify(rows).includes(edipi), edipi);
  // The query is the one the access log has always run, down the subject index.
  const seen = await preparing(() => get(dual.token, '/api/me/audit?limit=3'));
  const sql = seen.sql.find((s) => s.includes('WHERE al.subject_id = ? AND al.actor_id <> ? AND al.seq < ?'));
  assert.ok(sql, 'the access log’s own query');
  assert.match(plan(sql, dual.id, dual.id, 1e9, 4), /idx_audit_subject \(subject_id=\? AND seq<\?\)/);
});

test('no parameter reads somebody else’s activity, and reading one’s own writes nothing to the trail', async () => {
  const mark = head();
  const own = await activity(dual.token);
  for (const query of [`user=${op.id}`, `actor=${op.id}`, `user_id=${g1lead.id}`, `subject=${op.id}`, `q=view`, `unit=G8`, `org=G1`, `person=${op.id}`, `person=${g1lead.id}`]) {
    assert.deepEqual(await activity(dual.token, query), own, `${query} changes nothing`);
  }
  // A leader asking for Dual's gets their own.
  const asked = await activity(op.token, `user=${dual.id}&actor=${dual.id}`);
  assert.deepEqual(asked, await activity(op.token));
  assert.ok(asked.rows.every((r) => entry(r.id).actor_id !== dual.id));
  assert.equal(head(), mark, 'not one entry written by reading it');
  // Signed out, there is nobody's to read.
  assert.equal((await app.call('GET', '/api/me/activity')).status, 401);
  // Answered wherever the person signs in, as all of /api/me is: what is read is still only their own.
  for (const face of ['app', 'console', 'admin'] as const) assert.equal(apiAllowed(new Set([face]), '/me/activity'), true, face);
});

test('one’s own activity filters and pages as the audit trails do, down the two person indexes', async () => {
  const all = (await activity(dual.token)).rows;
  // A page at a time, back to the oldest, every entry once.
  const pages: Array<{ rows: Row[]; next: number | null }> = [];
  let before: number | null = null;
  do {
    pages.push(await activity(dual.token, `limit=2${before ? `&before=${before}` : ''}`));
    before = pages.at(-1)!.next;
  } while (before && pages.length < 100);
  assert.ok(pages.length > 3);
  assert.ok(pages.slice(0, -1).every((p) => p.rows.length === 2 && p.next === p.rows[1].seq));
  assert.equal(pages.at(-1)!.next, null);
  assert.deepEqual(pages.flatMap((p) => p.rows.map((r) => r.id)), all.map((r) => r.id));
  assert.equal(all.length, (await activity(dual.token, 'limit=1000')).rows.length);

  // By action, and by category: an entry the account had with nobody signed in is filtered as any other.
  const logins = (await activity(dual.token, 'action=login')).rows;
  assert.equal(logins.length, all.filter((r) => r.action === 'login').length);
  assert.ok(logins.length >= 1 && logins.every((r) => r.action === 'login'));
  assert.deepEqual((await activity(dual.token, 'action=session_expired')).rows.map((r) => r.by), ['account']);
  // The account's entries that nobody wrote are narrowed by category as well, not passed through.
  const expired = all.find((r) => r.action === 'session_expired')!;
  assert.equal(entry(expired.id).actor_id, null, 'read down the subject index');
  assert.ok(expired.category);
  assert.equal((app.ctx.db.prepare('SELECT category FROM audit_log WHERE id = ?').get(expired.id) as { category: string | null }).category, expired.category, 'sealed in that category');
  assert.ok((await activity(dual.token, `category=${expired.category}&limit=1000`)).rows.some((r) => r.id === expired.id));
  for (const other of ['user', 'unit', 'enterprise'].filter((c) => c !== expired.category)) {
    assert.ok(!(await activity(dual.token, `category=${other}&limit=1000`)).rows.some((r) => r.id === expired.id), other);
  }
  const lead = (await activity(op.token, 'limit=1000')).rows;
  for (const category of ['user', 'unit', 'enterprise']) {
    const only = (await activity(op.token, `category=${category}&limit=1000`)).rows;
    assert.ok(only.length > 0 && only.every((r) => r.category === category), category);
    assert.deepEqual(only.map((r) => r.id), lead.filter((r) => r.category === category).map((r) => r.id));
  }
  // By UTC day, under the one range rule (ADR-0038).
  const day = new Date().toISOString().slice(0, 10);
  assert.equal((await activity(dual.token, `from=${day}&to=${day}`)).rows.length, all.length);
  assert.equal((await activity(dual.token, 'from=2001-01-01&to=2001-01-31')).rows.length, 0);
  for (const bad of ['from=2026-11-20&to=2026-11-01', 'from=2026-11-01', 'from=2020-01-01&to=2026-01-01', 'from=2026-02-30&to=2026-03-01']) {
    const res = await get(dual.token, `/api/me/activity?${bad}`);
    assert.equal(res.status, 400, bad);
    assert.ok(res.body.fieldErrors?.from || res.body.fieldErrors?.to, `${bad}: said at the field`);
  }
  for (const bad of ['limit=0', 'limit=1001', 'limit=x', 'before=-1', 'before=x', 'category=everything']) assert.equal((await get(dual.token, `/api/me/activity?${bad}`)).status, 400, bad);

  // Each read walks one person index newest first: never the whole log, and never a sort.
  const seen = await preparing(() => get(dual.token, '/api/me/activity?before=1000000000'));
  const actor = seen.sql.find((s) => s.includes('INDEXED BY idx_audit_actor'))!;
  const subject = seen.sql.find((s) => s.includes('INDEXED BY idx_audit_subject'))!;
  assert.ok(actor && subject, 'one read down each index');
  const actorPlan = plan(actor, dual.id, 1e9, 101);
  const subjectPlan = plan(subject, dual.id, 1e9, 101);
  assert.match(actorPlan, /idx_audit_actor \(actor_id=\? AND seq<\?\)/);
  assert.match(subjectPlan, /idx_audit_subject \(subject_id=\? AND seq<\?\)/);
  for (const p of [actorPlan, subjectPlan]) assert.doesNotMatch(p, /TEMP B-TREE|SCAN al\b/);
  const filtered = await preparing(() => get(dual.token, '/api/me/activity?category=user&before=1000000000'));
  const filteredActor = filtered.sql.find((s) => s.includes('INDEXED BY idx_audit_actor'))!;
  const filteredPlan = plan(filteredActor, dual.id, 'user', ...auditActionsIn('user'), 1e9, 101);
  assert.match(filteredPlan, /idx_audit_actor \(actor_id=\? AND seq<\?\)/);
  assert.doesNotMatch(filteredPlan, /TEMP B-TREE|SCAN al\b/);
});
