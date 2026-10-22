import type { AppContext } from '../context.ts';
import { RECORD_TABLE_NAMES } from './records.ts';
import { VERSION } from '../version.ts';
import { now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { hmac } from '../lib/crypto.ts';
import { loadRuntime } from '../runtime.ts';
import { appendRestore, chainPoint } from './restoreLog.ts';
import { dataExportProblem } from '../../shared/dataTransfer.ts';
import { writeLineage } from './recovery.ts';
import { auditAppendOnlyTriggers, dropAuditAppendOnlyTriggers, dropInstanceBoundaryTriggers, dropMembershipHistoryTriggers, dropPersonnelHistoryTriggers, foundOrganizations, instanceBoundaryTriggers, instanceBoundaryViolations, membershipHistoryTriggers, metaSet, openMissingMembershipPeriods, personnelHistoryTriggers, stampAttachmentUnits, backfillAwardRecorders, linkBilletsByTitle } from '../db/index.ts';
import { sealBacklog } from './caseSeal.ts';
import { loadChainKey, resealStoredSecrets, secretsOf } from '../lib/keys.ts';

const keyCheck = (secret: string) => hmac(secret, 'vantage-instance-key-check');

export const EXPORT_TABLES = [
  'ranks', 'users', 'readiness', 'units', 'unit_members', 'roles', 'member_roles', 'passkeys', 'recovery_codes',
  // Who belonged where, and when (ADR-0009): a moved instance keeps its people's histories.
  'unit_membership_periods',
  // Tenancy and authority (ADR-0006): who runs the platform, which organizations exist, who owns them, who looked in.
  'organizations', 'platform_roles', 'org_roles', 'access_grants',
  // Features Vantage turned off for one Unit Instance (ADR-0014): a moved service keeps what it withheld, and why.
  'instance_feature_flags',
  // Each Unit Instance's own configuration (ADR-0012): its billets, duty types and training requirements.
  'unit_billets', 'duty_types', 'training_requirements', 'duty_scoring_policies',
  // Each Marine's personnel record in each Unit Instance, and its history (ADR-0017).
  'personnel_records', 'personnel_responsibilities', 'personnel_events',
  ...RECORD_TABLE_NAMES,
  'source_files', 'import_jobs', 'work_items', 'work_actions', 'work_events', 'work_event_seals', 'work_event_heads', 'work_views',
  // A person's own drafts and career plan move with the instance too.
  'record_drafts', 'career_steps', 'career_profiles',
  // Where an entry was moved from, and what it said (ADR-0015): an undo still works on the host it moves to.
  'record_lineage',
  // Report Studio: a draft and every revision it has been saved as.
  'report_drafts', 'report_revisions',
  'contacts', 'connectors', 'threads', 'thread_messages', 'thread_links',
  'attachments', 'comments', 'unit_invites', 'unit_invite_uses', 'support_tickets', 'support_messages',
  'personnel_roster', 'personnel_sync_runs',
  // Holds and schedules decide what may be destroyed; a moved instance that forgot them would destroy what is held.
  'legal_holds', 'retention_schedules', 'disposition_runs',
  'audit_log', 'notifications', 'maradmins', 'maradmin_user_state', 'ai_usage_daily', 'product_events', 'email_log', 'meta',
] as const;

/**
 * meta keys that describe this database and host rather than the service's data: its schema, the migrations and releases
 * that ran on it and how far its migrations are audited (ADR-0013), and the backups taken of it (ADR-0011). An import keeps this host's, so Operations does not report
 * the old host's history, a backup this database never had, or a schema the archive's build ran.
 */
const HOST_META = [
  'schema_version', 'migration_history', 'migration_history_since', 'migration_audited_through', 'release_history', 'backup_history', 'last_backup_at',
  // Which database this is, and what was upgraded, restored and backed up on it (ADR-0014).
  'database_id', 'upgrade_history', 'restore_history',
] as const;

/**
 * Tables left out of the archive on purpose: sign-ins, links, queued mail and support's approvals to change an account's
 * sign-in, which belong to the old host. Each approval and its use is in the audit trail, which moves.
 */
export const NOT_EXPORTED = ['sessions', 'tokens', 'email_queue', 'connector_auth_states', 'oidc_states', 'demo_workspaces', 'credential_approvals'] as const;

export function exportInstance(ctx: AppContext) {
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const rows = ctx.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    tables[table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = Buffer.isBuffer(v) ? { $bytes: v.toString('base64') } : v;
      return out;
    });
  }
  return { format: 'vantage-instance/1', version: VERSION, exported_at: now(), key_check: keyCheck(ctx.config.secret), tables };
}

