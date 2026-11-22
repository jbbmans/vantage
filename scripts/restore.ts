import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, renameSync, rmSync, statfsSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { loadConfig } from '../server/config.ts';
import { SCHEMA_VERSION, backupDatabase, copyFilePrivate, metaGet, metaSet, openDatabase } from '../server/db/index.ts';
import { sha256File, writeChecksumFile } from '../server/db/copies.ts';
import { upgradeHistory } from '../server/db/upgrades.ts';
import { loadChainKey, resealStoredSecrets, sealedUnderPreviousSecret } from '../server/lib/keys.ts';
import { verifyAuditChainOf } from '../server/services/audit.ts';
import { checkBackup, fileFaults } from '../server/services/backupCheck.ts';
import { backupHistory } from '../server/services/backupLog.ts';
import { recordDrill, type DrillRecord } from '../server/services/drillLog.ts';
import { appendRestore, chainPoint, lostSince, writeLineageFile, type ChainPoint, type RestoreRecord } from '../server/services/restoreLog.ts';
import { VERSION } from '../server/version.ts';

/**
 * Restoring the whole service from a backup, on the host (ADR-0014). It is the one way to put an infrastructure backup
 * back, and it is privileged three times over: it runs on the host, with the service's own VANTAGE_SECRET; it names the
 * Lead Vantage Administrator who authorized it and why; and it refuses while the service has the database open. It never
 * writes the backup, and keeps the database it replaces as a safety copy beside it.
 *
 * Before anything is replaced it checks the backup (ADR-0041): SQLite's full integrity check, one self-contained file, a
 * schema this build can run, its bytes matching the `.sha256` beside it, the chain key opening under the secret and every
 * entry of the audit trail verifying. The copy it puts in place starts with nobody signed in, no links or queued mail,
 * and no support approval waiting; it keeps this host's history of releases, upgrades, backups, drills and restores; and
 * it records the restore, with what it undid, for the service to write into the audit trail at its next start and tell
 * Vantage staff and every Unit Instance's Lead Unit Managers.
 *
 * The drill (`DRILL`, and `REPLACE-DATABASE --dry-run`, which is the drill and the check on who authorized it) runs with
 * the service up (ADR-0041). It takes no lock and replaces nothing: it applies every step above to a scratch copy beside
 * the live database, opens the result with this build as the next start would, upgrade included, checks it again, says
 * what a restore would undo, and removes the copy. The live database is only read, and records the drill, which the
 * running service writes into the audit trail.
 */

const USAGE = `Usage:
  node scripts/restore.ts DRILL --from <backup.db>

  VANTAGE_RESTORE=1 node scripts/restore.ts REPLACE-DATABASE --from <backup.db> --by <username> --reason "<why>" \\
    [--change <change or incident record>] [--different-database] [--dry-run]

  DRILL     rehearses a restore with Vantage running: the backup is restored into a scratch copy, opened with this
            build and checked, and the copy removed; nothing is replaced
  --by      the Lead Vantage Administrator who authorized the restore, by username
  --reason  why, in at least ten characters; it is written into the audit trail
  --dry-run the drill, and the check on who authorized it; nothing is replaced

A restore needs Vantage stopped, and kept stopped until it finishes. A drill or a dry run does not.`;

const fail = (message: string): never => { console.error(message); process.exit(1); };

const mode = process.argv[2];
const drillOnly = mode === 'DRILL';
if (!drillOnly && (process.env.VANTAGE_RESTORE !== '1' || mode !== 'REPLACE-DATABASE')) fail(`Refusing: this replaces the whole database.\n${USAGE}`);

