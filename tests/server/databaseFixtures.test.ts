import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILD_MIGRATIONS, SCHEMA_VERSION, copyFilePrivate, metaGet, openDatabase, type Migration } from '../../server/db/index.ts';
import { copyTagOf, readChecksumFile, sha256File, upgradeCopiesIn } from '../../server/db/copies.ts';
import { upgradeHistory } from '../../server/db/upgrades.ts';
import { normalizeSql, schemaFingerprint, schemaShape, tableDefinitions } from '../../server/db/schemaShape.ts';
import { loadChainKey } from '../../server/lib/keys.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';
import type { AppContext } from '../../server/context.ts';
import { FIXTURE_DIR, FIXTURE_SECRET, buildFingerprint, damagePages, fixtureInMemory, fixtureIntact, freshDatabase, readLedger, readManifest, rowCounts, unfrozenVersions, upgradeParity, type FixtureEntry } from './fixtureDatabases.ts';
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

/** The same fixture put back at the same path, as the previous build left it. */
function putBack(entry: FixtureEntry, path: string) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  copyFilePrivate(join(FIXTURE_DIR, entry.file), path);
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
  // Every recorded version before the newest is reached by a frozen database, which ran its migrations as they shipped.
  const unfrozen = unfrozenVersions(manifest, ledger, SCHEMA_VERSION);
  assert.deepEqual(unfrozen, [], `schema ${unfrozen.join(', ')} is recorded but no database that build wrote is frozen, so a migration edited in place there would pass. Freeze one from the commit that shipped it: node scripts/database-fixtures.ts freeze <commit>`);
  // A made-up register: fixtures at 14 and 22, versions recorded at 14, 22, 30 and 31. With 32 the newest, 30 and 31 lack one.
  const entry = { fingerprint: 'x', migration: null, recordedAt: '2026-11-22T00:00:00.000Z', from: 'build' as const };
  const made = { format: 'vantage-schema-fingerprints/1' as const, versions: { 14: entry, 22: entry, 30: entry, 31: entry } };
  const frozen = { format: 'vantage-database-fixtures/1' as const, fixtures: manifest.fixtures.filter((f) => f.schema <= 22) };
  assert.deepEqual(unfrozenVersions(frozen, made, 32), [30, 31], 'each recorded version past the newest fixture, short of the newest, is named');
  assert.deepEqual(unfrozenVersions(frozen, made, 31), [30], 'the newest version needs no fixture yet');
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
        assert.match(name, new RegExp(`^vantage-before-upgrade-${entry.schema}-to-${SCHEMA_VERSION}-\\d{8}T\\d{9}-${copyTagOf(path)}\\.db$`), entry.file);
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

test('only the newest copies of each database are kept, the one just made always, and nothing else is removed', () => {
  const copies = mkdtempSync(join(tmpdir(), 'vantage-copies-'));
  const keepMine = join(copies, 'vantage-before-upgrade-notes.txt');
  writeFileSync(keepMine, 'not a copy');
  const v5 = fixture('v5.0.0');
  const other = onDisk(v5);
  const mine = onDisk(v5);
  try {
    // Another database shares the directory.
    openDatabase(other.path, { upgradeCopy: { dir: copies, keep: 2 } }).close();
    const others = upgradeCopiesIn(copies, other.path);
    assert.equal(others.length, 1);
    // A copy of this database stamped later than now (a clock once set wrong) never makes a start prune the copy it made.
    const later = `vantage-before-upgrade-14-to-${SCHEMA_VERSION}-20991231T000000000-${copyTagOf(mine.path)}.db`;
    writeFileSync(join(copies, later), 'a copy from a wrong clock');
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      putBack(v5, mine.path);
      const db = openDatabase(mine.path, { upgradeCopy: { dir: copies, keep: 2 } });
      try { made.push(upgradeHistory(db).at(-1)!.copy!.file); } finally { db.close(); }
      assert.ok(existsSync(join(copies, made.at(-1)!)), 'the copy a start just made is kept');
    }
    const left = upgradeCopiesIn(copies, mine.path);
    assert.equal(left.length, 2);
    assert.ok(left.includes(made.at(-1)!), 'the copy the last upgrade names is one of them');
    assert.ok(!left.includes(made[0]) && !existsSync(join(copies, `${made[0]}.sha256`)), 'an older copy goes, with its SHA-256');
    assert.deepEqual(upgradeCopiesIn(copies, other.path), others, 'another database\u2019s copies in the same directory are left alone');
    assert.ok(existsSync(join(copies, `${others[0]}.sha256`)));
    assert.ok(existsSync(keepMine), 'a file the service did not make is left alone');
    // Keeping one, the copy just made is it, even beside one whose stamp sorts after it.
    assert.ok(left.includes(later));
    putBack(v5, mine.path);
    const db = openDatabase(mine.path, { upgradeCopy: { dir: copies, keep: 1 } });
    let newest: string;
    try { newest = upgradeHistory(db).at(-1)!.copy!.file; } finally { db.close(); }
    assert.deepEqual(upgradeCopiesIn(copies, mine.path), [newest]);
  } finally {
    for (const d of [copies, other.dir, mine.dir]) rmSync(d, { recursive: true, force: true });
  }
});

