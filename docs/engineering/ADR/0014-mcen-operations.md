# ADR-0014 · MCEN operations: versions, health, backup, restore and feature flags per Unit Instance

**Status:** accepted · **Date:** 2026-10-15 · **Builds on:** [ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md),
[ADR-0011](0011-vantage-administrator-console-operations.md), [ADR-0013](0013-security-audit-least-privilege.md)

## Context

Task 8 of the governing specification (VANTAGE_CLAUDE_MASTER.md) is MCEN operations, at P0. It asks Vantage to
track, for each Unit Instance:

- the app version;
- the schema version;
- the last upgrade;
- the upgrade status;
- the health status;
- backup freshness.

It also asks Vantage to keep **user data export and import** separate from **infrastructure backup and
restore**, and to make **restore privileged and audited**.

What Tasks 5 and 7 left:

- **The service, but not each Unit Instance.** ADR-0011 built the service's health report, its build and the
  releases it has run, the migration history, a backup log (`npm run backup` and console downloads) and
  maintenance mode. None of it says anything about one Unit Instance.
- **Migrations audited, but not checked.** ADR-0013 audits each migration as `schema_migrated`. Nothing says
  whether an upgrade kept everyone's data.
- **Restore by hand.** The run book said to start maintenance, copy a `.db` file over the live one and restart.
  ADR-0013 left this open: the application cannot see a restore made on the host, and a backup taken with
  `npm run backup` was recorded but never audited, because the script has no chain key.
- **Exports mixed in with backups.** The console page was called "Backup and recovery". The service archive,
  the database backup and a dozen exports for one Unit Instance, unit or person were described side by side.
  The import routes would read a database file or the service archive as if it were their own format.
- **Service-wide flags only.** ADR-0011 held per-instance flags back as "Not now": a flag per instance would
  let staff change how one command works without its Unit Managers.

Two topologies decide what "per Unit Instance" means (ADR-0007, I-13):

- **Shared:** one service and database hold many Unit Instances. Every Unit Instance runs the same build and
  schema, so those fields agree across the list. What differs is what each one went through and what each
  holds: whether an upgrade lost its rows, whether the newest backup holds it at all, how much it has done
  since, whether it was restored, and what is withheld from it.
- **Dedicated:** the deployment holds exactly one Unit Instance. Its console lists one. A fleet view across
  dedicated deployments needs each host to report, which is what `npm run operations-report` is for. Who
  aggregates those reports is MCEN's to say (I-34).

## Decision

### 1. One operations record per Unit Instance

`server/services/instanceOperations.ts` computes, for every Unit Instance or one:

| Field | Value | Source |
| --- | --- | --- |
| `version` | the Vantage version and build it runs, and since when | the release history (ADR-0011): the later of the current release's first start and the Unit Instance's creation |
| `schema` | database schema against this build's | `meta.schema_version`, `SCHEMA_VERSION` |
| `upgrade.last` | the newest release or schema upgrade since the Unit Instance was created | release history and upgrade history (§2); a schema upgrade within ten minutes of a release belongs with it |
| `upgrade.state` | `current`, `attention` (rows lost, not reviewed), `failed` (not reviewed), `ahead` or `behind` | §2 |
| `health` | its checks and their worst status | below |
| `backup` | `fresh`, `stale`, `never` or `not_yet`; age; audited actions since | §3 |
| `restore.last` | the newest restore or replacement since it was created | §4, §5 |
| `flags` | features withheld from it, with the reason | §7 |

Its health checks are its own, plus one for the service it runs on:

- **The service:** the service's health report reduced to one status. The full report stays for Vantage staff.
- **Status:** suspended or archived, with the reason.
- **Lead Unit Manager:** an active Unit Instance with none needs attention.
- **Upgrade:** failed, or rows lost, until a Vantage Administrator reviews it.
- **Backup:** none recorded, not in any backup yet, or older than `VANTAGE_BACKUP_MAX_AGE_HOURS`.
- **Email:** more of its mail failed than was sent in the last 24 hours.
- **Restore:** a restore in the last 14 days (a note), or a replacement outside the restore command (attention).
- **One per withheld feature** (a note).

