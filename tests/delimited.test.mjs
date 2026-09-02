import assert from 'node:assert/strict';
import { parseDelimited, rowsToCsv, safeCell } from '../src/lib/delimited.js';
import { activityRows, guessMapping } from '../src/lib/sheets.js';

let passed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}`);
    throw error;
  }
};

check('quoted commas, newlines, and doubled quotes parse correctly', () => {
  assert.deepEqual(parseDelimited('A,B\r\n"x,y","line 1\nline 2"\r\n"say ""go""",z', ','), [
    ['A', 'B'],
    ['x,y', 'line 1\nline 2'],
    ['say "go"', 'z'],
  ]);
});

check('the 500-row ceiling also applies without a final newline', () => {
  const tooMany = ['A', ...Array.from({ length: 501 }, (_, i) => String(i))].join('\n');
  assert.throws(() => parseDelimited(tooMany, ','), /500 data rows/);
});

check('malformed quote boundaries are rejected', () => {
  assert.throws(() => parseDelimited('A\n"closed"tail', ','), /closing quote/);
  assert.throws(() => parseDelimited('A\nabc"def', ','), /unquoted cell/);
});

check('formula prefixes are neutralized even after whitespace', () => {
  for (const value of ['=1+1', ' +SUM(A1:A2)', '\t@cmd', '\r-2']) {
    assert.ok(safeCell(value).startsWith("'"), value);
  }
  assert.equal(safeCell('ordinary text'), 'ordinary text');
});

check('CSV output quotes cells and neutralizes formulas', () => {
  const csv = rowsToCsv([{ Name: 'Alpha, "one"', Value: '  =2+2' }]);
  assert.equal(csv, '"Name","Value"\r\n"Alpha, ""one""","\'  =2+2"');
});

check('finance export keeps action amount separate from transaction value', () => {
  const [row] = activityRows([{
    title: 'Reconciled aged ULOs',
    quantity: 30,
    unit: 'ULOs',
    dollar_amount: 1118.38,
    dollar_type: 'reconciled',
  }]);
  assert.equal(row['Action Amount'], 30);
  assert.equal(row['Action Unit'], 'ULOs');
  assert.equal(row['Transaction Value'], 1118.38);
  assert.equal(row['Dollar Type'], 'reconciled');
});

check('finance import accepts current and legacy column labels', () => {
  assert.deepEqual(
    guessMapping(['Title', 'Action Amount', 'Action Unit', 'Transaction Value', 'Dollar Type']),
    {
      title: 'Title',
      quantity: 'Action Amount',
      unit: 'Action Unit',
      dollar_amount: 'Transaction Value',
      dollar_type: 'Dollar Type',
    }
  );
  const legacy = guessMapping(['Title', 'Quantity', 'Unit', 'Dollar Amount', 'Dollar Type']);
  assert.equal(legacy.quantity, 'Quantity');
  assert.equal(legacy.unit, 'Unit');
  assert.equal(legacy.dollar_amount, 'Dollar Amount');
});

console.log(`\n${passed}/7 delimited-file checks passed`);
