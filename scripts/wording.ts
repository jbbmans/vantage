/**
 * Vantage reads as people wrote it. This counts three things in every text file git tracks or would track: em dashes,
 * stock phrases that read as machine-written, and references to how the work was organised (a task number, the
 * planning document's file name, a coding tool, a decision cited to a person instead of to its ADR). Each file has a
 * budget in scripts/wording-budget.json, none when it is not listed. A file over its budget fails, and every finding
 * in it is printed with its line and column. Budgets only go down: `--update` lowers each one to today's count and
 * drops the files that reach none, but never raises one.
 *
 *   node scripts/wording.ts           check
 *   node scripts/wording.ts --update  lower each budget to today's count
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import ts from 'typescript';

export const ROOT = join(import.meta.dirname, '..');
export const BUDGET_FILE = join(ROOT, 'scripts', 'wording-budget.json');

export type RuleId = 'em-dash' | 'ai-phrase' | 'process-ref';
export const RULE_IDS: readonly RuleId[] = ['em-dash', 'ai-phrase', 'process-ref'];

/** Stock phrases. Matched as whole words, any case. Product words such as "AI", "assist" and "unlock" are not here. */
const AI_PHRASES = [
  'delve', 'delves', 'delved', 'delving', 'seamless', 'seamlessly', 'leverage', 'leverages', 'leveraged', 'leveraging',
  'utilize', 'utilizes', 'utilized', 'utilizing', 'utilization', 'streamline', 'streamlines', 'streamlined',
  'streamlining', 'empower', 'empowers', 'empowered', 'empowering', 'tapestry', 'testament to', 'showcase', 'showcases',
  'showcased', 'showcasing', 'vibrant', 'dive into', 'deep dive', 'deep-dive', 'at its core', 'myriad', 'plethora',
  'furthermore', 'moreover', "it's worth noting", 'it is worth noting', 'worth mentioning', 'rest assured',
  'game-changer', 'game changer', 'game-changing', 'cutting-edge', 'state-of-the-art', 'best-in-class', 'world-class',
  'supercharge', 'supercharged', 'effortless', 'effortlessly', 'ever-evolving', 'holistic', 'holistically', 'synergy',
  'synergies', 'paradigm', 'unleash', 'unleashes', 'unleashed', 'revolutionize', 'revolutionizes', 'revolutionized',
  'transformative', 'unparalleled', 'groundbreaking', "in today's", 'fast-paced', 'meticulous', 'meticulously',
  'embark', 'embarks', 'embarked', 'embarking', 'realm of', 'pivotal', 'in order to', 'navigate the complexities',
  'great question', 'i hope this helps', 'feel free to', 'happy to help', 'as an ai language model',
  'as an ai assistant', 'as a language model',
  'large language model',
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const RULES: Record<RuleId, { what: string; patterns: readonly RegExp[]; hint: string }> = {
  'em-dash': {
    what: 'an em dash',
    patterns: [/\u2014/g],
    hint: 'Use a comma, a colon, parentheses or a second sentence. Code that has to recognise one writes \\u2014.',
  },
  'ai-phrase': {
    what: 'a stock phrase',
    patterns: [new RegExp(`(?<![\\w'-])(?:${AI_PHRASES.map(escape).join('|')})(?![\\w'-])`, 'gi')],
    hint: 'Say it plainly, in the words the reader uses.',
  },
  'process-ref': {
    what: 'a reference to how the work was organised',
    patterns: [
      /\bTasks? \d+(?:-\d+)?\b/g,
      /\bVANTAGE_CLAUDE_MASTER\b|\bCLAUDE_MASTER\b/g,
      /\b(?:Claude|Anthropic|Codex|ChatGPT|Copilot)\b/gi,
      /\bper John\b|\bJohn's (?:decision|card|answer|choice|call|instruction|word|request)s?\b/g,
      /(?:\(|; )John[,;:)]|\bJohn (?:asked|said|chose|decided|supplied|wrote|wants|wanted|approved|picked)\b|\bas John (?:asked|said|wanted)\b/g,
    ],
    hint: 'Cite the ADR or the requirement, not the task, the planning document, a tool, or who decided.',
  },
};

/**
 * Files a rule does not read, and why. The guard's own rules and the commit identity guard spell out what they refuse;
 * the bullet writer keeps lists of the words it takes out of a Marine's entry.
 */
export const EXEMPT: Record<string, { rules: readonly RuleId[]; why: string }> = {
  'package-lock.json': { rules: RULE_IDS, why: 'written by npm' },
  'film/package-lock.json': { rules: RULE_IDS, why: 'written by npm' },
  'scripts/wording.ts': { rules: ['ai-phrase', 'process-ref'], why: 'the rules themselves' },
  'tests/server/wording.test.ts': { rules: ['ai-phrase', 'process-ref'], why: 'the rules are tested on these words' },
  'scripts/commit-identity.ts': { rules: ['ai-phrase', 'process-ref'], why: 'names the tools a commit may not carry' },
  'tests/server/commitIdentity.test.ts': { rules: ['ai-phrase', 'process-ref'], why: 'fixtures spell out the trailers it refuses' },
  'shared/writer/lexicon.ts': { rules: ['ai-phrase'], why: 'the words the bullet writer replaces or removes' },
  'shared/bullets.ts': { rules: ['ai-phrase'], why: 'the phrases the bullet writer shortens' },
  'tests/server/writer.test.ts': { rules: ['ai-phrase'], why: 'entries that use the words the writer removes' },
};

const TEXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|css|html|md|txt|json|ya?ml|sql|svg|xml|webmanifest|vtt|srt|sh|toml|example)$/i;
const NAMED = new Set(['Dockerfile', 'NOTICE', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig']);
const SCRIPT = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

export interface Finding { file: string; rule: RuleId; line: number; column: number; match: string; where: string; text: string }

/** Every text file git tracks, or would track if added: what a commit can carry. */
export function textFiles(root = ROOT): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  return [...new Set(out.split('\0').filter(Boolean))]
    .filter((f) => TEXT.test(f) || NAMED.has(basename(f)))
    .filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile() && statSync(join(root, f)).size < 4 << 20)
    .sort();
}

