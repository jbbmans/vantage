# ADR-0025 · Training evidence: a training's files say what they are, and are as reachable as the training

**Status:** accepted · **Date:** 2026-11-11 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0014](0014-mcen-operations.md),
[ADR-0015](0015-core-record-architecture.md), [ADR-0019](0019-import-export-restore.md)

## Context

Task 19 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is Training Attachments:

- "Training records support secure evidence: certificates, transcripts, completion documents, qualification documents,
  rosters."
- "Track: filename, type, upload date, uploader, description."
- "Validate file content and size server-side. Authorize download."
- "Preserve attachment relationships in supported exports/imports."

What main held before this Task (at `3efe3c1`):

- **Files on records.** One `attachments` table for the eight record types, the file kept as a BLOB with its name, MIME
  type, size, SHA-256, uploader, the unit its record sat in (ADR-0008) and its date. Routes under
  `/api/records/:table/:id/attachments`. Reading a record's files took `canRead` on the record; adding or removing one
  took `canEdit`. Uploads were gated by the service switch and by the per-Unit-Instance withhold (John's "Per
  instance" decision, ADR-0014), size-limited, type-checked by signature, hashed, scanned when a scanner is configured,
  and served as downloads. Files follow an entry that moves to another record type (ADR-0015) and travel in the
  personal export, the single-record export and the import (ADR-0019).
- **Training** already showed a generic Files panel in its dialog.

Against the specification, seven things were missing:

1. A file did not say what it was. Nothing told a certificate from a roster.
2. A file had no description.
3. The list returned the uploader's id and no name, and the page showed neither who added a file nor when.
4. What was said about a file could not be corrected; only the file could be removed.
5. Authorization and header checks ran after the server had read the whole body, so a caller with no right to add a file
   could still make the server take in a body up to the size limit.
6. Validation had gaps: PDF 2.0 was refused; a CSV chosen on a machine with a spreadsheet program arrives as
   `application/vnd.ms-excel` and was refused; a text file could hold terminal control characters; a filename could
   carry direction-override characters that make `fdp.exe` read as `exe.pdf`, and clipping a long name cut its
   extension off.
7. The audit entries for a file did not say which file, and anonymizing a record under a retention schedule left its
   files, names and all, in place.

## Decision

### 1. A training's file says what it is

`attachments` gains `kind` and `description` (migration 033). `kind` is one of certificate, transcript, completion,
qualification, roster, other (`shared/attachments.ts`, `EVIDENCE_KINDS`), held to that list by a CHECK. `description`
is one line of plain text, at most 500 characters, held by a CHECK and cleaned by one function
(`cleanDescription`) that the upload, the correction and the import all use.

- An upload to a training must say what the file is. An upload to any other record type must not: evidence types are
  training's (`takesEvidenceKind`). Every record type's files take a description.
- The CHECK on `kind` is not tied to the record type. A file follows an entry that moves to Training and back
  (ADR-0015), and its type goes with it. So a training can hold a file with no type yet (it arrived by a move, an
  import, or was attached before this Task). It shows as "Type not set" and whoever may edit the training sets it.
  Nothing is guessed from a filename, by the migration or afterwards.
- The file itself never changes. Its name, content and hash stay as they were added. To replace a file, remove it and
  add the new one.

### 2. What is tracked, and what a reader sees

Each file in the list carries its name, MIME type, size, hash, upload date, evidence type, description, uploader id and
the uploader's rank and last name (`uploader_name`). The name is shown to anyone who may read the record; they could
already see who owns it and who commented on it. The list never carries the content.

### 3. Authorization: a file is exactly as reachable as its record

No new permission. The record decides (`server/authz/records.ts`):

| Action | Rule |
|---|---|
| List, download | `canRead` on the record |
| Add | `canRead` and `canEdit`, attachments on for the service, not withheld from the record's Unit Instance |
| Correct type or description | `canRead` and `canEdit` |
| Remove | `canRead` and `canEdit` |

- A file is reached only through the record it hangs on. Its id under another record or another record type is 404.
- One export differs, as it did before this Task (ADR-0019): a person's own export carries every file they added,
  wherever it hangs, because they supplied it. For a file on somebody else's record it says what the file is (its type
  and description) only while that person can still open the record. Whoever keeps the record can rewrite those words,
  so they are not handed to someone the record is now closed to.
