import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { loadConfig } from '../../server/config.ts';
import { openDatabase } from '../../server/db/index.ts';
import { addMember } from '../../server/services/org.ts';
import { signInMethods } from '../../server/services/deployment.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';

/**
 * Task 3: one identity, many memberships (ADR-0009). A Marine's account is the same account for a whole career: its id,
 * its EDIPI, its sign-in methods and its records stay put while the units it belongs to change, and every one of those
 * changes is kept as history. What changes the identity itself (the EDIPI a card signs in with, the profile every Unit
 * Instance reads, the lock on a shared account) is governed once, not by whichever instance asks first.
 */

let app: TestApp;
let op: { token: string; id: string };
let g1lead: { token: string; id: string };
/** Transfers from G8 to G1 by invitation. */
let hale: { token: string; id: string };
/** Serves in both instances, primary in G8. */
let reyes: { token: string; id: string };
let g8marine: { token: string; id: string };
let g1marine: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;

interface Period { unit_id: string; billet: string | null; is_primary: number; started_at: string; ended_at: string | null; start_reason: string | null; end_reason: string | null; started_by: string | null; ended_by: string | null }
const periods = (userId: string, unitId?: string) => app.ctx.db.prepare(`SELECT unit_id, billet, is_primary, started_at, ended_at, start_reason, end_reason, started_by, ended_by FROM unit_membership_periods
  WHERE user_id = ? ${unitId ? 'AND unit_id = ?' : ''} ORDER BY id`).all(...[userId, ...(unitId ? [unitId] : [])]) as Period[];
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const auditCount = (action: string, subject: string) => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND subject_id = ?').get(action, subject) as { n: number }).n;
const notified = (userId: string, pattern: RegExp) => (app.ctx.db.prepare('SELECT title FROM notifications WHERE user_id = ?').all(userId) as Array<{ title: string }>).some((n) => pattern.test(n.title));
const dropSudo = (userId: string) => app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL WHERE user_id = ?').run(userId);

