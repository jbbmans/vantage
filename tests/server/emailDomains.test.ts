import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { asciiDomain, describeAllowedDomains, domainAllowed, parseAllowedDomains, recipientDomain, recipientRefusal } from '../../server/lib/recipientDomains.ts';
import { loadConfig } from '../../server/config.ts';
import { orgOfUnit } from '../../server/authz/scope.ts';
import { newId, now } from '../../server/lib/ids.ts';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { issueToken } from '../../server/auth/tokens.ts';
import { encryptSecret } from '../../server/lib/crypto.ts';
import { localClock, runDigestTick } from '../../server/services/digest.ts';
import { zoneOf } from '../../server/lib/zone.ts';
import { isPlainEmail, plainAddress } from '../../shared/emailAddress.ts';

// Who Vantage may email (VANTAGE_EMAIL_ALLOWED_DOMAINS, ADR-0048): a recipient outside the list is refused before any
// provider sees the message, logged, and audited.

test('the list reads exact domains and whole subdomain trees, in any case, and names what is not a domain', () => {
  assert.deepEqual(parseAllowedDomains(undefined), { domains: null, problems: [] });
  assert.deepEqual(parseAllowedDomains('  '), { domains: null, problems: [] });
  assert.deepEqual(parseAllowedDomains('USMC.mil, @mail.mil;*.Navy.MIL  usmc.mil').domains, ['usmc.mil', 'mail.mil', '*.navy.mil']);
  assert.deepEqual(parseAllowedDomains('bücher.de').domains, ['xn--bcher-kva.de'], 'an international name in its ASCII form');
  for (const bad of ['mil', '*.', 'not_a_domain.mil', '-lead.mil', 'trail-.mil', 'a..mil', '10.0.0.1', '*.*.mil', 'usmc.mil/x', 'usmc.mil?x', 'usmc.mil#x', 'x@usmc.mil', 'usmc.mil\u200b', 'usmc\u00admil.com', 'usmc.ｍｉｌ']) {
    assert.deepEqual(parseAllowedDomains(`usmc.mil, ${bad}`).problems, [bad], `${bad} is refused`);
  }
  // A single name receives no mail, but "*.mil" names everything under one.
  assert.deepEqual(parseAllowedDomains('*.mil').domains, ['*.mil']);
  assert.equal(asciiDomain('USMC.MIL'), 'usmc.mil');
  assert.equal(asciiDomain('usmc.mil.'), null);
  assert.equal(asciiDomain('xn--bcher-kva.de'), 'xn--bcher-kva.de', 'written in its ASCII form already');
  assert.equal(asciiDomain('bu\u0308cher.de'), 'xn--bcher-kva.de', 'a decomposed letter is the same name');
});

