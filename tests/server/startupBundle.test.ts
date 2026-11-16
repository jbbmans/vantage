import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// What a page loads before it draws is every module its entry reaches by static imports: Vite puts each one in the
// entry chunk or a chunk the entry preloads. A lazy route or an import() is fetched later, so it is not followed, and
// neither is an `import type` or `export type`, which the compiler erases. `import { type X }` keeps the module as a
// side-effect import under verbatimModuleSyntax, so it is followed.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx'];

const STATIC_FROM = /^[ \t]*(import|export)\s+(type\s+)?([\w$*{},\s]*?)\s*from\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;

function staticImports(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(STATIC_FROM)) if (!m[2]) found.push(m[4]);
  for (const m of source.matchAll(SIDE_EFFECT)) found.push(m[1]);
  return found;
}

/** A project file's path from the repository root, or the package a bare specifier names. */
function resolveSpecifier(from: string, specifier: string): string | null {
  const bare = specifier.split('?')[0];
  let base: string;
  if (bare.startsWith('@/')) base = join(ROOT, 'src', bare.slice(2));
  else if (bare.startsWith('@shared/')) base = join(ROOT, 'shared', bare.slice('@shared/'.length));
  else if (bare.startsWith('.')) base = resolve(dirname(join(ROOT, from)), bare);
  else return bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
  for (const ext of FILE_EXTENSIONS) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return relative(ROOT, path);
  }
  throw new Error(`${from} imports ${specifier}, which is not a file`);
}

/** Every module the entry loads at startup, each with the chain of imports that reaches it. */
function startupGraph(entry: string): Map<string, string[]> {
  const via = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!/\.(ts|tsx|js)$/.test(file)) continue;
    for (const specifier of staticImports(readFileSync(join(ROOT, file), 'utf8'))) {
      const target = resolveSpecifier(file, specifier);
      if (!target || via.has(target)) continue;
      via.set(target, [...via.get(file)!, target]);
      if (target.includes('/') || target.includes('.')) queue.push(target);
    }
  }
  return via;
}

test('the reader of the startup graph follows value imports and skips the erased ones', () => {
  assert.deepEqual(staticImports([
    "import { a } from './a';",
    "import type { B } from './b';",
    "import { type C } from './c';",
    "export { d } from './d';",
    "export type { E } from './e';",
    "import './f.css';",
    "const g = () => import('./g');",
    "import X, {\n  y,\n  z as w,\n} from 'pkg';",
  ].join('\n')).sort(), ['./a', './c', './d', './f.css', 'pkg']);
});

test('the app and the Unit Manager console draw without the schema library or the list of changes', () => {
  for (const entry of ['src/main.tsx', 'src/console-main.tsx']) {
    const graph = startupGraph(entry);
    assert.ok(graph.has('src/App.tsx') || graph.has('src/console/ConsoleApp.tsx'), `${entry} reaches its app`);
    assert.ok(graph.has('react'), `${entry} reaches react, so the walk followed its imports`);
    for (const late of ['zod', 'src/config/changes.ts']) {
      assert.ok(!graph.has(late), `${entry} loads ${late} at startup: ${graph.get(late)?.join(' -> ')}`);
    }
  }
});

test('the Vantage Administrator console draws without the list of changes', () => {
  const graph = startupGraph('src/admin-main.tsx');
  assert.ok(graph.has('react'));
  assert.ok(!graph.has('src/config/changes.ts'), `loaded at startup: ${graph.get('src/config/changes.ts')?.join(' -> ')}`);
});

test('Today names draft and request kinds without loading their schemas', () => {
  const graph = startupGraph('src/pages/Dashboard.tsx');
  assert.ok(graph.has('shared/draftKinds.ts') && graph.has('shared/requestKinds.ts'));
  for (const schemas of ['shared/drafts.ts', 'shared/workflowMessages.ts', 'shared/recordTransfer.ts', 'shared/schemas.ts']) {
    assert.ok(!graph.has(schemas), `Today loads ${schemas}: ${graph.get(schemas)?.join(' -> ')}`);
  }
});
