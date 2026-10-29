# Progress

_Updated 2026-10-29_

## What changed (2026-10-29: reports and printable output)

**Partial.** Not merged; HawkScan not run (no key); CI disregarded on John's word.

Eleven reports, each one document drawn the same way on screen, on paper and in every file
([ADR-0020](engineering/ADR/0020-reports-printable-output.md)).

- **The reports.** Individual performance, Activity, Training, Unit performance, Leadership, Personnel, Workload, Duty,
  Financial KPI, Error report and Custom, each built from the code that already computes its figures. Training now
  reads the unit's training requirements: met, due soon, past due or no record, from shared records only. Financial
  KPI and the error report read the unit's shared cases. Duty shows the duty types and the scoring version in force,
  and says duty records begin with Task 17. Custom picks a dataset, its columns, grouping and order; a counseling is
  listed by its date, type and counselor, never its words.
- **The document.** Every report carries its title, whom it is about, the unit, the period, when and by whom it was
  generated, every filter in force and the handling line. A rolling period shows it ending today.
- **Who sees what.** Yourself always; a Marine where you may open their records, only what they shared, never across
  Unit Instances; a unit with its shared-records role there. Figures by Marine need member detail, and any file of
  someone else's report needs the export permission. Every report about someone else is audited when it is viewed,
  printed or filed.
- **Formats.** PDF by PDFKit (the handling line on every page, table headers again after each break, cells that wrap
  and are never cut, landscape past eight columns), CSV, an Excel workbook with an About sheet, and the JSON document.
- **Printing.** `/reports/print` prints the report without the app around it: Letter paper, the handling line and
  report name on every page, table headers repeated, rows never split, landscape for a wide table, the buttons never
  printed.
- **Report library** (Reports & Analytics). Choose a report, whom it is about and its filters; print it, take the files
  you may, and save the choices (migration 028, `report_definitions`: choices, never data; private or shared with a
  unit, and a shared one names no Marine). The unit dashboard, workload, roster and Analysis link to their report.
- **Handling line.** Vantage Administrators set it in the console's Identity panel; it defaults to "Working paper".
  The wording MCEN requires is MCEN's to give.
- **Left to other Tasks:** duty records (17) and scoring (18) fill the Duty report; financial error snapshots (15);
  one set of analytics components (21).

## What changed (2026-10-28: import, export, download and restore)

**Partial.** Not merged; HawkScan not run (no key); CI disregarded on John's word.

Every category of a person's record goes out and comes back as what it is, through a review that writes nothing until
the person imports ([ADR-0019](engineering/ADR/0019-import-export-restore.md)).

- **Export.** Your data exports everything (ZIP, JSON, now Excel) or the categories chosen (Excel with a sheet each,
  JSON, ZIP, or one category as CSV). Training, Awards and Counseling export their own. A record downloads from its page
  as JSON, a CSV row that imports back, or a ZIP with its files, under the same read rule as the page, audited.
- **Import** (`/api/me/imports`, migration 027). A Vantage export (JSON or ZIP, personal or one record), an Excel
  workbook or a CSV. Each sheet is routed by its name, a CSV by its file name, else a Record Type column, else its
  headers; the person can change the type and each column. The review is the import run through the form's own writes
  and rolled back: each row shows what it is, where it goes, duplicates and problems. Corrections, "import as", rows
  left out, who sees them, the profile (fill, replace, leave) and files are the person's. The import is one
  transaction, stopped if the counts changed since the review; results are kept; undo once.
- **Never flattened.** Awards stay awards, courses training, counselings counselings. A log entry that reads like an
  award is offered as one, never moved for its owner. Duty rows are listed and never become Activities.
- **Boundaries.** Only the importer's account is written; ids in a file never name a record here; a record the
  importer may not place in a unit comes in private; a Vantage export already here is never overwritten; another
  person's import is 404; backups and other Vantage files are refused. Files are scanned one by one.
- **Restore.** A person restores by importing their own export, here or in another Vantage. The unit configuration
  file now carries duty scoring versions, loaded only into a Unit Instance without its own.
