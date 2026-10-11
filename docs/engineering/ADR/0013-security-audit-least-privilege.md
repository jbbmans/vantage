# ADR-0013 · Security audit and least privilege

**Status:** accepted · **Date:** 2026-10-10 · **Builds on:** [ADR-0006](0006-centralized-tenancy-and-authority.md),
[ADR-0008](0008-unit-instance-data-isolation.md), [ADR-0009](0009-identity-and-unit-membership.md),
[ADR-0010](0010-vantage-administrator-and-unit-manager.md), [ADR-0011](0011-vantage-administrator-console-operations.md),
[ADR-0012](0012-unit-manager-console.md)

## Context

Task 7 of the governing specification (VANTAGE_CLAUDE_MASTER.md) is security, audit and least privilege, at P0.
It asks for:

- separate audit categories for user activity, unit administration and enterprise administration;
- audit of role, permission and personnel changes, imports, exports, duty approvals, point overrides,
  scoring-policy changes, counseling amendments, deployments, migrations and restores;
- least privilege throughout, with authorization on the server and the Unit Instance as a hard boundary;
- an inventory of privileged routes, and an OWASP ASVS matrix.

Earlier Tasks left findings here on purpose:

- **Task 2 ([ADR-0008](0008-unit-instance-data-isolation.md)).**
  - The audit log was not append-only. The synthetic demo database deleted and resealed audit rows, so
    triggers had to wait.
  - Nothing anchored the chain's head outside the server.
  - An instance import named its actor only in the detail.
  - The support delivery log listed mail across Unit Instances.
- **Task 4 ([ADR-0010](0010-vantage-administrator-and-unit-manager.md)).**
  - Vantage support could take over an account that holds authority. Each step was recorded and the Unit
    Instance was told, but nothing prevented it.
  - A Unit Manager who creates or seats accounts could grant a second identity what they may not grant
    themselves.
  - Unit leadership outlasted the leader's membership.
  - There was no separation-of-duties view.
- **Task 5 ([ADR-0011](0011-vantage-administrator-console-operations.md)).** Deployments, configuration and
  migrations were not audited as events of their own.

Three decisions by John frame this ADR:

- **Vantage Administrators assign Unit Managers** (2026-10-08, ADR-0010 §5). This is unchanged. They add and
  remove Unit Managers in any Unit Instance at any time, never themselves, and that instance's Lead Unit
  Managers are told each time. Those grants and removals are now sealed as enterprise administration.
- **"Until proven"** (2026-10-09). A Unit Manager gives an account they created or invited no role that reads
  records, and no Unit Instance role, until that account has signed in as its own person (section 8).
- **Who approves a support takeover.** Task 4 left this to Task 7, and the decision card this Task put to
  John on 2026-10-09 is still unanswered. This Task builds its recommended option, **"Second staff member"**
  (section 5). If John chooses otherwise, the change is
  confined to `approversFor` and `decideApproval` in `server/services/credentialApprovals.ts`.

## Decision

### 1. Three audit categories

- **The catalogue.** `shared/auditCatalog.ts` names every action the server and the scripts write, each in
  exactly one category:
  - `user`, "User activity": what a person does as themselves or with records. That covers signing in and
    out and the failures on the way, their own account and settings, records, work, counselings, comments,
    reads of someone else's records, and exports under a unit permission.
  - `unit`, "Unit administration": running a unit or a Unit Instance. That covers members, unit roles,
    units, billets, duty types and scoring, training, configuration, the personnel feed, structure imports
    and exports, retention, holds, privacy, Vantage access decisions, Unit Instance roles, account import,
    invitations and join codes.
  - `enterprise`, "Enterprise administration": Vantage staff and the service itself. That covers the
    platform console, account support, staff roles, the Unit Instance lifecycle, Unit Manager assignment,
    maintenance, settings and flags, email and AI, backups, restores, deployments, migrations, anchors and
    the owners named in configuration.

  Actions built when they are written (the sign-in methods, Vantage access steps, Unit Instance status and
  unit configuration) are spelled out in `AUDIT_ACTION_FAMILIES`. `LEGACY_AUDIT_ACTIONS` lists seven actions
  that older builds wrote and nothing writes now, so their rows still read in a category. Among them are
  `grant_operator` and `revoke_operator`, the instance-operator grants of 5.x builds before Unit Instances, which
  read as enterprise administration.
