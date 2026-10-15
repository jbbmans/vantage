import Database from 'better-sqlite3';
import { chmodSync, copyFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { loadConfig } from '../server/config.ts';
import { SCHEMA_VERSION, metaGet, metaSet } from '../server/db/index.ts';
import { loadChainKey } from '../server/lib/keys.ts';
import { verifyAuditChain } from '../server/services/audit.ts';
import { appendRestore, chainPoint, lostSince, writeLineageFile, type ChainPoint, type RestoreRecord } from '../server/services/restoreLog.ts';
import type { AppContext } from '../server/context.ts';

/**
 * Restoring the whole service from a backup, on the host (ADR-0014). It is the one way to put an infrastructure backup
 * back, and it is privileged three times over: it runs on the host, with the service's own VANTAGE_SECRET; it names the
 * Lead Vantage Administrator who authorized it and why; and it refuses while the service has the database open. It never
 * writes the backup, and keeps the database it replaces as a safety copy beside it.
 *
 * Before anything is replaced it checks the backup: SQLite's own integrity check, a schema this build can run, the chain
 * key opening under the secret and every entry of the audit trail verifying. The copy it puts in place starts with
 * nobody signed in, no links or queued mail, and no support approval waiting; it keeps this host's history of releases,
 * upgrades, backups and restores; and it records the restore, with what it undid, for the service to write into the
 * audit trail at its next start and tell Vantage staff and every Unit Instance's Lead Unit Managers.
 */

const USAGE = `Usage:
  VANTAGE_RESTORE=1 node scripts/restore.ts REPLACE-DATABASE --from <backup.db> --by <username> --reason "<why>" \\
    [--change <change or incident record>] [--different-database] [--dry-run]

  --by      the Lead Vantage Administrator who authorized the restore, by username
  --reason  why, in at least ten characters; it is written into the audit trail
  --dry-run checks the backup and says what the restore would undo, and replaces nothing

Stop Vantage first, and keep it stopped until this finishes.`;

const fail = (message: string): never => { console.error(message); process.exit(1); };

if (process.env.VANTAGE_RESTORE !== '1' || process.argv[2] !== 'REPLACE-DATABASE') fail(`Refusing: this replaces the whole database.\n${USAGE}`);

const FLAGS = new Set(['--dry-run', '--different-database']);
const argv = process.argv.slice(3);
const flags = new Set(argv.filter((a) => FLAGS.has(a)));
const opts = new Map<string, string>();
for (let i = 0; i < argv.length; i += 1) {
  if (FLAGS.has(argv[i])) continue;
  if (!argv[i].startsWith('--') || argv[i + 1] === undefined) fail(`Unexpected argument "${argv[i]}".\n${USAGE}`);
  opts.set(argv[i].slice(2), argv[i + 1]);
  i += 1;
}
const from = opts.get('from');
const by = (opts.get('by') || '').trim();
const reason = (opts.get('reason') || '').trim();
const change = (opts.get('change') || '').trim() || null;
const dryRun = flags.has('--dry-run');
if (!from) fail(`--from is required.\n${USAGE}`);
if (!by) fail(`--by is required: the Lead Vantage Administrator who authorized the restore.\n${USAGE}`);
if (reason.length < 10 || reason.length > 500) fail('--reason is required, from ten to 500 characters. It is written into the audit trail.');
if (change && change.length > 120) fail('--change is at most 120 characters.');

const config = loadConfig();
const live = config.databasePath;
if (live === ':memory:') fail('VANTAGE_DB is in memory here; there is nothing to restore into.');
const source = resolve(from!);
if (!existsSync(source)) fail(`No backup at ${source}.`);
if (source === resolve(live)) fail('That is the live database itself.');

// ——— 1. The service must not be running: take the live database's lock, and hold it until the copy is ready ———
let liveDb: Database.Database | null = null;
if (existsSync(live)) {
  try {
    liveDb = new Database(live, { fileMustExist: true, timeout: 200 });
    liveDb.pragma('locking_mode = EXCLUSIVE');
    liveDb.exec('BEGIN EXCLUSIVE');
    liveDb.exec('COMMIT');
  } catch (error) {
    try { liveDb?.close(); } catch { /* already closed */ }
    fail(`Something has ${live} open (${(error as Error).message}). Stop Vantage, and anything else using the database, then run this again.`);
  }
}
const releaseLive = () => { try { liveDb?.close(); } catch { /* closed */ } liveDb = null; };

// ——— 2. A private copy of the backup beside the live database: the backup is never written, and the swap is one rename ———
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18);
const dir = dirname(live);
const temp = join(dir, `.vantage-restore-${stamp}-${process.pid}.db`);
const removeTemp = () => { for (const suffix of ['', '-wal', '-shm', '-journal']) { try { if (existsSync(`${temp}${suffix}`)) unlinkSync(`${temp}${suffix}`); } catch { /* gone */ } } };
let copy: Database.Database | null = null;
const abandon = (message: string): never => { try { copy?.close(); } catch { /* closed */ } removeTemp(); releaseLive(); return fail(`${message}\nNothing was replaced.`); };

