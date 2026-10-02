import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { buildZip, readZip, ZipError } from '../../server/lib/zip.ts';
import { readWorkbook, readDelimited, WorkbookError } from '../../server/lib/workbook.ts';
import { parseEml, parseAddresses, EmlError } from '../../server/lib/eml.ts';
import { sanitizeEmailHtml } from '../../server/lib/sanitizeHtml.ts';
import { certificatePolicies } from '../../server/auth/cac.ts';

/**
 * Vantage parses untrusted files with its own code: workbooks (ZIP and XML), saved email, email HTML and certificate
 * extensions. These run each parser over thousands of damaged and hostile variants of valid input. A parser may
 * refuse a file, with its own error type, but it may never crash with anything else, hang, or (for the HTML cleaner)
 * let active content through. The seed is fixed so a failure reproduces exactly.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Flip, insert, delete and splice bytes the way a damaged or hostile file would. */
function mutate(input: Buffer, rand: () => number): Buffer {
  const out = Buffer.from(input);
  const edits = 1 + Math.floor(rand() * 8);
  let buf = out;
  for (let i = 0; i < edits; i += 1) {
    const at = Math.floor(rand() * Math.max(buf.length, 1));
    const op = rand();
    if (op < 0.4 && buf.length) buf[at] = Math.floor(rand() * 256);
    else if (op < 0.6) buf = Buffer.concat([buf.subarray(0, at), Buffer.from([Math.floor(rand() * 256)]), buf.subarray(at)]);
    else if (op < 0.75 && buf.length > 1) buf = Buffer.concat([buf.subarray(0, at), buf.subarray(at + 1)]);
    else if (op < 0.9) buf = buf.subarray(0, at);
    else { const n = Math.floor(rand() * 4); for (let k = 0; k < n && at + k + 4 <= buf.length; k += 1) buf.writeUInt32LE(0xffffffff, at + k); }
  }
  return buf;
}

const ITERATIONS = 1500;

function survives(name: string, fn: () => unknown, allowed: Array<new (...a: never[]) => Error>) {
  const started = Date.now();
  try { fn(); }
  catch (e) {
    if (!allowed.some((C) => e instanceof C)) assert.fail(`${name} threw ${(e as Error)?.constructor?.name}: ${(e as Error)?.message}`);
  }
  assert.ok(Date.now() - started < 2000, `${name} took ${Date.now() - started} ms`);
}

const sheet = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;
const workbook = buildZip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
  { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns:r="r"><sheets><sheet name="Open items" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
  { name: 'xl/sharedStrings.xml', data: '<?xml version="1.0"?><sst count="3"><si><t>Document</t></si><si><t>Amount</t></si><si><t>ULO-0264</t></si></sst>' },
  { name: 'xl/worksheets/sheet1.xml', data: sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1118.38</v></c></row>') },
]);

test('the ZIP and workbook readers refuse damaged archives with their own errors, never a crash', () => {
  const rand = rng(20261002);
  assert.equal(readWorkbook(workbook).sheets[0].rows[1][0], 'ULO-0264', 'the seed is a valid workbook');
  for (let i = 0; i < ITERATIONS; i += 1) {
    const bad = mutate(workbook, rand);
    survives(`readZip #${i}`, () => readZip(bad, { maxTotalBytes: 8 * 1024 * 1024 }), [ZipError]);
    survives(`readWorkbook #${i}`, () => readWorkbook(bad), [ZipError, WorkbookError]);
  }
});

test('the delimited reader takes any text', () => {
  const rand = rng(7);
  const seed = Buffer.from('Document,Title,"Amount, total"\nULO-1,"A ""quoted"" title",1118.38\r\nULO-2,,\n');
  for (let i = 0; i < ITERATIONS; i += 1) survives(`readDelimited #${i}`, () => readDelimited(mutate(seed, rand).toString('utf8')), []);
});

