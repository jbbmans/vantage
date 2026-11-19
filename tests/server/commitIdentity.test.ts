import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityProblems, rangeFor, type Commit } from '../../scripts/commit-identity.ts';

/** Commits carry a person's identity: no AI tool as author or committer, and no co-author or session lines for one. */

const person = { authorName: 'jbbmans', authorEmail: 'owner@example.mil', committerName: 'jbbmans', committerEmail: 'owner@example.mil' };
const commit = (over: Partial<Commit>): Commit => ({ sha: 'a'.repeat(40), ...person, message: 'Remove the notices\n', ...over });

test('a commit by a person, with an ordinary message, passes', () => {
  assert.deepEqual(identityProblems([commit({})]), []);
  // GitHub commits a merge made on its site, and Dependabot authors its own updates: both are fine.
  assert.deepEqual(identityProblems([commit({ committerName: 'GitHub', committerEmail: 'noreply@github.com', message: 'Merge pull request #87 from jbbmans/claude/project-thread-x\n' })]), []);
  assert.deepEqual(identityProblems([commit({ authorName: 'dependabot[bot]', authorEmail: '49699333+dependabot[bot]@users.noreply.github.com' })]), []);
});

test('an AI tool as author or committer is refused, each one named', () => {
  const problems = identityProblems([
    commit({ authorName: 'Claude', authorEmail: 'noreply@anthropic.com' }),
    commit({ sha: 'b'.repeat(40), committerName: 'chatgpt-codex-connector[bot]', committerEmail: 'bot@example.com' }),
  ]);
  assert.deepEqual(problems, ['aaaaaaaa: the author is Claude <noreply@anthropic.com>', 'bbbbbbbb: the committer is chatgpt-codex-connector[bot] <bot@example.com>']);
});

test('co-author, session and generated-with lines are refused', () => {
  const message = [
    'Remove the notices', '',
    'Co-Authored-By: Claude Opus <noreply@anthropic.com>',
    'Claude-Session: https://claude.ai/code/session_x',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
  assert.equal(identityProblems([commit({ message })]).length, 3);
  assert.deepEqual(identityProblems([commit({ message: 'Fix\n\nCo-authored-by: Codex <codex@openai.com>\n' })]), ['aaaaaaaa: the message has a Co-Authored-By line naming an AI tool']);
  // A co-author who is a person is fine.
  assert.deepEqual(identityProblems([commit({ message: 'Fix\n\nCo-authored-by: Jane Doe <jane@example.mil>\n' })]), []);
});

test('the range comes from the pull request or the push, and is skipped when there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'identity-'));
  const event = (body: object) => { const path = join(dir, `${Math.random()}.json`); writeFileSync(path, JSON.stringify(body)); return { GITHUB_EVENT_PATH: path }; };
  assert.equal(rangeFor([], event({ pull_request: { base: { sha: 'b1' }, head: { sha: 'h1' } } })), 'b1..h1');
  assert.equal(rangeFor([], event({ before: 'p1', after: 'p2' })), 'p1..p2');
  assert.equal(rangeFor([], event({ before: '0000000000000000000000000000000000000000', after: 'p2' })), null, 'a new branch has no range');
  assert.equal(rangeFor([], event({})), null, 'a manual run has no range');
  assert.equal(rangeFor(['x..y'], event({ before: 'p1', after: 'p2' })), 'x..y', 'a range given wins');
  assert.equal(rangeFor(['--local'], event({ before: 'p1', after: 'p2' }), () => true), 'origin/main..HEAD', 'lint checks the local branch');
  assert.equal(rangeFor(['--local'], {}, () => false), null, 'without origin/main there is nothing to compare');
});
