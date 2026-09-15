# VANTAGE — coherence rebuild

A map of what is wrong, why, and the order it gets fixed. Written before any code
changed, from reading the tree at `659cbba`.

## The one sentence

VANTAGE grew three parallel models of "a piece of work" that never learned about each
other, and a permission model that is granular at the unit level and all-or-nothing
everywhere else. Almost every complaint below is a symptom of one of those two facts.

---

## Finding 1 — there are three work models, not one

| Model | Table | Has | Missing |
|---|---|---|---|
| Typed task | `tasks` | assignee, status, due date, `project_id` | **no foreign key on `project_id`**, no claim, no source |
| Container | `projects` | name, progress, dates | no link to queue rows |
| Imported row | `work_items` | claim, state machine, source file, row hash, amounts | **no `project_id` at all** |

`tasks.project_id` is declared `TEXT` with no `REFERENCES`. Nothing stops it pointing at
a project that does not exist. `work_items` cannot belong to a project under any schema
currently in the tree.

The Work screen shows these as four tabs (Case queue / Tasks / Projects / Correspondence).
That is a merge in the navigation only. Underneath they are unrelated tables, which is
exactly why a project cannot hold a spreadsheet queue.

**Fix:** one spine. `work_items` gains `project_id`; `tasks.project_id` gains a real
foreign key and an index; both surface through one list model carrying `origin`
(`typed` | `imported`). A project opens onto its work — typed rows and sheet rows in the
same list, with the sheet columns present when the row came from a sheet.

**Not doing:** collapsing `tasks` into `work_items` by rewriting rows. The two carry
different real semantics and a merge migration risks live data for a gain the unified
read model already delivers.

## Finding 2 — tasks and projects cannot take files

`server/routes/records.ts:98`

```
const ATTACHABLE = new Set(['activities', 'awards', 'counselings', 'trainings']);
```

The whole attachment stack already exists and is good: BLOB storage, SHA-256, a partial
unique index that de-duplicates live files per record, quota accounting, soft delete,
inclusion in the personal export. Tasks, projects and work items are simply not on the
list.

**Fix:** add them, with per-type permission checks (a file on a private task is private;
a file on a unit work item follows the work item).

## Finding 3 — a claim is the only gate there is

Corrected after reading every write path rather than the one I happened to open first.

`server/services/work.ts`

```
mayEdit = row.claimed_by === user.id || row.owner_id === user.id || can(MANAGE_RECORDS)
```

**What I first wrote here was wrong.** I said a claim lets you rewrite every field including
the figures that came off the source sheet. It does not. `ItemPatch` is only
`{ state, acknowledge_source_change }`, and a search of every `UPDATE work_items`
in the tree shows `amount`, `quantity`, `reference` and `title` are written by the
importer alone. Source values are already immutable through every route a person
can reach. The provenance rule was being kept; I misread it.

What is actually wrong is narrower and still real: **claiming is the only decision
the system makes.**

- Anyone who can *read* a row can claim it. There is no permission for it.
- A claim then carries the authority to **resolve**. Picking work up and closing it
  out are one gate, so there is no way to let somebody work a case without also
  letting them declare it finished.
- There is no way to **hand a case to somebody**. A leader cannot assign; a person
  can only take.
- A claim **never goes stale**. Somebody claims twelve rows on Friday and goes on
  leave, and those rows are held until a leader with MANAGE_RECORDS notices.
- `EDIT_WORK` had nothing to gate, because nothing about a row was editable at all —
  including the things that *should* be, like a due date on a case somebody typed
  by hand rather than imported.

**Fix:** split the verbs so each is a separate decision.

- **Claim** needs `CLAIM_WORK` and means *I am working this*, nothing more.
- **Resolve** needs `RESOLVE_WORK`. Working a case and closing it are different acts.
- **Assign and release** need `REASSIGN_WORK`, so work can be handed over rather than
  only taken, and a claim somebody is sitting on can be freed.
- **Edit** needs `EDIT_WORK`, and gets a real job: a hand-typed row's own fields become
  editable, while a row that came from a sheet keeps every source-derived value
  read-only for everyone. That turns a rule currently kept by accident — nothing
  offers the write — into one the server states and enforces.
- Claims go stale on a timer and release themselves.

## Finding 4 — nobody but the Instance Operator can create a unit

`server/services/org.ts:107`

```
} else if (!actor.is_operator) throw forbidden('Only the Instance Operator can create a new top-level organization.');
```

Sub-units need `MANAGE_UNITS` on the parent. Top-level units are operator-only. There is
no self-service path, and no invite-code join — members are enrolled by an admin.