test('an exact entry is that domain only, a "*." entry every subdomain but not the domain, and lookalikes are refused', () => {
  const list = ['usmc.mil', '*.navy.mil'];
  const allowed = ['a@usmc.mil', 'First.Last@USMC.MIL', 'a+tag@usmc.mil', "o'neil@usmc.mil", 'a@fleet.navy.mil', 'a@x.y.navy.mil'];
  for (const address of allowed) assert.equal(recipientRefusal(list, address), null, `${address} is allowed`);
  const outside = ['a@gmail.com', 'a@navy.mil', 'a@usmc.mil.evil.com', 'a@evilusmc.mil', 'a@sub.usmc.mil', 'a@navy.mil.evil.com', 'a@evilnavy.mil'];
  for (const address of outside) assert.match(recipientRefusal(list, address) ?? '', /^Vantage emails only addresses at usmc\.mil or any subdomain of navy\.mil\. \S+ is not one of them\.$/, `${address} is refused`);
  // Anything that is not one plain address could carry a second recipient past the check, so it never goes.
  const notOne = ['a@usmc.mil,b@gmail.com', 'a@usmc.mil;b@gmail.com', 'a@usmc.mil b@gmail.com', '"Boss" <a@usmc.mil>', 'Boss <a@usmc.mil>', 'a@b@usmc.mil',
    'a@usmc.mil\r\nBcc: b@gmail.com', 'a@usmc.mil\nb@gmail.com', '"a@gmail.com"@usmc.mil', 'a(comment)@usmc.mil', 'a@[127.0.0.1]', 'a@usmc.mil.', '@usmc.mil', 'a@', '', 'a\u0000@usmc.mil',
    'a@usmc.mil/x', 'a@usmc.mil?x', 'a@gmail.com#usmc.mil', 'a@usmc.mil\u200b', 'a@usmc.ｍｉｌ', 'a@usmc\u00ad.mil'];
  for (const address of notOne) {
    assert.equal(recipientDomain(address), null, JSON.stringify(address));
    assert.equal(recipientRefusal(list, address), 'That is not one email address, so Vantage did not send to it.', JSON.stringify(address));
    assert.equal(recipientRefusal(null, address), 'That is not one email address, so Vantage did not send to it.', 'even with no list');
  }
  // No list: any one address goes.
  assert.equal(recipientRefusal(null, 'a@gmail.com'), null);
  assert.equal(domainAllowed(['xn--bcher-kva.de'], recipientDomain('a@bücher.de')!), true, 'an international domain is matched in its ASCII form');
  assert.equal(describeAllowedDomains(['a.mil', 'b.mil', 'c.mil', 'd.mil', 'e.mil', 'f.mil', 'g.mil']), 'a.mil, b.mil, c.mil, d.mil, e.mil or 2 more');
});

const MCEN = {
  NODE_ENV: 'production', VANTAGE_TEST: '', VANTAGE_SECRET: 's'.repeat(40), VANTAGE_SETUP_TOKEN: 't'.repeat(30), VANTAGE_DEPLOYMENT_PROFILE: 'mcen',
  VANTAGE_APP_URL: 'https://vantage.example.mil', VANTAGE_PUBLIC_URL: '', VANTAGE_SITE_URL: '', VANTAGE_CONSOLE_URL: '', VANTAGE_ADMIN_URL: '',
  VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtps://relay.example.mil:465',
};
const startError = (env: Record<string, string>) => { try { loadConfig(env as NodeJS.ProcessEnv); return null; } catch (e) { return (e as Error).message; } };

