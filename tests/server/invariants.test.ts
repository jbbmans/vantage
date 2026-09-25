import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['shared', 'server', 'src'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap(walk).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

test('no streak survives anywhere in the product', () => {
  const denies = /\b(no|not|never|without|removed|abandoned|zero)\b/i;
  const offenders: string[] = [];
  for (const f of files) {
    for (const sentence of f.text.split(/(?<=[.!?])\s+|\n/)) {
      if (!/\bstreaks?\b/i.test(sentence)) continue;
      if (!denies.test(sentence)) offenders.push(`${f.path}: ${sentence.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(offenders, [], 'A streak rewards logging in, not doing the work. It was removed deliberately.');
});

test('nothing presents a count of entries as a headline figure', () => {
  const banned = [/label=["']Entries["']/, /label=["']Shared entries["']/, /entries this period/i];
  const offenders: string[] = [];
  for (const f of files) for (const pattern of banned) if (pattern.test(f.text)) offenders.push(`${f.path} matched ${pattern}`);
  assert.deepEqual(offenders, [], 'Counting entries measures typing. Report what the work produced instead.');
});

test('every place that sums a financial amount first asks whether the type counts', () => {
  const offenders = files
    .filter((f) => /\+=\s*(Number\()?\s*[a-z]\.dollar_amount/i.test(f.text))
    .filter((f) => !/isSummable/.test(f.text))
    .map((f) => f.path);
  assert.deepEqual(offenders, [], 'Check isSummable before adding a financial amount to a total.');
});

test('the engine keeps each financial type in its own total', () => {
  const engine = readFileSync('shared/metricEngine.ts', 'utf8');
  // The metric id embeds the type, so two types cannot share a total.
  assert.match(engine, /moneyMetricId = \(type/);
  assert.match(engine, /unitKey: `money:\$\{typeKey \|\| 'unclassified'\}`/);
});

test('the metric engine never adds across unit keys', () => {
  const engine = readFileSync('shared/metricEngine.ts', 'utf8');
  assert.match(engine, /groups\.get\(m\.metricId\)/, 'Totals must group by metric id, which carries the unit.');
  assert.ok(!/groups\.get\(m\.kind\)/.test(engine), 'Grouping by kind alone would add unlike units together.');
});

test('no client screen recomputes a total the server already computed', () => {
  const dashboard = readFileSync('src/pages/Dashboard.tsx', 'utf8');
  assert.ok(!/aggregateMetrics/.test(dashboard), 'The dashboard must read totals from the metrics endpoint, not derive them from a page of rows.');
  assert.match(dashboard, /useMetricsReport/);
});
