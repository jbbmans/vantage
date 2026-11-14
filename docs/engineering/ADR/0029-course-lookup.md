# ADR-0029 · Course lookup: course values verified only against an approved source's catalog, everything else manual

**Status:** accepted · **Date:** 2026-11-14 · **Builds on:** [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0015](0015-core-record-architecture.md), [ADR-0019](0019-import-export-restore.md),
[ADR-0022](0022-financial-case-diagnoser.md), [ADR-0025](0025-training-evidence.md)

## Context

Task 22 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P2) is MCeLE Course Lookup:

> When a course code is entered, retrieve verified metadata only from an approved authoritative source. Potential fields:
> name, provider, description, hours, CEUs, category, requirements, rank/MOS applicability where available. Do not build
> from an unofficial public list merely because it is easy to scrape. If no approved source is available, provide manual
> entry and mark the value as manual.

What main held before this Task (at `8862e95`):

- A training (`trainings`) had a title, type, hours, provider, status, notes and a timeframe. It had no course code and no
  CEUs. It is written by `createRecord` / `updateRecord` (`server/services/records.ts`), by a move from another record
  type (`recordMoves.ts`) and by an import, which calls the same two functions.
- A unit's training requirements already carried a `course_code`. `standing()` (`reportCenter.ts`) matched it against a
  training's *title*.
- No course catalog existed, and nothing connected to MarineNet, MCTIMS or any other course system. Neither the repository
  nor the specification documents an interface to an MCeLE system that is approved for Vantage.
- Service-wide reference data already had a pattern, the case diagnoser's official guidance (ADR-0022). Vantage
  Administrators with `platform.settings` record it. It is append-only, retired with a reason, and audited.

## Decision

### 1. Vantage fetches nothing. A Vantage Administrator registers an approved source and loads its published catalog

No online interface to an MCeLE system is approved for Vantage, so Vantage calls none and scrapes nothing.

A Vantage Administrator holding **Service settings** (`platform.settings`) **registers an approved source** with:
- its name;
- who publishes it;
- the reference of the document, memo or ticket that approves it for Vantage;
- who approved it, and on which day (never a later day than today).

That administrator then **loads the catalog file** the source publishes (.csv, .tsv or .xlsx, up to 10 MB and 20,000
courses), with the day its data is as of. Until a source is registered and its catalog applied, every course value on
every training is manual. The approval is the authority. Vantage never treats a list it found as approved.

A source is **never edited**. It is **withdrawn with a reason**, and its name is then free for a source registered under
a new approval. Two sources in use never share a name (a partial unique index), so "verified against" always names one.

If a live interface is approved later, it would fill the same tables through the same staging step.

### 2. A catalog is staged, read and counted before it answers anything

`POST /api/platform/course-sources/:id/import` reads the file and returns a **staged** catalog. The file is not kept.
Before anything is read:
- the upload goes through the same permission check;
- the same infrastructure-file refusal applies (`infrastructure_file`);
- the content is classified and scanned for malware (`scanUpload`), as every upload is.

Reading the file:
- **Columns are found by name.** The header row is found within the first ten rows of a sheet. Aliases are accepted
  ("Course Number", "Contact Hours", "CEU"). A file without both a code column and a name column is refused.
- **Rows are checked.** A row without a code or name is left out with the line and the reason. So is a row with a
  number that is not one, or one out of range. Numbers are read as a workbook or a person writes them ("1,200",
  "2.3333333"), kept to four decimal places.
- **One sheet is read.** In a workbook, the first visible sheet with a code column and a name column is the catalog.
  Hidden sheets are not read, and a long sheet that is not the catalog does not stop it.
- **Repeats are resolved.** A course listed twice the same way is kept once. A course listed twice differently is left
  out entirely, with the reason on every line it is on (naming the first ten lines), because Vantage cannot know which
  listing is right.
- **Tabs or commas.** A .tsv file, or one sent as tab-separated, is read on its tabs. Otherwise the separator is the one
  whose first lines give a code column and a name column, so a tab-separated file with commas in its descriptions is
  read correctly whatever it is named.
- **Encoding is checked.** A CSV that is not UTF-8 is refused rather than guessed at.

The staged catalog shows:
- which column each field was read from, and which columns were not used;
- how it compares with the catalog in use: added, changed, unchanged, and no longer listed;
- every row left out, with its reason.

A staged catalog answers no lookup.

**Applying it** (`.../loads/:loadId/apply`) sends back the file's SHA-256 as it was shown, so only the file that was read
is applied (`catalog_changed` otherwise). The catalog in use becomes **superseded**. It is kept, with its entries, so a
training can always say what the source listed when it was checked.

A staged catalog can be **discarded**. One left unapplied for 24 hours is discarded by an hourly job
(`course_catalog_prune`). Loading a new file replaces the one waiting. A discarded catalog's entries are removed, because
nothing was ever verified against them.

Triggers keep a source, a catalog and an entry from being changed or removed. A catalog moves only from staged to current
or discarded, and from current to superseded.

### 3. The server decides what is verified. Nothing a request or a file sends can say so

