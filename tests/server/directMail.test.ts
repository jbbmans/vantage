import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { startApp, type TestApp } from './helpers.ts';
import { dkimKey, requiredRecords, probePath, heloName, mergeSpf } from '../../server/services/directMail.ts';

interface Received { helo: string; from: string; to: string[]; data: string }

/** A receiving mail server, just enough of one: it records what it is sent and answers RCPT as told. */
function sink() {
  const received: Received[] = [];
  let rcptReply = '250 OK';
  const server: Server = createServer((socket: Socket) => {
    const msg: Received = { helo: '', from: '', to: [], data: '' };
    let inData = false;
    let buffer = '';
    socket.write('220 sink.test ESMTP ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          msg.data = buffer.slice(0, end + 2).replace(/\r\n\.\./g, '\r\n.');
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push({ ...msg, to: [...msg.to] });
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') { msg.helo = line.slice(5); socket.write('250-sink.test greets you [127.0.0.1]\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n'); }
        else if (verb === 'MAIL') { msg.from = line.match(/<([^>]*)>/)?.[1] || ''; socket.write('250 OK\r\n'); }
        else if (verb === 'RCPT') { if (rcptReply.startsWith('2')) msg.to.push(line.match(/<([^>]*)>/)?.[1] || ''); socket.write(`${rcptReply}\r\n`); }
        else if (verb === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); return; }
        else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('502 not here\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return {
    received, server,
    reply(r: string) { rcptReply = r; },
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port))),
  };
}

/** DKIM verification written from RFC 6376, independently of the signer: relaxed or simple canonicalization, rsa-sha256. */
function verifyDkim(raw: string, publicKeyB64: string) {
  const split = raw.indexOf('\r\n\r\n');
  const headerBlock = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const headers: Array<{ name: string; raw: string }> = [];
  for (const line of headerBlock.split('\r\n')) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].raw += `\r\n${line}`;
    else headers.push({ name: line.slice(0, line.indexOf(':')).trim().toLowerCase(), raw: line });
  }
  const sigHeader = headers.find((h) => h.name === 'dkim-signature');
  assert.ok(sigHeader, 'the message carries a DKIM-Signature');
  const tags = Object.fromEntries(sigHeader.raw.slice(sigHeader.raw.indexOf(':') + 1).replace(/\r\n[ \t]+/g, ' ').split(';').map((t) => t.trim()).filter(Boolean).map((t) => [t.slice(0, t.indexOf('=')).trim(), t.slice(t.indexOf('=') + 1).trim()]));
  assert.equal(tags.a, 'rsa-sha256');
  const [hc, bc] = (tags.c || 'simple/simple').split('/');
  const relaxedHeader = (h: string) => { const i = h.indexOf(':'); return `${h.slice(0, i).trim().toLowerCase()}:${h.slice(i + 1).replace(/\r\n/g, '').replace(/[ \t]+/g, ' ').trim()}`; };
  const canonHeader = (h: string) => (hc === 'relaxed' ? relaxedHeader(h) : h);
  let canonBody = (bc || 'simple') === 'relaxed'
    ? body.split('\r\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ +$/, '')).join('\r\n')
    : body;
  canonBody = canonBody.replace(/(\r\n)*$/, '');
  canonBody = canonBody.length || bc !== 'relaxed' ? `${canonBody}\r\n` : '';
  const bodyHash = createHash('sha256').update(canonBody).digest('base64');
  assert.equal(bodyHash, tags.bh.replace(/\s+/g, ''), 'the body hash matches the body that arrived');
  const used = new Map<string, number>();
  const signed: string[] = [];
  for (const name of tags.h.split(':').map((n: string) => n.trim().toLowerCase())) {
    const all = headers.filter((h) => h.name === name);
    const n = used.get(name) || 0;
    const pick = all[all.length - 1 - n];
    used.set(name, n + 1);
    if (pick) signed.push(`${canonHeader(pick.raw)}\r\n`);
  }
  const bare = sigHeader.raw.replace(/(\bb=)[^;]*/, '$1');
  const data = signed.join('') + canonHeader(bare).replace(/\r\n$/, '');
  const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
  return { ok: verify('sha256', Buffer.from(data), key, Buffer.from(tags.b.replace(/\s+/g, ''), 'base64')), tags };
}

