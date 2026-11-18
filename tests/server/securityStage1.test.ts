import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import PDFDocument from 'pdfkit';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, enroll, fakeClamd, mockGenAi, unanswered, PASSWORD, type TestApp } from './helpers.ts';
import { issueToken } from '../../server/auth/tokens.ts';
import { totpCode } from '../../server/auth/totp.ts';
import { assertConfirmedProof, createSession, invalidateUserSessions, liveSession, resolveSession, sessionDigest } from '../../server/auth/sessions.ts';
import { inExportLine } from '../../server/services/reportCenter.ts';
import { isoCBOR } from '@simplewebauthn/server/helpers';

/**
 * The security review's first stage (ADR-0035). Each finding is held to a regression here:
 * F01/C01, a contact is read by its own rule, and a thread lends nobody its contact;
 * F02/C02, a contact is changed by its own rule, against the version its editor read;
 * F04/C04, a proof checked before a reset, a sign-out everywhere or a deactivation opens and confirms nothing;
 * F05/C05, a file that waited in the export line, or while it was drawn, leaves only if its reader still holds it;
 * F06/C26, an upload that waited on the scanner is kept only for a session still live, by the same deadlines a request meets.
 * F03/C03 (organization sign-in bound to the browser that began it) is in oidc.test.ts.
 */

interface Who { token: string; id: string }
const NEW_PASSWORD = 'harbor-lantern-quartz-meadow-614';
const OTHER_PASSWORD = 'saffron-glacier-ember-violet-382';