- **Sealed when written.** `audit()` records `entry.category`, or failing that the catalogue's.
  - An action shared between a unit route and `/api/platform` keeps the unit default in the catalogue, and
    the platform caller passes `enterprise`. Examples: `force_logout`, `account_unlock`,
    `organization_updated`, Unit Manager assignment, platform-wide legal holds.
  - A support entry takes the category of its queue.
  - `entryHash` appends `[org_id, category]` when an entry has a category, and otherwise keeps the old rule.
    Entries written before this change still verify as written.
- **An unknown action.** The test suite refuses it (`ctx.config.test`). In service it is still written,
  without a category, and the log warns once per action.
- **Older rows are not backfilled.** Their hashes never sealed a category. A read takes their category from
  the catalogue.
- **Reading the trail.** `server/services/auditQuery.ts` serves both trails.
  - It filters by category: an entry's stored category, or for an older row, the catalogue's.
  - Every row it returns carries its category, and the CSV export has a `category` column.
  - The page (`src/components/AuditTrail.tsx`, used by both consoles) has a labelled Category select and shows
    each entry's category under its action.
- **Forwarding.** The stdout and syslog copies carry `category` (section 3).
- **Proved by** `tests/server/auditCatalog.test.ts`. It scans `server/` and `scripts/` for every action
  written and holds the catalogue to exactly that set. It also tests sealing, old-row verification, the
  filter and the CSV column.

### 2. The audit log is append-only

- **Triggers.** `audit_log_no_update` and `audit_log_no_delete` raise `audit_append_only: ...`. They are
  created by migration 021 (`auditAppendOnlyTriggers` in `server/db/index.ts`), which a new database runs as
  an older one does.
- **Lifted in three places only**, each inside one transaction that recreates the triggers before it commits:
  - removing an expired demo workspace (`purgeWorkspace` in `server/services/demo.ts`), whose reseal now runs
    inside that transaction. `resealAuditChain` still refuses anything but a synthetic demo database;
  - loading an instance archive into a fresh instance (`importInstance` in `server/services/exports.ts`);
  - `scripts/start-over.ts`.

  `dropAuditAppendOnlyTriggers` refuses to run outside a transaction.
- **Nothing else rewrites the log.**
  - `audit_log`'s foreign keys (`actor_id`, `subject_id`) have no `ON DELETE` action.
  - The only `DELETE FROM users` is the demo purge.
  - Retention, disposition and privacy erasure never touch `audit_log`.
- **The API's answer.** A refusal that reaches the error handler is a 403 `audit_append_only`, as
  `cross_instance` is.
- **Proved by** `tests/server/auditAppendOnly.test.ts` and the migration 021 test in
  `tests/server/migrations.test.ts`. The tamper tests in `org.test.ts` and `unitIsolation.test.ts` now show
  that the database refuses the edit. They then drop the trigger, standing in for someone who holds the
  database, and the chain still catches the rewrite.

### 3. An anchor kept outside the server

- **Writing an anchor.** `anchorAuditChain` (`server/services/audit.ts`) writes `audit_chain_anchored`
  (enterprise). Its detail names the head: seq, hash and entry count.
  - Like every entry, it is copied off the host as it is written (`VANTAGE_AUDIT_SYSLOG`,
    `VANTAGE_AUDIT_STDOUT`). That copy is the anchor whoever holds the server cannot rewrite.
  - No new outbound connection was added.
- **When anchors are written.**
  - The daily `audit_anchor` job (`startSchedulers`, `anchorAuditChainIfChanged`) anchors when anything was
    written since the last anchor.
  - `POST /api/platform/integrity/anchor` (`platform.settings`) anchors the case histories and then the audit
    chain, so the audit anchor covers the case anchors.
