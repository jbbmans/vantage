import type { AppContext, SessionUser } from '../context.ts';
import { now } from '../lib/ids.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { upgradeHistory, updateUpgrade, type UpgradeRecord } from '../db/upgrades.ts';
import { audit } from './audit.ts';
import { backupHistory, markBackupsAudited } from './backupLog.ts';
import { notify, notifyOrg, notifyStaff } from './notifications.ts';
import { chainPoint, checkLineage, markRestoreAudited, restoreHistory, writeLineageFile, type RestoreRecord } from './restoreLog.ts';

/**
 * What the service writes into the audit trail about its own upgrades, backups and restores (ADR-0014), and the lineage
 * it keeps beside its database. Upgrades and restores happen before the service can write an entry (a migration runs as
 * the database opens; a restore runs with the service stopped), and a backup taken on the server is made by a script
 * that does not hold the key the trail is sealed with. Each leaves a record in the database instead, and the running
 * service audits it once, marking the record in the same transaction.
 */

const activeInstances = (ctx: AppContext) =>
  ctx.db.prepare("SELECT id, name FROM organizations WHERE status = 'active' ORDER BY name").all() as Array<{ id: string; name: string }>;
const userExists = (ctx: AppContext, id: string | null | undefined) => Boolean(id && ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id));
const lossText = (changes: Array<{ table: string; before: number; after: number | null }>) =>
  changes.slice(0, 8).map((c) => `${c.table} ${c.before} to ${c.after ?? 'gone'}`).join(', ') + (changes.length > 8 ? `, and ${changes.length - 8} more` : '');

// ——— Upgrades ———

/** Audits each schema upgrade this database recorded and has not audited: one entry for the service, one per Unit Instance that lost rows. */
export function auditUpgrades(ctx: AppContext) {
  for (const record of upgradeHistory(ctx.db).filter((r) => !r.audited)) {
    const schema = `schema ${record.schema.from} to ${record.schema.to}`;
    ctx.db.transaction(() => {
      if (record.status === 'failed') {
        audit(ctx, { actor_id: null, action: 'upgrade_failed', entity: 'schema', entity_id: String(record.failed?.id ?? record.schema.to), detail: `${record.failed?.name ?? 'a migration'} failed under ${record.version} at ${record.at} and was rolled back; the database stayed at schema ${record.schema.to}: ${record.failed?.error ?? 'no error recorded'}`.slice(0, 1000) });
      } else {
        const lost = record.service.filter((c) => !c.intended);
        const lossy = record.status === 'changed';
        audit(ctx, {
          actor_id: null, action: lossy ? 'upgrade_rows_lost' : 'upgrade_verified', entity: 'schema', entity_id: String(record.schema.to),
          detail: `${schema} under ${record.version}, ${record.checked} tables counted before and after in ${record.ms} ms: ${lossy ? `fewer rows in ${lost.length ? lossText(lost) : `${record.instances.length} Unit Instances`}` : 'no table lost rows'}`,
        });
        for (const instance of record.instances) {
          audit(ctx, { actor_id: null, action: 'upgrade_rows_lost', category: 'enterprise', entity: 'schema', entity_id: String(record.schema.to), org_id: instance.org_id, detail: `${schema} under ${record.version} left this Unit Instance with fewer rows: ${lossText(instance.changes)}` });
        }
      }
      updateUpgrade(ctx.db, record.id, (r) => ({ ...r, audited: true }));
    }).immediate();
    if (record.status === 'verified') continue;
    const title = record.status === 'failed' ? `An upgrade of Vantage failed at ${record.failed?.name ?? 'a migration'}` : `The upgrade to schema ${record.schema.to} left fewer rows`;
    notifyStaff(ctx, 'platform.view', { kind: 'system', title, message: 'Review it under Unit Instance operations before relying on the data.', actionUrl: '/admin/instances', dedupeKey: `upgrade:${record.id}` });
    for (const instance of record.instances) {
      notifyOrg(ctx, instance.org_id, 'org.owners', { kind: 'system', title: 'A Vantage upgrade changed your Unit Instance’s records', message: `Some tables hold fewer rows than before the upgrade to schema ${record.schema.to}. Vantage staff have been told.`, actionUrl: '/console/operations', dedupeKey: `upgrade:${record.id}:${instance.org_id}` });
    }
  }
}