It reads counts and dates only, never a record.

**Who sees it:**

- **Vantage staff** (`platform.view`) see every Unit Instance: `GET /api/platform/instances/operations`, and
  the Vantage Administrator console's **Unit Instance operations** page. The page has a summary, the service
  line, the last ten schema upgrades and a table of Unit Instances. Each opens to its detail.
  - Who authorized a restore is shown only to staff who hold the backups or read the audit trail
    (`platform.data` or `platform.audit`). This matches who may see who took a backup (ADR-0011).
- **A Unit Instance's role holders** (`org.view`) see their own: `GET /api/orgs/:orgId/operations`, and the
  Unit Manager console's **Operations** page.
  - The service check is one status with no detail.
  - Vantage staff appear by name, never by account id.
  - A failed migration appears by name, without the database's error, which is for Vantage staff.
  - A Unit Manager in another Unit Instance gets a 404.
- **Who authorized a restore** shows in the Vantage Administrator console only to holders of `platform.data` or
  `platform.audit`, as who took a backup does.
- **`npm run operations-report`** prints the same records as JSON (`vantage-operations/1`) on the host.
  - It opens the database read-only, starts nothing and writes nothing.
  - It refuses a database at another schema.
  - It reports the service check as "not checked here", because the service's own checks need the process.

### 2. Upgrades counted before and after, in every Unit Instance

`runMigrations` in `server/db/index.ts` wraps the migrations a start runs. Each still runs in its own
transaction, as before. On a database that already existed:

1. **It counts first.** `rowCounts` in `server/db/upgrades.ts` counts every table, and each Unit Instance's
   rows in it: by `org_id`, or by `unit_id` through `units.org_id`. Tables that churn, or hold only sessions
   and caches, are not counted: `sessions`, `tokens`, `email_queue`, `oidc_states`, `connector_auth_states`,
   `product_events`, `demo_workspaces` and `meta`.
2. **It counts again afterwards and compares.** A table that holds fewer rows than before, service-wide or in
   any one Unit Instance, is a change. A table that is gone counts as zero.
   - A migration that means to shrink a table says so in `reshapes`. Its falls are kept but marked intended,
     and do not change the status.
3. **It records the upgrade in `meta.upgrade_history`.** The record holds the version that ran it, the schema
   from and to, the status (`verified`, `changed` or `failed`), the time taken, the migrations run, the
   service's changes and each Unit Instance's. The last 50 upgrades are kept, with up to 200 Unit Instances
   each.
   - A host key like the release history, it is carried across an archive import and a restore.
4. **A migration that throws** is rolled back, as before. The record says which one failed and why. The error
   is logged and the start stops.

The running service audits each record once, in the same transaction that marks it audited (`auditUpgrades`):

- **`upgrade_verified`, `upgrade_rows_lost` or `upgrade_failed`** in the platform trail.
- **`upgrade_rows_lost` in each affected Unit Instance's trail**, as enterprise administration.
- **Notifications** to Vantage staff and to each affected Unit Instance's Lead Unit Managers, for a loss or a
  failure.

A Vantage Administrator (`platform.maintenance`) marks a failed or lossy upgrade reviewed:

- `POST /api/platform/upgrades/:id/review` takes a note of 10 to 500 characters.
- It is audited as `upgrade_reviewed`, in the platform trail and in each affected Unit Instance's.
- It refuses a verified upgrade, and a second review.
- Until it is reviewed, the Unit Instance shows the upgrade as needing attention.

**Why counts:**

- Comparing contents would cost a copy of the database on every start.
- Counts catch the loss that matters most in an upgrade, rows gone, per Unit Instance, in seconds.
- They do not catch a migration that rewrites values. The release's own tests are for that.