A training gains `course_code` and `ceus`, both typed by its person. The server records what was verified in three
columns:
- `course_entry_id`: the catalog entry it was checked against;
- `course_verified`: which values matched;
- `course_verified_at`: when.

The server works these out on every write: create, edit, a move into Training, and an import. They are not in any
request schema. An import strips them, and with them a file's "Verified" and "Verified Against" columns.

**The rule** is `verifiedValues` (`shared/courses.ts`), shared by the server and the form:
- The **course code** matches when it is the same code once spacing, hyphens and case are ignored ("cdet-8010" is
  "CDET 8010").
- **Title and provider** match when they read the same once spacing is ignored. Case is the source's, so "sergeants
  course" is not "Sergeants Course".
- **Hours and CEUs** match when they are the same number, read as the record schemas read it ("1,200" is 1200).
- A value the entry does not list is never verified.

**Choosing the listing.** Only the current catalog of a source that has not been withdrawn is used. When two sources list
the code, the listing that matches the most values wins, and the newest catalog breaks a tie. Anything else filled in is
**manual**.

**When an edit checks again.** An edit that changes neither the code nor a value a catalog checks keeps what was
verified, and when. An edit that changes one is checked again. So is any edit of a training that has a code but nothing
verified, which covers codes typed before a catalog was loaded.

Once a source is withdrawn, or its catalog replaced, what was verified against it stays verified. The training says so
("That source has since been withdrawn: …", or "A later catalog … has replaced that one").

Description, category, requirements and rank or MOS applicability are **shown from the catalog entry**, labelled with the
source and its as-of date. They are never copied into the training.

### 4. Lookup, the form, and the training

- **Lookup.** `GET /api/courses/lookup?code=` is open to anyone signed in. A catalog is service reference data, not
  anyone's record. It returns how many sources have a catalog in use, and the listings of the code in those catalogs.
- **The form.** The training form opens on **Course code**. A moment after typing stops, it shows what each catalog
  lists, with **Use these details**. Each field's label then carries **Verified** or **Manual**, read with the label by
  a screen reader ("Title Verified"). A line says what would be verified if the training were saved as it reads.
  Editing a training whose course values are unchanged, the form shows what saving keeps (what was verified, against
  which catalog and when) rather than what the catalogs in use would verify now. While a code is being looked up, no
  value is marked. A save refused because the training changed meanwhile sends the newer version back with what it says
  was verified, so loading it keeps the same rule.
- **The training.** A training's page shows which values were verified, against which source and catalog, when, and
  which are manual. It also shows what the catalog says of the course. The same appears on a Marine's page for someone
  who reads it, in the record route, in the personal export (JSON) and in the record export.

### 5. Exports, imports, reports and retention

- **Exports and imports.** A training sheet carries **Course Code** and **CEUs**, which can be imported. It also carries
  **Verified** and **Verified Against**, which are export-only.
- **Reports.** A requirement is also met by a training whose course code is the requirement's, in addition to the title
  rules. This applies to report standing and unit analytics, which share `standing()`.
- **Retention.** Anonymizing a training removes what it says a catalog verified, and its link to the catalog's listing.
  Otherwise the listing's name and provider would stand beside the redacted title. Its course code, hours and CEUs stay:
  they count a course, not a Marine. While its title is the redaction, it is verified against nothing, even when it is
  edited later, and the form marks every value manual (`bestListing`, shared by both). A title its owner types again is
  a new value, and is checked as one.
- **Instance archive.** Restoring an archive into a fresh host empties the host's tables. The triggers that keep rows
  from being removed are lifted while it does and put back exactly as they were before it commits. These are the course
  tables' triggers and the earlier append-only records' (work events, error reports, case guidance). Before this, a
  fresh host whose operator had put case guidance on file could not be restored.
- **Inventories.** These list the new tables and routes: the privacy inventory, the instance archive (`EXPORT_TABLES`),
  the audit catalog, the privileged-route inventory and the data-transfer registry.

### 6. Who does what, and the audit

| Action | Who | Audit |
|---|---|---|
| Read sources, catalogs, entries | Vantage staff with Open the console (`platform.view`) | console read |
| Register, withdraw a source; load, apply, discard a catalog | Service settings (`platform.settings`), with a recent sign-in confirmation | `course_source_registered`, `course_source_withdrawn`, `course_catalog_staged`, `course_catalog_applied`, `course_catalog_discarded`; a refused file `upload_rejected` |
| Look up a course code | anyone signed in | none (reference data) |
| Course code, CEUs on a training | whoever may write the training | the training's own write |

The other Vantage Administrators who hold Service settings are told when a source is registered or withdrawn, and when
a catalog is applied. The person who did it is not told.

## Consequences

- MCEN gets course data only from a source its approver signed off. A manual value is never presented as verified.
- Each catalog someone applied is kept, with its hash and its as-of date. "Verified" can be traced to a file, a source
  and an approval.
- Loading a catalog is a manual step. Data is as fresh as the last file. The as-of date is shown wherever it is used.
- CEUs on trainings are not added into the readiness profile's MOL figure. The training page sums them beside the
  hours instead.
- Migration 036 adds five columns to `trainings` and the three tables. No training changes: none has a code, so none
  is verified until it is next saved.
