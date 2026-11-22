import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_MIGRATIONS, SCHEMA_VERSION, copyFilePrivate, metaGet, openDatabase, type Migration } from '../../server/db/index.ts';
import { readChecksumFile, sha256File, upgradeCopiesIn } from '../../server/db/copies.ts';
import { upgradeHistory } from '../../server/db/upgrades.ts';
import { normalizeSql, schemaFingerprint, schemaShape, tableDefinitions } from '../../server/db/schemaShape.ts';
import { loadChainKey } from '../../server/lib/keys.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';
import type { AppContext } from '../../server/context.ts';
import { FIXTURE_DIR, FIXTURE_SECRET, buildFingerprint, damagePages, fixtureInMemory, fixtureIntact, freshDatabase, readLedger, readManifest, rowCounts, upgradeParity, type FixtureEntry } from './fixtureDatabases.ts';
import { PASSWORD, startApp } from './helpers.ts';

// Databases earlier builds wrote, frozen once, that every new migration has to upgrade (ADR-0041)

const manifest = readManifest();
const ledger = readLedger();
const older = manifest.fixtures.filter((f) => f.schema < SCHEMA_VERSION);
const fixture = (ref: string) => manifest.fixtures.find((f) => f.ref === ref)!;

/** A fixture copied into a directory of its own, as a host would hold the database. */
function onDisk(entry: FixtureEntry) {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-fixture-'));
  const path = join(dir, 'vantage.db');
  copyFilePrivate(join(FIXTURE_DIR, entry.file), path);
  return { dir, path };
}

test('the fixtures are the release tag and the two main builds the plan names, each the file its manifest records', () => {
  assert.deepEqual(manifest.fixtures.map((f) => [f.ref, f.schema]), [['v5.0.0', 14], ['2b2ccf2', 22], ['caebfab', 42]]);
  for (const entry of manifest.fixtures) {
    assert.ok(fixtureIntact(entry), `${entry.file} is the file frozen from ${entry.ref}; fixtures are never written again`);
    assert.equal(statSync(join(FIXTURE_DIR, entry.file)).size, entry.bytes);
    assert.ok(entry.rows.users >= 4 && entry.rows.activities >= 3 && entry.rows.audit_log > 0, `${entry.file} holds records, not only a schema`);
    assert.ok(entry.steps.filter((s) => s.status === 200 || s.status === 201).length >= 10, `${entry.file}: the scenario ran on ${entry.ref}`);
    const db = fixtureInMemory(entry);
    try {
      assert.equal(metaGet(db, 'schema_version'), String(entry.schema));
      assert.equal(schemaFingerprint(db), ledger.versions[String(entry.schema)]?.fingerprint, `the ledger records the schema ${entry.ref} wrote at ${entry.schema}`);
      assert.deepEqual(rowCounts(db), entry.rows);
    } finally { db.close(); }
  }
});

test('a new database has the schema the ledger records for the newest migration', () => {
  const recorded = ledger.versions[String(SCHEMA_VERSION)];
  assert.ok(recorded, `migration ${SCHEMA_VERSION} has no entry in tests/fixtures/databases/fingerprints.json. Record it with: node scripts/database-fixtures.ts fingerprint --write`);
  const { fingerprint } = buildFingerprint();
  assert.equal(fingerprint, recorded.fingerprint, `a new database at schema ${SCHEMA_VERSION} no longer has the schema recorded for it: a migration or schema.sql changed in place. Put the change in a new migration.`);
});

test('every frozen database upgrades to a new database’s schema', () => {
  assert.ok(older.length >= 2);
  for (const entry of manifest.fixtures) {
    const { message } = upgradeParity(entry);
    assert.equal(message, '', message);
  }
});

