import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyFilePrivate } from '../server/db/index.ts';
import { sha256File } from '../server/db/copies.ts';
import { schemaFingerprint } from '../server/db/schemaShape.ts';
import {
  FIXTURE_DIR, LEDGER, MANIFEST, buildFingerprint, fixtureIntact, readLedger, readManifest, rowCounts, upgradeParity,
  type FixtureEntry, type Ledger, type Manifest, unfrozenVersions,
} from '../tests/server/fixtureDatabases.ts';

/**
 * The frozen database fixtures and the schema ledger (ADR-0041).
 *
 * `freeze <ref>` writes a fixture with the build at that git ref: a worktree of the ref, this checkout's node_modules,
 * and tests/fixtures/databases/scenario.ts run there with that build's own test helpers. The database goes in
 * tests/fixtures/databases with its manifest entry, once: a fixture is never written again. Freeze the next release's
 * once it ships, so every later migration has to upgrade what it wrote.
 *
 * `fingerprint` prints the fingerprint of a new database's schema at this build's schema version and says whether the
 * ledger records it; `--write` records it the first time, and refuses to change a recorded one.
 *
 * `check` upgrades every fixture with this build and compares it with a new database, as the fixture test does, naming
 * the migration that last changed each object that differs.
 */
const USAGE = `Usage:
  node scripts/database-fixtures.ts freeze <git ref> [--name <file.db>]
  node scripts/database-fixtures.ts fingerprint [--write]
  node scripts/database-fixtures.ts check`;

const repo = resolve(import.meta.dirname, '..');
const [command, ...rest] = process.argv.slice(2);
const fail = (message: string): never => { console.error(message); process.exit(1); };
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const sortLedger = (ledger: Ledger): Ledger => ({ ...ledger, versions: Object.fromEntries(Object.entries(ledger.versions).sort(([a], [b]) => Number(a) - Number(b))) });

if (command === 'fingerprint') {
  const write = rest.includes('--write');
  if (rest.some((a) => a !== '--write')) fail(USAGE);
  const { schema, fingerprint, migration } = buildFingerprint();
  const ledger = readLedger();
  const recorded = ledger.versions[String(schema)];
  if (recorded && recorded.fingerprint !== fingerprint) {
    fail(`Schema ${schema} is recorded as ${recorded.fingerprint}, and a new database at it is now ${fingerprint}. A recorded schema is never changed: put the change in a new migration, then record that one.`);
  }
  if (recorded) { console.log(`Schema ${schema} (${migration}) is recorded: ${fingerprint}.`); process.exit(0); }
  if (!write) fail(`Schema ${schema} (${migration}) is not recorded. A new database at it is ${fingerprint}. Run this again with --write to record it.`);
  // A recorded version guards its migrations only once a database that build wrote is frozen: without one, a migration
  // edited in place at that version changes upgraded and new databases alike, and nothing tells them apart (ADR-0041).
  const unfrozen = unfrozenVersions(readManifest(), ledger, schema);
  if (unfrozen.length) fail(`Schema ${unfrozen.join(', ')} is recorded but no database that build wrote is frozen. Freeze one from the commit that shipped it first: node scripts/database-fixtures.ts freeze <commit>`);
  ledger.versions[String(schema)] = { fingerprint, migration, recordedAt: new Date().toISOString(), from: 'build' };
  writeJson(LEDGER, sortLedger(ledger));
  console.log(`Recorded schema ${schema} (${migration}): ${fingerprint}.`);
  process.exit(0);
}

if (command === 'check') {
  if (rest.length) fail(USAGE);
  const manifest = readManifest();
  if (!manifest.fixtures.length) fail('There are no fixtures yet. Freeze one with: node scripts/database-fixtures.ts freeze <git ref>');
  let failed = 0;
  for (const entry of manifest.fixtures) {
    if (!fixtureIntact(entry)) { failed += 1; console.error(`${entry.file} is not the file its manifest names (SHA-256 ${entry.sha256}). Fixtures are never written again: restore it from git.`); continue; }
    const { message } = upgradeParity(entry);
    if (message) { failed += 1; console.error(message); } else console.log(`${entry.file} (schema ${entry.schema}, ${entry.ref}) upgrades to a schema that matches a new database.`);
  }
  process.exit(failed ? 1 : 0);
}

if (command !== 'freeze') fail(USAGE);
const ref = rest[0];
if (!ref || ref.startsWith('--')) fail(USAGE);
const nameAt = rest.indexOf('--name');
if (rest.length !== 1 && !(rest.length === 3 && nameAt === 1)) fail(USAGE);
let commit = '';
try { commit = git('rev-parse', '--verify', `${ref}^{commit}`); } catch { fail(`${ref} does not name a commit here. Fetch it first.`); }
const isTag = (() => { try { git('rev-parse', '--verify', `refs/tags/${ref}`); return true; } catch { return false; } })();
const name = nameAt === 1 ? rest[2] : isTag ? `${ref}.db` : `main-${commit.slice(0, 7)}.db`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/.test(name)) fail(`${name} is not a fixture file name: letters, digits, dots, dashes and underscores, ending .db.`);
const manifest: Manifest = readManifest();
if (existsSync(join(FIXTURE_DIR, name)) || manifest.fixtures.some((f) => f.file === name || f.commit === commit)) {
  fail(`A fixture from ${ref} (${commit.slice(0, 7)}) or named ${name} is already frozen. Fixtures are written once and never again.`);
}