### 3. Backups that know what they hold

- **Each backup records the newest audit entry it holds** (`seq`), as `npm run backup` and the console
  download each take one.
  - The copy is switched out of WAL mode, so the backup is one self-contained file.
  - "Through audit entry N" is what a restore of it goes back to.
- **A backup taken on the server is audited** by the running service (`auditServerBackups`), at the next start
  and every five minutes. The record is written `audited: false` and marked in the same transaction as its
  `backup` entry.
  - The script cannot write the entry itself, because it does not hold the chain key. This closes the gap
    ADR-0013 left.
  - A console download is recorded and audited in one transaction.
- **Freshness is the Unit Instance's:**
  - `not_yet` when the Unit Instance was created after the newest backup, which therefore cannot bring it back;
  - otherwise `fresh` or `stale` against `VANTAGE_BACKUP_MAX_AGE_HOURS`, with how many of its audited actions
    came after the backup, which is what restoring that backup would undo.
- Snapshots the hosting environment takes on its own still never pass through Vantage (I-28).

### 4. Restore: on the host, privileged, checked and audited

`npm run restore`, which runs `scripts/restore.ts`, is the one way to put a database backup back:

```
VANTAGE_RESTORE=1 npm run restore -- REPLACE-DATABASE --from <backup.db> --by <username> --reason "<why>" \
  [--change <record>] [--different-database] [--dry-run]
```

**It is privileged three ways:**

- It runs on the host, under the service's own `VANTAGE_SECRET`.
- It names the Lead Vantage Administrator who authorized it (`--by`, an active `platform_roles.owner`, read
  from the live database or from the backup when the live one is unreadable) and why (`--reason`, 10 to 500
  characters). It optionally names the change or incident record (`--change`).
- It asks for both `VANTAGE_RESTORE=1` and the word `REPLACE-DATABASE`.

**It refuses unless all of these hold:**

- It can take the live database's exclusive lock, so the service is not running.
- The backup passes SQLite's `quick_check` and is a Vantage database.
- The backup's schema is one this build can run.
- Its chain key opens under the secret, and every entry of its audit trail verifies.
- It is the same database (by `database_id`, or by the hash at its newest entry), unless
  `--different-database` says otherwise.

**It never writes the backup.** It works on a private copy beside the live database, then:

1. Says what the restore undoes: the live database's audit entries after the backup, in total and per Unit
   Instance. It lists up to 25 changes to accounts, authority and holds (`RESTORE_REVIEW_ACTIONS`) with the
   account's username as the live database had it, because an account opened after the backup is gone with
   the restore. `--dry-run` stops here.
2. Keeps the live database as `vantage-before-restore-<stamp>.db` beside it.
3. In one transaction on the copy:
   - carries this host's histories over: releases, backups, upgrades, restores;
   - clears sessions, sign-in and email links, the mail queue and pending sign-in states;
   - cancels support approvals that were pending or approved;
   - appends its record to `meta.restore_history`, `audited: false`.
4. Renames the copy over the live database and writes the lineage (§5).

**At its next start the service audits it once (`auditRestores`):**

- `database_restored` in the platform trail, naming who authorized it, the host account that ran it, the
  change record, the reason and the safety copy.
- One `database_restored` in each active Unit Instance's trail, with how many of its own entries were undone.
- Notifications to Vantage staff, to each Unit Instance's Lead Unit Managers and to the authorizer.

