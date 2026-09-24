# Domain model

The concepts, where each lives, and the rules that bind them. Table names are given for engineers.
The product never shows them to users.

## Organization and people

- **Unit** (`units`): a node in a flexible tree (`parent_id`). Any depth, any echelon name.
- **Membership** (`unit_members`): a person in a unit, with billet, primary flag and join date.
- **Role** (`roles`, `member_roles`): a named bitmask of permissions, defined per unit. Nothing
  inherits down the tree. Rank never grants authority.
- **Scope** (`server/authz/scope.ts`): the caller's units, per-unit permissions and positions, resolved
  from the session on every request. It is never taken from the client.

## Work

- **Project** (what the shop called a tasker): a `projects` row that holds work items
  (`work_items.project_id`). The UI says "Projects" (PD-022).
- **Work item** (`work_items`): one unit of work. Carries document number (`reference`), natural key,
  title, due date, amount from the source, the source row, the holder (`claimed_by`), **stage**, waiting
  category and start, blocked reason, and the pinned procedure and version. The coarse `state` column
  is kept in step with the stage.
- **Source file** (`source_files`) and **import job** (`import_jobs`): the original bytes (never
  rewritten), their SHA-256 hash, the scan verdict, the mapping, and per-row lineage.
- **Case event** (`work_events`): append-only. Kinds:
  - *ownership*: created, claimed, released, assigned, handed_off, claim_expired
  - *stage*: stage_changed, waiting_started, waiting_ended, resolved, reopened
  - *research*: question, observation, finding, decision, note, calculation, action_recorded
  - *execution*: action_prepared, action_submitted, external_event (approved, effective, posted,
    rejected, returned), funds_check
  - *control*: verification
  - *procedure*: procedure_applied

  Each event carries its actor (null only for the system), a subject where relevant, a typed body
  validated per kind (`shared/caseModel.ts`), an optional step, and an optional `supersedes_id`.
- **Work action** (`work_actions`): the original "what did you do" record with quantity, value and an
  optional drafted activity. Each one also writes an `action_recorded` event.

## Money

Case money is integer cents with an explicit currency (`shared/money.ts`). It is parsed from text and
never passes through a float. Older tables (`activities.dollar_amount`, `work_items.amount`) still hold
REAL dollars. They are read into cents through the same parser, and are not rewritten.

## Where a value came from

Every recorded value is labelled with its source (`VALUE_SOURCES`):
- the imported source file;
- a manual observation of an authoritative system (read from DAI and typed in);
- an approved authoritative import (none exists yet);
- a person's entry;
- a Vantage calculation;
- a forecast;
- an AI draft.

A manual observation is never presented as an integration.

## Procedures

See `PROCEDURE_MODEL.md`. A procedure is versioned code (`shared/procedures.ts`). A work item pins
the key and version it was started under. Progress is derived from the item's events. It is never
stored, and it never infers a decision.

## The Record

- **Assigned work**: items where `claimed_by` is the person and the stage is not closed.
- **Contribution history**: events the person authored, grouped by work item.
- **Contribution counts**: documents researched, research entries, submitted actions, verified
  outcomes and resolved work. Each has a definition in `shared/record.ts`, over a stated window.
- **Personal documentation**: activities, training, awards, counseling (the existing record tables),
  and **drafts** (`record_drafts`): facts cited to events, plus wording. Owner-only.

## Career

`career_steps` (owner-only next steps, each with its source and the date it was last checked) and
`career_profiles` (military goal, civilian interests). Readiness, training, awards and counseling are
the existing tables.

## Demo

`demo_workspaces` plus `users.demo_workspace_id`. Only a database flagged `meta.demo_database = '1'`
holds them. See `docs/security/SECURITY_MODEL.md`.
