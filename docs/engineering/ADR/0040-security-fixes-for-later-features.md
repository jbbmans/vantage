# ADR-0040 · Step-up on Unit Instance authority, complete session audits, and private entries kept private

**Status:** accepted · **Date:** 2026-11-22 · **Builds on:** [ADR-0012](0012-unit-manager-console.md) (step-up on the
Unit Manager console), [ADR-0013](0013-security-audit-least-privilege.md) (the audit trail and its categories),
[ADR-0014](0014-mcen-operations.md) (backups and restore), [ADR-0025](0025-training-evidence.md) (evidence files),
[ADR-0027](0027-counseling-workflow-navmc-2795.md) (counselings), [ADR-0035](0035-fresh-authority-across-waits.md) (sessions)

## Context

Round 2 builds statistics, a fuller Unit Manager console, email and database work on the security controls already in
place. The readiness register (`docs/engineering/readiness-gate.json`) held open defects in exactly those controls, and
a read of the statistics code found two more:

- `/api/orgs` (the Unit Manager console) asked for step-up on every change; `/api/org` made the same unit changes on the
  same Unit Instance authority without asking (`stepup-bypass-via-org-router`). The register named the unit routes; a
  review of the rest of the router found every unit, member, role, invitation and join-code change open the same way.
- A password step-up, signing out one session from the sessions list, a session pushed out by the limit and a session
  that ran out were in no audit entry (`password-step-up-unaudited`, `single-session-revoke-unaudited`,
  `c28-session-lifecycle-unaudited`).
- A security setting took a negative number, a fraction, an exponent or hex, or a value past any sane range, and some
  were clamped without a word (`c08-mcen-accepts-invalid-security-numbers`).
- On MCEN, mail to the relay could go in the clear (`c18-mcen-smtp-cleartext`).
- A backup copy was readable by other accounts on the host while it was drawn, and was made owner-only only afterwards
  (`backup-copies-world-readable`). A backup that names no database was taken for this one's own
  (`pre022-other-database-not-refused`).
- A file kept without a malware verdict carried no mark (`attachments-no-scan-verdict`).
- Closing or reopening a case from its row, or closing it with an action, wrote no audit entry
  (`work-close-reopen-unaudited`). A restore from the bin did not name whose record it was (`restore-audit-no-subject`).
- A Marine's page sent when they last signed in to any leader who could open it, though the roster and the personnel
  record give it only to those who manage them. A unit's access log listed what a Marine did to a private entry, so a
  leader who is refused the entry learned that it exists, when it changed and what files it holds.

## Decision

1. **Step-up on Unit Instance authority.** An `/api/org` change asks the person to confirm it is them, as `/api/orgs`
   does, when it rests on Unit Instance authority: the person holds a Unit Instance structure role in that unit and the
   chain of command does not give them full authority there, from a place at least as high as the Unit Instance role's
   (`restsOnInstanceAuthority`). Naming a unit's leader asks when it rests on the instance's Manage units, not on
   leading the unit. A Unit Leader, or anyone the chain of command gives full authority in the unit from its leader's
   place or above, is not asked, whatever Unit Instance role they also hold. Someone whose chain role falls short of
   that, by what it gives or by its place, and who also holds a Unit Instance role is asked, since the change, or
   whom it reaches, may rest on either. Moving a unit asks about its new parent only when the parent changes, so
   renaming a unit one leads is not asked. Taking someone out of their last unit in the instance asks whenever it
   ends a Unit Instance role they hold, as the console does, since that rests on the instance alone; so does archiving
   the last unit one serves in there, which ends one's own. A bulk personnel
   change is asked when it runs, not on its dry run. Joining with a code and the unit export are untouched.
   `assertSudo` is the one refusal (`403 sudo_required`); the route inventory marks these routes
   `stepUp: 'instance_authority'`, and its test reads the check from the code. In the app, `withSudo` lives in
   `src/lib/sudo.ts` and every `/api/org` write goes through it, so the app asks and retries as the consoles do.
2. **A session that ends alone is in the trail once, under its id.** A password step-up is `password_step_up`. Another
   session of one's own signed out from the sessions list is `session_revoked`; this session signed out there is
   `logout`. A session the limit pushes out is `session_evicted`, and one that runs out, found by a request or by the
   prune, is `session_expired`, naming the limit it reached first (idle or absolute); both are written by the service. Every sign-in, sign-out and step-up names its session
   by the 12 characters of its id the sessions list shows (entity `sessions`). A wrong password at step-up still counts
   toward the lockout and is not written one by one. `session_revoked` stays off the restore review list, since a
   restore ends every session anyway. Sessions ended together (signing out the others, a password, role, membership,
   MFA or EDIPI change, a removal or a forced sign-out) are in the entry for the change that ended them, not one by
   one, as before.