try {
  const backup = new Database(source, { readonly: true, fileMustExist: true });
  await backup.backup(temp);
  backup.close();
  chmodSync(temp, 0o600);
  copy = new Database(temp);
} catch (error) {
  abandon(`The backup could not be read as a SQLite database: ${(error as Error).message}`);
}
const db = copy!;

// ——— 3. Is it a sound Vantage database this build can run, sealed under this secret, with a trail that verifies? ———
const integrity = String(db.pragma('quick_check', { simple: true }));
if (integrity !== 'ok') abandon(`The backup fails SQLite's integrity check: ${integrity}.`);
const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
if (!hasTable('audit_log') || !hasTable('meta') || !hasTable('users')) abandon('That file is not a Vantage database.');
const schema = Number(metaGet(db, 'schema_version') || 0);
if (!schema) abandon('That file is not a Vantage 5 database: it records no schema.');
if (schema > SCHEMA_VERSION) abandon(`The backup is at schema ${schema}, newer than this build's ${SCHEMA_VERSION}. Restore it with the build that took it.`);
let chainKey = '';
try { chainKey = loadChainKey(db, config); } catch (error) { abandon(`The backup was sealed under another secret: ${(error as Error).message}`); }
const chain = verifyAuditChain({ db, chainKey } as unknown as AppContext);
if (!chain.ok) abandon(`The backup's audit trail does not verify (${chain.reason}). It was changed after it was written, or sealed under another secret.`);

// ——— 4. Who authorized it: an active Lead Vantage Administrator, as the live database has it, or the backup when there is no live one ———
type Owner = { id: string; username: string; first_name: string; last_name: string };
const ownerIn = (d: Database.Database) => d.prepare(`SELECT u.id, u.username, u.first_name, u.last_name FROM users u JOIN platform_roles p ON p.user_id = u.id AND p.role = 'owner'
                                                       WHERE lower(u.username) = lower(?) AND u.active = 1`).get(by) as Owner | undefined;
let liveReadable = false;
let owner: Owner | undefined;
if (liveDb) {
  try { owner = ownerIn(liveDb); liveReadable = true; } catch { liveReadable = false; }
}
if (!liveReadable) owner = ownerIn(db);
if (!owner) abandon(`${by} is not an active Lead Vantage Administrator ${liveReadable ? 'of this service' : 'in the backup'}. A restore is authorized by one, named by username.`);
const authorizer = owner!;

// ——— 5. What it replaces, and what that undoes ———
const restored = chainPoint(db);
let replaced: ChainPoint | null = null;
let sameDatabase: boolean | null = null;
let lost: RestoreRecord['lost'] = null;
let undone: RestoreRecord['undone'] = null;
if (liveDb && liveReadable) {
  try { replaced = chainPoint(liveDb); } catch { replaced = null; }
}
if (replaced) {
  if (replaced.database_id && restored.database_id) sameDatabase = replaced.database_id === restored.database_id;
  else if (restored.seq) {
    // A backup from before databases were named: the same database still holds its newest entry, with the same hash.
    const row = liveDb!.prepare('SELECT entry_hash FROM audit_log WHERE seq = ?').get(restored.seq) as { entry_hash: string } | undefined;
    sameDatabase = row ? row.entry_hash === restored.hash : null;
  }
  if (sameDatabase === false && !flags.has('--different-database')) abandon('The backup is of another Vantage database than the one here. Pass --different-database to replace this one with it anyway.');
  if (sameDatabase) ({ lost, undone } = lostSince(liveDb!, restored));
}