- **Proven.** A representative account (readiness, career plan and steps, every record type, a ranged FM work activity
  with its file, evidence link and project, PME with its dates, an ongoing certification, an award in submission with
  its period, a leader's recommendation and counseling) exported and imported into a clean Vantage comes back the same,
  types, dates, approval states and links intact, and a second import adds nothing. Duty scoring versions round-trip
  through the unit configuration file. Workbook routing, volunteer service and duty rows are tested on their own.
- **Decided:** counselings and award recommendations others wrote come in as the Marine's own copies, labelled with
  their author. John chose "Marine's own copies" on the decision card (2026-10-28), over read-only copies or leaving
  them out. Duty records are Task 17's.

## What changed (2026-10-24: record timeframes)

**Partial.** Not merged; HawkScan not run (no key); CI disregarded on John's word.

Records have a start, an end, optional times and "ongoing", and every report reads ranges by one rule
([ADR-0018](engineering/ADR/0018-record-timeframes.md)).

- **The fields.** Activities and training gain an end date, a start and end time (24-hour, shown as "0800") and
  Ongoing. Awards gain the start of the period they recognize; the award date stays the day it was given. Goals,
  projects, assignments and responsibilities keep the two days they had. Counselings and tasks keep one date.
- **Never ends before it starts.** The forms mark the field, the server refuses with 400 and an error per field, and
  database triggers (migration 026) refuse every other writer on all seven record types. Rows already out of order are
  kept, counted in `meta.timeframe_violations` and shown in the console's migration status; changing their dates asks
  for them in order.
- **One rule for periods.** A record is in a period when any day of it is (an award by its date), counted once per
  report, in the first month of the window it touches. Record lists, JEPES and FITREP inputs, analysis and its PDF,
  metrics, the dashboard, the progress delta, the digest, the AI context, the timeline and the CSV export all use it.
  John chose "every period it touches" on the decision card (2026-10-24), over counting by start or by end.
- **Around it.** Retention runs from a record's end and never for an ongoing one. Moves carry the range. CSV import
  and export of activities have End Date, Start Time, End Time and Ongoing ("Present"). Archives from before 026 load
  with the new columns at their defaults.
- **Pages.** Activity and training forms have start and end dates, "Add times" and an Ongoing switch; the award form a
  period start. Lists, cards, detail pages, the timeline, metric contributors and the import preview show the range.
- **Left to other Tasks:** duty records take the same registry (17); an index for overlap queries (25).

## What changed (2026-10-22: personnel management)

**Partial.** Not merged; HawkScan not run (no key); CI disregarded on John's word.

Personnel is a structured record per Marine, its history kept by the database whoever changes it, changed one Marine
at a time or many at once ([ADR-0017](engineering/ADR/0017-personnel-records.md)).

- **The record.** Rank, grade, MOS and EAS from the account; each assignment's unit, primary or secondary, billet,
  and start and end dates; their team (the deepest unit they belong to); supervisor and check-in date per Unit
  Instance; the leadership chain (supervisors upward, then the seated leaders of their unit and above); functional
  responsibilities; Vantage roles; account status; and counts of training, education, awards, counseling, duty,
  activities, goals and open tasks, linked to the tabs that show them.
- **Migration 024.** `unit_members` gains `billet_id`, `assignment_start` and `assignment_end`; new tables
  `personnel_records`, `personnel_responsibilities` and `personnel_events`. Memberships whose billet title names
  exactly one active billet of their Unit Instance are linked to it. Triggers write personnel history; boundary
  triggers keep billets, responsibilities and supervisors inside their Unit Instance. The instance archive carries
  the new tables.
- **Who reads what.** Anyone who sees a Marine on a roster opens their personnel record; account status and history
  go to those who manage them and the Marine; record counts only with record access. A Unit Manager now has the
  roster and corrects a rank without opening any record. Opening another Marine's record is audited
  (`view_personnel`).
- **Who changes what.** Manage members in the Marine's unit, above them there; never one's own. The leader's profile
  correction honours the personnel feed's fields, as the Marine's own edit does.
- **Bulk.** Supervisor, check-in, assignment start or end, billet, a responsibility, or a move, for up to 200 Marines:
  previewed, then all or nothing, each row audited as its single change and the whole as `personnel_bulk`.
- **Pages.** Personnel → Roster rebuilt (filters, search, selection, bulk bar, a list on phones); a Marine's page
  opens on a Personnel tab; Settings links to your own record.
- **Leaving.** The last membership in a Unit Instance ending ends the record there: supervisor, check-in,
  responsibilities, and the supervision of others.
- **Left to other Tasks:** personnel CSV import and export (13), duty records (17), role-change history beyond the
  audit trail.

## What changed (2026-10-19: information architecture)

**Partial.** Merged in #55 (`65ed79c`), with a follow-up for what the last review found; HawkScan not run (no key);
CI disregarded on John's word.

The menu is the specification's top-level structure, every page is named as the menu names it, one action has one
name, and Help answers where everything is
([ADR-0016](engineering/ADR/0016-information-architecture.md), [IA](product/INFORMATION_ARCHITECTURE.md)).

- **Menu.** Today, Work, Records, Personnel, Training & Development, Reports & Analytics and Administration, with
  Help and Settings at the foot. Awards and Counseling are under Records; Training, the career plan, Goals,
  Readiness and MARADMINs under Training & Development; Reference under Work; the unit dashboard under Reports &
  Analytics; invitations, roles, units, the access log and both consoles under Administration. Knowledge is gone.
- **Addresses did not move.** `groupFor` resolves by page, so `/career/awards` is Records → Awards. Old addresses
  redirect as before. Shortcuts keep their letters; C opens Training & Development → Training (it opened the
  career plan), A is new (Administration) and K is retired.
- **Names.** A page's heading is its menu label and its eyebrow its group (`usePlace`). Sentences that name a place
  use `placeName` ("Records → Awards") instead of "under Career".
- **Actions.** Log activity; New activity, New award, New training, New counseling, New goal, New report; Import
  activities, Import work; Export activities, Export analysis PDF, Export JEPES input PDF, and Export CSV and JSON on
  the audit trail. ⌘K carries the imports and exports.
- **Help.** The field guide opens with Find your way: the twelve questions of the UX definition of done, each linked
  to the pages that answer it for this person. Duty is answered as an activity filed under Operations until Task 17.
  Help's keyboard line and the shortcuts dialog list only the pages this person can open.
- **Activities.** Search, period and layout stay; the other filters fold behind Filters with a count, and open
  when a link sets one.
- **Rail.** Long labels wrap instead of being cut short; a console link carries an outward arrow, in the rail and in
  a group's strip. One item is marked as the page you are on; a collapsed rail's group icon is marked as the group
  you are in. A goal, task or project opened from a notification sits with its list.
- **No server, API, permission or schema change; no migration.**
- **Left to other Tasks:** Personnel pages (11), import and export (13), reports (14), duty (17), Packages and
  Analysis overlap (14, 21), drafts (23), performance and responsive pass (25), tutorials (26).

## What changed (2026-10-18: core record architecture)

**Partial.** Not merged; HawkScan not run; CI not considered.

Each kind of record keeps its own store, named in one registry. Quick Log steers awards and training to their own
records, and a Marine moves a misfiled entry there with its lineage, and back
([ADR-0015](engineering/ADR/0015-core-record-architecture.md)).

- **Record kinds.** `shared/recordKinds.ts` names, for every concept in the specification's domain model, its
  store, who writes it, who may correct it and which outside system holds the official copy. Duty (Task 17) and
  financial error snapshots (Task 15) are listed with no store yet.
- **Activities are work.** A conservative reading of an entry's words says when it reads like an award received or
  training completed, and leaves alone work done for others, such as drafting awards or teaching a class. Quick Log
  and the New entry form offer to save such an entry as an award or training, "Keep as activity" is remembered, and
  the CSV import counts the rows it put in that read that way.
- **Moving an entry.** Its owner moves an entry between Activities, Awards and Training, and back. One transaction
  carries its files and comments and keeps the row as it stood in `record_lineage`. The move is audited at both
  ends (`record_moved`, `record_move_undone`) and can be undone. Among the refusals: someone else's entry, a frozen
  one, an activity drawn from a financial case, an award a leader recorded, and one a legal hold covers. Readers of
  an entry see that it moved; what it said before is its owner's. Career shows the files an award or a course holds.
- **Entries that may belong elsewhere.** Activities lists the person's entries that read like an award or training.
  Each is moved or kept as an activity, and a kept one is not suggested again.
- **Award ownership.** An award keeps who recorded it. A leader's recommendation is no longer its subject's to edit,
  delete or move: its recorder changes it while it is shared with its unit and they hold Counsel members there, as
  do holders of Edit others' records. The Marine sees who recorded it, until a retention schedule anonymizes it.
- **Timeline.** **Record → Timeline** shows the person's activities, training, awards, counselings and goals reached,
  newest first, each opening its own record. It is read from each table when asked for and never stored.
- **Migration 023** adds `record_lineage`, `awards.recorded_by` (filled for older awards from their create entries)
  and `activities.kind_confirmed_at`. It moves nothing: John chose "Marine confirms" on the decision card
  (2026-10-17). Lineage is in the instance archive and the personal export, and goes with a destroyed or anonymized
  record unless a legal hold covers it.
- **Left to other Tasks:** duty records (17), financial error snapshots (15), semantic import (13).

## What changed (2026-10-15: MCEN operations)

Each Unit Instance's version, upgrades, health, backups and restores are tracked and shown, backups are kept
apart from data exports, and a restore is privileged and audited
([ADR-0014](engineering/ADR/0014-mcen-operations.md)).

- **Per Unit Instance.** **Instance operations** in the Vantage Administrator console lists every Unit Instance
  with its app and schema version, last upgrade and whether it kept its rows, health, backup freshness, last
  restore and any feature withheld from it. Its Unit Managers see theirs under **Operations** in the Unit Manager
  console, with the service's own checks as one status. `npm run operations-report` prints the same as JSON on
  the host (I-34).
- **Upgrades checked.** A start that migrates counts every table's rows, and each Unit Instance's, before and
  after. Rows lost that no migration declared, or a migration that fails, are recorded, audited in the platform
  trail and each affected Unit Instance's, and told to staff and the Lead Unit Managers. A Vantage Administrator
  marks one reviewed with a note. **Migration 022** adds `instance_feature_flags`; the upgrade, backup and
  restore histories live in `meta`.
- **Backups.** Each backup is recorded with the newest audit entry it holds and audited, and each Unit Instance
  shows whether the newest backup holds it and how much changed since.
- **Restore.** `npm run restore` is the only supported way: an active Lead Vantage Administrator authorizes it by
  username with a reason and an optional change record, the backup is checked, the replaced database is kept,
  everyone is signed out, and the restore is audited in every Unit Instance and told to its Lead Unit Managers.
  **Backup and restore → Restores** lists the account, authority and hold changes it undid. A database replaced by
  hand is detected at the next start from the lineage beside it, audited and shown on every Unit Instance's health
  (I-35, I-36).
- **Backups are not exports.** `shared/dataTransfer.ts` lists every data export and import, held to the routers by
  a test. **Backup and restore → Not backups: data exports** shows them; each import refuses a database file or the
  service archive, and the archive import refuses a data export.
- **Feature flags per Unit Instance.** Vantage Administrators can withhold file attachments or spreadsheet intake
  from one Unit Instance with a reason its Lead Unit Managers are told, and give it back. John chose "Per
  instance" on the decision card (2026-10-15); AI stays service-wide.

## What changed (2026-10-10: security, audit and least privilege)

The audit trail is categorised, append-only and anchored outside the server, and the findings Tasks 2 and 4 left
for this Task are closed ([ADR-0013](engineering/ADR/0013-security-audit-least-privilege.md)).

- **Audit categories.** Every action is user activity, unit administration or enterprise administration
  (`shared/auditCatalog.ts`), sealed into each entry's hash. Both audit trails filter by category, show it and
  export it. A test fails if anything writes an action the catalogue does not name.
- **Append-only.** The database refuses changing or removing an audit entry. Only the demo purge, an instance
  archive load into a fresh instance and `scripts/start-over.ts` lift the guard, each inside one transaction
  that restores it. **Migration 021** adds the category, the triggers, `email_log.org_id` and the
  `credential_approvals` table.
- **External anchor.** The chain's head goes into the trail, and so off the host, every day something was
  written. The platform audit page shows the head and the last anchor and checks a kept one; a failed check
  tells the Lead Vantage Administrators.
- **Coverage.** Failed sign-ins, refusals at the administration routes, counseling amendments by field,
  unit role edits by permission, new releases, schema migrations, owners named in configuration, revoked
  invitations and the person who restored an archive are now audited. Duty approvals and point overrides
  arrive with Tasks 17 and 18.
- **Second staff member for a takeover.** A temporary password, second-factor reset or CAC change on an account
  that holds authority needs another member of Vantage staff to approve it, used once within 24 hours. This is
  the recommended option on John's open decision card (INFRASTRUCTURE_QUESTIONS I-31).
- **Delivery log.** A unit's support queue sees only the account's own sign-in, reset and address-confirmation
  mail, with status and time.
- **Least privilege.** A unit's leader leads it only while a member, and leaving ends it. "Until proven" (John,
  2026-10-09): an account a Unit Manager created or invited gets no role that reads records, Unit Instance role
  or leadership from them until it signs in with its own CAC or the organization's sign-in. A **Separation of
  duties** page lists dual-hatted accounts. Console reads are limited per person.
