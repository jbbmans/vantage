import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let sncoic: { token: string; id: string };
let nco: { token: string; id: string };
let marine: { token: string; id: string };
let other: { token: string; id: string };
before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  sncoic = await app.register('sncoic', { rank_id: 'GySgt' });
  nco = await app.register('nco', { rank_id: 'Cpl' });
  marine = await app.register('marine');
  other = await app.register('other');
  await enroll(app, op.token, 'G8', sncoic.id, 'sncoic');
  await enroll(app, op.token, 'G8', nco.id, 'nco');
  await enroll(app, op.token, 'G8', marine.id);
  sncoic.token = (await app.login('sncoic')).body.token;
  nco.token = (await app.login('nco')).body.token;
  marine.token = (await app.login('marine')).body.token;
});
after(async () => { await app.close(); });

test('sub-unit creation requires MANAGE_UNITS on the parent; top-level requires operator', async () => {
  const denied = await app.call('POST', '/api/org/units', { token: nco.token, body: { name: 'Sneaky', parent_id: 'G8' } });
  assert.equal(denied.status, 403);
  const top = await app.call('POST', '/api/org/units', { token: sncoic.token, body: { name: 'Top level' } });
  assert.equal(top.status, 403);
  const ok = await app.call('POST', '/api/org/units', { token: sncoic.token, body: { name: 'Accounting Section', short_name: 'ACCT', parent_id: 'G8' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, 'ACCT');
  assert.equal(ok.body.owner_user_id, sncoic.id);
  assert.equal((await app.call('POST', '/api/org/units', { token: sncoic.token, body: { name: 'Accounting Section', short_name: 'ACCT', parent_id: 'G8' } })).status, 409);
  const cycle = await app.call('PUT', '/api/org/units/G8', { token: op.token, body: { parent_id: 'ACCT' } });
  assert.equal(cycle.status, 400);
  const rename = await app.call('PUT', '/api/org/units/ACCT', { token: sncoic.token, body: { name: 'Accounting Branch' } });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.name, 'Accounting Branch');
});

test('parent authority never cascades into the child unit', async () => {
  // op owns G8 but was never enrolled in ACCT; sncoic owns ACCT.
  const me = await app.call('GET', '/api/me', { token: op.token });
  assert.ok(!('ACCT' in me.body.permissions));
  const rec = await app.call('POST', '/api/records/activities', { token: (await app.login('sncoic')).body.token, body: { title: 'ACCT only', visibility: 'unit', unit_id: 'ACCT' } });
  assert.equal(rec.status, 201);
  assert.equal((await app.call('GET', `/api/records/activities/${rec.body.id}`, { token: op.token })).status, 403);
  assert.equal((await app.call('GET', '/api/org/units/ACCT/dashboard', { token: op.token })).status, 403);
});

test('role hierarchy: cannot create, grant, or edit at or above own position, nor delegate unheld bits', async () => {
  const sn = (await app.login('sncoic')).body.token;
  const tooHigh = await app.call('POST', '/api/org/roles', { token: sn, body: { unit_id: 'G8', name: 'Shadow', position: 60, permissions: 1 } });
  assert.equal(tooHigh.status, 403);
  const admin = await app.call('POST', '/api/org/roles', { token: sn, body: { unit_id: 'G8', name: 'Admin-ish', position: 10, permissions: PERMISSIONS.ADMINISTRATOR } });
  assert.equal(admin.status, 403);
  assert.equal(admin.body.code, 'delegation');
  const ok = await app.call('POST', '/api/org/roles', { token: sn, body: { unit_id: 'G8', name: 'Reader', position: 10, permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS } });
  assert.equal(ok.status, 201);
  const grant = await app.call('POST', `/api/org/team/${marine.id}/roles`, { token: sn, body: { role_id: ok.body.id, unit_id: 'G8' } });
  assert.equal(grant.status, 200);
  const grantUp = await app.call('POST', `/api/org/team/${marine.id}/roles`, { token: sn, body: { role_id: 'G8:sncoic', unit_id: 'G8' } });
  assert.equal(grantUp.status, 403);
  const ncoGrant = await app.call('POST', `/api/org/team/${marine.id}/roles`, { token: (await app.login('nco')).body.token, body: { role_id: ok.body.id, unit_id: 'G8' } });
  assert.equal(ncoGrant.status, 403);
  const roles = await app.call('GET', '/api/org/roles', { token: sn });
  assert.ok(roles.body.roles.find((r: any) => r.id === ok.body.id).editable);
  assert.ok(!roles.body.roles.find((r: any) => r.id === 'G8:unit-leader').editable);
  const outsiderGrant = await app.call('POST', `/api/org/team/${other.id}/roles`, { token: sn, body: { role_id: ok.body.id, unit_id: 'G8' } });
  assert.equal(outsiderGrant.status, 400);
  assert.equal((await app.call('DELETE', `/api/org/team/${marine.id}/roles/${ok.body.id}`, { token: sn })).status, 200);
  assert.equal((await app.call('DELETE', `/api/org/roles/${ok.body.id}`, { token: sn })).status, 200);
  assert.equal((await app.call('DELETE', '/api/org/roles/G8:marine', { token: op.token })).status, 400);
});

test('editing a role revokes holders sessions so authority is re-read', async () => {
  const sn = (await app.login('sncoic')).body.token;
  const ncoToken = (await app.login('nco')).body.token;
  const edit = await app.call('PUT', '/api/org/roles/G8:nco', { token: sn, body: { permissions: PERMISSIONS.VIEW_UNIT } });
  assert.equal(edit.status, 200);
  assert.ok(edit.body.sessionsRevoked >= 1);
  assert.equal((await app.call('GET', '/api/me', { token: ncoToken })).status, 401);
  await app.call('PUT', '/api/org/roles/G8:nco', { token: sn, body: { permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.CREATE_SHARED_WORK | PERMISSIONS.CREATE_SHARED_GOALS } });
});

test('roster visibility and member detail gates', async () => {
  const roster = await app.call('GET', '/api/org/team', { token: (await app.login('nco')).body.token });
  assert.ok(roster.body.roster.length >= 4);
  assert.ok(!roster.body.roster.some((p: any) => p.id === other.id));
  const asMarine = await app.call('GET', '/api/org/team', { token: (await app.login('marine')).body.token });
  assert.equal(asMarine.body.roster.length, 1);
  const detail = await app.call('GET', `/api/org/team/${marine.id}`, { token: (await app.login('sncoic')).body.token });
  assert.equal(detail.status, 200);
  assert.ok(!('email' in detail.body.person));
  assert.equal((await app.call('GET', `/api/org/team/${marine.id}`, { token: (await app.login('nco')).body.token })).status, 403);
  assert.equal((await app.call('GET', `/api/org/team/${sncoic.id}`, { token: (await app.login('marine')).body.token })).status, 403);
  const selfDetail = await app.call('GET', `/api/org/team/${marine.id}`, { token: (await app.login('marine')).body.token });
  assert.equal(selfDetail.status, 200);
});

test('membership management respects hierarchy and freezes records on removal', async () => {
  const sn = (await app.login('sncoic')).body.token;
  const m = (await app.login('marine')).body.token;
  const rec = await app.call('POST', '/api/records/activities', { token: m, body: { title: 'Frozen later', visibility: 'unit' } });
  assert.equal((await app.call('DELETE', `/api/org/units/G8/members/${sncoic.id}`, { token: (await app.login('nco')).body.token })).status, 403);
  assert.equal((await app.call('DELETE', `/api/org/units/G8/members/${op.id}`, { token: sn })).status, 400);
  const dir = await app.call('GET', '/api/org/directory?unit_id=G8&q=oth', { token: sn });
  assert.equal(dir.status, 200);
  assert.ok(dir.body.results.some((r: any) => r.id === other.id));
  assert.equal((await app.call('GET', '/api/org/directory?unit_id=G8&q=oth', { token: m })).status, 403);
  const billet = await app.call('PUT', `/api/org/units/G8/members/${marine.id}`, { token: sn, body: { billet: 'Fiscal Clerk' } });
  assert.equal(billet.status, 200);
  const removed = await app.call('DELETE', `/api/org/units/G8/members/${marine.id}`, { token: sn });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.recordsFrozen, 1);
  const marineAgain = (await app.login('marine')).body.token;
  const frozen = await app.call('PUT', `/api/records/activities/${rec.body.id}`, { token: marineAgain, body: { title: 'Edit frozen' } });
  assert.equal(frozen.status, 403);
  assert.equal((await app.call('GET', '/api/me', { token: marineAgain })).body.unitIds.length, 0);
  await enroll(app, op.token, 'G8', marine.id);
});

