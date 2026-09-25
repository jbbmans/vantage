import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { buildZip } from '../../server/lib/zip.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };

const CSV = [
  'Rank,First Name,Last Name,L2 Command,Fire Team,Username,Email,Temporary Password,Role,Billet',
  'SSgt,Avery,Stone,Test Command,Alpha Cell,avery.stone,avery.stone@example.mil,QuartzHarborLane4!,Fire Team Leader,Section chief',
  'Cpl,Blake,Rivers,Test Command,Alpha Cell,blake.rivers,blake.rivers@example.mil,CedarMeadowRun7#,Marine,',
  'LCpl,Casey,North,Test Command,Bravo Cell,casey.north,,,Marine,',
  'Cpl,Drew,Bad,Test Command,Bravo Cell,drew bad,,CedarMeadowRun7#,Marine,',
  'Cpl,Emery,Weak,Test Command,Bravo Cell,emery.weak,,password1234567,Marine,',
  'Cpl,Finley,Boss,Test Command,Bravo Cell,finley.boss,,CedarMeadowRun7#,Unit Leader,',
  'Wizard,Harper,Odd,Test Command,Bravo Cell,harper.odd,avery.stone@example.mil,CedarMeadowRun7#,NCO,',
].join('\n');
const csv = { 'content-type': 'text/csv', 'x-vantage-filename': 'roster.csv' };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
});
after(() => app.close());

test('a preview reports every row and writes nothing', async () => {
  const users = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const r = await app.call('POST', '/api/admin/accounts/import', { token: op.token, raw: Buffer.from(CSV), headers: csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.counts, { create: 4, exists: 0, error: 3, new_units: 3 });
  const byUser = Object.fromEntries(r.body.accounts.map((a: { username: string }) => [a.username, a]));
  assert.equal(byUser['drew bad'].status, 'error');
  assert.match(byUser['emery.weak'].problems.join(' '), /Temporary password/);
  assert.match(byUser['finley.boss'].problems.join(' '), /Unit Leader/);
  assert.equal(byUser['harper.odd'].status, 'create');
  assert.match(byUser['harper.odd'].warnings.join(' '), /not a rank/);
  assert.match(byUser['harper.odd'].warnings.join(' '), /email already belongs/);
  assert.equal(byUser['casey.north'].generated_password, true);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, users);
});

test('applying creates the accounts, their units, ranks, roles and billets, all on temporary passwords', async () => {
  const r = await app.call('POST', '/api/admin/accounts/import?apply=1', { token: op.token, raw: Buffer.from(CSV), headers: csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 4);
  assert.deepEqual(r.body.generated.map((g: { username: string }) => g.username), ['casey.north']);

  const avery = app.ctx.db.prepare(`SELECT u.rank_id, u.email, u.must_change_password, m.unit_id, m.billet, un.parent_id FROM users u JOIN unit_members m ON m.user_id = u.id JOIN units un ON un.id = m.unit_id WHERE u.username = 'avery.stone'`).get() as Record<string, unknown>;
  assert.deepEqual(avery, { rank_id: 'SSgt', email: 'avery.stone@example.mil', must_change_password: 1, unit_id: 'ALPHA-CELL', billet: 'Section chief', parent_id: 'TEST-COMMAND' });
  const roles = app.ctx.db.prepare(`SELECT r.key FROM member_roles mr JOIN roles r ON r.id = mr.role_id JOIN users u ON u.id = mr.user_id WHERE u.username = 'avery.stone' ORDER BY r.key`).all().map((x) => (x as { key: string }).key);
  assert.deepEqual(roles, ['fire-team-leader', 'marine']);
  const owners = app.ctx.db.prepare(`SELECT owner_user_id FROM units WHERE id IN ('TEST-COMMAND', 'ALPHA-CELL', 'BRAVO-CELL')`).all() as Array<{ owner_user_id: string }>;
  assert.deepEqual(owners.map((o) => o.owner_user_id), [op.id, op.id, op.id], 'the importer leads every unit it creates');

  const login = await app.login('avery.stone', 'QuartzHarborLane4!');
  assert.equal(login.status, 200);
  assert.equal(login.body.mustChangePassword, true);
  const generated = r.body.generated[0].password as string;
  assert.equal((await app.login('casey.north', generated)).status, 200);

  const again = await app.call('POST', '/api/admin/accounts/import?apply=1', { token: op.token, raw: Buffer.from(CSV), headers: csv });
  assert.equal(again.body.created, 0, 'importing the same roster twice changes nothing');
  assert.equal(again.body.counts.exists, 4);
});

test('an .xlsx roster works, and only a recently confirmed Instance Operator may import', async () => {
  const shared = ['Username', 'First Name', 'Last Name', 'Rank', 'jordan.lee', 'Jordan', 'Lee', 'Cpl'];
  const row = (n: number, cells: number[]) => `<row r="${n}">${cells.map((s, i) => `<c r="${'ABCD'[i]}${n}" t="s"><v>${s}</v></c>`).join('')}</row>`;
  const book = buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<worksheet><sheetData>${row(1, [0, 1, 2, 3])}${row(2, [4, 5, 6, 7])}</sheetData></worksheet>` },
  ]);
  const xlsx = { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x-vantage-filename': 'people.xlsx' };

  const marine = await app.register('plainmarine');
  await enroll(app, op.token, 'G8', marine.id);
  const denied = await app.call('POST', '/api/admin/accounts/import', { token: (await app.login('plainmarine')).body.token, raw: book, headers: xlsx });
  assert.equal(denied.status, 403);

  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
  const stale = await app.call('POST', '/api/admin/accounts/import', { token: op.token, raw: book, headers: xlsx });
  assert.equal(stale.body.code, 'sudo_required');
  await app.call('POST', '/api/auth/sudo', { token: op.token, body: { password: PASSWORD } });

  const r = await app.call('POST', '/api/admin/accounts/import?apply=1', { token: op.token, raw: book, headers: xlsx });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 1);
  assert.equal(r.body.generated.length, 1);
  assert.equal((app.ctx.db.prepare(`SELECT rank_id FROM users WHERE username = 'jordan.lee'`).get() as { rank_id: string }).rank_id, 'Cpl');
});

test('a file with no usable header is refused plainly', async () => {
  const r = await app.call('POST', '/api/admin/accounts/import', { token: op.token, raw: Buffer.from('Name,Rank\nSmith,Cpl'), headers: csv });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Username/);
});
