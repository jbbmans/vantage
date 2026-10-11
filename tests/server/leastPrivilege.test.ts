import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { isUnitOwner, scopeFor } from '../../server/authz/scope.ts';
import { accountOpenedBy, addMember, isProvenAccount, removeMember } from '../../server/services/org.ts';

/**
 * Least privilege (ADR-0013): leading a unit takes being a member of it; an account a Unit Manager created or invited
 * reads nothing through roles from that same person until it has signed in as its own ("Until proven"); the
 * separation-of-duties report; and the read limit on the two consoles.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let lum: Person; // a Lead Unit Manager of G8 who does not lead it through the chain of command
let um: Person; // a Unit Manager of G8
let um2: Person; // another Unit Manager of G8
const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const csv = { 'content-type': 'text/csv', 'x-vantage-filename': 'roster.csv' };
const idOf = (username: string) => (app.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id;
const lastEntry = (action: string, subject?: string) => app.ctx.db.prepare(`SELECT * FROM audit_log WHERE action = ? ${subject ? 'AND subject_id = ?' : ''} ORDER BY seq DESC LIMIT 1`).get(...[action, ...(subject ? [subject] : [])]) as Record<string, any> | undefined;

async function orgRoleHolder(username: string, role: 'owner' | 'admin') {
  const person = await app.register(username);
  await enroll(app, op.token, 'G8', person.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: person.id, role })).status, 201);
  return { id: person.id, token: await login(username) };
}

/** An account the Unit Manager creates by importing a roster, with the role the roster names. */
async function imported(token: string, username: string, role = 'Marine') {
  const roster = ['Rank,First Name,Last Name,Username,Temporary Password,Role', `Cpl,${username},Imported,${username},QuartzHarborLane4!,${role}`].join('\n');
  const r = await app.call('POST', '/api/orgs/G8/accounts/import?apply=1', { token, raw: Buffer.from(roster), headers: csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 1);
  return { id: idOf(username), result: r.body };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  lum = await orgRoleHolder('lpleadum', 'owner');
  um = await orgRoleHolder('lpunitmgr', 'admin');
  um2 = await orgRoleHolder('lpunitmgr2', 'admin');
  // Made through Unit Instance authority, so they are led from above until a leader is named.
  for (const [name, code] of [['Ledger Cell', 'LPLC'], ['Payroll Cell', 'LPPC'], ['Audit Cell', 'LPAC']]) {
    assert.equal((await post(um.token, '/api/org/units', { name, code, parent_id: 'G8' })).status, 201);
  }
});
after(async () => { await app.close(); });

test('a unit’s leader leads it only while they belong to it', async () => {
  const leader = await app.register('lpleader');
  // Left over from before the rule: the unit names a leader who is not a member of it.
  app.ctx.db.prepare("UPDATE units SET owner_user_id = ? WHERE id = 'LPLC'").run(leader.id);
  assert.equal(isUnitOwner(app.ctx, leader.id, 'LPLC'), false);
  const outside = scopeFor(app.ctx, { id: leader.id });
  assert.ok(!outside.ownedUnitIds.includes('LPLC'));
  assert.equal(outside.permissions.LPLC ?? 0, 0, 'no authority at all there');
  assert.ok(!outside.readableUnitIds.includes('LPLC'));

  addMember(app.ctx, leader.id, 'LPLC', { invitedBy: op.id });
  const seated = scopeFor(app.ctx, { id: leader.id });
  assert.ok(seated.ownedUnitIds.includes('LPLC'));
  assert.ok(seated.permissions.LPLC & PERMISSIONS.ADMINISTRATOR);
  assert.equal(isUnitOwner(app.ctx, leader.id, 'LPLC'), true);
});