- **Checking an anchor.** `POST /api/platform/integrity/verify` (`platform.audit`) takes
  `{ seq, entry_hash }`.
  - It answers whether that entry still carries that hash (`match`, `missing` or `different`), with
    `verifyAuditChain()`.
  - Every check writes `audit_anchor_verified` with its result.
  - A failed check tells every Lead Vantage Administrator (`notifyStaff(ctx, 'platform.staff', ...)`).
- **In the console.** `GET /api/platform/integrity` also returns the head and the last anchor. The Platform
  audit trail page has an **Audit chain anchors** panel with the head, the last anchor, and a labelled
  **Check a kept anchor** form whose result is announced (`role=status`).
- **Who keeps the copy, and how often it is compared, is open** (INFRASTRUCTURE_QUESTIONS I-30).
- **Proved by** `tests/server/auditCoverage.test.ts` and `tests/browser/34-audit-anchors.spec.ts`.

### 4. What is audited

| Specification item | Actions | Where |
|---|---|---|
| Role changes | `grant_role`, `revoke_role` (names the role), `create_role` (permission keys), `edit_role`, `delete_role`, `role_expired`, `transfer_ownership`, `unit_leader_set`, `unit_leader_ended`, `unit_role_withheld` | `server/routes/org.ts`, `server/services/org.ts`, `server/services/access.ts`, `server/services/organizations.ts` |
| Unit Instance roles | `org_role_granted`, `org_role_revoked`, `org_role_ended`, `org_role_expired`, `org_role_restored` (each names the role key), `org_owner_named`, `platform_owner_named`, `platform_manager_assigned`, `platform_manager_removed`, `platform_owner_configured` | `server/services/organizations.ts`, `server/services/org.ts`, `server/services/personnel.ts`, `server/app.ts` |
| Permission changes | `edit_role` (permission keys added and removed, other fields, sessions revoked), `create_role`, `staff_role_granted`, `staff_role_revoked` | `server/routes/org.ts`, `server/routes/platform.ts` |
| Personnel changes | `add_member`, `move_member`, `remove_member`, `edit_membership`, `edit_member_profile`, `removed_from_organization`, the `personnel_*` feed actions | `server/routes/org.ts`, `server/routes/orgs.ts`, `server/services/organizations.ts`, `server/services/personnel.ts` |
| Imports | `accounts_imported`, `account_imported`, `personnel_sync_planned`, `personnel_sync`, `personnel_sync_update`, `unit_configuration_imported`, `instance_import`, `import`, `run_import` | `server/routes/orgs.ts`, `server/services/accountImport.ts`, `server/services/personnel.ts`, `server/services/unitConfig.ts`, `server/services/exports.ts` |
| Exports | `export`, `export_csv`, `export_pdf`, `export_personal`, `organization_export`, `organization_roster_exported`, `organization_audit_exported`, `unit_configuration_exported`, `platform_audit_exported`, `instance_export` | `server/routes/org.ts`, `server/routes/misc.ts`, `server/routes/me.ts`, `server/routes/orgs.ts`, `server/routes/platform.ts` |
| Duty approvals, point overrides | none yet: they arrive with Tasks 17 and 18, and the catalogue test makes each new action name its category | — |
| Scoring-policy changes | `duty_scoring_policy_published`, `duty_scoring_policy_withdrawn`, the `duty_type_*` and `training_requirement_*` families, `duty_types_standard_added` | `server/services/dutyScoring.ts`, `server/services/unitConfig.ts` |
| Counseling amendments | `counseling_amended` (names the fields changed, never their values) in place of `edit` | `server/services/records.ts` |
| Deployments | `release_deployed`, for a new version, build or commit and not on a restart | `server/services/operations.ts` (`recordRelease`) |
| Migrations | `schema_migrated`, once per migration applied at start, or once naming the schema a new database began at | `server/services/operations.ts` (`auditMigrations`), `server/app.ts`, `server/db/index.ts` |
| Restore operations | `instance_import`, `backup`, `maintenance_on`, `maintenance_off`, `maintenance_task` | `server/services/exports.ts`, `server/routes/platform.ts`, `server/services/maintenance.ts` |
| Retention and holds | `retention_schedule_saved`, `disposition_run`, `legal_hold_placed`, `legal_hold_released` | `server/services/retention.ts` |
| Integrity | `audit_chain_anchored`, `audit_anchor_verified`, `case_history_anchor`, `case_history_anchor_requested` | `server/services/audit.ts`, `server/routes/platform.ts`, `server/services/caseSeal.ts` |
| Sign-in and refusals | `login_failed`, `access_denied`, `invite_created`, `invite_revoked` | `server/routes/auth.ts`, `server/app.ts`, `server/routes/org.ts` |
| Account support | `credential_change_requested`, `credential_change_approved`, `credential_change_denied`, `credential_change_cancelled` | `server/services/credentialApprovals.ts` |