before(async () => {
  app = await startApp();
  op = await app.setupOperator();

  g1lead = await app.register('g1lead', { email: 'g1lead@example.mil' });
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');

  for (const [token, body] of [
    [op.token, { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' }],
    [op.token, { name: 'G8 Budget', short_name: 'BUDGET', code: 'budget', parent_id: 'G8' }],
    [g1lead.token, { name: 'G1 Manpower', short_name: 'MANPOWER', code: 'manpower', parent_id: 'G1' }],
  ] as const) assert.equal((await post(token, '/api/org/units', body)).status, 201);

  hale = await app.register('hale', { email: 'hale@example.mil' });
  const code = await post(op.token, '/api/org/units/FISCAL/join-codes', {});
  assert.equal(code.status, 201, JSON.stringify(code.body));
  assert.equal((await post(hale.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`)).status, 200);
  hale.token = await login('hale');

  reyes = await app.register('reyes');
  await enroll(app, op.token, 'G8', reyes.id, 'sncoic');
  await enroll(app, g1lead.token, 'G1', reyes.id, 'sncoic');
  reyes.token = await login('reyes');

  g8marine = await app.register('g8marine');
  await enroll(app, op.token, 'FISCAL', g8marine.id);
  g1marine = await app.register('g1marine');
  await enroll(app, g1lead.token, 'MANPOWER', g1marine.id);
});
after(async () => { await app.close(); });

test('every membership change is kept as history: who, when and why, with one period per stretch and no re-shuffles', async () => {
  const joined = periods(hale.id, 'FISCAL');
  assert.equal(joined.length, 1);
  assert.equal(joined[0].start_reason, 'join_code');
  assert.equal(joined[0].started_by, op.id, 'the person whose code it was');
  assert.equal(joined[0].is_primary, 1, 'a first unit is the primary unit');
  assert.equal(joined[0].ended_at, null);

  // A billet change closes one period and opens the next, both naming the leader who made it.
  assert.equal((await put(op.token, `/api/org/units/FISCAL/members/${g8marine.id}`, { billet: 'Disbursing Clerk' })).status, 200);
  const billet = periods(g8marine.id, 'FISCAL');
  assert.equal(billet.length, 2);
  assert.deepEqual([billet[0].end_reason, billet[0].ended_by, billet[1].start_reason, billet[1].started_by, billet[1].billet], ['billet_changed', op.id, 'billet_changed', op.id, 'Disbursing Clerk']);
  // Saving the same billet again, or seating them where they already are, is no change.
  assert.equal((await put(op.token, `/api/org/units/FISCAL/members/${g8marine.id}`, { billet: 'Disbursing Clerk' })).status, 200);
  addMember(app.ctx, g8marine.id, 'FISCAL', { invitedBy: op.id, reason: 'enrolled' });
  assert.equal(periods(g8marine.id, 'FISCAL').length, 2);

  // A move inside the instance ends one membership and starts the other as a transfer; the primary unit passes straight across.
  const moved = await post(op.token, `/api/org/units/FISCAL/members/${g8marine.id}/move`, { to: 'BUDGET' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const fiscal = periods(g8marine.id, 'FISCAL');
  assert.equal(fiscal.length, 2, 'the move is one end, not a primary-unit shuffle and then an end');
  assert.deepEqual([fiscal[1].end_reason, fiscal[1].ended_by], ['transfer', op.id]);
  assert.ok(fiscal[1].ended_at);
  const budget = periods(g8marine.id, 'BUDGET');
  assert.equal(budget.length, 1);
  assert.deepEqual([budget[0].start_reason, budget[0].started_by, budget[0].is_primary, budget[0].billet, budget[0].ended_at], ['transfer', op.id, 1, 'Disbursing Clerk', null]);

  // The new team's leader reads the history in units they can open: not the sibling team the Marine came from.
  const lead = await app.register('budgetlead');
  await enroll(app, op.token, 'BUDGET', lead.id, 'sncoic');
  const view = await get(await login('budgetlead'), `/api/org/team/${g8marine.id}`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.deepEqual([...new Set((view.body.history as Period[]).map((p) => p.unit_id))], ['BUDGET']);
  const command = await get(op.token, `/api/org/team/${g8marine.id}`);
  assert.deepEqual([...new Set((command.body.history as Period[]).map((p) => p.unit_id))].sort(), ['BUDGET', 'FISCAL'], 'the command above both reads both');
});

test('a Marine who transfers to another Unit Instance keeps one account, one EDIPI and their record; only the memberships change', async () => {
  // G8 links Hale's card while Hale serves only in G8.
  assert.equal((await post(op.token, '/api/orgs/G8/personnel/link', { user_id: hale.id, edipi: '4445556667' })).status, 200);
  assert.equal((await get(hale.token, '/api/me')).status, 401, 'a changed sign-in key ends the sessions opened under the old one');
  hale.token = await login('hale');
  const logged = await post(hale.token, '/api/records/activities', { title: 'Closed out FY26 ULOs', date: '2026-09-15', visibility: 'unit', unit_id: 'FISCAL' });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));

  // G1 invites the address Hale already uses. Inviting an existing address is allowed, and says nothing about it.
  const invite = await post(g1lead.token, '/api/org/units/MANPOWER/invites', { email: 'hale@example.mil', billet: 'Pay Clerk' });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const token = tokenOf(invite.body.url);

  // A second account for the same person is refused: it would split their record in two.
  const second = await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'hale2', password: PASSWORD, first_name: 'Sam', last_name: 'Hale' } });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'account_exists');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM users WHERE username = 'hale2'").get(), undefined);

  // Hale accepts with the account they have. The primary unit stays with G8 until G8 lets them go.
  const claimed = await post(hale.token, '/api/auth/invite/claim', { token });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.deepEqual([claimed.body.unit_id, claimed.body.primary], ['MANPOWER', false]);
  assert.equal((await post(hale.token, '/api/auth/invite/claim', { token })).status, 400, 'an invitation works once');
  const opened = periods(hale.id, 'MANPOWER');
  assert.deepEqual([opened.length, opened[0].start_reason, opened[0].started_by, opened[0].billet, opened[0].is_primary], [1, 'invitation', g1lead.id, 'Pay Clerk', 0]);

  // G8 releases them. Their record stays theirs, frozen in G8; the primary unit moves to the command they now serve in.
  assert.equal((await app.call('DELETE', `/api/org/units/FISCAL/members/${hale.id}`, { token: op.token })).status, 200);
  const account = app.ctx.db.prepare('SELECT id, edipi, username, email FROM users WHERE id = ?').get(hale.id);
  assert.deepEqual(account, { id: hale.id, edipi: '4445556667', username: 'hale', email: 'hale@example.mil' }, 'the same account, the same EDIPI');
  const record = app.ctx.db.prepare('SELECT user_id, unit_id, frozen_at FROM activities WHERE id = ?').get(logged.body.id) as { user_id: string; unit_id: string; frozen_at: string | null };
  assert.deepEqual([record.user_id, record.unit_id], [hale.id, 'FISCAL']);
  assert.ok(record.frozen_at, 'what they shared with G8 stays with G8, frozen');
  const fiscal = periods(hale.id, 'FISCAL');
  assert.deepEqual([fiscal.at(-1)!.end_reason, fiscal.at(-1)!.ended_by], ['removed', op.id]);
  const manpower = periods(hale.id, 'MANPOWER');
  assert.equal(manpower.at(-1)!.is_primary, 1, 'MANPOWER is the primary unit now');
  assert.equal(manpower.at(-1)!.ended_at, null);

  // Each side reads its own part of the history. Hale reads all of it.
  hale.token = await login('hale');
  const own = await get(hale.token, `/api/org/team/${hale.id}`);
  assert.deepEqual([...new Set((own.body.history as Period[]).map((p) => p.unit_id))].sort(), ['FISCAL', 'MANPOWER']);
  const g1view = await get(g1lead.token, `/api/org/team/${hale.id}`);
  assert.equal(g1view.status, 200);
  assert.ok((g1view.body.history as Period[]).length > 0);
  assert.ok((g1view.body.history as Period[]).every((p) => p.unit_id === 'MANPOWER'), 'G1 does not learn where Hale served before');
  const g1history = await get(g1lead.token, `/api/orgs/G1/members/${hale.id}/history`);
  assert.ok(g1history.body.history.every((p: Period) => p.unit_id === 'MANPOWER'));
  const g8history = await get(op.token, `/api/orgs/G8/members/${hale.id}/history`);
  assert.equal(g8history.status, 200, 'a former member’s history is still the instance’s to read');
  assert.ok(g8history.body.history.length && g8history.body.history.every((p: Period) => p.unit_id === 'FISCAL'), 'and only its own part of it');
  assert.equal((await get(g1lead.token, `/api/orgs/G8/members/${hale.id}/history`)).status, 404, 'another instance’s history is not found');
  assert.equal((await get(op.token, `/api/orgs/G8/members/${g1marine.id}/history`)).status, 404, 'nor is a person who never served there');

  // The personal archive carries the whole history.
  const archive = await app.call('GET', '/api/me/export?format=json', { token: hale.token });
  assert.equal(archive.status, 200);
  assert.deepEqual([...new Set((archive.body.membership_history as Period[]).map((p) => p.unit_id))].sort(), ['FISCAL', 'MANPOWER']);
});

test('an invitation is accepted only by the account holding its address, once, and never as a way into records for its sender', async () => {
  const lead = await login('g1lead');
  const forOther = await post(lead, '/api/org/units/MANPOWER/invites', { email: 'someone.else@example.mil' });
  assert.equal(forOther.status, 201);
  const wrong = await post(await login('g8marine'), '/api/auth/invite/claim', { token: tokenOf(forOther.body.url) });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'invite_other_account');

  const link = await post(lead, '/api/org/units/MANPOWER/invites', {});
  const already = await post(await login('g1marine'), '/api/auth/invite/claim', { token: tokenOf(link.body.url) });
  assert.equal(already.status, 409);
  assert.equal(already.body.code, 'already_member');

  // Joining another command widens who governs the account, so it asks for a recent sign-in or confirmation.
  const g8 = await login('g8marine');
  dropSudo(g8marine.id);
  const unconfirmed = await post(g8, '/api/auth/invite/claim', { token: tokenOf(link.body.url) });
  assert.equal(unconfirmed.status, 403);
  assert.equal(unconfirmed.body.code, 'sudo_required');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'MANPOWER'").get(g8marine.id), undefined);

  // An organization administrator invites people into roles that read records; accepting their own invitation is not how they get one.
  const rivera = await app.register('rivera', { email: 'rivera@example.mil' });
  await enroll(app, op.token, 'G8', rivera.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: rivera.id, role: 'admin' })).status, 201);
  const riveraToken = await login('rivera');
  const own = await post(riveraToken, '/api/org/units/BUDGET/invites', { email: 'rivera@example.mil', role_id: 'BUDGET:snco' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const self = await post(riveraToken, '/api/auth/invite/claim', { token: tokenOf(own.body.url) });
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'self_grant');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'BUDGET'").get(rivera.id), undefined, 'and nothing was half-done');
});

test('an EDIPI proven by the person’s own card is their sign-in key: no Unit Instance moves it, Vantage support corrects it on the record', async () => {
  const link = (token: string, userId: string, edipi: string | null) => post(token, '/api/orgs/G8/personnel/link', { user_id: userId, edipi });
  assert.equal((await link(op.token, g8marine.id, '1112223334')).status, 200);
  assert.ok(notified(g8marine.id, /A CAC was linked to your account/), 'the person is told a card now signs in as them');
  // Typed in by an administrator, it is not proven yet, so it can still be corrected here.
  assert.equal((await link(op.token, g8marine.id, '1112223335')).status, 200);
  assert.equal((app.ctx.db.prepare('SELECT edipi FROM users WHERE id = ?').get(g8marine.id) as { edipi: string }).edipi, '1112223335');

  // Their card signs in once: the EDIPI is proven, and the organization can no longer move or clear it.
  app.ctx.db.prepare('UPDATE users SET edipi_verified_at = ? WHERE id = ?').run(new Date().toISOString(), g8marine.id);
  for (const next of ['9990001112', null]) {
    const moved = await link(op.token, g8marine.id, next);
    assert.equal(moved.status, 403, `changing a proven EDIPI to ${next}`);
    assert.equal(moved.body.code, 'edipi_verified');
  }
  // Not even on the administrator's own account: freeing their card's EDIPI is how they would hand it to another account.
  app.ctx.db.prepare("UPDATE users SET edipi = '7778889990', edipi_verified_at = ? WHERE id = ?").run(new Date().toISOString(), op.id);
  assert.equal((await link(op.token, op.id, null)).body.code, 'edipi_verified');
  // An account with authority in another instance is not re-keyed from here at all.
  assert.equal((await link(op.token, reyes.id, '5556667778')).body.code, 'cross_instance');

  // Vantage support corrects it, with a reason, and the person's sessions end.
  const correct = (token: string, userId: string, body: unknown) => post(token, `/api/platform/accounts/${userId}/edipi`, body);
  const why = 'Card reissued after a DEERS correction';
  assert.equal((await correct(op.token, g8marine.id, { edipi: '9990001112', reason: 'short' })).status, 400, 'a reason is required');
  assert.equal((await correct(op.token, g8marine.id, { edipi: '12345', reason: why })).status, 400);
  assert.equal((await correct(op.token, g8marine.id, { edipi: '7778889990', reason: why })).status, 400, 'an EDIPI another account carries');
  assert.equal((await correct(await login('g1lead'), g8marine.id, { edipi: '9990001112', reason: why })).status, 403, 'only Vantage staff');
  const g8 = await login('g8marine');
  const fixed = await correct(op.token, g8marine.id, { edipi: '9990001112', reason: why });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.changed, true);
  assert.ok(fixed.body.sessionsRevoked >= 1);
  assert.equal((await get(g8, '/api/me')).status, 401, 'the sessions under the old key are gone');
  assert.deepEqual(app.ctx.db.prepare('SELECT edipi, edipi_verified_at FROM users WHERE id = ?').get(g8marine.id), { edipi: '9990001112', edipi_verified_at: null }, 'unproven until the new card signs in');
  assert.equal(auditCount('edipi_corrected', g8marine.id), 1);
  assert.ok(notified(g8marine.id, /Vantage support changed the CAC/));
  const listed = await get(op.token, '/api/platform/accounts?q=g8marine');
  assert.equal(listed.status, 200);
  assert.ok(JSON.stringify(listed.body).includes('9990001112'), 'the admin dashboard shows the link it governs');
});

test('a shared account is governed once: no single Unit Instance unlocks it or rewrites its profile, and every one hears what another did', async () => {
  const g1 = await login('g1lead');
  // Unlocking lets guessing start again. On an account that also leads in G8 that is not G1's to allow.
  const unlock = await post(g1, `/api/orgs/G1/members/${reyes.id}/unlock`);
  assert.equal(unlock.status, 403);
  assert.equal(unlock.body.code, 'cross_instance');
  assert.equal((await post(g1, `/api/orgs/G1/members/${g1marine.id}/unlock`)).status, 200, 'an account only G1 governs, G1 unlocks');

  // Ending sessions only protects the account, so either instance may; the other one is told in its own audit log.
  const out = await post(g1, `/api/orgs/G1/members/${reyes.id}/logout`);
  assert.equal(out.status, 200);
  const notice = app.ctx.db.prepare("SELECT actor_id, org_id, detail FROM audit_log WHERE action = 'shared_account_notice' AND subject_id = ?").all(reyes.id) as Array<{ actor_id: string | null; org_id: string; detail: string }>;
  assert.deepEqual(notice.map((n) => [n.actor_id, n.org_id]), [[null, 'G8']]);
  assert.doesNotMatch(notice[0].detail, /G1|g1lead/i, 'it says what was done, not which instance or who');
  assert.ok(notified(reyes.id, /signed you out everywhere/));

  // The profile is kept by the instance that holds the primary unit, G8. G1 leads Reyes too, and still cannot rewrite it.
  const g1edit = await put(g1, `/api/org/team/${reyes.id}/profile`, { rank_id: 'GySgt' });
  assert.equal(g1edit.status, 403);
  assert.equal(g1edit.body.code, 'cross_instance');
  assert.equal((await put(op.token, `/api/org/team/${reyes.id}/profile`, { rank_id: 'SSgt' })).status, 200);
  const rank = () => (app.ctx.db.prepare('SELECT rank_id FROM users WHERE id = ?').get(reyes.id) as { rank_id: string }).rank_id;
  assert.equal(rank(), 'SSgt');

  // The same rule holds for the personnel feeds: G1's extract does not overwrite what G8's keeps.
  app.ctx.db.prepare("UPDATE users SET edipi = '5550001111' WHERE id = ?").run(reyes.id);
  const sync = (token: string, org: string, grade: string) => app.call('POST', `/api/orgs/${org}/personnel/sync?source=MCTFS&apply=1`, {
    token, raw: Buffer.from(`DoD ID,Last,First,MI,Grade,PMOS,EAS,RUC,Status\n5550001111,Reyes,Pat,,${grade},3451,2028-01-31,${org},Active`), headers: { 'content-type': 'text/plain' },
  });
  const fromG1 = await sync(g1, 'G1', 'GySgt');
  assert.equal(fromG1.status, 200, JSON.stringify(fromG1.body));
  assert.equal(rank(), 'SSgt', 'the secondary instance’s feed leaves it');
  const fromG8 = await sync(op.token, 'G8', 'MSgt');
  assert.equal(fromG8.status, 200, JSON.stringify(fromG8.body));
  assert.equal(rank(), 'MSgt', 'the home instance’s feed keeps it');
});

test('an instance archive carries the membership history, and history keeps being written after it loads', async () => {
  const archive = exportInstance(app.ctx) as Parameters<typeof importInstance>[1] & { tables: Record<string, unknown[]> };
  const count = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM unit_membership_periods').get() as { n: number }).n;
  assert.equal(archive.tables.unit_membership_periods.length, count);
  const fresh = await startApp();
  try {
    const freshOp = await fresh.setupOperator();
    importInstance(fresh.ctx, archive, freshOp.id);
    const columns = 'user_id, unit_id, billet, is_primary, started_at, ended_at, start_reason, end_reason, started_by, ended_by';
    assert.deepEqual(
      fresh.ctx.db.prepare(`SELECT ${columns} FROM unit_membership_periods ORDER BY id`).all(),
      app.ctx.db.prepare(`SELECT ${columns} FROM unit_membership_periods ORDER BY id`).all(),
      'the history comes back as it was, not re-derived',
    );
    const orphans = fresh.ctx.db.prepare('SELECT COUNT(*) AS n FROM unit_members um WHERE NOT EXISTS (SELECT 1 FROM unit_membership_periods p WHERE p.user_id = um.user_id AND p.unit_id = um.unit_id AND p.ended_at IS NULL)').get() as { n: number };
    assert.equal(orphans.n, 0, 'every membership has its open period');
    addMember(fresh.ctx, g1marine.id, 'BUDGET', { invitedBy: null, reason: 'enrolled' });
    const written = fresh.ctx.db.prepare("SELECT start_reason FROM unit_membership_periods WHERE user_id = ? AND unit_id = 'BUDGET'").get(g1marine.id) as { start_reason: string } | undefined;
    assert.equal(written?.start_reason, 'enrolled', 'the history is written again once loaded');
  } finally { await fresh.close(); }
});

// ——— CAC step-up ———

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, '../fixtures', name), 'utf8');
const CARD = fixture('cac-user.pem');      // EDIPI 1234567890 (synthetic)
const OTHER_CARD = fixture('other.pem');   // EDIPI 9998887770 (synthetic)
const SECRET = 'proxy-secret-proxy-secret-proxy-secret';
const asProxy = (pem: string) => ({ 'x-client-cert': encodeURIComponent(pem), 'x-client-verify': 'SUCCESS', 'x-cac-proxy-secret': SECRET });

test('a linked card confirms a sensitive change in place of a password; somebody else’s card, or no linked card, does not', async () => {
  const cac = await startApp({ CAC_MODE: 'proxy', CAC_PROXY_SECRET: SECRET });
  try {
    const owner = await cac.setupOperator();
    const marine = await cac.register('cardless');
    cac.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(owner.id);
    cac.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
    const stepUp = (token: string, headers: Record<string, string> = {}) => cac.call('POST', '/api/auth/cac/step-up', { token, headers });
    const refusals = () => (cac.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'cac_step_up_refused'").get() as { n: number }).n;

    assert.deepEqual((await cac.call('GET', '/api/me', { token: owner.token })).body.session.stepUp, ['password', 'cac'], 'the dialog offers both');
    assert.deepEqual((await cac.call('GET', '/api/me', { token: marine.token })).body.session.stepUp, ['password']);

    const none = await stepUp(owner.token);
    assert.deepEqual([none.status, none.body.code], [403, 'cac_no_certificate'], 'refusals are 403, so the browser stays signed in');
    const forged = await stepUp(owner.token, { 'x-client-cert': encodeURIComponent(CARD), 'x-client-verify': 'SUCCESS' });
    assert.deepEqual([forged.status, forged.body.code], [403, 'cac_no_certificate'], 'a certificate header without the proxy secret is no card');
    const other = await stepUp(owner.token, asProxy(OTHER_CARD));
    assert.deepEqual([other.status, other.body.code], [403, 'cac_mismatch']);
    const unlinked = await stepUp(marine.token, asProxy(CARD));
    assert.deepEqual([unlinked.status, unlinked.body.code], [403, 'cac_unlinked']);
    assert.equal(refusals(), 2, 'a card that is not theirs is on the audit trail');
    assert.equal((cac.ctx.db.prepare('SELECT sudo_until FROM sessions WHERE user_id = ?').get(owner.id) as { sudo_until: string | null }).sudo_until, null, 'nothing was granted');

    const ok = await stepUp(owner.token, asProxy(CARD));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(Date.parse(ok.body.until) > Date.now());
    assert.ok((cac.ctx.db.prepare('SELECT edipi_verified_at FROM users WHERE id = ?').get(owner.id) as { edipi_verified_at: string | null }).edipi_verified_at, 'the card proved the EDIPI');
    assert.equal((cac.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'cac_step_up' AND actor_id = ?").get(owner.id) as { n: number }).n, 1);
    assert.equal((await cac.call('GET', '/api/platform/accounts', { token: owner.token })).status, 200, 'a step-up the card gave opens what a password would');
  } finally { await cac.close(); }

  const off = await startApp();
  try {
    const owner = await off.setupOperator();
    assert.equal((await off.call('POST', '/api/auth/cac/step-up', { token: owner.token, headers: asProxy(CARD) })).status, 404, 'absent unless the instance turns cards on');
  } finally { await off.close(); }
});

test('where only a card signs in, every password path is closed: reset, invitation sign-up, password step-up', async () => {
  const cac = await startApp({ CAC_MODE: 'proxy', CAC_PROXY_SECRET: SECRET, CAC_EXCLUSIVE: 'true' });
  try {
    const owner = await cac.setupOperator();
    cac.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(owner.id);
    const refused = async (path: string, body: unknown, token?: string) => {
      const res = await cac.call('POST', path, { body, token });
      assert.deepEqual([res.status, res.body?.code], [403, 'cac_required'], path);
    };
    await refused('/api/auth/forgot', { identifier: 'boletz' });
    await refused('/api/auth/reset', { token: 'x'.repeat(40), password: PASSWORD });
    const invite = await cac.call('POST', '/api/org/units/G8/invites', { token: owner.token, body: { email: 'new.marine@example.mil' } });
    assert.equal(invite.status, 201);
    await refused('/api/auth/invite/accept', { token: tokenOf(invite.body.url), username: 'newmarine', password: PASSWORD, first_name: 'New', last_name: 'Marine' });
    await refused('/api/auth/sudo', { password: PASSWORD }, owner.token);
    assert.deepEqual((await cac.call('GET', '/api/me', { token: owner.token })).body.session.stepUp, ['cac'], 'the dialog offers the card alone');
    assert.equal(cac.ctx.db.prepare("SELECT 1 FROM tokens WHERE kind = 'reset'").get(), undefined, 'no reset link was issued');
    assert.equal(signInMethods(cac.ctx.config).password, false);
  } finally { await cac.close(); }
});

// ——— Test sign-in kept out of production ———

test('the test suite’s token sign-in needs both test settings, and the MCEN profile runs only as production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'development', VANTAGE_TEST: '1' } as NodeJS.ProcessEnv), /VANTAGE_TEST=1 is for the test suite only/);
  assert.throws(() => loadConfig({ VANTAGE_TEST: '1' } as NodeJS.ProcessEnv), /needs NODE_ENV=test/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', VANTAGE_TEST: '1', VANTAGE_SECRET: 's'.repeat(40) } as NodeJS.ProcessEnv), /never be enabled in production/);
  assert.throws(() => loadConfig({ VANTAGE_DEPLOYMENT_PROFILE: 'mcen' } as NodeJS.ProcessEnv), /mcen needs NODE_ENV=production/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', VANTAGE_DEPLOYMENT_PROFILE: 'mcen' } as NodeJS.ProcessEnv), /mcen needs NODE_ENV=production/);
  const suite = loadConfig({ NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DEPLOYMENT_PROFILE: 'mcen' } as NodeJS.ProcessEnv);
  assert.equal(signInMethods(suite).testTokens, true, 'the suite still exercises the MCEN profile');
  assert.equal(signInMethods(loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).testTokens, false);
});

// ——— Migration 018 ———

test('018 proves only the EDIPIs a card already signed in under, and opens a history period for every membership held', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-018-'));
  const path = join(dir, 'vantage.db');
  try {
    const seed = new Database(path);
    seed.exec(readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));
    seed.exec('DROP TABLE unit_membership_periods');
    seed.exec('ALTER TABLE users ADD COLUMN edipi TEXT');
    seed.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '17') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    const at = '2026-05-01T12:00:00.000Z';
    seed.prepare('INSERT INTO units (id, code, name, created_at) VALUES (?, ?, ?, ?)').run('G8', 'G8', 'G-8', at);
    const user = (id: string, edipi: string | null) => seed.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, edipi, created_at, updated_at) VALUES (?, ?, '', 'A', 'B', ?, ?, ?)").run(id, id, edipi, at, at);
    user('carded', '1234567890');      // their card signed in under this EDIPI
    user('rekeyed', '2222222222');     // a card signed in under other EDIPIs; an administrator typed this one
    user('typed', '3333333333');       // never signed in with a card
    user('nocard', null);
    const entry = (actor: string, action: string, detail: string, n: number) => seed.prepare('INSERT INTO audit_log (id, actor_id, action, detail, at, entry_hash) VALUES (?, ?, ?, ?, ?, ?)').run(`a${n}`, actor, action, detail, `2026-06-0${n}T00:00:00.000Z`, `h${n}`);
    entry('carded', 'cac_verified', 'edipi=1234567890 cn=AVERY.JORDAN.Q.1234567890 issuer=— serial=—', 1);
    entry('carded', 'cac_verified', 'edipi=1234567890 cn=AVERY.JORDAN.Q.1234567890 issuer=— serial=—', 2);
    entry('rekeyed', 'cac_verified', 'edipi=1111111111 cn=— issuer=— serial=—', 3);
    entry('typed', 'personnel_link', 'EDIPI 3333333333', 4);
    entry('rekeyed', 'cac_verified', 'edipi=22222222229 cn=— issuer=— serial=—', 5);
    seed.prepare('INSERT INTO unit_members (user_id, unit_id, is_primary, billet, joined_at) VALUES (?, ?, ?, ?, ?)').run('carded', 'G8', 1, 'Budget Analyst', at);
    seed.prepare('INSERT INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES (?, ?, ?, ?)').run('typed', 'G8', 1, at);
    seed.close();

    const db = openDatabase(path);
    assert.deepEqual(db.prepare('SELECT id, edipi_verified_at FROM users ORDER BY id').all(), [
      { id: 'carded', edipi_verified_at: '2026-06-02T00:00:00.000Z' },
      { id: 'nocard', edipi_verified_at: null },
      { id: 'rekeyed', edipi_verified_at: null },
      { id: 'typed', edipi_verified_at: null },
    ], 'the latest card sign-in under the EDIPI they carry now, and nothing for a longer number or another EDIPI');
    assert.deepEqual(db.prepare('SELECT user_id, unit_id, billet, is_primary, started_at, ended_at, start_reason FROM unit_membership_periods ORDER BY user_id').all(), [
      { user_id: 'carded', unit_id: 'G8', billet: 'Budget Analyst', is_primary: 1, started_at: at, ended_at: null, start_reason: 'recorded' },
      { user_id: 'typed', unit_id: 'G8', billet: null, is_primary: 1, started_at: at, ended_at: null, start_reason: 'recorded' },
    ]);
    // From here the triggers keep it.
    db.prepare("UPDATE unit_members SET billet = 'Budget Chief' WHERE user_id = 'carded'").run();
    db.prepare("DELETE FROM unit_members WHERE user_id = 'typed'").run();
    assert.deepEqual(db.prepare("SELECT billet, start_reason, end_reason, ended_at IS NOT NULL AS ended FROM unit_membership_periods WHERE user_id = 'carded' ORDER BY id").all(), [
      { billet: 'Budget Analyst', start_reason: 'recorded', end_reason: 'billet_changed', ended: 1 },
      { billet: 'Budget Chief', start_reason: 'billet_changed', end_reason: null, ended: 0 },
    ]);
    assert.equal((db.prepare("SELECT ended_at IS NOT NULL AS ended FROM unit_membership_periods WHERE user_id = 'typed'").get() as { ended: number }).ended, 1);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
