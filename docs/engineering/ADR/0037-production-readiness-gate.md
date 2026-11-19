# ADR-0037 · The production readiness gate: a register of evidence, and a verdict computed from it

**Status:** accepted · **Date:** 2026-11-19 · **Builds on:** [ADR-0013](0013-security-audit-least-privilege.md) (the
audit trail and least privilege), [ADR-0014](0014-mcen-operations.md) (backup, restore and upgrade on MCEN),
[ADR-0035](0035-fresh-authority-across-waits.md) (fresh authority across waits), the security review
(`Vantage_MCEN_Security_Review_and_Coding_Plan.pdf`)

## Context

Task 28 of `VANTAGE_CLAUDE_MASTER.md` (P0): test the representative roles (Marine, supervisor, NCO/SNCO, Unit Leader,
Unit Manager, Vantage Administrator) against unit isolation, privilege escalation, identity, personnel history, the
import and export round trip, attachments, report PDF and print, financial snapshots, case diagnosis, duty scoring
version changes, the counseling PDF, accessibility, performance, migrations, rollback and recovery, and the build, type,
lint, unit, integration and end-to-end checks. "Do not call Vantage production ready with unresolved critical/high
defects."

Each area already had deep tests from the Task that built it. What did not exist was one place that says, for this
candidate, which requirement each test shows, which defects were found and how each was closed, which checks ran and on
what, and what only someone outside the code can close. Without that, "production ready" is a sentence someone writes.

## Decision

### 1. A register, checked like code

`docs/engineering/readiness-gate.json` holds four lists:

- **Items:** each requirement of the gate, its source, the roles it covers, a status (`proven`, `partly`, `open`,
  `external`) and the tests that show it, cited by file and title. `partly` and `open` say in a note what is not shown.
- **Defects:** each defect the gate found, with its severity and area. `fixed` names the test that fails without the
  fix. `accepted` names who accepted it, and a critical or high defect cannot be accepted, only fixed or kept open.
- **External:** what the code cannot close (an owner's decision, an approval, evidence from the intended host), each
  with its owner.
- **Checks:** each check run on the candidate, the commit it ran on, and its result. Only `pass` counts; a required
  check that failed, was cancelled or did not run fails the gate.

`scripts/readiness-gate.ts` checks the register: every cited file exists, every cited test title is in its file, every
claim has evidence, every item has an owner, every role is covered. `tests/server/readinessGate.test.ts` runs that
check, so a register that cites a test someone renamed fails the suite.

### 2. The verdict is computed, in two parts

- **Engineering gate:** passes only when no critical or high defect is open, no gate item is `open`, and every required
  check passed. The script computes it; nobody writes it.
- **Operational release:** always "not ready" in this file. It waits on every external item and on the authorizing
  official's decision to operate, which the code never makes.

`docs/engineering/READINESS_GATE.md` is drawn from the register (`node scripts/readiness-gate.ts --write`) and the test
fails when the two differ, so the summary never claims more than the register holds.

### 3. The role matrix in one file

`tests/server/readinessGate.test.ts` sets the six roles up side by side in one Unit Instance, with a second Unit
Instance beside it, and tries each against records, personnel, the consoles, escalation, another instance's ids, duty,
the counseling worksheet, exports, attachments and the report PDF. The deep tests stay where they are; this file is
where the roles are compared.

### 4. Defects the gate found are fixed with a test that fails without the fix

`tests/server/readinessGateDefects.test.ts` holds one test per defect fixed in this Task, each shown to fail on the
code before its fix. The defects, and the rules they now hold to:

- **Reach inside a Unit Instance.** A unit export, team workload (and its report), a unit-measured goal and the AI
  command brief read the units beneath only where the reader reads them in their own right (`readableSubtree`, as the
  dashboard does). A unit export also needs View shared records. A unit report, or a brief, leaves as a file only with
  the export permission in every unit it reads.
- **EDIPIs.** A Unit Instance's audit trail never shows, matches or exports an EDIPI (its readers include roles that
  may never see one, ADR-0012). A personal export names other people by rank and name where their username is a card's
  EDIPI, and gives the Marine their own sign-in addresses only, never those of people who acted on them.
- **The service archive** (`POST /api/platform/import`) is refused when it comes from a newer build, holds no audit
  trail, or holds one that does not verify, and is taken only by a fresh instance (one account, one Unit Instance, no
  records). An archive sealed under another secret is refused before anything is replaced.
- **Recovery and keys.** The audit log's append-only triggers are put in place on every start, including for a
  database copied without them. A restore across a secret change seals the stored secrets again, and a rotation is in
  the trail. A settings change refused for its metrics changes nothing. The database directory is `0700` and the file
  `0600`, and browser backups are drawn in a private directory.
- **Smaller ones.** Moving a unit under another parent says where it sat before. Signing out forgets the recently
  opened list in both storages. A counseling copy that prints an EDIPI always carries the PII notice. An assignee's
  export leaves out a task its owner binned.

## Consequences

- A gate claim is as strong as the test it cites, and no stronger: the register can be read against the suite.
- The engineering gate can pass while operational release waits, and the summary says so in its first lines. The
  owners outside the code (the sign-in method policy, the dynamic scan key, code-scanning dispositions, MCEN host
  evidence, the authorizing official) are named, not implied.
- A later Task that closes an open defect or an external item edits the register and redraws the summary, and the test
  holds it to the evidence.
- Mediums and lows the gate found and did not fix stay in the register as open, each with its area and why it was not
  closed here. They are work for later Tasks, not hidden.

## Not done

- **A dynamic scan.** HawkScan needs a StackHawk API key this environment does not have.
- **CI.** Disregarded on John's standing instruction (2026-10-08). The full browser suite ran in the container, because
  GitHub's browser job stops at 25 minutes and the suite takes about 32.
- **Security review packages C06 to C35** beyond the defects above. Their code-side defects are in the register; the
  policy, evidence and conditional parts wait on their owners.
