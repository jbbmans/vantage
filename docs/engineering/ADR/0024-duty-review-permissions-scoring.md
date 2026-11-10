# ADR-0024 · Duty review: approve, return, reject; approved points apart from calculated; self-approval by named role only

**Status:** accepted · **Date:** 2026-11-10 · **Builds on:** [ADR-0006](0006-centralized-tenancy-and-authority.md),
[ADR-0008](0008-unit-instance-data-isolation.md), [ADR-0010](0010-vantage-administrator-and-unit-manager.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0019](0019-import-export-restore.md), [ADR-0020](0020-reports-printable-output.md),
[ADR-0023](0023-duty-records.md)

## Context

Task 18 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is Duty Approval, Permissions and Scoring:

- Workflow: Submit → Pending Review → Approve / Return / Reject.
- "Self-entered duty does not officially count until approved unless explicit self-approval authority exists."
- Permissions "should include concepts such as": view self, view team, view unit, create self, create for others,
  review, approve, reject, override points, manage duty types, manage scoring, import/export.
- Scoring methods: fixed, per day, per hour, duration bands, configurable multipliers.
- "Separate: Calculated Points / Approved Points. Overrides require authorization + explanation. Version scoring
  policies with effective dates. Never silently recalculate historical scores under a new policy."

What main held before this Task (at `a42ef19`):

- **Duty records** (`duties`, ADR-0023, migration 031): every duty is written `pending`, scored once by the server under
  the scoring version in force on its first day, with the review columns (`approval_status`, `reviewed_by`,
  `reviewed_at`, `review_reason`, `approved_points`) in place and held together by CHECKs, and nothing that could fill
  them. Approved and rejected duty already refused any edit, delete or move (`duty_decided`).
