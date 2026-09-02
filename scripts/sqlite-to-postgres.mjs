#!/usr/bin/env node

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATEST_SCHEMA_VERSION, verifyAuditChain } from '../server/db.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_PATH = join(ROOT, 'server', 'postgres', 'schema.sql');
const OMITTED_TABLES = new Set(['sessions']);
const TABLES = [
  'ranks',
  'billets',
  'users',
  'units',
  'roles',
  'unit_members',
  'member_roles',
  'assignments',
  'projects',
  'activities',
  'tasks',
  'goals',
  'recognitions',
  'trainings',
  'audit_log',
  'attachments',
  'ux_daily_metrics',
  'notifications',
  'rank_change_requests',
  'maradmins',
  'maradmin_user_state',
  'sessions',
  'integration_clients',
  'security_incidents',
  'security_incident_events',
  'meta',
];

function fail(message) {
  process.stderr.write(`PostgreSQL export refused: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!['--source', '--output'].includes(token) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('usage: npm run migrate:postgres:prepare -- --source /absolute/vantage.db --output /secure/vantage-postgres.sql');
    }
    args[token.slice(2)] = argv[i + 1];
    i += 1;
  }
  if (!args.source || !args.output) {
    throw new Error('both --source and --output are required');
  }
  if (!isAbsolute(args.source) || !isAbsolute(args.output)) {
    throw new Error('--source and --output must be absolute paths');
  }
  return args;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlLiteral(value, context) {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `decode('${value.toString('hex')}', 'hex')`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${context} contains a non-finite number`);
    return String(value);
  }
  const text = String(value);
  if (text.includes('\0')) throw new Error(`${context} contains a NUL byte PostgreSQL cannot store as text`);
  return `'${text.replaceAll("'", "''")}'`;
}

function canonicalValue(value) {
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')];
  if (value === undefined) return null;
  return value;
}

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, 'drain');
}

async function digestFile(path) {
  const digest = createHash('sha256');
  const input = createReadStream(path);
  input.on('data', (chunk) => digest.update(chunk));
  await once(input, 'end');
  return digest.digest('hex');
}

function inspectSource(db) {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity.slice(0, 5))}`);
  }
  const foreignKeys = db.pragma('foreign_key_check');
  if (foreignKeys.length) throw new Error(`SQLite has ${foreignKeys.length} foreign-key violation(s)`);
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);
  if (current !== LATEST_SCHEMA_VERSION) {
    throw new Error(`source schema is version ${current}; expected ${LATEST_SCHEMA_VERSION}`);
  }
  const actual = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
  const missing = TABLES.filter((table) => !actual.includes(table));
  const unexpected = actual.filter((table) => !TABLES.includes(table));
  if (missing.length || unexpected.length) {
    throw new Error(`source table set differs (missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'})`);
  }
  const audit = verifyAuditChain(db);
  if (!audit.ok) throw new Error(`tamper-evident audit verification failed: ${audit.reason}`);
  return { schemaVersion: current, auditEntries: audit.count };
}