/** A Vantage Administrator says an upgrade's losses or failure were looked at, and what was found. */
export function reviewUpgrade(ctx: AppContext, user: SessionUser, id: string, note: string, ip?: string): UpgradeRecord {
  const record = upgradeHistory(ctx.db).find((r) => r.id === id);
  if (!record) throw notFound('No such upgrade.');
  if (record.status === 'verified') throw badRequest('That upgrade lost nothing; there is nothing to review.', { code: 'upgrade_verified' });
  if (record.reviewed) throw conflict('That upgrade was already reviewed.', 'upgrade_reviewed');
  const byName = `${user.first_name} ${user.last_name}`.trim() || user.username;
  let updated: UpgradeRecord | null = null;
  ctx.db.transaction(() => {
    updated = updateUpgrade(ctx.db, id, (r) => ({ ...r, reviewed: { at: now(), by: user.id, byName, note } }));
    audit(ctx, { actor_id: user.id, action: 'upgrade_reviewed', entity: 'schema', entity_id: String(record.schema.to), detail: `${record.status} upgrade of ${record.at.slice(0, 16)} (schema ${record.schema.from} to ${record.schema.to}): ${note}`, ip });
    // Each Unit Instance the upgrade left with fewer rows has the review in its own trail, beside the loss.
    for (const instance of record.instances) {
      if (!ctx.db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(instance.org_id)) continue;
      audit(ctx, { actor_id: user.id, action: 'upgrade_reviewed', category: 'enterprise', entity: 'schema', entity_id: String(record.schema.to), org_id: instance.org_id, detail: `Vantage reviewed the upgrade to schema ${record.schema.to} of ${record.at.slice(0, 16)}: ${note}`, ip });
    }
  }).immediate();
  return updated!;
}

// ——— Backups ———

/**
 * Audits each backup `npm run backup` recorded and the trail does not hold yet (ADR-0014). The script writes its record
 * with `audited: false`; this writes the entry and marks it in one transaction, so a backup is audited once.
 */
export function auditServerBackups(ctx: AppContext): number {
  const due = backupHistory(ctx.db).filter((r) => r.method === 'server' && r.audited === false);
  if (!due.length) return 0;
  ctx.db.transaction(() => {
    const keys = new Set<string>();
    // Read again inside the write lock: another process may have audited them already.
    for (const r of backupHistory(ctx.db).filter((b) => b.method === 'server' && b.audited === false)) {
      audit(ctx, { actor_id: null, action: 'backup', entity: 'database', entity_id: r.file, detail: `taken on the server with npm run backup at ${r.at}: ${r.bytes ?? 'unknown'} bytes${r.seq ? `, through audit entry ${r.seq}` : ''}${r.file ? `, as ${r.file}` : ''}` });
      keys.add(`${r.at}|${r.file}`);
    }
    markBackupsAudited(ctx.db, (r) => keys.has(`${r.at}|${r.file}`));
  }).immediate();
  return due.length;
}

// ——— Restores ———

/** One sentence on what happened to the database, ending with its full stop. */
const restoreSummary = (r: RestoreRecord) => {
  const to = r.restored.at ? `the state of ${r.restored.at.slice(0, 16).replace('T', ' ')} UTC` : 'a database with no audit entries';
  if (r.method === 'detected') {
    const found = r.finding === 'other_database' ? 'another database was put in its place' : r.finding === 'different_entry' ? 'its audit chain no longer holds the entry the service last noted' : 'it was put back to before the entry the service last noted';
    return `The database was replaced outside Vantage’s restore command: ${found}. It now holds ${to}.`;
  }
  return `The database was restored from a backup to ${to}.`;
};

/**
 * Audits each restore or replacement this database recorded and has not audited: one enterprise entry, and one in each
 * active Unit Instance's trail, since every Unit Instance on the database went back with it. Vantage staff and each Unit
 * Instance's Lead Unit Managers are told. An archive import is audited as it happens (instance_import), so its record is
 * only marked.
 */
