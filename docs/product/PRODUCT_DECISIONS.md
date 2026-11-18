# Product decisions

Each entry records what was decided, why, and what would change the decision. Where the governing
contract resolved an earlier conflict, the entry says so. Major decisions are tested against four
questions: what value it delivers (believer), what harm or duplication it risks (skeptic), whether
the complexity is worth the adoption cost (investor), and the verdict (judge).

## PD-001 · The reference product is `jbbmans/vantage` `main`

**Decision.** The product to restore and improve is this repository at `ac51ce9` (Vantage 5.0.0).
**Why.** The restore brief names "old Vantage" as the reference and warns against the newest prototype.
The only repositories available are `jbbmans/vantage` and a private `jbbmans/vantage-main`. This one
holds the full Today/Work/Records/Goals/Career product the brief describes. A September 9 demo bundle built from v4.0
was not used as a reference. The rejected greenfield prototype is not in this repository.
**Open.** The owner has not yet confirmed this reference. If a different commit, repository or set of
screenshots is the preferred product, the parity checklist is re-run against it.

## PD-002 · Five primary destinations; nothing removed to get there

**Decision.** TODAY · WORK · RECORD · GOALS · CAREER, then Team for people who lead, then Reports,
MARADMINs, Settings and the Field guide under More.
**Why.** Simplicity means each destination answers one question. Counting links is not the measure.
Readiness belongs to where you stand (Career), and activities to what you did (Record). Every old path
redirects, carrying its query.
**Skeptic.** Moving Readiness and activities one level down costs one click for people who used them
daily. **Judge.** BUILD. The tabs are one click, and Today surfaces readiness gaps directly.

## PD-003 · "Record", not "Records"

**Decision.** The destination is Record, a person's record. The activity list inside it is "Your entries".
**Why.** The contract names it; and "Records" read as a database table, not as something that is yours.

## PD-004 · Claiming is not credit, and one document is one document

**Decision.** Claiming puts work on the assigned list at once and writes a `claimed` event. It
contributes nothing to any count. Contributions are counted from the events a person authored. A
document counts once however many entries or stages it has. Section totals count distinct documents,
so individual totals can add to more than the section.
**Why.** The contract's measurement rules. Counting stage moves or claims as work inflates credit and
rewards the wrong thing.

## PD-005 · An append-only case history

**Decision.** Every change to who holds work and where it stands writes an event in the same
transaction. Corrections are new events that supersede old ones. The database refuses UPDATE and
DELETE on `work_events`, except in a database created for the synthetic demo.
**Why.** "Who performed which action, when, why, and with what supporting reference" must survive
handoffs and stage changes. **Limit.** Someone with direct database access can drop the trigger. The
guarantee holds against the application, not against a database administrator. See SECURITY_MODEL.

## PD-006 · Stages are explicit; waiting is time, never work

**Decision.** Stages are: not started, researching, ready for action, submitted, waiting (with a
category), blocked (with a reason), verification required, resolved, and not applicable. The old
coarse `state` is kept in step so every filter still works. Waiting intervals are recorded as start
and end events and shown as elapsed calendar time, labelled as such, and never added to anything.
No "active time" is estimated.

## PD-007 · The first financial procedure is labelled for what it is

**Decision.** The 2-Way UMT procedure is marked "SME walkthrough, not yet validated". It lists its
limitations beside it, and no system screen path is published until an SME confirms one. The
calculation is a candidate with every input cited. The analyst makes the funding decision and must
say why. Upward, zero and downward describe direction only. Zero and downward always require review.
**Why.** Contract §§14–16. Guessed rules in code look authoritative.

## PD-008 · Controls that cannot be talked past

**Decision.** A FAILED, NOT_RUN or UNKNOWN funds check, or none at all, refuses the submission. A
WARNING requires a written acknowledgement, which is stored with the submission. A procedure case
resolves only after the original condition is verified cleared with a reference. A verified result
without a reference is refused.
**Open.** Whether WARNING should be passable at all is SME question Q-11.

## PD-009 · Drafts live with their kind; saved forms, entries from work and career plans are the owner's alone