const FLAGS = new Set(drillOnly ? [] : ['--dry-run', '--different-database']);
// A misspelt option is refused, so a change record or a reason is never dropped without a word.
const OPTIONS = new Set(drillOnly ? ['--from'] : ['--from', '--by', '--reason', '--change']);
const argv = process.argv.slice(3);
const flags = new Set(argv.filter((a) => FLAGS.has(a)));
const opts = new Map<string, string>();
for (let i = 0; i < argv.length; i += 1) {
  if (FLAGS.has(argv[i])) continue;
  if (!OPTIONS.has(argv[i]) || argv[i + 1] === undefined) fail(`Unexpected argument "${argv[i]}".\n${USAGE}`);
  opts.set(argv[i].slice(2), argv[i + 1]);
  i += 1;
}
const from = opts.get('from');
const by = (opts.get('by') || '').trim();
const reason = (opts.get('reason') || '').trim();
const change = (opts.get('change') || '').trim() || null;
const dryRun = flags.has('--dry-run');
/** A drill or a dry run: nothing is locked or replaced, and the result is recorded. */
const rehearse = drillOnly || dryRun;
if (!from) fail(`--from is required.\n${USAGE}`);
if (!drillOnly) {
  if (!by) fail(`--by is required: the Lead Vantage Administrator who authorized the restore.\n${USAGE}`);
  if (reason.length < 10 || reason.length > 500) fail('--reason is required, from ten to 500 characters. It is written into the audit trail.');
  if (change && change.length > 120) fail('--change is at most 120 characters.');
}

const config = loadConfig();
const live = config.databasePath;
if (live === ':memory:') fail('VANTAGE_DB is in memory here; there is nothing to restore into.');
const source = resolve(from!);
// A drill of a backup that is not there is a failed drill, recorded like any other: the check below names it.
if (!existsSync(source) && !rehearse) fail(`No backup at ${source}.`);
if (source === resolve(live)) fail('That is the live database itself.');

const started = performance.now();
const hostUser = process.env.SUDO_USER || (() => { try { return userInfo().username; } catch { return null; } })();
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18);
const dir = dirname(live);
const temp = join(dir, `${rehearse ? '.vantage-drill' : '.vantage-restore'}-${stamp}-${process.pid}.db`);
/** The live database: locked for a restore, read-only for a drill. */
let liveDb: Database.Database | null = null;
// A byte copy of the live files keeps its descriptors here, open until the lock goes: closing one would drop it.
const heldOpen: number[] = [];
let copy: Database.Database | null = null;
/** What the drill found so far, recorded whether it passes or not. */
const facts: Pick<DrillRecord, 'backup' | 'upgraded' | 'trail' | 'sameDatabase' | 'wouldUndo'> = {
  backup: { file: basename(source), bytes: null, sha256: null, schema: null, seq: null, at: null, recorded: false },
  upgraded: null, trail: null, sameDatabase: null, wouldUndo: null,
};

const releaseLive = () => {
  try { liveDb?.close(); } catch { /* closed */ }
  liveDb = null;
  for (const fd of heldOpen.splice(0)) { try { closeSync(fd); } catch { /* closed */ } }
};
const removeTemp = () => { for (const suffix of ['', '-wal', '-shm', '-journal']) { try { if (existsSync(`${temp}${suffix}`)) unlinkSync(`${temp}${suffix}`); } catch { /* gone */ } } };
/** Writes the drill into the live database, for the console and for the service to audit. Never a reason to fail it. */
let recorded = false;
const recordRehearsal = (ok: boolean, failure: string | null, refused: DrillRecord['refused'] = null, stopped = false) => {
  if (!rehearse || recorded || !existsSync(live)) return;
  recorded = true;
  try {
    const db = new Database(live, { fileMustExist: true });
    try {
      db.pragma('busy_timeout = 5000');
      recordDrill(db, { kind: drillOnly ? 'drill' : 'dry_run', ok, failure: failure?.slice(0, 1000) ?? null, ...(refused ? { refused } : {}), ...(stopped ? { stopped } : {}), ...facts, by: drillOnly ? null : by, hostUser, version: VERSION, ms: Math.round(performance.now() - started) });
    } finally { db.close(); }
  } catch (error) {
    console.warn(`The drill ran, but the database could not record it: ${(error as Error).message}`);
  }
};
const abandon = (message: string, refused: DrillRecord['refused'] = null, stopped = false): never => {
  try { copy?.close(); } catch { /* closed */ }
  removeTemp();
  releaseLive();
  recordRehearsal(false, message, refused, stopped);
  return fail(`${message}\nNothing was replaced.`);
};
/** Set once the restored copy is in place: from then on nothing is undone, and the temporary copy no longer exists. */
let swapped = false;
// Anything that throws before the swap leaves no scratch copy behind. A drill that stops so is recorded as stopped, not
// as a backup that does not restore: the error may be the host's or the live database's. Signals keep their default
// everywhere but the one wait in a restore (step 6), since a handler would only run once the synchronous work is done.
process.on('uncaughtException', (error) => {
  if (swapped) { console.error(`The restored database is in place, but a later step failed: ${error.message}`); process.exit(1); }
  abandon(`The ${rehearse ? 'drill' : 'restore'} stopped: ${error.message}`, null, true);
});