export function auditRestores(ctx: AppContext) {
  for (const r of restoreHistory(ctx.db).filter((x) => !x.audited)) {
    if (r.method === 'archive') { ctx.db.transaction(() => markRestoreAudited(ctx.db, r.id)).immediate(); continue; }
    const detected = r.method === 'detected';
    const actor = r.by?.id && userExists(ctx, r.by.id) ? r.by.id : null;
    // A replacement found at start knows only what the lineage last noted, so what it undid is at least that much.
    const n = r.lost?.entries ?? 0;
    const lost = r.lost ? ` ${detected ? 'At least ' : ''}${n} audit ${n === 1 ? 'entry' : 'entries'} after it ${n === 1 ? 'was' : 'were'} undone${r.undone?.count ? `, ${r.undone.count} of them changes to accounts, authority or holds` : ''}.` : '';
    const who = r.method === 'script' ? ` Authorized by ${r.by?.name ?? 'an unknown administrator'} (${r.by?.username ?? 'unknown'}), run as ${r.hostUser ?? 'an unknown host account'}${r.change ? ` under ${r.change}` : ''}: ${r.reason ?? 'no reason given'}.` : '';
    const instances = activeInstances(ctx);
    ctx.db.transaction(() => {
      audit(ctx, { actor_id: actor, action: detected ? 'database_replaced' : 'database_restored', entity: 'database', entity_id: r.id, detail: `${restoreSummary(r)}${lost}${who}${r.safetyCopy ? ` The replaced database was kept as ${r.safetyCopy}.` : ''}` });
      for (const org of instances) {
        const own = r.lost?.instances?.[org.id];
        audit(ctx, { actor_id: actor, action: detected ? 'database_replaced' : 'database_restored', category: 'enterprise', entity: 'database', entity_id: r.id, org_id: org.id, detail: `${restoreSummary(r)}${own !== undefined ? ` ${own} of this Unit Instance’s audit entries after it were undone.` : r.lost ? ' None of this Unit Instance’s audit entries were undone.' : ''}${r.method === 'script' ? ` Reason: ${r.reason ?? 'none given'}.` : ''}` });
      }
      markRestoreAudited(ctx.db, r.id);
    }).immediate();
    const title = detected ? 'The Vantage database was replaced outside the restore command' : 'The Vantage database was restored from a backup';
    notifyStaff(ctx, 'platform.view', { kind: 'system', title, message: `${restoreSummary(r)}${r.undone?.count ? ` ${r.undone.count} changes to accounts, authority or holds made after it are undone; review them under Backup and restore.` : ''}`, actionUrl: '/admin/data', dedupeKey: `restore:${r.id}` });
    for (const org of instances) {
      const own = r.lost?.instances?.[org.id];
      notifyOrg(ctx, org.id, 'org.owners', { kind: 'system', title: `${org.name} went back to an earlier state`, message: `${restoreSummary(r)}${own ? ` ${own} of your Unit Instance’s audited actions after it are undone; check the roles, members and holds you changed since.` : ''}`, actionUrl: '/console/operations', dedupeKey: `restore:${r.id}:${org.id}` });
    }
    if (actor) notify(ctx, actor, { kind: 'system', title: 'The restore you authorized is in place', message: restoreSummary(r), actionUrl: '/admin/data', dedupeKey: `restore-by:${r.id}` });
  }
}

// ——— Lineage ———

const lastWritten = new WeakMap<AppContext, { key: string; at: string }>();
const keeps = (ctx: AppContext) => (ctx.config.accessMode === 'demo' ? null : ctx.config.operations.lineageFile);

/**
 * At start, before anything is written to the trail: records a database put in place outside the restore command. A
 * demo database is synthetic and is rewritten as workspaces end, so it keeps no lineage.
 */
export function detectReplacement(ctx: Pick<AppContext, 'db' | 'config'>) {
  const file = ctx.config.accessMode === 'demo' ? null : ctx.config.operations.lineageFile;
  const found = checkLineage(ctx.db, file);
  if (found) console.warn(`This database is not the one the service last ran: ${found.finding}. It is recorded, audited and Vantage staff are told.`);
  return found;
}

/** Notes the newest audit entry beside the database, when it changed since the last note. */
export function writeLineage(ctx: AppContext, { force = false } = {}) {
  const file = keeps(ctx);
  if (!file) return null;
  const point = chainPoint(ctx.db);
  const key = `${point.database_id}|${point.seq}|${point.hash}`;
  if (!force && lastWritten.get(ctx)?.key === key) return null;
  const lineage = writeLineageFile(file, point);
  lastWritten.set(ctx, { key, at: lineage.at });
  return lineage;
}

/** For the operations views: the restores this database records, newest first, and whether its lineage is kept. */
export function restoreStatus(ctx: AppContext) {
  const history = [...restoreHistory(ctx.db)].reverse();
  const subjects = [...new Set(history.flatMap((r) => (r.undone?.entries ?? []).map((e) => e.subject_id).filter((id): id is string => Boolean(id))))];
  const usernames = subjects.length
    ? Object.fromEntries((ctx.db.prepare('SELECT id, username FROM users WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(subjects)) as Array<{ id: string; username: string }>).map((u) => [u.id, u.username]))
    : {};
  return { history, lineage: { kept: Boolean(keeps(ctx)), writtenAt: lastWritten.get(ctx)?.at ?? null }, usernames };
}