**Decision.** A draft lives with its own kind (ADR-0030):
- a counseling in its draft or review stage;
- a report package;
- unsent correspondence;
- an entry drawn from work;
- a saved form: a goal, award, training entry, task or personnel change saved to finish later.

Records → Drafts reads them all and stores nothing.

**Private to their owner.** Saved forms, entries from work and career steps have no visibility setting and no leader
path. Only the owner's session reaches them, and anyone else gets 404. A saved award recommendation or personnel change
names its Marine. That Marine never sees it and is not told of it until it is added. The author's own export includes
their saved forms about nobody else.

**Shared by their kind's rules.** A counseling shared for review, a report package about a Marine or shared with a unit,
and correspondence shared with a unit are read by whoever their kind lets read them. The Drafts page says so on each.

**Entries from work** separate facts, which are cited to events and not editable, from wording, which is editable and
labelled template, AI, or the person's own. Nothing is sent anywhere. "Keep in my record" adds a private activity.

## PD-010 · The synthetic demo opens without a sign-in form, and nothing else changes for it

**Decision.** `VANTAGE_ACCESS_MODE=demo` gives each visitor a disposable workspace of synthetic
people and lands them on Today. Protected APIs still require a session, and the demo session belongs
to a synthetic person. Refusals:
- production mode;
- a database that holds real accounts, and an accounts server started on a demo database;
- CAC, email, AI and the MARADMIN feed;
- the sign-in, administration and cross-workspace routes.

Workspaces expire after 24 hours by default and are removed whole.
**Why.** The owner asked for the sign-in step to be removed from the demonstration. The contract
forbids doing that by weakening protected APIs, falling back to a real identity, or making a host
public.
**Skeptic.** A second mode is a second thing to secure. **Judge.** BUILD. The mode is refused
everywhere real data could be, and the isolation is tested.

## PD-011 · Remove Google Tag Manager

**Decision.** Removed from the page, the CSP and the 404 page. The test that required it now forbids it.
**Why.** Contract §24: no GTM, no third-party analytics, no public egress from the page. This reverses
an earlier owner decision (`b195eab`).

## PD-012 · Remove keystroke-derived activity timing

**Decision.** Report Studio no longer measures time between keystrokes, and the server no longer
accepts that field.
**Why.** Contract §§12 and 24: no keystroke monitoring. Form-open time and the duration a person
confirms stay, reported separately.

## PD-013 · MARADMIN feed off by default

**Decision.** `VANTAGE_MARADMIN_ENABLED` defaults to false.
**Why.** It is the only outbound request the core makes. The product must work with public egress
blocked. An operator can turn it on where that egress is approved.

## PD-014 · Keep the visual identity; change the hierarchy

**Decision.** The navy rail, Glacier canvas, Cobalt primary action, Inter type, cards and badges stay.
What changed is what each screen puts first. **Status.** Awaiting owner review of the real running
screens (`docs/demo/BOARD_DEMO.md`). This is not yet an approved visual direction.

## PD-015 · SQLite stays for this slice; PostgreSQL is the production target

**Decision.** This slice ships on the existing SQLite layer. PostgreSQL work is planned, not done.
See ADR-0003 and MIGRATION_PLAN.
**Why.** Every service is written against a synchronous SQLite API. Moving to PostgreSQL is a rewrite
of the data layer, and it should follow the owner accepting the experience rather than precede it.

## PD-016 · Workflow messages and notices: what is said lives on the record

**Decision.** There is no chat (ADR-0031). What is said is said on the record or work case it is about: a comment, a
question or a review request to one named person, its answer, or the note an assignment carries. A notice names the
event and who did it, and is shown only while its person may still open the record. These are defaults John can change,
without a decision card:
- **Notices never quote what was written.** A comment, a question, a note or a reason is read on the record, behind its
  permissions. The exceptions are notices about no record: a leader's team message, a MARADMIN's number and title, a
  suspension or withheld-feature reason, and operations notes.
- **Discussion, Work updates and Announcements can be turned off;** the rest always arrive: what is asked of you,
  decisions on your records (with what your counselor or Marine says on a counseling), mentions, your unit, security
  and operations.
- **Notices are kept 180 days,** read or not, unless a legal hold keeps them.
- **Comments said on a counseling before it was final stay between its counselor and its Marine,** after it is final
  too.
