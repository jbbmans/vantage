import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { expireNotifications, notify, UNREAD_COUNTED } from '../../server/services/notifications.ts';
import { purgeDeleted } from '../../server/services/records.ts';
import { placeHold, releaseHold } from '../../server/services/retention.ts';
import {
  MUTABLE_GROUPS, NOTICE_GROUPS, NOTICE_KINDS, NOTICE_KIND_NAMES, NOTICE_RETENTION_DAYS, isNoticeKind,
  type NoticeKind, type NoticeRow, type NoticesResponse,
} from '../../shared/notifications.ts';
import { REQUEST_KINDS } from '../../shared/workflowMessages.ts';

/**
 * Task 24 (ADR-0031): what Vantage tells a person. Every kind is in the catalogue; a kind that coalesces keeps one unread
 * notice per record; nobody is told about what they did, nor anybody no longer active, nor about a group they turned off
 * (only discussion, work updates and announcements may be). Each notice is checked again when it is read, so one about a
 * record its reader can no longer open is neither shown nor counted, and a notice about a record never carries anybody's
 * words. Notices page, filter and mark read only as their own person; they go with a destroyed record, follow a moved
 * one, and are kept 180 days unless a hold keeps them.
 */

let app: TestApp;
type Person = { token: string; id: string };
let op: Person & { unitId: string };
/** A Marine of G-8. */
let rivera: Person;
/** An SNCO of G-8: reads shared records and reviews duty. */
let nguyen: Person;
/** An NCO of G-8, who reads shared records: leaves G-8 part way through. */
let kim: Person;
/** A fire team leader: counsels Diaz. */
let lopez: Person;
/** The Marine Lopez counsels. */
let diaz: Person;
/** Turns the discussion group off. */
let muter: Person;
/** Whose notices are paged. */
let pager: Person;
/** Whose notices are filtered and marked read by group. */
let sorter: Person;
/** An NCO of G-8, turned off part way through. */
let gone: Person;
/** Lead Unit Manager of a second Unit Instance, G-1, and one of its members. */
let g1lead: Person;
let g1member: Person;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}, headers?: Record<string, string>) => app.call('POST', path, { token, body, headers });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;

interface StoredNotice {
  id: string; user_id: string; kind: string; title: string; message: string | null; action_url: string | null; dedupe_key: string | null;
  read_at: string | null; created_at: string; org_id: string | null; entity: string | null; entity_id: string | null; actor_id: string | null; count: number | null;
}
/** A person's notices as they are stored, oldest first. */
const storedFor = (userId: string) => app.ctx.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at, rowid').all(userId) as StoredNotice[];
const storedAbout = (userId: string, entityId: string) => storedFor(userId).filter((n) => n.entity_id === entityId);
const storedUnread = (userId: string) => storedFor(userId).filter((n) => !n.read_at).length;

