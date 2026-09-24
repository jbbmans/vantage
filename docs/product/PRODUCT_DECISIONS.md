# Product decisions

Each entry records what was decided, why, and what would change the decision. Where the governing
contract resolved an earlier conflict, the entry says so. Major decisions are tested against four
questions: what value it delivers (believer), what harm or duplication it risks (skeptic), whether
the complexity is worth the adoption cost (investor), and the verdict (judge).

## PD-001 · The reference product is `jbbmans/vantage` `main`

**Decision.** The product to restore and improve is this repository at `ac51ce9` (Vantage 5.0.0).
**Why.** The restore brief names "old Vantage" as the reference and warns against the newest prototype.
The only repositories available are `jbbmans/vantage` and a private `jbbmans/vantage-main`. This one
holds the full Today/Work/Records/Goals/Career product the brief describes. The branch
`chatgpt-vantage-unified-preview` is a September 9 demo bundle built from v4.0. It was not used as a
reference. The rejected greenfield prototype is not in this repository.
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

## PD-009 · Drafts and career plans are the owner's alone

**Decision.** Accomplishment drafts and career steps have no visibility setting and no leader path.
Only the owner's session reaches them, including in exports. Drafts separate facts, which are cited to
events and not editable, from wording, which is editable and labelled template, AI, or the person's own.
Nothing is sent anywhere. "Keep in my record" adds a private activity.

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

## PD-016 · Four animation libraries, one job each

**Decision.** At the owner's request, Vantage uses GSAP, Anime.js, Motion and React Spring. Each has
one job (see DESIGN_SYSTEM → Motion): Motion for layout, React Spring for meters, GSAP for the
calculation timeline, Anime.js for check marks and stage pulses. They animate changes the person
made, never figures, and all four stop under reduced motion.
**Why.** The contract rules out excessive animation, so the libraries were given only the jobs that
explain a change. **Licences.** Motion, React Spring and Anime.js are MIT. GSAP 3.15 is under the
GreenSock "Standard No Charge" licence, which is free for commercial use but is not an OSI licence;
an enterprise licence review should list it.

## PD-017 · PostHog sees the synthetic demo only, and only the event catalog

**Decision.** `VANTAGE_POSTHOG_KEY` forwards rows from the existing first-party event catalog to
PostHog, from a demo instance only. Screen views become PostHog page views named by surface
(`/work_item`, `/workload`); procedure steps, stage moves, calculations, hand-offs and funds-check
refusals arrive as named events. Visitors are a keyed pseudonym of their demo workspace. Person
profiles and GeoIP are off, and requests come from the server, so no visitor IP reaches PostHog.
Config refuses the key in accounts mode. The demo banner tells visitors they are measured.
**Not done.** No PostHog script in the browser: no autocapture, heatmaps, session replay or
surveys. Contract §24 forbids replay and broad DOM telemetry, and keeps typed text, document
numbers and records out of usage telemetry. "Where visitors click" is answered at the level of
named screens and steps, not raw clicks.
**Owner decision needed.** Turning it on is the owner's call: it needs a PostHog project key, and it
sends demo usage to a third party. Anything beyond this scope (browser SDK, replay, real instances)
would be a change to the contract, not a configuration.

## PD-018 · A premium visual layer, written for Vantage

**Decision.** The owner asked for the app to look "extremely premium", with animation and effects
throughout, naming shadcn, React UI, the ui-ux-pro-max skill, Animaster, Skiper UI and Vengeance UI.
The result is an original premium layer (DESIGN_SYSTEM → Premium layer): an ambient light field,
glass chrome, a lit rail with a sliding pill, spotlight borders, sheen on primary actions, blur-in
titles, a hero on Today, beams on the next task, and live status dots. Brand palette, WCAG AA and
reduced motion are kept.
**What happened to each named source.**
- *Animaster Lib*: paid only, delivered through a Google Drive download. Not purchased.
- *Skiper UI*: its site refused connections from the build environment. Not used.
- *Vengeance UI, Magic UI (via the shadcn CLI), and the ui-ux-pro-max skill*: reachable and MIT
  licensed, but pulling their code into the repository or running their scripts was stopped by the
  agent's safety policy as third-party code integration. Nothing from them is in the codebase. The
  effects were written from scratch for this codebase instead.
- *shadcn*: the existing primitives already follow its architecture (Radix, Tailwind, `cn`). No
  `components.json` was added.
- *"React UI"*: read as React Bits. Not used, for the same reason as the registries.
**Owner decision needed.** If the owner wants any of those libraries' actual components, the owner
approves adding third-party UI code, and each component goes through licence and security review
before it lands.

