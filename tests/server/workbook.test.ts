import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readWorkbook, readDelimited, sniffDelimiter, columnIndex, WorkbookError } from '../../server/lib/workbook.ts';
import { buildZip, readZip, ZipError } from '../../server/lib/zip.ts';

/** Builds a minimal but genuine .xlsx so the reader is exercised against the real shape of the format. */
function xlsx(options: {
  sheets: Array<{ name: string; xml: string; hidden?: boolean }>;
  shared?: string[];
  styles?: string;
  extraParts?: Record<string, string>;
} ): Buffer {
  const { sheets, shared = [], styles, extraParts = {} } = options;
  const sheetTags = sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('');
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook xmlns:r="r"><sheets>${sheetTags}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships>${rels}</Relationships>` },
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>` },
    ...(styles ? [{ name: 'xl/styles.xml', data: styles }] : []),
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
    ...Object.entries(extraParts).map(([name, data]) => ({ name, data })),
  ];
  return buildZip(entries);
}

const sheet = (rows: string) => `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData></worksheet>`;

test('reads text, numbers, shared strings and inline strings out of a sheet', () => {
  const wb = readWorkbook(xlsx({
    shared: ['Document', 'Amount', 'ULO-0264'],
    sheets: [{
      name: 'Open items',
      xml: sheet(`
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1118.38</v></c></row>
        <row r="3"><c r="A3" t="inlineStr"><is><t>MIPR-9001</t></is></c><c r="B3"><v>250</v></c></row>
      `),
    }],
  }));
  assert.equal(wb.sheets.length, 1);
  assert.equal(wb.sheets[0].name, 'Open items');
  assert.deepEqual(wb.sheets[0].rows, [
    ['Document', 'Amount'],
    ['ULO-0264', '1118.38'],
    ['MIPR-9001', '250'],
  ]);
});

test('a formula cell yields its saved result, and the formula itself is never read', () => {
  const wb = readWorkbook(xlsx({
    sheets: [{ name: 'Totals', xml: sheet('<row r="1"><c r="A1"><f>SUM(B1:B9)</f><v>4200</v></c></row>') }],
  }));
  assert.deepEqual(wb.sheets[0].rows, [['4200']]);
  assert.ok(!JSON.stringify(wb).includes('SUM('), 'the formula text must not travel with the data');
});