test('ownership transfer moves the Unit Leader role and strips the former owner', async () => {
  const transfer = await app.call('POST', '/api/org/units/ACCT/owner', { token: (await app.login('sncoic')).body.token, body: { user_id: nco.id } });
  assert.equal(transfer.status, 400);
  await app.call('POST', '/api/org/units/ACCT/members', { token: (await app.login('sncoic')).body.token, body: { user_id: nco.id } });
  const ok = await app.call('POST', '/api/org/units/ACCT/owner', { token: (await app.login('sncoic')).body.token, body: { user_id: nco.id } });
  assert.equal(ok.status, 200);
  const ncoMe = await app.call('GET', '/api/me', { token: (await app.login('nco')).body.token });
  assert.ok(ncoMe.body.ownedUnitIds.includes('ACCT'));
  const snMe = await app.call('GET', '/api/me', { token: (await app.login('sncoic')).body.token });
  assert.ok(!snMe.body.ownedUnitIds.includes('ACCT'));
  assert.equal((await app.call('DELETE', '/api/org/units/ACCT', { token: (await app.login('nco')).body.token })).status, 400);
});

test('unit dashboard aggregates shared work and gates member rows', async () => {
  const sn = (await app.login('sncoic')).body.token;
  await app.call('POST', '/api/records/activities', { token: sn, body: { title: 'Obligated 4 MIPRs', visibility: 'unit', dollar_amount: 12000, dollar_type: 'obligated', quantity: 4, unit_label: 'MIPRs', result: 'zero returns', date: new Date().toISOString().slice(0, 10) } });
  const dash = await app.call('GET', '/api/org/units/G8/dashboard', { token: sn });
  assert.equal(dash.status, 200);
  assert.ok(dash.body.totals.entries >= 1);
  assert.ok(dash.body.totals.dollars >= 12000);
  assert.ok(dash.body.members.length >= 3);
  assert.ok(dash.body.weekly.length >= 1);
  const ncoDash = await app.call('GET', '/api/org/units/G8/dashboard', { token: (await app.login('nco')).body.token });
  assert.equal(ncoDash.status, 200);
  assert.equal(ncoDash.body.members.length, 0);
  assert.equal((await app.call('GET', '/api/org/units/G8/dashboard', { token: (await app.login('marine')).body.token })).status, 403);
  assert.equal((await app.call('GET', '/api/org/units/G8/dashboard?from=2026-13-01', { token: sn })).status, 400);
});