// 1. A restore needs the service stopped: take the live database's lock, and hold it until the copy is ready. A drill
//    only reads the live database, so it runs beside the service.
if (existsSync(live)) {
  if (rehearse) {
    try { liveDb = new Database(live, { readonly: true, fileMustExist: true }); } catch { liveDb = null; }
  } else {
    try {
      liveDb = new Database(live, { fileMustExist: true, timeout: 200 });
      liveDb.pragma('locking_mode = EXCLUSIVE');
      liveDb.exec('BEGIN EXCLUSIVE');
      liveDb.exec('COMMIT');
    } catch (error) {
      try { liveDb?.close(); } catch { /* already closed */ }
      fail(`Something has ${live} open (${(error as Error).message}). Stop Vantage, and anything else using the database, then run this again. A drill does not need it stopped: node scripts/restore.ts DRILL --from <backup.db>.`);
    }
  }
}
let liveReadable = false;
if (liveDb) { try { liveDb.prepare('SELECT 1 FROM users LIMIT 1').get(); liveReadable = true; } catch { liveReadable = false; } }

// 2. Is the backup sound: one self-contained SQLite file that passes the full integrity check, the bytes it was taken
//    with, a Vantage schema this build can run, sealed under this secret, with a trail that verifies?
let check: ReturnType<typeof checkBackup>;
try { check = checkBackup(source, { config, requireTrail: true }); } catch (error) { abandon(`The backup could not be checked: ${(error as Error).message}`); }
check = check!;
facts.backup = { file: basename(source), bytes: check.bytes, sha256: check.sha256, schema: check.schema, seq: check.audit?.seq ?? null, at: check.audit?.at ?? null, recorded: false };
if (liveDb && liveReadable && check.sha256) { try { facts.backup.recorded = backupHistory(liveDb).some((r) => r.sha256 === check.sha256); } catch { /* unrecorded */ } }
if (!check.ok) {
  const broken = fileFaults(check);
  abandon(`The backup cannot be restored. ${(broken.length ? broken : check.faults).map((f) => f.message).join(' ')}`);
}
const schema = check.schema!;

// 3. A private copy of the backup beside the live database: the backup is never written, and the swap is one rename
try {
  const fs = statfsSync(dir);
  const free = Number(fs.bavail) * Number(fs.bsize);
  if (free < (check.bytes ?? 0) + (1 << 20)) abandon(`${dir} has ${Math.ceil(free / 1_048_576)} MB free, and the restored copy needs about ${Math.ceil((check.bytes ?? 0) / 1_048_576) + 1} MB there. Make room, then run this again.`, 'space');
} catch { /* a file system that cannot say its free space is copied to as it is */ }
try {
  copyFilePrivate(source, temp);
  if (sha256File(temp) !== check.sha256) abandon('The backup changed while it was copied. Check what else is writing to it, then run this again.');
  copy = new Database(temp);
} catch (error) {
  abandon(`The backup could not be copied beside the database: ${(error as Error).message}`);
}
const db = copy!;
const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
let chainKey = '';
const rewrapped = sealedUnderPreviousSecret(db, config);
try { chainKey = loadChainKey(db, config); } catch (error) { abandon(`The backup was sealed under another secret: ${(error as Error).message}`); }
const chain = verifyAuditChainOf(db, chainKey);
if (!chain.ok) abandon(`The backup's audit trail does not verify (${chain.reason}). It was changed after it was written, or sealed under another secret.`);
// Opening the chain key above wrapped it again under the current secret when only VANTAGE_SECRET_PREVIOUS opened it. The
// values sealed with the secret are sealed again with it too, so the restored service does not start under the current
// secret alone with authenticators, mailbox tokens and the signing key it can no longer open (ADR-0014).
const resealed = resealStoredSecrets(db, config);
if (resealed) console.log(`Sealed ${resealed} stored secret${resealed === 1 ? '' : 's'} again under the current VANTAGE_SECRET${rehearse ? ', in the scratch copy' : ''}.`);

