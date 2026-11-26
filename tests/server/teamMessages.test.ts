import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer as createNetServer, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { startApp, enroll, fakeClamd, EICAR, unanswered, type TestApp } from './helpers.ts';
import { limiters } from '../../server/auth/limiter.ts';
import { apiAllowed } from '../../server/app.ts';
import { expireTeamMessages, settleInterruptedTeamSends } from '../../server/services/teamMessages.ts';
import { parseEml } from '../../server/lib/eml.ts';
import { newId } from '../../server/lib/ids.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';

// A leader's message to a unit, kept in Vantage with a page to read it, and its files sent as real email attachments
// (ADR-0049): only once each is scanned clean, every address is on the allow-list, and the relay takes TLS.

const FIXTURES = join(import.meta.dirname, '../fixtures/cac-crl');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const CSV = Buffer.from('Document,Amount\nM1234,1200.00\n');
const file = (name: string, type: string, bytes: Buffer) => ({ name, type, content: bytes.toString('base64') });
const FILES = [file('Close-out checklist.pdf', 'application/pdf', PDF), file('Funds status.csv', 'text/csv', CSV)];

let app: TestApp;
let op: { token: string; id: string };
let clamd: Awaited<ReturnType<typeof fakeClamd>>;
let inside: { token: string; id: string };
let noEmail: { token: string; id: string };