- **Decided before the body is read.** A middleware runs the upload's authorization and reads its type and description
  before `express.raw` takes the body. The handler decides again once it has the file, and a third time after the
  awaited malware scan. That last decision reads the caller's roles and memberships afresh, not as the request first
  found them, and nothing is awaited between it and the insert. So a file never lands on an entry that moved, was
  deleted, was frozen or filled up meanwhile, or that the caller lost the right to add to while the scanner had it.
- Withholding attachments from a Unit Instance stops new files only. What is there stays readable, correctable and
  removable.
- The type and description of an upload travel as headers beside the filename (`x-vantage-evidence-kind`,
  `x-vantage-description`, the description percent-encoded), because the body is the file. The filename header is
  percent-decoded once, where the header is read (`filenameFromHeader`). A stored name is never decoded again, so a
  name that holds a literal `%20` keeps it on download and through an import.

### 4. Validation

`inspectAttachment` (`server/services/attachments.ts`), on the server, for every upload:

- Size against the configured limit; the count per record against its limit.
- The type must be one the service allows, the filename's extension must be that type's, and the content must prove it:
  a signature for PDF (1.0 to 1.7 and 2.0), PNG and JPEG; valid UTF-8 with no control characters, C0 or C1, other than
  tab, line feed, carriage return and form feed for TXT and CSV.
- The type a browser states is a claim. Where it states none (empty, or `application/octet-stream`), or states a
  spreadsheet program's type for a `.csv`, the type is read from the filename and then proven the same way. A stated,
  allowed type must still agree with the filename.
- A filename is kept as it reads: its last path segment, without control characters, lone surrogates, zero-width or
  direction-override characters; path punctuation becomes a hyphen; a long name is shortened in its stem and keeps its
  extension.
- The same file twice on one record is refused (unique on the hash among live files).
- Every upload is scanned when a scanner is configured; a rejected file is never stored (unchanged).