test('ending a leader’s membership ends the leadership, on the record, and the Lead Unit Managers are told', async () => {
  const leader = await app.register('lpseparated');
  await enroll(app, op.token, 'LPPC', leader.id);
  const named = await post(um.token, '/api/orgs/G8/units/LPPC/leader', { user_id: leader.id });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(isUnitOwner(app.ctx, leader.id, 'LPPC'), true);

  // The personnel feed's separation, a removal from the Unit Instance and a transfer all end a membership the same way.
  const removed = removeMember(app.ctx, leader.id, 'LPPC', um.id, 'roster_separation');
  assert.equal(removed.leaderEnded, true);
  assert.equal((app.ctx.db.prepare("SELECT owner_user_id FROM units WHERE id = 'LPPC'").get() as { owner_user_id: string | null }).owner_user_id, null);
  const entry = lastEntry('unit_leader_ended', leader.id)!;
  assert.ok(entry, 'audited');
  assert.equal(entry.category, 'unit');
  assert.equal(entry.actor_id, um.id);
  assert.equal(entry.unit_id, 'LPPC');
  assert.equal(entry.org_id, 'G8');
  assert.match(entry.detail, /roster_separation/);
  const told = (id: string) => app.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%has no leader'").get(id);
  assert.ok(told(lum.id), 'the Lead Unit Managers are told');
  assert.ok(told(op.id));
  assert.equal(told(um2.id), undefined, 'a Unit Manager is not a Lead Unit Manager');
  // A member who leads nothing leaves without any of that.
  const plain = await app.register('lpplain');
  await enroll(app, op.token, 'LPPC', plain.id);
  assert.equal(removeMember(app.ctx, plain.id, 'LPPC', um.id).leaderEnded, false);
});

test('every path that ends a membership goes through removeMember, which ends the leadership', () => {
  const root = join(import.meta.dirname, '..', '..');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mjs|js)$/.test(name) && /DELETE\s+FROM\s+unit_members\b/i.test(readFileSync(path, 'utf8'))) hits.push(path.slice(root.length + 1));
    }
  };
  walk(join(root, 'server'));
  walk(join(root, 'scripts'));
  assert.deepEqual(hits, ['server/services/org.ts']);
  const source = readFileSync(join(root, 'server/services/org.ts'), 'utf8');
  assert.equal(source.match(/DELETE FROM unit_members/g)?.length, 1, 'once, in removeMember');
});

