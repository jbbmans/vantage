import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Reproducible file/line inventory, not a claim of human review, executed-line coverage or security clearance. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const paths = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
const code = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.sql']);
const files = paths.map((path) => {
  const bytes = readFileSync(resolve(root, path));
  const text = bytes.toString('utf8');
  const binary = bytes.includes(0) || (text.match(/\uFFFD/g)?.length ?? 0) > Math.max(1, text.length / 1000);
  const extension = extname(path);
  const kind = binary ? 'binary' : /(?:^|\/)package-lock\.json$/.test(path) ? 'dependency-lock' : path.startsWith('tests/') ? 'test' : code.has(extension) ? 'source' : 'documentation-or-configuration';
  const lines = binary || !text ? 0 : text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0);
  let functions = 0;
  if (!binary && /\.[cm]?[jt]sx?$/.test(path)) {
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => { if (ts.isFunctionLike(node)) functions++; ts.forEachChild(node, visit); };
    visit(parsed);
  }
  return { path, kind, bytes: bytes.length, lines, functions, sha256: createHash('sha256').update(bytes).digest('hex') };
});
const groups = [...new Set(files.map((f) => f.kind))].map((kind) => {
  const group = files.filter((f) => f.kind === kind);
  return { kind, files: group.length, lines: group.reduce((n, f) => n + f.lines, 0), bytes: group.reduce((n, f) => n + f.bytes, 0) };
});
process.stdout.write(`${JSON.stringify({
  format: 'vantage-source-inventory/1',
  generatedAt: new Date().toISOString(),
  head: git('rev-parse', 'HEAD').trim(),
  includesWorkingTree: true,
  method: 'Every tracked or nonignored working-tree file is hashed; text lines and TypeScript/JavaScript function syntax are counted. This is an automated inventory, not a manual line-by-line audit or runtime coverage measurement.',
  treeFingerprint: createHash('sha256').update(files.map((f) => `${f.path}\0${f.sha256}\n`).join('')).digest('hex'),
  totals: { files: files.length, lines: files.reduce((n, f) => n + f.lines, 0), bytes: files.reduce((n, f) => n + f.bytes, 0) },
  groups, files,
}, null, 2)}\n`);
