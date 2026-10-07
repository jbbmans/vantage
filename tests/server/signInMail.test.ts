import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { layout } from '../../server/services/mailLayout.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };

const CSV = [
  'Rank,First Name,Last Name,L2 Command,Fire Team,Username,Email,Temporary Password,Role',
  'SSgt,Avery,Stone,Test Command,Alpha Cell,avery.stone,avery.stone@example.mil,QuartzHarborLane4!,Marine',
  'Cpl,Blake,Rivers,Test Command,Alpha Cell,blake.rivers,blake.rivers@example.mil,,Marine',
  'LCpl,Casey,North,Test Command,Bravo Cell,casey.north,,,Marine',
].join('\n');

const linkIn = (text: string) => decodeURIComponent(text.match(/reset\?token=([^\s]+)/)![1]);

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  const r = await app.call('POST', '/api/orgs/G8/accounts/import?apply=1', { token: op.token, raw: Buffer.from(CSV), headers: { 'content-type': 'text/csv', 'x-vantage-filename': 'roster.csv' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
});
after(() => app.close());

const idOf = (username: string) => (app.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id;

test('the audience is every other active account, split by whether there is an address', async () => {
  const r = await app.call('GET', '/api/orgs/G8/accounts/sign-in-details', { token: op.token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.emailEnabled, true);
  assert.equal(r.body.linkHours, 72);
  assert.deepEqual(r.body.recipients.map((p: { username: string }) => p.username).sort(), ['avery.stone', 'blake.rivers']);
  assert.deepEqual(r.body.withoutEmail.map((p: { username: string }) => p.username), ['casey.north']);
  assert.ok(!r.body.recipients.some((p: { id: string }) => p.id === op.id), 'the sender is not in their own audience');
  assert.equal(r.body.recipients[0].sent_at, null);
});

test('each person gets their username and a one-time link that signs them in with a password they choose', async () => {
  const before = app.ctx.mailer.outbox.length;
  const r = await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: [idOf('avery.stone'), idOf('casey.north'), op.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x: { status: string }) => x.status), ['sent', 'skipped', 'skipped']);
  assert.match(r.body.results[1].error, /No email/);
  assert.match(r.body.results[2].error, /your own/);
  assert.equal(app.ctx.mailer.outbox.length, before + 1);

  const mail = app.ctx.mailer.outbox.at(-1)!;
  assert.equal(mail.to, 'avery.stone@example.mil');
  assert.equal(mail.kind, 'sign_in');
  assert.equal(mail.subject, 'Your Vantage sign-in details');
  assert.match(mail.text, /Username: avery\.stone/);
  assert.match(mail.text, /Welcome to Vantage, SSgt Stone/);
  assert.match(mail.html, /avery\.stone/);
  assert.doesNotMatch(mail.text, /QuartzHarborLane4!/, 'no password is ever emailed');
  assert.doesNotMatch(mail.html, /QuartzHarborLane4!/);

  // Sending does not change the current password.
  assert.equal((await app.login('avery.stone', 'QuartzHarborLane4!')).status, 200);

  const token = linkIn(mail.text);
  const status = await app.call('GET', `/api/auth/reset?token=${encodeURIComponent(token)}`);
  assert.equal(status.body.valid, true);
  assert.equal(status.body.purpose, 'sign_in');
  assert.equal(status.body.username, 'avery.stone');

  const set = await app.call('POST', '/api/auth/reset', { body: { token, password: PASSWORD } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.mustChangePassword, false);
  assert.equal((await app.login('avery.stone', PASSWORD)).status, 200);
  assert.equal((await app.call('POST', '/api/auth/reset', { body: { token, password: 'another-brand-new-passphrase-99' } })).status, 400, 'the link works once');

  const audit = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'sign_in_details_sent' ORDER BY rowid DESC LIMIT 1").get() as { detail: string };
  assert.match(audit.detail, /avery\.stone; sent/);
});

test('sending again replaces the earlier link, and the audience remembers who was sent one', async () => {
  const id = idOf('blake.rivers');
  await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: [id] } });
  const first = linkIn(app.ctx.mailer.outbox.at(-1)!.text);
  await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: [id, id] } });
  assert.equal(app.ctx.mailer.outbox.filter((m) => m.to === 'blake.rivers@example.mil').length, 2, 'a repeated id is sent once');
  const second = linkIn(app.ctx.mailer.outbox.at(-1)!.text);
  assert.equal((await app.call('GET', `/api/auth/reset?token=${encodeURIComponent(first)}`)).body.valid, false);
  assert.equal((await app.call('GET', `/api/auth/reset?token=${encodeURIComponent(second)}`)).body.valid, true);

  const audience = await app.call('GET', '/api/orgs/G8/accounts/sign-in-details', { token: op.token });
  const blake = audience.body.recipients.find((p: { username: string }) => p.username === 'blake.rivers');
  assert.ok(blake.sent_at);
});

