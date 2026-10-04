import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { buildZip } from '../../server/lib/zip.ts';
import { readWorkbook } from '../../server/lib/workbook.ts';
import { sanitizeEmailHtml, htmlToText } from '../../server/lib/sanitizeHtml.ts';
import { clientIp, fromCloudflare } from '../../server/lib/http.ts';
import { securityTxt } from '../../server/app.ts';
import { PROJECT_ROOT } from '../../server/config.ts';

let app: TestApp;
let op: { token: string; id: string };
before(async () => { app = await startApp(); op = await app.setupOperator(); });
after(async () => { await app.close(); });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('a goal measured across a unit takes the right to view its shared records, and reads nothing without it', async () => {
  assert.equal((await app.call('POST', '/api/org/units', { token: op.token, body: { name: 'Team A', short_name: 'TA', parent_id: 'G8' } })).status, 201);
  const victim = await app.register('goalvictim');
  const snoop = await app.register('goalsnoop');
  await enroll(app, op.token, 'TA', victim.id);
  await enroll(app, op.token, 'G8', snoop.id);
  // Joining a unit changes what a person may do, so their sessions start again.
  victim.token = (await app.login('goalvictim')).body.token;
  snoop.token = (await app.login('goalsnoop')).body.token;
  const shared = await app.call('POST', '/api/records/activities', { token: victim.token, body: { title: 'Reconciled obligation N00123', visibility: 'unit', unit_id: 'TA', date: day(-2), dollar_amount: 98765.43, dollar_type: 'obligated' } });
  assert.equal(shared.status, 201);
  const goal = { title: 'x', status: 'active', visibility: 'private', unit_id: 'G8', measure_scope: 'unit', metric_id: 'money:obligated', direction: 'increase', target_value: 1, period_start: day(-30), period_end: day(30), filters: { user_id: victim.id } };

  // A Marine without the permission cannot set one, however it is filtered.
  const refused = await app.call('POST', '/api/records/goals', { token: snoop.token, body: goal });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'unit_measure_forbidden');

  // A goal stored before the check (or by someone who has since lost the role) reads nothing and names nobody.
  const own = await app.call('POST', '/api/records/goals', { token: snoop.token, body: { ...goal, measure_scope: 'subject' } });
  assert.equal(own.status, 201);
  app.ctx.db.prepare("UPDATE goals SET measure_scope = 'unit' WHERE id = ?").run(own.body.id);
  const read = await app.call('GET', `/api/records/goals/${own.body.id}`, { token: snoop.token });
  assert.equal(read.body.progress?.current ?? 0, 0, 'no total of anybody else’s work');
  assert.deepEqual((await app.call('GET', `/api/records/goals/${own.body.id}/contributors`, { token: snoop.token })).body, []);

  // The leader who can view the unit's shared records still sets and reads one.
  const lead = await app.call('POST', '/api/records/goals', { token: op.token, body: { ...goal, filters: {} } });
  assert.equal(lead.status, 201);
  assert.equal(lead.body.progress.current, 98765.43);
  const contributors = await app.call('GET', `/api/records/goals/${lead.body.id}/contributors`, { token: op.token });
  assert.equal(contributors.body.length, 1);
});

test('the third wrong password answers the same whether or not the name has an account', async () => {
  await app.register('lockreal', { email: 'lockreal@example.mil' });
  const answers = async (username: string) => {
    const out: Array<[number, string]> = [];
    for (let i = 0; i < 4; i += 1) { const r = await app.call('POST', '/api/auth/login', { body: { username, password: `wrong-password-attempt-${i}` } }); out.push([r.status, r.body.code]); }
    return out;
  };
  const real = await answers('lockreal');
  const made = await answers('nobody-by-this-name');
  assert.deepEqual(made, real, 'a lock must not reveal which names have accounts');
  assert.deepEqual(real.at(-1), [429, 'account_locked']);

  // A reset link proves the mailbox, and clears the lock somebody else's guesses put on the account.
  assert.equal((await app.call('POST', '/api/auth/forgot', { body: { identifier: 'lockreal' } })).status, 200);
  const token = decodeURIComponent(app.ctx.mailer.outbox.at(-1)!.text.match(/reset\?token=([^\s]+)/)![1]);
  assert.equal((await app.call('POST', '/api/auth/reset', { body: { token, password: 'a-fresh-passphrase-after-lock' } })).status, 200);
  assert.equal((await app.login('lockreal', 'a-fresh-passphrase-after-lock')).status, 200);
  assert.ok(PASSWORD);
});

test('the workbook reader answers in linear time to parts that never close their elements', () => {
  const book = (sheet: string, styles = '<styleSheet/>') => buildZip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  for (const zip of [
    book(`<worksheet><sheetData>${'<row>'.repeat(60_000)}</sheetData></worksheet>`),
    book(`<worksheet><sheetData><row r="1">${'<c r="A1"><is><t>'.repeat(30_000)}</row></sheetData></worksheet>`),
    book('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>', `<styleSheet><numFmts><numFmt ${'numFmtId="1" '.repeat(30_000)}</numFmts></styleSheet>`),
  ]) {
    const started = performance.now();
    try { readWorkbook(zip); } catch { /* refusing is fine; stalling is not */ }
    // Linear is a few ms; the old reader took seconds. The slack is for a busy machine.
    assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
  }
  // And it still reads an ordinary sheet, with the format code in either attribute order.
  const ok = readWorkbook(book('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Doc</t></is></c><c r="B1" s="1"><v>46000</v></c></row></sheetData></worksheet>',
    '<styleSheet><numFmts><numFmt formatCode="yyyy-mm-dd" numFmtId="164"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>'));
  assert.deepEqual(ok.sheets[0].rows[0], ['Doc', '2025-12-09']);
});