test('audit log and export are permission-gated and chain-verified', async () => {
  const sn = (await app.login('sncoic')).body.token;
  const log = await app.call('GET', '/api/org/units/G8/audit', { token: sn });
  assert.equal(log.status, 200);
  assert.ok(log.body.rows.length > 5);
  assert.equal((await app.call('GET', '/api/org/units/G8/audit', { token: (await app.login('nco')).body.token })).status, 403);
  const exp = await app.call('GET', '/api/org/units/G8/export', { token: sn });
  assert.equal(exp.status, 200);
  assert.ok(Array.isArray(exp.body.activities));
  assert.ok(exp.body.activities.every((a: any) => a.visibility === 'unit'));
  const { verifyAuditChain } = await import('../../server/services/audit.ts');
  assert.equal(verifyAuditChain(app.ctx).ok, true);
  app.ctx.db.prepare("UPDATE audit_log SET detail = 'tampered' WHERE seq = 3").run();
  assert.equal(verifyAuditChain(app.ctx).ok, false);
});

test('operator console: runtime settings, users, lifecycle, export/import, backup', async () => {
  const opToken = (await app.login('boletz')).body.token;
  assert.equal((await app.call('GET', '/api/admin/overview', { token: (await app.login('sncoic')).body.token })).status, 403);
  const overview = await app.call('GET', '/api/admin/overview', { token: opToken });
  assert.equal(overview.status, 200);
  assert.ok(overview.body.users >= 5);
  const rt = await app.call('PUT', '/api/admin/runtime', { token: opToken, body: { announcement: 'Drill weekend', aiModels: ['gemini-2.5-flash', 'gpt-4o'], aiDefaultModel: 'gpt-4o' } });
  assert.equal(rt.status, 200);
  assert.equal(rt.body.aiDefaultModel, 'gpt-4o');
  assert.equal((await app.call('GET', '/api/auth/setup')).body.announcement, 'Drill weekend');
  assert.equal((await app.call('PUT', '/api/admin/runtime', { token: opToken, body: { aiModels: ['bad model!'] } })).status, 400);
  const users = await app.call('GET', '/api/admin/users', { token: opToken });
  assert.ok(users.body.users.some((u: any) => u.username === 'other'));
  const temp = await app.call('POST', `/api/org/team/${other.id}/temporary-password`, { token: opToken });
  assert.equal(temp.status, 200);
  const otherLogin = await app.login('other', temp.body.password);
  assert.equal(otherLogin.body.mustChangePassword, true);
  assert.equal((await app.call('GET', '/api/records/activities', { token: otherLogin.body.token })).status, 403);
  assert.equal((await app.call('POST', '/api/me/password', { token: otherLogin.body.token, body: { current_password: temp.body.password, new_password: PASSWORD } })).status, 200);
  assert.equal((await app.call('POST', `/api/org/team/${other.id}/deactivate`, { token: opToken })).status, 200);
  assert.equal((await app.login('other')).status, 401);
  assert.equal((await app.call('POST', `/api/org/team/${other.id}/reactivate`, { token: opToken })).status, 200);
  assert.equal((await app.call('POST', `/api/org/team/${op.id}/deactivate`, { token: opToken })).status, 400);
  const grant = await app.call('POST', `/api/org/team/${sncoic.id}/operator`, { token: opToken, body: { grant: true } });
  assert.equal(grant.status, 200);
  assert.equal((await app.call('GET', '/api/me', { token: (await app.login('sncoic')).body.token })).body.user.is_operator, 1);
  await app.call('POST', `/api/org/team/${sncoic.id}/operator`, { token: opToken, body: { grant: false } });
  const exp = await app.call('GET', '/api/admin/export', { token: opToken });
  assert.equal(exp.status, 200);
  assert.equal(exp.body.format, 'vantage-instance/1');
  assert.ok(exp.body.tables.users.length >= 5);
  assert.equal(exp.body.tables.sessions, undefined);
  const notFresh = await app.call('POST', '/api/admin/import', { token: opToken, body: exp.body });
  assert.equal(notFresh.status, 400);
  const audit = await app.call('GET', '/api/admin/audit?limit=20', { token: opToken });
  assert.equal(audit.body.rows.length, 20);
  assert.equal((await app.call('GET', '/api/admin/backup', { token: opToken })).status, 400);
  const maint = await app.call('POST', '/api/admin/maintenance', { token: opToken, body: { enabled: true } });
  assert.equal(maint.body.maintenance, true);
  assert.equal((await app.call('GET', '/api/records/activities', { token: opToken })).status, 200);
  assert.equal((await app.call('GET', '/api/records/activities', { token: (await app.login('marine')).body.token })).status, 503);
  await app.call('POST', '/api/admin/maintenance', { token: opToken, body: { enabled: false } });
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
  assert.equal((await app.call('GET', '/api/admin/overview', { token: opToken })).status, 403);
});