A download is always a download: `Content-Disposition: attachment` with the cleaned name, `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, the checked type (text says `charset=utf-8`), and the
API's `Cache-Control: no-store`.

### 5. Audit

| Action | Detail | Subject |
|---|---|---|
| `upload_attachment` | `attachment <id>; <size> bytes; <mime>[; <kind>]` | the Marine, when someone else adds it |
| `download_attachment` | `attachment <id>` (logged when the reader is not the record's owner) | the Marine |
| `update_attachment` (new) | `attachment <id>; changed kind, description[; <from> to <to>]` | the Marine, when someone else corrects it |
| `delete_attachment` | `attachment <id>` | the Marine, when someone else removes it |
| `upload_rejected` | `rejected by the malware scanner: <what it found>` | the Marine, when someone else tried |

The trail never holds a filename or a description: both can name a person, and the trail is append-only. That covers
the rejected upload too. Whoever sent the file is told which file in the response; the trail records what the scanner
found (`MalwareRejected.finding`). An import's rejections (ADR-0019) are recorded the same way, without the name of the
archive or of the file inside it.

### 6. Exports, imports, moves, retention

- **Personal export and `attachments.csv`:** each file carries `kind`, `description` and, for a file someone else
  added, `uploader_label` (a name, never this instance's id). A file the person added to somebody else's record
  carries `kind` and `description` only while they can still open that record (section 3).
- **Single-record export:** each file carries `kind`, `description` and `uploader_label`.
- **Import:** a known evidence type is kept only where the target record type takes one; a description is kept only if
  `cleanDescription` accepts it; anything else comes in empty and the file still comes in. The importer is the uploader
  and the date is the import's, as before; the export keeps who first added it.
- **Moves:** a file keeps its type and description when its entry moves and when the move is undone.
- **Instance archive:** row-generic, so the two columns travel with no change.
- **Retention:** an anonymized record holds no files. A certificate names its Marine in its name and on its face, so
  leaving it would undo the anonymizing. An anonymize run deletes the files of the records it anonymizes and of records
  already anonymized, whatever their clock says now: every run before this Task left their files, a file can be added
  to an anonymized record afterwards, and anonymizing a task or a project restarts its clock (`updated_at`). The files
  are chosen before the records are rewritten, and the preview counts the same files (`files` on its line). The run's
  history line and its `disposition_run` audit entry state the count. Run disposition is offered on a fresh preview
  when files are the only work left, and not again on the result of a run.
- **Retention holds:** holds win as they do for records. A held Marine's records and their files, a held record type's
  and everything under an instance-wide hold are untouched. Two more kinds of file are kept, as the recycle-bin purge
  and `destroyLineage` already keep them: a file a held person added to anyone's record, and the files of an entry
  whose history a hold keeps (an entry that has been of a held record type, `lineageHeld`). They go at the first run
  after the hold is released.

### 7. Where it shows

- **Training dialog** (Training & Development → Training): the panel is titled Evidence. Add evidence asks what the
  file is (required), the file, and an optional description, and says which types and what size are accepted. Each
  file shows its type, name, description, format, size, who added it and when. Edit details corrects type and
  description in place. Remove asks first, with focus on Keep.
- **Training list:** an Evidence column with the count of files on each training.
- **A Marine's page** (Personnel → the Marine → Career): a shared training opens in a dialog with its details and the
  same panel. The count shows only on trainings the reader could open.
- **Other record types** keep the Files panel and the one-press Add. They gain who added each file and when, a
  description that can be added afterwards, and the confirmation before removing.
- A file list is read even when attachments are turned off, so what is already attached stays visible.

## Decided, and defaults John can change

None of these needed a decision card; each is the narrowest reading of the specification and is listed so John can
change it.

- Whoever can open a training can open its evidence. A separate "view evidence" permission would let a unit share a
  training and withhold its certificate; the specification does not ask for it.
- Whoever may edit the training adds, corrects and removes its evidence, including a leader who may correct shared
  records.
- Allowed file types stay PDF, JPEG, PNG, TXT and CSV. Office formats (DOCX, XLSX) are not accepted: proving their
  content means opening a ZIP container, and they can carry macros.
- Evidence types apply to training only. Awards and duty keep untyped files.
- On import the importer becomes the uploader.
- Anonymizing a record removes its files, including files still on records anonymized before this Task, at the next
  anonymize run a Unit Manager applies. The preview shows the count first. Files a hold keeps stay until it is
  released.
- A rejected upload's audit entry says what the scanner found and not the file's name, on a record and in an import.

## Alternatives considered

- **A separate `training_evidence` table.** Rejected: files already follow moved entries, exports, imports, unit
  isolation and retention through one table; a second would need each of those built again.
- **Type and description in a multipart body.** Rejected: the route takes the raw file, and adding a multipart parser is
  a new dependency for two short values.
- **Guessing the type from the filename on upgrade.** Rejected: "certificate.pdf" is often a roster.
- **Structural checks of PDF and image internals.** Rejected for now: the existing signature checks are what current
  files and tests rely on, and deeper parsing is a larger attack surface than it removes without a sandbox.
- **Letting the description hold several lines.** Rejected: it is a caption; notes belong on the training.

## Not done here

- Office formats, and stripping active content from PDFs.
- A separate permission for viewing evidence.
- The activity page's own inline Attachments panel (`src/pages/RecordDetail.tsx`) is unchanged; it reads the same
  routes and does not yet show descriptions.
- Training requirements, expiry and compliance reporting on whether evidence is present.
- Restoring a removed file from the page (it is kept 30 days before it is purged, as before).
- The destroy disposition (`destroyRecords`) is unchanged: it removes a record with every file on it, including a file a
  held person added to somebody else's record. Only the anonymize path gained that exception here.
- Correcting or removing a file is not stopped by withholding attachments from a Unit Instance (section 3), and a
  request with an undecodable `Content-Encoding` or a malformed percent-escape in its path is answered 500 by the
  application-wide error handler, as on main.

## Consequences

- Migration 033 adds two nullable columns. No row is reshaped; every existing file keeps its content, hash, uploader,
  unit and date, and has no type or description until someone sets one.
- A direct upload to a training without `x-vantage-evidence-kind` is now refused (400). The only client is Vantage's
  own page, which sends it.
- Files that were refused are now accepted: PDF 2.0, a CSV sent as a spreadsheet type, and a file whose type the
  browser could not state but whose name and content agree. Files that were accepted are now refused: text holding
  control characters.
- One new audit action, `update_attachment`; existing attachment actions gain a detail. `upload_rejected` no longer
  holds the rejected file's name, on a record or in an import.
- The first anonymize run applied after this change also deletes the files left on records that earlier runs
  anonymized. Nothing runs by itself: disposition runs only when a Unit Manager applies it, and the preview states the
  number of files first. A disposition line gains an optional `files` count; `disposition_run` is now also written for
  a run that removed only files.
- Rollback: revert the commit. The two columns can stay in the database unread. To remove them: `ALTER TABLE attachments
  DROP COLUMN description`, then `DROP COLUMN kind`; set the stored `schema_version` back to 32 if 033 should run again
  on a later upgrade. Files deleted by an anonymizing retention run after this change are not brought back by a
  rollback.