test('an upgrade keeps a checked, private copy first, with every row, and leaves the data and the trail as they were', async () => {
  for (const entry of older) {
    const { dir, path } = onDisk(entry);
    const copies = join(dir, 'copies');
    try {
      const db = openDatabase(path, { upgradeCopy: { dir: copies, keep: 3 } });
      let copyFile: string;
      try {
        // The copy: owner-only, its SHA-256 beside it, at the old schema with every row.
        const [name] = upgradeCopiesIn(copies);
        assert.match(name, new RegExp(`^vantage-before-upgrade-${entry.schema}-to-${SCHEMA_VERSION}-\\d{8}T\\d{9}\\.db$`), entry.file);
        copyFile = join(copies, name);
        assert.equal((statSync(copyFile).mode & 0o777).toString(8), '600');
        assert.equal((statSync(copies).mode & 0o777).toString(8), '700');
        assert.equal(readChecksumFile(copyFile), sha256File(copyFile));
        assert.equal((statSync(`${copyFile}.sha256`).mode & 0o777).toString(8), '600');
        const kept = new Database(copyFile, { readonly: true });
        try {
          assert.equal(metaGet(kept, 'schema_version'), String(entry.schema));
          assert.deepEqual(rowCounts(kept), entry.rows, 'the copy holds every row the database held');
          assert.equal(String(kept.pragma('integrity_check', { simple: true })), 'ok');
        } finally { kept.close(); }
        // The upgrade: verified, naming the copy; nothing lost; the trail still verifies.
        const record = upgradeHistory(db).at(-1)!;
        assert.equal(record.status, 'verified', JSON.stringify(record.service));
        assert.deepEqual(record.schema, { from: entry.schema, to: SCHEMA_VERSION });
        assert.equal(record.copy?.file, name);
        assert.equal(record.copy?.sha256, sha256File(copyFile));
        const after = rowCounts(db);
        for (const [table, n] of Object.entries(entry.rows)) if (table !== 'meta') assert.ok(after[table] >= n, `${entry.file}: ${table} ${n} before, ${after[table]} after`);
        assert.equal(String(db.pragma('integrity_check', { simple: true })), 'ok');
        assert.deepEqual(db.pragma('foreign_key_check'), []);
        const chain = verifyAuditChain({ db, chainKey: loadChainKey(db, { secret: FIXTURE_SECRET, previousSecrets: [] }) } as unknown as AppContext);
        assert.equal(chain.ok, true, chain.reason);
        assert.deepEqual(schemaShape(db), (() => { const f = freshDatabase(); try { return schemaShape(f); } finally { f.close(); } })());
      } finally { db.close(); }

      // The service runs on it: the upgrade is audited with the copy named, and the people and records are there.
      const app = await startApp({ VANTAGE_DB: path, VANTAGE_UPGRADE_COPY_DIR: copies });
      try {
        const verified = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'upgrade_verified' ORDER BY seq DESC").get() as { detail: string };
        assert.match(verified.detail, new RegExp(`schema ${entry.schema} to ${SCHEMA_VERSION}.*copied first to vantage-before-upgrade-${entry.schema}-to-${SCHEMA_VERSION}-`));
        const lead = await app.login('boletz', PASSWORD);
        assert.equal(lead.status, 200, JSON.stringify(lead.body));
        const alpha = await app.login('alpha', PASSWORD);
        assert.equal(alpha.status, 200);
        const mine = await app.call('GET', '/api/records/activities', { token: alpha.body.token });
        assert.equal(mine.status, 200);
        const titles = (mine.body.items ?? mine.body.records ?? mine.body).map((r: { title: string }) => r.title);
        assert.ok(titles.includes('Reconciled 22 MIPRs against the ledger'), JSON.stringify(titles));
      } finally { await app.close(); }
      assert.equal(upgradeCopiesIn(copies).length, 1, 'a start at the current schema takes no copy');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a database already at this build’s schema, a new one and one in memory take no copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-fixture-'));
  try {
    const current = onDisk(fixture('caebfab'));
    try { openDatabase(current.path).close(); assert.deepEqual(readdirSync(current.dir).filter((f) => f.startsWith('vantage-before-upgrade-')), []); } finally { rmSync(current.dir, { recursive: true, force: true }); }
    openDatabase(join(dir, 'new.db')).close();
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('vantage-before-upgrade-')), []);
    openDatabase(':memory:').close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the newest copies are kept, and only copies the service made are removed', () => {
  const copies = mkdtempSync(join(tmpdir(), 'vantage-copies-'));
  const keepMine = join(copies, 'vantage-before-upgrade-notes.txt');
  writeFileSync(keepMine, 'not a copy');
  const dirs: string[] = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const { dir, path } = onDisk(fixture('v5.0.0'));
      dirs.push(dir);
      openDatabase(path, { upgradeCopy: { dir: copies, keep: 2 } }).close();
    }
    const left = upgradeCopiesIn(copies);
    assert.equal(left.length, 2);
    for (const f of left) assert.ok(existsSync(join(copies, `${f}.sha256`)));
    assert.equal(readdirSync(copies).filter((f) => f.endsWith('.sha256')).length, 2, 'a pruned copy takes its SHA-256 with it');
    assert.ok(existsSync(keepMine), 'a file the service did not make is left alone');
  } finally {
    for (const d of [copies, ...dirs]) rmSync(d, { recursive: true, force: true });
  }
});

