/**
 * The production readiness gate (Task 28). `docs/engineering/readiness-gate.json` is the register: every gate item
 * with the tests that prove it, every defect the gate found, every check run on the candidate, and every item only an
 * owner outside the code can close. `docs/engineering/READINESS_GATE.md` is drawn from it, so the summary never
 * claims more than the register holds. The verdict is computed here and never written by hand:
 *
 * - the engineering gate passes only when no critical or high defect is open, no gate item is open, and every
 *   required check passed (a check that was cancelled, skipped or not run is not a pass);
 * - operational release also waits on every external item, and is never decided by this script.
 *
 *   node scripts/readiness-gate.ts          check the register and that READINESS_GATE.md is what it draws
 *   node scripts/readiness-gate.ts --write  draw READINESS_GATE.md again
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
export const REGISTER_FILE = join(ROOT, 'docs', 'engineering', 'readiness-gate.json');
export const SUMMARY_FILE = join(ROOT, 'docs', 'engineering', 'READINESS_GATE.md');

export const ROLES = ['Marine', 'Supervisor', 'NCO/SNCO', 'Unit Leader', 'Unit Manager', 'Vantage Administrator'] as const;
export type GateRole = (typeof ROLES)[number];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** A test (file and title) or a document that shows a requirement holds. */
export interface GateEvidence { file: string; test?: string; note?: string }

/**
 * One thing the gate requires. `proven`: the evidence shows it on the candidate. `partly`: some of it is shown, the
 * note says what is not. `open`: not shown, and the code can show it. `external`: only an owner outside the code can.
 */
export interface GateItem {
  id: string;
  title: string;
  source: string;
  roles: GateRole[];
  status: 'proven' | 'partly' | 'open' | 'external';
  evidence: GateEvidence[];
  note?: string;
}

/** A defect the gate found. `fixed` names the test that fails without the fix. `accepted` names who accepted it. */
export interface GateDefect {
  id: string;
  title: string;
  severity: Severity;
  area: string;
  status: 'fixed' | 'open' | 'accepted';
  evidence: GateEvidence[];
  owner?: string;
  note?: string;
}

/** Something the code cannot close: an owner's decision, an approval, or evidence from the intended host. */
export interface GateExternal { id: string; title: string; owner: string; source: string; note?: string }

/** A check run on the candidate. Only `pass` counts; a required check in any other state fails the gate. */
export interface GateCheck { id: string; title: string; command: string; required: boolean; result: 'pass' | 'fail' | 'cancelled' | 'not-run'; on: string; detail: string }

export interface GateRegister {
  format: 1;
  task: string;
  candidate: { base: string; branch: string; runtime: string; note: string };
  items: GateItem[];
  defects: GateDefect[];
  external: GateExternal[];
  checks: GateCheck[];
}

export interface GateVerdict {
  engineering: 'pass' | 'fail';
  operational: 'not ready';
  reasons: string[];
  waitingOn: string[];
}

export const loadRegister = (file = REGISTER_FILE) => JSON.parse(readFileSync(file, 'utf8')) as GateRegister;

