# Architecture

A modular monolith. One Node.js process serves the API and the compiled client. The data layer today
is SQLite. The production target is PostgreSQL (ADR-0003). `docs/architecture.md` has the earlier
overview; this file supersedes it where they differ.

```
browser (React 19, Vite build, Tailwind, TanStack Query; every asset served locally)
   │  HTTPS 443 → reverse proxy (TLS) → app
   │  /api/* JSON · cookie session · x-vantage-client CSRF header
   ▼
Node 22 · Express 5 · TypeScript run directly (no server build step)
   ├─ auth/      sessions, TOTP, passkeys, CAC (direct mTLS or trusted proxy), limiter
   ├─ authz/     scope resolved per request from the session; record visibility
   ├─ routes/    auth, me, records, work, record, org, correspondence, support, admin, demo, misc
   ├─ services/  work (queue, claims), cases (history, stages, entries, handoffs, calculation),
   │             record (Record, workload, drafts, career), records, recordMoves (moves and their
   │             lineage), timeline, intake (imports), demo, org, metrics,
   │             reports, correspondence, retention, personnel, audit, telemetry, ai, email,
   │             comments (discussion and requests), notifications
   └─ db/        schema.sql (idempotent), numbered migrations, ranks seed
   ▼
SQLite (better-sqlite3, WAL) on a local volume · attachments and source files as BLOBs today
```

`shared/` holds domain logic used by both sides:
- `caseModel.ts`: stages, event kinds and their zod schemas
- `procedures.ts`: the 2-Way UMT procedure, progress derivation, the candidate calculation
- `money.ts`: exact cents
- `record.ts`: definitions and limits; career schemas
- `recordKinds.ts`: the registry of record kinds (store, writer, corrector, system of record), the
  classifier that reads an activity as an award or training, and what an entry becomes when it moves
- the existing parsers, metrics and permissions

## Module boundaries

| Boundary | Owns | Talks to |
|---|---|---|
| Identity and sessions | accounts, sessions, MFA, CAC | authz |
| Organization and authorization | units, memberships, roles, scope | everything, read-only |
| Work | work items, queue, claims | cases, intake, correspondence |
| Cases | `work_events`, stages, research, controls, handoffs | work, procedures |
| Imports | source files, jobs, lineage | work, cases |
| Record and career | projections of events; drafts; career | cases (read), records |
| Records (personal documentation) | activities, training, awards, counseling, goals; moves between activities, awards and training, and their lineage | metrics, reports, the timeline (read-only) |
| Reporting | metrics, reports, analysis, workload | read-only over the above |
| Discussion and notices | `comments` (comments, requests, answers, assignment notes), `notifications`, the notice catalogue | records and work (read), authz |
| Audit and telemetry | audit chain, product events | written by all |
| Administration | runtime settings, governance, exports | operators only |
| Demo | synthetic workspaces | org, work, cases (demo database only) |

## Request path for a case write

route → `scopeFor(session)` → service opens a transaction → reload the row → authorize against the row
→ check the version → validate the body per kind → append an event → update the row and its version
→ commit. The client invalidates the item, the queue, the Record and the workload queries after every
write.

## Configuration

Environment variables, validated at startup (`server/config.ts`). Dangerous combinations are refused:
- production without a 32+ character secret, a setup token, or an HTTPS public URL;
- CAC proxy mode without a shared secret;
- demo mode in production or alongside CAC, email, AI or the MARADMIN feed;
- under `VANTAGE_DEPLOYMENT_PROFILE=mcen`, any public-internet service of the legacy site (IndexNow,
  search verification, Cloudflare client addresses, Resend or direct mail, self-registration, no consent
  banner, a separate public-site address);
- `VANTAGE_TOPOLOGY=dedicated` on a database that already holds more than one Unit Instance;
- `VANTAGE_TEST=1` without `NODE_ENV=test`, and `VANTAGE_DEPLOYMENT_PROFILE=mcen` without
  `NODE_ENV=production` outside the test suite.

Deployment profiles, topology and the three configuration boundaries (infrastructure, enterprise, Unit
Instance) are in [ADR-0007](ADR/0007-mcen-enterprise-deployment-and-unit-instances.md). See `.env.example`.

The Unit Instance is a security boundary in the backend, not only a label: operations naming two units,
and references carried by id, are checked for the instance they belong to, and migration 016 keeps the
same rules in the database. See [ADR-0008](ADR/0008-unit-instance-data-isolation.md), which also records
why PostgreSQL row-level security waits for the PostgreSQL adapter.

An account is the person for a whole career; memberships change around it and are kept as history
(`unit_membership_periods`, written by triggers from migration 018). A transfer accepts an invitation into
the existing account, a proven EDIPI is changed only by Vantage support, and an account shared by two
Unit Instances is governed once. See [ADR-0009](ADR/0009-identity-and-unit-membership.md).

Authority has three tiers with explicit names: Vantage Administrators and other Vantage staff run the
service (`platform_roles`), Unit Managers run one Unit Instance's structure (`org_roles`, only while they
belong to it), and unit roles in the chain of command read what is shared with their units. Checks ask for
permissions, never role names, and no one at either upper tier can widen their own reach. See
[ADR-0010](ADR/0010-vantage-administrator-and-unit-manager.md).

