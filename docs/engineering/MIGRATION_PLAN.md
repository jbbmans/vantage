# Migration plan

Two migrations are in play: the **schema** (additive, applied automatically) and the **database engine**
(SQLite → PostgreSQL, planned in ADR-0003).

## Schema migrations

Numbered migrations live in `server/db/index.ts`. `schema.sql` is replayed on every boot and only
creates tables and indexes that do not exist yet. Each migration runs once, in a transaction, and
records `schema_version` in `meta`. No migration deletes or rewrites what a person wrote in a record. Migration 038 clears the words that old notices copied from comments, hand-off notes and task titles; the words stay on the records they came from (ADR-0031).

| # | Name | What it does |
|---|---|---|
| 001–007 | existing | unchanged |
| 008 | `008_case_history` | Adds `work_items.stage`, `waiting_category`, `waiting_since`, `blocked_reason`, `procedure_key` and `procedure_version`, and `users.demo_workspace_id`. Backfills `stage` from `state`. Backfills one `action_recorded` event per existing work action and one `claimed` event per current claim, each marked `backfilled`. New tables (`work_events`, `record_drafts`, `career_steps`, `career_profiles`, `demo_workspaces`) come from `schema.sql`. |
| 009–022 | as named in `server/db/index.ts` | See `server/db/index.ts`. |
| 023 | `023_record_lineage` | Adds `awards.recorded_by` and `activities.kind_confirmed_at`. Fills `recorded_by` for older awards from each award's `create` entry in the audit trail when the award is shared with its unit, else the award's owner. `record_lineage` comes from `schema.sql`. Moves no entry out of Activities and declares nothing it reshapes (ADR-0015). |
| 024–034 | as named in `server/db/index.ts` | See `server/db/index.ts` and ADR-0017 to ADR-0026. |
| 035 | `035_counseling_workflow` | Adds `counselings.stage` (`draft`, `review`, `final`; default `final`), `revision` (default 1), `finalized_at`, `finalized_by` and `particulars`, with the CHECKs a new database gets, and `idx_counselings_stage`. `counseling_revisions` (append-only amendment history) and its triggers come from `schema.sql`. Every counseling already written is final at revision 1 with no stamp or particulars; no counseling's text, people, unit or acknowledgement changes (ADR-0027). |
| 036 | `036_course_lookup` | Adds `trainings.course_code`, `ceus`, `course_entry_id` (references `course_catalog_entries`), `course_verified` (a JSON list) and `course_verified_at`, with the CHECKs a new database gets (an entry, the list and the time together or not at all), and `idx_trainings_course_entry`. `course_sources`, `course_catalog_loads` and `course_catalog_entries` (service-wide, append-only, with their triggers) come from `schema.sql`. No training changes: none has a course code or anything verified until its person saves it with one (ADR-0029). |
| 037 | `037_form_drafts` | Changes no row. `form_drafts` comes from `schema.sql`: forms saved to finish later (goal, award, training, task, personnel change), each its author's alone, with the CHECKs that keep a draft about someone else naming its unit and never its author, a personnel change always naming its Marine, and its values a JSON object of at most 32 KB. Indexed by author and by when it was last saved. A draft is removed when it is sent (in the same transaction as the record it becomes) or discarded, and 90 days after it was last saved, unless a legal hold keeps it (ADR-0030). |
| 038 | `038_workflow_messages` | Adds to `comments` `kind` (`comment`, `review_request`, `clarification_request`, `answer`, `assignment_note`; default `comment`), `addressee_id`, `state`, `reply_to`, `closed_by`, `closed_at` and `private` (0 or 1, default 0), with the CHECKs a new database gets: a request has a state and an addressee and nothing else has a state, a state is `open`, `answered`, `looks_right`, `needs_changes`, `withdrawn` or `closed`, an answer and only an answer has `reply_to`, and `closed_at` is set exactly when a request is no longer open. Adds to `notifications` `org_id`, `entity`, `entity_id` (set together with `entity`), `actor_id` and `count` (at least 1, only on a notice that names a record and has no dedupe key). Indexes: `idx_notifications_coalesce` (unique on user, kind and record while unread and counted), `idx_notifications_entity`, `idx_notifications_created` and `idx_comments_addressee`. Backfill: every comment is a `comment`; one said on a counseling still in draft or review, or before it was finalized, becomes private to its counselor and its Marine; a comment, mention, counseling, award, duty, assignment, hand-off or work notice that links to a record or a work case is given that record and its Unit Instance; the words old comment, mention, hand-off and assignment notices quoted are cleared (their titles stay); the demonstration's `work` kind becomes `work_moved`; training links open where a training lives. Triggers: `comments_reply_same_record` (an answer is on its request's record), `comments_requests_kept` (a request, answer or assignment note is not rewritten, except by a retention schedule's redaction) and the boundary trigger `comments_same_org_insert` (a new entry is in its record's Unit Instance), with `instanceBoundaryViolations` counting comments across it. No row is removed (ADR-0031). |

**Tested:** `tests/server/migrations.test.ts` builds a database at version 7 with real rows, opens it,
checks the stage and history backfill, and opens it again to show nothing changes the second time.

**Upgrade procedure (current):** stop the service, back up the database file (`docs/operations.md`),
start the new version. The migration runs at startup inside a transaction. There is no automatic
downgrade: restore the backup to roll back.

## Engine migration (SQLite → PostgreSQL)

Stages, per ADR-0003. None has started.

- [ ] 1. Data-access port with a SQLite adapter; move cases, record and demo onto it.
- [ ] 2. Portable SQL across the remaining services.
- [ ] 3. PostgreSQL adapter and migration set, including the append-only triggers.
- [ ] 4. Server suite green on both engines in CI.
- [ ] 5. File storage moved out of the database behind a local-volume abstraction.
- [ ] 6. Verified SQLite → PostgreSQL data migration tool: dry run, counts, checksums, attachment hashes.

## Product migration (the old interface to this one)

This is not a separate cutover. The same database serves the same routes. Old paths redirect with
their query strings. Nothing a Marine recorded moves or changes meaning. Activities, training, awards,
counseling, goals, reports and correspondence are all where the parity checklist says they are.

Entries already in Activities that read like an award received or training completed stay there through
the upgrade. Each Marine sees them listed in Activities and moves the ones that really are, or keeps them
as activities. A move keeps the entry's files, comments and lineage and can be undone (ADR-0015; John,
2026-10-17, "Marine confirms").
