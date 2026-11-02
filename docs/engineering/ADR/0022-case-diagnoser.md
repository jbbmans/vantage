# ADR-0022 · The automatic financial case diagnoser: rules first, every statement labelled, every source ranked

**Status:** accepted · **Date:** 2026-11-02 · **Builds on:** [ADR-0005](0005-money-and-procedures.md),
[ADR-0008](0008-unit-instance-data-isolation.md), [ADR-0011](0011-vantage-administrator-console-operations.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0019](0019-import-export-restore.md), [ADR-0021](0021-financial-error-reports.md)

## Context

Task 16 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is the "Automatic Financial Case Diagnoser":
diagnose uploaded cases and identify issue type, probable cause, missing information, research needed, systems to
inspect, calculations, corrective action, approvals, verification and resolution criteria. Use the provenance order
1 official policy, 2 official system guidance, 3 approved command SOP, 4 validated SME workflow, 5 validated historical
case, 6 inference. Label every statement Known Fact, Derived Value, Recommendation, Unknown or Human Decision Required.
Never present inference as policy. Core rule and SOP guidance must work without AI.

What main held before this Task (at `ed6634f`):

- **A balance reader** (`shared/fmra/diagnose.ts`): from commitment, obligation, delivered and paid it names the open
  lifecycle conditions (OCMT, UDOU, DOU, OTO), out-of-order anomalies, and the FMRAC's causes, research, roles and
  verification. It ran on the case page ("What the figures show"), in the Reference page's practice tool, in import
  and in the AI case brief.
- **Procedures as versioned code** (ADR-0005): typed steps with help, systems, responsibilities, gates and resolution
  checks, each carrying an `Authority`. Progress is derived from the case's append-only events.
- **Import** applies a procedure per row (by figures, then by words) and keeps its column mapping.
- **AI** (`case_brief`) drafts a reading when GenAI.mil is set up.
- **Error reports** (ADR-0021) keep each report a unit is sent, row by row.

Nothing read a case as a whole and said, statement by statement, what is known, what was worked out, what is
recommended and on whose authority, what is unknown, and what a person must decide. The only sources were the FMRAC (a
training reference) and one unvalidated SME walkthrough, so the provenance order had nothing to order: there was no
way to put a command SOP, a validated SME workflow, a validated past case or cited policy on file.

## Decision

### 1. One rule engine, pure and versioned

`shared/caseDiagnosis.ts` (`case_diagnosis 1.0.0`) takes a case and returns its diagnosis. It uses no AI, no clock and
no database. Its input is:

- the case (title, reference, stage, the file and row it was imported from);
- its standing events (a superseded entry is not read);
- the procedure it is pinned to;
- the imported row's mapped money, method and error columns;
- the guidance on file for it (§4) and what the unit's error reports say about it (§5);
- today, in the Unit Instance's time zone.

The same input gives the same diagnosis, so it is worked out on every read and never stored. It reuses the balance
reader, the procedures (`progress`, `stepApplies`, the formulas, the resolution checks) and the responsibilities
(`fmra/roles.ts`) as they are. The output is a headline, the issue type and how it was read, the ten sections in the
specification's order, a count of each label, the ladder of sources weighed, and the diagnosis's limits.

### 2. Every statement is labelled, and every recommendation names its source

| Label | Meaning |
| --- | --- |
| Known fact | On the record: imported from the sheet, read from a system, or recorded by a person. It says which: the file, row and column, or who recorded it, when, from which system |
| Derived value | Worked out by Vantage from known facts. The arithmetic or the comparison is shown |
| Recommendation | What a source on file says to do, with the source's name, rank and citation |
| Unknown | Not on the record yet. A blank or a dash is never read as zero |
| Human decision required | A person decides it. Vantage never does |

A figure a person recorded stands over the figure the sheet had. Within a section, statements run in label order, and
recommendations run by rank. The engine has no way to raise a statement above the source it came from.

**The ladder.** The specification's six tiers keep their order. Three sources it does not name are placed where they
belong:

| Rank | Source | Spec tier |
| --- | --- | --- |
| 1 | Official policy | 1 |
| 2 | Official system guidance | 2 |
| 3 | Approved command SOP (binds that command only) | 3 |
| 4 | Validated SME workflow | 4 |
| 5 | Training reference (the FMRAC), not verified against current policy | — |
| 6 | Validated historical case (one case: what was true then, not a rule) | 5 |
| 7 | SME walkthrough, not yet validated | — |
| 8 | Inference (Vantage read the words on the case) | 6 |
| 9 | Inference (an AI draft) | 6 |

Every diagnosis lists the ladder, how many statements each rung gave this case and how many entries each has on file,
so a rung with nothing on file is named as such. When no official policy or system guidance is on file for the issue,
the limits say so, and that the FMRAC is a training reference, not current policy.

### 3. Issue type: what the case reads as, and how

In order of strength:

1. **The procedure applied** to the case.
2. **An error label** the reference names exactly, in the error, hold or reject text or the title.
3. **The figures**, read by the balance reader.
4. **Words alone**: a keyword match on the title or text.

A reading from words alone is a lead, labelled inference (rank 8). Nothing else in the diagnosis is built on it: no
causes, research or corrective action, and no guidance for that issue, until a person applies a procedure. A case
with no reading says so. The cause a person decided, and the verification that closed it, are known facts. The
possible causes are recommendations of their source until then, never findings.

### 4. Guidance on file (`case_guidance`, migration 030)

A short, cited entry for one issue type (or any) and one section, with an optional effective day before which it is
given to no case.

