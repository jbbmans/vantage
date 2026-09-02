import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'vantage-postgres-test-'));
const database = join(root, 'vantage.db');
const output = join(root, 'vantage-postgres.sql');
const auditKey = 'test-only-postgres-migration-audit-key-32-bytes';
process.env.NODE_ENV = 'test';
process.env.VANTAGE_DB = database;
process.env.VANTAGE_AUDIT_HMAC_KEY = auditKey;

const { audit, bootstrapAdmin, getDb, newId, now } = await import('../server/db.js');
const db = getDb(database);
const admin = bootstrapAdmin({
  username: 'migration.operator',
  password: 'Migration-Test-Password-Only-42!',
  first_name: 'Migration',
  last_name: "O'Brien",
  unit_code: 'MFR',
});
assert.ok(admin?.id);

const activityId = newId();
const timestamp = now();
db.prepare(
  `INSERT INTO activities
     (id, user_id, unit_id, date, title, notes, visibility, version, created_at, updated_at)
   VALUES (?, ?, 'MFR', '2026-09-02', ?, ?, 'unit', 1, ?, ?)`
).run(activityId, admin.id, "O'Brien review", 'Line one\nLine two \\ retained', timestamp, timestamp);
db.prepare(
  `INSERT INTO attachments
     (id, activity_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at)
   VALUES (?, ?, ?, 'evidence.bin', 'application/octet-stream', 3, ?, ?, ?)`
).run(newId(), activityId, admin.id, 'fixture-digest', Buffer.from([0, 1, 255]), timestamp);
db.prepare(
  `INSERT INTO sessions (token, user_id, created_at, expires_at, absolute_expires_at)
   VALUES ('session-digest-not-exported', ?, ?, ?, ?)`
).run(admin.id, timestamp, '2099-01-01T00:00:00.000Z', '2099-01-01T01:00:00.000Z');
audit({
  actor_id: admin.id,
  action: 'postgres_export_test',
  entity: 'database',
  detail: 'migration fixture',
});
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

const run = spawnSync(process.execPath, [
  'scripts/sqlite-to-postgres.mjs',
  '--source', database,
  '--output', output,
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, VANTAGE_AUDIT_HMAC_KEY: auditKey },
});
assert.equal(run.status, 0, run.stderr || run.stdout);

const sql = readFileSync(output, 'utf8');
const manifest = JSON.parse(readFileSync(`${output}.manifest.json`, 'utf8'));
const schema = readFileSync('server/postgres/schema.sql', 'utf8');
const postgresTables = new Map(
  [...schema.matchAll(/^CREATE TABLE ([a-z_][a-z0-9_]*) \(\n([\s\S]*?)^\);$/gm)].map((match) => [
    match[1],
    match[2].split('\n').map((line) => line.trim().match(/^([a-z_][a-z0-9_]*)\s/)?.[1]).filter(Boolean),
  ])
);
const targetOnlyColumns = {
  audit_log: ['sequence'],
  security_incident_events: ['sequence'],
};
const sqlite = new (await import('better-sqlite3')).default(database, { readonly: true });
const sqliteTables = sqlite.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((row) => row.name);
assert.deepEqual([...postgresTables.keys()].sort(), sqliteTables);
for (const table of sqliteTables) {
  const sqliteColumns = sqlite.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
  const postgresColumns = postgresTables.get(table).filter(
    (column) => !(targetOnlyColumns[table] || []).includes(column)
  );
  assert.deepEqual(postgresColumns, sqliteColumns, `${table} column parity`);
}
sqlite.close();
assert.match(sql, /CREATE TABLE security_incidents/);
assert.match(sql, /sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE/);
assert.match(sql, /CREATE UNIQUE INDEX idx_users_username_nocase ON users \(lower\(username\)\)/);
assert.match(sql, /O''Brien review/);
assert.match(sql, /Line one\nLine two \\ retained/);
assert.match(sql, /decode\('0001ff', 'hex'\)/);
assert.doesNotMatch(sql, /session-digest-not-exported/);
assert.doesNotMatch(sql, /\bPRAGMA\b|COLLATE NOCASE|\bBLOB\b/);
assert.match(sql, /SET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;/);
assert.equal(manifest.sqlite_schema_version, 16);
assert.equal(manifest.audit_entries_verified, 1);
assert.equal(manifest.tables.sessions.source_rows, 1);
assert.equal(manifest.tables.sessions.exported_rows, 0);
assert.equal(manifest.tables.activities.source_rows, 1);
assert.equal(manifest.tables.attachments.source_rows, 1);
assert.equal(statSync(output).mode & 0o777, 0o600);
assert.equal(statSync(`${output}.manifest.json`).mode & 0o777, 0o600);

const protectedOutput = join(root, 'do-not-overwrite.sql');
writeFileSync(protectedOutput, 'preserve me\n');
const refused = spawnSync(process.execPath, [
  'scripts/sqlite-to-postgres.mjs',
  '--source', database,
  '--output', protectedOutput,
], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, VANTAGE_AUDIT_HMAC_KEY: auditKey },
});
assert.notEqual(refused.status, 0);
assert.match(refused.stderr, /already exists/);
assert.equal(readFileSync(protectedOutput, 'utf8'), 'preserve me\n');

console.log('  ok    SQLite export produces a guarded PostgreSQL import with verified counts');
