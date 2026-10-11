import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import type { PlatformRole } from '../../shared/permissions.ts';
import { RECENT_AUTHORITY_DAYS, heldAuthorityRecently, holdsAuthority } from '../../server/services/credentialApprovals.ts';
import { addMember } from '../../server/services/org.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';

/**
 * Two people for a takeover (ADR-0013): a temporary password, a second-factor reset or a CAC change on an account that
 * holds authority waits for a second member of Vantage staff, who is neither the one asking nor the account, and is used
 * once, by the one who asked, for exactly the change approved.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let support: Person;
let vadmin: Person;
let lead2: Person;
let manager: Person;
let plain: Person;
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const get = (token: string, path: string) => app.call('GET', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;
const ask = (token: string, userId: string, body: Record<string, unknown>) => post(token, `/api/platform/accounts/${userId}/credential-approvals`, body);
const REASON = 'Ticket 5120: locked out after a phone swap, identity confirmed';
const auditRows = (action: string, subject: string) =>
  app.ctx.db.prepare('SELECT actor_id, detail, category, org_id FROM audit_log WHERE action = ? AND subject_id = ? ORDER BY seq').all(action, subject) as Array<{ actor_id: string; detail: string; category: string; org_id: string | null }>;
const notices = (userId: string, like: string) => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title LIKE ?').get(userId, like) as { n: number }).n;

async function staffMember(username: string, role: PlatformRole) {
  const person = await app.register(username);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  const granted = await post(op.token, '/api/platform/staff', { user_id: person.id, role });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  return { id: person.id, token: await login(username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  support = await staffMember('helpdesk', 'support');
  vadmin = await staffMember('vadmin', 'admin');
  lead2 = await staffMember('secondlead', 'owner');
  // A Unit Manager in G8: authority. A plain member: none.
  manager = await app.register('unitmgr');
  await enroll(app, op.token, 'G8', manager.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: manager.id, role: 'admin' })).status, 201);
  plain = await app.register('plainmarine');
  await enroll(app, op.token, 'G8', plain.id);
});
after(async () => { await app.close(); });

test('authority is a platform role, a seated unexpired Unit Instance role, or leading an active unit', async () => {
  assert.equal(holdsAuthority(app.ctx, plain.id), false);
  assert.equal(holdsAuthority(app.ctx, manager.id), true);
  assert.equal(holdsAuthority(app.ctx, support.id), true, 'any platform role');
  assert.equal(holdsAuthority(app.ctx, op.id), true);
  // A unit's leader.
  const leader = await app.register('cellleader');
  assert.equal(holdsAuthority(app.ctx, leader.id), false);
  assert.equal((await post(leader.token, '/api/org/units', { name: 'Leader’s Cell' })).status, 201);
  assert.equal(holdsAuthority(app.ctx, leader.id), true);
  // A Unit Instance role that has expired confers nothing, and nor does one held outside the instance.
  const lapsed = await app.register('lapsedmgr');
  await enroll(app, op.token, 'G8', lapsed.id);
  app.ctx.db.prepare("INSERT INTO org_roles (org_id, user_id, role, granted_by, expires_at, created_at) VALUES ('G8', ?, 'admin', ?, '2000-01-01T00:00:00.000Z', ?)").run(lapsed.id, op.id, new Date().toISOString());
  assert.equal(holdsAuthority(app.ctx, lapsed.id), false);
  const unseated = await app.register('unseatedmgr');
  app.ctx.db.prepare("INSERT INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES ('G8', ?, 'admin', ?, ?)").run(unseated.id, op.id, new Date().toISOString());
  assert.equal(holdsAuthority(app.ctx, unseated.id), false, 'a role held by someone outside the instance is not seated');
});

test('an account with no authority is helped as before, and a request for it is refused', async () => {
  const temp = await post(support.token, `/api/platform/accounts/${plain.id}/temporary-password`);
  assert.equal(temp.status, 200, JSON.stringify(temp.body));
  assert.ok(temp.body.password);
  const refused = await ask(support.token, plain.id, { action: 'temporary_password', reason: REASON });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'no_authority');
});

test('a takeover of an account with authority waits for a second staff member, and is used once by the one who asked', async () => {
  // Alone, refused.
  for (const path of ['temporary-password', 'reset-mfa']) {
    const alone = await post(support.token, `/api/platform/accounts/${manager.id}/${path}`);
    assert.equal(alone.status, 403, path);
    assert.equal(alone.body.code, 'approval_required');
  }
  const before = (app.ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(manager.id) as { password_hash: string }).password_hash;

  // A request says why.
  assert.equal((await ask(support.token, manager.id, { action: 'temporary_password', reason: 'short' })).status, 400);
  assert.equal((await ask(support.token, manager.id, { action: 'something_else', reason: REASON })).status, 400);
  const asked = await ask(support.token, manager.id, { action: 'temporary_password', reason: REASON });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const id = asked.body.approval.id as string;
  assert.equal(asked.body.approval.status, 'pending');
  assert.equal((await ask(support.token, manager.id, { action: 'temporary_password', reason: REASON })).body.code, 'approval_open', 'one open request at a time');
  assert.ok(notices(vadmin.id, '%asks to set a temporary password%') >= 1, 'the staff who could approve it are told');
  assert.equal(notices(support.id, '%asks to set a temporary password%'), 0, 'but not the one asking');

  // Pending is not approved.
  assert.equal((await post(support.token, `/api/platform/accounts/${manager.id}/temporary-password`, { approvalId: id })).body.code, 'approval_required');
  // Nobody approves their own request.
  const self = await post(support.token, `/api/platform/credential-approvals/${id}/approve`);
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'self_approval');
  // A Vantage Auditor holds no account support.
  const auditor = await staffMember('vauditor', 'auditor');
  assert.equal((await post(auditor.token, `/api/platform/credential-approvals/${id}/approve`)).status, 403);

  const approved = await post(vadmin.token, `/api/platform/credential-approvals/${id}/approve`, { note: 'Confirmed with the SNCOIC' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.approval.status, 'approved');
  assert.equal(approved.body.approval.decided_by, vadmin.id);
  assert.equal((await post(vadmin.token, `/api/platform/credential-approvals/${id}/approve`)).body.code, 'not_pending', 'answered once');
  assert.ok(notices(support.id, '%approved your request%') >= 1, 'the one who asked is told');

  // Only for the change, the account and the person approved.
  assert.equal((await post(support.token, `/api/platform/accounts/${manager.id}/reset-mfa`, { approvalId: id })).body.code, 'approval_required', 'not another change');
  assert.equal((await post(vadmin.token, `/api/platform/accounts/${manager.id}/temporary-password`, { approvalId: id })).body.code, 'approval_required', 'not another staff member');
  assert.equal((await post(support.token, `/api/platform/accounts/${plain.id}/temporary-password`, { approvalId: id })).status, 200, 'an account with no authority needs none and leaves it unused');
  assert.equal((app.ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(manager.id) as { password_hash: string }).password_hash, before, 'nothing changed yet');

  const done = await post(support.token, `/api/platform/accounts/${manager.id}/temporary-password`, { approvalId: id });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.password);
  const row = app.ctx.db.prepare('SELECT status, used_at FROM credential_approvals WHERE id = ?').get(id) as { status: string; used_at: string | null };
  assert.equal(row.status, 'used');
  assert.ok(row.used_at);
  assert.equal((await post(support.token, `/api/platform/accounts/${manager.id}/temporary-password`, { approvalId: id })).body.code, 'approval_required', 'used once');

  // The trail names who asked, who approved, and who made the change; each step is enterprise administration.
  const requested = auditRows('credential_change_requested', manager.id);
  const decided = auditRows('credential_change_approved', manager.id);
  assert.equal(requested.at(-1)!.actor_id, support.id);
  assert.match(requested.at(-1)!.detail, /set a temporary password for unitmgr: Ticket 5120/);
  assert.equal(decided.at(-1)!.actor_id, vadmin.id);
  assert.match(decided.at(-1)!.detail, /asked by Helpdesk Marine: Confirmed with the SNCOIC/);
  assert.deepEqual([...requested, ...decided].map((r) => r.category), ['enterprise', 'enterprise']);
  const change = auditRows('temporary_password', manager.id).at(-1)!;
  assert.equal(change.actor_id, support.id);
  assert.match(change.detail, new RegExp(`approved by Vadmin Marine \\(request ${id}\\)`));
  const told = auditRows('vantage_account_support', manager.id).filter((r) => r.org_id === 'G8').at(-1)!;
  assert.equal(told.detail, 'Vantage support set a temporary password, approved by Vadmin Marine');
  assert.equal(verifyAuditChain(app.ctx).ok, true);

  // The list shows it, used.
  const listed = await get(vadmin.token, '/api/platform/credential-approvals');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.hours, 24);
  assert.equal(listed.body.approvals.find((a: { id: string }) => a.id === id).status, 'used');
});

test('a denial says why, a request can be cancelled only by the one who asked, and an approval lapses after a day', async () => {
  const first = await ask(support.token, manager.id, { action: 'reset_mfa', reason: REASON });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const deny = (body: unknown) => post(vadmin.token, `/api/platform/credential-approvals/${first.body.approval.id}/deny`, body);
  assert.equal((await deny({})).status, 400, 'a denial says why');
  const denied = await deny({ note: 'The ticket does not show the person asked for this.' });
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  assert.equal(denied.body.approval.status, 'denied');
  assert.ok(notices(support.id, '%denied your request%') >= 1);
  assert.match(auditRows('credential_change_denied', manager.id).at(-1)!.detail, /does not show/);
  assert.equal((await post(support.token, `/api/platform/accounts/${manager.id}/reset-mfa`, { approvalId: first.body.approval.id })).body.code, 'approval_required', 'a denied request is no approval');

  const second = await ask(support.token, manager.id, { action: 'reset_mfa', reason: REASON });
  const secondId = second.body.approval.id as string;
  assert.equal((await post(vadmin.token, `/api/platform/credential-approvals/${secondId}/cancel`)).body.code, 'not_requester');
  assert.equal((await post(vadmin.token, `/api/platform/credential-approvals/${secondId}/approve`)).status, 200);
  const cancelled = await post(support.token, `/api/platform/credential-approvals/${secondId}/cancel`);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.approval.status, 'cancelled');
  assert.ok(notices(vadmin.id, '%cancelled the request%') >= 1, 'the staff member who approved it is told');
  assert.ok(auditRows('credential_change_cancelled', manager.id).length >= 1);
  assert.equal((await post(support.token, `/api/platform/accounts/${manager.id}/reset-mfa`, { approvalId: secondId })).body.code, 'approval_required');

  const third = await ask(support.token, manager.id, { action: 'reset_mfa', reason: REASON });
  const thirdId = third.body.approval.id as string;
  assert.equal((await post(vadmin.token, `/api/platform/credential-approvals/${thirdId}/approve`)).status, 200);
  const row = app.ctx.db.prepare('SELECT requested_at, expires_at FROM credential_approvals WHERE id = ?').get(thirdId) as { requested_at: string; expires_at: string };
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.requested_at), 24 * 3_600_000, 'a day from when it was asked');
  app.ctx.db.prepare("UPDATE credential_approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(thirdId);
  assert.equal((await post(support.token, `/api/platform/accounts/${manager.id}/reset-mfa`, { approvalId: thirdId })).body.code, 'approval_required', 'a lapsed approval is no approval');
  const listed = await get(support.token, '/api/platform/credential-approvals');
  assert.equal(listed.body.approvals.find((a: { id: string }) => a.id === thirdId).status, 'expired');
});

test('a CAC change is approved for one EDIPI, and the approval and the change commit together', async () => {
  assert.equal((await ask(support.token, manager.id, { action: 'edipi', reason: REASON })).status, 400, 'the EDIPI is named');
  assert.equal((await ask(support.token, manager.id, { action: 'edipi', edipi: '12345', reason: REASON })).status, 400);
  const asked = await ask(support.token, manager.id, { action: 'edipi', edipi: '4445556667', reason: REASON });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const id = asked.body.approval.id as string;
  assert.equal((await post(vadmin.token, `/api/platform/credential-approvals/${id}/approve`)).status, 200);
  const correct = (edipi: string | null) => post(support.token, `/api/platform/accounts/${manager.id}/edipi`, { edipi, reason: REASON, approvalId: id });
  assert.equal((await correct('4445556668')).body.code, 'approval_required', 'not another EDIPI');

  // If the change itself fails, the approval is not used up.
  app.ctx.db.exec(`CREATE TEMP TRIGGER refuse_edipi BEFORE UPDATE OF edipi ON users WHEN NEW.id = '${manager.id}' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
  try {
    assert.equal((await correct('4445556667')).status, 500);
  } finally { app.ctx.db.exec('DROP TRIGGER refuse_edipi'); }
  assert.equal((app.ctx.db.prepare('SELECT status FROM credential_approvals WHERE id = ?').get(id) as { status: string }).status, 'approved', 'the approval rolled back with the change');

  const done = await correct('4445556667');
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((app.ctx.db.prepare('SELECT edipi FROM users WHERE id = ?').get(manager.id) as { edipi: string }).edipi, '4445556667');
  assert.match(auditRows('edipi_corrected', manager.id).at(-1)!.detail, /approved by Vadmin Marine/);
});

test('a staff member’s sign-in is approved only by a Lead Vantage Administrator, and nobody answers for their own account', async () => {
  // Support cannot even ask about a staff member (accountTarget), as before.
  assert.equal((await ask(support.token, vadmin.id, { action: 'temporary_password', reason: REASON })).body.code, 'staff_account');
  const asked = await ask(op.token, vadmin.id, { action: 'temporary_password', reason: REASON });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const id = asked.body.approval.id as string;
  assert.equal(notices(support.id, '%asks to set a temporary password for Vadmin%'), 0, 'only those who could approve it are told');
  assert.ok(notices(lead2.id, '%asks to set a temporary password for Vadmin%') >= 1);
  const byTarget = await post(vadmin.token, `/api/platform/credential-approvals/${id}/approve`);
  assert.equal(byTarget.status, 403);
  assert.equal(byTarget.body.code, 'self_approval');
  const bySupport = await post(support.token, `/api/platform/credential-approvals/${id}/approve`);
  assert.equal(bySupport.body.code, 'staff_account');
  assert.equal((await post(lead2.token, `/api/platform/credential-approvals/${id}/approve`)).status, 200);
  const done = await post(op.token, `/api/platform/accounts/${vadmin.id}/temporary-password`, { approvalId: id });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(auditRows('temporary_password', vadmin.id).at(-1)!.detail, /approved by Secondlead Marine/);
});

test('a temporary password is never asked for on your own account', async () => {
  const res = await ask(op.token, op.id, { action: 'temporary_password', reason: REASON });
  assert.equal(res.status, 400);
});

test('taking authority away, changing the sign-in alone and giving it back is no way round the second person', async () => {
  const va = await staffMember('vadmin2', 'admin'); // platform.managers and platform.accounts
  const target = await app.register('roundmgr');
  await enroll(app, op.token, 'G8', target.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: target.id, role: 'admin' })).status, 201);
  assert.equal((await post(va.token, `/api/platform/accounts/${target.id}/temporary-password`)).body.code, 'approval_required');

  // The Unit Manager role removed: the account held it within RECENT_AUTHORITY_DAYS, so it still counts.
  assert.equal((await app.call('DELETE', `/api/platform/orgs/G8/managers/${target.id}/admin`, { token: va.token })).status, 200);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G8' AND user_id = ?").get(target.id), undefined);
  assert.equal(heldAuthorityRecently(app.ctx, target.id), true);
  assert.equal(holdsAuthority(app.ctx, target.id), true);
  const alone = await post(va.token, `/api/platform/accounts/${target.id}/temporary-password`);
  assert.equal(alone.status, 403, JSON.stringify(alone.body));
  assert.equal(alone.body.code, 'approval_required');
  assert.equal((await ask(va.token, target.id, { action: 'temporary_password', reason: REASON })).status, 201, 'a request is taken, as for any holder');
  // Authority that ended longer ago than that no longer counts.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + (RECENT_AUTHORITY_DAYS + 1) * 86_400_000 });
  try {
    assert.equal(holdsAuthority(app.ctx, target.id), false);
  } finally { mock.timers.reset(); }

  // Leadership handed on counts the same way for the leader before.
  const leader = await app.register('handedon');
  assert.equal((await post(leader.token, '/api/org/units', { name: 'Handed Cell', code: 'HNDC' })).status, 201);
  const successor = await app.register('successor');
  await enroll(app, op.token, 'G8', successor.id);
  addMember(app.ctx, successor.id, 'HNDC', { invitedBy: null });
  const handed = await post(await login('handedon'), '/api/org/units/HNDC/owner', { user_id: successor.id });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(app.ctx.db.prepare('SELECT 1 FROM units WHERE owner_user_id = ? AND active = 1').get(leader.id), undefined);
  assert.equal(heldAuthorityRecently(app.ctx, leader.id), true, 'led a unit within the window');
  assert.equal(heldAuthorityRecently(app.ctx, successor.id), false, 'leads it now, and gave nothing up');
});

test('a staff member who changed an account’s sign-in does not then give it authority; another staff member can', async () => {
  const va = await staffMember('vadmin3', 'admin');
  const target = await app.register('freshmgr');
  await enroll(app, op.token, 'G8', target.id);
  assert.equal((await post(va.token, `/api/platform/accounts/${target.id}/temporary-password`)).status, 200, 'no authority, so no second person');

  const refused = await post(va.token, '/api/platform/orgs/G8/managers', { user_id: target.id, role: 'admin' });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'recent_credential_change');
  assert.equal(refused.body.error ?? refused.body.message, `You changed this account’s sign-in in the last ${RECENT_AUTHORITY_DAYS} days, so you cannot give it authority. Another member of Vantage staff can.`);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G8' AND user_id = ?").get(target.id), undefined);
  const denied = app.ctx.db.prepare("SELECT detail, category FROM audit_log WHERE action = 'access_denied' AND actor_id = ? ORDER BY seq DESC LIMIT 1").get(va.id) as { detail: string; category: string };
  assert.deepEqual(denied, { detail: 'POST /api/platform/orgs/:orgId/managers: recent_credential_change', category: 'enterprise' });
  assert.equal((await post(op.token, '/api/platform/orgs/G8/managers', { user_id: target.id, role: 'admin' })).status, 200, 'another staff member can');

  // Nor a platform role, nor the first Lead Unit Manager of a Unit Instance that has none.
  const other = await app.register('freshstaff');
  assert.equal((await post(op.token, `/api/platform/accounts/${other.id}/reset-mfa`)).status, 200);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(other.id);
  const staffRefused = await post(op.token, '/api/platform/staff', { user_id: other.id, role: 'support' });
  assert.equal(staffRefused.status, 403, JSON.stringify(staffRefused.body));
  assert.equal(staffRefused.body.code, 'recent_credential_change');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'Fresh Instance', code: 'FRSH' })).status, 201);
  const ownerRefused = await post(op.token, '/api/platform/orgs/FRSH/owner', { user_id: other.id });
  assert.equal(ownerRefused.status, 403, JSON.stringify(ownerRefused.body));
  assert.equal(ownerRefused.body.code, 'recent_credential_change');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'Fresher Instance', code: 'FRSR', owner_user_id: other.id })).body.code, 'recent_credential_change');
  assert.equal((await post(lead2.token, '/api/platform/orgs/FRSH/owner', { user_id: other.id })).status, 200, 'another staff member can');
  assert.equal((await post(lead2.token, '/api/platform/staff', { user_id: other.id, role: 'support' })).status, 201);
});