const work = mkdtempSync(join(tmpdir(), 'vantage-fixture-'));
const tree = join(work, 'tree');
// A stop while the old build runs is held until it ends: the work here is synchronous, so the handlers run only when
// the event loop is given a turn (below), and the run then stops before anything is written. The worktree is removed
// either way.
let stopped: NodeJS.Signals | null = null;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { stopped = signal; });
class Stopped extends Error {}
const stopIfAsked = async () => {
  await new Promise((done) => setImmediate(done));
  if (stopped) throw new Stopped(stopped);
};
git('worktree', 'add', '--detach', tree, commit);
try {
  symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'), 'dir');
  copyFilePrivate(join(FIXTURE_DIR, 'scenario.ts'), join(tree, '.vantage-fixture-scenario.ts'));
  const out = join(work, 'fixture.db');
  // Only what node needs: no VANTAGE_ setting of this host reaches the build that writes the fixture.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? work, TZ: 'UTC' };
  let printed = '';
  try {
    printed = execFileSync(process.execPath, ['.vantage-fixture-scenario.ts', out], { cwd: tree, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (error) {
    // Ctrl+C reaches the old build too, which then ends on the signal.
    const signal = (error as { signal?: NodeJS.Signals | null }).signal;
    if (!signal) throw error;
    stopped ??= signal;
  }
  await stopIfAsked();
  const { steps } = JSON.parse(printed.trim().split('\n').at(-1) ?? '{}') as { steps: FixtureEntry['steps'] };
  // One self-contained file, compacted.
  const db = new Database(out);
  let schema: number;
  let rows: Record<string, number>;
  let fingerprint: string;
  let migration: string | null = null;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
    db.exec('VACUUM');
    schema = Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    rows = rowCounts(db);
    fingerprint = schemaFingerprint(db);
    try {
      const history = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'migration_history'").get() as { value: string } | undefined)?.value ?? '[]') as Array<{ name: string }>;
      migration = history.at(-1)?.name ?? null;
    } catch { migration = null; }
  } finally { db.close(); }
  const version = /VERSION\s*=\s*'([^']+)'/.exec(readFileSync(join(tree, 'server', 'version.ts'), 'utf8'))?.[1] ?? 'unknown';
  await stopIfAsked();
  const dest = join(FIXTURE_DIR, name);
  copyFilePrivate(out, dest);
  const entry: FixtureEntry = { file: name, ref, commit, version, schema, sha256: sha256File(dest), bytes: readFileSync(dest).length, frozenAt: new Date().toISOString(), rows, steps };
  manifest.fixtures = [...manifest.fixtures, entry].sort((a, b) => a.schema - b.schema || a.frozenAt.localeCompare(b.frozenAt));
  writeJson(MANIFEST, { format: 'vantage-database-fixtures/1', fixtures: manifest.fixtures });
  const ledger = readLedger();
  const recorded = ledger.versions[String(schema)];
  if (!recorded) {
    ledger.versions[String(schema)] = { fingerprint, migration, recordedAt: entry.frozenAt, from: 'fixture' };
    writeJson(LEDGER, sortLedger(ledger));
  } else if (recorded.fingerprint !== fingerprint) {
    console.warn(`Schema ${schema} is recorded as ${recorded.fingerprint}, but ${ref} wrote ${fingerprint}: two builds wrote different schemas under one version. The fixture test will say where.`);
  }
  const refused = steps.filter((s) => typeof s.status !== 'number' || s.status >= 400);
  console.log(`Froze ${name}: ${ref} (${commit.slice(0, 7)}, Vantage ${version}), schema ${schema}, ${entry.bytes} bytes, SHA-256 ${entry.sha256}.`);
  console.log(`${steps.length - refused.length} of ${steps.length} scenario steps answered under 400${refused.length ? `; the others: ${refused.map((s) => `${s.step} ${s.status}`).join('; ')}` : ''}.`);
} catch (error) {
  if (!(error instanceof Stopped)) throw error;
} finally {
  try { git('worktree', 'remove', '--force', tree); } catch { /* removed with the directory below */ }
  rmSync(work, { recursive: true, force: true });
  try { git('worktree', 'prune'); } catch { /* nothing to prune */ }
  if (stopped) { console.error(`Stopped (${stopped}) before anything was written; the worktree was removed.`); process.exitCode = 130; }
}