- **Inventory and matrix.** `server/authz/privilegedRoutes.ts` lists every privileged route, held to the routers
  by a test that also refuses an ordinary member on each. [docs/security/ASVS.md](security/ASVS.md) maps Vantage
  to OWASP ASVS 5.0.0: V8 and V16 by requirement, the rest by section, with the gaps.
- **After review (2026-10-11).** Authority given up in the last 30 days counts for the two-person rule. A block
  on the staff member who changed an account's sign-in then giving it authority was built and removed on John's
  decision: reset-then-promote is audited and the Lead Unit Managers are told. "Until proven" covers the unit's
  default role and roles a move carries, and a unit the account founded first does not hide who opened it.
  Made-up addresses under a console's guard are one refusal in the trail. Every migration this build runs is audited. A roster restore gives back a
  leadership while the unit is unled. The ASVS matrix now counts a Level 3 shortfall against its section.
- **Open questions** I-30 (who keeps and compares the off-host copy), I-31 (whether MCEN names an approver for
  credential resets), I-32 (audit retention under append-only) and I-33 (the host's time source) are added to
  INFRASTRUCTURE_QUESTIONS.md.
- **Tests:** `tests/server/auditCatalog.test.ts`, `auditAppendOnly.test.ts`, `auditCoverage.test.ts`,
  `credentialApprovals.test.ts`, `leastPrivilege.test.ts`, `privilegedRoutes.test.ts`, a migration 021 test, and
  `tests/browser/34-audit-anchors.spec.ts`, `35-credential-approvals.spec.ts`, `36-separation-of-duties.spec.ts`.

## What changed (2026-10-09: Unit Manager console)

Unit Managers run their Unit Instance's structure and configuration from the console, within limits Vantage
sets for everyone ([ADR-0012](engineering/ADR/0012-unit-manager-console.md)).

- **Units and teams.** The units as a tree, teams (squads and fire teams) on their own, new units and teams,
  moving, archiving and naming leaders.
- **Billets.** A billet catalogue per unit or for the whole instance, and a roster of who fills each billet
  and which are vacant; assigning one updates the membership.
- **Unit roles.** Every unit's roles and holders in one place, with grants that may end on a date.
- **Duty.** Duty types, starting from the specification's list, and **versioned duty scoring**: fixed, per
  day, per hour or by length, with multipliers, published with the day it takes effect and a reason, never
  changed after, and withdrawable only before it takes effect (brought forward from Task 18 on John's
  decision). A calculator in the console shows what a version gives before it is published.
- **Training.** Requirements with a kind, course code, how often they recur and where they apply.
- **Work and reports.** How long a claim on the unit's work holds (now per Unit Instance) and the period
  reports open on (now used by Reports and Records when a person has not chosen one).
- **Imports and exports.** A roster CSV, the structure export, and a configuration file that exports and
  imports billets, duty types, requirements and settings, with a plan shown before anything changes.
- **Audit trail.** Filtered by words, action, unit and dates on the server, paged, and exported as CSV or
  JSON; each export is audited. The platform's trail and the instance's now share one query and one page.
- **Set by Vantage.** Settings shows the enterprise controls a Unit Manager cannot change.
- **New permission `org.config`**, held by Lead Unit Managers and Unit Managers. **Migration 020** adds the
  boundary triggers for the new configuration tables.
- **Tests:** `tests/server/unitManagerConsole.test.ts` (16), `tests/server/dutyScoring.test.ts` (6), a migration 020 test and
  `tests/browser/33-unit-manager-console.spec.ts` (axe on every new page, billets, duty and scoring,
  training, work settings, teams, the audit filter, a read-only Unit Auditor, tablet and phone widths).

## What changed (2026-10-08: Vantage Administrator console)

The Vantage Administrator console runs the service as an enterprise operation
([ADR-0011](engineering/ADR/0011-vantage-administrator-console-operations.md)).

- **Operations.** One health report, worst first: database size, free disk, schema, the audit chain and
  forwarding, backups, email, scheduled jobs, sign-in, maintenance and Unit Instances without a Lead
  Unit Manager. The Overview shows its worst. The same page shows the build and its release history,
  every migration with when it ran and under which version (migration history is now recorded), the
  backups and the scheduled jobs (each now tracked: runs, failures, the last error).
- **Backups are recorded.** A console download and `npm run backup` each record themselves in the
  database they copied. One older than `VANTAGE_BACKUP_MAX_AGE_HOURS` (a week) needs attention.
- **Sign-in health.** Each CRL's issuer and next update, each trusted CA's expiry, a live check of the
  organization sign-in provider, the lockout policy, second-factor coverage and the last day's sign-ins
  and refusals, as counts.
- **Feature flags.** The runtime switches with what the profile locks, what they need, the connection they
  open and who last changed them; the deployment's own flags beside them. Configuration changes are
  audited as before and after.
- **Controlled maintenance.** Its own permission (`platform.maintenance`), a reason to start, a message
  and expected end for everyone else (on every refused request and the sign-in page), a note to end,
  staff told each time, a banner on every console page, and a fixed list of audited database tasks.
  Compacting runs only during maintenance. Settings no longer switches maintenance.
- **Enterprise audit.** The platform trail is filtered and paged on the server and exported as CSV or
  JSON; each export is audited.
- **Visibility.** Recent email names recipients only to `platform.email`; who took a backup only to
  `platform.data` and `platform.audit`. No new read touches a record, and a test checks it.
- **Migration 019** indexes the audit trail by action.
- **`tests/server/adminConsole.test.ts`** (14 tests) and **`tests/browser/32-admin-console.spec.ts`**
  (axe on every new page, the maintenance flow as a Marine sees it, the audit filter and export).

## What changed (2026-10-08: Vantage Administrator and Unit Manager)

The roles are explicit and nobody elevates themselves ([ADR-0010](engineering/ADR/0010-vantage-administrator-and-unit-manager.md)).

- **Names.** Platform roles read Lead Vantage Administrator, Vantage Administrator, Vantage Support and
  Vantage Auditor. Unit Instance roles read Lead Unit Manager, Unit Manager, Records Officer and Unit
  Auditor. The unit permission `ADMINISTRATOR` reads "Full unit authority". The consoles are the Unit
  Manager console and the Vantage Administrator console. Stored keys, permission keys and paths are
  unchanged. `UNIT_MANAGER_ROLES`, `VANTAGE_ADMINISTRATOR_ROLES` and `ORG_STRUCTURE_GRANTS` in
  `shared/permissions.ts` name them for code.
- **Permissions decide.** What a Unit Instance permission confers in units is mapped one to one
  (`org.members`, `org.units`, `org.roles`), and removing a role holder asks for `org.owners`.
- **Scoped to membership.** A Unit Instance role confers nothing while its holder belongs to no unit of the
  instance (`seatedOrgRole`), and ends when they leave their last unit (audited `org_role_ended`), a
  roster separation included. The feed keeps the ended roles with the separated memberships and gives
  them back on restore (`org_role_restored`). Counts, notices and console sign-in count only members.
- **No self-elevation.** Nobody gives themselves, through Unit Instance authority, unit authority the
  chain of command has not given them: a role that reads records, or one that only makes units or
  manages members. Lead Unit Managers included (ADR-0006 allowed it with a notice). Nobody extends a
  unit role they hold. A Unit Manager cannot link a CAC to another role holder's account. A Vantage
  Administrator cannot name themselves a Lead Unit Manager, and `platform.orgs` no longer skips the
  self-service switch or its limit.
- **Removing role holders.** Taking someone else who holds a Unit Instance role out of their last unit
  needs a Lead Unit Manager, by removal or through the roster feed, which holds such separations back
  when someone else runs it. Nothing takes out the last Lead Unit Manager.
- **Unit Manager assignment** (John, 2026-10-08, answering I-27). Vantage Administrators add and remove
  Lead Unit Managers and Unit Managers in any Unit Instance, never themselves, members only, never the
  last Lead Unit Manager (`platform.managers`; **Unit Managers** on each Unit Instance in the Vantage
  Administrator console). The person and the instance's Lead Unit Managers are told; both audit trails
  record it.
- **Vantage support visibility.** A temporary password, second-factor reset, EDIPI correction,
  deactivation or reactivation is recorded in every Unit Instance the person belongs to, and told to its
  Lead Unit Managers when the person holds authority there. Preventing it with a second person is Task 7.
- **`tests/server/roleModel.test.ts`**: the role matrix for both catalogues, every self-elevation door,
  membership scoping, the roster feed's ending and restoring of roles, Unit Manager assignment, CAC
  links, account-support visibility and the last Lead Unit Manager.

## What changed (2026-10-08: one identity, unit membership history, CAC step-up)

Identity is separated from unit membership ([ADR-0009](engineering/ADR/0009-identity-and-unit-membership.md)).

- **One account for a whole career.** A Marine who transfers accepts the new command's invitation into
  the account they have (`POST /api/auth/invite/claim`, and an acceptance page at `/invite` for someone
  signed in). Their id, EDIPI and records stay put. Making a second account for an address that already
  has one is refused (`account_exists`). Leaders can now invite such an address.
- **Membership history.** Migration 018 adds `unit_membership_periods`, written by triggers on every
  membership change, with the reason and the actor added by the server. Each existing membership starts
  with one period. A move inside an instance reads as one transfer. The person sees all of their
  history; a leader sees the part in units of their own instance they can open, and the instance's managers
  its whole part (`GET /api/orgs/:orgId/members/:userId/history`).
  The history is in instance archives and in the personal export.
- **EDIPI proof.** Migration 018 adds `users.edipi_verified_at`, backfilled from card sign-ins under the
  EDIPI each account carries now, and set by card sign-in, card step-up, roster provisioning and a
  provider EDIPI claim. A proven EDIPI is changed only by Vantage support
  (`POST /api/platform/accounts/:userId/edipi`, and **CAC link** in the admin dashboard), with a reason.
  Every change ends the account's sessions and tells the person.
- **CAC step-up.** `POST /api/auth/cac/step-up` confirms a sensitive change with the card the account
  carries. The confirmation dialog offers password, card, or signing in again, according to
  `session.stepUp` on `/api/me`.
- **Card-only and provider-only deployments** now also refuse password resets, account creation from an
  invitation and the emailed sign-in details; card-only refuses the password step-up.
- **Shared accounts.** A Unit Instance can no longer unlock an account that serves elsewhere or runs the
  service, and only the instance holding a Marine's primary unit edits their profile, by hand or through
  its personnel feed. Signing an account out everywhere tells the person and leaves a
  `shared_account_notice` in every other instance's audit trail.
- **Test sign-in.** `VANTAGE_TEST=1` needs `NODE_ENV=test`, and the MCEN profile needs
  `NODE_ENV=production`. The admin dashboard's deployment posture lists the sign-in methods in force.
- **`tests/server/identityMembership.test.ts`**: 10 cases. The OIDC tests also check that a provider
  EDIPI claim proves the EDIPI.
- Open questions I-23 to I-26 are added to INFRASTRUCTURE_QUESTIONS.md. The residual risk is that the
  first link of a never-proven EDIPI is trusted to the person's own Unit Instance (I-25).

## What changed (2026-10-07: Unit Instance data isolation)

The Unit Instance is enforced as a backend security boundary ([ADR-0008](engineering/ADR/0008-unit-instance-data-isolation.md)).

- **Where two units meet, both must be in one Unit Instance.** Member moves, direct enrollment and the
  enrollment directory, the primary unit, project links on entries, tasks and queue items, re-placing
  another Marine's record, thread contacts and thread links, importing a shared upload, a report
  revision's citations, a report or export asked for against another Marine's unit, and linking an
  EDIPI. Refusals carry the code `cross_instance`. A comment or file goes with its record only within
  the instance it was added in.
- **Someone who serves in two Unit Instances** works in each with the authority they hold there, and
  carries nothing, and no reference to anything, from one into the other.
- **Migration 016** adds triggers that refuse, in the database, a change to a unit's organization and a
  cross-instance project link, thread contact or thread link, from both ends. It changes no row; links
  already across are counted into `meta.instance_boundary_violations`. An engine refusal reaches the
  client as a 403 `cross_instance` and is written to the audit trail. An instance archive restores the
  same way: links it brings across are kept and counted.
- **Migration 017** records on each attachment the unit its record sat in when it was added, as comments
  already do, and fills it for existing files from their record's unit. It changes no other row.
- **PostgreSQL row-level security** is evaluated and deferred to the PostgreSQL adapter, with the policy
  written down in ADR-0008 (SQLite has no RLS; triggers are the equivalent here).
- **`tests/server/unitIsolation.test.ts`** proves it: two Unit Instances, a Marine in each, a leader with
  authority in both, and 23 cases across personnel, records and ids, attachments, reports, exports,
  metrics, imports, correspondence, Report Studio, membership, identity, archives, the audit trail and
  the triggers. Ten of them prove the ways across that the code and security reviews found.
- Two behaviors changed: a leader who founds a top-level unit of their own can no longer enrol a Marine
  they lead elsewhere into it directly (that Marine joins by invitation or join code), and an
  organization can no longer link the EDIPI of an account that also serves in another Unit Instance or
  runs the service (it links its own with its CAC).
- Left for later Tasks, as ADR-0008 records: shared-account governance (Task 3), and append-only audit
  with an external anchor (Task 7).

## What changed (2026-10-07: MCEN target, Unit Instances, deployment profiles)

Production targets MCEN, not the public internet ([ADR-0007](engineering/ADR/0007-mcen-enterprise-deployment-and-unit-instances.md), [deploy-mcen.md](deploy-mcen.md)).

- **Deployment profiles.** `VANTAGE_DEPLOYMENT_PROFILE` is `mcen`, `legacy-public` or `development`.
  - `mcen` refuses the legacy site's public-internet services and serves no public site.
  - `mcen` defaults to the DoD consent banner, with self-registration and browser backups off.
  - `mcen` holds self-registration and self-service Unit Instances off at runtime.
  - Unset in production means `legacy-public`, with a warning, so the Render site keeps running.
- **Topology.** `VANTAGE_TOPOLOGY=dedicated` limits a deployment to one Unit Instance, enforced by a
  temporary trigger on the database connection.
- **Provisioning.** `npm run provision-instance` provisions a Unit Instance and its first Unit Manager
  from a manifest. It runs as a named Vantage Administrator, is idempotent, and is audited.
- **Outbound connections.** Every outbound connection is listed in the admin dashboard's overview, with
  how MCEN treats it.
- **Naming.** The admin dashboard, the owner console, server messages and permission labels say Unit
  Instance. API paths, tables, audit action names and the export format are unchanged.
- **Open questions.** I-13 to I-22 are added to INFRASTRUCTURE_QUESTIONS.md.

## What changed (2026-10-07: one central service, three tiers of authority, two consoles)

Vantage is no longer installed per command. It runs as one service for many commands ([ADR-0006](engineering/ADR/0006-centralized-tenancy-and-authority.md)).

**Tenancy.**
- Organizations are tenants (`organizations`, `units.org_id`). Triggers keep every new unit in its parent's organization, make a top-level unit found one, and refuse a move between organizations.
- The roster feed, retention schedules, holds, disposition runs and the audit trail carry their organization. Audit entries seal it into the hash only when set, so older entries still verify.
- Migration `015_organizations` converts a single-instance database in place: each top-level unit becomes an organization, former operators become platform owners, and each organization's owner is its top unit's leader (the former operators where it had none). An instance archive from before organizations is adopted the same way on import.

**Authority** (`shared/permissions.ts`, `server/authz/scope.ts`).
- Platform roles (owner, admin, support, auditor) replace the Instance Operator flag, which is no longer read.
- Organization roles (owner, admin, records, auditor) hold only the structural unit bits, never record reading. Organization owners and admins staff any role below Unit Leader. An admin cannot give themselves a role that reads records; an owner who does is reported to the other owners.
- Vantage access (`server/services/access.ts`) is the only way staff see inside an organization: requested with a reason, approved by an owner (or notify-only, by the organization's choice), read-only, at most 24 hours, revocable, audited in both trails.
- Unit and organization roles can end on a date. Scope ignores an expired grant at once; a sweep every minute removes it and audits the end.
- "Why can they?" (`server/services/explain.ts`) lists every source of a person's permissions in each unit.
- One organization's roster extract cannot change or separate an account that belongs only to another. Separation ends that organization's memberships (restorable on return) and deactivates the account only when it belongs nowhere else.
- Direct enrollment of an account the enroller does not already lead is refused for everyone; people join by invitation or join code.
- CAC and OIDC roster provisioning seat the new account in the organization whose roster lists it.

**Two consoles, two APIs.**
- The admin dashboard (`admin.html`, `/admin`, `/api/platform`) is for Vantage staff. The owner console (`/console/:orgId`, `/api/orgs/:orgId`) is for an organization's owners, administrators, records officers and auditors.
- Each API answers only on its own face's host. `VANTAGE_ADMIN_URL` gives the dashboard a host of its own, and old `/operator?tab=` links land on whichever console now holds the tab.
- `/api/admin` and the account actions under `/api/org/team` are gone. Account resets moved to `/api/platform/accounts`.

**Tests.**
- `tests/server/tenancy.test.ts` covers tenant isolation, the access flow (approve, revoke, notify mode, expiry), organization-role staffing and self-grants, time-bound roles, the explainer, a roster scoped to its own people, and support's limits.
- The 015 migration is tested from a legacy-shaped database.
- `hosts.test.ts` covers an admin dashboard with a host of its own.
- Browser specs cover both consoles and the redirects between them.
- Existing tests now seat people through join codes or the service layer, since direct enrollment needs consent.


## What changed (2026-10-05: cradle to grave)

**One Marine through the whole lifecycle** (`tests/server/lifecycle.test.ts`). The test takes one Marine through eight stages in the real application, each building on the last:
1. joins by code, and the personnel feed sets their rank;
2. claims and verifies a case and keeps the draft, and Quick Logs;
3. the lead sees the counts, not the private entry;
4. JEPES input is written in Appendix E's form;
5. the feed promotes them to Sgt, and the same entries become MRO worksheet input;
6. they leave the unit: held work is released, and the record stays theirs;
7. they export their record, and the feed separates them;
8. nothing is disposed of by default, and the audit chain verifies.

Writing it confirmed two behaviours:
- the Marine who verifies is credited with the verification, and whoever resolves is credited with the resolution;
- leaving a unit ends the Marine's sessions.

## What changed (2026-10-05: FITREP, and the two open data bugs)

**FITREP input, checked against the form and the MARADMINs.** marines.mil refused this environment, so MCO 1610.7B was not read directly. The form (NAVMC 10835), the A-PES MRO worksheet as reproduced in an NPS thesis, the NPS FITREP bulletin and MARADMINs 308/23, 634/23, 575/24, 630/24, 066/26 and 209/26 (on a verbatim mirror) were. What changed:
- **The worksheet's form.** FITREP input is the MRO worksheet's: a Section C draft for its major accomplishments block, and its PME/self-education and Other blocks beside it (`shared/writer/worksheet.ts`, on Analysis and in the PDF).
  - **Section C** is one list of dash bullets with no headings, as the NPS bulletin writes it. It is ordered by the section each line gives evidence for, D to H. The studio shows the section beside each group; Copy and the PDF leave it out.
  - **Routing.** On FITREP, PME completions and Volunteer Service entries go to their own blocks instead of spending Section C's characters. They can still be kept in Section C.
- **One reading of the fourteen attributes** (`shared/writer/attributes.ts`), from the verb and then the words that name an attribute:
  - JEPES command input or FITREPs written are Evaluations, so Section H;
  - a course is PME;
  - "checked on", welfare and barracks are Ensuring Well-Being;
  - decisions are Decision Making Ability; recommendations are Judgment;
  - "no-notice" and "48-hour window" add Effectiveness Under Stress.
  An untagged FITREP entry sits in its attribute's section. Readiness coverage is counted from the same reading, replacing a keyword list that disagreed with the draft. Attribute names are as the form prints them ("Ensuring Well-Being of Subordinates", "Professional Military Education (PME)").
- **Section H.** It was missing from the writer: a Sgt's entry tagged Evaluation Responsibilities was reported as untagged and filed by its verb. It is now an area of its own. Readiness quotes the form ("serving as a reporting official") and treats H as applying only then.
- **Advice corrected:**
  - **PME.** "Complete resident PME for your grade" was shown to everyone, including Marines whose distance PME was complete. Readiness now asks for PME status when it is blank. When status is none, it quotes the PME attribute's baseline from the form. For a Sgt with distance PME, it cites MARADMIN 630/24: the distance program plus Sergeants School or its seminar.
  - **Section references.** The outcome advice named Section I (the reporting senior's comments); it now names Section C.
  - **Fitness.** Fitness scores are placed in Section A, item 8.
  - **Empty sections.** Five near-identical "nothing tagged" cards became one. Missing attributes come with what evidence for each looks like (labelled coaching).
- **Reporting period end.** When it is blank, Readiness says how annual periods end. It offers the date only where a MARADMIN confirms it (active Capt, Maj, LtCol, E-9: 634/23). The other grades follow MCO 1610.7B Appendix A, which was seen only in an excerpt.
- **JEPES citations kept to JEPES.** On FITREP input, holds for annual training and earlier awards no longer cite MCO 1616.1. The AI draft prompt follows the same form.
- **The demo's section lead (SSgt Diaz) has a FITREP record**, so the FITREP side can be explored.
- **Smaller fixes.** Today's readiness reminders link straight to `/career/readiness`. The PDF names its sections in each order's terms.

**The two open data bugs from the audit, fixed** (`docs/AUDIT-2026-10-03.md`):
- **Separated on first sighting.** A personnel extract that lists someone for the first time, already Separated, now turns off the active account their EDIPI is on, within the mass-separation guard. Those accounts count as active before the extract, and a held row is not written, so the next extract raises it again.
- **One document number, two reports.** An import row whose report shares under half its columns with the matched case's report is refused, not written over that case. The preview says how to bring both in. A re-export of the same report with a column added still updates. The import wizard can now key a sheet by a second column.

**Types.** The import wizard and the roster console are typed; explicit `any` in the client went from 212 to 186. Typing the wizard found telemetry that always reported 0 unmapped columns (it read `.length` off a number).

## What changed (2026-10-04: the narrative writer)

The JEPES and FITREP narrative is written by a new engine, `shared/writer/` (design and sources: `docs/product/NARRATIVE_WRITER.md`). The old builder headlined each area with a generic "Processed N things", pasted titles in strength order and cut what did not fit. The writer:

- **Writes in the order's own form.** JEPES input is MCO 1616.1 Appendix E's billet accomplishments: under the three command input lines (Individual Character; MOS and/or Mission Accomplishment; Leadership), a dash, a past-tense verb, the number and the result, acronyms spelled out once. FITREP input is a Section C draft by section, at Section C's 1,232 characters (NPS bulletin), objective and without superlatives. Paragraph form stays one click away.
- **Reads each entry.**
  - Tense ("Reconciling" becomes "Reconciled") and word order ("14 ULOs reconciled" becomes "Reconciled 14 ULOs") are put right.
  - First person, filler and praise adverbs go.
  - A noun phrase gets a plain verb ("Brief to the CO" becomes "Delivered brief to the CO").
  - "Helped" stays "Helped": a stronger verb would change the claim.
  - The entries themselves are untouched.
- **Weighs, groups and plans.**
  - Each entry is scored, with reasons.
  - Every area with work gets its best sentence first.
  - Several plans are tried, and the one that says the most within the limit is kept.
  - The same work is totalled when it would not all fit, or would repeat.
  - Totals account for counted work left out.
  - Case-history credit appears in its own sentence: "Researched 39 documents (2-Way UMT); recorded 66 verified outcomes and resolved 33 cases."
- **Holds back what the order excludes.** Required annual training is set aside with the rule, and can be kept anyway.
- **Never writes the reporting chain's judgments.** It writes no rankings, recommendations or word pictures. The reviewer flags them if typed.
- **Reviews its own writing.** A 100-point grade (areas, outcomes, numbers, openings, length) and findings, each naming the entries that would fix it and what it rests on: an order (MCO 1616.1, NAVMC 10835), guidance (NPS bulletin, Marine Corps Gazette) or style. "Helped" is marked as a preference, because no order forbids it.

**Tested against real typing.** Messy entries from four MOSs (motor transport, admin, infantry, supply) and a harsher batch found real faults, all now fixed and covered by tests:
- **No invented claims.**
  - A title with no verb is never given one ("Completed working on…" claimed something unfinished).
  - Work in progress is held until it is done.
  - Unknown past tenses read as verbs ("Licensed 8 Marines", "Drove in the convoy").
  - A verbless title with the Marine's own classification becomes "Reconciled 30 ULOs … in support of FY26 year-end close".
- **No double counting.** The same entry logged twice (same words, numbers and day) counts once and is held as "looks logged twice".
- **Held back by rule.** Awards for a previous period are held (Appendix E). So are entries still saying "I" or ranking the Marine.
- **Weak lines don't fill a slot.** A line like "Responsible for the armory keys" no longer fills an area just to fill it; the reviewer asks for real work instead.
- **Typing cleaned up:**
  - shouting capitals are set in sentence case, keeping acronyms ("ULOs");
  - a second sentence is joined to the first;
  - "!!!" and emoji are removed; output is plain ASCII;
  - number words become numerals ("twelve MIPRs" → "12 MIPRs");
  - "my degree" reads "degree";
  - "with a 3.8 GPA";
  - an outcome that only repeats the title is dropped;
  - no "(1 Marine)".

**One phrasing everywhere.** Quick Log's preview, an entry's page and the Bullets tab now use the writer, and Quick Log coaches with the reviewer's own notes as you type. The notes come most useful first: what is held back and why, then the outcome, a vague word, a weak opening.

The **narrative studio** on Analysis writes live in the browser:
- **Explains every sentence:** select one to see its sources, score, attribute and why it made the cut.
- **Lets the Marine shape it:** Always keep or Leave out, Another wording (never changes a figure), Best fit/Full/Compact, Bullets/Paragraph, length, and spell-out.
- **Edits by hand,** with a live review as you type.
- **Keeps what was left out** in a Left out list, held entries included.
- **The PDF takes the same choices,** or the edited text.

The optional AI draft is instructed with the same rules.

## What changed (2026-10-04: everyday use)

- **No empty October.** Activities, the JEPES/FITREP input page, Today's outcomes, a Marine's page and the goal metric list opened on the fiscal year, so on 1 October every one of them read as if nobody had done anything. They open on a rolling twelve months ("Last 12 months", a new period everywhere), and a saved choice still wins.
- **A tab bar on phones.** Today, Work, a log button and the Record sit at the bottom where a thumb reaches, with everything else behind More. It steps aside while someone types and while the drawer is open, and toasts and the footer clear it. The header's log button is for wider screens now.
- **Filters that fold.** On a phone the Activities filters sit behind one Filters button with a count, instead of six menus before the first entry. "JEPES" and "FITREP" keep their capitals in every label.
- **Due dates in words.** "Due 07 Oct 26 · tomorrow", "1 day overdue", "in 4 days" on Today, the queue and every case row.
- **⌘K does things.** Switch theme, keyboard shortcuts, import activities from a CSV, and download your record as a PDF, ranked above the catch-all "log this" when they match what was typed.
- **Undo after delete.** Tasks, projects, goals, training, awards, counselings and an entry's own page offer Undo, as the activity list already did.
- **Smaller things.** A case page is titled "Work / Case" (it said "Vantage"), and Quick Log drops the word that introduced a date ("…in DAI on Sep 30" no longer leaves "…in DAI on").
- **The bar follows the role.** Somebody who leads a team gets Team in the tab bar where a Marine gets the Record; the Record stays under More.
- **Titles read whole on a phone.** Case and task rows put the due date under the title instead of beside it, and a title may take two lines before it is cut. The queue's "All open work · Open to claim · Mine · Overdue · Resolved" is one row that scrolls sideways.
- **The demo banner is one line on a phone** ("Demo · Marine | Section lead · Start over"), giving back about half the first screen it took on every page.
- **Packages explain themselves.** Beside the list, four steps say what a package is (choose the period, write against the records, save a revision that re-reads them, export what was reviewed), and each package says when it last changed.
- **Undo after logging.** "Activity logged." carries Undo for the slip of a thumb; the entry goes to the recycle bin like any other delete.
- **Cards that read like headings.** Today's outcome cards say "Dollars reconciled" and "Hours logged" instead of "Dollars, Reconciled" and "hours". A unit or value type an owner named keeps its own wording and case.
- **Reminders that say how many.** The record card read "readiness fields incomplete"; it now reads "3 readiness fields incomplete · rifle qualification · MCMAP belt · PFT".
- **Time zones by place.** Settings lists "New York · EDT" and "Okinawa / Tokyo · GMT+9" instead of raw zone names.
- **What's new, in the app and on the site.** The user menu, ⌘K and the version in the footer open a dated list of the changes a Marine would notice (`src/config/changes.ts`). A small dot on the avatar marks it until it has been read, for people who were here before the latest change. The same list is a public page, `/changes`, prerendered, in the sitemap, and linked from the site's menu and footer.
- **⌘K forgives apostrophes.** "what's new" typed with a straight apostrophe finds "What’s new".
- **The plain-language pages are checked like the rest.** Security, privacy, accessibility and what's new now run through axe in the browser suite, and their bulleted lists show their bullets again (the CSS reset had removed them).
- **Goals know their pace.** A goal that builds over its period (increase or decrease) says "Ahead of pace", "On pace" or "Behind pace" against the share of its period gone, within ten points, with a tick on its bar where an even pace would be; a behind goal's bar turns amber, on the Goals page and on Today. It says nothing in the first tenth of a period, after it ends, once it is met, or for a threshold (a PFT score) or a completion goal (`goalPace` in `shared/metricEngine.ts`). The countdown reads "30 days left" rather than "(30d left)", and the figures read "21 of 30 UMTs" and "60 of 100% complete" instead of repeating the unit.
- **Tasks say who.** A Marine without the roster saw "→ Assigned from Assigned" on a task their section lead set. Task rows now carry the setter's and holder's names (only on rows the reader can already open, and never their own), so it reads "from SSgt Diaz". Titles take two lines on a phone and due dates say "tomorrow" or "in 3 days".
- **Projects and stat cards.** A project opens from its title (the stray "Open" link is gone), counts read "2 of 5 tasks done" or "No tasks yet", and its due date says how close it is. Stat cards let a label and a hint take two lines, so three across a phone read "Training hours" and "Awards in progress" instead of "Training ho…".
- **Steadier timing tests.** One full server run failed once, straight after a production build, and did not fail again in five more full runs. The likeliest cause was the speed tests added in the audit, whose budgets (50–400 ms) were tight for a busy machine. Each now has 10–30 times its usual time and still fails on the slowdowns it guards against: the Quick Log test uses 20,000 figures (30 ms linear, seconds if quadratic).
- **The roster fits a phone.** On a phone the six-column table left a name two words wide and the controls off the screen; it is a list now (name, billet · MOS · team, roles, and the same controls). Each "Open" names whom it opens, for a screen reader.
- **Each Team page says what it is for.** Workload, Roster, Unit dashboard, Roles, Units and Access log each have their own one-line lede instead of the overview's paragraph; the privacy promise stays on the overview and the roster.
- **Age of open work, said exactly.** "One to four weeks" counted 7 to 30 days; the rows now read "Under 7 days", "7 to 30 days" and "Over 30 days", each with a bar for its share, over 30 days in amber.
- **One way to write a date.** Today's "Who holds what" read "since 2026-09-05", a package's heading "2026-07-07 to 2026-10-04", and award, counseling, access-log, conflict and entry-history times used the browser's own format ("9/18/2026, 9:31:02 AM"). All now read the way the rest of Vantage does ("05 Sep 26", "28 Sep 26 1432").
- **Smaller things.** Drafts with nothing in them use the full width and offer "Open my work"; the unit dashboard no longer says "the rest need a result written" at 100%.
- **Quick Log hears the outcome.** "…in DAI on Sep 30, all cleared on the next report" used to leave Result empty and the preview asking "so what?". A closing clause that says what came of the work (after a comma, semicolon or dash, opening with "resulting in", "which", "so", "saving", "clearing", "all", "each", "zero", "no" and the like) fills Result and leaves the title, while a list such as "for G-8, S-4 and S-1" stays put (`parseQuickLog`'s `result`).
- **A bullet says a figure once.** A title that already named its amount ("$48,250", "$1.2 million") got it again at the end ("…, $48,250.00."); the bullet now compares the title's figures by value.
- **An entry's gaps are one tap from the fix.** On an entry's page each gap ("No quantity (how many?)") opens Edit, and a missing area reads "Untagged" there as it does in the list (it said "Unassigned" on one and "Untagged" on the other).
- **Smaller things.** Activities' delete is a trash icon named for its entry ("Delete Cleared 4 2-Way UMTs…") instead of an anonymous "×", and the Career cards (training hours, awards, counselings) open their tabs.
- **The narrative's opening line makes sense.** The JEPES/FITREP narrative opened "MISSION: Processed 10 km, 6 hours and 4 UMTs valued at $6K." Its headline now counts work products only ("Processed 4 UMTs valued at $6K."); a hike's kilometres, points and percentages are left to the sentences about those entries, and hours appear only when nothing countable was logged ("Completed 3 documented actions over 22 hours."). The PDF uses the same text.
- **Each package section says what it wants.** Every section's empty box said "Write what changed because of the work, in the units it was measured in.", Leadership and Individual character included. Mission, Leadership, Character, Intellect and Wisdom, and Evaluation responsibilities each have their own prompt.
- **⌘K's search box has no stray outline.** The global focus ring drew a hard rectangle into the palette's top edge; the caret and the highlighted result already show where focus is.

## What changed (2026-10-03 audit and upgrade)

A second outside review, of the live site and the code, found two high-severity security problems and fixed them:
an unauthenticated request that could freeze the server (an exponential password-policy pattern), and a goal "measured
across the unit" that let a member read entries they could not open. It also fixed four denial-of-service and
disclosure issues (workbook reader, email sanitizer, lockout name disclosure, rate limits behind Cloudflare), more
than twenty correctness bugs (among them FITREP packages losing every Quick Log entry, roster sync deactivating people
for good, Quick Log dating "Sep 30" as today), and the live site's broken pages. The public site gained security,
privacy and accessibility pages, `security.txt`, a hero and a "built for your role" section aimed at the Marines it is
for, and a real footer. Details, verification and what is left for the owner: `docs/AUDIT-2026-10-03.md`.

## What changed (2026-10-02 audit)

An outside review of the code, the running demo and the security model found the issues below; each is fixed
with a test unless noted.

**Bugs.** A workbook that understated its sizes expanded past its limit (239 KB to 240 MB); the real expanded
size is now charged. A case history whose seals were removed read as "unsealed" and passed the check; it now reads
as broken, and the check covers every case. The Record, contribution history and team workload treated local days
as UTC days, so work done after 8pm Eastern dropped out of today (and the test suite failed every evening); windows
now span the instants their days really cover. nodemailer carried five high-severity advisories; it is on 10.0.13.

**Accreditation controls.** 15-minute idle sessions (10 for owners) that a background poll cannot keep alive, with a
warning before sign-out; a lockout after three failures kept in the database; PBKDF2-HMAC-SHA256 password hashing
with scrypt hashes replaced at sign-in; the DoD Notice and Consent Banner, enforced on the server
(`VANTAGE_CONSENT_BANNER=dod`); CRL checking for direct-mode CAC, failing closed; clamd scanning of every upload
(attachments and email too), optionally refusing what could not be scanned; audit records sent off the host to a
syslog collector as they are committed; a rotatable `VANTAGE_SECRET`; browser backups that can be turned off and
that notify every other owner, plus `npm run backup` on the server; direct mail never connecting to private
addresses. See `docs/security.md` and `docs/operations.md`.

**Daily use.** ⌘K finds cases by document number; a Marine's Today opens on their own work; the queue shows cents,
whole titles, and overdue items with an Overdue filter; one date style throughout, with full timestamps in case
history; per-person time zones; the theme follows the device; shorter page headers; scroll cues on tab strips; and a
demo whose team view, Reports and Owner console show something.

**Engineering.** CI gates on `npm audit`, publishes a CycloneDX SBOM, scans the image with Trivy and runs CodeQL;
the base image is pinned by digest; versions are tagged on main; the hand-written parsers are fuzzed.

**Organization sign-in.** Entra ID (commercial, GCC High, DoD) or any OpenID Connect provider can sign people in:
code flow with PKCE, single-use hashed state and nonce, the ID token verified against the provider's keys, and the
account bound to the provider's subject. It can link by verified email or an EDIPI claim, create accounts for active
roster members, and be the only way in (`VANTAGE_OIDC_EXCLUSIVE`). See `docs/cac-and-records.md`.

**Types.** The case page, assigned work, team workload, the record stores, the roster, a member's page, the org and
roles now have one shared response type each, which the server's builders are checked against, so a change on one
side the other does not expect fails the typecheck. Doing so found a counseling list that offered "for <name>" from a
field the server never sent (it sends it now). Explicit `any` went from 323 to 221 (186 in the client by 2026-10-05) and cannot grow: `npm run lint`
fails when a directory holds more than its budget in `scripts/any-budget.json`.

**Still open.** PostgreSQL (and with it running more than one server process), SAML, and the remaining `any` in the
owner console's retention and privacy panels. Owner decisions outside the code are unchanged (below).

## Earlier (2026-09-25)

**The FMRA knowledge, in the product.** The FMRAC reference (the 3451 Financial Management Resource
Analyst course material) is encoded as a typed, cited knowledge base in `shared/fmra/`: the four
lifecycle phases, the seven purchase methods with their supporting documents, the normal conditions
(OCMT, UDOU, DOU, OTO) and their causes, abnormal conditions (feeder rejects, interface errors, invoice
holds, UMTs and their error classes), roles and separation of duties, the data elements, the glossary,
the discrepancies found in the source, and the answer format and "never" rules. Every statement is
cited and labelled source, editorial or discrepancy. It powers:

- **Reference** (a new destination): the desk reference, searchable from ⌘K, and a balance diagnoser
  that opens a case with the figures already recorded.
- **Eight FMRA procedures** alongside the 2-Way UMT (now v0.2.0 with the NON-1081 match step), on a
  generalized procedure engine: pinned versions with explicit, attributed migration; conditional
  branches; evidence gates shown before they refuse; not-shown figures; stale calculations; resolution
  only on a verified outcome.
- **The case page**, rebuilt around that engine: a lifecycle reading with the method's supporting
  documents, the procedure checklist, the current step's form, corrections that keep the original, the
  history's seal status, and (where AI is enabled) a case brief in the reference's answer order.
- **Imports** that apply a procedure (one, or chosen per row from the figures) and map the lifecycle
  columns; a queue filter and chip by procedure; Today's count of open work by procedure.
- **Tamper evidence**: every case history is sealed in a per-case HMAC chain with a signed head, and the
  day's heads are anchored in the audit chain. The Owner console's integrity check covers both.

**The interface, rebuilt on one design system.** Geist type, navy-tinted depth tokens, a navy rail,
spring motion, restyled primitives, dialogs, toasts, menus and command palette (six overlapping
stylesheets folded into one). A new public landing page and a split sign-in page. An update banner when
a newer build is published. See `docs/design/DESIGN_SYSTEM.md`.

**All sixteen recorded defects (F01–F16) closed**, each with a test:

| | Defect | Now |
|---|---|---|
| F01 | Legacy resolution bypassed the verification gate | Every path that resolves a procedure case answers to its resolution condition |
| F06 | Correcting an input left the old calculation standing | A calculation is marked stale, with the reason, once an input is corrected or re-read |
| F12 | Append-only history was not tamper evidence | Per-case HMAC chain with signed heads, anchored daily in the audit chain |
| F13 | The stored procedure version did not select the definition run | A case runs the version it is pinned to; moving it is explicit and attributed |
| F14 | Reimported source changes did not reach the case history | A `source_revised` event records what changed; seeded values are superseded, research is untouched |
| F16 | The service worker's version was maintained by hand | The build stamps its own hash into the worker and `/api/health` |
| F02 | Leaving a unit left claimed-work access | Access to shared work follows current membership only; leaving releases held work, with the reason in each case's history |
| F03 | Private case activity in shared totals | Every unit total and member breakdown counts only live, unit-visible work of that unit |
| F04 | Corrected verifications still counted | A verified outcome counts only while it stands and is not overtaken; verification actions are counted separately |
| F05 | A claim alone could become an accomplishment | A draft needs substantive facts; an empty draft cannot be saved |
| F07 | Automatic cleanup bypassed legal holds | The recycle-bin purge and source pruning read the same holds and write disposition evidence |
| F08 | Mailbox sign-in stopped before a token | OAuth code flow with PKCE per national cloud, bound to the person and the mailbox, read-only enforced, tokens encrypted and renewed, failures visible, and an honest notice when unconfigured |
| F09 | Case facts did not feed metrics | A saved draft links its case, cites each fact, counts once, and credits money only for a resolved outcome the person verified |
| F10 | Mutations left views stale | One invalidation map by kind of change |
| F11 | Failures looked like emptiness or denial | Offline, signed out, denied, missing and server errors are told apart, with retry |
| F15 | A red commit could deploy | `autoDeployTrigger: checksPass`, and the browser suite passes |

**The films, made in code** (`film/`, `npm run film`). A 90-second hero film for the public page and
six narrated chapters for the field guide (Quick Log, working a case, reading a balance, the Record,
Report Studio, leading a section), recorded on the real application in the synthetic demo. One script
drives the narration (ElevenLabs, cached), the timing, the captions, the capture (Playwright on a
virtual clock, synced to the narrator's words), the picture (Remotion) and an original synthesised
score, mixed to −14 LUFS. A film is published to the landing page and field guide only when all its
narration is recorded voice. Making them surfaced and fixed four product defects: the case history's
doubled verbs, a doubled full stop in the figures' reading, "1 quantity" where Quick Log had read "30
ULOs", and a case opened from the diagnoser that its opener did not hold.

**Hardening.** CORP, Origin-Agent-Cluster and related headers; `upgrade-insecure-requests` in
production; null-prototype registries for anything looked up by a request's key; every table declared
in the privacy inventory; the financial answering rules on every AI prompt.

## Verification

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (server, web, browser tests) | clean |
| `npm test` (server suite, in-memory SQLite) | **774 / 774 pass** (2026-10-11) |
| `npm run test:browser` (Playwright, Chromium, built client) | **123 / 123 pass** (2026-10-11; 122 desktop, 1 phone) |
| Accessibility | axe: no serious or critical violations in either theme on every core page, the case page, the Reference, the public page and the security, privacy, accessibility and changes pages |
| `npm audit` | 0 vulnerabilities |

### Not verified

- A live Microsoft tenant. The mailbox flow and organization sign-in are tested end to end against local stand-ins
  for Microsoft and an OIDC provider; a real Entra registration in GCC High or DoD has not been exercised.
- The FMRA procedures against a current SOP or an SME. They are labelled "formal training reference,
  not verified against current policy", and screen paths are left undocumented until confirmed.
- PostgreSQL, Windows Server, a real CAC (revocation is tested with a fixture CA and CRL), a real clamd (tested against
  a stand-in speaking its protocol), a real SIEM, a restricted-network host, backup and restore drills.

## Owner decisions

1. The FMRAC reference content is committed to this public repository at the owner's instruction,
   although the source is marked for the DoD community. The public landing page describes the FMRA
   features at feature level only; the reference itself is inside the signed-in application.
2. The old walkthrough recordings stay unpublished (`91566f1`). They are replaced by the films above,
   which publish only once narrated; until then the landing page shows no player, and its test checks
   that no empty player is shown (and, once published, that every film loads).
3. "Until proven" (2026-10-09): an account a Unit Manager created or invited gets from that same person no
   role that reads records, no Unit Instance role and no unit to lead until it signs in with its own CAC or the
   organization's sign-in (ADR-0013 §8).
4. Vantage Administrators add and remove Unit Managers in any Unit Instance at any time, never themselves, and
   that instance's Lead Unit Managers are told each time (2026-10-08, ADR-0010 §5; unchanged by Task 7).
5. No block on reset-then-promote (2026-10-11, "Remove it"): the staff member who changed an account's sign-in
   may then give it authority. Both steps are audited and the instance's Lead Unit Managers are told of a new
   Unit Manager. The 30-day lookback for the two-person rule stays (ADR-0013 §5, Alternatives considered).
6. "Marine confirms" (2026-10-17): nothing moves out of Activities when Vantage upgrades. Each Marine sees the
   entries that read like awards or training and moves the ones that really are; a move keeps its lineage and can
   be undone (ADR-0015 §6).

## Next actions

1. Walk an FMRA through the diagnoser and one procedure of each family, and correct the step wording
   and screen paths from what they say.
2. Register a Microsoft Entra application in the target cloud and run one real mailbox sign-in and one real
   organization sign-in (`VANTAGE_OIDC_ISSUER`).
3. The films are published without narration, at the owner's request (score, sound and captions,
   which play by default; `voiced: false` in `src/config/films.generated.json`). To add the voice: put
   `ELEVENLABS_API_KEY` in the environment's settings and run `npm run film`, which voices the script,
   re-times and re-captures every scene to the real delivery, and republishes (film/README.md).
4. Protect `main` in GitHub with the three CI checks required (see `docs/deploy-render.md`).
5. Answer the open decision card on who approves a support takeover. Until then the recommended "Second staff
   member" is built (ADR-0013 §5, INFRASTRUCTURE_QUESTIONS I-31).
6. Name who keeps the off-host audit copy and how often it is compared with the anchors (I-30), and the audit
   trail's retention (I-32).
