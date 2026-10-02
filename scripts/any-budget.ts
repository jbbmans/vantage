/**
 * Explicit `any` is a hole in the typecheck. This counts every `any` written in the client and the server (the
 * TypeScript syntax tree, not a text search, so prose and identifiers do not count) and fails when a directory
 * holds more than its budget. When the count drops, lower the budget in scripts/any-budget.json so it stays down.
 *
 *   node scripts/any-budget.ts           check
 *   node scripts/any-budget.ts --update  set each budget to today's count
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(import.meta.dirname, '..');
const BUDGET_FILE = join(ROOT, 'scripts', 'any-budget.json');
const DIRS = ['src', 'server', 'shared'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

function anysIn(path: string): number {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, false, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node) => { if (node.kind === ts.SyntaxKind.AnyKeyword) n += 1; ts.forEachChild(node, visit); };
  visit(source);
  return n;
}

const counts: Record<string, number> = {};
const worst: Array<[string, number]> = [];
for (const dir of DIRS) {
  counts[dir] = 0;
  for (const file of files(join(ROOT, dir))) {
    const n = anysIn(file);
    counts[dir] += n;
    if (n) worst.push([relative(ROOT, file), n]);
  }
}

if (process.argv.includes('--update')) {
  writeFileSync(BUDGET_FILE, `${JSON.stringify(counts, null, 2)}\n`);
  console.log('any budget set:', counts);
  process.exit(0);
}

const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Record<string, number>;
let failed = false;
for (const dir of DIRS) {
  const over = counts[dir] - (budget[dir] ?? 0);
  if (over > 0) {
    failed = true;
    console.error(`${dir}: ${counts[dir]} explicit any, budget ${budget[dir] ?? 0}. Type the ${over} new one${over === 1 ? '' : 's'} instead.`);
  } else if (over < 0) {
    console.log(`${dir}: ${counts[dir]} explicit any, ${-over} under budget. Run \`node scripts/any-budget.ts --update\` to lock that in.`);
  } else {
    console.log(`${dir}: ${counts[dir]} explicit any, at budget.`);
  }
}
if (failed) {
  console.error('\nMost explicit any, by file:');
  for (const [file, n] of worst.sort((a, b) => b[1] - a[1]).slice(0, 10)) console.error(`  ${String(n).padStart(4)}  ${file}`);
  process.exit(1);
}