// 4. Who authorized it: an active Lead Vantage Administrator, as the live database has it, or the backup when there is no live one
type Owner = { id: string; username: string; first_name: string; last_name: string };
// A backup from before platform roles names its owners by users.is_operator, as the migration to roles reads it.
const ownerIn = (d: Database.Database) => (d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'platform_roles'").get()
  ? d.prepare(`SELECT u.id, u.username, u.first_name, u.last_name FROM users u JOIN platform_roles p ON p.user_id = u.id AND p.role = 'owner'
               WHERE lower(u.username) = lower(?) AND u.active = 1`).get(by)
  : d.prepare('SELECT id, username, first_name, last_name FROM users WHERE lower(username) = lower(?) AND active = 1 AND is_operator = 1').get(by)) as Owner | undefined;
let authorizer: Owner | null = null;
if (!drillOnly) {
  let owner: Owner | undefined;
  let ownersFrom: 'live' | 'backup' = liveDb && liveReadable ? 'live' : 'backup';
  if (ownersFrom === 'live') {
    try { owner = ownerIn(liveDb!); } catch (error) {
      // Accounts SQLite cannot read through are a damaged database, the one a restore is for: the backup names who may
      // authorize it, as it does when nothing here can be read at all.
      if (/^SQLITE_(CORRUPT|NOTADB)/.test(String((error as { code?: string }).code ?? ''))) {
        ownersFrom = 'backup';
        console.log(`The accounts in ${live} cannot be read (${(error as Error).message}), so the backup's Lead Vantage Administrators authorize this.`);
      } else owner = undefined;
    }
  }
  if (ownersFrom === 'backup') { try { owner = ownerIn(db); } catch { owner = undefined; } }
  if (!owner) abandon(`${by} is not an active Lead Vantage Administrator ${ownersFrom === 'live' ? 'of this service' : 'in the backup'}. A restore is authorized by one, named by username.`, 'authorization');
  authorizer = owner!;
}

// 5. What it replaces, and what that undoes
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
  else {
    // A backup from before databases were named is this database's only if the trail here still holds its newest entry,
    // with the same hash (ADR-0040). Anything else, an entry this trail does not reach or a backup with no trail at all,
    // is another database's: refused below without --different-database, and never given this database's name.
    // A trail here that cannot be read cannot say either way.
    try {
      const row = restored.seq ? liveDb!.prepare('SELECT entry_hash FROM audit_log WHERE seq = ?').get(restored.seq) as { entry_hash: string } | undefined : undefined;
      sameDatabase = Boolean(row && restored.hash && row.entry_hash === restored.hash);
    } catch { sameDatabase = null; }
  }
  facts.sameDatabase = sameDatabase;
  // A drill of another database's backup still says whether it restores; only a restore, or its dry run, refuses it.
  if (sameDatabase === false && !drillOnly && !flags.has('--different-database')) abandon('The backup is of another Vantage database than the one here. Pass --different-database to replace this one with it anyway.', 'other_database');
  // What a restore undoes is read from the database it replaces. A damaged one may not give it; the restore still goes ahead.
  if (sameDatabase) {
    try { ({ lost, undone } = lostSince(liveDb!, restored)); } catch (error) {
      console.log(`What a restore would undo could not be read from ${live} (${(error as Error).message}).`);
    }
  }
  if (lost) facts.wouldUndo = { entries: lost.entries, instances: Object.keys(lost.instances).length, changes: undone?.count ?? 0 };
}