test('the email sanitizer and its text rendering answer in linear time', () => {
  for (const html of ['<svg></svg>'.repeat(40_000), '<script'.repeat(40_000), '<a'.repeat(100_000), `${'<b>'.repeat(60_000)}${'</i>'.repeat(60_000)}`]) {
    const started = performance.now();
    sanitizeEmailHtml(html);
    htmlToText(html);
    assert.ok(performance.now() - started < 1500, `${html.slice(0, 8)}… took ${Math.round(performance.now() - started)} ms`);
  }
  assert.equal(htmlToText('<p>Before</p><script>steal()</script><style>p{}</style><p>After &amp; more<br>next</p>'), 'Before\n\nAfter & more\nnext');
});

test('behind Cloudflare the visitor’s address is used, but only when Cloudflare is the peer', () => {
  const req = (ip: string, cf?: string, mode: 'proxy' | 'cloudflare' = 'cloudflare') => ({
    ip, socket: {}, ctx: { config: { clientIp: mode } }, get: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? cf : undefined),
  }) as unknown as Request;
  assert.ok(fromCloudflare('172.70.1.2') && fromCloudflare('2606:4700::1') && fromCloudflare('::ffff:104.16.0.9'));
  assert.ok(!fromCloudflare('203.0.113.9') && !fromCloudflare('not an address'));
  assert.equal(clientIp(req('172.70.1.2', '198.51.100.7')), '198.51.100.7');
  assert.equal(clientIp(req('203.0.113.9', '198.51.100.7')), '203.0.113.9', 'a peer outside Cloudflare cannot choose its address');
  assert.equal(clientIp(req('172.70.1.2', 'not-an-ip')), '172.70.1.2');
  assert.equal(clientIp(req('172.70.1.2', '198.51.100.7', 'proxy')), '172.70.1.2', 'off unless the deployment says it is behind Cloudflare');
});

test('security.txt names where to report, and expires within the year', async () => {
  const text = securityTxt('https://www.example.mil/', 'mailto:security@example.mil', new Date('2026-10-03T12:00:00Z'));
  assert.match(text, /^Contact: mailto:security@example\.mil\nContact: https:\/\/www\.example\.mil\/login\?help=security\n/);
  assert.match(text, /\nExpires: 2027-04-01T00:00:00Z\n/);
  assert.match(text, /\nCanonical: https:\/\/www\.example\.mil\/\.well-known\/security\.txt\n/);
  const served = await app.call('GET', '/.well-known/security.txt');
  if (served.status !== 404) {
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type') || '', /text\/plain/);
    assert.match(served.text, /^Contact: /);
  }
});

test('the plain-language pages are served whole, and only the app is kept as the offline copy', { skip: !existsSync(join(PROJECT_ROOT, 'dist/pages/security.html')) && 'needs npm run build' }, async () => {
  for (const [path, heading] of [['/security', 'Built so a record can answer for itself.'], ['/privacy', 'Your record is yours.'], ['/accessibility', 'Usable by everyone who has to use it.']]) {
    const page = await app.call('GET', path);
    assert.equal(page.status, 200, path);
    assert.ok(page.text.includes(`<h1>${heading}</h1>`), path);
    assert.match(page.text, new RegExp(`<link rel="canonical" href="https://www\\.vantageusmc\\.com${path}"`));
    assert.equal(page.headers.get('x-robots-tag'), null, `${path} is meant to be found`);
    assert.equal(page.headers.get('x-vantage-document'), null);
  }
  assert.equal((await app.call('GET', '/work/queue')).headers.get('x-vantage-document'), 'app');
  const sitemap = await app.call('GET', '/sitemap.xml');
  for (const path of ['/security', '/privacy', '/accessibility']) assert.ok(sitemap.text.includes(`https://www.vantageusmc.com${path}</loc>`), path);
});

test('a missing address is a branded 404, and a signed-in visitor keeps the app around it', { skip: !existsSync(join(PROJECT_ROOT, 'dist/index.html')) && 'needs npm run build' }, async () => {
  const out = await app.call('GET', '/no-such-place');
  assert.equal(out.status, 404);
  assert.match(out.text, /<title>Page not found · Vantage<\/title>/);
  const signedIn = await app.call('GET', '/no-such-place', { headers: { cookie: 'vantage_signed_in=1' } });
  assert.equal(signedIn.status, 404);
  assert.match(signedIn.text, /<div id="root">/, 'the app shell, which shows its own "no page here"');
  assert.equal((await app.call('GET', '/no-such-file.png', { headers: { cookie: 'vantage_signed_in=1' } })).text.includes('Page not found'), true);
});