test('a macro-enabled workbook is read as data, and the macro is left alone', () => {
  const wb = readWorkbook(xlsx({
    sheets: [{ name: 'Data', xml: sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>fine</t></is></c></row>') }],
    extraParts: { 'xl/vbaProject.bin': 'not actually executable in this test, and never executed anywhere' },
  }));
  assert.deepEqual(wb.sheets[0].rows, [['fine']]);
  assert.ok(wb.notes.some((n) => /macro/i.test(n)), 'the person importing is told a macro is present');
  assert.ok(!JSON.stringify(wb.sheets).includes('never executed anywhere'), 'macro bytes never reach the parsed data');
});

test('an external link is reported and never followed', () => {
  const wb = readWorkbook(xlsx({
    sheets: [{ name: 'Data', xml: sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>') }],
    extraParts: { 'xl/externalLinks/externalLink1.xml': '<externalLink><externalBook r:id="rId1"/></externalLink>' },
  }));
  assert.ok(wb.notes.some((n) => /link/i.test(n)));
});

test('a workbook declaring an XML entity is refused rather than expanded', () => {
  const evil = sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>&boom;</t></is></c></row>')
    .replace('<?xml version="1.0"?>', '<?xml version="1.0"?><!DOCTYPE worksheet [<!ENTITY boom "aaaaaaaa">]>');
  assert.throws(
    () => readWorkbook(xlsx({ sheets: [{ name: 'Data', xml: evil }] })),
    (e: Error) => e instanceof WorkbookError && /entity/i.test(e.message),
  );
});

test('a hidden sheet is not offered for import', () => {
  const wb = readWorkbook(xlsx({
    sheets: [
      { name: 'Visible', xml: sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>') },
      { name: 'Scratch', hidden: true, xml: sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>b</t></is></c></row>') },
    ],
  }));
  assert.deepEqual(wb.sheets.map((s) => s.name), ['Visible']);
  assert.ok(wb.notes.some((n) => n.includes('Scratch')));
});

test('a date cell comes back as a date, not as a serial number', () => {
  const styles = `<?xml version="1.0"?><styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
  const wb = readWorkbook(xlsx({
    styles,
    sheets: [{ name: 'Dates', xml: sheet('<row r="1"><c r="A1" s="1"><v>45000</v></c><c r="B1" s="0"><v>45000</v></c></row>') }],
  }));
  assert.equal(wb.sheets[0].rows[0][0], '2023-03-15');
  assert.equal(wb.sheets[0].rows[0][1], '45000', 'a plain number stays a number');
});

test('sparse rows and columns keep their positions', () => {
  const wb = readWorkbook(xlsx({
    sheets: [{ name: 'Sparse', xml: sheet('<row r="1"><c r="C1" t="inlineStr"><is><t>third column</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>fourth row</t></is></c></row>') }],
  }));
  assert.deepEqual(wb.sheets[0].rows, [['', '', 'third column'], [], [], ['fourth row']]);
});

test('column letters map to positions past Z', () => {
  assert.equal(columnIndex('A'), 0);
  assert.equal(columnIndex('Z'), 25);
  assert.equal(columnIndex('AA'), 26);
  assert.equal(columnIndex('BC'), 54);
});

test('an encrypted archive is refused with a message a person can act on', () => {
  const buf = buildZip([{ name: 'xl/workbook.xml', data: '<workbook/>' }]);
  // Flip the encryption bit in the central directory so the reader sees a protected entry.
  const endIdx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const central = buf.readUInt32LE(endIdx + 16);
  buf.writeUInt16LE(0x0801, central + 8);
  assert.throws(() => readZip(buf), (e: Error) => e instanceof ZipError && /password/i.test(e.message));
});

test('an archive part that escapes its directory is refused', () => {
  const buf = buildZip([{ name: '../../etc/passwd', data: 'no' }]);
  assert.throws(() => readZip(buf), (e: Error) => e instanceof ZipError && /unsafe/i.test(e.message));
});

test('a file that is not a workbook fails as a value, not a crash', () => {
  assert.throws(() => readWorkbook(Buffer.from('this is a plain text file, not a workbook')), (e: Error) => e instanceof ZipError || e instanceof WorkbookError);
  assert.throws(() => readWorkbook(buildZip([{ name: 'readme.txt', data: 'hello' }])), (e: Error) => e instanceof WorkbookError && /not an Excel workbook/i.test(e.message));
});

test('too many rows truncates rather than growing without bound', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>r${i}</t></is></c></row>`).join('');
  const wb = readWorkbook(xlsx({ sheets: [{ name: 'Long', xml: sheet(rows) }] }), { maxRows: 10 });
  assert.equal(wb.sheets[0].rows.length, 10);
  assert.equal(wb.sheets[0].truncated, true);
});

test('delimited text handles quotes, embedded separators and newlines', () => {
  const rows = readDelimited('Doc,Note\r\n"ULO-1","Says ""hold"", then, waits"\r\n"MIPR-2","line one\nline two"\r\n');
  assert.deepEqual(rows, [
    ['Doc', 'Note'],
    ['ULO-1', 'Says "hold", then, waits'],
    ['MIPR-2', 'line one\nline two'],
  ]);
});

test('a byte-order mark does not become part of the first heading', () => {
  const rows = readDelimited('﻿Document,Amount\nULO-1,5\n');
  assert.equal(rows[0][0], 'Document');
});

test('the delimiter is sniffed from the heading row', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a,b,c'), ',');
  assert.equal(sniffDelimiter('single'), ',');
});