test('instance import restores an archive into a fresh instance', async () => {
  const opToken = (await app.login('boletz')).body.token;
  const archive = (await app.call('GET', '/api/admin/export', { token: opToken })).body;
  const fresh = await startApp();
  try {
    const freshOp = await fresh.setupOperator();
    const res = await fresh.call('POST', '/api/admin/import', { token: freshOp.token, body: archive });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.users, archive.tables.users.length);
    const login = await fresh.login('sncoic');
    assert.equal(login.status, 200);
    const list = await fresh.call('GET', '/api/records/activities', { token: login.body.token });
    assert.ok(list.body.length >= 1);
  } finally { await fresh.close(); }
});

test('private counselings never reach the unit dashboard', async () => {
  const marineToken = (await app.login('marine')).body.token;
  const res = await app.call('POST', '/api/records/counselings', { token: marineToken, body: { summary: 'Personal reflection', date: '2026-08-30', visibility: 'private', unit_id: op.unitId } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const dash = await app.call('GET', `/api/org/units/${op.unitId}/dashboard?from=2026-01-01&to=2026-12-31`, { token: op.token });
  assert.equal(dash.status, 200);
  const row = dash.body.members.find((m: any) => m.id === marine.id);
  assert.ok(row);
  assert.notEqual(row.last_counseling, '2026-08-30');
});

test('operator lifecycle actions require a fresh password confirmation', async () => {
  const opToken = (await app.login('boletz')).body.token;
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
  const stale = await app.call('POST', `/api/org/team/${other.id}/logout`, { token: opToken });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'sudo_required');
  assert.equal((await app.call('POST', `/api/org/team/${other.id}/reset-mfa`, { token: opToken })).status, 403);
  await app.call('POST', '/api/auth/sudo', { token: opToken, body: { password: PASSWORD } });
  assert.equal((await app.call('POST', `/api/org/team/${other.id}/logout`, { token: opToken })).status, 200);
});

test('reassigning a unit leader from the owner console strips the former leader', async () => {
  const opToken = (await app.login('boletz')).body.token;
  const unit = await app.call('POST', '/api/org/units', { token: opToken, body: { name: 'Disbursing', short_name: 'DISB', parent_id: op.unitId } });
  assert.equal(unit.status, 201, JSON.stringify(unit.body));
  const unitId = unit.body.id;
  await app.call('POST', `/api/org/units/${unitId}/members`, { token: opToken, body: { user_id: sncoic.id } });
  await app.call('POST', `/api/org/units/${unitId}/members`, { token: opToken, body: { user_id: nco.id } });
  await app.call('POST', '/api/auth/sudo', { token: opToken, body: { password: PASSWORD } });
  assert.equal((await app.call('POST', `/api/admin/units/${unitId}/claim`, { token: opToken, body: { owner_user_id: sncoic.id } })).status, 200);
  const sncoicToken = (await app.login('sncoic')).body.token;
  assert.ok((await app.call('GET', '/api/me', { token: sncoicToken })).body.ownedUnitIds.includes(unitId));
  // The operator was the unit's first leader, so the reassignment revoked their sessions too.
  const opAgain = (await app.login('boletz')).body.token;
  await app.call('POST', '/api/auth/sudo', { token: opAgain, body: { password: PASSWORD } });
  assert.equal((await app.call('POST', `/api/admin/units/${unitId}/claim`, { token: opAgain, body: { owner_user_id: nco.id } })).status, 200);
  const sncoicAfter = (await app.login('sncoic')).body.token;
  const me = await app.call('GET', '/api/me', { token: sncoicAfter });
  assert.ok(!me.body.ownedUnitIds.includes(unitId));
  assert.ok(!me.body.roles.some((r: any) => r.unit_id === unitId && r.key === 'unit-leader'));
  const ncoMe = await app.call('GET', '/api/me', { token: (await app.login('nco')).body.token });
  assert.ok(ncoMe.body.ownedUnitIds.includes(unitId));
});

test('an invitation survives a rejected first attempt', async () => {
  const opToken = (await app.login('boletz')).body.token;
  const invite = await app.call('POST', `/api/org/units/${op.unitId}/invites`, { token: opToken, body: { first_name: 'Pat', last_name: 'Reyes' } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const token = new URL(invite.body.url).searchParams.get('token')!;
  const taken = await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'marine', password: PASSWORD, first_name: 'Pat', last_name: 'Reyes' } });
  assert.equal(taken.status, 400);
  const badRank = await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'reyes', password: PASSWORD, first_name: 'Pat', last_name: 'Reyes', rank_id: 'NOPE' } });
  assert.equal(badRank.status, 400);
  const ok = await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'reyes', password: PASSWORD, first_name: 'Pat', last_name: 'Reyes' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'reyes2', password: PASSWORD, first_name: 'Pat', last_name: 'Reyes' } })).status, 400);
});

test('removing a member returns their assigned unit work to its author', async () => {
  const opToken = (await app.login('boletz')).body.token;
  await app.call('POST', '/api/auth/sudo', { token: opToken, body: { password: PASSWORD } });
  const marineToken = (await app.login('marine')).body.token;
  const task = await app.call('POST', '/api/records/tasks', { token: opToken, body: { title: 'Assigned before departure', visibility: 'unit', unit_id: op.unitId, assignee_id: marine.id } });
  assert.equal(task.status, 201);
  assert.ok((await app.call('GET', '/api/records/tasks', { token: marineToken })).body.some((t: any) => t.id === task.body.id));
  assert.equal((await app.call('DELETE', `/api/org/units/${op.unitId}/members/${marine.id}`, { token: opToken })).status, 200);
  const after = await app.call('GET', `/api/records/tasks/${task.body.id}`, { token: opToken });
  assert.equal(after.body.assignee_id, null);
  const again = (await app.login('marine')).body.token;
  assert.ok(!(await app.call('GET', '/api/records/tasks', { token: again })).body.some((t: any) => t.id === task.body.id));
});