test('a copy that cannot be made, or a database that fails its check, stops the start with nothing migrated', () => {
  const schemaOf = (path: string) => { const d = new Database(path, { readonly: true }); try { return metaGet(d, 'schema_version'); } finally { d.close(); } };
  // The copy directory is a file: nothing can be written there.
  const blocked = onDisk(fixture('v5.0.0'));
  try {
    const notADir = join(blocked.dir, 'copies');
    writeFileSync(notADir, '');
    assert.throws(() => openDatabase(blocked.path, { upgradeCopy: { dir: notADir } }), /keeps a copy of the database before it upgrades it from schema 14 to \d+.*Nothing was migrated; the database is still at schema 14\./s);
    assert.equal(schemaOf(blocked.path), '14');
  } finally { rmSync(blocked.dir, { recursive: true, force: true }); }

  // A damaged database is neither copied nor upgraded.
  const damaged = onDisk(fixture('v5.0.0'));
  try {
    damagePages(damaged.path);
    assert.throws(() => openDatabase(damaged.path, { upgradeCopy: { dir: join(damaged.dir, 'copies') } }), /fails SQLite's integrity check.*Nothing was migrated/s);
    assert.equal(schemaOf(damaged.path), '14');
    assert.deepEqual(upgradeCopiesIn(join(damaged.dir, 'copies')), []);
  } finally { rmSync(damaged.dir, { recursive: true, force: true }); }
});

// The fingerprint is the schema a migration leaves, not the text it is written in

/** This build's migrations with migration 42 run another way. */
const with42 = (run: Migration['run']): Migration[] => BUILD_MIGRATIONS.map((m) => (m.id === 42 ? { ...m, run } : m));
const hasScan = (db: Parameters<Migration['run']>[0]) => (db.prepare("SELECT 1 FROM pragma_table_info('attachments') WHERE name = 'scan_status'").get());

test('a changed migration fails the fixture test, naming the table and the migration', () => {
  assert.equal(SCHEMA_VERSION >= 42, true);
  const changed = with42((db) => {
    if (!hasScan(db)) db.exec("ALTER TABLE attachments ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'unrecorded' CHECK (scan_status IN ('clean', 'skipped', 'unrecorded', 'pending'))");
  });
  for (const entry of older) {
    const { differences, message } = upgradeParity(entry, changed);
    assert.deepEqual(differences.map((d) => d.object), ['table attachments'], message);
    assert.match(message, /table attachments: .*pending/);
    assert.match(message, /table attachments: last changed by migration 42 \(042_attachment_scan\)/);
  }
  // One that also runs on a new database changes the fingerprint the ledger holds for its schema.
  const everywhere = with42((db) => { db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_scan ON attachments(scan_status)'); });
  const fresh = freshDatabase(everywhere);
  try { assert.notEqual(schemaFingerprint(fresh), ledger.versions['42'].fingerprint); } finally { fresh.close(); }
});

test('the same migration with other comments, spacing and letter case passes', () => {
  const reworded = with42((db) => {
    if (!hasScan(db)) {
      db.exec(`alter table attachments add column scan_status   TEXT not null
        default 'unrecorded' -- what the malware scan said
        check ( scan_status in ('clean','skipped','unrecorded') ) /* the three verdicts */`);
    }
  });
  for (const entry of older) {
    const { message } = upgradeParity(entry, reworded);
    assert.equal(message, '', message);
  }
});

test('a schema is described by what it does: comments, spacing, case and column order do not count, quoted text does', () => {
  assert.equal(normalizeSql("CREATE TABLE t (a TEXT  NOT NULL, -- note, with a comma\n b INTEGER /* x */ CHECK (b > 0))"), 'create table t(a text not null,b integer check(b>0))');
  assert.equal(normalizeSql("CHECK (x IN ('A', 'b  c'))"), "check(x in('A','b  c'))");
  assert.deepEqual(tableDefinitions('CREATE TABLE t (b INTEGER, a TEXT)'), tableDefinitions('create table t (a text, b integer)'));
  assert.notDeepEqual(tableDefinitions("CREATE TABLE t (a TEXT CHECK (a IN ('x')))"), tableDefinitions("CREATE TABLE t (a TEXT CHECK (a IN ('y')))"));
  assert.deepEqual(tableDefinitions('CREATE TABLE t (a TEXT) STRICT').at(-1), 'options strict');
});