const count = (on: TestApp, sql: string, ...params: unknown[]) => (on.ctx.db.prepare(sql).get(...params) as { n: number }).n;
const sessionsOf = (on: TestApp, userId: string) => count(on, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', userId);
const audited = (on: TestApp, action: string) => count(on, 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', action);
const lastDetail = (on: TestApp, action: string) => (on.ctx.db.prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action) as { detail: string } | undefined)?.detail;
const past = () => new Date(Date.now() - 60_000).toISOString();

/** Someone signed up, seated where `seats` say (a seat ends their sessions), and signed in again afterwards. */
async function person(on: TestApp, lead: Who, username: string, seats: Array<[string, string?]> = [], extra: Record<string, unknown> = {}): Promise<Who> {
  const who = await on.register(username, extra);
  for (const [unit, role] of seats) await enroll(on, lead.token, unit, who.id, role);
  return { id: who.id, token: seats.length ? (await on.login(username)).body.token : who.token };
}

/** Takes a person's roles away and gives them back, without touching their sessions: the path a sync or an admin edit takes. */
function rolesOf(on: TestApp, userId: string) {
  const grants = on.ctx.db.prepare('SELECT * FROM member_roles WHERE user_id = ?').all(userId) as Array<Record<string, unknown>>;
  assert.ok(grants.length, 'they hold a role to take away');
  return {
    remove: () => on.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ?').run(userId),
    restore: () => { for (const g of grants) on.ctx.db.prepare(`INSERT OR IGNORE INTO member_roles (${Object.keys(g).join(', ')}) VALUES (${Object.keys(g).map(() => '?').join(', ')})`).run(...Object.values(g) as never[]); },
  };
}

/** Takes a person out of one unit (their seat and the roles they hold there) and puts them back, without touching their sessions. */
function seatOf(on: TestApp, userId: string, unitId: string) {
  const seat = on.ctx.db.prepare('SELECT * FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId) as Record<string, unknown> | undefined;
  assert.ok(seat, `they sit in ${unitId}`);
  const grants = on.ctx.db.prepare('SELECT * FROM member_roles WHERE user_id = ? AND unit_id = ?').all(userId, unitId) as Array<Record<string, unknown>>;
  const put = (table: string, row: Record<string, unknown>) => on.ctx.db.prepare(`INSERT OR IGNORE INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row) as never[]);
  return {
    leave: () => {
      on.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(userId, unitId);
      on.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(userId, unitId);
    },
    back: () => { put('unit_members', seat); for (const g of grants) put('member_roles', g); },
  };
}

// ——— Holds: a password check, a drawn PDF, the export line ———

type Pbkdf2 = (...args: unknown[]) => void;
const builtins = crypto as unknown as { pbkdf2: Pbkdf2 };
const realPbkdf2 = builtins.pbkdf2;
/**
 * Holds the next password check: PBKDF2 runs off the main thread and the sign-in awaits it, so a reset or a deactivation
 * can land while it runs. `seen` resolves once the check has begun; nothing is answered until `release`.
 */
function holdPasswordCheck() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let arrived!: () => void;
  const seen = new Promise<void>((r) => { arrived = r; });
  builtins.pbkdf2 = (...args: unknown[]) => {
    builtins.pbkdf2 = realPbkdf2;
    syncBuiltinESMExports();
    arrived();
    void gate.then(() => realPbkdf2(...args));
  };
  syncBuiltinESMExports();
  return { seen, release };
}

const realEnd = PDFDocument.prototype.end;
/** Holds the next PDF before it is finished: every renderer resolves on the document's end, so the file waits until `release`. */
function holdPdf() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let arrived!: () => void;
  const seen = new Promise<void>((r) => { arrived = r; });
  PDFDocument.prototype.end = function (this: PDFKit.PDFDocument) {
    PDFDocument.prototype.end = realEnd;
    arrived();
    void gate.then(() => realEnd.call(this));
  };
  return { seen, release };
}

/** Holds the export line: whatever is asked for next waits behind this until `release`. */
function holdExportLine() {
  let release!: () => void;
  const blocker = new Promise<void>((r) => { release = r; });
  const held = inExportLine(() => blocker);
  return { release: async () => { release(); await held; } };
}

after(() => {
  builtins.pbkdf2 = realPbkdf2;
  syncBuiltinESMExports();
  PDFDocument.prototype.end = realEnd;
});

// ——— F01, F02: contacts ———

/**
 * A G8 with a Fiscal team: ortiz adds contacts and sits in both; lane is a plain member of G8; reyes is a G8 SNCO (manages
 * records); fisk sits in both as a plain member; kemp is an SNCO of Fiscal only and a plain member of G8; stone is in no unit.
 */
async function contactsUnit() {
  const on = await startApp();
  try {
    const op = await on.setupOperator();
    assert.equal((await on.call('POST', '/api/org/units', { token: op.token, body: { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' } })).status, 201);
    const ortiz = await person(on, op, 'ortiz', [['G8'], ['FISCAL']]);
    const lane = await person(on, op, 'lane', [['G8']]);
    const reyes = await person(on, op, 'reyes', [['G8', 'snco']], { rank_id: 'SSgt' });
    const fisk = await person(on, op, 'fisk', [['G8'], ['FISCAL']]);
    const kemp = await person(on, op, 'kemp', [['G8'], ['FISCAL', 'snco']], { rank_id: 'SSgt' });
    const stone = await person(on, op, 'stone');
    const made = async (token: string, path: string, body: Record<string, unknown>) => {
      const res = await on.call('POST', path, { token, body });
      assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
      return res.body as Record<string, any>;
    };
    return { on, op, ortiz, lane, reyes, fisk, kemp, stone, made };
  } catch (e) { await on.close(); throw e; }
}

test('a contact is read by its own rule, and a thread lends nobody its contact (F01, C01)', async () => {
  const { on, op, ortiz, lane, reyes, fisk, stone, made } = await contactsUnit();
  try {
    const threads = async (who: Who) => (await on.call('GET', '/api/correspondence/threads', { token: who.token })).body as Array<Record<string, any>>;
    const listed = async (who: Who, thread: string) => (await threads(who)).find((t) => t.id === thread);
    const detail = (who: Who, thread: string) => on.call('GET', `/api/correspondence/threads/${thread}`, { token: who.token });
    const contacts = async (who: Who) => (await on.call('GET', '/api/correspondence/contacts', { token: who.token })).body as Array<Record<string, any>>;

    /** What someone who may not read the contact is served about a thread that names it: that it has one, and nothing of it. */
    async function hiddenFrom(who: Who, thread: string, contact: string, words: RegExp) {
      const row = await listed(who, thread);
      assert.ok(row, 'the thread itself is still theirs to read');
      assert.equal(row.contact_hidden, true);
      assert.equal(row.contact_name, null);
      assert.equal(row.contact_organization, null);
      const open = await detail(who, thread);
      assert.equal(open.status, 200, JSON.stringify(open.body));
      assert.equal(open.body.contact, null);
      assert.equal(open.body.contact_hidden, true);
      const theirs = await contacts(who);
      assert.ok(!theirs.some((c) => c.id === contact), 'nor is it in their contacts');
      assert.doesNotMatch(JSON.stringify([row, open.body, theirs]), words);
    }

    // Shared with G8, the unit sees it on the thread that names it.
    const contact = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Avery Vendor', email: 'avery@vendor.example', organization: 'Vendor Company', notes: 'Shared note', visibility: 'unit', unit_id: 'G8' });
    const thread = (await made(ortiz.token, '/api/correspondence/threads', { subject: 'Invoice 14', visibility: 'unit', unit_id: 'G8', contact_id: contact.id })).id as string;
    for (const who of [lane, reyes, op, fisk]) {
      const row = await listed(who, thread);
      assert.equal(row?.contact_name, 'Avery Vendor');
      assert.equal(row?.contact_hidden, false);
      assert.equal((await detail(who, thread)).body.contact.email, 'avery@vendor.example');
    }

    // Its owner makes it private, still filed under G8, with words the unit has never seen.
    const secret = /Avery Private|avery\.private|Homestead Trust|555-0199|Private note/;
    const priv = await on.call('PUT', `/api/correspondence/contacts/${contact.id}`, { token: ortiz.token, body: { name: 'Avery Private', email: 'avery.private@home.example', organization: 'Homestead Trust', phone: '555-0199', notes: 'Private note', visibility: 'private', unit_id: 'G8', version: contact.version } });
    assert.equal(priv.status, 200, JSON.stringify(priv.body));
    for (const who of [lane, reyes, op, fisk]) await hiddenFrom(who, thread, contact.id, secret);
    // Someone in no unit reads neither the thread nor the contact.
    assert.ok([403, 404].includes((await detail(stone, thread)).status));
    assert.doesNotMatch(JSON.stringify([await threads(stone), await contacts(stone)]), /Invoice 14|Avery/);
    // Its owner sees all of it, on the thread and in their contacts.
    const own = await detail(ortiz, thread);
    assert.equal(own.body.contact_hidden, false);
    assert.equal(own.body.contact.notes, 'Private note');
    assert.equal((await listed(ortiz, thread))?.contact_name, 'Avery Private');
    assert.ok((await contacts(ortiz)).some((c) => c.id === contact.id));

    // Removed, a contact is nobody's to see on a thread, its owner's included.
    const gone = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Blake Removed', notes: 'Removed note', visibility: 'unit', unit_id: 'G8' });
    const goneThread = (await made(ortiz.token, '/api/correspondence/threads', { subject: 'Invoice 15', visibility: 'unit', unit_id: 'G8', contact_id: gone.id })).id as string;
    on.ctx.db.prepare('UPDATE contacts SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), gone.id);
    for (const who of [lane, reyes, op, fisk, ortiz]) await hiddenFrom(who, goneThread, gone.id, /Blake Removed|Removed note/);
    assert.equal((await on.call('PUT', `/api/correspondence/contacts/${gone.id}`, { token: ortiz.token, body: { name: 'Blake Back', visibility: 'unit', unit_id: 'G8' } })).status, 404);

    // Private and in no unit: its owner may name it on a shared thread; the unit learns only that the thread has a contact.
    const mine = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Casey Personal', email: 'casey@personal.example', visibility: 'private' });
    const mineThread = (await made(ortiz.token, '/api/correspondence/threads', { subject: 'Invoice 16', visibility: 'unit', unit_id: 'G8', contact_id: mine.id })).id as string;
    for (const who of [lane, reyes, op, fisk]) await hiddenFrom(who, mineThread, mine.id, /Casey Personal|casey@personal/);
    assert.equal((await detail(ortiz, mineThread)).body.contact.name, 'Casey Personal');

    // Shared with Fiscal and named on a G8 thread: a member of G8 alone does not read it; a member of Fiscal does.
    const fiscal = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Drew Fiscal', email: 'drew@fiscal.example', visibility: 'unit', unit_id: 'FISCAL' });
    const fiscalThread = (await made(ortiz.token, '/api/correspondence/threads', { subject: 'Invoice 17', visibility: 'unit', unit_id: 'G8', contact_id: fiscal.id })).id as string;
    for (const who of [lane, reyes]) await hiddenFrom(who, fiscalThread, fiscal.id, /Drew Fiscal|drew@fiscal/);
    assert.equal((await listed(fisk, fiscalThread))?.contact_name, 'Drew Fiscal');
    assert.equal((await detail(fisk, fiscalThread)).body.contact.email, 'drew@fiscal.example');
  } finally { await on.close(); }
});

test('a contact is changed by its own rule, against the version its editor read, and audited without its words (F02, C02)', async () => {
  const { on, ortiz, lane, reyes, kemp, made } = await contactsUnit();
  try {
    const put = (who: Who, id: string, body: Record<string, unknown>) => on.call('PUT', `/api/correspondence/contacts/${id}`, { token: who.token, body });
    const row = (id: string) => on.ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Record<string, any>;

    const contact = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Avery Vendor', email: 'avery@vendor.example', visibility: 'unit', unit_id: 'G8' });
    assert.equal(lastDetail(on, 'create_contact'), 'unit', 'adding one is audited by its visibility alone');
    const v0 = Number(contact.version);

    // A G8 SNCO tidies a contact shared with G8. The trail says what kind of change it was, never what the contact says.
    const tidied = await put(reyes, contact.id, { name: 'Avery Vendor', organization: 'Vendor Company of Record', visibility: 'unit', unit_id: 'G8', version: v0 });
    assert.equal(tidied.status, 200, JSON.stringify(tidied.body));
    assert.equal(tidied.body.version, v0 + 1);
    assert.equal(lastDetail(on, 'edit_contact'), 'unit_manager edited');
    assert.doesNotMatch(JSON.stringify(on.ctx.db.prepare("SELECT * FROM audit_log WHERE entity = 'contacts'").all()), /Vendor Company of Record|avery@vendor/);

    // A plain member reads it and changes nothing.
    assert.equal((await put(lane, contact.id, { name: 'Avery Renamed', visibility: 'unit', unit_id: 'G8' })).status, 403);
    // An editor working from the version before the SNCO's change is refused, not let overwrite it.
    const stale = await put(ortiz, contact.id, { name: 'Avery Stale', visibility: 'unit', unit_id: 'G8', version: v0 });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'version_conflict');
    assert.equal(row(contact.id).organization, 'Vendor Company of Record');
    // Only its owner makes it private.
    const grab = await put(reyes, contact.id, { name: 'Avery Vendor', visibility: 'private', unit_id: 'G8', version: v0 + 1 });
    assert.equal(grab.status, 403);
    assert.equal(grab.body.code, 'owner_only');
    assert.equal(row(contact.id).visibility, 'unit');

    // The SNCO opened it at v0 + 1; its owner makes it private meanwhile. The SNCO's save finds no contact they can read,
    // and the owner's private words stand.
    const priv = await put(ortiz, contact.id, { name: 'Avery Private', notes: 'Private note', visibility: 'private', unit_id: 'G8', version: v0 + 1 });
    assert.equal(priv.status, 200, JSON.stringify(priv.body));
    assert.equal(lastDetail(on, 'edit_contact'), 'owner unit_to_private');
    const late = await put(reyes, contact.id, { name: 'Avery Vendor', notes: 'Overwritten', visibility: 'unit', unit_id: 'G8', version: v0 + 1 });
    assert.equal(late.status, 404, JSON.stringify(late.body));
    assert.equal(row(contact.id).notes, 'Private note');
    assert.equal(row(contact.id).visibility, 'private');
    // Its owner still edits it, private or not.
    assert.equal((await put(ortiz, contact.id, { name: 'Avery Private', notes: 'Second private note', visibility: 'private', unit_id: 'G8' })).status, 200);

    // A shared contact, and an SNCO who loses the role (their session standing): they read it still, and change nothing.
    const shared = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Blake Vendor', visibility: 'unit', unit_id: 'G8' });
    const roles = rolesOf(on, reyes.id);
    roles.remove();
    assert.equal((await put(reyes, shared.id, { name: 'Blake Renamed', visibility: 'unit', unit_id: 'G8' })).status, 403);
    roles.restore();
    assert.equal((await put(reyes, shared.id, { name: 'Blake Vendor', organization: 'Blake and Sons', visibility: 'unit', unit_id: 'G8' })).status, 200, 'the role back, the edit is allowed');
    // Out of the unit, they can place nothing there, so the change is refused before the contact is even read.
    const seat = on.ctx.db.prepare("SELECT * FROM unit_members WHERE user_id = ? AND unit_id = 'G8'").get(reyes.id) as Record<string, unknown>;
    on.ctx.db.prepare("DELETE FROM unit_members WHERE user_id = ? AND unit_id = 'G8'").run(reyes.id);
    assert.equal((await put(reyes, shared.id, { name: 'Blake Renamed', visibility: 'unit', unit_id: 'G8' })).status, 403);
    on.ctx.db.prepare(`INSERT INTO unit_members (${Object.keys(seat).join(', ')}) VALUES (${Object.keys(seat).map(() => '?').join(', ')})`).run(...Object.values(seat) as never[]);
    assert.equal(row(shared.id).name, 'Blake Vendor');

    // An SNCO of Fiscal tidies a Fiscal contact, and cannot move it to G8, where they manage nothing.
    const fiscal = await made(ortiz.token, '/api/correspondence/contacts', { name: 'Drew Fiscal', visibility: 'unit', unit_id: 'FISCAL' });
    const moved = await put(kemp, fiscal.id, { name: 'Drew Fiscal', visibility: 'unit', unit_id: 'G8' });
    assert.equal(moved.status, 403, JSON.stringify(moved.body));
    assert.equal(row(fiscal.id).unit_id, 'FISCAL');
    assert.equal((await put(kemp, fiscal.id, { name: 'Drew Fiscal', role: 'Budget analyst', visibility: 'unit', unit_id: 'FISCAL' })).status, 200);
    assert.equal(lastDetail(on, 'edit_contact'), 'unit_manager edited');
  } finally { await on.close(); }
});

// ——— F04: a proof checked across a reset ———

test('a password checked before a reset, a sign-out everywhere or a deactivation opens and confirms nothing (F04, C04)', async () => {
  const on = await startApp();
  try {
    const op = await on.setupOperator();
    const reset = (userId: string, password: string) => on.call('POST', '/api/auth/reset', { body: { token: issueToken(on.ctx, 'reset', { userId, ttlMinutes: 5 }).token, password } });
    const loginAs = (username: string, password: string) => on.login(username, password);

    // A sign-in whose password is still being checked when a reset lands: refused, and no session but the reset's own.
    const lane = await on.register('lane');
    let held = holdPasswordCheck();
    const signing = loginAs('lane', PASSWORD);
    await held.seen;
    assert.equal(await unanswered(signing), true, 'the password is still being checked');
    const resetDone = await reset(lane.id, NEW_PASSWORD);
    assert.equal(resetDone.status, 200, JSON.stringify(resetDone.body));
    held.release();
    const refused = await signing;
    assert.equal(refused.status, 401, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'credentials_changed');
    assert.equal(refused.body.token, undefined);
    assert.equal(sessionsOf(on, lane.id), 1, 'only the session the reset itself opened');
    assert.equal(lastDetail(on, 'login_failed'), 'password; the account changed while it was checked');
    assert.equal((await loginAs('lane', PASSWORD)).status, 401, 'the old password is gone');
    assert.equal((await loginAs('lane', NEW_PASSWORD)).status, 200, 'a fresh sign-in with the new one works');

    // The same for an account with an authenticator: no challenge is issued for a proof the reset overtook.
    const tess = await on.register('tess');
    const start = await on.call('POST', '/api/me/mfa/totp/start', { token: tess.token });
    assert.equal((await on.call('POST', '/api/me/mfa/totp/confirm', { token: tess.token, body: { code: totpCode(start.body.secret, Math.floor(Date.now() / 30000)) } })).status, 200);
    held = holdPasswordCheck();
    const challenging = loginAs('tess', PASSWORD);
    await held.seen;
    assert.equal(await unanswered(challenging), true);
    assert.equal((await reset(tess.id, NEW_PASSWORD)).body.mfa, 'totp');
    held.release();
    const noChallenge = await challenging;
    assert.equal(noChallenge.status, 401);
    assert.equal(noChallenge.body.challenge, undefined);
    // A challenge issued before a reset is spent unanswered, even with a good code.
    const before = await loginAs('tess', NEW_PASSWORD);
    assert.equal(before.body.mfa, 'totp');
    assert.equal((await reset(tess.id, OTHER_PASSWORD)).status, 200);
    const code = totpCode(start.body.secret, Math.floor(Date.now() / 30000) + 1);
    const expired = await on.call('POST', '/api/auth/login/mfa', { body: { challenge: before.body.challenge, code } });
    assert.equal(expired.status, 401, JSON.stringify(expired.body));
    assert.equal(expired.body.code, 'challenge_expired');
    const fresh = await loginAs('tess', OTHER_PASSWORD);
    const answered = await on.call('POST', '/api/auth/login/mfa', { body: { challenge: fresh.body.challenge, code } });
    assert.equal(answered.status, 200, 'the same code answers a challenge issued after the reset');
    assert.ok(answered.body.token);

    // An authenticator turned on while the password is checked is asked for: a challenge comes back, not a session.
    const mona = await on.register('mona');
    const monaSessions = sessionsOf(on, mona.id);
    held = holdPasswordCheck();
    const plain = loginAs('mona', PASSWORD);
    await held.seen;
    assert.equal(await unanswered(plain), true);
    const monaStart = await on.call('POST', '/api/me/mfa/totp/start', { token: mona.token });
    assert.equal((await on.call('POST', '/api/me/mfa/totp/confirm', { token: mona.token, body: { code: totpCode(monaStart.body.secret, Math.floor(Date.now() / 30000)) } })).status, 200);
    held.release();
    const asked = await plain;
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.mfa, 'totp');
    assert.ok(asked.body.challenge);
    assert.equal(asked.body.token, undefined);
    assert.equal(sessionsOf(on, mona.id), monaSessions);

    // A step-up whose password is being checked when another session signs this one out: refused as signed out.
    const rhee = await on.register('rhee');
    const rheeA = (await loginAs('rhee', PASSWORD)).body.token as string;
    held = holdPasswordCheck();
    const confirming = on.call('POST', '/api/auth/sudo', { token: rheeA, body: { password: PASSWORD } });
    await held.seen;
    assert.equal(await unanswered(confirming), true);
    assert.equal((await on.call('POST', '/api/me/sessions/revoke-others', { token: rhee.token })).status, 200);
    held.release();
    assert.equal((await confirming).status, 401);
    assert.equal(count(on, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sessionDigest(rheeA)), 0);
    // When the session that asks is the one that signed the others out, it stays signed in, and the stale proof confirms nothing.
    const rheeB = (await loginAs('rhee', PASSWORD)).body.token as string;
    const sudoOf = (token: string) => (on.ctx.db.prepare('SELECT sudo_until FROM sessions WHERE id = ?').get(sessionDigest(token)) as { sudo_until: string | null }).sudo_until;
    const sudoBefore = sudoOf(rheeB);
    held = holdPasswordCheck();
    const ownStepUp = on.call('POST', '/api/auth/sudo', { token: rheeB, body: { password: PASSWORD } });
    await held.seen;
    assert.equal(await unanswered(ownStepUp), true);
    assert.equal((await on.call('POST', '/api/me/sessions/revoke-others', { token: rheeB })).status, 200);
    held.release();
    const stale = await ownStepUp;
    assert.equal(stale.status, 403, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'credentials_changed');
    assert.equal(sudoOf(rheeB), sudoBefore, 'no step-up granted');
    assert.equal((await on.call('GET', '/api/me', { token: rheeB })).status, 200, 'and the session still stands');
    assert.equal((await on.call('POST', '/api/auth/sudo', { token: rheeB, body: { password: PASSWORD } })).status, 200, 'a fresh step-up works');

    // A password change whose current password is being checked when a reset lands: refused, and the reset's password stands.
    const park = await on.register('park');
    held = holdPasswordCheck();
    const changing = on.call('POST', '/api/me/password', { token: park.token, body: { current_password: PASSWORD, new_password: OTHER_PASSWORD } });
    await held.seen;
    assert.equal(await unanswered(changing), true);
    assert.equal((await reset(park.id, NEW_PASSWORD)).status, 200);
    held.release();
    assert.equal((await changing).status, 401);
    assert.equal((await loginAs('park', OTHER_PASSWORD)).status, 401, 'the change never landed');
    assert.equal((await loginAs('park', NEW_PASSWORD)).status, 200, 'the reset password stands');
    // And when its own session signs the others out meanwhile, it stays signed in and the change is refused.
    const parkToken = (await loginAs('park', NEW_PASSWORD)).body.token as string;
    held = holdPasswordCheck();
    const ownChange = on.call('POST', '/api/me/password', { token: parkToken, body: { current_password: NEW_PASSWORD, new_password: OTHER_PASSWORD } });
    await held.seen;
    assert.equal(await unanswered(ownChange), true);
    assert.equal((await on.call('POST', '/api/me/sessions/revoke-others', { token: parkToken })).status, 200);
    held.release();
    const staleChange = await ownChange;
    assert.equal(staleChange.status, 403, JSON.stringify(staleChange.body));
    assert.equal(staleChange.body.code, 'credentials_changed');
    assert.equal((await loginAs('park', OTHER_PASSWORD)).status, 401);
    assert.equal((await on.call('GET', '/api/me', { token: parkToken })).status, 200);

    // An account closed while its password is checked: nothing opens.
    const quinn = await on.register('quinn');
    held = holdPasswordCheck();
    const closing = loginAs('quinn', PASSWORD);
    await held.seen;
    assert.equal(await unanswered(closing), true);
    assert.equal((await on.call('POST', `/api/platform/accounts/${quinn.id}/deactivate`, { token: op.token, body: { reason: 'left the service' } })).status, 200);
    held.release();
    assert.equal((await closing).status, 401);
    assert.equal(sessionsOf(on, quinn.id), 0);

    // With nothing overtaking it, a sign-in opens a session as before.
    const plainLogin = await loginAs('lane', NEW_PASSWORD);
    assert.equal(plainLogin.status, 200);
    assert.ok(plainLogin.body.token);
  } finally { await on.close(); }
});

// ——— F05: files that waited ———

test('a file that waited in the export line, or while it was drawn, leaves only if its reader still holds it (F05, C05)', async () => {
  const on = await startApp();
  try {
    const op = await on.setupOperator();
    const diaz = await person(on, op, 'diaz', [['G8']], { last_name: 'Diaz' });
    let sato = await person(on, op, 'sato', [['G8', 'snco']], { rank_id: 'SSgt', last_name: 'Sato' });
    const act = await on.call('POST', '/api/records/activities', { token: diaz.token, body: { title: 'Reconciled 12 ULOs', date: '2026-09-01', visibility: 'unit', unit_id: 'G8' } });
    assert.equal(act.status, 201, JSON.stringify(act.body));
    const exportUrl = (format: string) => `/api/report-center/export?${new URLSearchParams({ type: 'unit', unit_id: 'G8', format })}`;
    const download = (token: string, path: string) => on.call('GET', path, { token, binary: true });
    const roles = rolesOf(on, sato.id);

    for (const format of ['json', 'csv', 'xlsx', 'pdf']) {
      // The control: with nothing changed, the file leaves and is audited.
      const exported = audited(on, 'export_report');
      const ok = await download(sato.token, exportUrl(format));
      assert.equal(ok.status, 200, format);
      assert.ok(ok.buffer!.length > 0);
      assert.equal(audited(on, 'export_report'), exported + 1);

      // The SNCO role taken away (their session standing) while the request waits its turn: no file, nothing audited.
      const line = holdExportLine();
      const waiting = download(sato.token, exportUrl(format));
      assert.equal(await unanswered(waiting), true, `${format} waits its turn`);
      roles.remove();
      await line.release();
      const refused = await waiting;
      assert.equal(refused.status, 403, format);
      assert.doesNotMatch(refused.buffer!.toString('utf8'), /Reconciled|Diaz/);
      assert.equal(audited(on, 'export_report'), exported + 1, `${format}: nothing audited as exported`);
      roles.restore();
    }

    // Their session ended while the request waits: a 401, as any request on it would be.
    let line = holdExportLine();
    let waiting = download(sato.token, exportUrl('csv'));
    assert.equal(await unanswered(waiting), true);
    on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(sato.token));
    await line.release();
    assert.equal((await waiting).status, 401);
    sato = { ...sato, token: (await on.login('sato')).body.token };
    // Their account closed while it waits: a 401.
    line = holdExportLine();
    waiting = download(sato.token, exportUrl('xlsx'));
    assert.equal(await unanswered(waiting), true);
    on.ctx.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(sato.id);
    await line.release();
    assert.equal((await waiting).status, 401);
    on.ctx.db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(sato.id);

    // The role taken away while the PDF is being drawn: the drawn file does not leave.
    const exported = audited(on, 'export_report');
    let drawing = holdPdf();
    const drawn = download(sato.token, exportUrl('pdf'));
    await drawing.seen;
    assert.equal(await unanswered(drawn), true, 'the PDF is being drawn');
    roles.remove();
    drawing.release();
    const undelivered = await drawn;
    assert.equal(undelivered.status, 403);
    assert.ok(!undelivered.buffer!.subarray(0, 5).equals(Buffer.from('%PDF-')));
    assert.equal(audited(on, 'export_report'), exported);
    roles.restore();

    // A FITREP or JEPES input PDF about another Marine, drawn while the reader's role is taken away: refused at delivery.
    const reportPdf = `/api/reports/pdf?${new URLSearchParams({ user_id: diaz.id, unit_id: 'G8', period: 'all' })}`;
    const pdfs = audited(on, 'export_pdf');
    const allowed = await download(sato.token, reportPdf);
    assert.equal(allowed.status, 200);
    assert.equal(audited(on, 'export_pdf'), pdfs + 1);
    drawing = holdPdf();
    const input = download(sato.token, reportPdf);
    await drawing.seen;
    assert.equal(await unanswered(input), true);
    roles.remove();
    drawing.release();
    const inputRefused = await input;
    assert.equal(inputRefused.status, 403);
    assert.equal(audited(on, 'export_pdf'), pdfs + 1);
    roles.restore();

    // A counseling worksheet drawn while the session that asked for it is signed out: a 401, and nothing audited.
    const counseling = await on.call('POST', '/api/records/counselings', { token: diaz.token, body: { date: '2026-09-01', type: 'monthly', summary: 'Own notes', visibility: 'private' } });
    assert.equal(counseling.status, 201, JSON.stringify(counseling.body));
    const worksheet = `/api/records/counselings/${counseling.body.id}/export?format=pdf`;
    const records = audited(on, 'export_record');
    drawing = holdPdf();
    const sheet = download(diaz.token, worksheet);
    await drawing.seen;
    assert.equal(await unanswered(sheet), true);
    on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(diaz.token));
    drawing.release();
    assert.equal((await sheet).status, 401);
    assert.equal(audited(on, 'export_record'), records);
    const again = await download((await on.login('diaz')).body.token, worksheet);
    assert.equal(again.status, 200, 'signed in again, the worksheet downloads');
    assert.equal(audited(on, 'export_record'), records + 1);
  } finally { await on.close(); }
});

// ——— F06: uploads that waited on the scanner ———

test('a session is live by the same deadlines everywhere, asked without renewing it and whether or not it was pruned (F06, C26)', async (t) => {
  const on = await startApp();
  try {
    const op = await on.setupOperator();
    const lane = await on.register('lane');
    const s = createSession(on.ctx, lane.id, { method: 'password' });
    const stored = () => on.ctx.db.prepare('SELECT expires_at, absolute_expires_at FROM sessions WHERE id = ?').get(s.id) as { expires_at: string; absolute_expires_at: string } | undefined;
    const at = Date.now() + 60_000;
    const iso = new Date(at).toISOString();
    on.ctx.db.prepare('UPDATE sessions SET expires_at = ?, last_used_at = ? WHERE id = ?').run(iso, iso, s.id);

    t.mock.timers.enable({ apis: ['Date'], now: at });
    assert.ok(liveSession(on.ctx, s.id, lane.id), 'at the very instant of its idle deadline it stands');
    assert.ok(resolveSession(on.ctx, s.token, { touch: false }), 'and a request then agrees');
    assert.equal(stored()?.expires_at, iso, 'asking never renews it');
    assert.equal(liveSession(on.ctx, s.id, op.id), null, 'paired with someone else it is nobody’s');
    t.mock.timers.tick(1);
    assert.equal(liveSession(on.ctx, s.id, lane.id), null, 'a millisecond past it, it is over');
    assert.ok(stored(), 'though nothing has pruned its row');
    assert.equal(resolveSession(on.ctx, s.token, { touch: false }), null, 'and a request then agrees');
    t.mock.timers.reset();

    // The absolute deadline holds the same way, however recently the session was used.
    const a = createSession(on.ctx, lane.id, { method: 'password' });
    const absolute = Date.now() + 60_000;
    on.ctx.db.prepare('UPDATE sessions SET absolute_expires_at = ?, expires_at = ? WHERE id = ?').run(new Date(absolute).toISOString(), new Date(absolute + 3_600_000).toISOString(), a.id);
    t.mock.timers.enable({ apis: ['Date'], now: absolute });
    assert.ok(liveSession(on.ctx, a.id, lane.id));
    t.mock.timers.tick(1);
    assert.equal(liveSession(on.ctx, a.id, lane.id), null);
    t.mock.timers.reset();

    // Deleted, closed, or opened under an epoch the account has left: over.
    const b = createSession(on.ctx, lane.id, { method: 'password' });
    assert.ok(liveSession(on.ctx, b.id, lane.id));
    on.ctx.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(lane.id);
    assert.equal(liveSession(on.ctx, b.id, lane.id), null);
    on.ctx.db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(lane.id);
    assert.ok(liveSession(on.ctx, b.id, lane.id));
    on.ctx.db.prepare('UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?').run(lane.id);
    assert.equal(liveSession(on.ctx, b.id, lane.id), null);
    const c = createSession(on.ctx, lane.id, { method: 'password' });
    on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(c.id);
    assert.equal(liveSession(on.ctx, c.id, lane.id), null);
    assert.equal(liveSession(on.ctx, null, lane.id), null);
  } finally { t.mock.timers.reset(); await on.close(); }
});

test('an upload that waited on the scanner is kept only for a session still live when the scanner answers (F06, C26)', async () => {
  const clamd = await fakeClamd();
  const on = await startApp({ VANTAGE_CLAMD: clamd.address });
  try {
    const op = await on.setupOperator();
    const diaz = await person(on, op, 'diaz', [['G8']], { last_name: 'Diaz' });
    const fresh = async () => (await on.login('diaz')).body.token as string;
    const training = await on.call('POST', '/api/records/trainings', { token: diaz.token, body: { title: 'Corporals Course', type: 'pme', status: 'completed', date: '2026-05-01' } });
    assert.equal(training.status, 201, JSON.stringify(training.body));
    let n = 0;
    const attach = (token: string) => on.call('POST', `/api/records/trainings/${training.body.id}/attachments`, {
      token, raw: Buffer.from(`%PDF-1.7\n% evidence ${(n += 1)}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`),
      headers: { 'content-type': 'application/pdf', 'x-vantage-filename': encodeURIComponent(`certificate-${n}.pdf`), 'x-vantage-evidence-kind': 'certificate' },
    });
    const message = (token: string) => on.call('POST', '/api/correspondence/messages/import', {
      token, raw: Buffer.from(`From: Vendor <vendor@example.com>\r\nTo: g8@example.mil\r\nSubject: Invoice ${(n += 1)}\r\nMessage-ID: <s${n}@example.com>\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease see the invoice.\r\n`),
      headers: { 'content-type': 'message/rfc822', 'x-unit-id': 'G8', 'x-visibility': 'unit' },
    });
    const stage = (token: string) => on.call('POST', '/api/me/imports', { token, raw: Buffer.from(`title,date\nReconciled ULOs ${(n += 1)},2026-09-01\n`), headers: { 'content-type': 'text/csv', 'x-filename': 'activities.csv' } });
    const intake = (token: string) => on.call('POST', '/api/work/sources', { token, raw: Buffer.from(`Document,Description,Due\nULO-${(n += 1)},Clear an obligation,2026-06-30\n`), headers: { 'content-type': 'text/csv', 'x-filename': 'work.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
    const kept = () => ({
      attachments: count(on, "SELECT COUNT(*) AS n FROM attachments WHERE record_table = 'trainings' AND record_id = ?", training.body.id),
      threads: count(on, 'SELECT COUNT(*) AS n FROM threads'),
      imports: count(on, "SELECT COUNT(*) AS n FROM record_imports WHERE user_id = ? AND status = 'staged'", diaz.id),
      sources: count(on, 'SELECT COUNT(*) AS n FROM source_files WHERE user_id = ?', diaz.id),
    });
    /** Sends one upload on a fresh session, ends that session by `end` while the scanner has the file, and returns the answer. */
    async function whileScanning(send: (token: string) => Promise<{ status: number; body: any }>, end: (token: string) => void) {
      const token = await fresh();
      const gate = clamd.gate();
      const sending = send(token);
      await gate.seen;
      assert.equal(await unanswered(sending), true, 'the scanner holds the file');
      end(token);
      gate.release();
      return sending;
    }
    const idle = (token: string) => { on.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(past(), sessionDigest(token)); };
    const absolute = (token: string) => { on.ctx.db.prepare('UPDATE sessions SET absolute_expires_at = ? WHERE id = ?').run(past(), sessionDigest(token)); };
    const deleted = (token: string) => { on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(token)); };
    const untouched = () => undefined;

    // The controls: with the session live throughout, each is kept.
    for (const send of [attach, message, stage, intake]) assert.equal((await whileScanning(send, untouched)).status, 201);
    const before = kept();
    assert.deepEqual(before, { attachments: 1, threads: 1, imports: 1, sources: 1 });

    // Its idle deadline passes while the scanner has an attachment; its absolute deadline while it has a saved message.
    assert.equal((await whileScanning(attach, idle)).status, 401);
    assert.equal((await whileScanning(message, absolute)).status, 401);
    // Run out or signed out while it has an import or a spreadsheet for intake.
    assert.equal((await whileScanning(stage, absolute)).status, 401);
    assert.equal((await whileScanning(intake, idle)).status, 401);
    assert.equal((await whileScanning(stage, deleted)).status, 401);
    assert.equal((await whileScanning(intake, deleted)).status, 401);
    // Still signed in, but no longer in the unit the spreadsheet was to be shared with: the file is placed again, and refused.
    const seat = seatOf(on, diaz.id, 'G8');
    const leftUnit = await whileScanning(intake, seat.leave);
    seat.back();
    assert.equal(leftUnit.status, 403, JSON.stringify(leftUnit.body));
    // Vantage withholds spreadsheet intake from the Unit Instance while the scanner has the file: refused, nothing kept.
    const org = (on.ctx.db.prepare("SELECT org_id FROM units WHERE id = 'G8'").get() as { org_id: string }).org_id;
    const withheld = await whileScanning(intake, () => {
      on.ctx.db.prepare("INSERT INTO instance_feature_flags (org_id, flag, reason, set_by, set_at) VALUES (?, 'intake', 'Held for review', ?, ?)").run(org, op.id, new Date().toISOString());
    });
    on.ctx.db.prepare("DELETE FROM instance_feature_flags WHERE org_id = ? AND flag = 'intake'").run(org);
    assert.equal(withheld.status, 403, JSON.stringify(withheld.body));
    assert.equal(withheld.body.code, 'feature_withheld');
    assert.deepEqual(kept(), before, 'nothing was kept for a session that had ended, or for a unit it had left');
  } finally { clamd.close(); await on.close(); }
});

// ——— Follow-ups from the review of these fixes ———

test('a session opened, resolved or confirmed under an older authentication epoch is refused, and a challenge without one is spent (F04, C04)', async () => {
  const on = await startApp();
  try {
    await on.setupOperator();
    const lane = await on.register('lane');
    const epochOf = (id: string) => (on.ctx.db.prepare('SELECT auth_epoch FROM users WHERE id = ?').get(id) as { auth_epoch: number }).auth_epoch;
    const refusedWith = (status: number, code: string) => (e: unknown) => (e as { status?: number }).status === status && (e as { code?: string }).code === code;

    // createSession refuses, in the same transaction as its insert, an epoch the account has moved past and a closed account.
    const held = sessionsOf(on, lane.id);
    assert.throws(() => createSession(on.ctx, lane.id, { method: 'password', epoch: epochOf(lane.id) + 1 }), refusedWith(401, 'credentials_changed'));
    on.ctx.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(lane.id);
    assert.throws(() => createSession(on.ctx, lane.id, { method: 'password', epoch: epochOf(lane.id) }), refusedWith(401, 'credentials_changed'));
    on.ctx.db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(lane.id);
    assert.equal(sessionsOf(on, lane.id), held, 'nothing was opened');
    assert.ok(createSession(on.ctx, lane.id, { method: 'password', epoch: epochOf(lane.id) }).token, 'under the current epoch it opens');

    // A session whose account's epoch moved on neither stands nor resolves, and is removed when it is presented.
    const s = createSession(on.ctx, lane.id, { method: 'password' });
    on.ctx.db.prepare('UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?').run(lane.id);
    assert.equal(liveSession(on.ctx, s.id, lane.id), null);
    assert.equal(resolveSession(on.ctx, s.token), null);
    assert.equal(count(on, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', s.id), 0, 'presented once, it is gone');
    assert.equal((await on.call('GET', '/api/me', { token: s.token })).status, 401);

    // A proof that needs a confirmed session (adding a passkey) commits only on a live one, under its epoch, still confirmed.
    const kept = createSession(on.ctx, lane.id, { method: 'password', sudo: true });
    const other = createSession(on.ctx, lane.id, { method: 'password', sudo: true });
    const epoch = epochOf(lane.id);
    assert.equal(assertConfirmedProof(on.ctx, kept.id, lane.id, epoch).epoch, epoch);
    invalidateUserSessions(on.ctx, lane.id, kept.id);
    assert.ok(liveSession(on.ctx, kept.id, lane.id), 'the session the others were signed out from stays signed in');
    assert.throws(() => assertConfirmedProof(on.ctx, kept.id, lane.id, epoch), refusedWith(403, 'credentials_changed'), 'but the proof begun before is stale');
    assert.throws(() => assertConfirmedProof(on.ctx, other.id, lane.id, epoch), refusedWith(401, 'unauthenticated'), 'a session signed out meanwhile');
    assert.throws(() => assertConfirmedProof(on.ctx, kept.id, 'someone-else', epochOf(lane.id)), refusedWith(401, 'unauthenticated'), 'another person’s session');
    assert.equal(assertConfirmedProof(on.ctx, kept.id, lane.id, epochOf(lane.id)).epoch, epochOf(lane.id), 'begun under the new epoch, it commits');
    on.ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id = ?').run(past(), kept.id);
    assert.throws(() => assertConfirmedProof(on.ctx, kept.id, lane.id, epochOf(lane.id)), refusedWith(403, 'sudo_required'), 'its confirmation ran out');

    // A code challenge from before the epoch existed carries none: spent unanswered, whatever code comes with it.
    const tess = await on.register('tess');
    const start = await on.call('POST', '/api/me/mfa/totp/start', { token: tess.token });
    const step = Math.floor(Date.now() / 30000);
    assert.equal((await on.call('POST', '/api/me/mfa/totp/confirm', { token: tess.token, body: { code: totpCode(start.body.secret, step) } })).status, 200);
    const sessions = sessionsOf(on, tess.id);
    const old = issueToken(on.ctx, 'login_mfa', { userId: tess.id, ttlMinutes: 5, payload: { ip: '127.0.0.1' } });
    const answer = (challenge: string) => on.call('POST', '/api/auth/login/mfa', { body: { challenge, code: totpCode(start.body.secret, step + 1) } });
    const unanswerable = await answer(old.token);
    assert.equal(unanswerable.status, 401);
    assert.equal(unanswerable.body.code, 'challenge_expired');
    assert.ok((on.ctx.db.prepare('SELECT used_at FROM tokens WHERE id = ?').get(old.id) as { used_at: string | null }).used_at, 'and it is spent');
    assert.equal((await answer(old.token)).body.code, 'challenge_expired');
    assert.equal(sessionsOf(on, tess.id), sessions, 'nothing was opened');
    // The control: the same challenge carrying the account's epoch is answered.
    const current = issueToken(on.ctx, 'login_mfa', { userId: tess.id, ttlMinutes: 5, payload: { ip: '127.0.0.1', epoch: epochOf(tess.id) } });
    const answered = await answer(current.token);
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(sessionsOf(on, tess.id), sessions + 1);
  } finally { await on.close(); }
});

test('an export drawn for a unit and a team below it leaves only while its reader still reads both, and one whose reader left is neither sent nor audited (F05, C05)', async () => {
  const on = await startApp();
  try {
    const op = await on.setupOperator();
    assert.equal((await on.call('POST', '/api/org/units', { token: op.token, body: { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' } })).status, 201);
    // Sato's G8 role does not reach down the chain of command, so Fiscal is theirs only by the role they hold there.
    const position = (on.ctx.db.prepare("SELECT position FROM roles WHERE id = 'G8:snco'").get() as { position: number }).position;
    on.ctx.db.prepare("UPDATE roles SET position = 0 WHERE id = 'G8:snco'").run();
    const diaz = await person(on, op, 'diaz', [['G8']], { last_name: 'Diaz' });
    const fiona = await person(on, op, 'fiona', [['FISCAL']], { last_name: 'Fiona' });
    const sato = await person(on, op, 'sato', [['G8', 'snco'], ['FISCAL', 'snco']], { rank_id: 'SSgt', last_name: 'Sato' });
    for (const [who, title, unit] of [[diaz, 'Reconciled 12 ULOs', 'G8'], [fiona, 'Closed out 7 MIPRs', 'FISCAL']] as const) {
      const act = await on.call('POST', '/api/records/activities', { token: who.token, body: { title, date: '2026-09-01', visibility: 'unit', unit_id: unit } });
      assert.equal(act.status, 201, JSON.stringify(act.body));
    }
    const exportUrl = (format: string) => `/api/report-center/export?${new URLSearchParams({ type: 'unit', unit_id: 'G8', format })}`;
    const download = (path: string) => on.call('GET', path, { token: sato.token, binary: true });
    const fiscal = seatOf(on, sato.id, 'FISCAL');

    /** What a unit report file covers: the units it says it is about, and the entries it counts. */
    const covering = (file: Buffer) => {
      const doc = JSON.parse(file.toString('utf8')) as { about: string; summary: Array<{ label: string; value: number }> };
      return { about: doc.about, shared: doc.summary.find((m) => m.label === 'Entries shared')!.value };
    };
    // The control: the G8 report holds both units' work.
    const whole = await download(exportUrl('json'));
    assert.equal(whole.status, 200);
    assert.deepEqual(covering(whole.buffer!), { about: 'G-8 Comptroller and 1 unit beneath it', shared: 2 });

    // Sato leaves Fiscal while the export waits its turn: the file is drawn on what they read then, without Fiscal.
    let exported = audited(on, 'export_report');
    const line = holdExportLine();
    const waiting = download(exportUrl('json'));
    assert.equal(await unanswered(waiting), true);
    fiscal.leave();
    await line.release();
    const narrowed = await waiting;
    assert.equal(narrowed.status, 200);
    assert.deepEqual(covering(narrowed.buffer!), { about: 'G-8 Comptroller', shared: 1 });
    assert.equal(audited(on, 'export_report'), exported + 1);
    fiscal.back();

    // Sato leaves Fiscal while the PDF is drawn: G8 alone is still theirs to export, but the file holds Fiscal, so it stays.
    exported = audited(on, 'export_report');
    const drawing = holdPdf();
    const drawn = download(exportUrl('pdf'));
    await drawing.seen;
    assert.equal(await unanswered(drawn), true);
    fiscal.leave();
    drawing.release();
    const kept = await drawn;
    assert.equal(kept.status, 403);
    assert.equal(JSON.parse(kept.buffer!.toString('utf8')).code, 'access_changed');
    assert.equal(audited(on, 'export_report'), exported, 'nothing audited as exported');
    fiscal.back();

    // The reader goes (their connection closes) while the export waits: nothing is drawn for them, nothing is audited.
    const away = (path: string) => {
      const leaving = new AbortController();
      const answer = fetch(`${on.base}${path}`, { headers: { authorization: `Bearer ${sato.token}` }, signal: leaving.signal }).catch(() => null);
      return { answer, leave: async () => { leaving.abort(); await answer; await new Promise((r) => setTimeout(r, 150)); } };
    };
    exported = audited(on, 'export_report');
    const notDrawn = holdPdf();
    const held = holdExportLine();
    const queued = away(exportUrl('pdf'));
    assert.equal(await unanswered(queued.answer), true);
    await queued.leave();
    const behind = download(exportUrl('csv'));
    await held.release();
    const drawnForNobody = !(await unanswered(notDrawn.seen));
    PDFDocument.prototype.end = realEnd;
    notDrawn.release();
    assert.equal(drawnForNobody, false, 'no PDF is drawn for a reader who left');
    assert.equal((await behind).status, 200, 'the export queued behind it is drawn and sent');
    assert.equal(audited(on, 'export_report'), exported + 1, 'only the one that was sent is audited');

    // The reader goes while their PDF is being drawn: the drawn file is dropped, unsent and unaudited.
    exported = audited(on, 'export_report');
    const midway = holdPdf();
    const drawingFor = away(exportUrl('pdf'));
    await midway.seen;
    await drawingFor.leave();
    midway.release();
    assert.equal((await download(exportUrl('csv'))).status, 200, 'the next export, queued behind it, runs');
    assert.equal(audited(on, 'export_report'), exported + 1, 'the dropped file is not audited as exported');

    // An analysis PDF about another Marine, drawn while the reader leaves G8: refused at delivery, nothing audited. (Sato's
    // G8 role leads again, as it stands by default, so G8's Marines are theirs to report on.)
    on.ctx.db.prepare("UPDATE roles SET position = ? WHERE id = 'G8:snco'").run(position);
    const analysis = `/api/reports/analysis.pdf?${new URLSearchParams({ user_id: diaz.id, unit_id: 'G8', period: 'all' })}`;
    const pdfs = audited(on, 'export_pdf');
    assert.equal((await download(analysis)).status, 200);
    assert.equal(audited(on, 'export_pdf'), pdfs + 1);
    const g8 = seatOf(on, sato.id, 'G8');
    const analysing = holdPdf();
    const report = download(analysis);
    await analysing.seen;
    assert.equal(await unanswered(report), true);
    g8.leave();
    analysing.release();
    assert.equal((await report).status, 403);
    assert.equal(audited(on, 'export_pdf'), pdfs + 1);
    g8.back();

    // A counseling the reader opens through the unit, drawn while they leave it: refused at delivery, nothing audited.
    const counseling = await on.call('POST', '/api/records/counselings', { token: diaz.token, body: { date: '2026-09-01', type: 'monthly', summary: 'Shared notes', visibility: 'unit', unit_id: 'G8' } });
    assert.equal(counseling.status, 201, JSON.stringify(counseling.body));
    const worksheet = `/api/records/counselings/${counseling.body.id}/export?format=pdf`;
    const records = audited(on, 'export_record');
    assert.equal((await download(worksheet)).status, 200, 'the control: it is theirs to read through G8');
    assert.equal(audited(on, 'export_record'), records + 1);
    const sheet = holdPdf();
    const pending = download(worksheet);
    await sheet.seen;
    assert.equal(await unanswered(pending), true);
    g8.leave();
    sheet.release();
    assert.equal((await pending).status, 403);
    assert.equal(audited(on, 'export_record'), records + 1);
    g8.back();
  } finally { await on.close(); }
});

test('a backup copy or a course catalog that waited leaves or is staged only for a session still live, confirmed and allowed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-stage1-'));
  const clamd = await fakeClamd();
  const on = await startApp({ VANTAGE_DB: join(dir, 'vantage.db'), VANTAGE_CLAMD: clamd.address });
  const db = on.ctx.db as unknown as { backup: (dest: string) => Promise<unknown> };
  const realBackup = db.backup.bind(on.ctx.db);
  try {
    const op = await on.setupOperator();
    const fresh = async () => (await on.login('boletz')).body.token as string;
    const copies = () => readdirSync(tmpdir()).filter((f) => f.startsWith('vantage-backup-')).length;
    const backups = () => audited(on, 'backup');
    /** A backup on `token` whose copying is held while `meanwhile` runs. */
    async function heldBackup(token: string, meanwhile: () => void) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let arrived!: () => void;
      const seen = new Promise<void>((r) => { arrived = r; });
      db.backup = async (dest: string) => { db.backup = realBackup; arrived(); await gate; return realBackup(dest); };
      const pending = on.call('GET', '/api/platform/backup', { token, binary: true });
      await seen;
      meanwhile();
      release();
      return pending;
    }
    const platformRoles = on.ctx.db.prepare('SELECT * FROM platform_roles WHERE user_id = ?').all(op.id) as Array<Record<string, unknown>>;
    assert.ok(platformRoles.length);
    const restoreRoles = () => { for (const r of platformRoles) on.ctx.db.prepare(`INSERT OR IGNORE INTO platform_roles (${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`).run(...Object.values(r) as never[]); };

    // A second Lead Vantage Administrator is told of each backup downloaded, and only of those.
    const peer = await on.register('peerlead');
    on.ctx.db.prepare("INSERT INTO platform_roles (user_id, role, granted_by, created_at) VALUES (?, 'owner', ?, ?)").run(peer.id, op.id, new Date().toISOString());
    const told = () => count(on, "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE '%downloaded a full database backup'", peer.id);
    const before = { copies: copies(), backups: backups(), told: told() };
    const ok = await heldBackup(await fresh(), () => {});
    assert.equal(ok.status, 200, 'the control: a copy made with nothing changed downloads');
    assert.ok(ok.buffer!.subarray(0, 16).toString('latin1').startsWith('SQLite format 3'));
    assert.equal(backups(), before.backups + 1);
    assert.equal(told(), before.told + 1, 'the other Lead Vantage Administrator is told');

    const signedOut = await fresh();
    const ended = await heldBackup(signedOut, () => { on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(signedOut)); });
    assert.equal(ended.status, 401);
    const lapsed = await fresh();
    const unconfirmed = await heldBackup(lapsed, () => { on.ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id = ?').run(past(), sessionDigest(lapsed)); });
    assert.equal(unconfirmed.status, 403);
    assert.equal(unconfirmed.buffer && JSON.parse(unconfirmed.buffer.toString('utf8')).code, 'sudo_required');
    const demoted = await heldBackup(await fresh(), () => { on.ctx.db.prepare('DELETE FROM platform_roles WHERE user_id = ?').run(op.id); });
    restoreRoles();
    assert.equal(demoted.status, 403);
    assert.equal(JSON.parse(demoted.buffer!.toString('utf8')).code, 'access_changed');
    for (const refused of [ended, unconfirmed, demoted]) assert.ok(!refused.buffer!.subarray(0, 16).toString('latin1').startsWith('SQLite format 3'), 'no database bytes leave');
    assert.equal(backups(), before.backups + 1, 'no refused copy is recorded or audited');
    assert.equal(told(), before.told + 1, 'and nobody is told it was downloaded');
    assert.equal(copies(), before.copies, 'and no copy is left behind');

    // A course catalog staged while the scanner has it: kept only if the session that sent it still stands.
    const source = await on.call('POST', '/api/platform/course-sources', { token: op.token, body: { name: 'MarineNet course catalog', authority: 'TECOM, College of Distance Education and Training', approval_reference: 'G-8 memo 1500 of 2026-09-30', approved_by: 'Comptroller, G-8', approved_on: '2026-09-30' } });
    assert.equal(source.status, 201, JSON.stringify(source.body));
    const loads = () => count(on, 'SELECT COUNT(*) AS n FROM course_catalog_loads');
    const stage = (token: string) => on.call('POST', `/api/platform/course-sources/${source.body.id}/import?as_of=2026-10-01`, { token, raw: Buffer.from('Course Number,Course Title,Contact Hours\r\nFIN-201,Fiscal Law Fundamentals,12.5\r\n'), headers: { 'content-type': 'text/csv', 'x-filename': 'catalog.csv' } });
    async function whileScanning(token: string, meanwhile: () => void) {
      const gate = clamd.gate();
      const sending = stage(token);
      await gate.seen;
      assert.equal(await unanswered(sending), true, 'the scanner holds the catalog');
      meanwhile();
      gate.release();
      return sending;
    }
    const staged = loads();
    assert.equal((await whileScanning(await fresh(), () => {})).status, 201, 'the control');
    assert.equal(loads(), staged + 1);
    const idle = await fresh();
    assert.equal((await whileScanning(idle, () => { on.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(past(), sessionDigest(idle)); })).status, 401);
    const gone = await fresh();
    assert.equal((await whileScanning(gone, () => { on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(gone)); })).status, 401);
    const unseated = await whileScanning(await fresh(), () => { on.ctx.db.prepare('DELETE FROM platform_roles WHERE user_id = ?').run(op.id); });
    restoreRoles();
    assert.equal(unseated.status, 403);
    assert.equal(loads(), staged + 1, 'nothing was staged for a session that ended or a role that went');
  } finally { db.backup = realBackup; clamd.close(); await on.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an AI answer drawn from others’ records reaches only a reader still signed in who may still read them', async () => {
  let gate: { reached: () => void; release: Promise<void> } | null = null;
  const mock = await mockGenAi(async (body) => {
    const hold = gate;
    gate = null;
    if (hold) { hold.reached(); await hold.release; }
    const brief = { executive_summary: 'A brief for the commander.', highlights: [], watch_items: [], recommended_questions: [], caveats: [] };
    return { json: { model: body.model, choices: [{ message: { content: JSON.stringify(brief) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } };
  });
  const on = await startApp({ VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'test-key-123', VANTAGE_GENAI_BASE_URL: mock.url, VANTAGE_GENAI_MODELS: 'model-fast' });
  try {
    const op = await on.setupOperator();
    let sato = await person(on, op, 'sato', [['G8', 'snco']], { rank_id: 'SSgt', last_name: 'Sato' });
    const roles = rolesOf(on, sato.id);
    const brief = (token: string) => on.call('POST', '/api/ai/assist', { token, body: { workflow: 'command_brief', input: { unit_id: 'G8' } } });
    async function heldBrief(token: string, meanwhile: () => void) {
      let reached!: () => void;
      const there = new Promise<void>((r) => { reached = r; });
      let release!: () => void;
      gate = { reached, release: new Promise<void>((r) => { release = r; }) };
      const pending = brief(token);
      await there;
      meanwhile();
      release();
      return pending;
    }
    const assists = audited(on, 'ai_assist');
    const ok = await heldBrief(sato.token, () => {});
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(audited(on, 'ai_assist'), assists + 1);

    // The role that let them brief the unit is taken away while the provider answers: the answer is not handed back.
    const demoted = await heldBrief(sato.token, roles.remove);
    roles.restore();
    assert.equal(demoted.status, 403, JSON.stringify(demoted.body));
    assert.doesNotMatch(JSON.stringify(demoted.body), /brief for the commander/);
    // The session ends while it answers: a 401.
    const ended = await heldBrief(sato.token, () => { on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionDigest(sato.token)); });
    assert.equal(ended.status, 401);
    sato = { ...sato, token: (await on.login('sato')).body.token };
    assert.equal(audited(on, 'ai_assist'), assists + 1, 'no answer withheld is audited as given');
  } finally { await on.close(); mock.close(); }
});

/**
 * A software authenticator: a 'none' attestation for a new P-256 key, answering the registration options Vantage gave,
 * as a browser on the application's own address would send it.
 */
function softwareRegistration(on: TestApp, challenge: string) {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cosePublicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const credentialId = crypto.randomBytes(16);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(credentialId.length);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(on.ctx.config.rpId).digest(),
    Buffer.from([0x45]), // user present, user verified, attested credential data
    Buffer.alloc(4), Buffer.alloc(16), length, credentialId, Buffer.from(cosePublicKey),
  ]);
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: on.ctx.config.urls.app, crossOrigin: false }));
  const id = credentialId.toString('base64url');
  return {
    id, rawId: id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
    response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: Buffer.from(attestationObject).toString('base64url'), transports: ['internal'] },
  };
}

test('a passkey whose answer was being verified is added only to a session still live, under its epoch and still confirmed (F04, C04)', async () => {
  const on = await startApp();
  const subtle = globalThis.crypto.subtle as unknown as { digest: (...args: unknown[]) => Promise<ArrayBuffer> };
  const realDigest = subtle.digest;
  try {
    await on.setupOperator();
    const lane = await on.register('lane');
    const passkeys = () => count(on, 'SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', lane.id);
    const added = () => audited(on, 'passkey_added');
    /** Adds a passkey on a confirmed session, holding the answer's verification while `meanwhile` runs. */
    async function addWhileVerifying(meanwhile: (sessionId: string) => void) {
      const s = createSession(on.ctx, lane.id, { method: 'password', sudo: true });
      const options = await on.call('POST', '/api/me/passkeys/options', { token: s.token, body: {} });
      assert.equal(options.status, 200, JSON.stringify(options.body));
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let arrived!: () => void;
      const seen = new Promise<void>((r) => { arrived = r; });
      subtle.digest = async (...args: unknown[]) => { subtle.digest = realDigest; arrived(); await gate; return realDigest.apply(globalThis.crypto.subtle, args); };
      const pending = on.call('POST', '/api/me/passkeys', { token: s.token, body: { response: softwareRegistration(on, options.body.challenge), name: 'Laptop' } });
      await seen;
      meanwhile(s.id);
      release();
      return pending;
    }
    const before = { passkeys: passkeys(), added: added() };

    // The control: nothing changes while the answer is verified, and the passkey is added.
    const ok = await addWhileVerifying(() => {});
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual({ passkeys: passkeys(), added: added() }, { passkeys: before.passkeys + 1, added: before.added + 1 });

    // The session that asked is signed out, its confirmation runs out, or it signs the others out (a newer epoch) meanwhile.
    const ended = await addWhileVerifying((id) => { on.ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id); });
    assert.equal(ended.status, 401, JSON.stringify(ended.body));
    const lapsed = await addWhileVerifying((id) => { on.ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id = ?').run(past(), id); });
    assert.equal(lapsed.status, 403);
    assert.equal(lapsed.body.code, 'sudo_required');
    const moved = await addWhileVerifying((id) => { invalidateUserSessions(on.ctx, lane.id, id); });
    assert.equal(moved.status, 403);
    assert.equal(moved.body.code, 'credentials_changed');
    assert.deepEqual({ passkeys: passkeys(), added: added() }, { passkeys: before.passkeys + 1, added: before.added + 1 }, 'no passkey was added, and none audited');
  } finally { subtle.digest = realDigest; await on.close(); }
});