The role machinery to support Discord-style spaces is *already here* and is good: 13
bitflag permissions, ordered role templates, `Fire Team Leader` among them, a unit owner
role. Only creation and joining are missing.

**Fix:** self-service unit creation behind a runtime setting (default on, so an enclave
deployment can switch it off), a per-user cap and a rate limit. Invite codes reuse the
existing `tokens` table with a new `unit_invite` kind: max uses, expiry, revocable.
Creating a unit makes you its owner; it confers nothing anywhere else. Unit owner is
still not Instance Operator.

## Finding 5 — there is no comment anywhere in the product

No table, no route, no component. Confirmed by search across `server/`, `shared/`, `src/`.

**Fix:** one `comments` table, polymorphic on `(record_table, record_id)` exactly like
attachments. **Visibility is inherited from the host record and can never widen it** — a
comment on a private task is private, full stop. `@` mentions raise a notification
through the table that already exists. Edit and delete your own; soft delete; audited.

## Finding 6 — password reset email works and was never switched on

The mailer is real and complete: Resend, SMTP, and a memory provider for tests, with
every send written to `email_log`. The reset flow issues a single-use 30-minute token,
revokes prior tokens, rate-limits by IP, and audits the request.

`server/config.ts:143`

```
const emailProvider = (env.VANTAGE_EMAIL_PROVIDER || 'none')
```

The default is `none`, and nothing on the running instance sets it. So the code runs, the
send is skipped, and `email_log` records `skipped / no provider`. **This is a
configuration gap, not a missing feature.** It needs `VANTAGE_EMAIL_PROVIDER`,
`VANTAGE_EMAIL_FROM` and a `RESEND_API_KEY` (or `SMTP_URL`) set on the deployment.

**Fix:** set the variables, make the Owner console say loudly when email is unconfigured,
add a test-send, and surface failed and bounced sends where someone will see them.

## Finding 7 — the support ticket system, and the one thing it will not do

A helpdesk queue is the right idea and does not exist yet. It will: a member raises a
ticket, it lands in a queue, whoever holds a new `VIEW_SUPPORT` permission works it,
messages thread, state is tracked, everything audited.

**It will not show anyone the contents of a password-reset email.** Those mails carry a
live single-use link; a reader of that link is one click from taking the account. Reading
them is account takeover with extra steps, and it would defeat the reset flow's own
security model.

What the ticket actually needs to be useful is the *delivery* fact, and that is safe to
show: which address it went to, when, and whether it sent, failed, bounced or was skipped
because email is off. `email_log` already stores exactly that — address, kind, subject,
status, error — and deliberately stores **no body**. That answers "why can this Marine not
get in" without handing anyone a key.

## Finding 8 — Report Studio ignores rank

`shared/evaluation.ts:17` is already correct:

```
if (match) return Number(match[1]) <= 4 ? 'jepes' : 'fitrep';
```

E-4 and below JEPES, E-5 and above FITREP. `buildReport` and `analytics` both call it
with the subject's grade. **Report Studio does not.**

`server/services/reportStudio.ts:74`

```
input.track === 'fitrep' ? 'fitrep' : 'jepes'
```

Any draft where the client did not explicitly pass `fitrep` is stored as JEPES —
including every draft for a Sergeant. That is the bug you are seeing.

**Fix:** derive the default from the subject's grade, keep an explicit override, and test
E-4 → JEPES, E-5 → FITREP, warrant and officer → FITREP.

---

## Order of work

Each phase ends green — server tests, browser tests, lint, typecheck, build — and ships
on its own. Later phases depend on earlier ones, so the order is not negotiable.

1. **Foundation.** Migration 007: `work_items.project_id`, real FK and index on
   `tasks.project_id`, `comments` table, `unit_invites`, `support_tickets`. New
   permission bits. Report Studio rank fix (small, independent, ships first).
2. **One work spine.** Unified list model and item detail; project opens onto its work,
   typed and imported together.
3. **Claim, split.** The four verbs, read-only source fields, stale-claim release.
4. **Comments** across tasks, projects, work items and records, with inherited visibility.
5. **Attachments** on tasks, projects and work items.
6. **Spaces.** Self-service units, invite codes, join flow.
7. **Email and tickets.** Configuration, the unconfigured-email warning, the support queue.

## Invariants that do not move

Carried from the existing product rules; the rebuild does not get to relax them.

- Authorization is decided server-side. A hidden button has decided nothing.
- A comment or file never widens the visibility of the record it hangs on.
- Owner and Operator do not automatically override privacy semantics.
- Source-derived values are never silently overwritten.
- Nothing summed across mixed units; record count is not productivity; no streaks.
- No secret, token or reset link in a log, a ticket, or an analytics event.