**Importing a service archive** (the console's whole-service import) is recorded as a restore too
(`method: archive`), audited as `instance_import` as before, and refuses a data export (§6).

**Why not in the console:**

- Replacing the database a running service holds open cannot be made consistent from inside it.
- The host is where the stopped service, the secret and the backups are.
- The console shows the restores (**Backup and restore → Restores**), the command, and whether the lineage
  is kept.

### 5. A database put back any other way is noticed

The service keeps a lineage file beside the database (`<database>.lineage`, or `VANTAGE_LINEAGE_FILE`, `off`
to disable).

- **What it holds:** the database's id, its newest audit entry and that entry's hash, the entry count and the
  schema.
- **When it is written:** at every start, every minute, and at shutdown. It is written whole (a temporary file,
  renamed) and readable by its owner only.
- **What a start checks:** whether the database still holds that entry with that hash. When it does not, and
  no `npm run restore` at or after the lineage explains it, the start records a `detected` restore:
  - `other_database`: another database is in place;
  - `missing_entry`: an older copy was put back;
  - `different_entry`: a different entry sits where the noted one was.
- **How it is audited:** as `database_replaced`, in the platform trail and every Unit Instance's, once, and
  Vantage staff and the Lead Unit Managers are told.
- **Demo mode** keeps no lineage.

**Its limit:** the lineage lives on the same host. It catches a database put back by hand, by a mistake or by
an old procedure. It does not stop someone who holds the host and rewrites the lineage as well. Evidence
against them is the audit trail copied off the host as it is written (ADR-0013 §3, I-30).

### 6. Infrastructure backups and data exports, kept apart

`shared/dataTransfer.ts` lists every way a file leaves or enters Vantage, in one of two kinds.

**Infrastructure:**

- **The database backup.** The SQLite file, through `GET /api/platform/backup`, `npm run backup` and
  `npm run restore`.
- **The service archive.** `vantage-instance/1` JSON, through `GET /api/platform/export` and
  `POST /api/platform/import`.
- Both hold every Unit Instance, account, password hash, sealed secret, record and the audit trail.
- Both take `platform.data` (Lead Vantage Administrators).

**Data:** one Unit Instance's, unit's or person's data, for its own use. Each entry says what it holds, who
takes it and that it restores nothing:

- the Unit Instance's structure, roster, configuration and audit trail;
- the platform audit trail;
- the account roster and personnel feed imports;
- a unit's shared work, the personal export, reports;
- the activity and spreadsheet intake imports and saved email.

**The two kinds never meet:**

- **Every data import refuses an infrastructure backup** before it reads a byte as its own format. That covers
  the account roster, personnel feed, configuration, activities, spreadsheet intake and saved email.
  - A database file is told by SQLite's header, and the archive by its format mark in the first 512 bytes.
  - The refusal is `infrastructure_file`, with a message saying what the file is and where it goes.
- **The service archive import refuses a data export** by its format (`vantage-organization/1`,
  `vantage-unit-configuration/1`, `vantage-personal/1`). The message says it is a data export, not a backup.
- **A test holds the list to the routers.** Every route that writes a file out or takes one in is listed, and
  every listed route exists. Only the two infrastructure kinds take `platform.data`.

**In the consoles:**

- The Vantage Administrator console's page is now **Backup and restore**: the database backup with its
  history, the restore command and steps, the restores, the service archive, and **Not backups: data exports**
  from the same list.
- The Unit Manager console's Operations page says the Unit Instance's exports are copies for its own use and
  restore nothing.

### 7. A feature withheld from one Unit Instance

A Vantage Administrator (`platform.settings`) can turn **file attachments** or **spreadsheet intake** off for
one Unit Instance, with a reason of at least ten characters:

- `PUT /api/platform/orgs/:orgId/features/:flag`, from **Feature flags → Withheld from one Unit Instance**.
- Withholding is stored in `instance_feature_flags` (migration 022), audited as `instance_feature_withheld` in
  the platform trail and the Unit Instance's, and its Lead Unit Managers are told the reason.
- Giving it back is `instance_feature_restored`, audited and told the same way.

**What it covers, and what it does not:**

- **It only ever withholds.** The service's switch still decides whether a feature runs at all, so no Unit
  Instance gets more than the enterprise allows.
- **AI stays service-wide**, because what one person sends to it can span Unit Instances.
- **Enforcement:** the attachments list says `enabled: false` and an upload is refused (`feature_withheld`),
  while files already attached stay readable. A spreadsheet upload or import into the Unit Instance's units is
  refused after the placement check, so only someone who may place work there learns it is withheld.
- **What decides the Unit Instance:** the record's unit, or for a private record its owner's primary unit.

This answers ADR-0011's "Not now". The Unit Manager is not bypassed: a withheld feature is visible on their
Operations page, with the reason and since when, and they were told.

The decision card on the Task 8 thread (2026-10-15) is unanswered. This Task builds its recommended option,
**"Per instance"**. If John picks **"Service-wide only"**, delete `server/services/instanceFlags.ts`'s writer,
its route and panel, and leave the operations record listing no withheld features. The table can stay empty.

### 8. Migration 022

`022_instance_operations` adds `instance_feature_flags`, through `schema.sql`. It also starts the upgrade
history, which `runMigrations` keeps from this release on. Every database is named with a `database_id` at
open, if it has none, so a restore can tell a backup of this database from another one. An instance export
carries the new table. Importing one keeps the importing host's `database_id` and its upgrade and restore
histories in place of the archive's, as it already did for the releases and backups, because they are the
host's.

## Consequences

- **Each start costs a count.** A start that migrates counts every table twice: a few hundred milliseconds on
  a large database, recorded in the upgrade's `ms`. A start with nothing to migrate counts nothing.
- **Restoring takes the host.** That is deliberate. A runbook that copied files by hand now leaves a
  `database_replaced` entry, which is the point.
- **The safety copy is a full copy of the database**, beside it, with the same protection. Who removes it, and
  when, is the host's retention to set (I-36).
- **Unit Managers see their Unit Instance's operations.** That includes the restore's reason, the name of the
  Lead Vantage Administrator who authorized it, and features withheld. They do not see the service's checks or
  any staff account id.

## Alternatives considered

- **A restore button in the console.** Rejected. The service would have to replace its own open database,
  and a browser upload of the whole service is a larger path for the same file than the host already has.
- **Checksumming every row before and after an upgrade.** Rejected for now: it doubles the database's
  footprint on every start. Counts per Unit Instance catch loss, and a release's tests catch rewrites.
- **Per-Unit-Instance versions in a shared deployment.** Not possible: one process serves one build. The
  field is per instance so that dedicated deployments, and a future one with several, report the same shape.
- **Turning a feature on for one Unit Instance** that the service has off. Rejected: a Unit Instance must never
  be given more than the enterprise allows.
- **Withholding AI per Unit Instance.** Rejected: one conversation can draw on more than one Unit Instance.

## Open questions

Added to [INFRASTRUCTURE_QUESTIONS.md](../INFRASTRUCTURE_QUESTIONS.md):

- **I-34.** Who aggregates operations across deployments, and in which format?
- **I-35.** Must a restore be tied to an approved change or incident record, and approved by someone other
  than the Lead Vantage Administrator who runs it?
- **I-36.** Where may the lineage file and the pre-restore safety copy live, and how long is the safety copy
  kept?

## Verification

- **`tests/server/mcenOperations.test.ts`:**
  - who reads which operations view;
  - backup freshness per Unit Instance, including `not_yet` and actions since;
  - a lossy, a declared, a clean and a failing migration through `runMigrations`, their audit, notifications
    and review;
  - migration 022 from schema 21;
  - withholding and giving back attachments and intake, and their enforcement;
  - every data import refusing a database file or the archive, and the archive import refusing data exports;
  - the transfer list held to the routers;
  - the restore command's refusals, dry run, restore, audit and notifications;
  - a database put back by hand being detected once;
  - the host report.
- **`tests/server/auditCoverage.test.ts`** follows the migrations to this build's last.
- **`tests/browser/37-instance-operations.spec.ts`:** Unit Instance operations, Backup and restore, and a
  feature withheld and given back across both consoles, with axe.