How the new actions behave:

- **`login_failed`** (user) is written for a wrong password or a wrong second factor on a known account. It
  names the account as subject, the IP and the method. For a name that matches no account it records no
  name. `login_lockout` and `account_unlock` are unchanged.
- **`access_denied`** is written for a 403 to a signed-in person at `/api/platform` (enterprise) or at
  `/api/orgs` and `/api/org` (unit).
  - It names the method, the declared route and the code, and the Unit Instance under `/api/orgs/:orgId`.
  - A refusal by a router's own guard, before any route matches, is named by the mount instead (for example
    `GET /api/platform/*: not_staff`), so made-up addresses beneath it are one refusal, not one each. Its detail
    adds the address first asked for, cut to 120 characters.
  - Step-up and boundary codes are left out (`sudo_required`, `cac_required`, `oidc_required`,
    `bad_password`, `cross_instance`), and so is every 401.
  - The same person, method, route and code is written once in ten minutes (in memory, per process). At most
    5,000 refusals are remembered (`DENIALS_REMEMBERED`); past that, expired ones go first, then the oldest.
  - `self_grant`, `unproven_own_account`, `approval_required` and `recent_credential_change` refusals reach the
    trail this way.
- **`schema_migrated`** keeps `migration_audited_through`, a host meta key that an instance export does not
  carry.
  - A database this build creates is audited once, as created at its schema.
  - A database an older build left below the current schema, without the key, gets it from `migrate()` before
    any migration runs: the schema it started at, and never above 20 (`AUDITED_FROM` in `server/db/index.ts`).
    So every migration this start runs is audited, from schema 18 as from schema 20. Migrations an older build
    ran are not audited after the fact.
- **`instance_import`** names the importer as actor when their account exists after the import. Otherwise it
  records no actor and names the importer's username and id in the detail.
- **`invite_revoked`** is new: revoking an invitation wrote nothing before.

### 5. Support takeover needs a second member of Vantage staff

- **When the rule applies.** A temporary password, a second-factor reset or a CAC (EDIPI) change on an
  account that **holds authority** needs an approval. An account holds authority when it has any platform
  role, an unexpired Unit Instance role it holds while a member (`seatedOrgRole`), or the leadership of an
  active unit (`holdsAuthority` in `server/services/credentialApprovals.ts`).
- **Authority given up lately still counts.** Authority the account held in the last 30 days
  (`RECENT_AUTHORITY_DAYS`) counts too (`heldAuthorityRecently`). The trail shows it: an `org_role_revoked`,
  `org_role_ended`, `org_role_expired`, `platform_manager_removed`, `staff_role_revoked` or `unit_leader_ended`
  entry about the account, an `archive_unit` entry naming it as the leader of the unit archived, a
  `transfer_ownership` or `unit_leader_set` entry that passed a unit on from it, or a Unit Instance role that ran
  out in that time. Taking an account's authority away, changing its sign-in alone
  and giving the authority back is therefore no way round the second person.
