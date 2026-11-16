# ADR-0031 · Workflow messages and notices: what is said lives on the record it is about

**Status:** accepted · **Date:** 2026-11-15 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0010](0010-vantage-administrator-and-unit-manager.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0015](0015-core-record-architecture.md), [ADR-0024](0024-duty-review-permissions-scoring.md),
[ADR-0027](0027-counseling-workflow-navmc-2795.md), [ADR-0030](0030-drafts-in-context.md)

## Context

Task 24 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P2) is Workflow Messaging / Comments / Notifications:

> Do not create generic chat unless needed. Use workflow communication: comments, @mentions, review request,
> clarification request, return for correction, approval/rejection note, assignment note. Notifications should cover
> meaningful state changes. Avoid spam. Respect Unit Instance and record permissions.

What main held before this Task (at `b11b676`):

- **Comments and @mentions** on every record table (`server/services/comments.ts`), not on work cases. Anyone who could
  read a record could write on it, including Vantage staff reading through an access grant. A mention was looked up among
  every user of the service, and one that matched nobody was dropped without a word. A comment a Marine wrote on a
  counseling in review became readable by the unit once it was final.
- **Notifications** were rows with a free `kind`, a copied title and message, and a link. Nothing said which Unit
  Instance or which record a notice was about, or who caused it, so a notice could not be checked again when read,
  grouped, turned off, taken back, removed with its record or expired. They were kept forever. A comment's notice quoted
  160 characters of it, against the rule that a notice carries nobody's words (`docs/security.md`, ADR-0024).
- **Noise and gaps.** A bulk hand-off of 40 cases sent 40 notices. Handing work to oneself told oneself. A permanent
  dedupe key silenced a real second event (reassigned A to B, back to A, to B again). Nothing told a holder their claim
  lapsed or was released, a requester their support ticket was resolved, or an owner their task was done.
- **Review and clarification requests** existed nowhere outside support tickets. **Return for correction** existed only
  on duty. **An assignment note** existed only on a work hand-off.

## Decision

### 1. No chat. Everything said is said on a record, to people who already read it

There are no direct messages, channels or a free-text inbox. A record (activity, project, task, goal, training, award,
counseling, duty) or a work case has a **Discussion**: the `comments` table, which already travels with record moves,
transfers, destruction, exports and the privacy inventory. Migration 038 gives each entry a `kind`:

| kind | what it is |
|---|---|
| `comment` | a remark; its author may edit it, its author or a records manager may remove it |
| `clarification_request` | "Ask a question" of one named person; open until answered or withdrawn |
| `review_request` | "Ask for review" of one named person; open until "Looks right" or "Needs changes" (with what), or withdrawn |
| `answer` | the answer to a request (`reply_to`), on the same record (a trigger refuses another) |
| `assignment_note` | the note a task or goal assignment carries, written in the assignment's transaction |