/** What the register itself gets wrong: a missing file or test, a claim without evidence, an item without an owner. */
export function gateProblems(register: GateRegister, root = ROOT): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const unique = (kind: string, id: string) => {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id)) problems.push(`${kind} ${id}: ids are lower-case words joined by hyphens`);
    if (seen.has(id)) problems.push(`${kind} ${id}: the id is used twice`);
    seen.add(id);
  };
  const cache = new Map<string, string | null>();
  const read = (file: string) => {
    if (!cache.has(file)) cache.set(file, existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null);
    return cache.get(file)!;
  };
  const checkEvidence = (owner: string, evidence: GateEvidence[]) => {
    for (const e of evidence) {
      const text = read(e.file);
      if (text === null) { problems.push(`${owner}: ${e.file} does not exist`); continue; }
      if (e.test && !/\.(test|spec)\.ts$/.test(e.file)) problems.push(`${owner}: ${e.file} is not a test file, so it names no test`);
      else if (e.test && !text.includes(e.test)) problems.push(`${owner}: no test called "${e.test}" in ${e.file}`);
    }
  };
  if (register.format !== 1) problems.push(`format ${register.format}: this script reads format 1`);
  for (const item of register.items) {
    unique('item', item.id);
    for (const role of item.roles) if (!(ROLES as readonly string[]).includes(role)) problems.push(`item ${item.id}: ${role} is not one of the gate's roles`);
    if ((item.status === 'proven' || item.status === 'partly') && !item.evidence.some((e) => e.test)) problems.push(`item ${item.id}: ${item.status} needs at least one named test`);
    if (item.status !== 'proven' && !item.note) problems.push(`item ${item.id}: ${item.status} needs a note saying what is not shown`);
    checkEvidence(`item ${item.id}`, item.evidence);
  }
  for (const role of ROLES) if (!register.items.some((i) => i.roles.includes(role))) problems.push(`no gate item covers the ${role}`);
  for (const d of register.defects) {
    unique('defect', d.id);
    if (!(SEVERITIES as readonly string[]).includes(d.severity)) problems.push(`defect ${d.id}: severity ${d.severity} is not one of ${SEVERITIES.join(', ')}`);
    if (d.status === 'fixed' && !d.evidence.some((e) => e.test)) problems.push(`defect ${d.id}: fixed needs the regression test that fails without the fix`);
    if (d.status === 'accepted' && !d.owner) problems.push(`defect ${d.id}: accepted needs the owner who accepted it`);
    if (d.status === 'accepted' && (d.severity === 'critical' || d.severity === 'high')) problems.push(`defect ${d.id}: a ${d.severity} defect cannot be accepted here; fix it or keep it open`);
    checkEvidence(`defect ${d.id}`, d.evidence);
  }
  for (const x of register.external) {
    unique('external', x.id);
    if (!x.owner.trim()) problems.push(`external ${x.id}: names no owner`);
  }
  for (const c of register.checks) {
    unique('check', c.id);
    if (!c.on.trim()) problems.push(`check ${c.id}: says nothing about what it ran on`);
  }
  return problems;
}

/** The verdict, from the register alone. */
export function verdictOf(register: GateRegister): GateVerdict {
  const reasons: string[] = [];
  const blocking = register.defects.filter((d) => d.status === 'open' && (d.severity === 'critical' || d.severity === 'high'));
  for (const d of blocking) reasons.push(`${d.severity} defect open: ${d.title} (${d.id})`);
  for (const i of register.items.filter((i) => i.status === 'open')) reasons.push(`gate item not shown: ${i.title} (${i.id})`);
  for (const c of register.checks.filter((c) => c.required && c.result !== 'pass')) reasons.push(`required check ${c.result}: ${c.title} (${c.id})`);
  const waitingOn = [
    ...register.external.map((x) => `${x.title} (${x.owner})`),
    ...register.items.filter((i) => i.status === 'external').map((i) => `${i.title} (${i.note ?? 'owner outside the code'})`),
  ];
  return { engineering: reasons.length ? 'fail' : 'pass', operational: 'not ready', reasons, waitingOn };
}