- **Nor the other way round.** A staff member who set a temporary password, reset the second factor or changed
  the CAC on an account in the last 30 days does not then give it authority (`guardRecentCredentialChange`):
  - any Unit Instance role, through `grantOrgRole`, which a Vantage Administrator's `assignManager` and the
    Unit Instance's own routes both use;
  - the first Lead Unit Manager, by `nameFirstOwner` or when a Unit Instance is created with one;
  - a platform staff role (`POST /api/platform/staff`);
  - the leadership of a unit, by naming (`setUnitLeader`) or by transfer (`transferOwnership`), whoever the staff
    member is in the unit.

  The refusal is 403 `recent_credential_change`: "You changed this account's sign-in in the last 30 days, so you
  cannot give it authority. Another member of Vantage staff can." It reaches the trail as `access_denied`.
  John's decision on Unit Manager assignment stands: Vantage Administrators still add and remove Unit Managers
  at any time; only the one who just changed that account's sign-in is refused, and another can act.
- **Asking.** A holder of `platform.accounts` asks with a reason of at least ten characters, and an EDIPI for
  a CAC change: `POST /api/platform/accounts/:userId/credential-approvals`. The request is refused with:
  - 400 `no_authority` when the account holds none;
  - 409 `approval_open` when the same request is already open;
  - 400 for an EDIPI the account already carries or another account holds, and for a temporary password on
    one's own account.

  `accountTarget`'s staff rule applies.
- **Answering.** `POST /api/platform/credential-approvals/:id/approve`, or `/deny` with a required note.
  - The approver must be another holder of `platform.accounts`, neither the one asking nor the account
    (`self_approval`).
  - When the account is staff, the approver must also hold `platform.staff`, that is, be a Lead Vantage
    Administrator (`staff_account`).
  - The one asking may cancel (`/cancel`).
  - `GET /api/platform/credential-approvals` lists open requests and the last thirty days.
- **Carrying it out.** The change routes take an `approvalId`. It must name an approved, unused, unexpired
  request by the same staff member for the same account, change and EDIPI. It is used up in the same
  transaction as the change. Otherwise the route answers 403 `approval_required`.
  - A request lapses 24 hours after it is made. Expiry is recorded the next time approvals are read, and is
    not audited.
  - Accounts without authority are helped as before.
- **On the record.**
  - Each step is audited as enterprise administration (`credential_change_*`).
  - The other side is told in the app.
  - The change's own audit entry, and the notice `tellInstancesOfSupport` gives the Unit Instance's Lead Unit
    Managers, name the approver.
- **In the console.** The Accounts page turns `approval_required` into an "Ask a second staff member to
  approve" form. An Approvals panel lets others approve or deny, and the one who asked cancel or carry it
  out.
- **The break-glass path.** `scripts/recover-operator.ts`, run on the server, is the way back in when no
  second staff member can act. Its header says so. It needs the host, not the API.
- **Whether MCEN requires a particular approver is open** (INFRASTRUCTURE_QUESTIONS I-31).
- **Proved by** `tests/server/credentialApprovals.test.ts`, `tests/server/roleModel.test.ts` and
  `tests/browser/35-credential-approvals.spec.ts`.

### 6. The support delivery log

`deliveryFor` in `server/services/support.ts` decides who sees which deliveries:

- **Vantage support** (`platform.support`) sees every delivery to the account or address, as before.
- **A unit's support queue** sees only the account's own mail: sign-in details, password reset and address
  confirmation (`ACCOUNT_MAIL_KINDS`). It sees status and time only, never a subject, address or error.
- **Sign-in details** show only when the ticket's own Unit Instance sent them. `email_log` gains `org_id`
  (`schema.sql`, migration 021) for that. The mailer fills it for sign-in details, invitations and team
  messages. Sign-in details sent by Vantage support, or written before this change, have no `org_id` and do
  not show to a unit queue.

### 7. Unit leadership requires membership