Requests, answers and assignment notes are kept as said (`comments_requests_kept` refuses an edit, except a retention
schedule's redaction). A request's `state` is `open`, `answered`, `looks_right`, `needs_changes`, `withdrawn` or
`closed`. One request is open at a time per author, addressee, kind and record (409 `request_open`). Thirty requests an
hour per person.

**Where each kind lives:**
- **Duty:** "Ask for review" only of someone who may decide it (`dutyReviewAuthority().review`), never its Marine; the
  person picker offers the same people for a review (`/people?kind=review_request`), and lets go of someone chosen for a
  question when the request turns into a review. A decision (approve, return, reject) closes the review requests still
  open on it. Approving takes an optional note,
  kept on the duty where its Marine reads it.
- **Counseling:** no review request: sharing it with its Marine is the review (ADR-0027). Comments between its counselor
  and its Marine while it is a draft or in review are `private`: only those two read them, after it is final too. An
  edit of one, after it is final too, can name only those two.
- **Work case:** questions and review requests only, no free comments (the case has its own sealed notes, ADR-0022).
  Moving a case out of "Verification required" to a working stage is a **return for correction**: whoever does it says
  what needs correcting (kept on the case's sealed history), unless its holder takes it back themselves; its holder and
  whoever asked for it to be verified are told. A return closes the review requests open on the case, after telling
  whoever asked: nothing waits to be verified until it comes back, and then it can be asked for again. Every route that
  moves a stage applies it: the stage change, a state PATCH (refused, 409 `reason_required`, because a PATCH has no
  reason) and a recorded action. Resolving or closing a case closes its open requests and tells its holder when someone
  else closed it, once: a repeated request that changes nothing tells nobody again.
- **Task and goal:** an assignment to someone else may carry a note (`assignment_note`, up to 1000 characters), kept in
  task and goal drafts (ADR-0030) until the form is sent. The note is written after the record's own change, in the same
  transaction, so a task moved to another Unit Instance and given to someone there carries its note with it, and a stale
  edit writes neither. Whoever a task was given to before is not told what is said on it once it is someone else's: an
  addressee hears a record's discussion only while a question or review request names them.

### 2. One rule for who may speak: `speaks()`

Someone may write, be asked, be named, be offered in the person picker, or be pushed a comment only if:
- they are active;
- they read the record **by their own access**: their permissions are recomputed without the `vantage` grants
  (`ownScope`, `server/authz/scope.ts`), so Vantage staff reading through an access grant never write (ADR-0010);
- the record is neither frozen nor anonymized;
- and they are a member of its Unit Instance (`scope.orgIds`), or they are its Marine on a record that is private, has
  no unit, or is in a Unit Instance they still belong to.

A counselor is pushed comments only while `stillCounsels`. Mentions and the picker look only among the record's Marine
and the members of its Unit Instance, then keep those who speak. `@username` exactly, or a first and last name run
together when exactly one such person matches; never after a letter or digit, so an e-mail address is no mention. At
most 10 people per message (400, never quietly cut). The answer to a comment says who was told and which names were not.

### 3. Notices know what they are about

Migration 038 adds to `notifications`: `org_id` (the Unit Instance), `entity` and `entity_id` (the record or work case),
`actor_id`, and `count` (coalescing). The catalogue `shared/notifications.ts` names every kind and its group; `notify()`
refuses a kind it does not name.

| group | can be turned off |
|---|---|
| Asked of you: questions and review requests, answers to yours, work and tasks handed to you or returned for correction, support | no |
| Decisions on your records: duty, counseling, award; what your counselor or Marine says on a counseling | no |
| Mentions | no |
| Discussion: new comments on records you are part of | **yes** |
| Work updates: a claim lapsed or released, work you held moved or closed, a task you set done | **yes** |
| Your unit: membership, roles, leaders' messages | no |
| Announcements: MARADMINs | **yes** |
| Security; Operations | no |

`notify()` never tells someone about their own action (when the caller names the actor), never an inactive person, and
skips a group its recipient turned off (`prefs.notifications.muted`, Settings → Notifications).

**Coalescing is declared per kind and never shares a row with a dedupe key.** A kind that coalesces (`comment_added`,
`counseling_comment`) keeps one unread notice per person, kind and record: the next one adds to its `count` ("3 new
comments") instead of adding a row. A partial unique index on `(user_id, kind, entity, entity_id) WHERE read_at IS NULL
AND count IS NOT NULL` does it in one statement. Every other kind dedupes by `dedupe_key`, now dated where the event can
happen again (re-adding a member, a second move, a second hand-off). Enrolling someone already in a unit tells them
nothing new.

**A bulk hand-off or release** sends one summary per person per Unit Instance, counting only the cases that run
applied, and sends it even when the run stops on a server error. A retry with the same key reports what it applied
itself; a pure replay sends nothing.

**A notice about a Unit Instance names it** (`org_id`) even when it names no record: a member added or moved, a role, a
leader's message, a help request, an access grant, a sign-out or a CAC link made by that Unit Instance. An instance
hold therefore keeps it (§6).

### 4. A notice never carries anybody's words

A notice about a record names the event and who did it ("Sgt Diaz asked you a question"). Its `message` is not stored.
The record's own name (a task's current title, a duty's type and day, a case's reference) is read **when the notice is
read**, after the access check, and is "A record its retention schedule anonymized" once it is. Never a comment, a
question, a note or a reason: those are on the record, behind its permissions. Support ticket notices no longer quote
the subject or the reply; access and credential notices no longer quote the reason or the note (they are read in the
console). Migration 038 clears the words old notices quoted: comment notices, and the old support ticket, access
request, access decision and credential notices.

Stated exceptions, notices about no record: a leader's team message (its subject and body, as sent to the unit), a
MARADMIN's number and title, a Unit Instance's suspension reason and the withheld-feature reason (the notice is how
Vantage tells its Lead Unit Managers, ADR-0014), and operations notes.

### 5. Checked again when read

`GET /api/me/notifications` hides any notice whose record or work case its reader can no longer open (deleted, moved out
of reach, back in draft, access lost) and counts unread the same way, so the bell never shows a number the list does not.
A moved record's notices follow it (`moveNotices` points them at the record where it now is), and links to trainings
open where trainings live. Each row carries its Unit Instance's name. Cursor paging, `filter=unread`, `group=`; `limit` is an integer from 1 to 100. A notice that would tell someone
they lost access (a counseling taken back, claims released because they left) is not sent: the check would hide it.

### 6. Lifecycle

- Kept 180 days, then removed by the `notifications_expire` job every six hours, except those of a person under a hold
  and those of a Unit Instance under an instance hold; a platform-wide hold stops the sweep. A run that finds notices
  due is recorded as a disposition run, as the drafts sweep is (ADR-0030); one that removed anything is audited
  (`notifications_expired`).
- A destroyed or anonymized record takes its notices with it. Anonymizing a record also redacts every comment, request
  and answer on it and closes its open requests, except what a person under a legal hold said, which stays until the
  hold is released and goes at the next run after that, as their files do. A record anonymized before migration 038 has
  its discussion redacted, its open requests closed and its notices removed at the next run of its schedule; the
  Governance console counts these in its preview and lets a run start for them alone. A moved record's notices and
  discussion follow it.
- Soft-deleted comments are purged with the recycle bin after 30 days.
- A withdrawn or closed request takes back its unread notice.
- A record with a question or review request still open with someone other than its Marine does not move to another
  Unit Instance until it is answered or withdrawn (ADR-0008). Others' comments and answers, a review's verdict among
  them even with no note, already keep it there; a withdrawn request does not.

### 7. Unit Instance boundary

A `BEFORE INSERT` trigger on `comments` refuses an entry whose unit is in another Unit Instance than its record's
(`comments_same_org_insert`), and `instanceBoundaryViolations` counts live entries by someone other than the record's
Marine across the boundary. There are no update triggers: a Marine's own comments legitimately travel with their record.

### 8. Where people see it

- **Notifications** (`/notifications`): Notices (unread or all, by group, with the Unit Instance's name, mark read, mark
  all read, more) and Asked of you / You asked.
- **The bell** previews the newest and links to the page. **Today** puts "Asked of you" with your work and "You asked"
  with what waits on someone else. **The weekly digest** counts what waits on you and your unread notices, with nobody's
  words.
- **Discussion** on records and cases: comment, ask a question, ask for review, answer, withdraw, with a person picker.

## Not doing

- Direct messages, channels or a free-text inbox (the specification).
- Per-event e-mail. The weekly digest stays the only personal e-mail; instant mail needs MCEN mail policy.
- A notice to duty reviewers on every submission (ADR-0024 decided against it). A Marine can ask a named reviewer.
- A per-record mute: coalescing gives one unread notice per record.
- A required note on an access-request denial: it would put more words in the append-only audit.

## Consequences

- Notices can be re-checked, grouped, turned off, taken back, purged and expired, because each knows its record.
- Reading notices costs one access check per record shown; it is batched (200 at a time, at most 2,000 scanned).
- The words of old notices are gone after migration 038. Their titles remain.