const STATUS_LABEL: Record<GateItem['status'], string> = { proven: 'Proven', partly: 'Partly', open: 'Open', external: 'External' };
const RESULT_LABEL: Record<GateCheck['result'], string> = { pass: 'Pass', fail: 'Fail', cancelled: 'Cancelled', 'not-run': 'Not run' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const cite = (evidence: GateEvidence[]) => evidence.map((e) => (e.test ? `\`${e.file}\`: “${cell(e.test)}”` : `\`${e.file}\``) + (e.note ? ` (${cell(e.note)})` : '')).join('<br>') || '–';

/** READINESS_GATE.md, drawn from the register. */
export function renderGate(register: GateRegister): string {
  const v = verdictOf(register);
  const bySeverity = [...register.defects].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.id.localeCompare(b.id));
  const count = (s: GateItem['status']) => register.items.filter((i) => i.status === s).length;
  const lines = [
    '# Production readiness gate',
    '',
    `_${register.task}. Drawn from [readiness-gate.json](readiness-gate.json) by \`scripts/readiness-gate.ts\`; edit the register, then run \`node scripts/readiness-gate.ts --write\`. A test holds the two together._`,
    '',
    '## Verdict',
    '',
    `- **Engineering gate: ${v.engineering === 'pass' ? 'PASS' : 'FAIL'}.** ${v.engineering === 'pass' ? 'No critical or high defect is open, every gate item is shown or owned outside the code, and every required check passed on the candidate.' : 'Not passed, because:'}`,
    ...v.reasons.map((r) => `  - ${r}`),
    `- **Operational release: NOT READY.** This gate never decides it. It waits on ${v.waitingOn.length} item${v.waitingOn.length === 1 ? '' : 's'} only an owner outside the code can close (below), and on the responsible authority's decision to operate.`,
    '',
    '## Candidate',
    '',
    `- Base: \`${register.candidate.base}\``,
    `- Branch: \`${register.candidate.branch}\``,
    `- Runtime: ${register.candidate.runtime}`,
    `- ${register.candidate.note}`,
    '',
    '## Checks',
    '',
    '| Check | Command | Required | Result | Ran on | Detail |',
    '|---|---|---|---|---|---|',
    ...register.checks.map((c) => `| ${cell(c.title)} | \`${cell(c.command)}\` | ${c.required ? 'Yes' : 'No'} | ${RESULT_LABEL[c.result]} | \`${cell(c.on)}\` | ${cell(c.detail)} |`),
    '',
    '## Gate items',
    '',
    `${register.items.length} items: ${count('proven')} proven, ${count('partly')} partly, ${count('open')} open, ${count('external')} external.`,
    '',
    '| Item | Source | Roles | Status | Evidence | Note |',
    '|---|---|---|---|---|---|',
    ...register.items.map((i) => `| ${cell(i.title)} | ${cell(i.source)} | ${i.roles.join(', ')} | ${STATUS_LABEL[i.status]} | ${cite(i.evidence)} | ${cell(i.note ?? '')} |`),
    '',
    '## Defects the gate found',
    '',
    register.defects.length ? '| Defect | Severity | Area | Status | Evidence | Note |' : 'None.',
    ...(register.defects.length ? ['|---|---|---|---|---|---|'] : []),
    ...bySeverity.map((d) => `| ${cell(d.title)} (\`${d.id}\`) | ${d.severity} | ${cell(d.area)} | ${d.status}${d.owner ? ` (${cell(d.owner)})` : ''} | ${cite(d.evidence)} | ${cell(d.note ?? '')} |`),
    '',
    '## Waiting on owners outside the code',
    '',
    '| Item | Owner | Source | Note |',
    '|---|---|---|---|',
    ...register.external.map((x) => `| ${cell(x.title)} (\`${x.id}\`) | ${cell(x.owner)} | ${cell(x.source)} | ${cell(x.note ?? '')} |`),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const register = loadRegister();
  const problems = gateProblems(register);
  if (problems.length) {
    console.error(`The register has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const drawn = renderGate(register);
  if (process.argv.includes('--write')) {
    writeFileSync(SUMMARY_FILE, drawn);
    console.log(`Wrote ${SUMMARY_FILE}.`);
  } else if (!existsSync(SUMMARY_FILE) || readFileSync(SUMMARY_FILE, 'utf8') !== drawn) {
    console.error('READINESS_GATE.md is not what the register draws. Run `node scripts/readiness-gate.ts --write`.');
    process.exit(1);
  }
  const v = verdictOf(register);
  console.log(`Engineering gate: ${v.engineering}. Operational release: ${v.operational}.`);
}