- **At most 10 people are named in one message.** More is refused, never cut.
- **A work case takes questions and review requests, but no free comments.** Its notes stay in its sealed history.

**Why.** The specification asks for workflow communication (comments, mentions, review and clarification requests,
return for correction, approval and rejection notes, assignment notes), not generic chat, and for notices of meaningful
state changes without spam, within Unit Instance and record permissions. Keeping the words on the record keeps them
behind its permissions and lets a retention schedule clear them.
**Skeptic.** Notices without words are less useful at a glance, and three groups that can be turned off may hide
something a person wanted. **Judge.** BUILD. A notice opens the record in one click, a comment's notices coalesce into
one per record, and nothing anyone is asked to do can be turned off.

## PD-017 · Performance and accessibility defaults

**Decision.** Vantage stays fast at MCEN scale by paging and indexing, and meets WCAG 2.2 AA at 320 to 1280 px
(ADR-0032). These are defaults John can change, without a decision card:
- **Reports show 200 rows** before "Show more" (print shows every row); **the dashboard shows 25 members** before
  "Show all"; **audit logs load 100 entries** at a time for your own and 200 for a unit's log or an audit trail.
- **Files still stop at 5,000 rows** (ADR-0020), and now say so in the file.
- **The audit chain status on a trail's first page may be up to 60 s old;** the integrity check run on purpose is fresh.
- **Single-key shortcuts are on** by default; anyone can turn them off in Settings, Appearance.

**Why.** The specification asks for pagination, indexing, efficient queries and lazy loading on the six heaviest areas,
and for WCAG 2.2 AA tested with Playwright and axe. **Skeptic.** "Show more" adds a click, and a 60-second-old chain
status could miss a break for a minute. **Judge.** BUILD. Nothing is hidden without saying so, and a break is still
found by every explicit check and by the next first page.

## PD-018 · Tutorials: offered where the task is, never opened by themselves

**Decision.** Twelve short tutorials, one task each, with the names the specification gives (ADR-0034). These are
defaults John can change, without a decision card:
- **Nothing opens by itself.** A page offers its tutorial in one line under its title; Help → Field guide, its search
  and ⌘K list them all; Today's Getting started card links to the first.
- **The line under titles is on by default,** and anyone can turn it off in Settings → Appearance → Tutorials.
- **A finished tutorial is marked** wherever it is offered, on every device (it is kept with the person's settings), and
  can be taken again.
- **The films stay,** each saying it was recorded before the current look; the tutorials follow the build.
- **A step is offered only to those it is for:** a counselor's steps to counselors, a reviewer's to reviewers. The server
  still decides every action.

**Why.** The specification asks for short task-based tutorials and contextual guidance over one giant walkthrough.
**Skeptic.** A line under every title is one more thing on the page, and a tutorial that never opens may never be found.
**Judge.** BUILD. The line is one short row that names the task, it can be turned off, and the Field guide and search
still find every tutorial.

## PD-019 · The trailer: the ten outcomes, in place of the ad and the tour

**Decision.** One trailer of the specification's ten outcomes, recorded on the product as it ships (ADR-0036). These
are defaults John can change, without a decision card:
- **It replaces the ad and the tour.** Both showed the earlier look and an earlier product, and the tour closed on a
  pitch for running Vantage "on your own network". Bringing either back is a revert.
- **Ten outcomes, in the specification's order,** each one take from the synthetic demo, then a close on who governs a
  Unit Instance. About 100 seconds, no narration; what it says is listed under the player.
- **No address, price or sign-up.** "Demo data" stays on screen while the application is, and the end card says
  synthetic demo data, not an official DoD or USMC system of record.
- **The thirteen chapters stay** as they are, marked as recorded before the current look.
- **The demo scores duty,** under one scoring version the section lead published 120 days back, so Duty can be shown.

**Why.** The specification asks for a trailer of the actual final product, focused on outcomes, that does not portray
Vantage as a public SaaS site.
**Skeptic.** The public page loses one of its two films, and a trailer ages as the product changes.
**Judge.** BUILD. The trailer shows everything the two films did and the outcomes they never reached, one command
rebuilds it from the demo, and a test holds it to the ten outcomes and to that wording.