async function exportTable(db, stream, table) {
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map((column) => column.name);
  const sourceCount = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count;
  const digest = createHash('sha256');
  const batchLimit = table === 'attachments' ? 1 : 250;
  let batch = [];
  let exportedRows = 0;
  const flush = async () => {
    if (!batch.length) return;
    const values = batch.map(({ row, rowNumber }) => {
      const ordered = columns.map((column) => canonicalValue(row[column]));
      digest.update(`${JSON.stringify(ordered)}\n`, 'utf8');
      return `(${columns.map((column) => sqlLiteral(row[column], `${table} row ${rowNumber} column ${column}`)).join(', ')})`;
    });
    await writeChunk(
      stream,
      `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES\n${values.join(',\n')};\n`
    );
    batch = [];
  };
  if (!OMITTED_TABLES.has(table)) {
    const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY rowid`);
    for (const row of statement.iterate()) {
      exportedRows += 1;
      batch.push({ row, rowNumber: exportedRows });
      if (batch.length >= batchLimit) await flush();
    }
    await flush();
  }
  if (exportedRows === 0) digest.update('', 'utf8');
  await writeChunk(
    stream,
    `DO $vantage$ BEGIN IF (SELECT COUNT(*) FROM ${quoteIdentifier(table)}) <> ${exportedRows} THEN RAISE EXCEPTION 'VANTAGE row-count mismatch for ${table}'; END IF; END $vantage$;\n`
  );
  return {
    source_rows: sourceCount,
    exported_rows: exportedRows,
    sha256: digest.digest('hex'),
    omitted_reason: OMITTED_TABLES.has(table) ? 'active sessions are revoked at cutover' : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.source)) throw new Error('source database does not exist');
  if (lstatSync(args.source).isSymbolicLink()) throw new Error('source database must not be a symbolic link');
  const sourcePath = realpathSync(args.source);
  if (!statSync(sourcePath).isFile()) throw new Error('source database must be a regular file');

  const outputDir = realpathSync(dirname(args.output));
  const outputPath = join(outputDir, basename(args.output));
  const manifestPath = `${outputPath}.manifest.json`;
  const partialPath = `${outputPath}.partial-${process.pid}`;
  if ([outputPath, manifestPath, partialPath].some(existsSync)) {
    throw new Error('output, manifest, or process-specific partial file already exists');
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'vantage-postgres-export-'));
  const snapshotPath = join(tempRoot, 'source-snapshot.db');
  let stream;
  try {
    const live = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await live.backup(snapshotPath);
    } finally {
      live.close();
    }

    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const source = inspectSource(snapshot);
      stream = createWriteStream(partialPath, { flags: 'wx', mode: 0o600 });
      stream.on('error', () => {});
      const schema = readFileSync(SCHEMA_PATH, 'utf8').trim();
      await writeChunk(stream, '\\set ON_ERROR_STOP on\n');
      await writeChunk(stream, '-- Contains sensitive VANTAGE data. Store and transmit only through approved encrypted channels.\n');
      await writeChunk(stream, `-- Generated ${new Date().toISOString()} from SQLite schema ${source.schemaVersion}.\n`);
      await writeChunk(stream, "SET client_min_messages = warning;\nSET standard_conforming_strings = on;\nBEGIN;\n");
      await writeChunk(stream, `${schema}\nSET CONSTRAINTS ALL DEFERRED;\n`);

      const tables = {};
      for (const table of TABLES) tables[table] = await exportTable(snapshot, stream, table);
      await writeChunk(
        stream,
        `DO $vantage$ BEGIN IF (SELECT value FROM meta WHERE key = 'schema_version') <> '${source.schemaVersion}' THEN RAISE EXCEPTION 'VANTAGE schema-version mismatch'; END IF; END $vantage$;\n`
      );
      await writeChunk(stream, 'SET CONSTRAINTS ALL IMMEDIATE;\nCOMMIT;\nANALYZE;\n');
      stream.end();
      await once(stream, 'finish');
      stream = null;
      renameSync(partialPath, outputPath);

      const manifest = {
        format: 'vantage-sqlite-to-postgresql-v1',
        generated_at: new Date().toISOString(),
        source_file: basename(sourcePath),
        source_snapshot_bytes: statSync(snapshotPath).size,
        source_snapshot_sha256: await digestFile(snapshotPath),
        sqlite_schema_version: source.schemaVersion,
        audit_entries_verified: source.auditEntries,
        target: 'PostgreSQL 15 or newer',
        tables,
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`Prepared PostgreSQL import: ${outputPath}\nManifest: ${manifestPath}\n`);
      process.stdout.write(`Active sessions intentionally omitted: ${tables.sessions.source_rows}\n`);
    } finally {
      snapshot.close();
    }
  } finally {
    if (stream) stream.destroy();
    if (existsSync(partialPath)) rmSync(partialPath, { force: true });
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error.message));