let app: TestApp;
let op: { token: string; id: string };
const mx = sink();

before(async () => {
  const port = await mx.listen();
  app = await startApp({ VANTAGE_EMAIL_PROVIDER: 'direct', VANTAGE_EMAIL_FROM: 'Vantage <no-reply@vantage.test>', VANTAGE_EMAIL_REPLY_TO: 'help@vantage.test', VANTAGE_EMAIL_DIRECT_ROUTE: `127.0.0.1:${port}` });
  op = await app.setupOperator();
});
after(async () => { await app?.close(); mx.server.close(); });

test('the instance makes its own signing key and names the records to publish', () => {
  const key = dkimKey(app.ctx.db, app.ctx.config);
  assert.equal(key.domain, 'vantage.test');
  assert.equal(key.selector, 'vantage');
  assert.equal(dkimKey(app.ctx.db, app.ctx.config).publicKey, key.publicKey, 'the key is kept, not remade');
  const stored = app.ctx.db.prepare("SELECT value FROM meta WHERE key = 'mail_dkim'").get() as { value: string };
  assert.ok(!stored.value.includes('PRIVATE KEY'), 'the private key is stored encrypted');
  const records = requiredRecords(app.ctx.db, app.ctx.config);
  assert.deepEqual(records.map((r) => r.fqdn), ['vantage._domainkey.vantage.test', 'vantage.test', '_dmarc.vantage.test']);
  assert.equal(records[0].value, `v=DKIM1; k=rsa; p=${key.publicKey}`);
});

test('the path check finds the port open and the address this server sends from', async () => {
  const path = await probePath(app.ctx.db, app.ctx.config);
  assert.equal(path.open, true, path.error);
  assert.equal(path.ip, '127.0.0.1');
  assert.ok(requiredRecords(app.ctx.db, app.ctx.config)[1].value.includes('ip4:127.0.0.1'), 'SPF names the address it found');
  assert.ok(heloName(app.ctx.db, app.ctx.config));
});

