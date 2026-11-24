import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, renameSync, chmodSync, rmSync, writeFileSync, openSync, closeSync, fchmodSync, readSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANKS } from './ranks.ts';
import { compareCounts, recordUpgrade, rowCounts, upgradeHistory, upgradeStatus, type UpgradeRecord } from './upgrades.ts';
import { copyBeforeUpgrade, databaseState, sameState, type UpgradeCopy, type UpgradeCopyOptions } from './copies.ts';
import { VERSION } from '../version.ts';
import { TIMEFRAMES, timeframeColumns, type TimeframedTable, type TimeframeSpec } from '../../shared/timeframe.ts';
import { REDACTED } from '../../shared/constants.ts';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, 'schema.sql'), 'utf8');

/**
 * A schema migration. `reshapes` names tables whose row counts it changes on purpose, so upgrade verification records a
 * fall in one as intended rather than as a loss (ADR-0014).
 */
export interface Migration { id: number; name: string; run: (db: Db) => void; reshapes?: readonly string[] }

/** Ordered migrations applied after the base schema. Keep each idempotent. */
const MIGRATIONS: Migration[] = [
  { id: 1, name: '001_initial', run: () => {} },
  { id: 2, name: '002_work_intake', run: () => {} },
  {
    id: 3,
    name: '003_typed_goals',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(goals)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        ['metric_id', 'TEXT'],
        ['direction', "TEXT NOT NULL DEFAULT 'increase'"],
        ['baseline_value', 'REAL'],
        ['aggregation', "TEXT NOT NULL DEFAULT 'sum'"],
        ['filters', "TEXT NOT NULL DEFAULT '{}'"],
        ['measure_scope', "TEXT NOT NULL DEFAULT 'subject'"],
        ['completed_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE goals ADD COLUMN ${name} ${type}`);
    },
  },
  // Correspondence tables come from schema.sql, which is safe to replay.
  { id: 4, name: '004_correspondence', run: () => {} },
  // The product_events table comes from schema.sql, which is safe to replay.
  { id: 5, name: '005_product_events', run: () => {} },
  {
    id: 6,
    name: '006_authoritative_identity',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        ['edipi', 'TEXT'],
        ['identity_source', "TEXT NOT NULL DEFAULT 'local'"],
        ['identity_synced_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_edipi ON users(edipi) WHERE edipi IS NOT NULL');
    },
  },
  {
    id: 7,
    name: '007_work_coherence',
    run: (db) => {
      const work = new Set((db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!work.has('project_id')) db.exec('ALTER TABLE work_items ADD COLUMN project_id TEXT REFERENCES projects(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, state)');

      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id)');

      const CLAIM_WORK = 1 << 13, EDIT_WORK = 1 << 14, RESOLVE_WORK = 1 << 15, REASSIGN_WORK = 1 << 16;
      const MANAGE_RECORDS = 1 << 3;
      db.prepare('UPDATE roles SET permissions = permissions | ? WHERE permissions > 0').run(CLAIM_WORK | RESOLVE_WORK);
      db.prepare('UPDATE roles SET permissions = permissions | ? WHERE permissions & ? != 0')
        .run(EDIT_WORK | REASSIGN_WORK, MANAGE_RECORDS);
    },
  },
  {
    id: 8,
    name: '008_case_history',
    run: (db) => {
      const work = new Set((db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name));
      const workColumns: Array<[string, string]> = [
        ['stage', 'TEXT'],
        ['waiting_category', 'TEXT'],
        ['waiting_since', 'TEXT'],
        ['blocked_reason', 'TEXT'],
        ['procedure_key', 'TEXT'],
        ['procedure_version', 'TEXT'],
      ];
      for (const [name, type] of workColumns) if (!work.has(name)) db.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
      db.exec(`UPDATE work_items SET stage = CASE state
                 WHEN 'open' THEN 'not_started' WHEN 'in_progress' THEN 'researching' WHEN 'waiting' THEN 'waiting'
                 WHEN 'resolved' THEN 'resolved' WHEN 'not_applicable' THEN 'not_applicable' ELSE 'not_started' END
               WHERE stage IS NULL`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_stage ON work_items(unit_id, stage)');

      db.exec(`INSERT OR IGNORE INTO work_events (id, work_item_id, unit_id, actor_id, kind, body, idempotency_key, occurred_at, created_at)
               SELECT 'backfill-action-' || a.id, a.work_item_id, a.unit_id, a.user_id, 'action_recorded',
                      json_object('action_id', a.id, 'action', a.kind, 'text', a.note, 'quantity', a.quantity, 'unit_label', a.unit_label,
                                  'drafted_record', a.activity_id IS NOT NULL, 'backfilled', 1),
                      'backfill:action:' || a.id, a.occurred_at || 'T12:00:00.000Z', a.created_at
                 FROM work_actions a`);
      db.exec(`INSERT OR IGNORE INTO work_events (id, work_item_id, unit_id, actor_id, kind, body, idempotency_key, occurred_at, created_at)
               SELECT 'backfill-claim-' || w.id, w.id, w.unit_id, w.claimed_by, 'claimed', json_object('backfilled', 1),
                      'backfill:claim:' || w.id, w.claimed_at, w.claimed_at
                 FROM work_items w WHERE w.claimed_by IS NOT NULL AND w.claimed_at IS NOT NULL AND w.deleted_at IS NULL`);

      const users = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!users.has('demo_workspace_id')) db.exec('ALTER TABLE users ADD COLUMN demo_workspace_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_demo_workspace ON users(demo_workspace_id) WHERE demo_workspace_id IS NOT NULL');
    },
  },
  {
    id: 9,
    name: '009_mailbox_authorization',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(connectors)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        ['access_token_enc', 'TEXT'], ['refresh_token_enc', 'TEXT'], ['token_expires_at', 'TEXT'],
        ['account_id', 'TEXT'], ['account_address', 'TEXT'], ['tenant_id', 'TEXT'], ['authorized_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE connectors ADD COLUMN ${name} ${type}`);
    },
  },
  {
    id: 10,
    name: '010_totp_replay',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!existing.has('totp_pending')) db.exec('ALTER TABLE users ADD COLUMN totp_pending TEXT');
      if (!existing.has('totp_last_step')) db.exec('ALTER TABLE users ADD COLUMN totp_last_step INTEGER');
    },
  },
  {
    id: 11,
    name: '011_marforres_primary_membership',
    run: (db) => {
      const command = db.prepare(`
        SELECT id, owner_user_id
          FROM units
         WHERE active = 1
           AND parent_id IS NULL
           AND (
             lower(COALESCE(short_name, '')) = 'marforres'
             OR lower(COALESCE(code, '')) = 'marforres'
             OR lower(name) = 'marine forces reserve'
           )
         ORDER BY CASE WHEN lower(COALESCE(short_name, '')) = 'marforres' THEN 0 ELSE 1 END, created_at
         LIMIT 1
      `).get() as { id: string; owner_user_id: string | null } | undefined;
      if (!command) return;

      const at = new Date().toISOString();
      const defaultRole = db.prepare('SELECT id FROM roles WHERE unit_id = ? AND is_default = 1 LIMIT 1').get(command.id) as { id: string } | undefined;
      const people = db.prepare('SELECT id FROM users WHERE active = 1').all() as Array<{ id: string }>;

      for (const person of people) {
        const hasMembership = db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? LIMIT 1').get(person.id);
        if (!hasMembership) continue;

        db.prepare(`
          INSERT INTO unit_members (user_id, unit_id, is_primary, billet, joined_at, invited_by)
          VALUES (?, ?, 0, NULL, ?, ?)
          ON CONFLICT(user_id, unit_id) DO NOTHING
        `).run(person.id, command.id, at, command.owner_user_id);

        db.prepare('UPDATE unit_members SET is_primary = CASE WHEN unit_id = ? THEN 1 ELSE 0 END WHERE user_id = ?')
          .run(command.id, person.id);

        if (defaultRole) {
          db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(person.id, defaultRole.id, command.id, command.owner_user_id, at);
        }
      }
    },
  },
  // The email_queue table comes from schema.sql, which is safe to replay.
  { id: 12, name: '012_email_queue', run: () => {} },
  {
    id: 13,
    name: '013_lockout_and_timezone',
    run: (db) => {
      // Failed sign-ins are counted in the database, so a lockout outlasts a restart and holds across processes.
      // A person's own timezone decides their "today" and what is overdue for them.
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [['failed_sign_ins', 'INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'TEXT'], ['timezone', 'TEXT']];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    },
  },
  {
    id: 14,
    name: '014_organization_sign_in',
    run: (db) => {
      // The identity an account is linked to at the organization's provider: issuer and subject, never reassigned.
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      for (const name of ['oidc_issuer', 'oidc_subject']) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL');
    },
  },
  {
    id: 15,
    name: '015_organizations',
    run: migrateToOrganizations,
  },
  {
    id: 16,
    name: '016_unit_instance_isolation',
    run: (db) => {
      instanceBoundaryTriggers(db);
      // Rows joined across the boundary before it was kept stay as they are, so nothing is lost, and are counted, so an
      // operator can find them (ADR-0008). Their owners can still edit them; only a new crossing is refused.
      const found = instanceBoundaryViolations(db);
      if (Object.keys(found).length) metaSet(db, 'instance_boundary_violations', JSON.stringify({ at: new Date().toISOString(), found }));
    },
  },
  {
    id: 17,
    name: '017_attachment_unit',
    run: (db) => {
      // A file keeps the unit its record sat in when it was added, as a comment does, so a move across the boundary is
      // judged by where the file was added and not by where its uploader serves now (ADR-0008).
      if (!columnsOf(db, 'attachments').has('unit_id')) db.exec('ALTER TABLE attachments ADD COLUMN unit_id TEXT REFERENCES units(id)');
      stampAttachmentUnits(db);
    },
  },
  {
    id: 18,
    name: '018_identity_and_membership_history',
    run: (db) => {
      // When the account's EDIPI was last proven by its card (ADR-0009). Accounts whose card already signed in under the
      // EDIPI they carry now are proven from the audit log; any other EDIPI was typed in by someone and stays unproven.
      const users = columnsOf(db, 'users');
      if (!users.has('edipi_verified_at')) db.exec('ALTER TABLE users ADD COLUMN edipi_verified_at TEXT');
      if (users.has('edipi')) db.exec(`UPDATE users SET edipi_verified_at = (
          SELECT MAX(a.at) FROM audit_log a WHERE a.actor_id = users.id AND a.action IN ('cac_verified', 'cac_provisioned')
             AND (a.detail = 'edipi=' || users.edipi OR a.detail LIKE 'edipi=' || users.edipi || ' %'))
        WHERE edipi IS NOT NULL AND edipi_verified_at IS NULL`);
      // The table comes from schema.sql. Memberships held before it existed open their first period at the joined date.
      membershipHistoryTriggers(db);
      openMissingMembershipPeriods(db);
    },
  },
  {
    id: 19,
    name: '019_audit_action_index',
    // The Vantage Administrator console counts sign-ins and refusals by action over a day, and filters the trail by
    // action (ADR-0011): without this, each of those reads the whole audit log.
    run: (db) => db.exec('CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at)'),
  },
  {
    id: 20,
    name: '020_unit_configuration',
    // A Unit Instance's billets, duty types and training requirements (ADR-0012). The tables come from schema.sql; this
    // keeps them inside the boundary on a database that ran 016 before they existed.
    run: (db) => instanceBoundaryTriggers(db),
  },
  {
    id: 21,
    name: '021_audit_categories_and_append_only',
    // Each audit entry seals its category, and the log is append-only from here (ADR-0013). Entries already written are
    // left as they are, with no category: their hashes never sealed one, so a read takes it from the catalogue. The
    // credential_approvals table comes from schema.sql; email_log gains the Unit Instance a message was sent for.
    run: (db) => {
      if (!columnsOf(db, 'audit_log').has('category')) {
        db.exec("ALTER TABLE audit_log ADD COLUMN category TEXT CHECK (category IS NULL OR category IN ('user', 'unit', 'enterprise'))");
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category, seq)');
      auditAppendOnlyTriggers(db);
      // Mail names the Unit Instance it was sent for, so a unit's support queue sees only its own; older mail names none.
      if (!columnsOf(db, 'email_log').has('org_id')) db.exec('ALTER TABLE email_log ADD COLUMN org_id TEXT');
    },
  },
  {
    id: 22,
    name: '022_instance_operations',
    // Features a Vantage Administrator has turned off for one Unit Instance (ADR-0014). The table comes from schema.sql;
    // the upgrade, backup and restore records it is tracked by live in meta.
    run: () => {},
  },
  {
    id: 23,
    name: '023_record_lineage',
    // Each record type keeps its own records, and an entry its owner moves between them keeps its lineage (ADR-0015). The
    // lineage table comes from schema.sql. An award keeps who entered it, so a leader's recommendation is no longer its
    // subject's to change. Nothing already in Activities moves: each owner moves what they choose
    // (ADR-0015), so no row is removed and the migration declares nothing it reshapes.
    run: (db) => {
      if (!columnsOf(db, 'awards').has('recorded_by')) db.exec('ALTER TABLE awards ADD COLUMN recorded_by TEXT REFERENCES users(id)');
      if (!columnsOf(db, 'activities').has('kind_confirmed_at')) db.exec('ALTER TABLE activities ADD COLUMN kind_confirmed_at TEXT');
      backfillAwardRecorders(db);
    },
  },
  {
    id: 24,
    name: '024_personnel_records',
    // Personnel as a structured record (ADR-0017). The supervisor, check-in, responsibility and history tables come from
    // schema.sql; a membership gains the catalogue billet it fills and its assignment dates. A membership whose billet
    // reads as exactly one active billet of its Unit Instance is linked to it; any other keeps its title and no link.
    // Triggers write the history from here, and the boundary keeps a billet, a responsibility and a supervisor inside the
    // Unit Instance. No row is removed or reshaped.
    run: (db) => {
      const members = columnsOf(db, 'unit_members');
      if (!members.has('billet_id')) db.exec('ALTER TABLE unit_members ADD COLUMN billet_id TEXT REFERENCES unit_billets(id)');
      if (!members.has('assignment_start')) db.exec('ALTER TABLE unit_members ADD COLUMN assignment_start TEXT');
      if (!members.has('assignment_end')) db.exec('ALTER TABLE unit_members ADD COLUMN assignment_end TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_unit_members_billet ON unit_members(billet_id) WHERE billet_id IS NOT NULL');
      linkBilletsByTitle(db);
      personnelHistoryTriggers(db);
      instanceBoundaryTriggers(db);
    },
  },
  {
    id: 25,
    name: '025_personnel_guards',
    // Two gaps in 024 (ADR-0017): a membership created with its assignment dates already set now leaves them in the
    // history, as a later change to them does, and a billet is not narrowed to one unit while a Marine in another unit
    // holds it. Nothing already written is changed; a billet that already disagrees with a holder is left for its Unit
    // Managers to reassign.
    run: (db) => {
      personnelHistoryTriggers(db);
      billetHolderTriggers(db);
    },
  },
  {
    id: 26,
    name: '026_record_timeframes',
    // Records take a timeframe (ADR-0018). Activities and training gain an end date, a time of day at each end and
    // "ongoing"; their date stays the first day, so every entry already written reads as the single day it was. An award
    // gains the start of the period it recognizes; its date stays the period's end. Triggers refuse a timeframe that ends
    // before it starts on every record type that has one. No row is removed or reshaped: a row already out of order (a
    // goal whose deadline was entered before its start) is kept, counted for the Vantage Administrator console, and asked
    // to be put in order only when its dates are next changed.
    run: (db) => {
      for (const table of ['activities', 'trainings'] as const) {
        const have = columnsOf(db, table);
        if (!have.has('end_date')) db.exec(`ALTER TABLE ${table} ADD COLUMN end_date TEXT`);
        for (const column of ['start_time', 'end_time']) if (!have.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT CHECK (${timeOfDayCheck(column)})`);
        if (!have.has('ongoing')) db.exec(`ALTER TABLE ${table} ADD COLUMN ongoing INTEGER NOT NULL DEFAULT 0 CHECK (ongoing IN (0, 1))`);
      }
      if (!columnsOf(db, 'awards').has('period_start')) db.exec('ALTER TABLE awards ADD COLUMN period_start TEXT');
      timeframeTriggers(db);
      const found = timeframeViolations(db);
      if (Object.keys(found).length) metaSet(db, 'timeframe_violations', JSON.stringify({ at: new Date().toISOString(), found }));
    },
  },
  {
    id: 27,
    name: '027_record_imports',
    // A person imports their own records back, each into its own record type, staged first and undoable (ADR-0019). The
    // two tables come from schema.sql, which is safe to replay. Nothing already written is read, moved or reshaped.
    run: () => {},
  },
  {
    id: 28,
    name: '028_report_definitions',
    // Saved reports (ADR-0020): a report's choices kept under a name, never its data. The table comes from schema.sql,
    // which is safe to replay. Nothing already written is read, moved or reshaped.
    run: () => {},
  },
  {
    id: 29,
    name: '029_error_report_snapshots',
    // Financial error reports filed and compared (ADR-0021). The tables, and the triggers that keep a filed report as it
    // was filed, come from schema.sql, which is safe to replay; the boundary keeps a report, its type and its file in one
    // Unit Instance. Nothing already written is read, moved or reshaped: the queue's cases stay as they are.
    run: (db) => instanceBoundaryTriggers(db),
  },
  {
    id: 30,
    name: '030_case_guidance',
    // Guidance on file for the case diagnoser (ADR-0022): command SOPs, validated SME workflows, validated past cases and,
    // service-wide, cited official policy and system guidance. The table and the triggers that keep an entry as it was put
    // on file come from schema.sql, which is safe to replay; the boundary keeps a validated case and its entry in one Unit
    // Instance. Nothing already written is read, moved or reshaped: a diagnosis is derived on read, never stored.
    run: (db) => instanceBoundaryTriggers(db),
  },
  {
    id: 31,
    name: '031_duty_records',
    // Duty as a record of its own (ADR-0023). The duties table comes from schema.sql, which is safe to replay; the
    // boundary keeps a duty, its type and its scoring version in one Unit Instance, and its start and end are kept in
    // order as every record's are (ADR-0018). The move history widens to name duty, so an activity that was a duty can be
    // moved to it by its owner and back. Nothing already written moves: an activity logged as duty stays one until its
    // owner moves it (ADR-0015), so the migration declares nothing it reshapes.
    run: (db) => {
      widenRecordLineage(db);
      instanceBoundaryTriggers(db);
      timeframeTriggers(db);
    },
  },
  {
    id: 32,
    name: '032_duty_review',
    // Duty is reviewed (ADR-0024). A duty gains who set its approved points apart from the calculated ones, when
    // and why; a database that had the duties table before these columns gets them here, with the check schema.sql gives a
    // new one. Its review history (duty_reviews) comes from schema.sql, which is safe to replay, and the boundary keeps a
    // review in its duty's Unit Instance. The standard SNCO and SNCOIC roles of every unit gain the review permissions the
    // role template now gives them, so duty already waiting has reviewers: a role a unit made itself is left as it is, one
    // it cut back gains nothing it was cut back from, and no role gains the permission to approve one's own duty. No row
    // is removed or reshaped, and no duty's status, points or scoring version is touched: nothing is recalculated.
    run: (db) => {
      const have = columnsOf(db, 'duties');
      if (!have.has('points_override_reason')) db.exec('ALTER TABLE duties ADD COLUMN points_override_reason TEXT');
      if (!have.has('points_overridden_by')) db.exec('ALTER TABLE duties ADD COLUMN points_overridden_by TEXT REFERENCES users(id)');
      if (!have.has('points_overridden_at')) db.exec(`ALTER TABLE duties ADD COLUMN points_overridden_at TEXT CHECK ((points_overridden_at IS NULL) = (points_overridden_by IS NULL) AND (points_overridden_at IS NULL) = (points_override_reason IS NULL) AND (points_overridden_at IS NULL OR approval_status = 'approved'))`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_duties_review ON duties(unit_id, approval_status, submitted_at)');
      grantDutyReviewToStandardRoles(db);
      instanceBoundaryTriggers(db);
    },
  },
  {
    id: 33,
    name: '033_attachment_evidence',
    // Training evidence (ADR-0025). A file gains what it is evidence of (a certificate, a transcript, a
    // completion or qualification document, a roster) and a line on what it shows. A database that had the attachments
    // table before these columns gets them here, with the checks schema.sql gives a new one. Both are empty on every
    // file already attached: nothing is guessed from a filename, no row is removed or reshaped, and no file's content,
    // hash, uploader, unit or date is touched. The check on the type is not tied to the record type, because a file
    // follows an entry that moves to another record type and comes back with it (ADR-0015).
    run: (db) => {
      const have = columnsOf(db, 'attachments');
      if (!have.has('kind')) db.exec(`ALTER TABLE attachments ADD COLUMN kind TEXT CHECK (kind IS NULL OR kind IN ('certificate', 'transcript', 'completion', 'qualification', 'roster', 'other'))`);
      if (!have.has('description')) db.exec('ALTER TABLE attachments ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 500)');
    },
  },
  // The new ephemeral challenge table and its index are created idempotently by schema.sql. No existing rows change.
  { id: 34, name: '034_durable_passkey_challenges', run: () => {} },
  {
    id: 35,
    name: '035_counseling_workflow',
    // Counseling as structured data (ADR-0027). A counseling gains where it stands (a draft, shared with its
    // Marine for review, or final), which text it is (its revision), who finalized it and when, and the particulars its
    // worksheet prints as they stood then. A database that had the counselings table before these columns gets them here,
    // with the checks schema.sql gives a new one. Every counseling already written is final at revision 1, as it read to
    // its Marine the moment it was written, with no finalization stamp or particulars, because nothing recorded them: its
    // worksheet says so. No row is removed or reshaped, and no counseling's text, people, unit or acknowledgement is
    // touched. Its amendment history (counseling_revisions) comes from schema.sql, which is safe to replay, and the
    // boundary keeps an amendment in its counseling's Unit Instance.
    run: (db) => {
      const have = columnsOf(db, 'counselings');
      if (!have.has('stage')) db.exec(`ALTER TABLE counselings ADD COLUMN stage TEXT NOT NULL DEFAULT 'final' CHECK (stage IN ('draft', 'review', 'final'))`);
      if (!have.has('revision')) db.exec('ALTER TABLE counselings ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)');
      if (!have.has('finalized_at')) db.exec('ALTER TABLE counselings ADD COLUMN finalized_at TEXT');
      if (!have.has('finalized_by')) db.exec('ALTER TABLE counselings ADD COLUMN finalized_by TEXT REFERENCES users(id)');
      if (!have.has('particulars')) db.exec('ALTER TABLE counselings ADD COLUMN particulars TEXT');
      // One a retention schedule already anonymized stays done: its new particulars are redacted as its words are, so the
      // next run neither counts it again nor stamps it as disposed of that day.
      db.prepare(`UPDATE counselings SET particulars = ? WHERE particulars IS NULL AND summary IS ? AND strengths IS ? AND improvements IS ? AND goals_set IS ? AND counselor_name IS ?`)
        .run(REDACTED, REDACTED, REDACTED, REDACTED, REDACTED, REDACTED);
      db.exec('CREATE INDEX IF NOT EXISTS idx_counselings_stage ON counselings(counselor_id, stage)');
      instanceBoundaryTriggers(db);
    },
  },
  {
    id: 36,
    name: '036_course_lookup',
    // Course lookup (ADR-0029). A training gains the course code its person enters and the CEUs it earned, and
    // what of it an approved source's catalog verified: the entry it was checked against, which values matched and when.
    // A database that had the trainings table before these columns gets them here, with the checks schema.sql gives a new
    // one, last and in its order. Every training already written has no course code and nothing verified: its values are
    // what its person typed, and nothing is guessed from a title. The approved sources, their catalogs and their entries
    // come from schema.sql, which is safe to replay; they are the service's, not a Unit Instance's, so no boundary trigger
    // is needed. No row is removed or reshaped.
    run: (db) => {
      const have = columnsOf(db, 'trainings');
      if (!have.has('course_code')) db.exec('ALTER TABLE trainings ADD COLUMN course_code TEXT CHECK (course_code IS NULL OR length(course_code) BETWEEN 1 AND 40)');
      if (!have.has('ceus')) db.exec('ALTER TABLE trainings ADD COLUMN ceus REAL CHECK (ceus IS NULL OR (ceus >= 0 AND ceus <= 1000))');
      if (!have.has('course_entry_id')) db.exec('ALTER TABLE trainings ADD COLUMN course_entry_id TEXT REFERENCES course_catalog_entries(id)');
      if (!have.has('course_verified')) db.exec(`ALTER TABLE trainings ADD COLUMN course_verified TEXT CHECK (course_verified IS NULL OR (json_valid(course_verified) AND json_type(course_verified) = 'array'))`);
      if (!have.has('course_verified_at')) db.exec('ALTER TABLE trainings ADD COLUMN course_verified_at TEXT CHECK ((course_verified_at IS NULL) = (course_entry_id IS NULL) AND (course_verified_at IS NULL) = (course_verified IS NULL))');
      // A staged catalog that is discarded removes its entries; the index keeps that from reading every training.
      db.exec('CREATE INDEX IF NOT EXISTS idx_trainings_course_entry ON trainings(course_entry_id)');
    },
  },
  // Drafts (ADR-0030). A form its author saves to finish later, a goal, an award, a training entry, a task or a
  // change to a Marine's assignment, is kept in form_drafts until it is sent through its kind's own route, discarded or
  // left 90 days. The table and its indexes come from schema.sql, which is safe to replay. Every other draft stays where it
  // always was: a counseling's stage, a report package with no revision, correspondence not sent, an entry from work not
  // kept. A draft about a Marine names its unit, checked when it is saved; no boundary trigger, as with report_drafts
  // (ADR-0008). No row is removed or reshaped.
  { id: 37, name: '037_form_drafts', run: () => {} },
  {
    id: 38,
    name: '038_workflow_messages',
    // Workflow messaging (ADR-0031). A comment gains its kind (a comment, a question or a review request to one
    // named person, the answer to one, an assignment's note), whom a request is for, where it stands, the request an
    // answer is to, who closed a request and when, and whether it was said on a counseling before it was final. A notice
    // gains its Unit Instance, the record or work case it is about, who acted, and how many events one unread notice
    // stands for. A database that had these tables before the columns gets them here, with the checks schema.sql gives a
    // new one, last and in order. Every comment already written is a comment; one said on a counseling before it was
    // final becomes private to its counselor and its Marine, as it was when it was said. Every notice already sent that
    // links to a record is given that record, so it is checked again when read; the words old notices quoted from a
    // comment, a hand-off, a task, a help request, or a reason or note about Vantage access or a sign-in change are
    // cleared, because a notice carries nobody's words. No row is removed.
    run: (db) => {
      const comments = columnsOf(db, 'comments');
      if (!comments.has('kind')) db.exec(`ALTER TABLE comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'review_request', 'clarification_request', 'answer', 'assignment_note'))`);
      if (!comments.has('addressee_id')) db.exec('ALTER TABLE comments ADD COLUMN addressee_id TEXT REFERENCES users(id)');
      if (!comments.has('state')) db.exec(`ALTER TABLE comments ADD COLUMN state TEXT CHECK ((state IS NULL) = (kind NOT IN ('review_request', 'clarification_request'))
                      AND (state IS NULL OR state IN ('open', 'answered', 'looks_right', 'needs_changes', 'withdrawn', 'closed'))
                      AND (kind NOT IN ('review_request', 'clarification_request') OR addressee_id IS NOT NULL))`);
      if (!comments.has('reply_to')) db.exec(`ALTER TABLE comments ADD COLUMN reply_to TEXT CHECK ((reply_to IS NULL) = (kind <> 'answer'))`);
      if (!comments.has('closed_by')) db.exec('ALTER TABLE comments ADD COLUMN closed_by TEXT REFERENCES users(id)');
      if (!comments.has('closed_at')) db.exec(`ALTER TABLE comments ADD COLUMN closed_at TEXT CHECK ((closed_at IS NULL) = (state IS NULL OR state = 'open'))`);
      if (!comments.has('private')) db.exec('ALTER TABLE comments ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1))');
      const notices = columnsOf(db, 'notifications');
      if (!notices.has('org_id')) db.exec('ALTER TABLE notifications ADD COLUMN org_id TEXT');
      if (!notices.has('entity')) db.exec('ALTER TABLE notifications ADD COLUMN entity TEXT');
      if (!notices.has('entity_id')) db.exec('ALTER TABLE notifications ADD COLUMN entity_id TEXT CHECK ((entity IS NULL) = (entity_id IS NULL))');
      if (!notices.has('actor_id')) db.exec('ALTER TABLE notifications ADD COLUMN actor_id TEXT REFERENCES users(id)');
      if (!notices.has('count')) db.exec('ALTER TABLE notifications ADD COLUMN count INTEGER CHECK (count IS NULL OR (count >= 1 AND dedupe_key IS NULL AND entity IS NOT NULL))');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_coalesce ON notifications(user_id, kind, entity, entity_id) WHERE read_at IS NULL AND count IS NOT NULL`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_entity ON notifications(entity, entity_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_comments_addressee ON comments(addressee_id, state)');
      backfillWorkflowMessages(db);
      workflowMessageTriggers(db);
      instanceBoundaryTriggers(db);
    },
  },
  {
    id: 39,
    name: '039_performance_indexes',
    // Performance at MCEN scale (ADR-0032). Indexes only: no table, column, trigger or row changes. Each serves a
    // read that otherwise scans a table or sorts it in memory, and the read's test asserts its plan. Built here rather than
    // in schema.sql because several are on columns earlier migrations added, which schema.sql runs before. The period
    // indexes are on the exact expression periodClause (server/services/timeframes.ts) writes for the last day a record
    // covers: an edit to that expression must change these indexes with it, or those reads fall back to a scan.
    run: (db) => {
      for (const sql of [
        // Personnel: the latest roster sync of a Unit Instance; a Marine's trainings and awards in date order.
        'CREATE INDEX IF NOT EXISTS idx_sync_runs_org ON personnel_sync_runs(org_id, at)',
        'CREATE INDEX IF NOT EXISTS idx_trainings_user_date ON trainings(user_id, date)',
        'CREATE INDEX IF NOT EXISTS idx_awards_user_date ON awards(user_id, date)',
        // Report Studio: drafts about a Marine and a unit's shared drafts, newest first.
        'CREATE INDEX IF NOT EXISTS idx_report_drafts_subject ON report_drafts(subject_id, updated_at DESC)',
        'CREATE INDEX IF NOT EXISTS idx_report_drafts_unit ON report_drafts(unit_id, visibility, updated_at DESC)',
        // Error snapshots: a series' history read by key, and the snapshots filed from one uploaded file.
        'CREATE INDEX IF NOT EXISTS idx_error_snapshot_rows_key_closed ON error_snapshot_rows(natural_key, snapshot_id, closed)',
        'CREATE INDEX IF NOT EXISTS idx_error_snapshots_source ON error_snapshots(source_file_id)',
        // Audit: the actions a trail holds, for its filter.
        'CREATE INDEX IF NOT EXISTS idx_audit_trail_action ON audit_log(org_id, unit_id, action)',
        // Duty: the live duty list newest first, page by page; what links an activity to work and to drafts.
        'CREATE INDEX IF NOT EXISTS idx_duties_live_order ON duties(date DESC, start_time DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL',
        'CREATE INDEX IF NOT EXISTS idx_work_actions_activity ON work_actions(activity_id) WHERE activity_id IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS idx_record_drafts_activity ON record_drafts(activity_id) WHERE activity_id IS NOT NULL',
        // Analytics: a unit's records in a period, bounded on both sides by the last day each covers.
        "CREATE INDEX IF NOT EXISTS idx_activities_unit_last ON activities(unit_id, visibility, (CASE WHEN ongoing = 1 THEN '9999-12-31' ELSE COALESCE(end_date, date) END)) WHERE deleted_at IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_trainings_unit_last ON trainings(unit_id, visibility, (CASE WHEN ongoing = 1 THEN '9999-12-31' ELSE COALESCE(end_date, date) END)) WHERE deleted_at IS NULL",
        'CREATE INDEX IF NOT EXISTS idx_duties_unit_last ON duties(unit_id, (COALESCE(end_date, date)))',
      ]) db.exec(sql);
    },
  },
  {
    id: 40,
    name: '040_form_edipi',
    // The EDIPI a person types for their counseling worksheets (ADR-0033): what the form's EDIPI box prints when their CAC
    // has not proved one. It is only ever set by its own person (PUT /api/me/edipi), is never unique, and is never read to
    // sign anyone in: `users.edipi`, the CAC's, stays the only sign-in link, and wins over it. Two columns, added empty;
    // no row is changed. Rolled back by dropping both columns, which nothing before 040 reads.
    run: (db) => {
      const users = columnsOf(db, 'users');
      if (!users.has('form_edipi')) db.exec(`ALTER TABLE users ADD COLUMN form_edipi TEXT CHECK (form_edipi IS NULL OR (length(form_edipi) = 10 AND form_edipi NOT GLOB '*[^0-9]*'))`);
      if (!users.has('form_edipi_at')) db.exec('ALTER TABLE users ADD COLUMN form_edipi_at TEXT CHECK ((form_edipi_at IS NULL) = (form_edipi IS NULL))');
    },
  },
  {
    id: 41,
    name: '041_auth_epoch',
    // Fresh authority across waits (ADR-0035). `users.auth_epoch` counts the security transitions an account has been
    // through (invalidateUserSessions advances it); `sessions.auth_epoch` is the epoch a session was opened under, and a
    // session stands only while the two match, so a proof checked across a reset cannot open one. `oidc_states.browser_hash`
    // is the digest of the cookie set in the browser that began an organization sign-in, which its return must present.
    // Three columns, added with defaults; no row is changed. Every account and session starts at 0, so they still match
    // and nobody is signed out by the upgrade. A sign-in begun at the provider before it has no browser hash and is
    // refused (ten minutes at most); a code challenge issued before it carries no epoch and is refused the same way
    // (five minutes). Rolled back by restoring the pre-upgrade backup with the previous build.
    run: (db) => {
      if (!columnsOf(db, 'users').has('auth_epoch')) db.exec('ALTER TABLE users ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0)');
      if (!columnsOf(db, 'sessions').has('auth_epoch')) db.exec('ALTER TABLE sessions ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0)');
      if (!columnsOf(db, 'oidc_states').has('browser_hash')) db.exec('ALTER TABLE oidc_states ADD COLUMN browser_hash TEXT');
    },
  },
  {
    id: 42,
    name: '042_attachment_scan',
    // What the malware scan said of each file (ADR-0040): `clean`, or `skipped` when it was kept without a verdict (no
    // scanner, or one that timed out or could not be reached while scanning is optional). A file kept before this has no
    // verdict on record, so every existing row takes `unrecorded`; nothing claims a scan it cannot show. One column,
    // added with that default; no other value is changed. Rolled back by restoring the pre-upgrade backup with the
    // previous build.
    run: (db) => {
      if (!columnsOf(db, 'attachments').has('scan_status')) db.exec("ALTER TABLE attachments ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'unrecorded' CHECK (scan_status IN ('clean', 'skipped', 'unrecorded'))");
    },
  },
  {
    id: 43,
    name: '043_tune_up_indexes',
    // The reads that still scanned a table (ADR-0042). Indexes only: no table, column, trigger or row changes, and each
    // read's test asserts its plan. A person's goals as owner or assignee, their work items, contacts and sign-in links,
    // a unit's help requests, and the foreign keys into users and units each get an index; the recycle bin's sweep reads
    // only what was deleted, by a partial index that holds nothing else, so a live write or read never touches it. The
    // three unit window indexes of 039 are built again under their names with the first day after the last, so a window's
    // two ends are both tested in the index and the period before one is read without the period after it. Every
    // statement only creates what is missing, and a window index is rebuilt only while it lacks that column, so a rerun
    // does nothing. Rolled back by restoring the pre-upgrade copy with the previous build.
    run: (db) => {
      for (const sql of [
        'CREATE INDEX IF NOT EXISTS idx_goals_assignee ON goals(assignee_id) WHERE assignee_id IS NOT NULL',
        'CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner_id, visibility, unit_id)',
        'CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id)',
        'CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id, kind)',
        'CREATE INDEX IF NOT EXISTS idx_support_unit ON support_tickets(unit_id, state)',
        ...BINNED_TABLES.map((table) => `CREATE INDEX IF NOT EXISTS idx_${table}_deleted ON ${table}(deleted_at) WHERE deleted_at IS NOT NULL`),
      ]) db.exec(sql);
      for (const [name, sql] of Object.entries(UNIT_WINDOW_INDEXES)) {
        const keys = (db.prepare('SELECT name FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno').all(name) as Array<{ name: string | null }>).map((k) => k.name);
        if (keys.at(-1) === 'date') continue;
        db.exec(`DROP INDEX IF EXISTS ${name}`);
        db.exec(sql);
      }
    },
  },  {
    id: 44,
    name: '044_jepes_inputs',
    // The figures a JEPES estimate reads that readiness did not keep (ADR-0046): the rifle score the order's tables
    // read, whether the Marine is an MCMAP instructor at their belt, a second associate degree, off-duty courses in
    // service and in grade, the MOS qualification points MOL shows, and the bonus lines of the worksheet. Thirteen
    // columns, each added empty with its range checked; no row is changed, and each is added only while missing, so a
    // rerun does nothing. Rolled back by restoring the pre-upgrade copy with the previous build.
    run: (db) => {
      const have = columnsOf(db, 'readiness');
      for (const [column, definition] of JEPES_INPUT_COLUMNS) if (!have.has(column)) db.exec(`ALTER TABLE readiness ADD COLUMN ${column} ${definition}`);
    },
  },
  {
    id: 45,
    name: '045_fitness_reports',
    // The fitness reports a Marine received, as they copy them off their Master Brief Sheet (ADR-0047). The table and
    // its index come from schema.sql, which is safe to replay; every column's range is checked there. Nothing already
    // written is read, moved or reshaped, and no report's standing is stored: it is worked on read. Rolled back by
    // restoring the pre-upgrade copy with the previous build.
    run: () => {},
  },
];

/** The readiness columns migration 044 adds, as schema.sql declares them, so a new and an upgraded database match. */
const JEPES_INPUT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['rifle_score', 'INTEGER CHECK (rifle_score IS NULL OR rifle_score BETWEEN 0 AND 350)'],
  ['mcmap_instructor', 'INTEGER CHECK (mcmap_instructor IS NULL OR mcmap_instructor IN (0, 1))'],
  ['associate_degrees', 'INTEGER CHECK (associate_degrees IS NULL OR associate_degrees BETWEEN 0 AND 9)'],
  ['courses_in_service', 'INTEGER CHECK (courses_in_service IS NULL OR courses_in_service BETWEEN 0 AND 99)'],
  ['courses_in_grade', 'INTEGER CHECK (courses_in_grade IS NULL OR courses_in_grade BETWEEN 0 AND 99)'],
  ['mos_qual_points', 'INTEGER CHECK (mos_qual_points IS NULL OR mos_qual_points BETWEEN 0 AND 100)'],
  ['bonus_di_school', 'INTEGER CHECK (bonus_di_school IS NULL OR bonus_di_school IN (0, 1))'],
  ['bonus_recruiter_school', 'INTEGER CHECK (bonus_recruiter_school IS NULL OR bonus_recruiter_school IN (0, 1))'],
  ['bonus_msg_school', 'INTEGER CHECK (bonus_msg_school IS NULL OR bonus_msg_school IN (0, 1))'],
  ['bonus_combat_instructor', 'INTEGER CHECK (bonus_combat_instructor IS NULL OR bonus_combat_instructor IN (0, 1))'],
  ['bonus_security_forces', 'INTEGER CHECK (bonus_security_forces IS NULL OR bonus_security_forces IN (0, 1))'],
  ['bonus_reserve_affiliation', 'INTEGER CHECK (bonus_reserve_affiliation IS NULL OR bonus_reserve_affiliation IN (0, 1))'],
  ['recruiting_referrals', 'INTEGER CHECK (recruiting_referrals IS NULL OR recruiting_referrals BETWEEN 0 AND 99)'],
];

/** The tables the recycle bin keeps deleted rows in until its sweep removes them (purgeDeleted). */
const BINNED_TABLES = ['activities', 'projects', 'tasks', 'goals', 'trainings', 'awards', 'counselings', 'duties', 'attachments', 'comments'] as const;

/**
 * A unit's records in a window (migration 039, rebuilt by 043): the Unit Instance and visibility, the last day a record
 * covers, exactly as periodClause writes it (server/services/timeframes.ts), then its first day. The reads name these
 * indexes (BY_LAST_DAY in server/services/metrics.ts), so a change to that expression must change them too.
 */
export const UNIT_WINDOW_INDEXES = {
  idx_activities_unit_last: "CREATE INDEX idx_activities_unit_last ON activities(unit_id, visibility, (CASE WHEN ongoing = 1 THEN '9999-12-31' ELSE COALESCE(end_date, date) END), date) WHERE deleted_at IS NULL",
  idx_trainings_unit_last: "CREATE INDEX idx_trainings_unit_last ON trainings(unit_id, visibility, (CASE WHEN ongoing = 1 THEN '9999-12-31' ELSE COALESCE(end_date, date) END), date) WHERE deleted_at IS NULL",
  idx_duties_unit_last: 'CREATE INDEX idx_duties_unit_last ON duties(unit_id, (COALESCE(end_date, date)), date)',
} as const;
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.id;
/** Every migration this build carries, in order: what the database fixtures run, and change, to test an upgrade (ADR-0041). */
export const BUILD_MIGRATIONS: readonly Migration[] = MIGRATIONS;
/** The migrations this build carries, for the Vantage Administrator console's migration status. */
export const MIGRATION_CATALOG: ReadonlyArray<{ id: number; name: string }> = MIGRATIONS.map(({ id, name }) => ({ id, name }));

/**
 * The standard SNCO and SNCOIC roles gain what the role template gives them from migration 032 on (ADR-0024 §2): Review
 * duty for both, Override duty points for the SNCOIC as well. Only the roles Vantage seeded (is_system, by key) and only
 * bits added: a role a unit defined is left as it is, and one a unit takes the permission out of afterwards is not
 * touched again, because this runs once. As migration 007 hands a permission only to a role that could already do the
 * work, a standard role its unit has cut back gains nothing it was cut back from: reviewing takes a role that still reads
 * shared records and counsels members, and overriding one that still corrects others' records too. The bits are written
 * out, as 007's are, so a later change to the template does not change what this migration did. An archive from before
 * 032 gets the same when it is imported (importInstance).
 */
export function grantDutyReviewToStandardRoles(db: Db) {
  const VIEW_RECORDS = 1 << 1, MANAGE_RECORDS = 1 << 3, COUNSEL = 1 << 11;
  const REVIEW_DUTY = 1 << 18, OVERRIDE_DUTY_POINTS = 1 << 19;
  const add = db.prepare('UPDATE roles SET permissions = permissions | ? WHERE is_system = 1 AND key = ? AND permissions & ? = ?');
  const leads = VIEW_RECORDS | COUNSEL;
  add.run(REVIEW_DUTY, 'snco', leads, leads);
  add.run(REVIEW_DUTY, 'sncoic', leads, leads);
  add.run(OVERRIDE_DUTY_POINTS, 'sncoic', leads | MANAGE_RECORDS, leads | MANAGE_RECORDS);
}

/** The record tables a comment may hang on, and the work case: what a notice's link is read back to (migration 038). */
const NOTICE_LINKS: ReadonlyArray<[RegExp, string]> = [
  [/^\/records\/(activities|awards|trainings|counselings|tasks|projects|goals|duties)\/([^/?#]+)$/, '$1'],
  [/^\/records\/([^/?#]+)$/, 'activities'],
  [/^\/career\/awards\?open=([^&#]+)$/, 'awards'],
  [/^\/career\/training\?open=([^&#]+)$/, 'trainings'],
  [/^\/career\/counseling\?open=([^&#]+)$/, 'counselings'],
  [/^\/record\/duty\?open=([^&#]+)$/, 'duties'],
  [/^\/work\/items\/([^/?#]+)$/, 'work_items'],
];

/**
 * What migration 038 does to rows written before it, and what an instance archive from before it gets when it is loaded
 * (importInstance). A comment said on a counseling before it was final is private to its counselor and its Marine, as it
 * was when it was said: while it is still a draft or in review, or before the moment it was finalized. A notice that
 * links to a record or a work case is given it, with its Unit Instance, so it is checked again when read; one whose kind
 * quoted what somebody wrote (a comment, a hand-off's note, a task's title, a help request or a reply on it, a reason or a
 * note given about Vantage access or a sign-in change) keeps its title and loses the words. Safe to run again: it only
 * fills what is empty and clears what a notice must not hold.
 */
export function backfillWorkflowMessages(db: Db) {
  if (columnsOf(db, 'comments').has('private') && columnsOf(db, 'counselings').has('stage')) {
    db.exec(`UPDATE comments SET private = 1 WHERE private = 0 AND record_table = 'counselings' AND EXISTS (
      SELECT 1 FROM counselings c WHERE c.id = comments.record_id
        AND (c.stage IN ('draft', 'review') OR (c.finalized_at IS NOT NULL AND comments.created_at < c.finalized_at)))`);
  }
  if (!columnsOf(db, 'notifications').has('entity')) return;
  const linked = db.prepare(`SELECT id, action_url FROM notifications WHERE entity IS NULL AND action_url IS NOT NULL
    AND kind IN ('comment_added', 'comment_mention', 'counseling', 'award', 'duty', 'assignment', 'work_assigned', 'work')`).all() as Array<{ id: string; action_url: string }>;
  const give = db.prepare('UPDATE notifications SET entity = ?, entity_id = ?, org_id = COALESCE(org_id, (SELECT u.org_id FROM units u WHERE u.id = ?)) WHERE id = ?');
  const unitOf = (table: string, id: string) => {
    if (!/^[a-z_]+$/.test(table) || !columnsOf(db, table).has('unit_id')) return null;
    return (db.prepare(`SELECT unit_id FROM ${table} WHERE id = ?`).get(id) as { unit_id: string | null } | undefined)?.unit_id ?? null;
  };
  for (const n of linked) {
    for (const [pattern, table] of NOTICE_LINKS) {
      const m = pattern.exec(n.action_url);
      if (!m) continue;
      const entity = table.startsWith('$') ? m[1] : table;
      const entityId = decodeURIComponent(table.startsWith('$') ? m[2] : m[1]);
      give.run(entity, entityId, unitOf(entity, entityId), n.id);
      break;
    }
  }
  db.exec(`UPDATE notifications SET message = NULL WHERE message IS NOT NULL AND kind IN ('comment_added', 'comment_mention', 'work_assigned', 'assignment')`);
  // So do the notices that quoted a help request's subject or a reply on it, the reason Vantage support gave for asking
  // to look at a Unit Instance or the note it was answered with (a denial was the note alone, with no quotation marks),
  // and the reason for a change to a sign-in or the note it was answered with. The ones sent beside them quote nobody,
  // and keep what they said: who finished looking or withdrew the request, and when access ends.
  db.exec(`UPDATE notifications SET message = NULL WHERE message IS NOT NULL AND (
    kind IN ('support_ticket', 'support_reply', 'support_assigned')
    OR (kind = 'system' AND action_url = '/console/access' AND dedupe_key LIKE 'access:%')
    OR (kind = 'system' AND action_url = '/admin/access' AND (dedupe_key IS NULL OR dedupe_key NOT LIKE 'access-ending:%'))
    OR (kind = 'security' AND action_url = '/admin/accounts'))`);
  // The demonstration's old "work" notices were about work that moved; the catalogue names that kind now.
  db.exec(`UPDATE notifications SET kind = 'work_moved' WHERE kind = 'work'`);
  // A training has no page of its own under /records: its notices open it where it lives.
  db.exec(`UPDATE notifications SET action_url = '/career/training?open=' || substr(action_url, 20) WHERE action_url LIKE '/records/trainings/%'`);
}

/**
 * What the database keeps of a discussion's shape (ADR-0031), as the second line behind the code: an answer is on its
 * request's record, and what a request, an answer or an assignment note said is never rewritten, except by a retention
 * schedule's redaction. A reference to a request that is not there yet passes, as an archive loads table by table.
 */
export function workflowMessageTriggers(db: Db) {
  if (!columnsOf(db, 'comments').has('reply_to')) return;
  db.exec(`CREATE TRIGGER IF NOT EXISTS comments_reply_same_record BEFORE INSERT ON comments FOR EACH ROW
    WHEN NEW.reply_to IS NOT NULL AND EXISTS (SELECT 1 FROM comments r WHERE r.id = NEW.reply_to
      AND (r.record_table IS NOT NEW.record_table OR r.record_id IS NOT NEW.record_id OR r.kind NOT IN ('review_request', 'clarification_request')))
    BEGIN SELECT RAISE(ABORT, 'workflow_message: an answer belongs to its request, on its record'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS comments_requests_kept BEFORE UPDATE OF body, kind, author_id, addressee_id ON comments FOR EACH ROW
    WHEN OLD.kind <> 'comment' AND (NEW.kind IS NOT OLD.kind OR NEW.author_id IS NOT OLD.author_id OR NEW.addressee_id IS NOT OLD.addressee_id
      OR (NEW.body IS NOT OLD.body AND NEW.body IS NOT '${REDACTED.replace(/'/g, "''")}'))
    BEGIN SELECT RAISE(ABORT, 'workflow_message: a request, an answer or an assignment note is kept as it was said'); END`);
}

/** What `migration_audited_through` holds for a database created by this start whose creation is not audited yet. */
export const NEW_DATABASE = 'new';

/** Migrations up to this one ran before Vantage audited them; a database that has not said otherwise audits from the next. */
export const AUDITED_FROM = 21;

/** One migration this database ran: when, how long it took, and under which version of Vantage. */
export interface MigrationRun { id: number; name: string; at: string; ms: number; version: string }
const MIGRATION_HISTORY_KEPT = 100;

const columnsOf = (db: Db, table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

/**
 * One central service, organizations as tenants (ADR-0006). Adds before it changes anything:
 * - every top-level unit founds an organization, and every unit beneath it carries that organization;
 * - former Instance Operators become platform owners; each organization's owners are its root unit's leader,
 *   or the former operators where it had none;
 * - the roster feed, retention schedules, holds and their runs become the first organization's.
 * Audit entries are not rewritten: their hashes stay valid, and an organization's view derives older entries' org from
 * their unit.
 */
function migrateToOrganizations(db: Db) {
  const at = new Date().toISOString();
  const add = (table: string, column: string, type: string) => { if (!columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); };
  add('units', 'org_id', 'TEXT');
  add('member_roles', 'expires_at', 'TEXT');
  add('audit_log', 'org_id', 'TEXT');
  add('legal_holds', 'org_id', 'TEXT');
  add('disposition_runs', 'org_id', 'TEXT');
  add('personnel_sync_runs', 'org_id', 'TEXT');

  const { roots, operators } = foundOrganizations(db, at);
  db.exec('CREATE INDEX IF NOT EXISTS idx_units_org ON units(org_id)');

  // The instance's governance data becomes the first organization's.
  const first = [...roots.values()].filter((r) => r.active).sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.id ?? [...roots.keys()][0] ?? null;
  if (!columnsOf(db, 'personnel_roster').has('org_id')) {
    db.exec(`CREATE TABLE personnel_roster_v2 (
      org_id TEXT NOT NULL, edipi TEXT NOT NULL, last_name TEXT NOT NULL, first_name TEXT NOT NULL, middle_initial TEXT, rank_id TEXT, mos TEXT, eas TEXT,
      unit_code TEXT, billet TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'separated')), source TEXT NOT NULL, row_hash TEXT NOT NULL,
      synced_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_units TEXT, PRIMARY KEY (org_id, edipi))`);
    if (first) db.prepare(`INSERT INTO personnel_roster_v2 (org_id, edipi, last_name, first_name, middle_initial, rank_id, mos, eas, unit_code, billet, status, source, row_hash, synced_at, created_at, updated_at)
                           SELECT ?, edipi, last_name, first_name, middle_initial, rank_id, mos, eas, unit_code, billet, status, source, row_hash, synced_at, created_at, updated_at FROM personnel_roster`).run(first);
    db.exec('DROP TABLE personnel_roster');
    db.exec('ALTER TABLE personnel_roster_v2 RENAME TO personnel_roster');
    db.exec('CREATE INDEX IF NOT EXISTS idx_roster_status ON personnel_roster(status, unit_code)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_roster_name ON personnel_roster(last_name, first_name)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_roster_edipi ON personnel_roster(edipi)');
  if (!columnsOf(db, 'retention_schedules').has('org_id')) {
    db.exec(`CREATE TABLE retention_schedules_v2 (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, record_type TEXT NOT NULL, retain_days INTEGER NOT NULL CHECK (retain_days > 0),
      disposition TEXT NOT NULL CHECK (disposition IN ('destroy', 'anonymize', 'review')), authority TEXT, notes TEXT,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (org_id, record_type))`);
    if (first) db.prepare(`INSERT INTO retention_schedules_v2 (id, org_id, record_type, retain_days, disposition, authority, notes, enabled, created_at, updated_at)
                           SELECT id, ?, record_type, retain_days, disposition, authority, notes, enabled, created_at, updated_at FROM retention_schedules`).run(first);
    db.exec('DROP TABLE retention_schedules');
    db.exec('ALTER TABLE retention_schedules_v2 RENAME TO retention_schedules');
  }
  if (first) {
    for (const table of ['legal_holds', 'disposition_runs', 'personnel_sync_runs']) db.prepare(`UPDATE ${table} SET org_id = ? WHERE org_id IS NULL`).run(first);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_holds_org ON legal_holds(org_id, released_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, seq DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_roles_expiry ON member_roles(expires_at) WHERE expires_at IS NOT NULL');
  db.prepare("INSERT INTO meta (key, value) VALUES ('org_migration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ at, organizations: roots.size, platformOwners: operators.length, governanceTo: first }));
}

/**
 * Every unit without an organization joins the one at the top of its tree, which is founded if it does not exist; the
 * triggers keep it so from then on. Former operators become platform owners, and each new organization's owner is its
 * top unit's leader (the former operators where it had none). Safe to run again: it only fills what is missing. The
 * migration runs it once; importing an archive from before organizations runs it on what the archive brought.
 */
export function foundOrganizations(db: Db, at = new Date().toISOString()) {
  // Organizations from the top of each unit tree. A unit whose parent is gone is the top of its own tree.
  const units = db.prepare('SELECT id, code, name, short_name, parent_id, owner_user_id, active, created_at FROM units').all() as Array<{ id: string; code: string; name: string; short_name: string | null; parent_id: string | null; owner_user_id: string | null; active: number; created_at: string }>;
  const byId = new Map(units.map((u) => [u.id, u]));
  const rootOf = (id: string) => {
    let current = byId.get(id)!;
    const seen = new Set<string>();
    while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.parent_id)) { seen.add(current.id); current = byId.get(current.parent_id)!; }
    return current;
  };
  const insertOrg = db.prepare(`INSERT OR IGNORE INTO organizations (id, slug, name, short_name, status, root_unit_id, settings, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`);
  const setOrg = db.prepare('UPDATE units SET org_id = ? WHERE id = ? AND org_id IS NULL');
  const roots = new Map<string, (typeof units)[number]>();
  for (const u of units) {
    const root = rootOf(u.id);
    roots.set(root.id, root);
    setOrg.run(root.id, u.id);
  }
  for (const root of roots.values()) insertOrg.run(root.id, root.code, root.name, root.short_name, root.active ? 'active' : 'archived', root.id, root.created_at, at);

  // Every unit belongs to an organization from now on: beneath a parent, the parent's; at the top, one it founds.
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_inherit_org AFTER INSERT ON units FOR EACH ROW WHEN NEW.org_id IS NULL AND NEW.parent_id IS NOT NULL
    BEGIN UPDATE units SET org_id = (SELECT org_id FROM units WHERE id = NEW.parent_id) WHERE id = NEW.id; END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_found_org AFTER INSERT ON units FOR EACH ROW WHEN NEW.org_id IS NULL AND NEW.parent_id IS NULL
    BEGIN
      INSERT OR IGNORE INTO organizations (id, slug, name, short_name, status, root_unit_id, settings, created_at, updated_at)
        VALUES (NEW.id, NEW.code, NEW.name, NEW.short_name, 'active', NEW.id, '{}', NEW.created_at, NEW.created_at);
      UPDATE units SET org_id = NEW.id WHERE id = NEW.id;
    END`);
  // A unit never changes organization by being moved: a parent in another organization is refused here as well as in code.
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_stay_in_org BEFORE UPDATE OF parent_id ON units FOR EACH ROW
    WHEN NEW.parent_id IS NOT NULL AND NEW.org_id IS NOT NULL AND (SELECT org_id FROM units WHERE id = NEW.parent_id) IS NOT NEW.org_id
    BEGIN SELECT RAISE(ABORT, 'a unit cannot move into another organization'); END`);

  // Former operators run the platform now; organizations get owners of their own.
  const operators = columnsOf(db, 'users').has('is_operator')
    ? (db.prepare('SELECT id FROM users WHERE is_operator = 1').all() as Array<{ id: string }>).map((r) => r.id)
    : [];
  const platform = db.prepare("INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, created_at) VALUES (?, 'owner', NULL, ?)");
  for (const id of operators) platform.run(id, at);
  const owner = db.prepare("INSERT OR IGNORE INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES (?, ?, 'owner', NULL, ?)");
  // Only an organization with no owner gets them here: one that has owners keeps the ones it has.
  const hasOwner = db.prepare("SELECT 1 FROM org_roles WHERE org_id = ? AND role = 'owner'");
  for (const root of roots.values()) {
    if (hasOwner.get(root.id)) continue;
    const owners = root.owner_user_id ? [root.owner_user_id] : operators;
    for (const id of owners) owner.run(root.id, id, at);
  }

  return { roots, operators };
}

/** The organization of a unit, as SQL over an expression that names one. */
const orgOf = (unit: string) => `(SELECT org_id FROM units WHERE id = ${unit})`;
/** Two units across the boundary: both organizations known, and different. `<>` is not true when either is NULL. */
const across = (a: string, b: string) => `${orgOf(a)} <> ${orgOf(b)}`;
const projectUnit = (id: string) => `(SELECT unit_id FROM projects WHERE id = ${id})`;
const contactUnit = (id: string) => `(SELECT unit_id FROM contacts WHERE id = ${id})`;
const threadUnit = (id: string) => `(SELECT unit_id FROM threads WHERE id = ${id})`;
const itemUnit = (id: string) => `(SELECT unit_id FROM work_items WHERE id = ${id})`;
const PROJECT_CHILDREN = ['activities', 'tasks', 'work_items'] as const;
/** The tables that file rows under a project in this database. One built by hand at an older version may lack the column. */
const filedUnderProjects = (db: Db) => PROJECT_CHILDREN.filter((t) => columnsOf(db, t).has('project_id'));

/**
 * The Unit Instance boundary, kept by the database as well as by the code that enforces it (ADR-0008). Authorization
 * is decided in the server; these triggers are the second line, so that a defect or a hand-written statement cannot
 * quietly move a unit between organizations or link one instance's rows to another's. PostgreSQL row-level security
 * is the equivalent for a PostgreSQL deployment; on SQLite, which has no RLS, triggers are what the engine offers.
 *
 * They refuse only a pairing that is really across the boundary: two units whose organizations are both known and
 * differ. A row with no unit belongs to no instance, a unit an archive has not yet given its organization is not known
 * to differ, and a reference to a row that is not there yet passes, because an archive is restored table by table and
 * `instanceBoundaryViolations` checks it whole once it is in. Both ends of each reference are kept: the row that points,
 * and the row pointed at, which cannot move out from under it. An update is checked only when it changes the reference
 * or a unit, so a row joined across before this migration can still be edited. Each refusal begins `cross_instance:`,
 * which the API answers as a refusal rather than a server error.
 */
export function instanceBoundaryTriggers(db: Db) {
  const refuse = (why: string) => `BEGIN SELECT RAISE(ABORT, 'cross_instance: ${why}'); END`;
  // A unit's organization is set once, when it is created. Nothing moves it afterwards.
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_org_immutable BEFORE UPDATE OF org_id ON units FOR EACH ROW
    WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id
    ${refuse('a unit cannot change Unit Instance')}`);

  // An entry, a task or a queue item filed under a project stays inside the project's instance...
  const children = filedUnderProjects(db);
  for (const table of children) {
    const crossing = `NEW.project_id IS NOT NULL AND ${across('NEW.unit_id', projectUnit('NEW.project_id'))}`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_project_same_org_insert BEFORE INSERT ON ${table} FOR EACH ROW
      WHEN ${crossing}
      ${refuse('a project in another Unit Instance cannot be linked here')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_project_same_org_update BEFORE UPDATE OF project_id, unit_id ON ${table} FOR EACH ROW
      WHEN (NEW.project_id IS NOT OLD.project_id OR NEW.unit_id IS NOT OLD.unit_id) AND ${crossing}
      ${refuse('a project in another Unit Instance cannot be linked here')}`);
  }
  // ...and a project moves only where everything filed under it can follow.
  if (children.length) db.exec(`CREATE TRIGGER IF NOT EXISTS projects_children_same_org BEFORE UPDATE OF unit_id ON projects FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND (${children.map((t) => `EXISTS (SELECT 1 FROM ${t} c WHERE c.project_id = NEW.id AND ${across('c.unit_id', 'NEW.unit_id')})`).join(' OR ')})
    ${refuse('work in another Unit Instance is filed under this project')}`);

  // Correspondence names a contact from its own instance, and the contact stays where its threads are.
  const contactCrossing = `NEW.contact_id IS NOT NULL AND ${across('NEW.unit_id', contactUnit('NEW.contact_id'))}`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS threads_contact_same_org_insert BEFORE INSERT ON threads FOR EACH ROW
    WHEN ${contactCrossing}
    ${refuse('a contact in another Unit Instance cannot be used here')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS threads_contact_same_org_update BEFORE UPDATE OF contact_id, unit_id ON threads FOR EACH ROW
    WHEN (NEW.contact_id IS NOT OLD.contact_id OR NEW.unit_id IS NOT OLD.unit_id) AND ${contactCrossing}
    ${refuse('a contact in another Unit Instance cannot be used here')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS contacts_threads_same_org BEFORE UPDATE OF unit_id ON contacts FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM threads t WHERE t.contact_id = NEW.id AND ${across('t.unit_id', 'NEW.unit_id')})
    ${refuse('correspondence in another Unit Instance names this contact')}`);

  // A thread points at work in its own instance, and neither end of the link moves out from under the other.
  const linkCrossing = across(threadUnit('NEW.thread_id'), itemUnit('NEW.work_item_id'));
  db.exec(`CREATE TRIGGER IF NOT EXISTS thread_links_same_org BEFORE INSERT ON thread_links FOR EACH ROW
    WHEN ${linkCrossing}
    ${refuse('correspondence and work in different Unit Instances cannot be linked')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS thread_links_same_org_update BEFORE UPDATE OF thread_id, work_item_id ON thread_links FOR EACH ROW
    WHEN ${linkCrossing}
    ${refuse('correspondence and work in different Unit Instances cannot be linked')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS threads_links_same_org BEFORE UPDATE OF unit_id ON threads FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM thread_links l WHERE l.thread_id = NEW.id AND ${across(itemUnit('l.work_item_id'), 'NEW.unit_id')})
    ${refuse('this correspondence is linked to work in another Unit Instance')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS work_items_links_same_org BEFORE UPDATE OF unit_id ON work_items FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM thread_links l WHERE l.work_item_id = NEW.id AND ${across(threadUnit('l.thread_id'), 'NEW.unit_id')})
    ${refuse('this work is linked to correspondence in another Unit Instance')}`);

  // A Unit Instance's configuration, and a responsibility held in it, names only its own units (ADR-0012, ADR-0017).
  for (const table of orgUnitTables(db)) {
    const crossing = `NEW.unit_id IS NOT NULL AND ${orgOf('NEW.unit_id')} <> NEW.org_id`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_unit_same_org_insert BEFORE INSERT ON ${table} FOR EACH ROW
      WHEN ${crossing}
      ${refuse('a unit in another Unit Instance cannot be named here')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_unit_same_org_update BEFORE UPDATE OF unit_id, org_id ON ${table} FOR EACH ROW
      WHEN (NEW.unit_id IS NOT OLD.unit_id OR NEW.org_id IS NOT OLD.org_id) AND ${crossing}
      ${refuse('a unit in another Unit Instance cannot be named here')}`);
  }

  // A membership fills a billet of its own unit's Unit Instance, and a billet stays where its holders are (ADR-0017).
  if (columnsOf(db, 'unit_members').has('billet_id')) {
    const crossing = `NEW.billet_id IS NOT NULL AND ${billetOrg('NEW.billet_id')} <> ${orgOf('NEW.unit_id')}`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS unit_members_billet_same_org_insert BEFORE INSERT ON unit_members FOR EACH ROW
      WHEN ${crossing}
      ${refuse('a billet of another Unit Instance cannot be filled here')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS unit_members_billet_same_org_update BEFORE UPDATE OF billet_id, unit_id ON unit_members FOR EACH ROW
      WHEN (NEW.billet_id IS NOT OLD.billet_id OR NEW.unit_id IS NOT OLD.unit_id) AND ${crossing}
      ${refuse('a billet of another Unit Instance cannot be filled here')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS unit_billets_holders_same_org BEFORE UPDATE OF org_id ON unit_billets FOR EACH ROW
      WHEN NEW.org_id IS NOT OLD.org_id AND EXISTS (SELECT 1 FROM unit_members m WHERE m.billet_id = NEW.id AND ${orgOf('m.unit_id')} <> NEW.org_id)
      ${refuse('this billet is filled in another Unit Instance')}`);
  }
  // A filed error report, its type and the file it was read from are all one Unit Instance's (ADR-0021). A filed report
  // never changes (schema.sql), and a type or file it names never moves out from under it.
  if (columnsOf(db, 'error_snapshots').has('type_id')) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS error_snapshots_same_org BEFORE INSERT ON error_snapshots FOR EACH ROW
      WHEN ${orgOf('NEW.unit_id')} <> NEW.org_id OR ${typeOrg('NEW.type_id')} <> NEW.org_id
        OR ${orgOf(`(SELECT unit_id FROM source_files WHERE id = NEW.source_file_id)`)} <> NEW.org_id
      ${refuse('an error report, its type and its file belong to one Unit Instance')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS error_report_types_snapshots_same_org BEFORE UPDATE OF org_id ON error_report_types FOR EACH ROW
      WHEN NEW.org_id IS NOT OLD.org_id AND EXISTS (SELECT 1 FROM error_snapshots s WHERE s.type_id = NEW.id)
      ${refuse('error reports are filed under this type')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS source_files_snapshots_same_org BEFORE UPDATE OF unit_id ON source_files FOR EACH ROW
      WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM error_snapshots s WHERE s.source_file_id = NEW.id AND ${orgOf('NEW.unit_id')} <> s.org_id)
      ${refuse('an error report in another Unit Instance was read from this file')}`);
  }
  // A validated past case and the guidance entry that cites it are one Unit Instance's (ADR-0022), and so is an entry and
  // the one it replaces. Entries never change (schema.sql); a case an entry cites never moves out from under it.
  if (columnsOf(db, 'case_guidance').has('work_item_id')) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS case_guidance_same_org BEFORE INSERT ON case_guidance FOR EACH ROW
      WHEN (NEW.work_item_id IS NOT NULL AND (${orgOf(caseUnit('NEW.work_item_id'))} IS NOT NEW.org_id OR ${caseUnit('NEW.work_item_id')} IS NOT NEW.unit_id))
        OR (NEW.supersedes_id IS NOT NULL AND (SELECT org_id FROM case_guidance WHERE id = NEW.supersedes_id) IS NOT NEW.org_id)
      ${refuse('guidance and the case it cites belong to one Unit Instance')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS work_items_guidance_same_org BEFORE UPDATE OF unit_id ON work_items FOR EACH ROW
      WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM case_guidance g WHERE g.work_item_id = NEW.id)
      ${refuse('this case is cited as a validated example')}`);
  }
  // A duty is stood in a unit of the Unit Instance whose duty type it is and whose scoring version scored it (ADR-0023),
  // and a duty type never moves out from under the duty recorded against it. A version's instance never changes
  // (duty_scoring_policies_published).
  if (columnsOf(db, 'duties').has('duty_type_id')) {
    const crossing = `${orgOf('NEW.unit_id')} <> ${dutyTypeOrg('NEW.duty_type_id')} OR (NEW.scoring_policy_id IS NOT NULL AND ${orgOf('NEW.unit_id')} <> ${scoringOrg('NEW.scoring_policy_id')})`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS duties_same_org_insert BEFORE INSERT ON duties FOR EACH ROW
      WHEN ${crossing}
      ${refuse('a duty, its unit, its duty type and its scoring version belong to one Unit Instance')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS duties_same_org_update BEFORE UPDATE OF unit_id, duty_type_id, scoring_policy_id ON duties FOR EACH ROW
      WHEN (NEW.unit_id IS NOT OLD.unit_id OR NEW.duty_type_id IS NOT OLD.duty_type_id OR NEW.scoring_policy_id IS NOT OLD.scoring_policy_id) AND (${crossing})
      ${refuse('a duty, its unit, its duty type and its scoring version belong to one Unit Instance')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS duty_types_duties_same_org BEFORE UPDATE OF org_id ON duty_types FOR EACH ROW
      WHEN NEW.org_id IS NOT OLD.org_id AND EXISTS (SELECT 1 FROM duties d WHERE d.duty_type_id = NEW.id AND ${orgOf('d.unit_id')} <> NEW.org_id)
      ${refuse('duty in another Unit Instance is recorded against this duty type')}`);
  }
  // A duty's review history stays in its duty's Unit Instance (ADR-0024): a review is written in the unit its duty
  // stands in, and a duty that has been reviewed does not leave the Unit Instance that reviewed it.
  if (columnsOf(db, 'duty_reviews').has('duty_id')) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS duty_reviews_same_org_insert BEFORE INSERT ON duty_reviews FOR EACH ROW
      WHEN ${orgOf('NEW.unit_id')} IS NOT ${orgOf('(SELECT unit_id FROM duties WHERE id = NEW.duty_id)')}
      ${refuse('a duty review belongs to the Unit Instance of its duty')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS duties_reviews_same_org BEFORE UPDATE OF unit_id ON duties FOR EACH ROW
      WHEN NEW.unit_id IS NOT OLD.unit_id AND ${orgOf('NEW.unit_id')} IS NOT ${orgOf('OLD.unit_id')} AND EXISTS (SELECT 1 FROM duty_reviews r WHERE r.duty_id = NEW.id)
      ${refuse('this duty has been reviewed in its Unit Instance')}`);
  }
  // A counseling's amendment history stays in its counseling's Unit Instance (ADR-0027): an amendment is written in the
  // unit its counseling stands in, and a counseling that has been amended does not leave the Unit Instance it was amended in.
  if (columnsOf(db, 'counseling_revisions').has('counseling_id')) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS counseling_revisions_same_org_insert BEFORE INSERT ON counseling_revisions FOR EACH ROW
      WHEN ${orgOf('NEW.unit_id')} IS NOT ${orgOf('(SELECT unit_id FROM counselings WHERE id = NEW.counseling_id)')}
      ${refuse('a counseling amendment belongs to the Unit Instance of its counseling')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS counselings_revisions_same_org BEFORE UPDATE OF unit_id ON counselings FOR EACH ROW
      WHEN NEW.unit_id IS NOT OLD.unit_id AND ${orgOf('NEW.unit_id')} IS NOT ${orgOf('OLD.unit_id')} AND EXISTS (SELECT 1 FROM counseling_revisions r WHERE r.counseling_id = NEW.id)
      ${refuse('this counseling has been amended in its Unit Instance')}`);
  }
  // What is said on a record or a work case is said in its Unit Instance (ADR-0031): a comment, a request or an answer is
  // written in the unit of the record it hangs on. Only a new one is checked: a Marine's own comments go with their own
  // record when it moves (ADR-0008), and what others said keeps a record where it was said (assertCarriesNothingAcross).
  if (columnsOf(db, 'comments').has('reply_to')) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS comments_same_org_insert BEFORE INSERT ON comments FOR EACH ROW
      WHEN NEW.unit_id IS NOT NULL AND ${across('NEW.unit_id', commentHostUnit(db, 'NEW'))}
      ${refuse('what is said on a record is said in its Unit Instance')}`);
  }
  // A supervisor serves in the Unit Instance they supervise in. Leaving it clears them as anyone's supervisor there first
  // (server/services/personnelRecords.ts), so only a new pairing is checked.
  if (columnsOf(db, 'personnel_records').has('supervisor_id')) {
    const outside = `NEW.supervisor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unit_members sm JOIN units su ON su.id = sm.unit_id WHERE sm.user_id = NEW.supervisor_id AND su.org_id = NEW.org_id)`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_records_supervisor_same_org_insert BEFORE INSERT ON personnel_records FOR EACH ROW
      WHEN ${outside}
      ${refuse('a supervisor must serve in the same Unit Instance')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_records_supervisor_same_org_update BEFORE UPDATE OF supervisor_id, org_id ON personnel_records FOR EACH ROW
      WHEN (NEW.supervisor_id IS NOT OLD.supervisor_id OR NEW.org_id IS NOT OLD.org_id) AND ${outside}
      ${refuse('a supervisor must serve in the same Unit Instance')}`);
  }
}

/**
 * The tables that belong to a Unit Instance (org_id) and may name one of its units: its configuration (ADR-0012) and the
 * responsibilities held in it (ADR-0017), where this database has them.
 */
const orgUnitTables = (db: Db) => (['unit_billets', 'training_requirements', 'personnel_responsibilities'] as const).filter((t) => columnsOf(db, t).has('unit_id') && columnsOf(db, t).has('org_id'));
const billetOrg = (id: string) => `(SELECT org_id FROM unit_billets WHERE id = ${id})`;
const typeOrg = (id: string) => `(SELECT org_id FROM error_report_types WHERE id = ${id})`;
const caseUnit = (id: string) => `(SELECT unit_id FROM work_items WHERE id = ${id})`;
const dutyTypeOrg = (id: string) => `(SELECT org_id FROM duty_types WHERE id = ${id})`;
/** The tables a comment may hang on in this database, by what it names them. */
const COMMENT_HOSTS = ['activities', 'awards', 'trainings', 'counselings', 'tasks', 'projects', 'goals', 'duties', 'work_items'] as const;
/** The unit of the record a comments row (aliased `row`) hangs on, as SQL. */
const commentHostUnit = (db: Db, row: string) => `(CASE ${row}.record_table ${COMMENT_HOSTS.filter((t) => columnsOf(db, t).has('unit_id'))
  .map((t) => `WHEN '${t}' THEN (SELECT unit_id FROM ${t} WHERE id = ${row}.record_id)`).join(' ')} END)`;
/** The Marine (or owner) of the record a comments row (aliased `row`) hangs on, as SQL. */
const commentHostOwner = (db: Db, row: string) => `(CASE ${row}.record_table ${COMMENT_HOSTS.filter((t) => columnsOf(db, t).has(t === 'work_items' ? 'owner_id' : 'user_id'))
  .map((t) => `WHEN '${t}' THEN (SELECT ${t === 'work_items' ? 'owner_id' : 'user_id'} FROM ${t} WHERE id = ${row}.record_id)`).join(' ')} END)`;
const scoringOrg = (id: string) => `(SELECT org_id FROM duty_scoring_policies WHERE id = ${id})`;

/**
 * Rows already joined across the boundary, by kind, leaving out the kinds with none. Migration 016 records what it found
 * on the way in, and an instance archive that brings any is refused, so neither is a silent pass (ADR-0008).
 */
export function instanceBoundaryViolations(db: Db): Record<string, number> {
  const checks: Record<string, string> = {
    ...Object.fromEntries(filedUnderProjects(db).map((t) => [`${t}_project`, `SELECT COUNT(*) AS n FROM ${t} x JOIN projects p ON p.id = x.project_id WHERE ${across('x.unit_id', 'p.unit_id')}`])),
    threads_contact: `SELECT COUNT(*) AS n FROM threads t JOIN contacts c ON c.id = t.contact_id WHERE ${across('t.unit_id', 'c.unit_id')}`,
    thread_links: `SELECT COUNT(*) AS n FROM thread_links l JOIN threads t ON t.id = l.thread_id JOIN work_items w ON w.id = l.work_item_id WHERE ${across('t.unit_id', 'w.unit_id')}`,
    ...Object.fromEntries(orgUnitTables(db).map((t) => [`${t}_unit`, `SELECT COUNT(*) AS n FROM ${t} x WHERE x.unit_id IS NOT NULL AND ${orgOf('x.unit_id')} <> x.org_id`])),
    ...(columnsOf(db, 'unit_members').has('billet_id') ? { unit_members_billet: `SELECT COUNT(*) AS n FROM unit_members m JOIN unit_billets b ON b.id = m.billet_id WHERE b.org_id <> ${orgOf('m.unit_id')}` } : {}),
    ...(columnsOf(db, 'error_snapshots').has('type_id') ? {
      error_snapshots: `SELECT COUNT(*) AS n FROM error_snapshots s LEFT JOIN source_files f ON f.id = s.source_file_id
        WHERE ${orgOf('s.unit_id')} <> s.org_id OR ${typeOrg('s.type_id')} <> s.org_id OR ${orgOf('f.unit_id')} <> s.org_id`,
    } : {}),
    ...(columnsOf(db, 'case_guidance').has('work_item_id') ? {
      case_guidance: `SELECT COUNT(*) AS n FROM case_guidance g LEFT JOIN work_items w ON w.id = g.work_item_id LEFT JOIN case_guidance p ON p.id = g.supersedes_id
        WHERE (g.work_item_id IS NOT NULL AND (${orgOf('w.unit_id')} IS NOT g.org_id OR w.unit_id IS NOT g.unit_id))
          OR (g.supersedes_id IS NOT NULL AND p.org_id IS NOT g.org_id)`,
    } : {}),
    ...(columnsOf(db, 'duties').has('duty_type_id') ? {
      duties: `SELECT COUNT(*) AS n FROM duties d LEFT JOIN duty_types t ON t.id = d.duty_type_id LEFT JOIN duty_scoring_policies p ON p.id = d.scoring_policy_id
        WHERE ${orgOf('d.unit_id')} <> t.org_id OR ${orgOf('d.unit_id')} <> p.org_id`,
    } : {}),
    ...(columnsOf(db, 'duty_reviews').has('duty_id') ? {
      duty_reviews: `SELECT COUNT(*) AS n FROM duty_reviews r JOIN duties d ON d.id = r.duty_id WHERE ${orgOf('r.unit_id')} IS NOT ${orgOf('d.unit_id')}`,
    } : {}),
    ...(columnsOf(db, 'counseling_revisions').has('counseling_id') ? {
      counseling_revisions: `SELECT COUNT(*) AS n FROM counseling_revisions r JOIN counselings c ON c.id = r.counseling_id WHERE ${orgOf('r.unit_id')} IS NOT ${orgOf('c.unit_id')}`,
    } : {}),
    // What someone other than the record's Marine said, in a Unit Instance the record is no longer in. A Marine's own
    // comments go with their record (ADR-0008), so they are not counted.
    ...(columnsOf(db, 'comments').has('reply_to') ? {
      comments: `SELECT COUNT(*) AS n FROM comments c WHERE c.deleted_at IS NULL AND c.unit_id IS NOT NULL
        AND c.author_id IS NOT ${commentHostOwner(db, 'c')} AND ${across('c.unit_id', commentHostUnit(db, 'c'))}`,
    } : {}),
    ...(columnsOf(db, 'personnel_records').has('supervisor_id') ? {
      personnel_records_supervisor: `SELECT COUNT(*) AS n FROM personnel_records r WHERE r.supervisor_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM unit_members sm JOIN units su ON su.id = sm.unit_id WHERE sm.user_id = r.supervisor_id AND su.org_id = r.org_id)`,
    } : {}),
  };
  const found: Record<string, number> = {};
  for (const [kind, sql] of Object.entries(checks)) {
    const { n } = db.prepare(sql).get() as { n: number };
    if (n) found[kind] = n;
  }
  return found;
}

/**
 * Lifts the boundary's triggers, for a caller that puts them back with `instanceBoundaryTriggers` in the same
 * transaction: an archive is restored table by table, so its rows are checked whole once they are all in.
 */
export function dropInstanceBoundaryTriggers(db: Db) {
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%cross_instance:%'").all() as Array<{ name: string }>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

const AUDIT_APPEND_ONLY_TRIGGERS = ['audit_log_no_update', 'audit_log_no_delete'] as const;

/**
 * The audit log is append-only, kept by the database as well as by the code (ADR-0013): an entry is never changed or
 * removed, so a defect or a hand-written statement cannot quietly rewrite the trail. The hash chain makes a rewrite
 * visible afterwards; these refuse it as it is tried. Each refusal begins `audit_append_only:`, which the API answers as
 * a refusal rather than a server error.
 */
export function auditAppendOnlyTriggers(db: Db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'audit_append_only: an audit entry is never changed'); END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'audit_append_only: an audit entry is never removed'); END`);
}

/**
 * Lifts the audit log's triggers for a caller that puts them back with `auditAppendOnlyTriggers` before its transaction
 * commits, so they are never missing outside it. Only three callers do: removing an expired demo workspace (a synthetic
 * database), loading an instance archive into a fresh instance, and scripts/start-over.ts. Outside a transaction it
 * refuses, so the log is never left open.
 */
export function dropAuditAppendOnlyTriggers(db: Db) {
  if (!db.inTransaction) throw new Error('The audit log is opened only inside a transaction that closes it again.');
  for (const name of AUDIT_APPEND_ONLY_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

const MEMBERSHIP_TRIGGERS = ['unit_membership_opened', 'unit_membership_changed', 'unit_membership_closed'] as const;
const AT_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Membership history is written by the database (ADR-0009), so no way of joining, moving or leaving a unit (a route, the
 * personnel feed, an import, a script) can change unit_members without leaving its period behind. The service fills in
 * why and by whom afterwards, in the same transaction (server/services/membership.ts).
 */
export function membershipHistoryTriggers(db: Db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_membership_opened AFTER INSERT ON unit_members FOR EACH ROW
    BEGIN
      UPDATE unit_membership_periods SET ended_at = NEW.joined_at, end_reason = 'superseded'
       WHERE user_id = NEW.user_id AND unit_id = NEW.unit_id AND ended_at IS NULL;
      INSERT INTO unit_membership_periods (user_id, unit_id, billet, is_primary, started_at, started_by)
      VALUES (NEW.user_id, NEW.unit_id, NEW.billet, NEW.is_primary, NEW.joined_at, NEW.invited_by);
    END`);
  // A new billet or a primary flag that moved closes one period and opens the next; an update that changes neither is no change.
  const why = "CASE WHEN OLD.billet IS NOT NEW.billet THEN 'billet_changed' ELSE 'primary_changed' END";
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_membership_changed AFTER UPDATE OF billet, is_primary ON unit_members FOR EACH ROW
    WHEN OLD.billet IS NOT NEW.billet OR OLD.is_primary IS NOT NEW.is_primary
    BEGIN
      UPDATE unit_membership_periods SET ended_at = ${AT_NOW}, end_reason = ${why}
       WHERE user_id = OLD.user_id AND unit_id = OLD.unit_id AND ended_at IS NULL;
      INSERT INTO unit_membership_periods (user_id, unit_id, billet, is_primary, started_at, start_reason)
      VALUES (NEW.user_id, NEW.unit_id, NEW.billet, NEW.is_primary, ${AT_NOW}, ${why});
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_membership_closed AFTER DELETE ON unit_members FOR EACH ROW
    BEGIN
      UPDATE unit_membership_periods SET ended_at = ${AT_NOW}
       WHERE user_id = OLD.user_id AND unit_id = OLD.unit_id AND ended_at IS NULL;
    END`);
}

/** Lifted while an instance archive loads, which brings its own history, and put back before it commits. */
export function dropMembershipHistoryTriggers(db: Db) {
  for (const name of MEMBERSHIP_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

/** Every current membership with no open period gets one from its joined date: memberships older than the history. */
export function openMissingMembershipPeriods(db: Db): number {
  return db.prepare(`INSERT INTO unit_membership_periods (user_id, unit_id, billet, is_primary, started_at, start_reason, started_by)
    SELECT um.user_id, um.unit_id, um.billet, um.is_primary, um.joined_at, 'recorded', um.invited_by FROM unit_members um
     WHERE NOT EXISTS (SELECT 1 FROM unit_membership_periods p WHERE p.user_id = um.user_id AND p.unit_id = um.unit_id AND p.ended_at IS NULL)`).run().changes;
}

const PERSONNEL_TRIGGERS = ['personnel_profile_changed', 'personnel_record_opened', 'personnel_record_changed', 'personnel_assignment_dated', 'personnel_assignment_opened'] as const;

/**
 * A Marine's personnel history is written by the database (ADR-0017), as their membership history is (ADR-0009): rank,
 * MOS, EAS and account status on the account, supervisor and check-in in each Unit Instance, and the dates of each
 * assignment. Whatever changes one of them (the person, a leader, the personnel feed, Vantage support, a script) leaves a
 * row; the service names who, how and why afterwards (server/services/personnelRecords.ts). A name is not tracked: it is
 * the person, not a personnel fact, and the audit trail says who changed it.
 */
export function personnelHistoryTriggers(db: Db) {
  const event = (columns: string, values: string, when: string) =>
    `INSERT INTO personnel_events (${columns}, at) SELECT ${values}, ${AT_NOW} WHERE ${when};`;
  const profile = (field: string, column: string) => event('user_id, field, from_value, to_value', `NEW.id, '${field}', OLD.${column}, NEW.${column}`, `OLD.${column} IS NOT NEW.${column}`);
  const status = (v: string) => `CASE ${v} WHEN 1 THEN 'active' ELSE 'deactivated' END`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_profile_changed AFTER UPDATE OF rank_id, mos, eas, active ON users FOR EACH ROW
    WHEN OLD.rank_id IS NOT NEW.rank_id OR OLD.mos IS NOT NEW.mos OR OLD.eas IS NOT NEW.eas OR OLD.active IS NOT NEW.active
    BEGIN
      ${profile('rank', 'rank_id')}
      ${profile('mos', 'mos')}
      ${profile('eas', 'eas')}
      ${event('user_id, field, from_value, to_value', `NEW.id, 'account', ${status('OLD.active')}, ${status('NEW.active')}`, 'OLD.active IS NOT NEW.active')}
    END`);
  const record = (field: string, column: string, when: string, from: string) =>
    event('user_id, org_id, field, from_value, to_value', `NEW.user_id, NEW.org_id, '${field}', ${from}, NEW.${column}`, when);
  db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_record_opened AFTER INSERT ON personnel_records FOR EACH ROW
    BEGIN
      ${record('supervisor', 'supervisor_id', 'NEW.supervisor_id IS NOT NULL', 'NULL')}
      ${record('checked_in', 'checked_in_on', 'NEW.checked_in_on IS NOT NULL', 'NULL')}
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_record_changed AFTER UPDATE OF supervisor_id, checked_in_on ON personnel_records FOR EACH ROW
    WHEN OLD.supervisor_id IS NOT NEW.supervisor_id OR OLD.checked_in_on IS NOT NEW.checked_in_on
    BEGIN
      ${record('supervisor', 'supervisor_id', 'OLD.supervisor_id IS NOT NEW.supervisor_id', 'OLD.supervisor_id')}
      ${record('checked_in', 'checked_in_on', 'OLD.checked_in_on IS NOT NEW.checked_in_on', 'OLD.checked_in_on')}
    END`);
  const dated = (field: string) => event('user_id, org_id, unit_id, field, from_value, to_value',
    `NEW.user_id, ${orgOf('NEW.unit_id')}, NEW.unit_id, '${field}', OLD.${field}, NEW.${field}`, `OLD.${field} IS NOT NEW.${field}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_assignment_dated AFTER UPDATE OF assignment_start, assignment_end ON unit_members FOR EACH ROW
    WHEN OLD.assignment_start IS NOT NEW.assignment_start OR OLD.assignment_end IS NOT NEW.assignment_end
    BEGIN
      ${dated('assignment_start')}
      ${dated('assignment_end')}
    END`);
  // A membership that begins with its dates (a script, an import tool) records them as set from nothing (025).
  const opened = (field: string) => event('user_id, org_id, unit_id, field, from_value, to_value',
    `NEW.user_id, ${orgOf('NEW.unit_id')}, NEW.unit_id, '${field}', NULL, NEW.${field}`, `NEW.${field} IS NOT NULL`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS personnel_assignment_opened AFTER INSERT ON unit_members FOR EACH ROW
    WHEN NEW.assignment_start IS NOT NULL OR NEW.assignment_end IS NOT NULL
    BEGIN
      ${opened('assignment_start')}
      ${opened('assignment_end')}
    END`);
}

/**
 * A billet stays where its holders are (ADR-0017). One that a Marine holds in a unit is not narrowed to another unit,
 * which would leave a membership holding a billet its unit does not have. The Unit Manager console refuses it first
 * (server/services/unitConfig.ts); this refuses any other writer. Moving it to another Unit Instance is refused by the
 * instance boundary.
 */
export function billetHolderTriggers(db: Db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_billets_holders_fit BEFORE UPDATE OF unit_id ON unit_billets FOR EACH ROW
    WHEN NEW.unit_id IS NOT NULL AND NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM unit_members m WHERE m.billet_id = NEW.id AND m.unit_id <> NEW.unit_id)
    BEGIN SELECT RAISE(ABORT, 'billet_held: a Marine in another unit holds this billet'); END`);
}

/** Lifted while an instance archive loads, which brings its own personnel history, and put back before it commits. */
export function dropPersonnelHistoryTriggers(db: Db) {
  for (const name of PERSONNEL_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

/**
 * The move history names duty once there is a duty record (migration 031, ADR-0023). SQLite cannot widen a CHECK in
 * place, so a history from before it is copied into the table as schema.sql defines it now, every row and its order
 * (rowid) kept, and the old one dropped. A history that already names duty is left as it is.
 */
export function widenRecordLineage(db: Db) {
  const current = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'record_lineage'").get() as { sql: string } | undefined)?.sql;
  if (!current || current.includes("'duties'")) return;
  const definition = /CREATE TABLE IF NOT EXISTS record_lineage \([\s\S]*?\n\);/.exec(SCHEMA)?.[0];
  if (!definition) throw new Error('schema.sql does not define record_lineage');
  db.exec(definition.replace('CREATE TABLE IF NOT EXISTS record_lineage (', 'CREATE TABLE record_lineage_031 ('));
  const kept = [...columnsOf(db, 'record_lineage')].filter((c) => columnsOf(db, 'record_lineage_031').has(c));
  db.exec(`INSERT INTO record_lineage_031 (rowid, ${kept.join(', ')}) SELECT rowid, ${kept.join(', ')} FROM record_lineage ORDER BY rowid`);
  db.exec('DROP TABLE record_lineage');
  db.exec('ALTER TABLE record_lineage_031 RENAME TO record_lineage');
  for (const index of SCHEMA.match(/CREATE INDEX IF NOT EXISTS idx_record_lineage_\w+ ON record_lineage\([^)]*\);/g) ?? []) db.exec(index);
}

/** A time of day as the columns hold it, HH:MM on a 24-hour clock; schema.sql says the same. */
const timeOfDayCheck = (column: string) => `${column} IS NULL OR ${column} GLOB '[01][0-9]:[0-5][0-9]' OR ${column} GLOB '2[0-3]:[0-5][0-9]'`;

/** The record types whose timeframe columns this database has: all of them once 026 has run. */
const timeframedTables = (db: Db) => (Object.keys(TIMEFRAMES) as TimeframedTable[]).filter((table) => {
  const have = columnsOf(db, table);
  return timeframeColumns(table).every((column) => have.has(column));
});

/**
 * Whether `row` (NEW in a trigger, a table alias in a count) breaks its timeframe: the same rules as timeframeProblems in
 * shared/timeframe.ts, which the server and the forms apply first with words for each field. The days compare as
 * calendar days, as there.
 */
function timeframeBreach(table: TimeframedTable, row: string): string {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  const start = `${row}.${spec.start}`, end = `${row}.${spec.end}`;
  const startDay = `substr(${start}, 1, 10)`, endDay = `substr(${end}, 1, 10)`;
  const breaches = [`(${start} IS NOT NULL AND ${end} IS NOT NULL AND ${endDay} < ${startDay})`];
  if (!spec.open) breaches.push(`(${end} IS NOT NULL AND ${start} IS NULL)`);
  if (spec.ongoing) breaches.push(`(${row}.ongoing = 1 AND (${start} IS NULL OR ${end} IS NOT NULL${spec.times ? ` OR ${row}.end_time IS NOT NULL` : ''}))`);
  if (spec.times) {
    breaches.push(`((${row}.start_time IS NOT NULL OR ${row}.end_time IS NOT NULL) AND ${start} IS NULL)`);
    breaches.push(`(${row}.start_time IS NOT NULL AND ${row}.end_time IS NOT NULL AND ${start} IS NOT NULL AND (${end} IS NULL OR ${endDay} = ${startDay})${spec.ongoing ? ` AND ${row}.ongoing = 0` : ''} AND ${row}.end_time < ${row}.start_time)`);
  }
  return `(${breaches.join(' OR ')})`;
}

/**
 * A record does not end before it starts (ADR-0018), whoever writes it: a route, an import, the personnel feed, a script.
 * The server refuses it first with words for each field (shared/timeframe.ts); these refuse any other writer, each
 * refusal beginning `timeframe:`, which the API answers as a refusal of the request rather than a server error. A change
 * that leaves the dates alone is not checked, so a row already out of order before 026 can still be edited in its other
 * fields; changing its dates asks for them in order.
 */
export function timeframeTriggers(db: Db) {
  for (const table of timeframedTables(db)) {
    const columns = timeframeColumns(table);
    const refuse = `BEGIN SELECT RAISE(ABORT, 'timeframe: a record in ${table} cannot end before it starts'); END`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_timeframe_written BEFORE INSERT ON ${table} FOR EACH ROW
      WHEN ${timeframeBreach(table, 'NEW')} ${refuse}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_timeframe_changed BEFORE UPDATE OF ${columns.join(', ')} ON ${table} FOR EACH ROW
      WHEN (${columns.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')}) AND ${timeframeBreach(table, 'NEW')} ${refuse}`);
  }
}

/** Lifted while an instance archive loads, which is counted whole once it is in, and put back before it commits. */
export function dropTimeframeTriggers(db: Db) {
  for (const table of Object.keys(TIMEFRAMES)) for (const when of ['written', 'changed']) db.exec(`DROP TRIGGER IF EXISTS ${table}_timeframe_${when}`);
}

/** Rows whose timeframe is out of order, by record type, leaving out the types with none. */
export function timeframeViolations(db: Db): Record<string, number> {
  const found: Record<string, number> = {};
  for (const table of timeframedTables(db)) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table} x WHERE ${timeframeBreach(table, 'x')}`).get() as { n: number };
    if (n) found[table] = n;
  }
  return found;
}

/**
 * Links each membership whose billet reads as exactly one active billet of its Unit Instance (one of its own unit's
 * first, then one for every unit) to that billet, as the Unit Manager console has matched them by title until now. Any
 * other keeps its title and no link. Run by migration 024 and by an archive import from before it.
 */
export function linkBilletsByTitle(db: Db): number {
  const match = (select: string, unitClause: string) => `SELECT ${select} FROM unit_billets b JOIN units un ON un.id = unit_members.unit_id
     WHERE b.active = 1 AND b.org_id = un.org_id AND ${unitClause} AND lower(b.title) = lower(trim(unit_members.billet))`;
  const link = (unitClause: string) => db.prepare(`UPDATE unit_members SET billet_id = (${match('b.id', unitClause)})
     WHERE billet_id IS NULL AND billet IS NOT NULL AND (${match('COUNT(*)', unitClause)}) = 1`).run().changes;
  return link('b.unit_id = unit_members.unit_id') + link('b.unit_id IS NULL');
}

/**
 * Who entered each award that does not say yet: the actor of its create entry in the audit trail, which for a leader's
 * recommendation is the leader (subject_id names the Marine). An award no entry names, seeded or imported without one,
 * is taken as its owner's own (ADR-0015). So is one its owner has since made private: before 023 they could, and a
 * leader is never handed a Marine's private entry. Run by migration 023 and by an archive import from before it.
 *
 * The trail is read once, joined to the awards, rather than asked once per award: it has no index by entity, and the
 * per-award question grows with both.
 */
export function backfillAwardRecorders(db: Db) {
  const named = db.prepare(`UPDATE awards SET recorded_by = CASE WHEN awards.visibility = 'unit' THEN first.actor_id ELSE awards.user_id END
      FROM (SELECT entity_id AS award_id, actor_id FROM (
              SELECT a.entity_id, a.actor_id, ROW_NUMBER() OVER (PARTITION BY a.entity_id ORDER BY a.seq) AS n
                FROM audit_log a JOIN users u ON u.id = a.actor_id
               WHERE a.action = 'create' AND a.entity = 'awards' AND a.entity_id IS NOT NULL)
             WHERE n = 1) AS first
     WHERE first.award_id = awards.id AND awards.recorded_by IS NULL`).run().changes;
  return named + db.prepare('UPDATE awards SET recorded_by = user_id WHERE recorded_by IS NULL').run().changes;
}

/** The record types that take attachments, each with the unit its row sits in. */
const ATTACHMENT_HOSTS = ['activities', 'awards', 'counselings', 'trainings', 'tasks', 'projects', 'goals', 'duties'] as const;

/**
 * Files attached before they kept a unit take the one their record sits in now. For a record moved before the boundary
 * was kept that is where the file is already read, so nothing new crosses; one in no unit keeps none, and a move is then
 * judged by whether its uploader serves where it goes (ADR-0008).
 */
export function stampAttachmentUnits(db: Db) {
  for (const table of ATTACHMENT_HOSTS) {
    db.prepare(`UPDATE attachments SET unit_id = (SELECT r.unit_id FROM ${table} r WHERE r.id = attachments.record_id) WHERE record_table = ? AND unit_id IS NULL`).run(table);
  }
}

function isLegacyDatabase(db: Db): boolean {
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!hasUsers) return false;
  const columns = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
  return !columns.includes('is_operator');
}

/**
 * A copy of a database that is the service's alone from its first page (ADR-0040): the file is made owner-only before
 * SQLite writes a byte to it, so no other account on the host reads the copy while it is drawn, and a copy that fails is
 * removed when this call made the file. Every copy the service or its scripts take comes through here.
 */
export async function backupDatabase(db: { backup: (destination: string) => Promise<unknown> }, dest: string): Promise<void> {
  const existed = existsSync(dest);
  writeFileSync(dest, '', { flag: 'a', mode: 0o600 });
  chmodSync(dest, 0o600);
  try { await db.backup(dest); }
  catch (error) {
    if (!existed) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${dest}${suffix}`, { force: true });
    throw error;
  }
  chmodSync(dest, 0o600);
}

/**
 * A database file copied as its bytes, for one SQLite cannot read through (ADR-0040): owner-only before the first byte,
 * whatever the source's mode, since copyFile gives the copy the source's permissions. A copy that fails is removed.
 * Closing any descriptor on a file drops every POSIX lock this process holds on it, a SQLite lock included, so a copy
 * of a database this process holds locked passes `keepOpen`: the source's descriptor is added to it, still open, for
 * the caller to close once the lock may go.
 */
export function copyFilePrivate(src: string, dest: string, keepOpen?: number[]): void {
  const out = openSync(dest, 'w', 0o600);
  try {
    fchmodSync(out, 0o600);
    const input = openSync(src, 'r');
    keepOpen?.push(input);
    try {
      const chunk = Buffer.allocUnsafe(1 << 20);
      for (let n = readSync(input, chunk, 0, chunk.length, 0), at = 0; n > 0; at += n, n = readSync(input, chunk, 0, chunk.length, at)) {
        for (let w = 0; w < n;) w += writeSync(out, chunk, w, n - w);
      }
    } finally { if (!keepOpen) closeSync(input); }
  } catch (error) {
    closeSync(out);
    rmSync(dest, { force: true });
    throw error;
  }
  closeSync(out);
}

export interface OpenOptions {
  /**
   * Where the copy kept before an upgrade goes and how many are kept (ADR-0041). `false` only for a database that is a
   * scratch copy already, as the restore drill's is; a start always keeps one.
   */
  upgradeCopy?: UpgradeCopyOptions | false;
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  // The database holds every personnel record, sealed secret and audit entry: its directory and file are this service's
  // alone, and SQLite gives the WAL and shared-memory files the database file's own permissions.
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let db = new Database(path);
  if (path !== ':memory:') { try { chmodSync(path, 0o600); } catch { /* a file this account does not own keeps the host's permissions */ } }
  // Refuse an unknown/newer schema before applying even the idempotent base DDL. An older binary must not silently
  // open a database written by a newer release, nor treat damaged version metadata as an empty database.
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const storedVersion = hasMeta ? metaGet(db, 'schema_version') : null;
  if (storedVersion !== null && (!/^\d+$/.test(storedVersion) || Number(storedVersion) > SCHEMA_VERSION)) {
    db.close();
    throw new Error(`Database schema ${storedVersion} is invalid or newer than this build's ${SCHEMA_VERSION}. Use the matching build or the supported restore procedure.`);
  }
  let from = storedVersion === null ? 0 : Number(storedVersion);
  // A database that already holds anything outside its settings but records no schema is not a new one: which migrations
  // it ran cannot be told, so it is neither copied nor migrated as if it were empty (ADR-0041). A new database has rows in
  // no table but meta until its first migration records schema 1; the base schema creates tables and inserts nothing.
  if (path !== ':memory:' && from === 0 && !isLegacyDatabase(db)) {
    const tables = (db.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name <> 'meta' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    const held = tables.flatMap((name) => {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number }).n;
      return n ? [`${n} in ${name}`] : [];
    });
    if (held.length) {
      db.close();
      throw new Error(`The database at ${path} holds rows (${held.slice(0, 5).join(', ')}${held.length > 5 ? `, and ${held.length - 5} more tables` : ''}) but records no schema version, so this build cannot tell which migrations it has run. Nothing was migrated. Restore the last good backup with node scripts/restore.ts, then start again.`);
    }
  }
  if (path !== ':memory:' && isLegacyDatabase(db)) {
    db.close();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${path}.legacy-${stamp}${suffix}`);
    console.warn(`Found a pre-5.0 Vantage database at ${path}. It was moved to ${path}.legacy-${stamp} and a fresh database was created. Restore it on a 4.x build if you need its contents.`);
    db = new Database(path);
    try { chmodSync(path, 0o600); } catch { /* as above */ }
    from = 0;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Sorts and scratch tables in memory, and a larger page cache: faster, and no change to what is durable.
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000');
  // What is deleted is overwritten where it lay, so a removed record's text is not left readable on a free page of the
  // file or of a copy taken from it (ADR-0042). It holds for this connection; Compact clears what was deleted before.
  db.pragma('secure_delete = ON');
  // A database this build is about to upgrade is checked and copied as the last build left it, before even the base
  // schema is replayed over it (ADR-0041). Anything wrong stops the start here, with nothing migrated.
  let copy: UpgradeCopy | null = null;
  if (path !== ':memory:' && options.upgradeCopy !== false && from > 0 && from < SCHEMA_VERSION) {
    // A start after a failed upgrade keeps the copy that start took, while the copy is unchanged and nothing was written
    // to the database since: a restore, or the previous build serving it, makes the next start take a copy of its own.
    // The copies failed starts named since the last upgrade that completed are never pruned.
    const history = upgradeHistory(db);
    const last = history.at(-1);
    const kept = last?.status === 'failed' && last.copy && last.left && sameState(last.left, databaseState(db)) ? last.copy : null;
    const protect = history.slice(history.findLastIndex((r) => r.status !== 'failed') + 1).flatMap((r) => (r.copy ? [r.copy.file] : []));
    try { copy = copyBeforeUpgrade(db, path, from, SCHEMA_VERSION, { ...(options.upgradeCopy ?? {}), kept, protect }); }
    catch (error) { db.close(); throw error; }
  }
  upgradeSchema(db, { copy });
  // Refresh the planner's statistics where they have gone stale; SQLite's advice for a long-lived connection.
  db.pragma('optimize = 0x10002');
  cacheStatements(db);
  return db;
}

/**
 * What a start does to the schema, in order: the base schema replayed (it only creates what is missing), the migrations
 * the database has not run, the audit log made append-only again and the ranks seeded. Exported so the database fixtures
 * can run a changed list of migrations exactly as a start runs this build's (ADR-0041).
 */
export function upgradeSchema(db: Db, options: { migrations?: readonly Migration[]; copy?: UpgradeCopy | null } = {}) {
  db.exec(SCHEMA);
  migrate(db, options.migrations ?? MIGRATIONS, options.copy ?? null);
  // The audit log is append-only on every start, not only from the migration that first made it so (ADR-0013): a
  // database restored or copied without the triggers gets them back before anything is served.
  auditAppendOnlyTriggers(db);
  seed(db);
}

/**
 * Compiling SQL was the largest single cost of a request: the code prepares its statements where it uses
 * them, so the same text was compiled again on every call. The connection now keeps what it compiled and
 * hands the same statement back. Nothing puts a statement into a special mode (pluck, raw, expand), and a
 * statement that is iterated has SQL text no other code prepares (the audit chain walk), so a shared statement
 * always behaves like a fresh one. Bounded, because a few
 * statements are built with a variable number of placeholders.
 */
function cacheStatements(db: Db, limit = 1000) {
  const compile = db.prepare.bind(db);
  const cache = new Map<string, Database.Statement>();
  db.prepare = ((sql: string) => {
    let statement = cache.get(sql);
    if (statement) { cache.delete(sql); cache.set(sql, statement); return statement; }
    statement = compile(sql);
    cache.set(sql, statement);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
    return statement;
  }) as Db['prepare'];
}

/**
 * Runs what the database has not run yet, each migration in a transaction of its own with its record in the history
 * (`migration_history`), so a migration and the note that it ran land together or not at all. A database that ran its
 * migrations before the history was kept says from when, and at which schema, it has been kept (`migration_history_since`).
 * Every database is named once (`database_id`), so a restore can tell a copy of this database from another one (ADR-0014).
 */
function migrate(db: Db, migrations: readonly Migration[], copy: UpgradeCopy | null) {
  if (!metaGet(db, 'database_id')) metaSet(db, 'database_id', randomUUID());
  const version = Number(metaGet(db, 'schema_version') || 0);
  if (!metaGet(db, 'migration_history_since')) metaSet(db, 'migration_history_since', JSON.stringify({ at: new Date().toISOString(), schema: version }));
  // A new database is audited as created at its schema, not as every migration it ran to get there (auditMigrations).
  if (version === 0 && !metaGet(db, 'migration_audited_through')) metaSet(db, 'migration_audited_through', NEW_DATABASE);
  // One an older build migrated has audited nothing yet: every migration this start runs is audited, from the schema it
  // began at, and never fewer than from AUDITED_FROM.
  if (version > 0 && version < migrations.at(-1)!.id && !metaGet(db, 'migration_audited_through')) metaSet(db, 'migration_audited_through', String(Math.min(version, AUDITED_FROM - 1)));
  runMigrations(db, migrations.filter((m) => m.id > version), version, copy);
}

/**
 * Runs these migrations in order from the schema the database is at. A database that already held data is counted before
 * and after, table by table and Unit Instance by Unit Instance, and the result goes in its upgrade history; a migration
 * that throws is recorded there with its error, and the error is thrown on so the start stops (ADR-0014). Exported so
 * the tests can run a migration this build does not carry.
 */
export function runMigrations(db: Db, pending: readonly Migration[], from: number, copy: UpgradeCopy | null = null): UpgradeRecord | null {
  if (!pending.length) return null;
  const started = performance.now();
  const verify = from > 0;
  const before = verify ? rowCounts(db) : null;
  let failed: UpgradeRecord['failed'];
  let failure: unknown = null;
  const ran: number[] = [];
  for (const m of pending) {
    const begun = performance.now();
    try {
      db.transaction(() => {
        m.run(db);
        metaSet(db, 'schema_version', String(m.id));
        const run: MigrationRun = { id: m.id, name: m.name, at: new Date().toISOString(), ms: Math.round(performance.now() - begun), version: VERSION };
        metaSet(db, 'migration_history', JSON.stringify([...migrationHistory(db), run].slice(-MIGRATION_HISTORY_KEPT)));
      })();
      ran.push(m.id);
    } catch (error) {
      failed = { id: m.id, name: m.name, error: String((error as Error)?.message || error).slice(0, 500) };
      failure = error;
      break;
    }
  }
  if (!verify && !failed) return null;
  const after = verify ? rowCounts(db) : null;
  const { service, instances } = before && after ? compareCounts(before, after, new Set(pending.flatMap((m) => m.reshapes ?? []))) : { service: [], instances: [] };
  const record = recordUpgrade(db, {
    id: randomUUID(), at: new Date().toISOString(), kind: 'schema', version: VERSION,
    schema: { from, to: Number(metaGet(db, 'schema_version') || 0) },
    status: failed ? 'failed' : upgradeStatus(service, instances),
    ms: Math.round(performance.now() - started), migrations: ran, ...(failed ? { failed, left: databaseState(db) } : {}),
    service, instances, checked: before ? Object.keys(before.tables).length : 0, audited: false, reviewed: null,
    ...(copy ? { copy } : {}),
  });
  if (failure) {
    const back = !copy ? 'Restore the backup taken before the upgrade'
      : copy.trail?.ok === false ? `The copy taken before the upgrade, ${copy.file}, has an audit trail that does not verify, as this database's did not, so a restore refuses it: restore the last backup whose trail verifies`
        : `Restore the copy taken before the upgrade, ${copy.file} (beside the database, or in VANTAGE_UPGRADE_COPY_DIR)`;
    console.error(`Migration ${failed!.name} failed and was rolled back; the database stays at schema ${record.schema.to}. The upgrade history records it. ${back}, or run the build this database last ran.`);
    throw failure;
  }
  if (record.status === 'changed') console.warn(`The upgrade to schema ${record.schema.to} left fewer rows in ${record.service.map((c) => c.table).join(', ') || 'some Unit Instances'}. Review it under Operations in the Vantage Administrator console before relying on the data.`);
  return record;
}

/** The migrations this database ran since it began keeping a history, oldest first. */
export function migrationHistory(db: Db): MigrationRun[] {
  try {
    const parsed = JSON.parse(metaGet(db, 'migration_history') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function seed(db: Db) {
  const insert = db.prepare(
    `INSERT INTO ranks (id, grade, abbr, name, tier, sort) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET grade = excluded.grade, name = excluded.name, tier = excluded.tier, sort = excluded.sort`
  );
  db.transaction(() => { for (const r of RANKS) insert.run(r.abbr, r.grade, r.abbr, r.name, r.tier, r.sort); })();
}

export const metaGet = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
export const metaSet = (db: Db, key: string, value: string) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
