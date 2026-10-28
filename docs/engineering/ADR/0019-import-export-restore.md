# ADR-0019 · Import, export, download and restore: every record keeps its type on the way out and on the way back in

**Status:** accepted · **Date:** 2026-10-28 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0014](0014-mcen-operations.md),
[ADR-0015](0015-core-record-architecture.md), [ADR-0018](0018-record-timeframes.md)

## Context

Task 13 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P0) is import, export, download and restore:
"Implement semantic import/export. Do not flatten everything into Activities." It names the categories (profile and
personal data, activities, awards, training, education, certifications, qualifications, counselings, duty, goals, PME,
volunteer, FM work, personnel history, attachments), the workflow (Upload, Detect, Map, Validate, Duplicate Check,
Preview, Correct, Import, Results, Audit), the formats (Vantage JSON, CSV, XLSX, ZIP), full and selective import and
export, a single record's download and a category's export, transactions where possible, and a mandatory round trip.
Section 15 adds that an export never holds another unit's data, a download enforces record and unit authorization, an
import never writes into another Unit Instance, and ids cannot be manipulated to cross a boundary.

What main held before this Task (at `f0857ac`):

- **A personal export** (`GET /api/me/export`, ZIP or JSON, `vantage-personal/1`) of everything tied to the account,
  password confirmed. Nothing read it back.
- **An activity CSV import** (`POST /api/records/activities/import`, `CsvImportDialog`): activities only, mapped in the
  browser. A spreadsheet of awards or courses came in as activities.
- **Work intake** (`ImportWizard`, ADR-0011): taskers and cases from a spreadsheet into the queue. Not records.
- **A workbook reader** (`server/lib/workbook.ts`) with limits, and no writer.
- **A unit configuration file** (ADR-0012) without the duty scoring versions Task 6 added.
- **Infrastructure backups and service archives** (ADR-0014), which no data import may take.

## Decision

### 1. One registry for what goes out and comes back

`shared/recordTransfer.ts` lists every category the spec names, the store it lives in, whether an import writes it and,
when not, why not, and the spreadsheet columns of each record type (`RECORD_COLUMNS`). The export, the import, a
record's download and the Your data page all read it, so a column the export writes is one the import reads.

| Category | Store | Import |
| --- | --- | --- |
| Profile and readiness | `users`, `readiness`, preferences | ✓ field by field (§4) |
| Activities, volunteer service, FM work | `activities` (by category; FM work by its `work:` fingerprint) | ✓ |
| Awards and recognition | `awards` | ✓ |
| Training, PME, education, certifications, qualifications | `trainings` (by `type`) | ✓ |
| Counselings, goals, projects, tasks, career plan | their own tables | ✓ |
| Attachments | `attachments`, in a ZIP | ✓ onto the record they came with |
| Duty | none yet (Task 17) | listed, never written, **never made an Activity** |
| Personnel history | memberships, billets, responsibilities | kept in the file; the people who manage membership write it |
| Account history | trail, notifications, comments, drafts, moves, AI and email logs | kept in the file; the record of what happened, never written back |

### 2. Export: everything, or what the person chooses

- `GET /api/me/export?format=json|xlsx|csv|zip&sections=…` (password confirmed, as before). `sections` names categories
  from the registry; none is everything. A category that is one kind of a table (education, PME, volunteer) exports
  only those rows unless the broader one is chosen too.
- **XLSX** is new: a sheet per record type under the import's own headers, plus a profile sheet. `writeWorkbook` writes
  inline strings, so a cell starting with `=` is text and never runs as a formula.
- **CSV** holds one table: exactly one category (or the profile), else 400 `csv_one_category`.
- **A spreadsheet holds only the exporter's own records,** since an import reads every row back as its reader's.
  Counselings they recorded about another Marine and tasks or goals someone else set them stay in the JSON (and the
  ZIP's JSON), where an import knows them for what they are; the workbook's About sheet says how many.
- **A record's download** (`GET /api/records/:table/:id/export?format=json|csv|zip`, `vantage-record/1`): the record, a
  CSV row that imports back, or a ZIP with its files. It uses `readableRecord`, the same rule as the record's page, so
  a reader downloads only what they may already open; the download is audited as `export_record` with the record's
  subject. It is not a bulk route (`NOT_BULK` in `server/authz/privilegedRoutes.ts`).
- Training, Awards and Counseling each export their own category (CSV, workbook or JSON) and open the import.

The export still holds only the exporter's own data: their records, and the names (never ids) of people on them.

### 3. Import: staged, reviewed, then written once

`server/services/recordImport.ts`, under `/api/me/imports`:

1. **Upload** (`POST`, raw body, `x-filename`). Up to `VANTAGE_RECORD_IMPORT_MAX_BYTES` (50 MB). The file is scanned as
   any upload is, and each file inside a Vantage ZIP on its own; a rejected file is audited as `upload_rejected` and
   never kept. Infrastructure backups, service archives, unit configuration files and Unit Instance structure files are
   refused by their format, each with where it does belong. One
   import waits per person; a new upload cancels the one before. One left unreviewed for
   `VANTAGE_RECORD_IMPORT_STAGED_HOURS` (24) loses its bytes to the hourly prune.
2. **Detect.** A Vantage export (JSON or ZIP, personal or one record), an Excel workbook, or a CSV.
3. **Map.** A Vantage export maps itself. A spreadsheet's sheet is routed by its name ("Awards", "PME", "Volunteer"),
   a CSV by its file name ("vantage-boletz-awards-….csv"), else by a Record Type column per row, else by its headers;
   the person can change any of it, and each column. A sheet named for a kind (Education, Certifications, PME,
   Volunteer, Duty) presets that kind.
4. **Validate.** Every row runs through the same `createRecord` and `updateRecord` a form uses, inside a transaction
   that is rolled back: the same schemas, timeframe rules (ADR-0018), placement rules and refusals. What the review says
   is what the import does.
5. **Duplicate check.** A Vantage export's record already here (same id, the importer's own) is **left as it is**,
   never overwritten; one in the recycle bin says to restore it from there. A spreadsheet's Vantage ID updates the
   importer's own record and nobody else's. A record imported before, or the same thing already here (an activity by
   its fingerprint; the others by what they are called and when), or twice in one file, is held back; the person may
   include any of them but an activity.