Each kind of record keeps its own store, named in `shared/recordKinds.ts` with who writes it, who may
correct it and which outside system holds the official copy. An Activity is work a person did, and never
stands in for an award, a course, a counseling or a duty. A duty (`duties`, migration 031) is scored on the server under the
version in force on its first day and keeps that score ([ADR-0023](ADR/0023-duty-records.md)). It counts only once a reviewer in its
unit approves it, at approved points kept apart from the calculated ones; one rule (`dutyReviewOptions` in
`shared/dutyReview.ts`) says who may approve, return, reject, reopen or set points, the server enforces it and sends
its answer with every duty it reads, and each decision is a row of `duty_reviews` (migration 032) and an audit entry
([ADR-0024](ADR/0024-duty-review-permissions-scoring.md)). A record's files live in `attachments` and are reached only through the
record (`canRead` to list and download, `canEdit` to add, correct and remove); a training's files are its evidence and
say what they are (`kind`, `description`, migration 033), validated by `inspectAttachment`
([ADR-0025](ADR/0025-training-evidence.md)). A counseling a leader writes is a draft only they read, may be shared with its
Marine for review, and is finalized; once final it changes only by amendment, which keeps what it replaced in
`counseling_revisions` (migration 035). One rule (`counselingOptions` in `shared/counseling.ts`) says who may share,
finalize, amend or acknowledge, and its worksheet is one structured document that the preview, the print page and
`server/lib/pdfCounseling.ts` all draw; the PDF is never stored ([ADR-0027](ADR/0027-counseling-workflow-navmc-2795.md)).
A unit's analytics (`GET /api/org/units/:unitId/analytics/:section` and `.../drill`) are built in
`server/services/unitAnalytics.ts` from the report center's readers: each source record says which bar of which
visual it counts in, and `shared/unitAnalytics.ts` adds them into figures and filters them for a drill, so a drill
lists exactly what its figure counts. `src/components/analytics/` draws every chart, with its table and its drill
([ADR-0028](ADR/0028-unified-analytics.md)).
A draft lives with its kind: a goal, award, training entry, task or personnel change saved to finish later is a row of
`form_drafts` (migration 037), its author's alone and read by nothing that counts or lists records; it is sent through
its kind's own route with `?draft=`, which checks it as any new record and removes it in the same transaction
(`consumeDraft` in `server/services/drafts.ts`). `GET /api/drafts` reads every kind of draft from where each is kept,
on request, and stores nothing ([ADR-0030](ADR/0030-drafts-in-context.md)).
What is said is said on the record or work case it is about, never in a chat ([ADR-0031](ADR/0031-workflow-messages-and-notices.md),
migration 038). Its Discussion is the `comments` table, whose `kind` is a comment, a question or a review request to one
named person (open until answered, withdrawn or closed by its workflow), the answer to one, or the note a task or goal
assignment carries; a work case takes requests but no free comments. One rule, `speaks()` in
`server/services/comments.ts`, says who may write, be asked, be named, be offered in the picker or be told of a comment:
someone who reads the record by their own access (`ownScope` in `server/authz/scope.ts` leaves out Vantage access) and
belongs to its Unit Instance, or is its Marine on a record that is private or in no unit. Every notice is of a kind
named in `shared/notifications.ts`, which puts it in a group. `notify()` refuses any other kind, never tells someone
about their own action or tells an inactive person, and skips a group its person turned off (only Discussion, Work
updates and Announcements may be). A notice names its Unit Instance, the record or case it is about (`entity`,
`entity_id`) and who acted; one about a record never carries what anybody wrote. A kind that coalesces
(`comment_added`, `counseling_comment`) keeps one unread notice per person, kind and record and counts what it stands
for (`count`, under a partial unique index); every other kind is sent at most once per dedupe key.
`GET /api/me/notifications` checks each notice again as it is read (`readableEntity`, batched, at most 2,000 scanned
per page), hides one whose record its reader can no longer open, counts unread the same way, and reads the record's
name only then. A destroyed or anonymized record takes its notices with it (`forgetNotices`), and a moved one takes
them along (`moveNotices`). The `notifications_expire` job runs every six hours and removes notices older than 180 days,
except those a person's or a Unit Instance's legal hold keeps, and a hold on every Unit Instance stops it; a run that
finds any due is recorded as a disposition run.
The person's timeline (`GET /api/record/timeline`)
is read from each store on request and never stored. An owner moves an entry between activities, awards and
training, or from an activity to duty, in one transaction that carries its files and comments, keeps the row as it stood in
`record_lineage`, is audited at both ends and can be undone; nothing moves on its own, and migration 023
moved nothing. An award keeps who recorded it (`awards.recorded_by`), and a leader's recommendation is never
its subject's to change. See [ADR-0015](ADR/0015-core-record-architecture.md).
A list that is limited decides which rows its reader may see before it cuts, and says when it is cut
([ADR-0032](ADR/0032-performance-accessibility-responsive.md)). Many people's permissions are built at once by
`scopesFor` in `server/authz/scope.ts`, from five statements and the same builder as `scopeFor`. Migration 039 adds
indexes only; the period indexes are on the exact expression `periodClause` writes, and the analytics reads name them
(`INDEXED BY`). In the browser, `Table` requires a caption, `Dialog` gives focus back, `Tabs` pairs with `TabPanel`,
and `keepFocusClear` in `src/lib/keyboard.ts` keeps keyboard focus out from under the sticky header and the tab bar.

## Tests

- `tests/server/`: node:test, HTTP level, in-memory SQLite. 361+ cases, including the case model,
  Record, demo isolation, and migrations from a v7 database.
- `tests/browser/`: Playwright on the built client:
  - `server.ts` runs an accounts-mode instance;
  - `demo-server.ts` runs a demo instance for `22-demo.spec.ts`;
  - axe runs in both themes;
  - four viewports are checked for sideways scrolling.

SQLite passing is not proof of PostgreSQL behavior (ADR-0003).
