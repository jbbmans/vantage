import assert from 'node:assert/strict';
import { parseDelimited, rowsToCsv, safeCell } from '../src/lib/delimited.js';

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

console.log(`\n${passed}/5 delimited-file checks passed`);