const EML = Buffer.from([
  'From: "SSgt Morgan Diaz" <morgan.diaz@example.mil>',
  'To: Jordan Avery <jordan.avery@example.mil>, budget@example.mil',
  'Subject: =?utf-8?B?UTQgVU1UIHN0YXR1cw==?=',
  'Date: Thu, 01 Oct 2026 14:32:00 -0500',
  'Message-ID: <abc@example.mil>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>SYN-26-P-0082 is still open=2E <img src=3D"https://track.example/p.gif"></p>',
  '--b1',
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  '',
  'JVBERi0xLjQKJcfsj6IKMSAwIG9iago8PD4+CmVuZG9iagp0cmFpbGVyCjw8Pj4KJSVFT0YK',
  '--b1--',
  '',
].join('\r\n'));

test('the email parser refuses damaged messages with its own error, never a crash', () => {
  const rand = rng(41);
  assert.equal(parseEml(EML).attachments.length, 1, 'the seed is a valid message');
  for (let i = 0; i < ITERATIONS; i += 1) {
    const bad = mutate(EML, rand);
    survives(`parseEml #${i}`, () => parseEml(bad), [EmlError]);
    survives(`parseAddresses #${i}`, () => parseAddresses(bad.subarray(0, 300).toString('latin1')), []);
  }
});

const HOSTILE = [
  '<a href="javascript:alert(1)">x</a>', '<img src=x onerror=alert(1)>', '<svg><script>alert(1)</script></svg>', '<scr<script>ipt>alert(1)</script>',
  '<a title="a&quot; onmouseover=&quot;alert(1)" href="https://x">x</a>', '<!--><img src=x onerror=alert(1)>-->', '<style>*{background:url(https://evil)}</style>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', '<a/href="javascript:alert(1)">x</a>', '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<form action="https://evil"><input name=x></form>', '<p onclick="x()">hi</p>', '<a href="&#106;avascript:alert(1)">x</a>', '<table background="https://evil/p"><tr><td>x</td></tr></table>',
];

test('the email HTML cleaner never lets active content through, whatever it is given', () => {
  const rand = rng(99);
  // Tags only: what sits inside a quoted attribute value is text (the cleaner re-quotes every value it keeps).
  const tagsOf = (html: string) => (html.match(/<[^>]*>/g) || []).map((t) => t.replace(/"[^"]*"/g, '""'));
  const bannedTags = [/^<\s*\/?\s*(script|iframe|object|embed|svg|math|form|input|style|link|meta|base|img)\b/i, /\son[a-z]+\s*=/i, /\s(src|srcdoc|style|background|action)\s*=/i];
  for (let i = 0; i < ITERATIONS * 2; i += 1) {
    const base = Buffer.from(HOSTILE.slice(0, 1 + Math.floor(rand() * HOSTILE.length)).join(''));
    const html = mutate(base, rand).toString('latin1');
    let out = '';
    survives(`sanitize #${i}`, () => { out = sanitizeEmailHtml(html).html; }, []);
    for (const tag of tagsOf(out)) for (const pattern of bannedTags) assert.doesNotMatch(tag, pattern, `input ${JSON.stringify(html)} produced ${JSON.stringify(out)}`);
    // Links inside tags only: text that merely reads href="..." is shown as text.
    for (const tag of out.match(/<[^>]*>/g) || []) for (const [, href] of tag.matchAll(/\shref="([^"]*)"/gi)) assert.match(href, /^(https?:|mailto:|tel:)/i, `a link the cleaner kept: ${href} from ${JSON.stringify(html)}`);
  }
});

test('reading certificate policies from damaged DER never crashes', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cac-crl');
  const der = new X509Certificate(readFileSync(join(dir, 'good.pem'))).raw;
  const rand = rng(5);
  for (let i = 0; i < ITERATIONS; i += 1) survives(`certificatePolicies #${i}`, () => certificatePolicies(mutate(der, rand)), []);
});