before(async () => {
  clamd = await fakeClamd();
  app = await startApp({ VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil', VANTAGE_CLAMD: clamd.address });
  op = await app.setupOperator();
  inside = await app.register('filesinside', { email: 'files.inside@example.mil' });
  noEmail = await app.register('filesnomail');
  for (const u of [inside, noEmail]) await enroll(app, op.token, 'G8', u.id);
});
after(async () => { await app.close(); clamd.close(); });

const count = (sql: string, ...args: unknown[]) => (app.ctx.db.prepare(sql).get(...args) as { n: number }).n;
const refusedEntries = () => app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'team_message_refused' ORDER BY rowid").all() as Array<{ detail: string; actor_id: string; entity_id: string }>;
const send = (token: string, body: Record<string, unknown>, unit = 'G8', on = app) => on.call('POST', `/api/org/units/${unit}/message`, { token, body });

/** Sends that are refused leave nothing behind: no message, no notice, no email, and the hourly count where it was. */
async function refusedWhole(on: TestApp, token: string, userId: string, body: Record<string, unknown>, status: number, code: string) {
  const before = { kept: (on.ctx.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n, outbox: on.ctx.mailer.outbox.length, hour: limiters.teamMail.peek(userId), audits: (on.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'team_message_refused'").get() as { n: number }).n };
  const res = await send(token, body, 'G8', on);
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.equal(res.body.code, code);
  assert.ok(res.body.error.length > 20, 'the leader is told why');
  assert.equal((on.ctx.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n, before.kept, 'nothing is kept');
  assert.equal(on.ctx.mailer.outbox.length, before.outbox, 'nothing is emailed');
  assert.equal((on.ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE title LIKE ?').get(`%${String(body.subject)}%`) as { n: number }).n, 0, 'nobody is told');
  assert.equal(limiters.teamMail.peek(userId), before.hour, 'the hourly count is not used');
  const entries = on.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'team_message_refused' ORDER BY rowid").all() as Array<{ detail: string; actor_id: string; entity_id: string }>;
  assert.equal(entries.length, before.audits + 1, 'the refusal is audited');
  const entry = entries.at(-1)!;
  assert.equal(entry.actor_id, userId);
  assert.equal(entry.entity_id, 'G8');
  assert.match(entry.detail, new RegExp(`^${code}: `));
  for (const f of (body.files as Array<{ name: string }> | undefined) ?? []) assert.ok(!entry.detail.includes(f.name), 'a refusal never names a file');
  return res;
}

test('a message with files is kept, each file attached to the email and listed in its plain text, and audited file by file and Marine by Marine', async () => {
  const audience = await app.call('GET', '/api/org/units/G8/message', { token: op.token });
  assert.equal(audience.status, 200);
  assert.deepEqual(audience.body.files, { refusal: null, byEmail: true, maxFiles: 5, maxBytes: 10 * 1024 * 1024, allowedTypes: app.ctx.config.attachments.allowedTypes });
  const outbox = app.ctx.mailer.outbox.length;
  const sent = await send(op.token, { subject: 'Close-out packet', body: 'The checklist and the funds status are attached.', files: FILES, confirmFiles: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const { id } = sent.body;
  assert.deepEqual({ ...sent.body, id: 'x' }, { id: 'x', recipients: 2, emailed: 1, queued: 0, failed: 0, refused: 0, appOnly: 1, files: 2 });

  // The email: the files as attachments, named with their type and size in both parts, and the button to the kept copy.
  const mails = app.ctx.mailer.outbox.slice(outbox).filter((m) => m.kind === 'team_message');
  assert.equal(mails.length, 1);
  const [mail] = mails;
  assert.equal(mail.to, 'files.inside@example.mil');
  assert.deepEqual(mail.attachments!.map((a) => [a.filename, a.contentType, a.content.equals(a.filename.endsWith('.pdf') ? PDF : CSV)]), [['Close-out checklist.pdf', 'application/pdf', true], ['Funds status.csv', 'text/csv', true]]);
  assert.match(mail.text, /^2 attached files$/im);
  assert.match(mail.text, /Close-out checklist\.pdf \(PDF, [\d.]+ [KMG]?B\)/);
  assert.match(mail.text, /Funds status\.csv \(CSV, [\d.]+ [KMG]?B\)/);
  assert.match(mail.text, /scanned each one for malware and found nothing/);
  assert.ok(mail.text.includes(`http://localhost:5173/team/messages/${id}`), 'the button opens the kept copy');
  assert.ok(mail.html.includes('Close-out checklist.pdf'));

  // Kept as sent, with who it went to and how, and each file with its verdict.
  const row = app.ctx.db.prepare('SELECT * FROM team_messages WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.subject, 'Close-out packet');
  assert.ok(row.files_confirmed_at, 'the sender confirmed the files cannot be withdrawn');
  const delivery = Object.fromEntries((app.ctx.db.prepare('SELECT user_id, delivery FROM team_message_recipients WHERE message_id = ?').all(id) as Array<{ user_id: string; delivery: string }>).map((r) => [r.user_id, r.delivery]));
  assert.deepEqual(delivery, { [inside.id]: 'emailed', [noEmail.id]: 'app_only' });
  const files = app.ctx.db.prepare('SELECT original_name, size_bytes, sha256, scan_status, scanner FROM team_message_files WHERE message_id = ? ORDER BY position').all(id) as Array<Record<string, unknown>>;
  assert.deepEqual(files.map((f) => [f.original_name, f.size_bytes, f.scan_status, f.scanner]), [['Close-out checklist.pdf', PDF.length, 'clean', 'clamd'], ['Funds status.csv', CSV.length, 'clean', 'clamd']]);
  assert.throws(() => app.ctx.db.prepare("UPDATE team_messages SET body = 'changed' WHERE id = ?").run(id), /kept as it was sent/);
  assert.throws(() => app.ctx.db.prepare("UPDATE team_message_files SET original_name = 'x.pdf' WHERE message_id = ?").run(id), /kept as it was sent/);

  // The trail: each file by name, size, SHA-256 and verdict; each Marine as the subject of their own entry.
  const trail = (action: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY rowid').all(action, id) as Array<{ detail: string; subject_id: string | null; actor_id: string }>;
  const fileEntries = trail('team_message_file');
  assert.equal(fileEntries.length, 2);
  assert.match(fileEntries[0].detail, new RegExp(`Close-out checklist\\.pdf; ${PDF.length} bytes; application/pdf; sha256 ${files[0].sha256}; scan clean \\(clamd\\)`));
  assert.match(fileEntries[1].detail, new RegExp(`Funds status\\.csv; ${CSV.length} bytes; text/csv; sha256 ${files[1].sha256}; scan clean`));
  const reached = trail('team_message_recipient');
  assert.deepEqual(Object.fromEntries(reached.map((e) => [e.subject_id, e.detail])), { [inside.id]: 'by email to an address at example.mil; 2 files', [noEmail.id]: 'in Vantage only; 2 files' });
  assert.ok(reached.every((e) => e.actor_id === op.id));
  const summary = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'team_message' ORDER BY rowid DESC LIMIT 1").get() as { detail: string };
  assert.match(summary.detail, new RegExp(`^message ${id}; 2 recipients: 1 emailed, 0 queued, 0 failed, 1 in Vantage only \\(0 refused by the address check\\); 2 files, ${PDF.length + CSV.length} bytes; subject: Close-out packet$`));
  assert.equal(verifyAuditChain(app.ctx).ok, true);

  // Each Marine's notice opens the message.
  const notices = app.ctx.db.prepare("SELECT user_id, action_url FROM notifications WHERE title = 'G8: Close-out packet'").all() as Array<{ user_id: string; action_url: string }>;
  assert.deepEqual(new Set(notices.map((n) => n.user_id)), new Set([inside.id, noEmail.id]));
  assert.ok(notices.every((n) => n.action_url === `/team/messages/${id}`));
});

test('the kept copy opens only for its sender and the Marines it went to, while they are members of its Unit Instance', async () => {
  const sent = await send(op.token, { subject: 'Who may read this', body: 'Formation at 0700.', files: [FILES[1]], confirmFiles: true });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const { id } = sent.body;
  const open = (token?: string, path = `/api/team-messages/${id}`) => app.call('GET', path, { token });

  const mine = await open(op.token);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.subject, 'Who may read this');
  assert.deepEqual({ ...mine.body.delivery }, { pending: 0, emailed: 1, queued: 0, failed: 0, refused: 0, app_only: 1 }, 'the sender sees how each was reached');
  const theirs = await open(noEmail.token);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.delivery, null, 'a Marine sees the message, not who else got it how');
  assert.equal(theirs.body.files.length, 1);
  assert.equal(theirs.body.files[0].name, 'Funds status.csv');
  assert.equal(theirs.body.files[0].scanStatus, 'clean');
  assert.ok(new Date(theirs.body.keptUntil).getTime() - new Date(theirs.body.sentAt).getTime() === 180 * 86_400_000);

  // The file is always a download, never a page.
  const fileUrl = `/api/team-messages/${id}/files/${theirs.body.files[0].id}`;
  const download = await app.call('GET', fileUrl, { token: noEmail.token, binary: true });
  assert.equal(download.status, 200);
  assert.ok(download.buffer!.equals(CSV));
  assert.equal(download.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(download.headers.get('content-disposition') ?? '', /^attachment; filename="Funds status\.csv"/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('content-security-policy'), "sandbox; default-src 'none'");

  // Signed out, someone it did not go to, and a Marine who joined after it was sent: nothing, the same as no such message.
  assert.equal((await open()).status, 401);
  assert.equal((await app.call('GET', fileUrl)).status, 401);
  const stranger = await app.register('notonthelist', { email: 'not.on.list@example.mil' });
  assert.equal((await open(stranger.token)).status, 404, 'outside the Unit Instance');
  await enroll(app, op.token, 'G8', stranger.id);
  const late = await open(stranger.token);
  assert.equal(late.status, 404, 'in the unit now, but it was not sent to them');
  assert.equal(late.body.error, (await open(stranger.token, '/api/team-messages/no-such-message')).body.error, 'no different from a message that does not exist');
  assert.equal((await app.call('GET', fileUrl, { token: stranger.token })).status, 404);
  // A file of another message is not found under this one.
  const other = app.ctx.db.prepare('SELECT id FROM team_message_files WHERE message_id != ? LIMIT 1').get(id) as { id: string };
  assert.equal((await app.call('GET', `/api/team-messages/${id}/files/${other.id}`, { token: noEmail.token })).status, 404);
  // A Marine who left the Unit Instance can no longer open what was sent to them.
  app.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ?').run(noEmail.id);
  assert.equal((await open(noEmail.token)).status, 404);
  assert.equal((await app.call('GET', fileUrl, { token: noEmail.token })).status, 404);
  await enroll(app, op.token, 'G8', noEmail.id);
  app.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ?').run(stranger.id);

  // Only the application's host answers the page's calls; the Unit Manager console's, which answers /api/org, does not.
  assert.equal(apiAllowed(new Set(['app']), `/team-messages/${id}`), true);
  assert.equal(apiAllowed(new Set(['console']), `/team-messages/${id}`), false);
  assert.equal(apiAllowed(new Set(['admin']), `/team-messages/${id}`), false);
});

test('a file the scanner does not find clean is refused whole: malware as such, and no verdict as not scanned clean', async () => {
  const malware = await refusedWhole(app, op.token, op.id, { subject: 'Scanned refusal', body: 'See attached.', files: [FILES[0], file('read-me.txt', 'text/plain', EICAR)], confirmFiles: true }, 422, 'malware_rejected');
  assert.match(malware.body.error, /read-me\.txt was rejected by the malware scanner: Win\.Test\.EICAR_HDB-1/, 'the sender is told which file');
  assert.match(refusedEntries().at(-1)!.detail, /rejected by the malware scanner: Win\.Test\.EICAR_HDB-1/);

  // No scanner, a scanner that errs and one that does not answer all give no clean verdict.
  const was = app.ctx.config.intake.clamd;
  app.ctx.config.intake.clamd = null;
  try {
    const unscanned = await refusedWhole(app, op.token, op.id, { subject: 'Unscanned refusal', body: 'See attached.', files: [FILES[0]], confirmFiles: true }, 409, 'file_not_clean');
    assert.match(unscanned.body.error, /^Close-out checklist\.pdf was not scanned clean\. No malware scanner is configured/);
    app.ctx.config.intake.clamd = 'tcp://127.0.0.1:9';
    await refusedWhole(app, op.token, op.id, { subject: 'Scanner down refusal', body: 'See attached.', files: [FILES[0]], confirmFiles: true }, 409, 'file_not_clean');
  } finally { app.ctx.config.intake.clamd = was; }
});

test('a Marine with an address outside the allow-list refuses the files for everyone; the same message without them goes', async () => {
  const outside = await app.register('filesoutside', { email: 'files.outside@gmail.com' });
  await enroll(app, op.token, 'G8', outside.id);
  try {
    const audience = await app.call('GET', '/api/org/units/G8/message', { token: op.token });
    assert.match(audience.body.files.refusal, /One Marine on this message has an address outside the allowed domains \(gmail\.com\)/, 'the dialog says so before anything is written');
    const res = await refusedWhole(app, op.token, op.id, { subject: 'Outside refusal', body: 'See attached.', files: FILES, confirmFiles: true }, 409, 'recipients_outside_allowed_domains');
    assert.match(res.body.error, /Send the message without its files/);
    assert.match(refusedEntries().at(-1)!.detail, /1 addresses outside the allowed domains \(gmail\.com\)/);
    const plain = await send(op.token, { subject: 'Outside without files', body: 'Formation at 0700.' });
    assert.equal(plain.status, 200, 'a message with no files goes as before, in Vantage only for the address outside the list');
    assert.equal(plain.body.refused, 1);
    // The trail says that Marine had it in Vantage only, never that it went by email to an address the check refuses.
    const reached = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'team_message_recipient' AND entity_id = ? AND subject_id = ?").get(plain.body.id, outside.id) as { detail: string };
    assert.equal(reached.detail, 'in Vantage only; the address check refuses an address at gmail.com');
  } finally { app.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ?').run(outside.id); }
});

test('files must be confirmed, fit the caps, and be files Vantage takes', async () => {
  await refusedWhole(app, op.token, op.id, { subject: 'Unconfirmed', body: 'See attached.', files: FILES }, 400, 'files_unconfirmed');
  await refusedWhole(app, op.token, op.id, { subject: 'Unconfirmed false', body: 'See attached.', files: FILES, confirmFiles: false }, 400, 'files_unconfirmed');
  await refusedWhole(app, op.token, op.id, { subject: 'Twice', body: 'See attached.', files: [FILES[0], { ...FILES[0], name: 'copy.pdf' }], confirmFiles: true }, 400, 'duplicate_file');
  await refusedWhole(app, op.token, op.id, { subject: 'Program', body: 'See attached.', files: [file('setup.exe', 'application/octet-stream', Buffer.from('MZ\x90\x00'))], confirmFiles: true }, 400, 'file_invalid');
  await refusedWhole(app, op.token, op.id, { subject: 'Mislabeled', body: 'See attached.', files: [file('scan.pdf', 'application/pdf', CSV)], confirmFiles: true }, 400, 'file_invalid');
  await refusedWhole(app, op.token, op.id, { subject: 'Not base64', body: 'See attached.', files: [{ name: 'a.txt', type: 'text/plain', content: 'not base64!' }], confirmFiles: true }, 400, 'file_unreadable');
  await refusedWhole(app, op.token, op.id, { subject: 'Empty file', body: 'See attached.', files: [{ name: 'empty.txt', type: 'text/plain', content: '' }], confirmFiles: true }, 400, 'file_unreadable');
  const six = Array.from({ length: 6 }, (_, i) => file(`note-${i}.txt`, 'text/plain', Buffer.from(`note ${i}\n`)));
  const tooMany = await refusedWhole(app, op.token, op.id, { subject: 'Six files', body: 'See attached.', files: six, confirmFiles: true }, 400, 'too_many_files');
  assert.match(tooMany.body.error, /at most 5 files/);
  assert.match(refusedEntries().at(-1)!.detail, /; 6 files$/);
  // Together within the attachment limit, whatever each one is.
  const limit = app.ctx.config.attachments.maxBytes;
  app.ctx.config.attachments.maxBytes = PDF.length + 10;
  try {
    const big = await refusedWhole(app, op.token, op.id, { subject: 'Too big together', body: 'See attached.', files: FILES, confirmFiles: true }, 413, 'files_too_large');
    assert.match(big.body.error, /a message carries at most/);
    // Far larger than files within the limit can be: refused before the files are read, with the reason and its entry.
    const huge = await refusedWhole(app, op.token, op.id, { subject: 'Far too big', body: 'See attached.', files: [file('big.txt', 'text/plain', Buffer.alloc(200_000, 'a'))], confirmFiles: true }, 413, 'files_too_large');
    assert.match(huge.body.error, /more than a message carries/);
    assert.match(refusedEntries().at(-1)!.detail, /; files not read$/);
    // That entry is written after the parser's callback, outside Express's own catch: a failed write is answered, and the
    // server keeps serving.
    app.ctx.db.exec("CREATE TEMP TRIGGER refusal_write_fails BEFORE INSERT ON audit_log WHEN NEW.action = 'team_message_refused' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    try {
      const failed = await send(op.token, { subject: 'Far too big again', body: 'See attached.', files: [file('big.txt', 'text/plain', Buffer.alloc(200_000, 'a'))], confirmFiles: true });
      assert.equal(failed.status, 500);
    } finally { app.ctx.db.exec('DROP TRIGGER refusal_write_fails'); }
    assert.equal((await app.call('GET', '/api/org/units/G8/message', { token: op.token })).status, 200, 'still serving');
  } finally { app.ctx.config.attachments.maxBytes = limit; }
  // Attachments withheld from this Unit Instance: no files on its messages either.
  const orgId = (app.ctx.db.prepare("SELECT org_id FROM units WHERE id = 'G8'").get() as { org_id: string }).org_id;
  app.ctx.db.prepare("INSERT INTO instance_feature_flags (org_id, flag, reason, set_at, set_by) VALUES (?, 'attachments', 'test', ?, ?)").run(orgId, new Date().toISOString(), op.id);
  try {
    const audience = await app.call('GET', '/api/org/units/G8/message', { token: op.token });
    assert.match(audience.body.files.refusal, /turned file attachments off for this Unit Instance/);
    await refusedWhole(app, op.token, op.id, { subject: 'Withheld', body: 'See attached.', files: FILES, confirmFiles: true }, 403, 'feature_withheld');
  } finally { app.ctx.db.prepare("DELETE FROM instance_feature_flags WHERE org_id = ? AND flag = 'attachments'").run(orgId); }
});

test('control characters alone make no subject and no message; refused with a reason, not a server error', async () => {
  await refusedWhole(app, op.token, op.id, { subject: '\u0007', body: 'Formation at 0700.' }, 400, 'subject_empty');
  await refusedWhole(app, op.token, op.id, { subject: 'Nothing but NUL', body: '\u0000\u0001' }, 400, 'message_empty');
  // C1 controls too (NEXT LINE among them), as a file's text is held to.
  await refusedWhole(app, op.token, op.id, { subject: '\u0085', body: 'Formation at 0700.' }, 400, 'subject_empty');
  await refusedWhole(app, op.token, op.id, { subject: 'Nothing but C1', body: '\u0090\u009b' }, 400, 'message_empty');
  const sent = await send(op.token, { subject: 'Formation\u0085Uniform', body: 'Formation\u0000 at 0700.\u009b\nBring the binder.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const kept = app.ctx.db.prepare('SELECT subject, body FROM team_messages WHERE id = ?').get(sent.body.id) as { subject: string; body: string };
  assert.equal(kept.subject, 'Formation Uniform', 'one line');
  assert.equal(kept.body, 'Formation at 0700.\nBring the binder.', 'kept and emailed without what cannot be read, line breaks kept');
  limiters.teamMail.clear(op.id);
});

test('a Marine who gains an address while the files are scanned is sent to only over a relay proven to take TLS', async () => {
  const relay = await plainRelay();
  const plain = await startApp({ VANTAGE_CLAMD: clamd.address, VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${relay.port}`, VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil' });
  try {
    const leader = await plain.setupOperator();
    const marine = await plain.register('gainsaddress');
    await enroll(plain, leader.token, 'G8', marine.id);
    const gate = clamd.gate();
    const pending = send(leader.token, { subject: 'Address gained mid-scan', body: 'See attached.', files: [FILES[0]], confirmFiles: true }, 'G8', plain);
    try {
      await gate.seen;
      assert.equal(await unanswered(pending), true, 'the scanner has the file');
      plain.ctx.db.prepare('UPDATE users SET email = ? WHERE id = ?').run('gained.address@example.mil', marine.id);
    } finally { gate.release(); }
    const res = await pending;
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'relay_not_tls');
    assert.equal((plain.ctx.db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number }).n, 0, 'nothing is kept');
    assert.ok(/STARTTLS/i.test(relay.seen.join('')), 'the relay was asked for TLS once the list had an address');
    assert.ok(!/^(MAIL FROM|RCPT TO|DATA)/im.test(relay.seen.join('')), 'nothing was sent to it in the clear');
  } finally { await plain.close(); await relay.close(); }
});

test('attachments turned off while the files are scanned refuse them as off for the service, or as withheld from the instance', async () => {
  const gate = clamd.gate();
  const pending = send(op.token, { subject: 'Turned off mid-scan', body: 'See attached.', files: [FILES[0]], confirmFiles: true });
  try {
    await gate.seen;
    assert.equal(await unanswered(pending), true, 'the scanner has the file');
    app.ctx.runtime.attachmentsEnabled = false;
  } finally { gate.release(); }
  try {
    const res = await pending;
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'attachments_off');
    assert.match(refusedEntries().at(-1)!.detail, /^attachments_off: attachments turned off meanwhile; 1 file$/);
  } finally { app.ctx.runtime.attachmentsEnabled = true; }
  const orgId = (app.ctx.db.prepare("SELECT org_id FROM units WHERE id = 'G8'").get() as { org_id: string }).org_id;
  const second = clamd.gate();
  const withheld = send(op.token, { subject: 'Withheld mid-scan', body: 'See attached.', files: [FILES[0]], confirmFiles: true });
  try {
    await second.seen;
    app.ctx.db.prepare("INSERT INTO instance_feature_flags (org_id, flag, reason, set_at, set_by) VALUES (?, 'attachments', 'test', ?, ?)").run(orgId, new Date().toISOString(), op.id);
  } finally { second.release(); }
  try {
    const res = await withheld;
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.code, 'feature_withheld');
    assert.match(refusedEntries().at(-1)!.detail, /^feature_withheld: attachments withheld from the Unit Instance meanwhile; 1 file$/);
  } finally { app.ctx.db.prepare("DELETE FROM instance_feature_flags WHERE org_id = ? AND flag = 'attachments'").run(orgId); }
  assert.equal(count("SELECT COUNT(*) AS n FROM team_messages WHERE subject IN ('Turned off mid-scan', 'Withheld mid-scan')"), 0);
});

test('a copy a stopped send never emailed is recorded at the next start as not delivered by email', () => {
  const db = app.ctx.db;
  const orgId = (db.prepare("SELECT org_id FROM units WHERE id = 'G8'").get() as { org_id: string }).org_id;
  const id = newId();
  db.prepare("INSERT INTO team_messages (id, org_id, unit_id, sender_id, sender_name, unit_label, unit_name, subject, body, marking, created_at) VALUES (?, ?, 'G8', ?, 'Cpl John Boletz', 'G8', 'G-8 Comptroller', 'Stopped part way', 'Words.', 'CUI', ?)").run(id, orgId, op.id, new Date().toISOString());
  db.prepare("INSERT INTO team_message_recipients (message_id, user_id, org_id, delivery) VALUES (?, ?, ?, 'emailed'), (?, ?, ?, 'pending')").run(id, inside.id, orgId, id, noEmail.id, orgId);
  assert.equal(settleInterruptedTeamSends(app.ctx), 1);
  const rows = Object.fromEntries((db.prepare('SELECT user_id, delivery FROM team_message_recipients WHERE message_id = ?').all(id) as Array<{ user_id: string; delivery: string }>).map((r) => [r.user_id, r.delivery]));
  assert.deepEqual(rows, { [inside.id]: 'emailed', [noEmail.id]: 'failed' });
  assert.equal(settleInterruptedTeamSends(app.ctx), 0);
  db.prepare('DELETE FROM team_messages WHERE id = ?').run(id);
});

test('a send that loses the hourly count while its files are scanned is refused with its entry, and keeps nothing', async () => {
  const gate = clamd.gate();
  limiters.teamMail.clear(op.id);
  const pending = send(op.token, { subject: 'Count used meanwhile', body: 'See attached.', files: [FILES[0]], confirmFiles: true });
  try {
    await gate.seen;
    assert.equal(await unanswered(pending), true, 'the scanner has the file');
    for (let i = 0; i < 5; i++) limiters.teamMail.bump(op.id);
  } finally { gate.release(); }
  try {
    const res = await pending;
    assert.equal(res.status, 429, JSON.stringify(res.body));
    assert.equal(count("SELECT COUNT(*) AS n FROM team_messages WHERE subject = 'Count used meanwhile'"), 0);
    assert.match(refusedEntries().at(-1)!.detail, /^throttled: the hourly count was used up while the message was checked; 1 file$/);
    assert.equal(limiters.teamMail.peek(op.id), 5, 'not taken again by the refused send');
  } finally { limiters.teamMail.clear(op.id); }
});

test('a sender signed out while the files are scanned sends nothing, and the hourly count stays', async () => {
  const second = (await app.login('boletz')).body.token as string;
  const gate = clamd.gate();
  const hour = limiters.teamMail.peek(op.id);
  const pending = send(second, { subject: 'Signed out mid-scan', body: 'See attached.', files: [FILES[0]], confirmFiles: true });
  try {
    await gate.seen;
    assert.equal(await unanswered(pending), true, 'the scanner has the file');
    assert.equal((await app.call('POST', '/api/auth/logout', { token: second })).status < 300, true);
  } finally { gate.release(); }
  const res = await pending;
  assert.equal(res.status, 401);
  assert.equal(count("SELECT COUNT(*) AS n FROM team_messages WHERE subject = 'Signed out mid-scan'"), 0);
  assert.equal(limiters.teamMail.peek(op.id), hour);
});

test('with no allow-list, files go by email to nobody; direct delivery and a relay that refuses TLS refuse them too', async () => {
  const instances: TestApp[] = [];
  const relay = await plainRelay();
  try {
    const open = await startApp({ VANTAGE_CLAMD: clamd.address });
    instances.push(open);
    const openOp = await open.setupOperator();
    const marine = await open.register('openlist', { email: 'open.list@example.mil' });
    await enroll(open, openOp.token, 'G8', marine.id);
    await refusedWhole(open, openOp.token, openOp.id, { subject: 'No list', body: 'See attached.', files: FILES, confirmFiles: true }, 409, 'no_allowed_domains');

    const direct = await startApp({ VANTAGE_CLAMD: clamd.address, VANTAGE_EMAIL_PROVIDER: 'direct', VANTAGE_EMAIL_FROM: 'Vantage <no-reply@vantage.test>', VANTAGE_EMAIL_DIRECT_ROUTE: '127.0.0.1:9', VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil' });
    instances.push(direct);
    const directOp = await direct.setupOperator();
    const m2 = await direct.register('directlist', { email: 'direct.list@example.mil' });
    await enroll(direct, directOp.token, 'G8', m2.id);
    const viaDirect = await refusedWhole(direct, directOp.token, directOp.id, { subject: 'Direct', body: 'See attached.', files: FILES, confirmFiles: true }, 409, 'relay_not_tls');
    assert.match(viaDirect.body.error, /only through a mail relay that requires TLS/);

    const plain = await startApp({ VANTAGE_CLAMD: clamd.address, VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${relay.port}`, VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil' });
    instances.push(plain);
    const plainOp = await plain.setupOperator();
    const m3 = await plain.register('plainrelay', { email: 'plain.relay@example.mil' });
    await enroll(plain, plainOp.token, 'G8', m3.id);
    const viaPlain = await refusedWhole(plain, plainOp.token, plainOp.id, { subject: 'Plain relay', body: 'See attached.', files: FILES, confirmFiles: true }, 409, 'relay_not_tls');
    assert.match(viaPlain.body.error, /could not open a TLS connection to the mail relay/);
    const heard = relay.seen.join('');
    assert.ok(/STARTTLS/i.test(heard), 'the relay was asked for TLS');
    assert.ok(!/^(MAIL FROM|RCPT TO|DATA)/im.test(heard), 'nothing was sent to it in the clear');
  } finally {
    for (const i of instances) await i.close();
    await relay.close();
  }
});

test('through a relay that takes TLS, the email carries the files as MIME parts and the plain text lists them', async () => {
  const relay = await tlsRelay();
  const relayed = await startApp({ VANTAGE_CLAMD: clamd.address, VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: `smtp://127.0.0.1:${relay.port}`, VANTAGE_EMAIL_FROM: 'Vantage <no-reply@vantage.example.mil>', VANTAGE_EMAIL_ALLOWED_DOMAINS: 'example.mil', VANTAGE_EMAIL_TEST_RELAY_CA: join(FIXTURES, 'ca.pem') });
  try {
    const leader = await relayed.setupOperator();
    const marine = await relayed.register('tlsrelay', { email: 'tls.relay@example.mil' });
    await enroll(relayed, leader.token, 'G8', marine.id);
    const sent = await send(leader.token, { subject: 'Packet over TLS', body: 'Both files attached.', files: FILES, confirmFiles: true }, 'G8', relayed);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.emailed, 1);
    const withMail = relay.sessions.filter((s) => s.data.length);
    assert.equal(withMail.length, 1, 'one message, one copy');
    const [session] = withMail;
    assert.ok(session.clear.every((line) => /^(EHLO|HELO|STARTTLS)/i.test(line)), `only the greeting and STARTTLS in the clear: ${session.clear.join(' | ')}`);
    assert.ok(session.secure.some((line) => /^RCPT TO:<tls\.relay@example\.mil>/i.test(line)));
    const parsed = parseEml(Buffer.from(session.data[0], 'latin1'));
    assert.equal(parsed.subject, '[G8] Packet over TLS');
    const sha = (b: Buffer) => (relayed.ctx.db.prepare('SELECT sha256 FROM team_message_files WHERE size_bytes = ? AND message_id = ?').get(b.length, sent.body.id) as { sha256: string }).sha256;
    assert.deepEqual(parsed.attachments.map((a) => [a.filename, a.contentType, a.sizeBytes, a.sha256]), [
      ['Close-out checklist.pdf', 'application/pdf', PDF.length, sha(PDF)],
      ['Funds status.csv', 'text/csv', CSV.length, sha(CSV)],
    ]);
    assert.match(parsed.text, /Close-out checklist\.pdf \(PDF, /);
    assert.match(parsed.text, /Funds status\.csv \(CSV, /);
    // The relay was proven before the message was kept: a session that opened TLS and sent nothing.
    assert.ok(relay.sessions.some((s) => !s.data.length && s.secure.length), 'the route was checked first');
  } finally { await relayed.close(); await relay.close(); }
});

test('a team message is kept 180 days, then removed with its files and recipients unless a legal hold keeps it', () => {
  const db = app.ctx.db;
  const orgId = (db.prepare("SELECT org_id FROM units WHERE id = 'G8'").get() as { org_id: string }).org_id;
  const old = new Date(Date.now() - 181 * 86_400_000).toISOString();
  const seed = (label: string, recipient: string) => {
    const id = newId();
    db.prepare("INSERT INTO team_messages (id, org_id, unit_id, sender_id, sender_name, unit_label, unit_name, subject, body, marking, created_at) VALUES (?, ?, 'G8', ?, 'Cpl John Boletz', 'G8', 'G-8 Comptroller', ?, 'Old words.', 'CUI', ?)").run(id, orgId, op.id, label, old);
    db.prepare("INSERT INTO team_message_recipients (message_id, user_id, org_id, delivery) VALUES (?, ?, ?, 'app_only')").run(id, recipient, orgId);
    db.prepare("INSERT INTO team_message_files (id, message_id, org_id, position, original_name, mime_type, size_bytes, sha256, scan_status, scanner, content, created_at) VALUES (?, ?, ?, 1, 'old.csv', 'text/csv', ?, ?, 'clean', 'clamd', ?, ?)").run(newId(), id, orgId, CSV.length, 'a'.repeat(64), CSV, old);
    return id;
  };
  const hold = (scope: string, over: { subject_id?: string; record_type?: string; org_id?: string | null }) => {
    const id = newId();
    db.prepare('INSERT INTO legal_holds (id, scope, subject_id, record_type, reason, placed_by, placed_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, scope, over.subject_id ?? null, over.record_type ?? null, 'test hold', op.id, new Date().toISOString(), over.org_id ?? null);
    return id;
  };
  const release = (id: string) => db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?').run(new Date().toISOString(), op.id, id);
  const exists = (id: string) => Boolean(db.prepare('SELECT 1 FROM team_messages WHERE id = ?').get(id));

  const fresh = db.prepare('SELECT COUNT(*) AS n FROM team_messages').get() as { n: number };
  const a = seed('Old one', inside.id);
  // A hold on every Unit Instance keeps every one.
  const everywhere = hold('instance', {});
  assert.deepEqual(expireTeamMessages(app.ctx), { expired: 0, held: 1, blocked: true });
  release(everywhere);
  // A hold on its own Unit Instance, or on team messages there, keeps it.
  for (const h of [hold('instance', { org_id: orgId }), hold('record_type', { record_type: 'team_messages', org_id: orgId })]) {
    assert.deepEqual(expireTeamMessages(app.ctx), { expired: 0, held: 1, blocked: false });
    release(h);
  }
  // A hold on a Marine it went to keeps it; so does one on its sender.
  for (const h of [hold('user', { subject_id: inside.id }), hold('user', { subject_id: op.id })]) {
    assert.deepEqual(expireTeamMessages(app.ctx), { expired: 0, held: 1, blocked: false });
    release(h);
  }
  // A hold on someone else, or another Unit Instance's, keeps nothing here.
  const elsewhere = hold('instance', { org_id: 'another-instance' });
  const otherMarine = hold('user', { subject_id: noEmail.id });
  const seq = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log').get() as { n: number }).n;
  assert.deepEqual(expireTeamMessages(app.ctx), { expired: 1, held: 0, blocked: false });
  release(elsewhere); release(otherMarine);
  assert.equal(exists(a), false);
  assert.equal(count('SELECT COUNT(*) AS n FROM team_message_files WHERE message_id = ?', a), 0, 'its files go with it');
  assert.equal(count('SELECT COUNT(*) AS n FROM team_message_recipients WHERE message_id = ?', a), 0, 'and who it went to');
  assert.equal(count('SELECT COUNT(*) AS n FROM team_messages'), fresh.n, 'messages inside the window stay');
  const audited = db.prepare("SELECT detail FROM audit_log WHERE rowid > ? AND action = 'team_messages_expired'").all(seq) as Array<{ detail: string }>;
  assert.deepEqual(audited.map((r) => r.detail), ['team messages older than 180 days: 1 removed']);
  const runs = db.prepare("SELECT acted, held FROM disposition_runs WHERE record_type = 'team_messages' ORDER BY at").all() as Array<{ acted: number; held: number }>;
  assert.deepEqual(runs.at(-1), { acted: 1, held: 0 });
  assert.ok(runs.length >= 6, 'each run is recorded, held or not');
  assert.deepEqual(expireTeamMessages(app.ctx), { expired: 0, held: 0, blocked: false }, 'nothing is due');
});

/** A relay that offers no STARTTLS and keeps everything it is sent, in clear text. */
async function plainRelay() {
  const seen: string[] = [];
  const server = createNetServer((sock) => {
    let data = false;
    sock.on('error', () => {});
    sock.write('220 relay.example.mil ESMTP\r\n');
    sock.on('data', (buf) => {
      const text = buf.toString('utf8');
      seen.push(text);
      if (data) { if (/\r\n\.\r\n$/.test(text)) { data = false; sock.write('250 queued\r\n'); } return; }
      for (const line of text.split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(line)) sock.write('250-relay.example.mil\r\n250 SIZE 10000000\r\n');
        else if (/^STARTTLS/i.test(line)) sock.write('454 TLS not available\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go ahead\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * A relay that offers STARTTLS with the test CA's certificate for 127.0.0.1, then takes the message over TLS. Each
 * session keeps what it was told in the clear, what it was told over TLS, and each message it was given.
 */
async function tlsRelay() {
  const key = readFileSync(join(FIXTURES, 'server.key'));
  const cert = readFileSync(join(FIXTURES, 'server.pem'));
  const sessions: Array<{ clear: string[]; secure: string[]; data: string[] }> = [];
  const server = createNetServer((raw: Socket) => {
    const session = { clear: [] as string[], secure: [] as string[], data: [] as string[] };
    sessions.push(session);
    let sock: Socket = raw;
    let secure = false;
    let inData = false;
    let buffered = '';
    const reply = (line: string) => sock.write(`${line}\r\n`);
    const handle = (line: string) => {
      if (/^(EHLO|HELO)/i.test(line)) sock.write(`250-relay.example.mil\r\n${secure ? '' : '250-STARTTLS\r\n'}250 SIZE 52428800\r\n`);
      else if (/^STARTTLS/i.test(line)) {
        reply('220 go ahead');
        raw.removeAllListeners('data');
        const wrapped = new TLSSocket(raw, { isServer: true, key, cert });
        wrapped.on('error', () => {});
        wrapped.on('data', feed);
        sock = wrapped;
        secure = true;
        buffered = '';
      } else if (/^DATA/i.test(line)) { inData = true; reply('354 go ahead'); }
      else if (/^QUIT/i.test(line)) { reply('221 bye'); sock.end(); }
      else reply('250 ok');
    };
    function feed(chunk: Buffer) {
      buffered += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffered.indexOf('\r\n.\r\n');
          if (end < 0) return;
          session.data.push(buffered.slice(0, end + 2).replace(/\r\n\.\./g, '\r\n.'));
          buffered = buffered.slice(end + 5);
          inData = false;
          reply('250 queued');
          continue;
        }
        const at = buffered.indexOf('\r\n');
        if (at < 0) return;
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 2);
        (secure ? session.secure : session.clear).push(line);
        handle(line);
        if (secure && sock !== raw && line.toUpperCase().startsWith('STARTTLS')) return;
      }
    }
    raw.on('error', () => {});
    raw.on('data', feed);
    raw.write('220 relay.example.mil ESMTP\r\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as { port: number }).port, sessions, close: () => new Promise<void>((r) => server.close(() => r())) };
}