test('someone who already signs in is told their password still works', async () => {
  await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: [idOf('avery.stone')] } });
  const mail = app.ctx.mailer.outbox.at(-1)!;
  assert.match(mail.text, /Your Vantage sign-in, SSgt Stone/);
  assert.match(mail.text, /keep using it/);
});

test('only an owner who recently confirmed their password may send, and batches are bounded', async () => {
  const marine = await app.register('plainmarine', { email: 'plain@example.mil' });
  // Someone with no role in the organization is not told it exists.
  assert.equal((await app.call('GET', '/api/orgs/G8/accounts/sign-in-details', { token: marine.token })).status, 404);
  assert.equal((await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: marine.token, body: { userIds: [idOf('avery.stone')] } })).status, 404);
  const tooMany = Array.from({ length: 26 }, (_, i) => `id-${i}`);
  assert.equal((await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: tooMany } })).status, 400);
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
  const stale = await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: [idOf('avery.stone')] } });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'sudo_required');
  await app.call('POST', '/api/auth/sudo', { token: op.token, body: { password: PASSWORD } });
});

test('a password reset link still says nothing about the account', async () => {
  await app.call('POST', '/api/auth/forgot', { body: { identifier: 'blake.rivers' } });
  const token = linkIn(app.ctx.mailer.outbox.at(-1)!.text);
  const status = await app.call('GET', `/api/auth/reset?token=${encodeURIComponent(token)}`);
  assert.equal(status.body.valid, true);
  assert.equal(status.body.username, undefined);
  assert.equal(status.body.purpose, undefined);
});

test('the layout escapes everything it is given and keeps a plain-text part', () => {
  const mail = layout({
    eyebrow: '<b>eyebrow</b>', title: 'Title <script>alert(1)</script>', intro: 'Line one\nLine two\n\nSecond "paragraph"',
    details: [{ label: 'User<name>', value: 'a&b', mono: true }], stats: [{ label: 'x', value: '<1>' }],
    sections: [{ heading: 'H', lines: ['<img src=x onerror=alert(1)>'] }], cta: { label: 'Go', url: 'https://example.test/a?b=1&c="2"' },
    note: 'Note <i>', footer: 'Foot <u>', origin: 'https://vantage.example.test',
  });
  assert.doesNotMatch(mail.html, /<script>|<img src=x|<b>eyebrow|<i>|<u>|User<name>/);
  assert.match(mail.html, /Title &lt;script&gt;/);
  assert.match(mail.html, /href="https:\/\/example\.test\/a\?b=1&amp;c=&quot;2&quot;"/);
  assert.match(mail.html, /Line one<br>Line two<\/p><p[^>]*>Second &quot;paragraph&quot;/);
  assert.match(mail.html, /https:\/\/vantage\.example\.test\/brand\/email-mark\.png/);
  assert.match(mail.text, /Go: https:\/\/example\.test\/a\?b=1&c="2"/);
  assert.match(mail.text, /User<name>: a&b/);
  // No mark over plain http: a local deployment's image would only ever be broken.
  assert.doesNotMatch(layout({ title: 't', intro: 'i', origin: 'http://localhost:5173' }).html, /email-mark\.png/);
});