6. **Preview and correct.** Each row shows what it is read as, where it goes and why. The person leaves rows out,
   corrects a field the review could not read, says what a row really is ("import as"), chooses who sees the records
   ("as the file says" or "only me"), how the profile is treated, and whether files come in. Each choice re-runs the
   review.
7. **Import** (`POST …/commit`). The run again, kept, in one transaction; each row in its own savepoint, so a row the
   server refuses is reported and the rest go in. The commit carries the counts the person saw: if the account changed
   in between, or a record it updates or the profile it fills was edited since the review, nothing is written (409
   `import_changed`). The
   record limit is checked once for all it adds (507).
8. **Results** per record type, files and profile fields, kept on the import.
9. **Audit.** `record_import_staged`, `…_committed`, `…_undone`, `…_cancelled`; each record created carries `import <id>`
   in its own trail. Each record an import wrote is listed in `record_import_origins`, so its page says "imported …
   from <file>".
10. **Undo** (`POST …/undo`, once): what it created goes to the recycle bin, what it updated is put back, files it
    attached come off, profile fields it set go back. Only where nothing changed since; a record edited after the
    import is kept as it is and counted. A record goes back where it was only where an edit could put it now (its
    placement, assignee, and nothing others added since crossing an instance's edge), else it is kept. Two rows of one
    file that update one record are one change to undo. A file comes off only a record its owner may still edit, and
    a profile field the personnel feed has taken since stays the feed's.

**Records keep their type.** An award comes back an award, a course training, a counseling a counseling. A row in
Activities that only reads like an award or a course is offered to its owner as that type and goes in as one only when
they say so (ADR-0015, John's "Marine confirms", 2026-10-17). Duty rows are listed and left out.

### 4. Boundaries: ids are never trusted

- **Only the importer's account is written.** `id`, `user_id`, `assignee_id`, `counselor_id`, `recorded_by`,
  `fingerprint`, `kind_confirmed_at`, `frozen_at`, `deleted_at` and `version` are never taken from a file. A project link
  is kept only to the project the same import brings in (or finds as the importer's).
- **Placement.** A record keeps its file's visibility and unit only when the importer may place a record there now
  (`canPlace`) and the unit is active; otherwise it comes in private in their home unit. A file can never put a record
  in a Unit Instance its importer does not serve in. "Only me" brings everything in private, and makes private a record
  of theirs that a spreadsheet updates.
- **Another person's import** is 404 to everyone else; a Vantage export of another account comes in only as the
  importer's own copy, with a note.
- **Records others wrote.** Counselings and award recommendations someone else recorded about the importer come in as
  the importer's own copies, labelled as imported with the author's name from the file. Records the importer wrote
  about other Marines, and tasks or goals others set them, stay in the file. **Decided by John, 2026-10-28 05:38 UTC,
  on the Task 13 thread's decision card: "Marine's own copies"**, the recommended option, over "Read-only copies" and
  "Leave them out".
- **Profile.** Field by field against the profile, readiness and career schemas: fill what is empty (default), replace,
  or leave it. Fields the personnel feed keeps (ADR-0017) are refused. Changes go through the same personnel note and
  are audited as `edit_profile`.
- **FM work** keeps its tie to financial work as a new fingerprint, `work:import:<hash of the person and the old one>`,
  so it reads as drawn from work but never claims a case here.
- **Files** come in only when attachments are on for the record's Unit Instance, the record takes files, the importer
  may edit it, the type and size pass, the scan passed and the same file is not already on it.

### 5. Restore, and the unit configuration file

A person's restore is this import of their own export, into the same Vantage or another. An infrastructure restore
stays ADR-0014's. The unit configuration file now carries **duty scoring versions** (ADR-0012, Task 6) with their
dates, withdrawals and rules keyed by duty code and name. They load only into a Unit Instance that has none; a duty
type a version names and the instance lacks is created retired. An instance with its own versions keeps them.

### 6. Migration 027

`record_imports` (the staged file, the plan, the review and the results) and `record_import_origins` (what each import
wrote). Both are in the infrastructure backup and the privacy inventory. Nothing already stored is read or reshaped.

## Consequences

- A Marine can take their record to another Vantage and bring it back without retyping or flattening it, and see
  before anything is written what will happen to each row.
- The review costs one rolled-back run per change. Files are bounded (50 MB, 5,000 spreadsheet rows, 20,000 records of a Vantage
  file, 10,000 ZIP entries).
- Undo is once, and partial where the person changed things after.
- Duty rows wait for Task 17; then the registry's `duty` category becomes a table and imports.
- The activity CSV import and work intake are unchanged.