test('mail goes straight to the receiving server, DKIM-signed for the domain, with a reply address', async () => {
  const res = await app.call('POST', '/api/admin/email/test', { token: op.token, body: { to: 'avery@example.test' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const got = mx.received.at(-1)!;
  assert.equal(got.from, 'no-reply@vantage.test');
  assert.deepEqual(got.to, ['avery@example.test']);
  assert.match(got.data, /^From: Vantage <no-reply@vantage\.test>/m);
  assert.match(got.data, /^Reply-To: help@vantage\.test/m);
  const { ok, tags } = verifyDkim(got.data, dkimKey(app.ctx.db, app.ctx.config).publicKey);
  assert.equal(ok, true, 'the signature verifies against the published key');
  assert.equal(tags.d, 'vantage.test');
  assert.equal(tags.s, 'vantage');
  const log = app.ctx.db.prepare("SELECT status FROM email_log WHERE kind = 'test' ORDER BY created_at DESC LIMIT 1").get() as { status: string };
  assert.equal(log.status, 'sent');
});

test('a refusal is final, and a “try later” is queued encrypted and retried', async () => {
  mx.reply('550 5.1.1 no such user');
  const refused = await app.call('POST', '/api/admin/email/test', { token: op.token, body: { to: 'nobody@example.test' } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /550/);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM email_queue').get() as { n: number }).n, 0, 'a permanent refusal is not retried');

  mx.reply('451 4.7.1 greylisted, try again later');
  const later = await app.call('POST', '/api/admin/email/test', { token: op.token, body: { to: 'later@example.test' } });
  assert.equal(later.status, 200);
  assert.equal(later.body.queued, true);
  const row = app.ctx.db.prepare('SELECT * FROM email_queue').get() as { payload: string; log_id: string };
  assert.ok(row && !row.payload.includes('Vantage email is working'), 'the queued message is encrypted');
  assert.equal((app.ctx.db.prepare('SELECT status FROM email_log WHERE id = ?').get(row.log_id) as { status: string }).status, 'queued');

  mx.reply('250 OK');
  const before = mx.received.length;
  app.ctx.db.prepare("UPDATE email_queue SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
  const retry = await app.ctx.mailer.retryQueued();
  assert.deepEqual(retry, { sent: 1, failed: 0, waiting: 0 });
  assert.equal(mx.received.length, before + 1);
  assert.equal(mx.received.at(-1)!.to[0], 'later@example.test');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM email_queue').get() as { n: number }).n, 0);
  assert.equal((app.ctx.db.prepare('SELECT status FROM email_log WHERE id = ?').get(row.log_id) as { status: string }).status, 'sent');
});

test('the owner sees the records and the path in one place', async () => {
  const res = await app.call('GET', '/api/admin/email', { token: op.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'direct');
  assert.equal(res.body.domain, 'vantage.test');
  assert.equal(res.body.records.length, 3);
  assert.equal(res.body.path.open, true);
});

test('a leader emails the team: one copy each, replies to the leader, and everyone sees it in Vantage', async () => {
  const withEmail = await app.register('teamwithmail', { email: 'with.mail@example.test' });
  const noEmail = await app.register('teamnomail');
  for (const u of [withEmail, noEmail]) {
    const r = await app.call('POST', '/api/org/units/G8/members', { token: op.token, body: { user_id: u.id } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const audience = await app.call('GET', '/api/org/units/G8/message', { token: op.token });
  assert.deepEqual(audience.body, { members: 2, withEmail: 1, appOnly: 1, emailEnabled: true });

  const before = mx.received.length;
  const sent = await app.call('POST', '/api/org/units/G8/message', { token: op.token, body: { subject: 'Close-out Friday', body: 'Line one.\nLine two.' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.recipients, 2);
  assert.equal(sent.body.emailed, 1);
  assert.equal(sent.body.appOnly, 1);
  const got = mx.received.slice(before);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].to, ['with.mail@example.test'], 'each Marine gets their own copy');
  assert.match(got[0].data, /^Subject: \[G8\] Close-out Friday/m);
  assert.match(got[0].data, /^Reply-To: boletz@example\.mil/m, 'replies reach the leader, not the instance');
  assert.equal(verifyDkim(got[0].data, dkimKey(app.ctx.db, app.ctx.config).publicKey).ok, true);
  const notes = app.ctx.db.prepare("SELECT user_id FROM notifications WHERE title = 'G8: Close-out Friday'").all() as Array<{ user_id: string }>;
  assert.deepEqual(new Set(notes.map((n) => n.user_id)), new Set([withEmail.id, noEmail.id]));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'team_message' AND entity_id = 'G8'").get());

  const marine = (await app.login('teamnomail')).body.token;
  assert.equal((await app.call('POST', '/api/org/units/G8/message', { token: marine, body: { subject: 'x', body: 'y' } })).status, 403);
  const sneaky = mx.received.length;
  assert.equal((await app.call('POST', '/api/org/units/G8/message', { token: op.token, body: { subject: 'Hi\r\nBcc: attacker@example.test', body: 'text' } })).status, 200);
  const injected = mx.received.slice(sneaky)[0].data;
  assert.doesNotMatch(injected, /^Bcc:/mi, 'a subject cannot add headers');
  assert.match(injected, /^Subject: \[G8\] Hi Bcc: attacker@example\.test/m);
  for (let i = 0; i < 3; i++) assert.equal((await app.call('POST', '/api/org/units/G8/message', { token: op.token, body: { subject: `Note ${i}`, body: 'text' } })).status, 200);
  assert.equal((await app.call('POST', '/api/org/units/G8/message', { token: op.token, body: { subject: 'One too many', body: 'text' } })).status, 429);
});

test('SPF is merged into the record a domain already has, never published twice', () => {
  const forwarding = 'v=spf1 include:spf.efwd.registrar-servers.com ~all';
  assert.equal(mergeSpf(forwarding, '3.14.15.92'), 'v=spf1 include:spf.efwd.registrar-servers.com ip4:3.14.15.92 ~all');
  assert.equal(mergeSpf('v=spf1 include:spf.efwd.registrar-servers.com ip4:3.14.15.92 ~all', '3.14.15.92'), 'v=spf1 include:spf.efwd.registrar-servers.com ip4:3.14.15.92 ~all', 'already there, left alone');
  assert.equal(mergeSpf(null, '2600:1f18::1'), 'v=spf1 ip6:2600:1f18::1 ~all');
  assert.equal(mergeSpf('v=spf1 mx', '3.14.15.92'), 'v=spf1 mx ip4:3.14.15.92 ~all');
});