export function importInstance(ctx: AppContext, archive: { format?: string; key_check?: string; tables?: Record<string, Array<Record<string, unknown>>> }, actorId: string) {
  // A data export is not a backup, and says so rather than failing as an unknown file (ADR-0014).
  const notBackup = dataExportProblem(archive);
  if (notBackup) throw new Error(notBackup);
  if (archive?.format !== 'vantage-instance/1' || !archive.tables) throw new Error('That file is not a Vantage instance archive.');
  if (archive.key_check && !secretsOf(ctx.config).some((secret) => keyCheck(secret) === archive.key_check)) throw new Error('This archive was exported under a different VANTAGE_SECRET. Set the same secret on this host before importing, or authenticator secrets and the audit chain will not verify.');
  const users = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const activities = (ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n;
  if (users > 1 || activities > 0) throw new Error('Import only into a fresh instance (one operator account, no records).');
  // Read now: the archive replaces this host's accounts, and the importer's may not be among the ones it brings.
  const importer = ctx.db.prepare('SELECT username, first_name, last_name FROM users WHERE id = ?').get(actorId) as { username: string; first_name: string; last_name: string } | undefined;
  const replaced = chainPoint(ctx.db);
  const counts: Record<string, number> = {};
  // An archive from before organizations has none: its governance rows go to the oldest top unit's organization, the
  // same rule the migration follows, and its units found their organizations once they are in.
  const legacy = !archive.tables.organizations;
  const firstRoot = legacy
    ? ((archive.tables.units || []).filter((u) => !u.parent_id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]?.id as string | undefined) ?? null
    : null;
  const ORG_OWNED = new Set(['personnel_roster', 'retention_schedules', 'legal_holds', 'disposition_runs', 'personnel_sync_runs']);
  // Files attached before they kept a unit get the one their record sits in, as migration 017 gives a live database's.
  const unstamped = (archive.tables.attachments || []).some((a) => !('unit_id' in a));
  // An archive from before 023 names nobody as an award's recorder; its create entries do, as the migration reads them.
  const unrecorded = (archive.tables.awards || []).some((a) => !('recorded_by' in a));
  // An archive from before 024 links no membership to its billet; the titles do, as the migration reads them.
  const unlinked = (archive.tables.unit_members || []).some((m) => !('billet_id' in m));
  let crossings: Record<string, number> = {};
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.transaction(() => {
      // The boundary's triggers are lifted while the archive loads table by table, and put back before it commits. So are
      // the membership history's: the archive brings its own history, and loading its memberships is not anybody joining.
      dropInstanceBoundaryTriggers(ctx.db);
      dropMembershipHistoryTriggers(ctx.db);
      dropPersonnelHistoryTriggers(ctx.db);
      // The audit log is append-only (ADR-0013). Only here, loading a fresh instance, is it emptied: the archive brings
      // its own chain in place of this host's first-run entries. Its triggers are back before this commits.
      dropAuditAppendOnlyTriggers(ctx.db);
      const hostMeta = ctx.db.prepare(`SELECT key, value FROM meta WHERE key IN (${HOST_META.map(() => '?').join(',')})`).all(...HOST_META) as Array<{ key: string; value: string }>;
      for (const table of [...NOT_EXPORTED, ...[...EXPORT_TABLES].reverse()]) ctx.db.prepare(`DELETE FROM ${table}`).run();
      for (const table of EXPORT_TABLES) {
        const rows = archive.tables![table] || [];
        if (!rows.length) { counts[table] = 0; continue; }
        const columns = (ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        const insert = ctx.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) {
          insert.run(...columns.map((c) => {
            const v = row[c];
            if (v && typeof v === 'object' && '$bytes' in (v as object)) return Buffer.from(String((v as { $bytes: string }).$bytes), 'base64');
            if (legacy && c === 'org_id' && v == null && ORG_OWNED.has(table)) return firstRoot;
            return v === undefined ? null : v;
          }));
        }
        counts[table] = rows.length;
      }
      ctx.db.prepare(`DELETE FROM meta WHERE key IN (${HOST_META.map(() => '?').join(',')})`).run(...HOST_META);
      for (const { key, value } of hostMeta) metaSet(ctx.db, key, value);
      if (legacy) foundOrganizations(ctx.db);
      if (unstamped) stampAttachmentUnits(ctx.db);
      if (unrecorded) backfillAwardRecorders(ctx.db);
      if (unlinked) linkBilletsByTitle(ctx.db);
      // An archive from before the history opens a period for each membership it holds, as migration 018 does.
      openMissingMembershipPeriods(ctx.db);
      membershipHistoryTriggers(ctx.db);
      personnelHistoryTriggers(ctx.db);
      // Rows the archive brings already joined across the boundary are kept and counted, as migration 016 keeps a live
      // database's: a backup restores as the instance it came from was kept, and nothing new crosses from here (ADR-0008).
      crossings = instanceBoundaryViolations(ctx.db);
      if (Object.keys(crossings).length) metaSet(ctx.db, 'instance_boundary_violations', JSON.stringify({ at: now(), found: crossings }));
      else ctx.db.prepare("DELETE FROM meta WHERE key = 'instance_boundary_violations'").run();
      instanceBoundaryTriggers(ctx.db);
      auditAppendOnlyTriggers(ctx.db);
      const violations = ctx.db.pragma('foreign_key_check') as unknown[];
      if (violations.length) throw new Error(`Archive has ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 3))}`);
    })();
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }
  Object.assign(ctx.runtime, loadRuntime(ctx.db, ctx.config));
  // The archive brought its own chain key (or, from before there was one, chains signed with the secret itself).
  ctx.chainKey = loadChainKey(ctx.db, ctx.config);
  resealStoredSecrets(ctx.db, ctx.config);
  // An archive from before sealing brings histories without seals. Seal them now, so that from here on a history
  // without seals can only mean its seals were removed.
  sealBacklog(ctx);
  metaSet(ctx.db, 'case_seals_backfilled', now());
  const crossed = Object.keys(crossings).length ? `; joined across Unit Instances: ${JSON.stringify(crossings)}` : '';
  // The importer is the actor when the archive holds their account. When it does not, the entry names them instead, so
  // the restore is still attributed to a person and not to an id nothing in the chain resolves.
  const kept = Boolean(ctx.db.prepare('SELECT 1 FROM users WHERE id = ?').get(actorId));
  const by = `by ${importer?.username ?? 'an account no longer here'} (${actorId})${kept ? '' : ', whose account the archive does not hold'}`;
  audit(ctx, { actor_id: kept ? actorId : null, action: 'instance_import', entity: 'instance', detail: `${by}${crossed}; ${JSON.stringify(counts)}`.slice(0, 900) });
  // Loading an archive is a restore (ADR-0014): it is in the restore history, audited above, and the lineage beside the
  // database is noted afresh, so the next start does not take the archive's chain for a database replaced behind its back.
  appendRestore(ctx.db, {
    method: 'archive', by: importer ? { id: kept ? actorId : null, username: importer.username, name: `${importer.first_name} ${importer.last_name}`.trim() || importer.username } : null,
    hostUser: null, reason: null, change: null, restored: { ...chainPoint(ctx.db), file: null, bytes: null }, replaced,
    sameDatabase: null, lost: null, undone: null, safetyCopy: null, audited: true,
  });
  writeLineage(ctx, { force: true });
  return counts;
}