| Kind | Put on file by | Reaches |
| --- | --- | --- |
| Official policy, official system guidance | A Vantage Administrator with `platform.settings` (Vantage Administrator console → Official guidance) | Every Unit Instance |
| Approved command SOP, validated SME workflow (each names who approved or validated it) | A Unit Manager with `org.config` (Unit Manager console → Case guidance) | Its own Unit Instance |
| Validated historical case | A unit leader, from a resolved case (§4.1) | Readers of that case, in its Unit Instance |

An entry is **never edited or deleted.** A new wording is a new entry that retires the old one with it. Retiring needs
a reason. Database triggers refuse any change to an entry's words and any deletion (outside the demo database). A
retired entry is kept with who retired it, when and why, so a past diagnosis can be rebuilt. Each Unit Instance's
console shows the official guidance, read-only.

#### 4.1 A past case becomes an example only at another leader's hands

A case is validated as an example only when all of these hold:

- it is shared with its unit;
- it is resolved and followed a procedure;
- its resolution was verified;
- a cause was decided, and the cause was not "refer for review";
- the person validating it holds `REASSIGN_WORK` or `MANAGE_RECORDS` in its unit;
- the person validating it did not resolve it.

The leader writes what it shows the next person and which section it speaks to. The citation is the case's reference
and the day it was resolved. One example per case stands at a time; withdrawing it needs a reason, and it may be
validated again as a new entry.

An example is offered to a case of the same issue type in the same Unit Instance, and only to a reader who may open
the example's case. A case is never its own example. In the console, a Unit Instance role that may not open the case
sees what it shows and "A resolved case of the unit", not which case.

### 5. What the unit's error reports say

A case shared with its unit is matched to the rows of that unit's error reports (ADR-0021) by its identifier and by
the import's own test that the columns are the same report's (`sameReport`). For a reader with `VIEW_RECORDS` in the
unit, each kind of report that listed the case gives a known fact (listed on it, as it stood), and a derived value
under Verification when the case is still open on the latest report of that kind, or no longer on it. "No longer on
it" is a lead to verify in the system of record, not proof it cleared. Status, amount and age only: no owner, and
nothing for another reader.

### 6. Where it shows

- **The case page** (`/work/items/:id`, `case.diagnosis` on the detail): a Diagnosis panel under the figures, with the
  headline, the five labels with their counts, the ten sections (what the case is, why, what is missing and what to
  research open first), each statement's source, rank and caution, the ladder, and the limits. "What the figures
  show" points to it for the causes rather than repeating them. A leader who may validate the case as an example does
  it here, and withdraws it here.
- **The queue**: each row's title carries the headline, and a case with no procedure yet shows what it reads as.
- **Import**: the preview says what the diagnoser reads in the new rows (issue type and how, with a count), before
  anything is written.
- **The consoles**: Case guidance (Unit Manager), Official guidance (Vantage Administrator).

### 7. AI stays optional and ranks last

The diagnosis needs no AI and is tested with AI off. The case brief (when GenAI.mil is set up) is given the rule
diagnosis with every statement's label and source, and is told to keep them, never to present a recommendation as
stronger than its source, never to present a training reference, a past case or an inference as policy, and to call
anything it adds inference. The case page says the brief is an AI draft that ranks last.

### 8. Authorization, decided on the server

| To | Needs |
| --- | --- |
| Read a case's diagnosis | Reading the case (unchanged) |
| Read the error-report facts in it | `VIEW_RECORDS` in the case's unit |
| Be offered an example | Being able to open the example's case |
| Validate or withdraw an example on the case | `REASSIGN_WORK` or `MANAGE_RECORDS` in the case's unit; validating also needs not having resolved it |
| Withdraw an example from the console | `org.config` in the Unit Instance, as for any guidance on file there |
| Read a Unit Instance's case guidance | `org.view` in it |
| Put command guidance on file or retire it | `org.config` in it |
| Read official guidance | `platform.view` |
| Put official guidance on file or retire it | `platform.settings` |

An entry and the case it cites are one Unit Instance's: migration 030's boundary triggers refuse a row otherwise, and
`instanceBoundaryViolations` counts any that exist. Another instance's console answers 404.

### 9. Audited and carried

`case_guidance_added`, `case_guidance_retired`, `case_example_validated` and `case_example_withdrawn` are in the
unit-configuration family. `official_guidance_added` and `official_guidance_retired` are in the enterprise family. The
console and platform routes are in the privileged-route manifest. `case_guidance` is in the instance archive, the
privacy inventory (every column classified) and `RECORD_KINDS`.

## Defaults John can change

- **Who records official policy and system guidance:** Vantage Administrators, service-wide (asked on the Task 16
  thread; built as recommended until answered).
- The FMRAC training reference ranks above a single validated past case and below a validated SME workflow.
- A leader is someone who reassigns the unit's work or manages its records; the person who resolved a case does not
  validate it.
- An example speaks to "Probable cause" unless the leader chooses another section.

## Alternatives considered

- **Store each diagnosis.** Rejected: it would go stale with every entry on the case, and every change to guidance
  would need a migration of stored readings. It is cheap to work out, and versioned so a reading can be explained.
- **Let AI write the diagnosis.** Rejected by the specification: core rule and SOP guidance must work without AI. AI
  may only draft on top of it, and ranks last.
- **Build causes on a words-only reading.** Rejected: a keyword match is inference, and building the diagnosis on it
  would present inference as the reference's reading.
- **Let anyone mark a past case as an example.** Rejected: an example ranks above inference and is offered to the next
  person, so it needs a leader, and a second person, as a correction does.

## Consequences

- Every case has a diagnosis the moment it is imported, and it changes as people record what they find.
- A command's own SOP and the service's official guidance reach every case they speak to, ranked where they belong,
  without code changes.
- A wrong or outdated entry is retired with a reason; both stay visible.
- Migration 030 adds one empty table, its triggers and two boundary triggers. It reads, moves and reshapes nothing
  already written.
