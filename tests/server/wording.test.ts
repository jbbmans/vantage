import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUDGET_FILE, EXEMPT, ROOT, countAll, findingsIn, lowered, overBudget, textFiles, type Budget, type Counts } from '../../scripts/wording.ts';

/** The wording guard: em dashes, stock phrases and references to how the work was organised, each held to a budget. */

const DASH = String.fromCharCode(0x2014);
const BACKSLASH = String.fromCharCode(92);
const AMP = '&';
const rules = (file: string, text: string) => findingsIn(file, text).map((f) => `${f.rule} ${f.line}:${f.column} ${f.where} ${f.match}`);

test('an em dash is found with its line, column and what it sits in; an escape is not one', () => {
  const source = [
    `// The chain's head ${DASH} kept outside the server`,
    `const label = 'Report only ${DASH} never acts';`,
    `export const Row = () => <td title="a ${DASH} b">Try it ${DASH} now</td>;`,
    `const dash = /[-${BACKSLASH}u2013${BACKSLASH}u2014]/;`,
    `const blank = /^[${DASH}]$/;`,
  ].join('\n');
  assert.deepEqual(rules('src/x.tsx', source), [
    `em-dash 1:21 comment ${DASH}`,
    `em-dash 2:28 string ${DASH}`,
    `em-dash 3:39 JSX attribute ${DASH}`,
    `em-dash 3:51 JSX text ${DASH}`,
    `em-dash 5:18 regular expression ${DASH}`,
  ]);
  assert.deepEqual(rules('docs/a.md', `# Title ${DASH} sub`), [`em-dash 1:9 text ${DASH}`]);
  assert.deepEqual(rules('src/y.tsx', `export const P = () => <p>Saved ${AMP}mdash; sent</p>;`), [`em-dash 1:33 JSX text ${AMP}mdash;`]);
  assert.deepEqual(rules('public/a.html', `<p>a ${AMP}#8212; b ${AMP}#x2014; c</p>`), [`em-dash 1:6 text ${AMP}#8212;`, `em-dash 1:16 text ${AMP}#x2014;`]);
  assert.deepEqual(rules('src/a.css', `.x::before { content: "${BACKSLASH}2014"; }`), [`em-dash 1:24 text ${BACKSLASH}2014`]);
  assert.deepEqual(rules('src/b.css', `.x::before { content: "${BACKSLASH}20140"; }`), [], 'another code point');
});

test('stock phrases are matched as whole words in any case, and product words are not', () => {
  const found = findingsIn('src/a.ts', [
    '// Furthermore, this lets a leader leverage the report to unleash a seamless review.',
    '// In order to unlock an account, an elevated role must ensure the robust check runs.',
  ].join('\n')).map((f) => f.match);
  assert.deepEqual(found, ['Furthermore', 'leverage', 'unleash', 'seamless', 'In order to']);
  assert.deepEqual(rules('src/b.ts', "// Draft with AI on GenAI.mil; the reviewer's notes; a moreoverish name; leverage_ratio"), []);
});

test('a stock phrase is found inside quote marks, with either apostrophe, and across a wrapped line', () => {
  const found = (file: string, text: string) => findingsIn(file, text).map((f) => `${f.line}:${f.column} ${f.where} ${f.match}`);
  assert.deepEqual(found('src/c.tsx', [
    "const title = 'Seamless import';",
    "toast('Leverage the roster');",
    "export const T = () => <p title='Furthermore, it saves'>It’s worth noting that in today’s Corps</p>;",
  ].join('\n')), [
    '1:16 string Seamless',
    '2:8 string Leverage',
    '3:34 JSX attribute Furthermore',
    "3:57 JSX text It’s worth noting",
    "3:80 JSX text in today’s",
  ]);
  assert.deepEqual(found('src/d.ts', '// This runs in order\n// to keep the chain whole.\n/**\n * A deep\n * dive.\n */'), ['1:14 comment in order\n// to', '4:6 comment deep\n * dive']);
  assert.deepEqual(found('src/e.ts', "const a = 'the Marine’s leverage’s'; const b = 'o’seamless';"), [], 'an apostrophe between letters is part of the word');
});