/** Where in a script a position falls: a comment, a string, a template, JSX text or attribute, or a regular expression. */
function placesIn(file: string, source: string): (pos: number) => string {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : /\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const spans: Array<[number, number, string]> = [];
  const K = ts.SyntaxKind;
  const visit = (node: ts.Node) => {
    let where: string | null = null;
    if (node.kind === K.StringLiteral) where = node.parent?.kind === K.JsxAttribute ? 'JSX attribute' : 'string';
    else if (node.kind === K.NoSubstitutionTemplateLiteral || node.kind === K.TemplateHead || node.kind === K.TemplateMiddle || node.kind === K.TemplateTail) where = 'template';
    else if (node.kind === K.JsxText) where = 'JSX text';
    else if (node.kind === K.RegularExpressionLiteral) where = 'regular expression';
    if (where) spans.push([node.getStart(sf), node.end, where]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return (pos) => spans.find(([a, b]) => pos >= a && pos < b)?.[2] ?? 'comment';
}

/** The findings in one file's text, rule by rule, skipping the rules the file is exempt from. */
export function findingsIn(file: string, source: string): Finding[] {
  const skip = EXEMPT[file]?.rules ?? [];
  const found: Finding[] = [];
  let where: ((pos: number) => string) | null = null;
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  for (const rule of RULE_IDS) {
    if (skip.includes(rule)) continue;
    for (const pattern of RULES[rule].patterns) {
      for (const m of source.matchAll(pattern)) {
        const pos = m.index;
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
        if (SCRIPT.test(file)) where ??= placesIn(file, source);
        const lineText = source.slice(starts[lo], source.indexOf('\n', pos) === -1 ? source.length : source.indexOf('\n', pos));
        found.push({ file, rule, line: lo + 1, column: pos - starts[lo] + 1, match: m[0], where: where ? where(pos) : 'text', text: lineText.trim() });
      }
    }
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

export type Budget = Partial<Record<RuleId, Record<string, number>>>;
export type Counts = Record<RuleId, Record<string, number>>;

export function countAll(files: readonly string[], read: (f: string) => string): { counts: Counts; findings: Map<string, Finding[]> } {
  const counts = { 'em-dash': {}, 'ai-phrase': {}, 'process-ref': {} } as Counts;
  const findings = new Map<string, Finding[]>();
  for (const file of files) {
    const list = findingsIn(file, read(file));
    if (!list.length) continue;
    findings.set(file, list);
    for (const f of list) counts[f.rule][file] = (counts[f.rule][file] ?? 0) + 1;
  }
  return { counts, findings };
}

/** Files over budget, rule by rule. */
export function overBudget(counts: Counts, budget: Budget): Array<{ rule: RuleId; file: string; count: number; allowed: number }> {
  const over: Array<{ rule: RuleId; file: string; count: number; allowed: number }> = [];
  for (const rule of RULE_IDS) {
    for (const [file, count] of Object.entries(counts[rule])) {
      const allowed = budget[rule]?.[file] ?? 0;
      if (count > allowed) over.push({ rule, file, count, allowed });
    }
  }
  return over;
}

/** Each budget lowered to today's count, files at none dropped. A count above its budget leaves the budget as it was. */
export function lowered(counts: Counts, budget: Budget): Budget {
  const next: Budget = {};
  for (const rule of RULE_IDS) {
    const entries = Object.entries(budget[rule] ?? {})
      .map(([file, allowed]) => [file, Math.min(allowed, counts[rule][file] ?? 0)] as const)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length) next[rule] = Object.fromEntries(entries);
  }
  return next;
}

const area = (file: string) => (file.includes('/') ? file.slice(0, file.indexOf('/')) : '(root)');

if (import.meta.main) {
  const files = textFiles();
  const { counts, findings } = countAll(files, (f) => readFileSync(join(ROOT, f), 'utf8'));
  const budget = (existsSync(BUDGET_FILE) ? JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) : {}) as Budget;

  if (process.argv.includes('--update')) {
    writeFileSync(BUDGET_FILE, `${JSON.stringify(lowered(counts, budget), null, 2)}\n`);
    console.log('wording: budgets lowered to today\'s counts.');
    process.exit(0);
  }

  const over = overBudget(counts, budget);
  for (const rule of RULE_IDS) {
    const byArea = new Map<string, number>();
    for (const [file, n] of Object.entries(counts[rule])) byArea.set(area(file), (byArea.get(area(file)) ?? 0) + n);
    const total = [...byArea.values()].reduce((a, b) => a + b, 0);
    const allowed = Object.values(budget[rule] ?? {}).reduce((a, b) => a + b, 0);
    const where = [...byArea].sort(([a], [b]) => a.localeCompare(b)).map(([a, n]) => `${a} ${n}`).join(', ');
    console.log(`wording: ${rule}: ${total} (budget ${allowed})${where ? `: ${where}` : ''}.`);
    if (total < allowed && !over.length) console.log(`  ${allowed - total} under budget. Run \`node scripts/wording.ts --update\` to lock that in.`);
  }
  if (over.length) {
    const fileCount = new Set(over.map((o) => o.file)).size;
    console.error(`\nwording: ${fileCount} file${fileCount === 1 ? '' : 's'} over budget.`);
    for (const { rule, file, count, allowed } of over) {
      console.error(`\n${file}: ${count} ${rule} (${RULES[rule].what}), budget ${allowed}. ${RULES[rule].hint}`);
      for (const f of findings.get(file)!.filter((x) => x.rule === rule)) {
        console.error(`  ${f.file}:${f.line}:${f.column}  ${f.where}: "${f.match}" in ${f.text.length > 140 ? `${f.text.slice(0, 137)}...` : f.text}`);
      }
    }
    process.exit(1);
  }
}