test('a start after a failed upgrade keeps the copy that start took, so restarts never prune away the database as it was', () => {
  const { dir, path } = onDisk(fixture('v5.0.0'));
  const copies = join(dir, 'copies');
  const schemaOf = () => { const d = new Database(path, { readonly: true }); try { return metaGet(d, 'schema_version'); } finally { d.close(); } };
  try {
    // Migration 30 fails on this database, every time: each start stops there, at schema 29.
    const d = new Database(path);
    for (const on of ['INSERT', 'UPDATE']) d.exec(`CREATE TRIGGER refuse_30_${on.toLowerCase()} BEFORE ${on} ON meta WHEN NEW.key = 'schema_version' AND NEW.value = '30' BEGIN SELECT RAISE(ABORT, 'migration 30 cannot take this database'); END`);
    d.close();
    for (let start = 0; start < 4; start += 1) assert.throws(() => openDatabase(path, { upgradeCopy: { dir: copies, keep: 1 } }), /migration 30 cannot take this database/);
    assert.equal(schemaOf(), '29');
    const kept = upgradeCopiesIn(copies, path);
    assert.equal(kept.length, 1, 'no copy of the half-upgraded database replaces it');
    assert.match(kept[0], /^vantage-before-upgrade-14-to-/);
    const failed = (() => { const h = new Database(path, { readonly: true }); try { return upgradeHistory(h).filter((r) => r.status === 'failed'); } finally { h.close(); } })();
    assert.equal(failed.length, 4);
    for (const r of failed) assert.equal(r.copy?.file, kept[0], 'each failed start names the copy of the database as the previous build left it');
    // Once the cause is gone, the upgrade completes and still names that copy.
    const fix = new Database(path);
    for (const on of ['insert', 'update']) fix.exec(`DROP TRIGGER refuse_30_${on}`);
    fix.close();
    const db = openDatabase(path, { upgradeCopy: { dir: copies, keep: 1 } });
    try { assert.equal(upgradeHistory(db).at(-1)!.copy?.file, kept[0]); } finally { db.close(); }
    assert.deepEqual(upgradeCopiesIn(copies, path), kept);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a start after a failed upgrade takes a copy of its own once anything was written since, and keeps the failed start\u2019s', () => {
  // What the previous build, or someone by hand, might write meanwhile: a row added, a row only changed, a setting.
  const writes: Record<string, string> = {
    'someone signs in': `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, absolute_expires_at, method)
      SELECT 'served-again', id, '2026-11-22T00:00:00.000Z', '2026-11-22T00:00:00.000Z', '2026-11-23T00:00:00.000Z', '2026-11-23T00:00:00.000Z', 'password' FROM users LIMIT 1`,
    'a name is corrected': "UPDATE users SET first_name = first_name || 'e' WHERE rowid = (SELECT MIN(rowid) FROM users)",
    'a setting is written': "INSERT INTO meta (key, value) VALUES ('served_again', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  };
  for (const [what, sql] of Object.entries(writes)) {
    const { dir, path } = onDisk(fixture('v5.0.0'));
    const copies = join(dir, 'copies');
    try {
      const d = new Database(path);
      for (const on of ['INSERT', 'UPDATE']) d.exec(`CREATE TRIGGER refuse_30_${on.toLowerCase()} BEFORE ${on} ON meta WHEN NEW.key = 'schema_version' AND NEW.value = '30' BEGIN SELECT RAISE(ABORT, 'migration 30 cannot take this database'); END`);
      d.close();
      assert.throws(() => openDatabase(path, { upgradeCopy: { dir: copies, keep: 1 } }), /migration 30 cannot take this database/);
      const [first] = upgradeCopiesIn(copies, path);
      const failed = (() => { const h = new Database(path, { readonly: true }); try { return upgradeHistory(h).at(-1)!; } finally { h.close(); } })();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.left?.schema, '29', 'the failed start records the database as it left it');
      const served = new Database(path);
      try { assert.equal(served.prepare(sql).run().changes, 1, what); } finally { served.close(); }
      assert.throws(() => openDatabase(path, { upgradeCopy: { dir: copies, keep: 1 } }), /migration 30 cannot take this database/);
      const after = upgradeCopiesIn(copies, path);
      assert.equal(after.length, 2, `${what}: a copy of the database as it now is, and the failed start\u2019s, which is never pruned`);
      assert.ok(after.includes(first), what);
      const second = (() => { const h = new Database(path, { readonly: true }); try { return upgradeHistory(h).at(-1)!.copy!.file; } finally { h.close(); } })();
      assert.notEqual(second, first, what);
      assert.match(second, /^vantage-before-upgrade-29-to-/, what);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a database that holds data but records no schema is neither copied nor migrated', () => {
  // People and a trail; then rows only in other tables (units, records, ranks), which migration 15 would rebuild.
  for (const empty of [false, true]) {
    const { dir, path } = onDisk(fixture('v5.0.0'));
    try {
      const d = new Database(path);
      d.pragma('foreign_keys = OFF');
      d.prepare('DELETE FROM meta WHERE key = ?').run('schema_version');
      if (empty) {
        d.exec('DROP TRIGGER IF EXISTS audit_log_no_delete; DELETE FROM audit_log; DELETE FROM sessions; DELETE FROM member_roles; DELETE FROM users');
      }
      const count = (table: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const before = count('units');
      const peopleAndTrail = count('users') + count('audit_log');
      d.close();
      assert.ok(before > 0);
      assert.equal(peopleAndTrail === 0, empty);
      let message = '';
      assert.throws(() => openDatabase(path, { upgradeCopy: { dir: join(dir, 'copies') } }), (error: Error) => { message = error.message; return true; });
      assert.match(message, /holds rows \(\d+ in activities, .*\) but records no schema version.*Nothing was migrated/s);
      assert.match(message, empty ? /\d+ in awards/ : /\d+ in audit_log/);
      if (empty) assert.doesNotMatch(message, / in audit_log\b/, 'it is refused for what the other tables hold');
      assert.deepEqual(upgradeCopiesIn(join(dir, 'copies')), []);
      const after = new Database(path, { readonly: true });
      try {
        assert.equal(metaGet(after, 'schema_version'), null);
        assert.equal((after.prepare('SELECT COUNT(*) AS n FROM units').get() as { n: number }).n, before, 'nothing in it was touched');
      } finally { after.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('a start says before it migrates when the copy it keeps has a trail a restore refuses', async () => {
  const warned: string[] = [];
  const errors: string[] = [];
  const { warn, error } = console;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  const breakTrail = (d: Database.Database) => { d.prepare("UPDATE audit_log SET detail = 'changed by hand' WHERE seq = 5").run(); };
  try {
    for (const broken of [false, true]) {
      const { dir, path } = onDisk(fixture('v5.0.0'));
      try {
        if (broken) { const d = new Database(path); try { breakTrail(d); } finally { d.close(); } }
        warned.length = 0;
        const app = await startApp({ VANTAGE_DB: path, VANTAGE_UPGRADE_COPY_DIR: join(dir, 'copies') });
        try {
          const record = upgradeHistory(app.ctx.db).at(-1)!;
          assert.equal(record.copy?.trail?.ok, !broken, `broken: ${broken}`);
          const said = warned.filter((w) => w.includes(record.copy!.file));
          if (broken) {
            assert.equal(said.length, 1);
            assert.match(said[0], /its audit trail fails its check, as the database's own does: Its audit trail does not verify \(audit entry .* does not match the chain\).*cannot be put back with scripts\/restore\.ts/s);
          } else assert.deepEqual(said, []);
          const entry = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action IN ('upgrade_verified', 'upgrade_rows_lost') AND detail LIKE '%copied first to%' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
          assert.equal(entry.detail.includes('whose audit trail does not verify'), broken, entry.detail);
        } finally { await app.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // A start that then fails does not send the operator to that copy.
    const { dir, path } = onDisk(fixture('v5.0.0'));
    try {
      const d = new Database(path);
      try {
        breakTrail(d);
        for (const on of ['INSERT', 'UPDATE']) d.exec(`CREATE TRIGGER refuse_30_${on.toLowerCase()} BEFORE ${on} ON meta WHEN NEW.key = 'schema_version' AND NEW.value = '30' BEGIN SELECT RAISE(ABORT, 'migration 30 cannot take this database'); END`);
      } finally { d.close(); }
      errors.length = 0;
      await assert.rejects(startApp({ VANTAGE_DB: path, VANTAGE_UPGRADE_COPY_DIR: join(dir, 'copies') }), /migration 30 cannot take this database/);
      assert.match(errors.join('\n'), /has an audit trail that does not verify, as this database's did not, so a restore refuses it: restore the last backup whose trail verifies/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { console.warn = warn; console.error = error; }
});