test('a Unit Manager gives an account they created no role that reads records until it signs in as its own', async () => {
  const sock = await imported(um.token, 'lpsock');
  assert.equal(accountOpenedBy(app.ctx, sock.id), um.id);
  assert.equal(isProvenAccount(app.ctx, sock.id), false);

  const refused = await post(um.token, `/api/org/team/${sock.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'unproven_own_account');
  assert.match(refused.body.error ?? refused.body.message ?? '', /You created or invited this account, and it hasn’t signed in with its own CAC or the organization’s sign-in yet\. Another Unit Manager or the chain of command can grant this\./);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(sock.id), undefined);
  const denied = lastEntry('access_denied')!;
  assert.equal(denied.actor_id, um.id, 'refused on the record, as a self-grant is');
  assert.match(denied.detail, /unproven_own_account/);
  assert.equal(denied.category, 'unit');

  // A role that reads nothing is still theirs to give.
  const clerk = await post(um.token, '/api/org/roles', { unit_id: 'G8', name: 'Claims clerk', position: 5, permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.CLAIM_WORK });
  assert.equal(clerk.status, 201, JSON.stringify(clerk.body));
  assert.equal((await post(um.token, `/api/org/team/${sock.id}/roles`, { role_id: clerk.body.id, unit_id: 'G8' })).status, 200);
  // Widening that role so it reads records would reach the same account.
  const widen = await app.call('PUT', `/api/org/roles/${encodeURIComponent(clerk.body.id)}`, { token: um.token, body: { permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.CLAIM_WORK | PERMISSIONS.VIEW_RECORDS } });
  assert.equal(widen.status, 403, JSON.stringify(widen.body));
  assert.equal(widen.body.code, 'unproven_own_account');

  // Nor lead a unit, by naming or by transfer.
  assert.equal((await post(um.token, '/api/orgs/G8/units/LPAC/leader', { user_id: sock.id })).body.code, 'unproven_own_account');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'LPAC'").get(sock.id), undefined, 'and nothing was half-done');
  addMember(app.ctx, sock.id, 'LPAC', { invitedBy: um.id });
  assert.equal((await post(um.token, '/api/org/units/LPAC/owner', { user_id: sock.id })).body.code, 'unproven_own_account');

  // Another Unit Manager can; so can the chain of command.
  const other = await post(um2.token, `/api/org/team/${sock.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  assert.equal((await post(op.token, `/api/org/team/${sock.id}/roles`, { role_id: 'G8:fire-team-leader', unit_id: 'G8' })).status, 200);
  assert.equal((await post(um2.token, '/api/orgs/G8/units/LPAC/leader', { user_id: sock.id })).status, 200);

  // Once it has signed in with its own CAC, it is anyone's to staff.
  const proven = await imported(um.token, 'lpproven');
  app.ctx.db.prepare("UPDATE users SET edipi = '1234567890', edipi_verified_at = ? WHERE id = ?").run(new Date().toISOString(), proven.id);
  assert.equal((await post(um.token, `/api/org/team/${proven.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' })).status, 200);
  // Or with the organization's sign-in.
  const viaOidc = await imported(um.token, 'lpoidc');
  app.ctx.db.prepare("UPDATE users SET oidc_issuer = 'https://idp.example.mil', oidc_subject = 'lpoidc' WHERE id = ?").run(viaOidc.id);
  assert.equal(isProvenAccount(app.ctx, viaOidc.id), true);
  assert.equal((await post(um.token, `/api/org/team/${viaOidc.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' })).status, 200);
});

test('nor a Unit Instance role from the Lead Unit Manager who created it', async () => {
  const sock = await imported(lum.token, 'lpsock2');
  const refused = await post(lum.token, '/api/orgs/G8/roles', { user_id: sock.id, role: 'auditor' });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'unproven_own_account');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G8' AND user_id = ?").get(sock.id), undefined);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: sock.id, role: 'auditor' })).status, 201, 'another Lead Unit Manager can');
});

test('a role an import, invitation or join code carries waits for an account its maker opened', async () => {
  // An import: the account is made, the role is held back and the result says so.
  const sock = await imported(um.token, 'lpimported', 'SNCO');
  assert.deepEqual(sock.result.withheld, [{ username: 'lpimported', role: 'SNCO' }]);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(sock.id), undefined);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'G8'").get(sock.id), 'they still join');
  assert.equal(lastEntry('unit_role_withheld', sock.id)?.category, 'unit');
  assert.match(lastEntry('accounts_imported')!.detail, /1 roles held back/);
  // The chain of command importing gives the role as before.
  assert.deepEqual((await imported(op.token, 'lpbychain', 'SNCO')).result.withheld, []);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(idOf('lpbychain')));

  // A join code: a new account that redeems it joins without the role, and the Unit Manager is told.
  const code = await post(um.token, '/api/org/units/G8/join-codes', { role_id: 'G8:snco' });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  const joiner = await app.register('lpjoiner');
  const joined = await post(joiner.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(accountOpenedBy(app.ctx, joiner.id), um.id);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(joiner.id), undefined);
  assert.ok(lastEntry('unit_role_withheld', joiner.id));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%without SNCO'").get(um.id));
  // Someone who already belonged somewhere, or has proven themselves, is not an account the code's maker opened.
  const proven = await app.register('lpprovenjoiner');
  app.ctx.db.prepare("UPDATE users SET edipi = '1234567891', edipi_verified_at = ? WHERE id = ?").run(new Date().toISOString(), proven.id);
  assert.equal((await post(proven.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`)).status, 200);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(proven.id));

  // An invitation accepted by a new password account.
  const invite = await post(um.token, '/api/org/units/G8/invites', { role_id: 'G8:snco' });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const token = new URL(invite.body.url).searchParams.get('token');
  const accepted = await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'lpinvitee', password: PASSWORD, first_name: 'Invited', last_name: 'Marine' } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const invitee = idOf('lpinvitee');
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'G8'").get(invitee));
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(invitee), undefined);
  assert.ok(lastEntry('unit_role_withheld', invitee));
  // A role that reads nothing comes with the invitation as before.
  const nco = await post(um.token, '/api/org/units/G8/invites', { role_id: null });
  assert.equal(nco.status, 201);
});

test('the default role reads records only by the chain of command’s hand, and never through an account its inviter opened', async () => {
  assert.equal((await post(um.token, '/api/org/units', { name: 'Default Cell', code: 'LPDC', parent_id: 'G8' })).status, 201);
  const reading = PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL;
  // A Unit Manager who belongs to nothing there cannot widen it: it reaches every account they will open.
  const widen = (token: string) => app.call('PUT', '/api/org/roles/LPDC%3Amarine', { token, body: { permissions: reading } });
  const refused = await widen(um.token);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.code, 'self_grant');
  assert.match(refused.body.error ?? refused.body.message ?? '', /every new member of the unit receives/);
  assert.equal((app.ctx.db.prepare("SELECT permissions FROM roles WHERE id = 'LPDC:marine'").get() as { permissions: number }).permissions & PERMISSIONS.VIEW_RECORDS, 0);
  assert.match(lastEntry('access_denied')!.detail, /^PUT \/api\/org\/roles\/:roleId: self_grant$/);
  // Narrowing it, or widening it with what reads nothing, is theirs as before; the chain of command (G8’s leader) may widen it.
  assert.equal((await app.call('PUT', '/api/org/roles/LPDC%3Amarine', { token: um.token, body: { permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.CLAIM_WORK } })).status, 200);
  assert.equal((await widen(op.token)).status, 200);

  // Even so, an account the Unit Manager opens joins without it: through an invitation, as through a join code.
  const invite = await post(um.token, '/api/org/units/LPDC/invites', { role_id: null });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const accepted = await app.call('POST', '/api/auth/invite/accept', { body: { token: new URL(invite.body.url).searchParams.get('token'), username: 'lpdefault', password: PASSWORD, first_name: 'Default', last_name: 'Marine' } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const x = idOf('lpdefault');
  assert.equal(accountOpenedBy(app.ctx, x), um.id);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'LPDC'").get(x), 'they still join');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'LPDC:marine'").get(x), undefined);
  const scope = scopeFor(app.ctx, { id: x });
  assert.equal((scope.permissions.LPDC ?? 0) & PERMISSIONS.VIEW_RECORDS, 0);
  assert.ok(!scope.readableUnitIds.includes('LPDC'));
  assert.match(lastEntry('unit_role_withheld', x)!.detail, /^Marine, from /);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%joined Default Cell without Marine'").get(um.id), 'the inviter is told');
  // Founding a unit of its own first is no way round it: the join code it answers next still opened it.
  const founder = await app.register('lpfounder');
  assert.equal((await post(founder.token, '/api/org/units', { name: 'Founder Cell', code: 'LPFC' })).status, 201);
  const code = await post(um.token, '/api/org/units/LPDC/join-codes', { role_id: null });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  assert.equal((await post(await login('lpfounder'), `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`)).status, 200);
  assert.equal(accountOpenedBy(app.ctx, founder.id), um.id);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'LPDC:marine'").get(founder.id), undefined);
  assert.equal((scopeFor(app.ctx, { id: founder.id }).permissions.LPDC ?? 0) & PERMISSIONS.VIEW_RECORDS, 0);
  // Seated by someone who did not open the account, it comes with membership as ever.
  const other = await app.register('lpdefault2');
  addMember(app.ctx, other.id, 'LPDC', { invitedBy: um.id });
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'LPDC:marine'").get(other.id));
});

test('a move carries no role that reads records to an account the mover opened', async () => {
  for (const [name, code] of [['Team One', 'LPT1'], ['Team Two', 'LPT2']]) assert.equal((await post(um.token, '/api/org/units', { name, code, parent_id: 'G8' })).status, 201);
  // NCO reads records in the template; narrowed in the first team, it is the Unit Manager’s to give there.
  const nco = app.ctx.db.prepare("SELECT permissions FROM roles WHERE id = 'LPT1:nco'").get() as { permissions: number };
  assert.ok(nco.permissions & PERMISSIONS.VIEW_RECORDS);
  assert.equal((await app.call('PUT', '/api/org/roles/LPT1%3Anco', { token: um.token, body: { permissions: nco.permissions & ~(PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL | PERMISSIONS.EXPORT_DATA) } })).status, 200);
  const mover = await imported(um.token, 'lpmover');
  addMember(app.ctx, mover.id, 'LPT1', { invitedBy: um.id });
  assert.equal((await post(um.token, `/api/org/team/${mover.id}/roles`, { role_id: 'LPT1:nco', unit_id: 'LPT1' })).status, 200);

  const moved = await post(um.token, `/api/org/units/LPT1/members/${mover.id}/move`, { to: 'LPT2' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body.roles, []);
  assert.deepEqual(moved.body.rolesSkipped, ['NCO']);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'LPT2:nco'").get(mover.id), undefined);
  assert.equal((scopeFor(app.ctx, { id: mover.id }).permissions.LPT2 ?? 0) & PERMISSIONS.VIEW_RECORDS, 0);
  assert.match(lastEntry('move_member', mover.id)!.detail, /not carried: NCO/);
  // Another Unit Manager carries it back and forth as before.
  assert.equal((await post(um2.token, `/api/org/team/${mover.id}/roles`, { role_id: 'LPT2:nco', unit_id: 'LPT2' })).status, 200);
  const back = await post(um2.token, `/api/org/units/LPT2/members/${mover.id}/move`, { to: 'LPT1' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.roles, ['NCO']);
});

test('a leader who archives the unit only they belong to leaves no notice that it has no leader', async () => {
  assert.equal((await post(op.token, '/api/org/units', { name: 'Solo Cell', code: 'LPSO', parent_id: 'G8' })).status, 201);
  assert.equal(isUnitOwner(app.ctx, op.id, 'LPSO'), true);
  assert.equal((await app.call('DELETE', '/api/org/units/LPSO', { token: op.token })).status, 200);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'unit_leader_ended' AND unit_id = 'LPSO'").get(), undefined);
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM notifications WHERE title = 'Solo Cell has no leader'").get(), undefined);
  assert.ok(lastEntry('archive_unit'), 'the archive itself is on the record');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE unit_id = 'LPSO'").get(), undefined);
});

test('the separation-of-duties report lists every crossing, for Vantage staff who read the audit trail', async () => {
  // A Unit Manager in a second Unit Instance as well.
  const g1lead = await app.register('lpgonelead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  addMember(app.ctx, um.id, 'G1', { invitedBy: g1lead.id });
  assert.equal((await post(await login('lpgonelead'), '/api/orgs/G1/roles', { user_id: um.id, role: 'admin' })).status, 201);
  um.token = await login('lpunitmgr'); // a new role signs them out
  // An account granted a role that reads records by the person who imported it, before the rule (written directly).
  const legacy = await imported(um.token, 'lplegacy');
  app.ctx.db.prepare("INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, 'G8:snco', 'G8', ?, ?)").run(legacy.id, um.id, new Date().toISOString());

  const report = await get(op.token, '/api/platform/separation-of-duties');
  assert.equal(report.status, 200, JSON.stringify(report.body));
  const ids = (rows: Array<{ person: { id: string } }>) => rows.map((r) => r.person.id);
  // The Lead Vantage Administrator who set Vantage up is also G8's Lead Unit Manager, and leads G8.
  assert.ok(ids(report.body.platformAndInstance).includes(op.id));
  const opInG8 = report.body.instanceAndRecords.find((r: { person: { id: string }; orgId: string }) => r.person.id === op.id && r.orgId === 'G8');
  assert.ok(opInG8, JSON.stringify(report.body.instanceAndRecords));
  assert.ok(opInG8.reading.some((x: { unitId: string; role: string }) => x.unitId === 'G8' && x.role === 'Unit leader'));
  const across = report.body.managersAcrossInstances.find((r: { person: { id: string } }) => r.person.id === um.id);
  assert.deepEqual(across?.instances.map((i: { orgId: string }) => i.orgId).sort(), ['G1', 'G8']);
  const stale = report.body.leadersNotMembers.find((r: { unitId: string }) => r.unitId === 'LPLC');
  assert.equal(stale, undefined, 'the leader of LPLC was seated above');
  app.ctx.db.prepare("DELETE FROM unit_members WHERE user_id = ? AND unit_id = 'LPLC'").run(idOf('lpleader'));
  const again = await get(op.token, '/api/platform/separation-of-duties');
  assert.ok(again.body.leadersNotMembers.some((r: { unitId: string; person: { username: string } }) => r.unitId === 'LPLC' && r.person.username === 'lpleader'));
  const unproven = again.body.unprovenReaders.find((r: { person: { id: string } }) => r.person.id === legacy.id);
  assert.equal(unproven?.role, 'SNCO');
  assert.equal(unproven?.grantedBy.id, um.id);
  assert.ok(!ids(again.body.unprovenReaders).includes(idOf('lpsock')), 'granted by another Unit Manager, so not a crossing');
  // Read-only, and only for platform.audit.
  assert.equal((await get(um.token, '/api/platform/separation-of-duties')).status, 403);
});

test('console reads are limited per person, generously, and changes are not counted against them', async () => {
  const limited = await startApp({ VANTAGE_CONSOLE_READS_PER_15_MINUTES: '5' });
  try {
    const owner = await limited.setupOperator();
    for (let i = 0; i < 5; i += 1) assert.equal((await limited.call('GET', '/api/orgs', { token: owner.token })).status, 200);
    const sixth = await limited.call('GET', '/api/orgs/G8/overview', { token: owner.token });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.code, 'reads_throttled');
    assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    assert.equal((await limited.call('GET', '/api/platform/overview', { token: owner.token })).status, 429, 'both consoles share one count');
    assert.equal((await limited.call('GET', '/api/me', { token: owner.token })).status, 200, 'the app itself is not limited here');
    const unit = await limited.call('POST', '/api/org/units', { token: owner.token, body: { name: 'Still Allowed', parent_id: 'G8' } });
    assert.equal(unit.status, 201, 'a change is not a read');
    const other = await limited.register('lpreader');
    assert.equal((await limited.call('GET', '/api/orgs', { token: other.token })).status, 200, 'per person');
  } finally {
    await limited.close();
  }
});