const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'none');
const summary = [
  `Backup:   ${source}`,
  `          schema ${schema}, ${chain.count} audit entries, the newest at ${when(restored.at)}; the trail verifies.`,
  replaced
    ? `Replaces: ${live}\n          schema ${replaced.schema}, ${replaced.count} audit entries, the newest at ${when(replaced.at)}${sameDatabase === false ? '; another database' : ''}.`
    : `Replaces: nothing readable at ${live}.`,
  lost ? `Undoes:   ${lost.entries} audit entries after the backup${Object.keys(lost.instances).length ? `, in ${Object.keys(lost.instances).length} Unit Instances` : ''}${undone?.count ? `; ${undone.count} of them change accounts, authority or holds, which must be made again` : ''}.` : null,
  `Authorized by ${authorizer.username}: ${reason}${change ? ` (${change})` : ''}`,
].filter(Boolean).join('\n');

if (dryRun) {
  console.log(`${summary}\n\nDry run: nothing was replaced.`);
  try { db.close(); } catch { /* closed */ }
  removeTemp();
  releaseLive();
  process.exit(0);
}

// ——— 6. A safety copy of what is replaced, beside it ———
let safetyCopy: string | null = null;
if (liveDb) {
  safetyCopy = join(dir, `vantage-before-restore-${stamp}.db`);
  try {
    await liveDb.backup(safetyCopy);
  } catch {
    // A database SQLite cannot read through is kept as its files are.
    copyFileSync(live, safetyCopy);
    if (existsSync(`${live}-wal`)) copyFileSync(`${live}-wal`, `${safetyCopy}-wal`);
  }
  chmodSync(safetyCopy, 0o600);
}

// ——— 7. The copy keeps this host's history, starts with nobody signed in, and records the restore ———
const HOST_HISTORY = ['release_history', 'backup_history', 'last_backup_at', 'upgrade_history', 'restore_history'];
const at = new Date().toISOString();
db.transaction(() => {
  if (liveDb && liveReadable) {
    for (const key of HOST_HISTORY) { const value = metaGet(liveDb, key); if (value !== null) metaSet(db, key, value); }
    if (!metaGet(db, 'database_id') && replaced?.database_id && sameDatabase !== false) metaSet(db, 'database_id', replaced.database_id);
  }
  // A session, a link or a queued message from the backup's day would sign someone in, or send, as of then.
  for (const table of ['sessions', 'tokens', 'email_queue', 'oidc_states', 'connector_auth_states']) if (hasTable(table)) db.prepare(`DELETE FROM ${table}`).run();
  // An approval to change somebody's sign-in belongs to the backup's day; it is asked for again.
  if (hasTable('credential_approvals')) {
    db.prepare("UPDATE credential_approvals SET status = 'cancelled', decided_at = COALESCE(decided_at, ?), decision_note = COALESCE(decision_note, 'Cancelled by a restore of the database.') WHERE status IN ('pending', 'approved')").run(at);
  }
  appendRestore(db, {
    at, method: 'script', by: { id: authorizer.id, username: authorizer.username, name: `${authorizer.first_name} ${authorizer.last_name}`.trim() || authorizer.username },
    hostUser: process.env.SUDO_USER || (() => { try { return userInfo().username; } catch { return null; } })(),
    reason, change, restored: { ...restored, file: basename(source), bytes: statSync(source).size }, replaced, sameDatabase, lost, undone,
    safetyCopy: safetyCopy ? basename(safetyCopy) : null, audited: false,
  });
}).immediate();
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
db.close();

// ——— 8. Put it in place: the replaced database's journal goes with it, and the copy is renamed over it ———
releaseLive();
for (const suffix of ['-wal', '-shm']) if (existsSync(`${live}${suffix}`)) unlinkSync(`${live}${suffix}`);
renameSync(temp, live);
chmodSync(live, 0o600);

// ——— 9. The lineage notes the restored chain, so the next start tells this restore from a database put back some other way ———
if (config.operations.lineageFile) {
  const placed = new Database(live, { readonly: true, fileMustExist: true });
  writeLineageFile(config.operations.lineageFile, chainPoint(placed));
  placed.close();
}

console.log(`${summary}\n\nRestored. ${safetyCopy ? `The database it replaced is kept as ${safetyCopy}; it holds what the restore undid. ` : ''}Start Vantage: it writes the restore into the audit trail and tells Vantage staff and every Unit Instance's Lead Unit Managers. Everyone signs in again.`);