test('references to how the work was organised are found, and a person named in data is not', () => {
  const found = findingsIn('server/a.ts', [
    '/** Duty records (Task 17, ADR-0023). */',
    '// Tasks 7-8 brought forward (VANTAGE_CLAUDE_MASTER §19).',
    '// A key is a key (Codex, PR #77); written with Claude.',
    "// No block (John's decision of 2026-10-11); role only (John, 2026-11-10), as John asked.",
    '// John’s card said so; John’s standing instruction is to wait.',
    "const operator = { first_name: 'John', last_name: 'Boletz' }; // a task 3 in lower case is prose",
    "const extract = 'DoD ID,Last,First,1234567890,Boletz,John';",
  ].join('\n')).map((f) => f.match);
  assert.deepEqual(found, ['Task 17', 'Tasks 7-8', 'VANTAGE_CLAUDE_MASTER', 'Codex', 'Claude', "John's decision", '(John,', 'as John asked', 'John’s card', 'John’s standing instruction']);
});

test('an exempt file is not read for the rules it is exempt from, and still is for the rest', () => {
  assert.deepEqual(EXEMPT['tests/server/commitIdentity.test.ts'].rules, ['process-ref']);
  assert.deepEqual(rules('tests/server/commitIdentity.test.ts', "const line = 'Co-Authored-By: Claude <noreply@anthropic.com>';"), []);
  assert.deepEqual(rules('tests/server/commitIdentity.test.ts', '// Furthermore, it refuses them.'), ['ai-phrase 1:4 comment Furthermore']);
  assert.deepEqual(rules('tests/server/commitIdentity.test.ts', `const line = 'a ${DASH} b';`), [`em-dash 1:17 string ${DASH}`]);
  assert.deepEqual(rules('shared/writer/lexicon.ts', "const words = [['streamline', '', 'improve', 3], ['utilized', 'used']];"), []);
  assert.equal(rules('shared/writer/lexicon.ts', '// Task 37').length, 1, 'the writer\'s word lists are exempt from stock phrases only');
});

test('a file over its budget is named; a budget is only ever lowered, and a file at none leaves the budget', () => {
  const counts: Counts = { 'em-dash': { 'docs/a.md': 3, 'src/new.tsx': 1 }, 'ai-phrase': {}, 'process-ref': { 'docs/b.md': 1 } };
  const budget: Budget = { 'em-dash': { 'docs/a.md': 5, 'docs/gone.md': 2 }, 'process-ref': { 'docs/b.md': 1 } };
  assert.deepEqual(overBudget(counts, budget), [{ rule: 'em-dash', file: 'src/new.tsx', count: 1, allowed: 0 }]);
  assert.deepEqual(overBudget({ ...counts, 'em-dash': { 'docs/a.md': 6 } }, budget), [{ rule: 'em-dash', file: 'docs/a.md', count: 6, allowed: 5 }]);
  assert.deepEqual(lowered(counts, budget), { 'em-dash': { 'docs/a.md': 3 }, 'process-ref': { 'docs/b.md': 1 } });
  assert.deepEqual(lowered({ ...counts, 'em-dash': { 'docs/a.md': 9 } }, budget), { 'em-dash': { 'docs/a.md': 5 }, 'process-ref': { 'docs/b.md': 1 } }, 'never raised');
});

test('the application, its tests, its scripts and its films carry no budget: nothing there is let through', () => {
  const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget;
  const allowed = Object.values(budget).flatMap((files) => Object.keys(files ?? {}));
  assert.deepEqual(allowed.filter((f) => /^(src|server|shared|scripts|tests|film|public)\//.test(f) || !f.includes('/')), []);
});

test('the repository is within its wording budget', () => {
  const { counts, findings } = countAll(textFiles(), (f) => readFileSync(join(ROOT, f), 'utf8'));
  const over = overBudget(counts, JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget);
  assert.deepEqual(over.flatMap(({ file, rule }) => findings.get(file)!.filter((f) => f.rule === rule).map((f) => `${f.file}:${f.line}:${f.column} ${f.match}`)), []);
});