3. **Settings are whole numbers in range, on every profile.** Every numeric setting is read by one `envInt(name,
   fallback, min, max)`: digits only, a safe integer, within its bounds. The start names a bad one. The quiet clamps are
   refusals now. Where 0 already meant "never" (`VANTAGE_INTAKE_RETAIN_DAYS`, uploaded workbooks kept until their
   owners remove them), 0 is in range. A setting's old name (`VANTAGE_OPERATOR_IDLE_MINUTES`) is read only when its
   new one is not set, so a stale old value never stops a start the new one configures. The ranges are wide enough for every default, test and known deployment; how tight a session limit an
   accredited host sets (an idle limit of 15 minutes at most, for example) is policy for the ISSM, not a ceiling here.
4. **Mail to the relay is TLS only on MCEN.** The transport is built from the parsed `SMTP_URL` (address and sign-in
   only) with TLS required, TLS 1.2 at least and a certificate that checks. `smtps://` is TLS from the first byte (465
   by default); `smtp://` must start TLS (587 by default). The start refuses an `SMTP_URL` that is empty, not `smtp:` or
   `smtps:`, or whose query sets `secure`, `requireTLS`, `ignoreTLS`, `opportunisticTLS` or `tls.*`, or whose user
   name or password holds a `%` that starts no escape (written `%25`). The certificate is checked against Node's
   bundled roots; a relay whose certificate an enterprise CA signed needs that CA in `NODE_EXTRA_CA_CERTS`, since the
   host's own store is read only under `--use-system-ca`. Other profiles keep their delivery as it was.
5. **Every database copy is private from its first page.** `backupDatabase(db, dest)` makes the file owner-only (0600)
   before SQLite writes to it and removes a file it made when the copy fails. The browser download, the server backup,
   both copies a restore takes and the start-over copy use it; `scripts/backup.ts` makes a new directory for the copies
   owner-only (0700). A database SQLite cannot read through is kept by `copyFilePrivate`, its bytes into a file that is
   owner-only before the first (a plain file copy would give it the source's permissions), its write-ahead log too.
6. **A backup that names no database** is this database's only when the trail here holds the backup's newest entry with
   the same hash. Otherwise it is another database's: refused without `--different-database`, and never given this
   database's name.
7. **A file keeps what the scan said of it.** `attachments.scan_status` (migration 042) is `clean`, `skipped` (kept
   without a verdict: no scanner, or one that timed out or could not be reached while scanning is optional) or
   `unrecorded` (kept before verdicts were). An upload and a record import store it; the answer, the file lists, the
   trail (`; scan clean`) and the personal export carry it. Both file lists mark a file that is not `clean`: "Not
   scanned" or "No scan on record". Only `clean` is clean.
8. **Closing and reopening a case is audited on every path**, as `work_closed` or `work_reopened` with the stage it
   moved to, as moving it from its stage already was. Sending a closed case the same state again writes nothing.
9. **A restore names whose record it was**, as the delete does, so the Marine sees it in their own trail.
10. **When a Marine last signed in** is on their page only for them and for those who manage them
    (`personnelAccess().manageIn`), as the roster and the personnel record have it. Reading their records is not
    managing them.
11. **What is done to a private entry is filed under its Unit Instance, never a unit.** `audit()` decides it as the
    entry is written, from the record as it then is (`privateEntry`): an activity, project, task, goal, training,
    award, case or counseling kept private is filed with its Unit Instance and no unit, so no unit's access log lists
    it, while the Unit Instance trail keeps it. So is a private workbook in work intake and its import, contact,
    correspondence thread (and a message in it), report draft (and its revisions and exports) and saved report. A
    counseling a leader writes keeps its unit, as its counselor reads it there. Each end of a move is filed as its own
    row was: the one it left as it was before the move, the one it became as it is, so a duty undone back to a
    private activity is seen leaving its unit and the activity is not seen. A shared entry made private is filed under
    no unit from then on. Entries written before keep their unit: the trail is sealed.

## Consequences

- Each defect has a regression test in `tests/server/readinessGateDefects.test.ts` that fails without its fix, and the
  register marks each fixed with that test as evidence. `tests/server/migrations.test.ts` covers 042.
- A Unit Manager working in the app is asked to confirm it is them before a unit change, as the console asks; a Unit
  Leader working in their own unit is not.
- The trail now names each session at its sign-in and, where it ends alone, at its end; sessions ended together are
  in the entry for the change that ended them. It holds every case close.
- A deployment with a bad number in its settings, or plain mail to the relay on MCEN, does not start, and says why.
- A unit's access log is a little shorter: it holds what was done to the unit's shared entries and to the unit itself.
- A Unit Leader who is also a Unit Manager is asked a little more: before ending a Unit Instance role from the unit
  routes, their own too, and wherever their full authority comes from a role placed below the Unit Instance role.
- One migration (042), one column with a default; no row changes.

## Not done

- STIG ceilings on session settings for MCEN (`c08-mcen-weak-postures-not-refused` stays open for the ISSM to set).
- Entries written before this keep the unit they were filed under.
- The saved-message import still reads and scans a whole file before deciding where it may go
  (`eml-scan-before-authorization`).