/** What GET /api/me/notifications gives this person. */
async function inbox(who: Person, query = ''): Promise<NoticesResponse> {
  const res = await get(who.token, `/api/me/notifications${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as NoticesResponse;
}
const linkedTo = (list: NoticesResponse, url: string) => list.rows.filter((n) => n.action_url === url);

async function made(token: string, table: string, body: Record<string, unknown>) {
  const res = await post(token, `/api/records/${table}`, body);
  assert.equal(res.status, 201, `${table}: ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
/** A task shared with the unit: set by someone who may share work there. */
const task = (token: string, title: string, extra: Record<string, unknown> = {}) => made(token, 'tasks', { title, visibility: 'unit', ...extra });
/** A Marine's own entry, shared with G-8. */
const entry = (token: string, title: string) => made(token, 'activities', { title, date: '2026-05-01', quantity: 1, visibility: 'unit', unit_id: 'G8' });
async function say(token: string, table: string, id: string, body: string) {
  const res = await post(token, `/api/records/${table}/${id}/comments`, { body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}
async function ask(token: string, path: string, kind: string, addresseeId: string, body: string) {
  const res = await post(token, `${path}/requests`, { kind, addressee_id: addresseeId, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}
const day = (n: number) => { const d = new Date(`${today()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** A counseling Lopez writes for Diaz, in draft unless the test says otherwise. */
const counseling = (summary = 'Discussed the reconciliation backlog and the close-out timeline.', extra: Record<string, unknown> = {}) => made(lopez.token, 'counselings', {
  user_id: diaz.id, type: 'quarterly', date: day(-3), summary, strengths: 'Owned the UMT clean-up.', improvements: 'Brief the section chief earlier.',
  goals_set: 'Clear the remaining UMTs.', follow_up_date: day(27), visibility: 'unit', unit_id: 'G8', stage: 'draft', ...extra,
});

/** A work case in G-8, shared with the unit. */
async function workCase(reference: string) {
  const res = await post(op.token, '/api/work/items', { unit_id: 'G8', title: 'Synthetic notice test case', reference });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; version: number };
}
const caseVersion = async (id: string) => (await get(op.token, `/api/work/items/${id}`)).body.item.version as number;

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  const person = async (username: string, profile: Record<string, unknown>, roleKey?: string, unit = 'G8') => {
    const p = await app.register(username, profile);
    if (unit) await enroll(app, op.token, unit, p.id, roleKey);
    return { id: p.id, token: await login(username) };
  };
  rivera = await person('rivera', { rank_id: 'Cpl', last_name: 'Rivera' });
  nguyen = await person('nguyen', { rank_id: 'SSgt', last_name: 'Nguyen' }, 'snco');
  kim = await person('kim', { rank_id: 'Cpl', last_name: 'Kim' }, 'nco');
  lopez = await person('lopez', { rank_id: 'Sgt', last_name: 'Lopez' }, 'fire-team-leader');
  diaz = await person('diaz', { rank_id: 'Cpl', last_name: 'Diaz' });
  muter = await person('muter', { rank_id: 'LCpl', last_name: 'Mute' });
  pager = await person('pager', { rank_id: 'LCpl', last_name: 'Page' });
  sorter = await person('sorter', { rank_id: 'LCpl', last_name: 'Sort' });
  gone = await person('gone', { rank_id: 'Cpl', last_name: 'Gone' }, 'nco');
  const lead = await app.register('g1lead', { rank_id: 'Maj', last_name: 'Lead' });
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id })).status, 201);
  g1lead = { id: lead.id, token: await login('g1lead') };
  const member = await app.register('g1member', { rank_id: 'Cpl', last_name: 'Member' });
  await enroll(app, g1lead.token, 'G1', member.id);
  g1member = { id: member.id, token: await login('g1member') };

  // Duty in G-8: a DNCO worth three points, as a unit's own scoring policy says.
  const at = '2025-12-20T00:00:00.000Z';
  app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)').run('nt-dnco', 'G8', 'DNCO', 'Duty NCO', at, at);
  app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('nt-v1', 'G8', 1, '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: 'nt-dnco', method: 'fixed', points: 3, bands: null }], multipliers: [], combine: 'highest' }), 'First policy', op.id, at);
});
after(async () => { await app.close(); });

// ---------------------------------------------------------------------------------------------------------------------
// The catalogue

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const NOTIFIERS = new Set(['notify', 'notifyOrg', 'notifyStaff']);

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = join(dir, name);
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) out.push(path);
    }
  };
  walk('server');
  return out;
}

/**
 * Every call to notify, notifyOrg or notifyStaff in the server, and the kinds its payload can name: the string literals
 * its `kind` can take, through any conditional, and the text of any other expression. notifications.ts itself, where the
 * three are defined and hand a payload on as given, is left out.
 */
function noticeCalls() {
  const calls: Array<{ at: string; named: boolean; kinds: string[]; dynamic: string[] }> = [];
  for (const file of serverSources()) {
    if (file === join('server', 'services', 'notifications.ts')) continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (!/\bnotify(?:Org|Staff)?\(/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && NOTIFIERS.has(node.expression.text)) {
        const kinds: string[] = [];
        const dynamic: string[] = [];
        let named = false;
        const value = (e: ts.Expression): void => {
          if (ts.isStringLiteralLike(e)) kinds.push(e.text);
          else if (ts.isConditionalExpression(e)) { value(e.whenTrue); value(e.whenFalse); }
          else if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) value(e.expression);
          else dynamic.push(e.getText(source));
        };
        const payload = (e: ts.Expression): void => {
          if (ts.isObjectLiteralExpression(e)) {
            for (const p of e.properties) {
              if (ts.isPropertyAssignment(p) && p.name.getText(source) === 'kind') { named = true; value(p.initializer); }
              else if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'kind') { named = true; dynamic.push('kind'); }
            }
          } else if (ts.isConditionalExpression(e)) { payload(e.whenTrue); payload(e.whenFalse); }
          else if (ts.isParenthesizedExpression(e)) payload(e.expression);
        };
        node.arguments.forEach(payload);
        calls.push({ at: `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`, named, kinds, dynamic });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

test('the catalogue: every kind the server sends is in it, each in a group, and it names nothing nothing sends', () => {
  const calls = noticeCalls();
  assert.ok(calls.length > 50, `the scan finds the server's call sites (${calls.length})`);
  assert.deepEqual(calls.filter((c) => !c.named).map((c) => c.at), [], 'every call names its kind where it is made');
  const unknown = calls.flatMap((c) => c.kinds.filter((k) => !isNoticeKind(k)).map((k) => `${c.at}: ${k}`));
  assert.deepEqual(unknown, [], 'every kind sent is in shared/notifications.ts');
  // The one kind not written out: a request's own kind, which is a notice kind of the same name.
  assert.deepEqual(calls.flatMap((c) => c.dynamic.map((d) => `${c.at.replace(/:\d+$/, '')}: ${d}`)), ['server/services/comments.ts: input.kind']);
  for (const kind of REQUEST_KINDS) assert.ok(isNoticeKind(kind), kind);

  const sent = new Set([...calls.flatMap((c) => c.kinds), ...REQUEST_KINDS]);
  assert.deepEqual(NOTICE_KIND_NAMES.filter((k) => !sent.has(k)), [], 'the catalogue names no kind that nothing sends');
  for (const kind of NOTICE_KIND_NAMES) assert.ok((NOTICE_GROUPS as readonly string[]).includes(NOTICE_KINDS[kind].group), kind);
  // Only a comment's notice coalesces: requests, security, operations and team messages are each their own notice.
  assert.deepEqual(NOTICE_KIND_NAMES.filter((k) => 'coalesce' in NOTICE_KINDS[k]).sort(), ['comment_added', 'counseling_comment']);
  assert.deepEqual([...MUTABLE_GROUPS], ['discussion', 'work', 'announcements']);
});

test('notify() refuses a kind the catalogue does not name, and a coalescing kind without its record or with a dedupe key', () => {
  const before = storedFor(rivera.id).length;
  assert.throws(() => notify(app.ctx, rivera.id, { kind: 'chat' as NoticeKind, title: 'Hello' }), /Unknown notice kind "chat"/);
  assert.throws(() => notify(app.ctx, rivera.id, { kind: 'comment_added', title: 'Commented' }), /coalesces per record/);
  assert.throws(() => notify(app.ctx, rivera.id, { kind: 'comment_added', title: 'Commented', entity: 'tasks', entityId: 'x', dedupeKey: 'k' }), /coalesces per record/);
  assert.throws(() => notify(app.ctx, rivera.id, { kind: 'unit', title: 'Half a record', entity: 'tasks' }), /table and its id together/);
  assert.equal(storedFor(rivera.id).length, before, 'nothing was written');
});

// ---------------------------------------------------------------------------------------------------------------------
// Who is told, and how often

test('three comments on one record are one unread notice standing for three; once it is read, the next starts another', async () => {
  const t = await task(nguyen.token, 'Reconcile the October UMTs');
  const url = `/records/tasks/${t.id}`;
  for (const n of [1, 2, 3]) await say(op.token, 'tasks', t.id, `Batch ${n} of the rows is done.`);

  const stored = storedAbout(nguyen.id, t.id);
  assert.equal(stored.length, 1, 'one row, however many comments');
  assert.equal(stored[0].kind, 'comment_added');
  assert.equal(stored[0].count, 3);
  assert.equal(stored[0].dedupe_key, null);
  assert.equal(stored[0].read_at, null);
  assert.equal(stored[0].message, null);

  const listed = linkedTo(await inbox(nguyen), url);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, `3 ${NOTICE_KINDS.comment_added.many}`);
  assert.equal(listed[0].count, 3);
  assert.equal(listed[0].group, 'discussion');
  assert.equal(listed[0].label, 'Reconcile the October UMTs', 'named by its record, read now');
  assert.equal(listed[0].message, null);
  assert.equal(listed[0].org_name !== null, true, 'with its Unit Instance');

  assert.equal((await put(nguyen.token, `/api/me/notifications/${listed[0].id}/read`)).status, 200);
  await say(op.token, 'tasks', t.id, 'One more thing on the last batch.');
  const again = storedAbout(nguyen.id, t.id);
  assert.equal(again.length, 2, 'a read notice is not added to');
  assert.deepEqual(again.map((n) => [n.count, Boolean(n.read_at)]), [[3, true], [1, false]]);
  const fresh = linkedTo(await inbox(nguyen), url).find((n) => !n.read_at)!;
  assert.match(fresh.title, /commented$/, 'one comment is said as one');
  assert.equal(fresh.count, 1);
});

test('nobody is told about what they did themselves', async () => {
  const t = await task(nguyen.token, 'Own words');
  await say(nguyen.token, 'tasks', t.id, 'A note to myself.');
  assert.equal(storedAbout(nguyen.id, t.id).length, 0);
  await say(op.token, 'tasks', t.id, 'Seen it.');
  await say(nguyen.token, 'tasks', t.id, 'Thanks.');
  assert.equal(storedAbout(op.id, t.id).length, 1, 'someone who has spoken hears what follows');
  assert.deepEqual(storedAbout(nguyen.id, t.id).map((n) => n.count), [1], 'and its author hears only the others');
  assert.equal(notify(app.ctx, rivera.id, { kind: 'unit', title: 'You did this', actorId: rivera.id }), false);
});

test('a person no longer active is not told', async () => {
  const t = await task(nguyen.token, 'Inactive check');
  await say(gone.token, 'tasks', t.id, 'I was here.');
  await say(op.token, 'tasks', t.id, 'Thanks for looking.');
  const before = storedFor(gone.id).map((n) => [n.kind, n.entity_id, n.count]);
  assert.deepEqual(before, [['comment_added', t.id, 1]], 'active, they hear what follows what they said');

  app.ctx.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(gone.id);
  const named = await say(op.token, 'tasks', t.id, 'Following up on this, @gone.');
  assert.deepEqual(named.not_told, ['@gone']);
  assert.deepEqual(storedFor(gone.id).map((n) => [n.kind, n.entity_id, n.count]), before, 'neither as one who spoke nor as one named');
  assert.deepEqual(storedAbout(nguyen.id, t.id).map((n) => n.count), [3], 'its Marine still is');
  assert.equal(notify(app.ctx, gone.id, { kind: 'unit', title: 'Added to a unit' }), false);
  assert.deepEqual(storedFor(gone.id).map((n) => [n.kind, n.entity_id, n.count]), before);
});

test('a person may turn discussion off; mentions and requests still arrive, and a group that may not be turned off cannot be', async () => {
  const saved = await put(muter.token, '/api/me/prefs', { notifications: { muted: ['discussion'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.notifications, { muted: ['discussion'] });
  for (const group of ['security', 'asked', 'mentions', 'decisions', 'unit', 'operations', 'nonsense']) {
    const refused = await put(muter.token, '/api/me/prefs', { notifications: { muted: [group] } });
    assert.equal(refused.status, 400, `${group} cannot be turned off`);
  }
  assert.deepEqual((await get(muter.token, '/api/me/prefs')).body.notifications, { muted: ['discussion'] }, 'a refused change changes nothing');

  const t = await entry(muter.token, 'Muted discussion');
  const path = `/api/records/activities/${t.id}`;
  await say(op.token, 'activities', t.id, 'Looked at the totals.');
  assert.deepEqual(storedAbout(muter.id, t.id).map((n) => n.kind), [], 'a comment is not');
  await say(op.token, 'activities', t.id, '@muter can you confirm the totals?');
  await ask(op.token, path, 'review_request', muter.id, 'Please review the totals before Friday.');
  assert.deepEqual(storedAbout(muter.id, t.id).map((n) => n.kind), ['comment_mention', 'review_request']);
  const listed = linkedTo(await inbox(muter), `/records/${t.id}`);
  assert.deepEqual(listed.map((n) => n.group).sort(), ['asked', 'mentions']);

  // Even a preference written some other way cannot silence a group that always arrives.
  app.ctx.db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify({ notifications: { muted: ['security', 'discussion'] } }), muter.id);
  assert.equal(notify(app.ctx, muter.id, { kind: 'security', title: 'Your second factor was reset' }), true);
  assert.equal(notify(app.ctx, muter.id, { kind: 'comment_added', title: 'Commented', entity: 'activities', entityId: t.id }), false);

  // Turned on again, comments arrive again.
  assert.equal((await put(muter.token, '/api/me/prefs', { notifications: { muted: [] } })).status, 200);
  await say(op.token, 'activities', t.id, 'Totals confirmed.');
  assert.deepEqual(storedAbout(muter.id, t.id).map((n) => n.kind), ['comment_mention', 'review_request', 'comment_added']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Checked again when read

test('a notice about a record deleted since is neither listed nor counted', async () => {
  const t = await entry(rivera.token, 'Deleted later');
  const url = `/records/${t.id}`;
  await say(op.token, 'activities', t.id, 'Checking on this, @nguyen.');
  const before = await inbox(nguyen);
  const shown = linkedTo(before, url);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].label, 'Deleted later');
  assert.equal(shown[0].read_at, null);

  assert.equal((await del(rivera.token, `/api/records/activities/${t.id}`)).status, 200);
  const afterIt = await inbox(nguyen);
  assert.deepEqual(linkedTo(afterIt, url), []);
  assert.equal(afterIt.unread, before.unread - 1);
  assert.equal(storedAbout(nguyen.id, t.id).length, 1, 'kept, unshown, until the record is destroyed');
});

test('a notice about a unit record is hidden from someone who left the unit', async () => {
  const t = await task(nguyen.token, 'Shared with the section');
  const url = `/records/tasks/${t.id}`;
  await say(op.token, 'tasks', t.id, 'Over to @kim for the second column.');
  const before = await inbox(kim);
  assert.equal(linkedTo(before, url).length, 1);

  const removed = await del(op.token, `/api/org/units/G8/members/${kim.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  kim.token = await login('kim');
  const afterIt = await inbox(kim);
  assert.deepEqual(linkedTo(afterIt, url), []);
  assert.equal(afterIt.unread, before.unread - 1);
});

test('a counseling taken back to draft takes its notice out of its Marine’s list', async () => {
  const c = await counseling();
  const url = `/career/counseling?open=${c.id}`;
  const shared = await post(lopez.token, `/api/records/counselings/${c.id}/share`, { version: c.version });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  const before = await inbox(diaz);
  const shown = linkedTo(before, url);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'counseling');
  assert.match(String(shown[0].label), /counseling/i);

  const back = await post(lopez.token, `/api/records/counselings/${c.id}/withdraw`, { version: shared.body.version });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const afterIt = await inbox(diaz);
  assert.deepEqual(linkedTo(afterIt, url), []);
  assert.equal(afterIt.unread, before.unread - 1);
});

test('a notice about a work case that went private is hidden from a unit member who is not its owner or holder', async () => {
  const item = await workCase('SYN-PRIVATE-1');
  const url = `/work/items/${item.id}`;
  await ask(op.token, `/api/work/items/${item.id}`, 'clarification_request', rivera.id, 'Which document number does this match?');
  const before = await inbox(rivera);
  const shown = linkedTo(before, url);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'clarification_request');
  assert.equal(shown[0].label, 'SYN-PRIVATE-1');
  assert.equal(shown[0].message, null);

  // Nothing in the API makes a shared case private today; the re-check must still hold if anything does.
  app.ctx.db.prepare("UPDATE work_items SET visibility = 'private' WHERE id = ?").run(item.id);
  const afterIt = await inbox(rivera);
  assert.deepEqual(linkedTo(afterIt, url), []);
  assert.equal(afterIt.unread, before.unread - 1);
});

test('the unread count is the list’s: hidden notices are not counted', async () => {
  let hiddenSomewhere = false;
  for (const who of [nguyen, rivera, kim, diaz, muter]) {
    const all = await inbox(who, '?limit=100');
    assert.ok(all.rows.length < 100 && all.next_cursor === null, 'the whole list fits on one page');
    const unread = await inbox(who, '?filter=unread&limit=100');
    assert.equal(all.unread, all.rows.filter((n) => !n.read_at).length);
    assert.equal(unread.unread, unread.rows.length);
    assert.ok(unread.rows.every((n) => !n.read_at));
    if (storedUnread(who.id) > all.unread) hiddenSomewhere = true;
  }
  assert.ok(hiddenSomewhere, 'some unread notices are stored but no longer shown');
});

test('the unread count reaches past many newer notices about a record its reader no longer opens', async () => {
  const p = await app.register('counted', { rank_id: 'LCpl', last_name: 'Count' });
  await enroll(app, op.token, 'G8', p.id);
  const who = { id: p.id, token: await login('counted') };
  const hidden = await made(rivera.token, 'tasks', { title: 'Not theirs', visibility: 'private' });
  const own = await made(who.token, 'tasks', { title: 'Their own', visibility: 'private' });
  const at = (s: number) => new Date(Date.now() - 3_600_000 + s * 1000).toISOString();
  const insert = app.ctx.db.prepare('INSERT INTO notifications (id, user_id, kind, title, dedupe_key, created_at, entity, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  app.ctx.db.transaction(() => {
    insert.run('nt-cap-own', who.id, 'comment_mention', 'Somebody mentioned you', 'nt-cap-own', at(0), 'tasks', own.id);
    for (let i = 1; i <= UNREAD_COUNTED; i++) insert.run(`nt-cap-${i}`, who.id, 'comment_mention', 'Somebody mentioned you', `nt-cap-${i}`, at(i), 'tasks', hidden.id);
  })();
  const unread = await inbox(who, '?filter=unread');
  assert.deepEqual(unread.rows.map((n) => n.id), ['nt-cap-own'], `the list reads past the ${UNREAD_COUNTED} newer ones`);
  assert.equal(unread.unread, 1, 'and so does the count');
  assert.equal((await inbox(who)).unread, 1);
  assert.equal((await inbox(who, '?group=mentions')).unread, 1, 'and its group\u2019s count');

  // Once as many as are counted may be opened, the count stops there.
  app.ctx.db.prepare('UPDATE notifications SET entity_id = ? WHERE user_id = ? AND id <> ?').run(own.id, who.id, 'nt-cap-own');
  assert.equal((await inbox(who)).unread, UNREAD_COUNTED);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading the list

test('paging: next_cursor walks the whole list once, newest first, past notices no longer shown', async () => {
  const hidden = await made(rivera.token, 'tasks', { title: 'Not the pager’s', visibility: 'private' });
  for (let i = 0; i < 10; i++) {
    if (i % 3 === 1) notify(app.ctx, pager.id, { kind: 'comment_mention', title: 'Somebody mentioned you', entity: 'tasks', entityId: hidden.id, dedupeKey: `nt-page-${i}` });
    else notify(app.ctx, pager.id, { kind: 'unit', title: `Notice ${i}`, message: `Unit message ${i}` });
  }
  // Two at each moment, so a page boundary falls between notices of the same time.
  const base = Date.now() - 3_600_000;
  storedFor(pager.id).forEach((n, i) => app.ctx.db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(new Date(base + Math.floor(i / 2) * 1000).toISOString(), n.id));
  const expected = (app.ctx.db.prepare('SELECT id FROM notifications WHERE user_id = ? AND entity IS NULL ORDER BY created_at DESC, id DESC').all(pager.id) as Array<{ id: string }>).map((n) => n.id);
  assert.equal(expected.length, 7);

  const walk = async (query: string, limit: number) => {
    const seen: NoticeRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await inbox(pager, `?limit=${limit}${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      assert.ok(page.rows.length <= limit);
      seen.push(...page.rows);
      cursor = page.next_cursor;
      assert.ok(++pages <= 10, 'the walk ends');
    } while (cursor);
    return { seen, pages };
  };
  const all = await walk('', 3);
  assert.deepEqual(all.seen.map((n) => n.id), expected, 'every notice once, in order');
  assert.equal(new Set(all.seen.map((n) => n.id)).size, all.seen.length, 'no duplicates across pages');
  assert.equal(all.pages, 3);
  assert.ok(all.seen.every((n) => n.kind === 'unit'), 'none of those about a record its reader cannot open');
  assert.ok(all.seen.every((n) => n.message?.startsWith('Unit message')), 'a notice about no record keeps its message');

  const exact = await walk('', 7);
  assert.equal(exact.pages, 1, 'a page that holds the rest says there is no more');

  for (const id of expected.slice(1, 3)) assert.equal((await put(pager.token, `/api/me/notifications/${id}/read`)).status, 200);
  const unread = await walk('&filter=unread', 2);
  assert.deepEqual(unread.seen.map((n) => n.id), expected.filter((_, i) => i !== 1 && i !== 2));
  assert.equal(unread.pages, 3);
  assert.equal((await inbox(pager)).unread, 5);
});

test('limit is a whole number from 1 to 100, and the other parameters are checked', async () => {
  for (const limit of ['2.5', '0', '101', '-1', 'ten', '1e3']) {
    assert.equal((await get(pager.token, `/api/me/notifications?limit=${limit}`)).status, 400, `limit=${limit}`);
  }
  const one = await inbox(pager, '?limit=1');
  assert.equal(one.rows.length, 1);
  assert.ok(one.next_cursor);
  assert.equal((await get(pager.token, '/api/me/notifications?limit=100')).status, 200);
  assert.equal((await get(pager.token, '/api/me/notifications?filter=everything')).status, 400);
  assert.equal((await get(pager.token, '/api/me/notifications?group=chat')).status, 400);
  assert.equal((await get(pager.token, `/api/me/notifications?cursor=${'x'.repeat(201)}`)).status, 400);
  assert.equal((await post(pager.token, '/api/me/notifications/read-all', { group: 'chat' })).status, 400);
});

/** Sorter's notices: a mention, a comment, a review request and a unit notice, all unread. */
async function sorterNotices() {
  const t = await entry(sorter.token, 'Sorted notices');
  await say(op.token, 'activities', t.id, 'Looked it over.');
  await say(op.token, 'activities', t.id, 'One question for @sorter.');
  await ask(op.token, `/api/records/activities/${t.id}`, 'review_request', sorter.id, 'Review the totals, please.');
  notify(app.ctx, sorter.id, { kind: 'unit', title: 'Added to a unit', message: 'Sign in again to see it.' });
  return t;
}

test('filter=unread and group= narrow the list to what was asked for', async () => {
  await sorterNotices();
  const all = await inbox(sorter);
  assert.deepEqual(all.rows.map((n) => n.group).sort(), ['asked', 'discussion', 'mentions', 'unit']);
  for (const group of ['asked', 'discussion', 'mentions', 'unit'] as const) {
    const only = await inbox(sorter, `?group=${group}`);
    assert.equal(only.rows.length, 1, group);
    assert.ok(only.rows.every((n) => n.group === group));
  }
  assert.deepEqual((await inbox(sorter, '?group=security')).rows, []);

  const mention = all.rows.find((n) => n.kind === 'comment_mention')!;
  assert.equal((await put(sorter.token, `/api/me/notifications/${mention.id}/read`)).status, 200);
  const unread = await inbox(sorter, '?filter=unread');
  assert.deepEqual(unread.rows.map((n) => n.kind).sort(), ['comment_added', 'review_request', 'unit']);
  assert.deepEqual((await inbox(sorter, '?filter=unread&group=mentions')).rows, []);
  assert.equal((await inbox(sorter, '?group=mentions')).rows[0].read_at !== null, true, 'all of a group, read or not');
});

test('the unread count of a list narrowed to a group counts that group', async () => {
  // shared/notifications.ts: "Unread notices this person may still open, counted as the list is filtered". The notices
  // page enables "Mark all read" for a group from it.
  const everything = await inbox(sorter);
  assert.ok(everything.unread >= 3);
  assert.equal((await inbox(sorter, '?group=mentions')).unread, 0, 'the mention is read');
  assert.equal((await inbox(sorter, '?group=asked')).unread, 1);
  assert.equal((await inbox(sorter, '?group=security&filter=unread')).unread, 0);
});

test('a person marks only their own notices read', async () => {
  const theirs = (await inbox(nguyen)).rows.find((n) => !n.read_at);
  assert.ok(theirs, 'Nguyen has an unread notice');
  assert.equal((await put(rivera.token, `/api/me/notifications/${theirs.id}/read`)).status, 404, 'another person’s is no such notice');
  assert.equal(storedFor(nguyen.id).find((n) => n.id === theirs.id)!.read_at, null);
  assert.equal((await put(rivera.token, '/api/me/notifications/no-such-notice/read')).status, 404);

  assert.equal((await put(nguyen.token, `/api/me/notifications/${theirs.id}/read`)).status, 200);
  const at = storedFor(nguyen.id).find((n) => n.id === theirs.id)!.read_at;
  assert.ok(at);
  assert.equal((await put(nguyen.token, `/api/me/notifications/${theirs.id}/read`)).status, 200, 'again is fine');
  assert.equal(storedFor(nguyen.id).find((n) => n.id === theirs.id)!.read_at, at, 'and keeps when it was first read');
});

test('mark all read, by group or all at once, and only for the person asking', async () => {
  const nguyenUnread = storedUnread(nguyen.id);
  const discussion = await post(sorter.token, '/api/me/notifications/read-all', { group: 'discussion' });
  assert.equal(discussion.status, 200, JSON.stringify(discussion.body));
  assert.equal(discussion.body.updated, 1);
  const after = await inbox(sorter, '?filter=unread');
  assert.deepEqual(after.rows.map((n) => n.kind).sort(), ['review_request', 'unit']);

  const rest = await post(sorter.token, '/api/me/notifications/read-all', {});
  assert.equal(rest.body.updated, 2);
  assert.equal((await inbox(sorter)).unread, 0);
  assert.equal(storedUnread(sorter.id), 0);
  assert.equal(storedUnread(nguyen.id), nguyenUnread, 'nobody else’s');
  assert.equal((await post(sorter.token, '/api/me/notifications/read-all', {})).body.updated, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Where notices go with their records

test('a record destroyed takes its notices with it', async () => {
  const t = await entry(rivera.token, 'Purged with its notices');
  await say(op.token, 'activities', t.id, 'Noted, @nguyen.');
  assert.equal(storedAbout(nguyen.id, t.id).length, 1);
  assert.equal(storedAbout(rivera.id, t.id).length, 1);
  assert.equal((await del(rivera.token, `/api/records/activities/${t.id}`)).status, 200);
  app.ctx.db.prepare('UPDATE activities SET deleted_at = ? WHERE id = ?').run(ago(31), t.id);
  const purged = purgeDeleted(app.ctx);
  assert.ok(purged.records >= 1, JSON.stringify(purged));
  assert.equal(app.ctx.db.prepare('SELECT 1 FROM activities WHERE id = ?').get(t.id), undefined);
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE entity = 'activities' AND entity_id = ?").get(t.id) as { n: number }).n, 0);
});

test('a moved record’s notices follow it, open it where it is now, and still coalesce', async () => {
  const source = await made(rivera.token, 'activities', { title: 'Received the Navy and Marine Corps Achievement Medal', date: '2026-05-01', quantity: 1, visibility: 'unit', unit_id: 'G8' });
  await say(nguyen.token, 'activities', source.id, 'Well earned.');
  assert.equal(linkedTo(await inbox(rivera), `/records/${source.id}`).length, 1);

  const moved = await post(rivera.token, `/api/records/activities/${source.id}/move`, { to: 'awards', version: source.version });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const awardId = moved.body.id as string;
  assert.deepEqual(storedAbout(rivera.id, source.id), [], 'nothing names the old entry');
  const followed = storedAbout(rivera.id, awardId);
  assert.equal(followed.length, 1);
  assert.equal(followed[0].entity, 'awards');

  const url = `/career/awards?open=${awardId}`;
  const shown = linkedTo(await inbox(rivera), url);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].label, moved.body.record.name);
  assert.equal(linkedTo(await inbox(rivera), `/records/${source.id}`).length, 0);

  await say(nguyen.token, 'awards', awardId, 'Citation is in.');
  assert.deepEqual(storedAbout(rivera.id, awardId).map((n) => n.count), [2], 'the next comment adds to it');
});

test('a bulk hand-off of several cases is one notice to the new holder and one to the old', async () => {
  const items = [await workCase('SYN-BULK-1'), await workCase('SYN-BULK-2'), await workCase('SYN-BULK-3')];
  const claim = await post(rivera.token, '/api/work/bulk', { action: 'claim', items }, { 'idempotency-key': 'nt-bulk-claim' });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.succeeded, 3, JSON.stringify(claim.body));
  const current = await Promise.all(items.map(async (i) => ({ id: i.id, version: await caseVersion(i.id) })));

  const before = { nguyen: storedFor(nguyen.id).length, rivera: storedFor(rivera.id).length, op: storedFor(op.id).length };
  const input = { action: 'assign', items: current, to_user_id: nguyen.id, note: 'Synthetic hand-off: match each to its obligation.' };
  const handed = await post(op.token, '/api/work/bulk', input, { 'idempotency-key': 'nt-bulk-handoff' });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.succeeded, 3, JSON.stringify(handed.body));

  const toNguyen = storedFor(nguyen.id).slice(before.nguyen);
  assert.deepEqual(toNguyen.map((n) => n.kind), ['work_assigned'], 'one notice, not three');
  assert.match(toNguyen[0].title, /handed you 3 cases$/);
  assert.equal(toNguyen[0].entity, null);
  assert.equal(toNguyen[0].action_url, '/work');
  assert.equal(toNguyen[0].message, null);
  const fromRivera = storedFor(rivera.id).slice(before.rivera);
  assert.deepEqual(fromRivera.map((n) => n.kind), ['work_moved']);
  assert.match(fromRivera[0].title, /handed 3 cases you held to someone else$/);
  assert.equal(storedFor(op.id).length, before.op, 'its actor hears nothing');

  const retry = await post(op.token, '/api/work/bulk', input, { 'idempotency-key': 'nt-bulk-handoff' });
  assert.equal(retry.body.succeeded, 3);
  assert.equal(storedFor(nguyen.id).length, before.nguyen + 1, 'a retry tells nobody again');
});

// ---------------------------------------------------------------------------------------------------------------------
// No one's words

test('after comments, requests, duty, counseling and hand-offs, no notice about a record carries anybody’s words', async () => {
  const words = 'quillwords';
  const said = (text: string) => `${text} (${words})`;

  // A task assigned with a note; comments, a mention, a question and its answer, a review and its outcome.
  const t = await task(op.token, 'Close out the travel claims', { assignee_id: rivera.id, assignment_note: said('Start with the October statement.') });
  assert.equal(storedAbout(rivera.id, t.id).map((n) => n.kind).join(), 'assignment');
  const tPath = `/api/records/tasks/${t.id}`;
  await say(op.token, 'tasks', t.id, said('The September claims are short two receipts.'));
  await say(nguyen.token, 'tasks', t.id, said('@rivera the DTS report is attached.'));
  // Each person asked follows the notice (which marks it read: an unread one is taken back once its request closes).
  const followed = async (who: Person, kind: string) => {
    const n = (await inbox(who)).rows.find((r) => r.kind === kind && r.action_url === `/records/tasks/${t.id}` && !r.read_at);
    assert.ok(n, `${kind} reached them`);
    assert.equal((await put(who.token, `/api/me/notifications/${n.id}/read`)).status, 200);
  };
  const question = await ask(op.token, tPath, 'clarification_request', nguyen.id, said('Which voucher numbers are missing?'));
  await followed(nguyen, 'clarification_request');
  assert.equal((await post(nguyen.token, `${tPath}/requests/${question.id}/answer`, { body: said('Vouchers 114 and 118.') })).status, 200);
  const reviewAsk = await ask(op.token, tPath, 'review_request', rivera.id, said('Check the totals against the ledger.'));
  await followed(rivera, 'review_request');
  assert.equal((await post(rivera.token, `${tPath}/requests/${reviewAsk.id}/answer`, { outcome: 'needs_changes', body: said('Line 4 is double counted.') })).status, 200);

  // Duty: recorded, asked for review, approved with a note.
  const duty = await made(rivera.token, 'duties', { duty_type_id: 'nt-dnco', date: '2026-03-02', start_time: '0800', end_date: '2026-03-02', end_time: '1600', unit_id: 'G8' });
  await ask(rivera.token, `/api/records/duties/${duty.id}`, 'review_request', nguyen.id, said('Please review my DNCO.'));
  const version = (app.ctx.db.prepare('SELECT version FROM duties WHERE id = ?').get(duty.id) as { version: number }).version;
  const approved = await post(nguyen.token, `/api/records/duties/${duty.id}/review`, { action: 'approve', reason: said('Logbook checks out.'), version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.ok(storedAbout(rivera.id, duty.id).some((n) => n.kind === 'duty'), 'its Marine hears of the decision');

  // Counseling: shared, spoken on, asked about, answered, finalized, acknowledged.
  const c = await counseling(said('Discussed the travel claim backlog.'));
  const cPath = `/api/records/counselings/${c.id}`;
  const shared = await post(lopez.token, `${cPath}/share`, { version: c.version });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  await say(diaz.token, 'counselings', c.id, said('Can we add the GTCC follow-up?'));
  const cq = await ask(lopez.token, cPath, 'clarification_request', diaz.id, said('Which follow-up date suits you?'));
  assert.equal((await post(diaz.token, `${cPath}/requests/${cq.id}/answer`, { body: said('The first of next month.') })).status, 200);
  const final = await post(lopez.token, `${cPath}/finalize`, { version: shared.body.version });
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal((await post(diaz.token, `${cPath}/acknowledge`, { version: final.body.version })).status, 200);
  assert.ok(storedAbout(lopez.id, c.id).some((n) => n.kind === 'counseling_comment'));

  // A case handed off with a note, sent to verification and returned for correction with a reason.
  const item = await workCase('SYN-WORDS-1');
  const claimed = await post(rivera.token, `/api/work/items/${item.id}/claim`, { version: item.version });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const handed = await post(rivera.token, `/api/work/items/${item.id}/handoff`, { to_user_id: nguyen.id, note: said('Check the posted obligation first.'), version: claimed.body.version });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  const verify = await post(nguyen.token, `/api/work/items/${item.id}/stage`, { stage: 'verification_required', version: handed.body.version });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  const returned = await post(op.token, `/api/work/items/${item.id}/stage`, { stage: 'researching', reason: said('The document number is wrong.'), version: verify.body.version });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.deepEqual(storedAbout(nguyen.id, item.id).map((n) => n.kind).sort(), ['work_assigned', 'work_returned']);

  // Stored: a notice about a record or a case keeps no message, and no notice quotes anything anybody wrote.
  const all = app.ctx.db.prepare('SELECT * FROM notifications').all() as StoredNotice[];
  assert.deepEqual(all.filter((n) => n.entity !== null && n.message !== null).map((n) => `${n.kind}: ${n.message}`), []);
  assert.deepEqual(all.filter((n) => `${n.title} ${n.message ?? ''}`.includes(words)).map((n) => `${n.kind}: ${n.title}`), []);
  const about = new Set([t.id, duty.id, c.id, item.id]);
  const kinds = new Set(all.filter((n) => n.entity_id && about.has(n.entity_id)).map((n) => n.kind));
  for (const kind of ['comment_added', 'comment_mention', 'clarification_request', 'request_answered', 'review_request', 'assignment', 'duty', 'counseling', 'counseling_comment', 'work_assigned', 'work_returned']) {
    assert.ok(kinds.has(kind), `the sequence sent a ${kind} notice`);
  }

  // Read: each one about a record names it, and says nothing else.
  for (const who of [op, rivera, nguyen, lopez, diaz]) {
    for (const n of (await inbox(who, '?limit=100')).rows) {
      assert.ok(!`${n.title} ${n.message ?? ''} ${n.label ?? ''}`.includes(words), `${n.kind}: ${n.title}`);
      if (n.label !== null) assert.equal(n.message, null, `${n.kind} about ${n.label}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Your unit

test('enrolling someone already in the unit tells them nothing new; adding them again after a removal does', async () => {
  const unit = await post(g1lead.token, '/api/org/units', { name: 'G-1 Admin', short_name: 'ADMIN', parent_id: 'G1' });
  assert.equal(unit.status, 201, JSON.stringify(unit.body));
  const admin = unit.body.id as string;
  const added = () => storedFor(g1member.id).filter((n) => n.title === 'Added to a unit');
  const enrol = async () => {
    const res = await post(g1lead.token, `/api/org/units/${admin}/members`, { user_id: g1member.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };
  await enrol();
  assert.equal(added().length, 1, 'joining the unit tells them');
  await enrol();
  assert.equal(added().length, 1, 'a second enrolment, a retry or a second leader at the same time, is not news');
  assert.equal((await del(g1lead.token, `/api/org/units/${admin}/members/${g1member.id}`)).status, 200);
  await enrol();
  assert.equal(added().length, 2, 'added again after a removal, they are told again');
});

test('a Unit Instance that signs someone out or changes their CAC link names itself on the notice, so its hold keeps it', async () => {
  const titled = (title: string) => storedFor(g1member.id).filter((n) => n.title === title).at(-1);
  const out = await post(g1lead.token, `/api/orgs/G1/members/${g1member.id}/logout`);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(titled('MARFORRES G-1 signed you out everywhere')?.org_id, 'G1');
  const linked = await post(g1lead.token, '/api/orgs/G1/personnel/link', { user_id: g1member.id, edipi: '1234567890' });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(titled('A CAC was linked to your account')?.org_id, 'G1');
  const cleared = await post(g1lead.token, '/api/orgs/G1/personnel/link', { user_id: g1member.id, edipi: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(titled('The CAC link on your account was removed')?.org_id, 'G1');
  g1member.token = await login('g1member');
});

// ---------------------------------------------------------------------------------------------------------------------
// Kept 180 days, unless a hold keeps them. Last, as its holds bind every sweep while they stand.

test('notices older than 180 days are swept, except a held person’s and a held Unit Instance’s, and each run is recorded', async () => {
  assert.equal(NOTICE_RETENTION_DAYS, 180);
  const runs = () => app.ctx.db.prepare("SELECT * FROM disposition_runs WHERE record_type = 'notifications' ORDER BY at, rowid").all() as Array<Record<string, any>>;
  assert.deepEqual(expireNotifications(app.ctx), { expired: 0, held: 0, blocked: false }, 'nothing is old yet');
  assert.equal(runs().length, 0, 'and a sweep with nothing due records nothing');

  const old = (userId: string, title: string, orgId: string | null) => {
    assert.ok(notify(app.ctx, userId, { kind: 'unit', title, orgId, dedupeKey: `nt-old:${title}` }));
    const row = storedFor(userId).at(-1)!;
    app.ctx.db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(ago(NOTICE_RETENTION_DAYS + 1), row.id);
    return row.id;
  };
  const exists = (id: string) => Boolean(app.ctx.db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(id));
  const heldPerson = old(rivera.id, 'Held person', null);
  const heldInstance = old(g1member.id, 'Held instance', 'G1');
  const otherInstance = old(nguyen.id, 'Other instance', 'G8');
  const noInstance = old(nguyen.id, 'No instance', null);
  const recent = storedFor(nguyen.id).find((n) => n.created_at > ago(1))!;
  assert.ok(recent, 'Nguyen has a recent notice');

  const holds = [
    placeHold(app.ctx, 'G8', { scope: 'user', subject_id: rivera.id, reason: 'Synthetic inquiry into Rivera’s records' }, op.id),
    placeHold(app.ctx, 'G1', { scope: 'instance', reason: 'Synthetic inquiry into G-1' }, g1lead.id),
  ];
  try {
    const seq = (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
    assert.deepEqual(expireNotifications(app.ctx), { expired: 2, held: 2, blocked: false });
    assert.deepEqual([heldPerson, heldInstance, otherInstance, noInstance].map(exists), [true, true, false, false]);
    assert.ok(exists(recent.id), 'a notice within 180 days stays');
    const run = runs().at(-1)!;
    assert.deepEqual([run.disposition, run.eligible, run.acted, run.held, run.actor_id], ['destroy', 4, 2, 2, null]);
    assert.match(run.detail, /2 removed, 2 kept under hold/);
    const audited = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE seq > ? AND action = 'notifications_expired'").all(seq) as Array<{ detail: string }>;
    assert.equal(audited.length, 1);
    assert.match(audited[0].detail, /2 removed/);

    // A hold on every Unit Instance keeps every notice, and the run says so.
    holds.push(placeHold(app.ctx, null, { scope: 'instance', reason: 'Synthetic service-wide hold' }, op.id));
    assert.deepEqual(expireNotifications(app.ctx), { expired: 0, held: 2, blocked: true });
    assert.deepEqual([heldPerson, heldInstance].map(exists), [true, true]);
    assert.deepEqual([runs().at(-1)!.acted, runs().at(-1)!.held], [0, 2]);
  } finally {
    for (const h of holds) releaseHold(app.ctx, h.org_id, h.id, h.placed_by);
  }
  // Released, the held notices go at the next sweep.
  assert.deepEqual(expireNotifications(app.ctx), { expired: 2, held: 0, blocked: false });
  assert.deepEqual([heldPerson, heldInstance].map(exists), [false, false]);
  assert.equal(runs().length, 3);
});

test('an instance hold keeps its notices that name no record: a leader’s message, a member added or moved, a help request', async () => {
  const team = async (name: string, short_name: string) => {
    const res = await post(g1lead.token, '/api/org/units', { name, short_name, parent_id: 'G1' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  };
  const ops = await team('G-1 Operations', 'OPS');
  const plans = await team('G-1 Plans', 'PLANS');
  const latest = (userId: string, title: string | RegExp) => {
    const row = storedFor(userId).filter((n) => (typeof title === 'string' ? n.title === title : title.test(n.title))).at(-1);
    assert.ok(row, `a notice titled ${String(title)}`);
    return row;
  };

  assert.equal((await post(g1lead.token, `/api/org/units/${ops}/members`, { user_id: g1member.id })).status, 201);
  const added = latest(g1member.id, 'Added to a unit');
  assert.equal((await post(g1lead.token, `/api/org/units/${ops}/members/${g1member.id}/move`, { to: plans })).status, 200);
  const moved = latest(g1member.id, 'Moved to a new team');
  const sent = await post(g1lead.token, '/api/org/units/G1/message', { subject: 'Formation', body: 'Formation at 0700 on the parade deck.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const message = latest(g1member.id, /: Formation$/);
  assert.equal(message.message, 'Formation at 0700 on the parade deck.', 'a leader’s message keeps its words');
  g1member.token = await login('g1member');
  const ticket = await post(g1member.token, '/api/support/tickets', { subject: 'Orders', body: 'My orders do not show.', unit_id: 'G1' });
  assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
  const asked = latest(g1lead.id, 'A new help request');

  const kept = [added, moved, message, asked];
  assert.deepEqual(kept.map((n) => n.org_id), ['G1', 'G1', 'G1', 'G1'], 'each names its Unit Instance');
  for (const n of kept) app.ctx.db.prepare('UPDATE notifications SET created_at = ? WHERE id = ?').run(ago(NOTICE_RETENTION_DAYS + 1), n.id);
  const exists = (id: string) => Boolean(app.ctx.db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(id));

  const hold = placeHold(app.ctx, 'G1', { scope: 'instance', reason: 'Synthetic inquiry into G-1' }, g1lead.id);
  try {
    assert.deepEqual(expireNotifications(app.ctx), { expired: 0, held: 4, blocked: false });
    assert.deepEqual(kept.map((n) => exists(n.id)), [true, true, true, true]);
  } finally {
    releaseHold(app.ctx, hold.org_id, hold.id, hold.placed_by);
  }
  assert.deepEqual(expireNotifications(app.ctx), { expired: 4, held: 0, blocked: false });
  assert.deepEqual(kept.map((n) => exists(n.id)), [false, false, false, false]);
});