test('on MCEN mail is sent only with the list set; anywhere, an entry that is not a domain stops the start', () => {
  const refused = startError(MCEN);
  assert.ok(refused?.startsWith('VANTAGE_DEPLOYMENT_PROFILE=mcen refuses:'), String(refused));
  assert.match(refused!, /VANTAGE_EMAIL_ALLOWED_DOMAINS: on MCEN mail goes only to the domains the enterprise names/);
  assert.equal(startError({ ...MCEN, VANTAGE_EMAIL_ALLOWED_DOMAINS: 'usmc.mil, *.usmc.mil' }), null);
  assert.deepEqual(loadConfig({ ...MCEN, VANTAGE_EMAIL_ALLOWED_DOMAINS: 'usmc.mil, *.usmc.mil' } as NodeJS.ProcessEnv).email.allowedDomains, ['usmc.mil', '*.usmc.mil']);
  // With mail off there is nothing to limit.
  assert.equal(startError({ ...MCEN, VANTAGE_EMAIL_PROVIDER: '', SMTP_URL: '' }), null);
  const dev = { NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory' };
  assert.equal(loadConfig(dev as NodeJS.ProcessEnv).email.allowedDomains, null, 'elsewhere no list is every domain, as before');
  assert.match(startError({ ...dev, VANTAGE_EMAIL_ALLOWED_DOMAINS: 'usmc.mil, gmail' }) ?? '', /^VANTAGE_EMAIL_ALLOWED_DOMAINS: "gmail" is not a domain\./);
  assert.match(startError({ ...MCEN, VANTAGE_EMAIL_ALLOWED_DOMAINS: 'usmc.mil, gmail' }) ?? '', /"gmail" is not a domain/);
});

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => {
  app = await startApp({ VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil, *.navy.mil' });
  op = await app.setupOperator();
});
after(() => app.close());

const REASON = /^Vantage emails only addresses at example\.mil or any subdomain of navy\.mil\. gmail\.com is not one of them\.$/;
const refusals = () => app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'email_refused' ORDER BY rowid").all() as Array<Record<string, string | null>>;
const lastRefusal = () => refusals().at(-1)!;
const logRow = (id: string | null) => app.ctx.db.prepare('SELECT * FROM email_log WHERE id = ?').get(id) as Record<string, string | null>;
const tokens = (kind: string, userId?: string) => (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE kind = ?${userId ? ' AND user_id = ?' : ''}`).get(...(userId ? [kind, userId] : [kind])) as { n: number }).n;

test('a refused send never reaches the provider: it is logged as refused and audited with who, for whom, where and the domain only', async () => {
  const outbox = app.ctx.mailer.outbox.length;
  const orgId = orgOfUnit(app.ctx, 'G8');
  const result = await app.ctx.mailer.send({ to: 'someone@gmail.com', subject: 'Hello', text: 't', html: '<p>h</p>', kind: 'invite', userId: op.id, orgId, actorId: op.id });
  assert.deepEqual({ ok: result.ok, refused: result.refused }, { ok: false, refused: true });
  assert.match(result.error!, REASON);
  assert.equal(app.ctx.mailer.outbox.length, outbox, 'nothing was handed over');
  const entry = lastRefusal();
  assert.equal(entry.actor_id, op.id);
  assert.equal(entry.subject_id, op.id);
  assert.equal(entry.org_id, orgId);
  assert.equal(entry.category, 'enterprise');
  assert.equal(entry.entity, 'email_log');
  assert.equal(entry.detail, 'invite; gmail.com is not on the allowed domains');
  assert.doesNotMatch(JSON.stringify(entry), /someone@/, 'the trail names the domain, not the address');
  const row = logRow(entry.entity_id);
  assert.equal(row.status, 'refused');
  assert.equal(row.to_address, 'someone@gmail.com');
  assert.match(row.error!, REASON);
  // An address inside the list still goes.
  assert.equal((await app.ctx.mailer.send({ to: 'someone@fleet.navy.mil', subject: 'Hello', text: 't', html: '<p>h</p>', kind: 'test' })).ok, true);
  assert.equal(app.ctx.mailer.outbox.length, outbox + 1);
});

test('a team message counts who is outside the list, before and after, and emails only those inside it', async () => {
  const inside = await app.register('insidemarine', { email: 'inside@example.mil' });
  const outside = await app.register('outsidemarine', { email: 'outside@gmail.com' });
  for (const u of [inside, outside]) await enroll(app, op.token, 'G8', u.id);
  const audience = await app.call('GET', '/api/org/units/G8/message', { token: op.token });
  const { files: filesGate, ...reach } = audience.body;
  assert.deepEqual(reach, { members: 2, withEmail: 1, refused: 1, appOnly: 1, emailEnabled: true, limit: 300 });
  assert.match(filesGate.refusal, /outside the allowed domains \(gmail\.com\)/, 'files are refused while anyone on the list is outside it');
  const before = refusals().length;
  const sent = await app.call('POST', '/api/org/units/G8/message', { token: op.token, body: { subject: 'Muster', body: 'At 0700.' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const { id: kept, ...counts } = sent.body;
  assert.deepEqual(counts, { recipients: 2, emailed: 1, queued: 0, failed: 0, refused: 1, appOnly: 1, files: 0 });
  assert.ok(app.ctx.db.prepare('SELECT 1 FROM team_messages WHERE id = ?').get(kept), 'the message is kept');
  assert.equal(app.ctx.mailer.outbox.filter((m) => m.kind === 'team_message' && m.to === 'outside@gmail.com').length, 0);
  assert.equal(refusals().length, before + 1);
  assert.equal(lastRefusal().subject_id, outside.id);
  assert.equal(lastRefusal().actor_id, op.id);
  const trail = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'team_message' ORDER BY rowid DESC LIMIT 1").get() as { detail: string };
  assert.match(trail.detail, /1 emailed, 0 queued, 0 failed, 1 in Vantage only \(1 refused by the address check\)/);
  // Both still have it in Vantage.
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'unit'").get(outside.id) as { n: number }).n, 1);
});

test('a password reset to an address outside the list issues no link and answers exactly as one that was sent', async () => {
  const marine = await app.register('resetoutside', { email: 'reset.outside@gmail.com' });
  const insideAnswer = await app.call('POST', '/api/auth/forgot', { body: { identifier: 'boletz' } });
  const before = tokens('reset', marine.id);
  const answer = await app.call('POST', '/api/auth/forgot', { body: { identifier: 'resetoutside' } });
  assert.equal(answer.status, insideAnswer.status);
  assert.deepEqual(answer.body, insideAnswer.body);
  assert.equal(tokens('reset', marine.id), before, 'no link was made');
  assert.equal(app.ctx.mailer.outbox.filter((m) => m.to === 'reset.outside@gmail.com').length, 0);
  assert.equal(lastRefusal().subject_id, marine.id);
  assert.equal(lastRefusal().detail, 'reset; gmail.com is not on the allowed domains');
  assert.equal(lastRefusal().org_id, null, 'an account’s own mail is in the platform’s trail');
  const asked = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'password_reset_requested' AND subject_id = ?").get(marine.id) as { n: number };
  assert.equal(asked.n, 1, 'the request itself is still recorded');
});

test('changing to an address outside the list is refused on the field, before any link is made', async () => {
  const before = tokens('email_change');
  const res = await app.call('POST', '/api/me/email/verify', { token: op.token, body: { email: 'boletz@gmail.com' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, REASON);
  assert.match(res.body.fieldErrors.email, REASON);
  assert.equal(tokens('email_change'), before);
  assert.equal(lastRefusal().detail, 'email_change; gmail.com is not on the allowed domains');
  assert.equal(lastRefusal().actor_id, op.id);
  assert.equal((await app.call('POST', '/api/me/email/verify', { token: op.token, body: { email: 'boletz@fleet.navy.mil' } })).status, 200);
});

test('an invitation to an address outside the list is still made, and the leader is told why it was not emailed', async () => {
  const res = await app.call('POST', '/api/org/units/G8/invites', { token: op.token, body: { email: 'recruit@gmail.com', first_name: 'Rae', last_name: 'Ward' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.emailed, false);
  assert.match(res.body.emailError, REASON);
  assert.match(res.body.url, /\/invite\?token=/);
  assert.equal(lastRefusal().org_id, orgOfUnit(app.ctx, 'G8'));
  assert.equal(lastRefusal().detail, 'invite; gmail.com is not on the allowed domains');
});

test('the Vantage Administrator console test, the weekly digest and sign-in details refuse an outside address too', async () => {
  const test = await app.call('POST', '/api/platform/email/test', { token: op.token, body: { to: 'admin@gmail.com' } });
  assert.equal(test.status, 400);
  assert.match(test.body.error, REASON);
  const listed = await app.call('POST', '/api/platform/email/test', { token: op.token, body: { to: ['admin@example.mil', 'admin@gmail.com'] } });
  assert.equal(listed.status, 400, 'a list is not one address');
  assert.equal(lastRefusal().detail, 'test; not one email address');
  const setup = await app.call('GET', '/api/platform/email', { token: op.token });
  assert.deepEqual(setup.body.allowedDomains, ['example.mil', '*.navy.mil'], 'the Email tab shows the list');

  const reader = await app.register('digestreader', { email: 'digest.reader@gmail.com' });
  const digest = await app.call('POST', '/api/me/digest/send-now', { token: reader.token });
  assert.equal(digest.status, 400);
  assert.match(digest.body.error, REASON);
  assert.equal(lastRefusal().detail, 'digest; gmail.com is not on the allowed domains');
  assert.equal(lastRefusal().actor_id, reader.id);

  const csv = ['Rank,First Name,Last Name,L2 Command,Fire Team,Username,Email,Temporary Password,Role', 'Sgt,Gale,Moss,Test Command,Alpha Cell,gale.moss,gale.moss@gmail.com,,Marine'].join('\n');
  const imported = await app.call('POST', '/api/orgs/G8/accounts/import?apply=1', { token: op.token, raw: Buffer.from(csv), headers: { 'content-type': 'text/csv', 'x-vantage-filename': 'roster.csv' } });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const gale = (app.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('gale.moss') as { id: string }).id;
  // A link Gale already holds, sent before the list changed.
  const earlier = issueToken(app.ctx, 'reset', { userId: gale, email: 'gale.moss@gmail.com', ttlMinutes: 60 });
  const before = tokens('reset', gale);
  const details = await app.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: op.token, body: { userIds: [gale] } });
  assert.equal(details.status, 200, JSON.stringify(details.body));
  assert.equal(details.body.results[0].status, 'failed');
  assert.match(details.body.results[0].error, REASON);
  assert.equal(tokens('reset', gale), before, 'no new link was made');
  const held = app.ctx.db.prepare('SELECT used_at FROM tokens WHERE id = ?').get(earlier.id) as { used_at: string | null };
  assert.equal(held.used_at, null, 'the link already sent keeps working');
  const check = await app.call('GET', `/api/auth/reset?token=${encodeURIComponent(earlier.token)}`);
  assert.equal(check.body.valid, true);
  assert.equal(lastRefusal().detail, 'sign_in; gmail.com is not on the allowed domains');
  assert.equal(lastRefusal().org_id, orgOfUnit(app.ctx, 'G8'));
});

test('a message waiting for a retry is checked again, and refused if its domain has left the list', async () => {
  const direct = await startApp({ VANTAGE_EMAIL_PROVIDER: 'direct', VANTAGE_EMAIL_FROM: 'Vantage <no-reply@vantage.test>', VANTAGE_EMAIL_DIRECT_ROUTE: '127.0.0.1:9', VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil' });
  try {
    const logId = newId();
    const at = now();
    direct.ctx.db.prepare('INSERT INTO email_log (id, user_id, to_address, kind, subject, status, error, created_at, org_id) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, NULL)').run(logId, 'queued@gmail.com', 'invite', 'Invitation', 'queued', at);
    direct.ctx.db.prepare('INSERT INTO email_queue (id, log_id, to_address, kind, payload, attempts, next_attempt_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run(newId(), logId, 'queued@gmail.com', 'invite', 'unread', new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), at);
    const counts = await direct.ctx.mailer.retryQueued();
    assert.deepEqual(counts, { sent: 0, failed: 1, waiting: 0 });
    assert.equal((direct.ctx.db.prepare('SELECT COUNT(*) AS n FROM email_queue').get() as { n: number }).n, 0, 'the message is gone from the queue');
    const row = direct.ctx.db.prepare('SELECT status, error FROM email_log WHERE id = ?').get(logId) as { status: string; error: string };
    assert.equal(row.status, 'refused');
    assert.match(row.error, /gmail\.com is not one of them/);
    const entry = direct.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'email_refused'").get() as Record<string, string | null>;
    assert.equal(entry.entity_id, logId);
    assert.equal(entry.detail, 'invite; gmail.com is not on the allowed domains');
    assert.equal(entry.actor_id, null, 'a payload that cannot be read names nobody');

    // Queued with who caused it, the refusal at retry names them, as one at send would.
    const leader = (await direct.setupOperator()).id;
    const sealedLog = newId();
    direct.ctx.db.prepare('INSERT INTO email_log (id, user_id, to_address, kind, subject, status, error, created_at, org_id) VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, NULL)').run(sealedLog, 'team@gmail.com', 'team_message', 'Muster', 'queued', at);
    const payload = encryptSecret(direct.ctx.config.secret, JSON.stringify({ subject: 'Muster', text: 't', html: '<p>h</p>', replyTo: null, userId: null, actorId: leader }));
    direct.ctx.db.prepare('INSERT INTO email_queue (id, log_id, to_address, kind, payload, attempts, next_attempt_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run(newId(), sealedLog, 'team@gmail.com', 'team_message', payload, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 3_600_000).toISOString(), at);
    await direct.ctx.mailer.retryQueued();
    const named = direct.ctx.db.prepare("SELECT actor_id FROM audit_log WHERE action = 'email_refused' AND entity_id = ?").get(sealedLog) as { actor_id: string | null };
    assert.equal(named.actor_id, leader);
  } finally { await direct.close(); }
});

test('a weekly digest to a refused address is refused once that week, not at every tick of its hour', async () => {
  const reader = await app.register('weeklyoutside', { email: 'weekly.outside@gmail.com' });
  // Four ticks a quarter hour apart, all in the hour the digest is set for.
  const hourStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 60_000);
  const clock = localClock(zoneOf(app.ctx, null), hourStart);
  app.ctx.db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify({ digest: { enabled: true, weekday: clock.weekday, hour: clock.hour } }), reader.id);
  for (const minutes of [0, 15, 30, 45]) await runDigestTick(app.ctx, new Date(hourStart.getTime() + minutes * 60_000));
  const logged = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE user_id = ? AND kind = 'digest' AND status = 'refused'").get(reader.id) as { n: number };
  assert.equal(logged.n, 1);
  const audited = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'email_refused' AND subject_id = ?").get(reader.id) as { n: number };
  assert.equal(audited.n, 1);
  assert.equal((app.ctx.db.prepare('SELECT digest_last_sent_at FROM users WHERE id = ?').get(reader.id) as { digest_last_sent_at: string | null }).digest_last_sent_at, null, 'nothing is stamped as sent');
});

test('an address field and the mailer read an address by one rule, and the mailer sends to the form it checked', async () => {
  const taken: Array<[string, string]> = [
    ['a@usmc.mil', 'a@usmc.mil'], ['First.Last@USMC.MIL', 'First.Last@usmc.mil'], ['a+tag@usmc.mil', 'a+tag@usmc.mil'], ["o'neil@usmc.mil", "o'neil@usmc.mil"],
    ['a@fleet.navy.mil', 'a@fleet.navy.mil'], ['a@bücher.de', 'a@xn--bcher-kva.de'], ['a@xn--bcher-kva.de', 'a@xn--bcher-kva.de'], ['a@bu\u0308cher.de', 'a@xn--bcher-kva.de'],
    ['a@1st-mardiv.usmc.mil', 'a@1st-mardiv.usmc.mil'], ['a@ß.de', 'a@xn--zca.de'],
  ];
  for (const [address, sent] of taken) {
    assert.equal(isPlainEmail(address), true, address);
    assert.equal(plainAddress(address), sent, `${address} goes to ${sent}`);
    assert.equal(recipientDomain(address), sent.split('@')[1], `${address} is checked at ${sent.split('@')[1]}`);
  }
  // Not one address, or a domain that does not mean what was written: refused by the field and by the mailer alike.
  const refused = [
    'name<a@x.mil>', '"n"<a@x.mil>', 'a;b@x.mil', 'a,b@x.mil', 'a(x)@x.mil', 'a@x.mil.', 'a@x', 'a@-x.mil', 'a@x-.mil', 'a@x..mil', 'a@x.mil/x', 'a@x.mil?q', 'a@x.mil:25',
    'a@1.2.3.4', 'me%gmail.com@usmc.mil', 'gmail.com!me@usmc.mil', 'a\u200b@x.mil', 'a@usmc.mil\u200b', 'a@usmc\u00admil.com', 'a@x.mil ', ' a@x.mil', 'a@usmc%2Emil',
    // Look-alikes that a URL parser would quietly map to another name: full-width, a Roman numeral, a ligature, a circled digit.
    'a@ｕsmc.mil', 'a@usmc.ｍｉｌ', 'a@Ⅻnavy.mil', 'a@ﬀ.com', 'a@①.com',
    // A variation selector, a label that starts with a combining mark, a bad punycode label, a symbol.
    'a@usmc.mil\uFE0F', 'a@\u0301x.mil', 'a@xn--a.com', 'a@☃.com', 'a@i❤.ws',
    'a@' + 'ü'.repeat(63) + '.de',
  ];
  for (const address of refused) {
    assert.equal(isPlainEmail(address), false, `field refuses ${JSON.stringify(address)}`);
    assert.equal(recipientDomain(address), null, `mailer refuses ${JSON.stringify(address)}`);
  }

  const registered = await app.call('POST', '/api/auth/register', { body: { username: 'displayname', password: 'cobalt-orbit-velvet-anchor-927', first_name: 'D', last_name: 'N', rank_id: 'LCpl', email: 'name<a@example.mil>' } });
  assert.equal(registered.status, 400);
  // The field says so itself, before the mailer is asked, so nothing is logged or audited for it.
  const logged = (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE status = 'refused'").get() as { n: number }).n;
  const audited = refusals().length;
  const changed = await app.call('POST', '/api/me/email/verify', { token: op.token, body: { email: 'boletz@example.mil.' } });
  assert.equal(changed.status, 400);
  assert.equal(changed.body.fieldErrors?.email, 'Not a valid email.');
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE status = 'refused'").get() as { n: number }).n, logged);
  assert.equal(refusals().length, audited);

  // What the provider is given is the form the check read, whatever the case or script it was written in.
  const idn = await startApp({ VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_EMAIL_ALLOWED_DOMAINS: 'bücher.de' });
  try {
    const result = await idn.ctx.mailer.send({ to: 'Ähre@BÜCHER.de', subject: 'S', text: 't', html: '<p>h</p>', kind: 'test' });
    assert.equal(result.ok, true);
    assert.equal(idn.ctx.mailer.outbox.at(-1)!.to, 'Ähre@xn--bcher-kva.de', 'the local part as written, the domain in ASCII');
    assert.equal((idn.ctx.db.prepare("SELECT to_address FROM email_log WHERE status = 'sent'").get() as { to_address: string }).to_address, 'Ähre@BÜCHER.de', 'the log keeps the address as given');
  } finally { await idn.close(); }
});

test('a provider’s own error stays in the mail log; the person asking is told only that it was not sent', async () => {
  const broken = await startApp({ VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://127.0.0.1:1' });
  try {
    const marine = await broken.setupOperator();
    const digest = await broken.call('POST', '/api/me/digest/send-now', { token: marine.token });
    assert.equal(digest.status, 400);
    assert.equal(digest.body.error, 'The digest could not be sent. Try again later.');
    const change = await broken.call('POST', '/api/me/email/verify', { token: marine.token, body: { email: 'relay.new@example.mil' } });
    assert.equal(change.status, 400);
    assert.equal(change.body.error, 'The confirmation could not be sent. Try again later.');
    // Sign-in details tell the Unit Manager the same, and the Unit Instance's trail carries no more than they see.
    const member = await broken.register('relaydown', { email: 'relay.down@example.mil' });
    await enroll(broken, marine.token, 'G8', member.id);
    const details = await broken.call('POST', '/api/orgs/G8/accounts/sign-in-details', { token: marine.token, body: { userIds: [member.id] } });
    assert.equal(details.status, 200, JSON.stringify(details.body));
    assert.deepEqual(details.body.results[0], { id: member.id, status: 'failed', error: 'The sign-in details could not be sent. Try again later.' });
    const trail = broken.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'sign_in_details_sent' AND subject_id = ?").get(member.id) as { detail: string };
    assert.equal(trail.detail, 'relaydown; failed; The sign-in details could not be sent. Try again later.');
    // An invitation says what the leader can do about it.
    const invite = await broken.call('POST', '/api/org/units/G8/invites', { token: marine.token, body: { email: 'new.hand@example.mil' } });
    assert.equal(invite.status, 201, JSON.stringify(invite.body));
    assert.equal(invite.body.emailError, 'The invitation could not be sent. Try again later. Copy the link and send it yourself.');
    assert.doesNotMatch(JSON.stringify([digest.body, change.body, details.body, invite.body, trail]), /ECONNREFUSED|127\.0\.0\.1/);
    const logged = broken.ctx.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE status = 'failed' AND error LIKE '%ECONNREFUSED%'").get() as { n: number };
    assert.equal(logged.n, 4, 'the mail log keeps each reason');
  } finally { await broken.close(); }
});