- **Scoring versions** (`duty_scoring_policies`, ADR-0012, brought forward on John's Task 6 card): the five scoring
  methods of the specification (fixed, per day, per hour, duration bands, multipliers by condition), immutable versions
  with effective dates, published and withdrawn in the Unit Manager console (`org.config`). That part of Task 18 was
  already built and is not changed here.
- **Unit permissions** (`shared/permissions.ts`): a bitfield held through roles. None was about duty. Reading shared
  records is View shared records; recording duty for a Marine is Counsel members; correcting others' records is Correct
  shared records; duty types and scoring are the Unit Manager's (`org.config`); export is Export unit data.

**John's decision (2026-11-10):** asked who may approve duty they stood themselves, John chose "Unit Leaders too" on the
card and then wrote "Actually make it role only", which stands. Approving your own duty takes a role that names it. No
standard role does, not even Unit Leader, and nobody can give it to themselves.

## Decision

### 1. What counts

A duty counts only once it is approved, and then at its **approved points**. Its **calculated points** are what its
scoring version gave it when it was recorded (ADR-0023 §3) and are never changed by a review. Approval at the
calculated points copies them to `approved_points`; anything else is an override (§5). A duty with no score (no version
in force on its first day) is approved for none. `countedPoints` in `shared/dutyReview.ts` is the one definition:
approved points when approved, zero otherwise. Pages, the Duty report and exports show the two figures apart.

### 2. Three permissions, and the ones already there

| Specification concept | What holds it |
| --- | --- |
| view self | one's own records, always |
| view team, view unit | View shared records in the unit (roles above the default reach the units beneath) |
| create self | a membership in the unit (ADR-0023 §4) |
| create for others | Counsel members over the Marine in the unit (ADR-0023 §4) |
| review, approve, reject | **Review duty** (new) with View shared records, in the duty's unit |
| override points | **Override duty points** (new) with View shared records, in the duty's unit |
| explicit self-approval authority | **Approve own duty** (new), named in a role |
| manage duty types, manage scoring | Unit Manager, `org.config` (ADR-0012) |
| import/export | one's own records always; a unit's with Export unit data |

- **Review duty** (`REVIEW_DUTY`, bit 18): approve, return or reject duty Marines stood for the unit, and reopen a
  decision. One permission for the three decisions, because a reviewer who could approve and not reject would have to
  leave duty they will not approve waiting forever.
- **Override duty points** (`OVERRIDE_DUTY_POINTS`, bit 19): approve at points other than the scoring gives, or change
  approved points afterwards, each time with a reason.
- **Approve own duty** (`APPROVE_OWN_DUTY`, bit 20): approve duty one stood oneself, at its calculated points. Marked
  dangerous in the role editors.

The role template gives Review duty to the SNCO and the SNCOIC, and Override duty points to the SNCOIC. A Unit Leader
holds both by full unit authority. Migration 032 adds the same bits to the standard roles already seeded in every unit
(`is_system`, by key), so duty already waiting has reviewers. As migration 007 did, it hands a permission only to a role
that could already do that work: an SNCO or SNCOIC role its unit cut back from View shared records or Counsel members
gains nothing, and an SNCOIC role that no longer corrects shared records does not gain the override. A role a unit made
itself is never touched. The bits are written out in the migration so a later change to the template does not change
what it did, and an instance archive from before 032 gets the same when it is imported.

**Approve own duty is named-only.** `NAMED_ONLY_BITS` holds it, and:

- full unit authority is `ALL_PERMISSIONS & ~NAMED_ONLY_BITS`: a unit's leader holds `FULL_UNIT_AUTHORITY`, and `has()`
  never reads `ADMINISTRATOR` as a named-only permission, on the server or in the client;
- no entry of the role template carries it, and migration 032 gives it to no role;
- **nobody grants it to themselves** (`guardSelfNamed`, code `self_grant`): not by granting oneself a role that names
  it, by adding it to a role one holds (the default role included), by raising a role one holds off position 0 so that
  it reaches the units beneath, or by one's own join code or invitation (`guardSelfReach`). This holds for a Unit Leader
  and a Unit Manager as for anyone;
- someone without full authority over the unit cannot put it in a role or hand such a role out unless they hold it
  (the existing delegation rule, code `delegation`).

So the only way to hold it is for someone else, with authority over the unit's roles, to grant a role that names it,
and that grant is in the audit trail with who gave it.

### 3. One rule for who may do what

`dutyReviewOptions(row, me, authority)` in `shared/dutyReview.ts` is the single rule. The server enforces it in
`reviewDuty` and sends its answer with every duty it reads out (`review`: seven booleans), so a page offers exactly the
decisions the server will take and holds no rule of its own.

| Duty | Who | May |
| --- | --- | --- |
| somebody else's, pending | reviewer | approve, reject; return unless it is frozen |
| somebody else's, pending | reviewer with override | also approve at other points |
| somebody else's, approved, rejected or returned | reviewer | reopen, with a reason |
| somebody else's, approved | override authority | change its approved points |
| one's own, pending | holder of Approve own duty in its unit | approve at its calculated points, unless frozen |
| one's own, any | anyone, whatever they hold | never return, reject, reopen or set points |
| returned | whoever may correct it (ADR-0023 §4) | send it back for review |

**Authority is held through the chain of command.** `dutyReviewAuthority` reads what the person holds in the duty's unit
through their roles there and above it and through leading it (`chainBits`): View shared records and Review duty (or
Override duty points) must both come from there. Vantage access (read-only) and Unit Instance authority (structure only)
never complete it, so a Vantage Administrator or a Unit Manager does not review duty by that office, and a role that
names Review duty without View shared records reviews nothing: nobody decides what they cannot open.

**The workflow.**

- **Submit.** Recording a duty submits it (`pending`, `submitted_at`), as ADR-0023 wrote it.
- **Approve.** `approved`, with `reviewed_by`, `reviewed_at` and `approved_points`.
- **Return**, with a reason. `returned`. Its Marine (or whoever recorded it for them, or a records manager) corrects it;
  saving the correction sets it `pending` again in the same update, with a fresh `submitted_at`. It can also be sent
  back as it is (`resubmit`). A duty frozen because its Marine left the unit cannot be returned, since nobody could
  correct it: it is approved or rejected.
- **Reject**, with a reason. `rejected`. It counts for nothing and stays as decided.
- **Reopen**, with a reason. A reviewer takes back an approval, a rejection or a return; the duty waits again and any
  approved points are withdrawn. This is how a wrong decision is corrected: a decided duty is still refused every edit.
- A decision is for the duty as the reviewer saw it: the request carries its `version`, and the update is guarded on
  version and status (409 `stale`, with the current duty).

Deliberate allowances: a leader who recorded duty for a Marine and also reviews in that unit may approve it, because it
is not their own duty; and a reviewer who corrects a returned duty (which sends it back) may then approve it. Both leave
the Marine's duty decided by someone other than the Marine, and both are in its history.

### 4. Every decision is kept

`duty_reviews` (from `schema.sql`, with migration 032) holds one row for each decision, each change of points and each
resubmission: the duty, the unit it stood in then, who did it, the event, the status before and after, the reason, the
calculated points, the approved points after, the scoring version, whether the points were an override and whether its
own Marine did it. It is written in the transaction that makes the change, with the audit entry. Triggers keep it as
written: nothing but its reason is ever updated, and that only to the retention notice. CHECKs require a reason where
one is required and allow points only on an approval. It goes when its duty is destroyed (`ON DELETE CASCADE`, as
comments do).

Each decision is also an audit entry (`duty_approved`, `duty_returned`, `duty_rejected`, `duty_resubmitted`,
`duty_reopened`, `duty_points_changed`), naming the actor, the duty, its unit and its Marine, and saying the points and
whether a reason was given. A self-approval says so. **Reasons are never written to the audit trail**, which is
append-only and could not be cleared by a retention schedule; they live on the duty and in its history.

The people a decision concerns are notified after it commits: the Marine, whoever recorded the duty for them, and the
reviewer whose return was answered or whose decision was reopened or re-pointed. By the duty's type and day only, never
its words or the reason, and never someone who can no longer open it.

`GET /api/records/duties/:id/reviews` returns the history to whoever may read the duty, people by rank and name. Reading
another Marine's is audited as a record view.

### 5. Overrides need authority and an explanation

Approved points other than the calculated ones are an override whenever they are set: at approval (`approve` with
`points`) or afterwards (`change_points`). Both take Override duty points in the duty's unit and a reason. The duty keeps
`points_override_reason`, `points_overridden_by` and `points_overridden_at` (migration 032), which a CHECK holds whole
or absent and only on an approved duty. Setting the points back to the calculated ones withdraws the override and clears
the three, with its own reason in the history. Asking for the calculated points is no override and needs no reason.
Points are a number from 0 to 100,000, to two places. Nobody overrides the points of their own duty, and a
self-approval is at the calculated points only.

### 6. Scores are never recalculated by a review or a new version

No review path scores a duty. Approval copies the stored `calculated_points`; the duty's `scoring_policy_id`,
`scoring_version` and `scoring_basis` are untouched by approve, return, reject, reopen, resubmit and change of points.
A duty is scored again only when its own times, type, claimed conditions or unit are corrected (ADR-0023 §3), and then
under the version in force on its first day. A version published later changes nothing already recorded, calculated or
approved. Migration 032 changes no duty's status, points or version.

### 7. Where a reviewed duty may go

- **Its Unit Instance.** A reviewed duty does not leave the instance that reviewed it: the service refuses
  (`cross_instance`) and so does a trigger (`duties_reviews_same_org`). A review row is in its duty's instance
  (`duty_reviews_same_org_insert`), and `instanceBoundaryViolations` checks existing rows.
- **Undo of a move.** A duty that was an activity can be moved back until somebody reviews it; after that the undo is
  refused (`duty_reviewed`), whatever its status is now, so its history is not orphaned.
- **Import.** A file never brings a review in. A duty comes in submitted whatever the file says of its status or
  approved points; a file that corrects a returned duty sends it back for review as any correction does; and undoing an
  import puts back what the duty said, never its review columns (`DUTY_REVIEW_COLUMNS`). Review history is listed as not
  imported.
- **Export.** Exports carry Approved Points beside Calculated Points. One's own copy holds each duty's override and who
  set it, and its review history (`duty_reviews`, `duty-reviews.csv`), people by name and never by id. The instance
  archive carries `duty_reviews` after `duties`.
- **Retention.** Anonymizing a duty redacts the reason its points were set apart and every reason in its history, with
  its other words; who decided, when and the points stay, as its score does, and nobody is named on a read of it. An
  anonymized duty is closed to review (`duty_anonymized`). Destroying a duty destroys its history.

### 8. Where it shows

- **Records → Duty**: calculated and approved points side by side; what counts in the totals is approved points.
  **To review** lists the duty waiting for the reader's decision (`GET /api/record/duty/review-queue`: their units,
  longest-waiting first, never their own, audited as a list of those Marines' records), with Approve, Return and Reject
  on each row. A duty opens with the decisions open to its reader, a required reason where one is required, and its
  review history. A returned duty shows why, and its form says that saving sends it back.
- **A Marine's page**: the same decisions and history on the Duty tab.
- **Duty report**: Approved points and an Override column, approved counts and points in the summary, and the by-Marine
  tally ranked by what counts.
- **Role editors** (Personnel → Roles, and the console): the three permissions under Duty.

## Decided, and defaults John can change

- Self-approval is by named role only (John, 2026-11-10).
- One permission covers approve, return, reject and reopen. Splitting them would need a second decision from John.
- SNCO and SNCOIC review by default; the SNCOIC may override. A unit can move either permission to any role.
- Reviewers are not notified of each submission; the queue and its count on the Duty page show what waits.
- A reviewer may reopen any decision in their unit, including another reviewer's, with a reason; that reviewer is told.

## Alternatives considered

- **Let full unit authority include self-approval.** John chose "Unit Leaders too" and then replaced it with "role
  only". Under role only, a leader's own duty is decided by another reviewer or under a role someone else gave them.
- **Separate approve, return and reject permissions.** Rejected for now: the specification lists them as concepts, and a
  reviewer with one and not the others cannot finish a review.
- **Edit a decided duty in place.** Rejected: a decision would change without a record. Reopen, with a reason, then
  correct.
- **Rescore at approval.** Rejected: the specification says never silently recalculate; the stored score is approved.
- **Write reasons to the audit trail.** Rejected: the trail is append-only, so a retention schedule could never clear
  words about a person from it.

## Not done here

- Notifying reviewers when duty is submitted, and a count of waiting duty in the navigation.
- Review decisions in bulk.
- A duty dataset in the Custom report; demo duty; duty swaps and availability (open since ADR-0012).
- Auditing refused review attempts: refusals on record routes are counted in telemetry, as for every record route.

## Consequences

- Duty already recorded keeps its status; nothing is approved, scored or recalculated by the upgrade.
- Three permission bits are added (18, 19, 20). The standard SNCO and SNCOIC roles of existing units gain review
  permissions on upgrade; no role gains self-approval.
- `has()` now treats named-only permissions apart from `ADMINISTRATOR`, so any later permission that must be explicitly
  granted can join `NAMED_ONLY_BITS`.
- Rollback: revert the commit. The three columns, `duty_reviews` and the role bits can stay in the database unread; to
  remove them, clear bits 18 to 20 from `roles.permissions`, drop `duty_reviews` and the three `duties` columns.