- **Scope.** `scopeFor`'s owned set and `isUnitOwner` count `units.owner_user_id` only while that person is a
  member of the unit (`seatedLeader` in `server/authz/scope.ts`).
- **Leaving ends it.** `removeMember` (`server/services/org.ts`) is the only path that deletes from
  `unit_members`, and a static test holds it to that. It now ends the leadership of a leader it removes:
  - the owner is cleared;
  - `unit_leader_ended` (unit) is audited with the reason;
  - the Unit Instance's Lead Unit Managers are told.

  This covers removal, transfer, personnel-feed separation and removal from the instance. A leader who
  archives the unit only they belong to closes it rather than leaving it unled: the leadership is cleared
  first, so no `unit_leader_ended` entry or "has no leader" notice is written for it. The `archive_unit` entry
  names the leader as its subject, and the two-person rule reads it as leadership given up.
- **Existing data.** A leader who is not a member is left in place, ignored by scope and listed by the
  separation-of-duties report.
- **Restored with the roster, while nobody else leads.** A personnel-feed separation keeps, with the
  memberships it ends, which units the person led (`led`). When a later extract brings them back and the unit
  is still unled, the restore gives the leadership back (`claimUnit`, audited as `unit_leader_set`, "back on the
  roster"). If a leader was named meanwhile, the restore gives back neither the leadership nor the Unit Leader
  role, which goes only with leading the unit.

### 8. "Until proven" (John, 2026-10-09)

- **Opened by.** An account was opened by a person when its earliest `unit_membership_periods` row has
  `start_reason` in (`account_import`, `invitation`, `join_code`) and `started_by` that person
  (`accountOpenedBy`). A unit the account founded (`unit_created`) is not counted, so founding one first is no
  way round the rule for the code or invitation it answers next.
- **Proven.** An account is proven once `users.edipi_verified_at` or `users.oidc_subject` is set
  (`isProvenAccount`), that is, once it has signed in with its own CAC or the organization's sign-in.
- **What waits.** Until then, the person who opened it gives it none of the following:
  - a unit role carrying the record-reading bits, by direct grant, by widening a role it holds, or by carrying
    one over when they move it to another unit (`moveMember`: the role goes into `rolesSkipped`, and the
    `move_member` entry says "not carried");
  - a Unit Instance role, including a Vantage Administrator's `assignManager`, `nameFirstOwner` and the
    first owner at creation;
  - the leadership of a unit, by naming or by transfer.

  The refusal is 403 `unproven_own_account`: "You created or invited this account, and it hasn't signed in
  with its own CAC or the organization's sign-in yet. Another Unit Manager or the chain of command can grant
  this." It is checked before anything is written, and reaches the trail as `access_denied`.
- **Who else may grant it.** Another Unit Manager may. So may anyone who already holds full unit authority,
  or the bits being granted, through the chain of command, as `guardSelfReach` judges it. Unit Instance roles
  have no chain-of-command exemption.
- **Roles carried by a join code, an invitation or an account import** are held back rather than refusing
  the join. The person joins. The role is audited as `unit_role_withheld`, and the maker of the code or
  invitation is told. An import lists the held-back roles (`withheld`) in its result.
- **The unit's default role**, which every new member receives, is covered both ways:
  - Widening it to read records (`PUT /api/org/roles/:roleId`) is judged as giving that reach to yourself,
    since accounts you open will receive it: 403 `self_grant` unless you lead the unit, or the chain of
    command already gives you those bits or full unit authority there.
  - When `addMember` seats an account its inviter opened and has not proven, a default role that reads records
    is held back from it (`mayCarryRole`), audited as `unit_role_withheld`, and the inviter is told. An account
    someone else opened still receives it.
- **The residual risk.** A proof is never re-checked. Under the two-person rule an EDIPI change clears
  `edipi_verified_at`, so the account reads as unproven again.
- **Proved by** `tests/server/leastPrivilege.test.ts`.

### 9. The separation-of-duties report

`GET /api/platform/separation-of-duties` (`platform.audit`, read-only, `server/services/separationOfDuties.ts`)
and the console page **Separation of duties** (`/admin/separation`) list:

- accounts that hold a platform role and a Unit Instance role;
- a Unit Instance role together with a record-reading unit role, or unit leadership, in the same instance;
- Unit Manager roles in more than one instance;
- unit leaders who are not members of the unit;
- unproven accounts holding a record-reading role, or a Unit Instance role, granted by whoever opened them.

It reports. It changes nothing. Proved by `tests/server/leastPrivilege.test.ts` and
`tests/browser/36-separation-of-duties.spec.ts`.

### 10. A read limit on the consoles

- **Scope.** `limitConsoleReads` (`server/auth/middleware.ts`) counts `GET`, `HEAD` and `OPTIONS` on
  `/api/platform` and `/api/orgs` per signed-in person, after `requireAuth`.
- **Limit.** `VANTAGE_CONSOLE_READS_PER_15_MINUTES` sets it, 1800 by default.
- **Over the limit.** The answer is 429 `reads_throttled` with `Retry-After`.
- **Changes** are counted by the existing mutation limiter, as before.
- **The browser suite** raises the limit, because its few staff accounts share one server.

### 11. An inventory of privileged routes

`server/authz/privilegedRoutes.ts` lists every mutating route on the platform, `orgs` and `org` routers, and
every route that exports or downloads data in bulk. Each entry gives the method, path, permission, whether
step-up applies, and the audit actions it writes with their categories.

`tests/server/privilegedRoutes.test.ts` checks it three ways:

- it scans those router files and requires the manifest to match exactly, with no route missing and none
  stale;
- it requires every action the manifest names to be catalogued;
- it calls every route in the manifest without a session (401), as an ordinary member, and as a Unit Auditor
  beyond what that read-only role allows, and requires a refusal and no change each time.

A new privileged route therefore fails the suite until it is declared.

### 12. OWASP ASVS 5.0.0

[docs/security/ASVS.md](../../security/ASVS.md) maps Vantage to ASVS 5.0.0:

- V8 (Authorization) and V16 (Security Logging and Error Handling) one requirement per row;
- every other chapter one section per row.

It cites requirement identifiers and describes them in its own words. Its provenance, the source file's
checksum and the licence are recorded at its head.

## Consequences

- **Migration 021** (`021_audit_categories_and_append_only`, schema 21) adds:
  - `audit_log.category` (CHECK) and `idx_audit_category`;
  - the append-only triggers;
  - `email_log.org_id`.

  `schema.sql` adds the `credential_approvals` table and both columns for a new database.
  `credential_approvals` is declared in the privacy inventory and not exported with an instance: approvals
  belong to the host, and their audit entries travel with the trail.
- **New audit actions:**
  - `login_failed`, `access_denied`, `counseling_amended`;
  - `release_deployed`, `schema_migrated`, `platform_owner_configured`;
  - `audit_chain_anchored`, `audit_anchor_verified`;
  - `credential_change_requested`, `credential_change_approved`, `credential_change_denied`,
    `credential_change_cancelled`;
  - `unit_leader_ended`, `unit_role_withheld`, `invite_revoked`.

  Editing a counseling now writes `counseling_amended` instead of `edit`. A counselor editing their own
  counseling is labelled "counselor edit".
- **New routes:**
  - `POST /api/platform/integrity/verify`;
  - `GET /api/platform/credential-approvals`, `POST /api/platform/accounts/:userId/credential-approvals`,
    and `POST /api/platform/credential-approvals/:id/{approve,deny,cancel}`;
  - `GET /api/platform/separation-of-duties`.

  `GET /api/platform/integrity` returns `head` and `lastAnchor`, and `POST /api/platform/integrity/anchor`
  returns `audit`.
- **New configuration:** `VANTAGE_CONSOLE_READS_PER_15_MINUTES`. New scheduled job: `audit_anchor`.
- **Behavior changes:**
  - An audit entry cannot be changed or removed, even by hand, without dropping a trigger.
  - Both audit CSV exports gain a `category` column after `action`.
  - Vantage support needs a second staff member to take over an account that holds authority.
  - A leader who leaves a unit stops leading it, and gets it back from a roster restore only while it is still
    unled.
  - Authority held in the last 30 days counts for the two-person rule, and a staff member who changed an
    account's sign-in in that time gives it no authority (`recent_credential_change`).
  - A Unit Manager's own invitees and imported accounts wait for proof before reading records or holding a
    Unit Instance role from them, through the unit's default role and a move as well.
  - A unit support queue sees less of the delivery log.
  - Heavy console reading can be throttled.
- **Existing tests updated** for these behaviors, each listed in its commit:
  - `adminConsole`, `auditForwarding`, `secretRotation`, `org`, `unitIsolation`, `unitManagerConsole`,
    `roleModel`, `migrations` and `auditCoverage` (the detail of a router-level refusal);
  - the browser specs `32` and `33`.
- **The syslog line** carries `category` in its JSON message, not as a structured-data element. A custom
  SD-ID needs a registered private enterprise number, and Vantage has none.
- **Not done here, or left open:**
  - **Duty approvals and point overrides** (Tasks 17 and 18). The catalogue test makes their actions name a
    category when they arrive.
  - **Server-side backups and restores.** `scripts/backup.ts` records a backup in `backup_history` but
    writes no audit entry, because it runs without the service's secret and chain key. A `.db` file
    restored on the host outside the console cannot be seen by the application.
  - **Migrations an older build ran** are not audited after the fact. Those this build runs are, however far
    back the database started.
  - **Audit retention.** No schedule covers `audit_log`. Under append-only, any future disposition of audit
    entries needs a deliberate, documented exception (INFRASTRUCTURE_QUESTIONS I-32).
  - **`holdsAuthority`** still counts a unit an account owns without being a member. For the two-person rule,
    asking for approval on slightly more accounts is the safe side.
  - **The `access_denied` quiet period** is held per process and starts empty on each start. Its 5,000-entry
    cap has no direct test, which would take 5,000 requests.
  - **Maintenance and backups** still need no second person (INFRASTRUCTURE_QUESTIONS I-29).
  - **Adaptive, risk-based access decisions** (device posture, location) are not built (ASVS V8.2.4,
    V8.4.2).

## Alternatives considered

- **Backfilling a category into older audit rows.** Rejected: their hashes never sealed one, so a backfill
  would mean resealing the chain, which is the rewrite append-only exists to stop. Reads derive it.
- **Keeping append-only in the code alone.** Rejected: a defect or a hand-written statement could still
  rewrite the trail quietly. The triggers refuse it as it is tried. The chain still catches whoever drops
  them.
- **Sending anchors to an outside service of their own.** Rejected: under MCEN every outbound connection
  needs approval. The syslog or stdout copy already leaves the host with every entry, so the anchor goes
  with it.
- **A structured-data element for the category in syslog.** Rejected for now: it needs a registered
  private enterprise number.
- **Who approves a support takeover.** Built: "Second staff member", the card's recommended option.
  The card's other options, not built while it is open:
  - "Lead Unit Manager": a Lead Unit Manager of the person's Unit Instance approves. It gives a unit a say
    over Vantage's own staff accounts, cannot cover an account in no instance, and needs a Vantage
    Administrator to name one first where the instance has no other Lead Unit Manager;
  - "Either one": whoever approves first, another staff member or a Lead Unit Manager of the person's
    instance. It carries the second option's gaps for the instance side;
  - "Notify only": Task 4's behavior, one person acts and the instance is told afterward. A takeover is
    detected but not prevented.
- **Refusing the join when a code or invitation carries a role the maker may not give.** Rejected: existing
  practice has leaders staff units with join codes made for others. Holding back the role keeps the join and
  stops the grant.
- **Ending a non-member leader's leadership in migration 021.** Rejected: it would change who leads units in
  running instances without anyone deciding it. Scope ignores them, and the report lists them for a Unit
  Manager to act on.