const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : 'none');
const summary = [
  `Backup:   ${source}`,
  `          schema ${schema}, ${chain.count} audit entries, the newest at ${when(restored.at)}; SQLite's integrity check passes and the trail verifies.`,
  `          SHA-256 ${check.sha256}${check.checksum === 'match' ? ', as its .sha256 says' : ''}${facts.backup.recorded ? '; this database recorded taking it' : ''}.`,
  replaced
    ? `${rehearse ? 'Would replace' : 'Replaces'}: ${live}\n          schema ${replaced.schema}, ${replaced.count} audit entries, the newest at ${when(replaced.at)}${sameDatabase === false ? '; another database' : ''}.`
    : `${rehearse ? 'Would replace' : 'Replaces'}: nothing readable at ${live}.`,
  lost ? `${rehearse ? 'Would undo' : 'Undoes'}:   ${lost.entries} audit entries after the backup${Object.keys(lost.instances).length ? `, in ${Object.keys(lost.instances).length} Unit Instances` : ''}${undone?.count ? `; ${undone.count} of them change accounts, authority or holds, which must be made again` : ''}.` : null,
  authorizer ? `Authorized by ${authorizer.username}: ${reason}${change ? ` (${change})` : ''}` : null,
].filter(Boolean).join('\n');

// 6. A safety copy of what is replaced, beside it, checked and with its SHA-256
let safetyCopy: string | null = null;
if (!rehearse && liveDb) {
  safetyCopy = join(dir, `vantage-before-restore-${stamp}.db`);
  const drawn = safetyCopy;
  // The one wait in a restore: a stop while the copy is drawn removes what was drawn, and nothing is replaced.
  const interrupted = (signal: NodeJS.Signals) => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${drawn}${suffix}`, { force: true });
    abandon(`The restore was interrupted (${signal}) while the database it replaces was being copied.`);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, interrupted);
  let readable = true;
  try {
    await backupDatabase(liveDb, safetyCopy);
    const kept = new Database(safetyCopy, { fileMustExist: true });
    try { kept.pragma('journal_mode = DELETE'); } finally { kept.close(); }
  } catch {
    // A database SQLite cannot read through is kept as its files are, each owner-only before a byte is copied.
    readable = false;
    copyFilePrivate(live, safetyCopy, heldOpen);
    if (existsSync(`${live}-wal`)) copyFilePrivate(`${live}-wal`, `${safetyCopy}-wal`, heldOpen);
  } finally {
    // A stop that came while the byte copy above ran (it is synchronous) is handled before the listeners go, on this turn.
    await new Promise((done) => setImmediate(done));
    for (const signal of signals) process.removeListener(signal, interrupted);
  }
  chmodSync(safetyCopy, 0o600);
  // The copy is what the database was, sound or not: a restore is often the answer to a damaged one, so it is kept and
  // said, never a reason to stop.
  const kept = readable ? checkBackup(safetyCopy) : null;
  // Its SHA-256 is kept beside it whether SQLite can read it or not, and its log's too when it has one.
  writeChecksumFile(safetyCopy, kept?.sha256 ?? sha256File(safetyCopy));
  if (existsSync(`${safetyCopy}-wal`)) writeChecksumFile(`${safetyCopy}-wal`, sha256File(`${safetyCopy}-wal`));
  if (!kept || !kept.ok) console.log(`The database being replaced ${kept ? `fails its check (${kept.faults.map((f) => f.message).join(' ')})` : 'cannot be read by SQLite'}; its copy is kept as it was.`);
}

// 7. The copy keeps this host's history, starts with nobody signed in, and records the restore
const HOST_HISTORY = ['release_history', 'backup_history', 'last_backup_at', 'upgrade_history', 'restore_history', 'drill_history'];
const at = new Date().toISOString();
db.transaction(() => {
  if (liveDb && liveReadable) {
    for (const key of HOST_HISTORY) { const value = metaGet(liveDb, key); if (value !== null) metaSet(db, key, value); }
    if (!metaGet(db, 'database_id') && replaced?.database_id && sameDatabase === true) metaSet(db, 'database_id', replaced.database_id);
  }
  // A session, a link or a queued message from the backup's day would sign someone in, or send, as of then.
  for (const table of ['sessions', 'tokens', 'passkey_challenges', 'email_queue', 'oidc_states', 'connector_auth_states']) if (hasTable(table)) db.prepare(`DELETE FROM ${table}`).run();
  // An approval to change somebody's sign-in belongs to the backup's day; it is asked for again.
  if (hasTable('credential_approvals')) {
    db.prepare("UPDATE credential_approvals SET status = 'cancelled', decided_at = COALESCE(decided_at, ?), decision_note = COALESCE(decision_note, 'Cancelled by a restore of the database.') WHERE status IN ('pending', 'approved')").run(at);
  }
  appendRestore(db, {
    at, method: 'script',
    by: authorizer ? { id: authorizer.id, username: authorizer.username, name: `${authorizer.first_name} ${authorizer.last_name}`.trim() || authorizer.username } : null,
    hostUser, reason: drillOnly ? 'Restore drill' : reason, change, restored: { ...restored, file: basename(source), bytes: statSync(source).size }, replaced, sameDatabase, lost, undone,
    safetyCopy: safetyCopy ? basename(safetyCopy) : null, audited: false,
    rotated: rewrapped || resealed ? { chainKey: rewrapped, resealed } : null,
  });
}).immediate();
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
db.close();
copy = null;

// 8. A drill opens the restored copy with this build, as the next start would, checks it again, and removes it
if (rehearse) {
  releaseLive();
  try {
    const opened = openDatabase(temp, { upgradeCopy: false });
    try {
      if (schema < SCHEMA_VERSION) {
        const upgrade = upgradeHistory(opened).at(-1);
        facts.upgraded = { from: schema, to: SCHEMA_VERSION, status: upgrade?.status ?? 'unrecorded' };
        if (upgrade?.status === 'changed') {
          const fewer = upgrade.service.filter((c) => !c.intended).map((c) => `${c.table} ${c.before} to ${c.after ?? 'gone'}`).slice(0, 8);
          throw new Error(`the upgrade from schema ${schema} to ${SCHEMA_VERSION} left fewer rows${fewer.length ? ` (${fewer.join(', ')})` : ''}`);
        }
      }
      const integrity = (opened.pragma('integrity_check(5)') as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join('; ');
      if (integrity !== 'ok') throw new Error(`it fails SQLite's integrity check after the restore steps: ${integrity.slice(0, 300)}`);
      // The restored service starts under the current secret alone, as a restore leaves it.
      const key = loadChainKey(opened, { secret: config.secret, previousSecrets: [] });
      const after = verifyAuditChainOf(opened, key);
      if (!after.ok) throw new Error(`its audit trail does not verify under VANTAGE_SECRET alone after the restore steps (${after.reason})`);
      facts.trail = after.count;
    } finally { opened.close(); }
  } catch (error) {
    abandon(`The restored copy did not open as the next start would: ${(error as Error).message}.`);
  }
  removeTemp();
  recordRehearsal(true, null);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const drilled = `Drill:    restored into a scratch copy beside ${live}${facts.upgraded ? `, upgraded from schema ${facts.upgraded.from} to ${facts.upgraded.to}` : ''}, opened with this build (${VERSION}): SQLite's integrity check passes and the trail verifies over ${facts.trail} entries under VANTAGE_SECRET alone. The copy was removed (${seconds} s).`;
  console.log(`${summary}\n${drilled}\n\n${dryRun ? 'Dry run: nothing was replaced.' : 'Drill passed: nothing was replaced.'} The running service writes it into the audit trail within five minutes.`);
  process.exit(0);
}

// 9. Put it in place: the replaced database's journal goes with it, and the copy is renamed over it
releaseLive();
for (const suffix of ['-wal', '-shm']) if (existsSync(`${live}${suffix}`)) unlinkSync(`${live}${suffix}`);
renameSync(temp, live);
swapped = true;
chmodSync(live, 0o600);

// 10. The lineage notes the restored chain, so the next start tells this restore from a database put back some other way
if (config.operations.lineageFile) {
  const placed = new Database(live, { readonly: true, fileMustExist: true });
  writeLineageFile(config.operations.lineageFile, chainPoint(placed));
  placed.close();
}

console.log(`${summary}\n\nRestored. ${safetyCopy ? `The database it replaced is kept as ${safetyCopy}, with its SHA-256 beside it; it holds what the restore undid. ` : ''}Start Vantage: it writes the restore into the audit trail and tells Vantage staff and every Unit Instance's Lead Unit Managers. Everyone signs in again.`);
