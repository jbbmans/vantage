/**
 * Every commit in Vantage is authored and committed by a person. This fails when a commit in the range names an AI
 * tool as its author or committer, or carries a co-author, session or "generated with" line for one.
 *
 *   node scripts/commit-identity.ts               in CI: the pull request's commits, or the range pushed to main
 *   node scripts/commit-identity.ts --local       origin/main..HEAD, when origin/main exists (npm run lint)
 *   node scripts/commit-identity.ts A..B          any range
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  message: string;
}

const TOOL = /\b(claude|anthropic|codex|openai|chatgpt)\b/i;
const LINES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^co-authored-by:.*\b(claude|anthropic|codex|openai|chatgpt)\b/im, 'a Co-Authored-By line naming an AI tool'],
  [/^claude-session:/im, 'a Claude-Session line'],
  [/generated with \[?claude code/i, 'a "Generated with Claude Code" line'],
];

export function identityProblems(commits: readonly Commit[]): string[] {
  const problems: string[] = [];
  for (const c of commits) {
    const short = c.sha.slice(0, 8);
    for (const [role, name, email] of [['author', c.authorName, c.authorEmail], ['committer', c.committerName, c.committerEmail]] as const) {
      if (TOOL.test(name) || TOOL.test(email)) problems.push(`${short}: the ${role} is ${name} <${email}>`);
    }
    for (const [pattern, what] of LINES) if (pattern.test(c.message)) problems.push(`${short}: the message has ${what}`);
  }
  return problems;
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function hasRef(ref: string): boolean {
  try { git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`); return true; } catch { return false; }
}

/** The range to check, or null when there is nothing to check here (a manual run, a new branch, no origin/main). */
export function rangeFor(argv: readonly string[], env: NodeJS.ProcessEnv, hasOriginMain = () => hasRef('origin/main')): string | null {
  const given = argv.find((a) => a.includes('..'));
  if (given) return given;
  if (!argv.includes('--local') && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (event.pull_request) return `${event.pull_request.base.sha}..${event.pull_request.head.sha}`;
    if (event.before && event.after && !/^0+$/.test(event.before)) return `${event.before}..${event.after}`;
    return null;
  }
  return hasOriginMain() ? 'origin/main..HEAD' : null;
}

export function commitsIn(range: string): Commit[] {
  const out = git('log', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e', range);
  return out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter(Boolean).map((record) => {
    const [sha, authorName, authorEmail, committerName, committerEmail, message] = record.split('\x1f');
    return { sha, authorName, authorEmail, committerName, committerEmail, message };
  });
}

if (import.meta.main) {
  const range = rangeFor(process.argv.slice(2), process.env);
  if (!range) {
    console.log('commit identity: no range to check here.');
  } else {
    const commits = commitsIn(range);
    const problems = identityProblems(commits);
    if (problems.length) {
      console.error(`commit identity: ${problems.length} problem(s) in ${range}:`);
      for (const p of problems) console.error(`  ${p}`);
      console.error('Commits carry a person\'s name and address and no AI tool lines. Amend or rewrite them before merging.');
      process.exit(1);
    }
    console.log(`commit identity: ${commits.length} commit(s) in ${range}, all carry a person's identity.`);
  }
}
