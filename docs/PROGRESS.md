# Progress

_Updated 2026-10-07_

## What changed (2026-10-07: Unit Instance data isolation)

The Unit Instance is enforced as a backend security boundary ([ADR-0008](engineering/ADR/0008-unit-instance-data-isolation.md)).

- **Where two units meet, both must be in one Unit Instance.** Member moves, direct enrollment and the
  enrollment directory, the primary unit, project links on entries, tasks and queue items, re-placing
  another Marine's record, thread contacts and thread links, importing a shared upload, a report
  revision's citations, a report or export asked for against another Marine's unit, and linking an
  EDIPI. Refusals carry the code `cross_instance`. A comment or file goes with its record only within
  the instance it was added in.
- **Someone who serves in two Unit Instances** works in each with the authority they hold there, and
  carries nothing, and no reference to anything, from one into the other.
- **Migration 016** adds triggers that refuse, in the database, a change to a unit's organization and a
  cross-instance project link, thread contact or thread link, from both ends. It changes no row; links
  already across are counted into `meta.instance_boundary_violations`. An engine refusal reaches the
  client as a 403 `cross_instance` and is written to the audit trail. An instance archive restores the
  same way: links it brings across are kept and counted.
- **Migration 017** records on each attachment the unit its record sat in when it was added, as comments
  already do, and fills it for existing files from their record's unit. It changes no other row.
- **PostgreSQL row-level security** is evaluated and deferred to the PostgreSQL adapter, with the policy
  written down in ADR-0008 (SQLite has no RLS; triggers are the equivalent here).
- **`tests/server/unitIsolation.test.ts`** proves it: two Unit Instances, a Marine in each, a leader with
  authority in both, and 23 cases across personnel, records and ids, attachments, reports, exports,
  metrics, imports, correspondence, Report Studio, membership, identity, archives, the audit trail and
  the triggers. Ten of them prove the ways across that the code and security reviews found.
- Two behaviors changed: a leader who founds a top-level unit of their own can no longer enrol a Marine
  they lead elsewhere into it directly (that Marine joins by invitation or join code), and an
  organization can no longer link the EDIPI of an account that also serves in another Unit Instance or
  runs the service (it links its own with its CAC).
- Left for later Tasks, as ADR-0008 records: shared-account governance (Task 3), and append-only audit
  with an external anchor (Task 7).

## What changed (2026-10-07: MCEN target, Unit Instances, deployment profiles)

Production targets MCEN, not the public internet ([ADR-0007](engineering/ADR/0007-mcen-enterprise-deployment-and-unit-instances.md), [deploy-mcen.md](deploy-mcen.md)).

- **Deployment profiles.** `VANTAGE_DEPLOYMENT_PROFILE` is `mcen`, `legacy-public` or `development`.
  - `mcen` refuses the legacy site's public-internet services and serves no public site.
  - `mcen` defaults to the DoD consent banner, with self-registration and browser backups off.
  - `mcen` holds self-registration and self-service Unit Instances off at runtime.
  - Unset in production means `legacy-public`, with a warning, so the Render site keeps running.
- **Topology.** `VANTAGE_TOPOLOGY=dedicated` limits a deployment to one Unit Instance, enforced by a
  temporary trigger on the database connection.
- **Provisioning.** `npm run provision-instance` provisions a Unit Instance and its first Unit Manager
  from a manifest. It runs as a named Vantage Administrator, is idempotent, and is audited.
- **Outbound connections.** Every outbound connection is listed in the admin dashboard's overview, with
  how MCEN treats it.
- **Naming.** The admin dashboard, the owner console, server messages and permission labels say Unit
  Instance. API paths, tables, audit action names and the export format are unchanged.
- **Open questions.** I-13 to I-22 are added to INFRASTRUCTURE_QUESTIONS.md.

## What changed (2026-10-07: one central service, three tiers of authority, two consoles)

Vantage is no longer installed per command. It runs as one service for many commands ([ADR-0006](engineering/ADR/0006-centralized-tenancy-and-authority.md)).

**Tenancy.**
- Organizations are tenants (`organizations`, `units.org_id`). Triggers keep every new unit in its parent's organization, make a top-level unit found one, and refuse a move between organizations.
- The roster feed, retention schedules, holds, disposition runs and the audit trail carry their organization. Audit entries seal it into the hash only when set, so older entries still verify.
- Migration `015_organizations` converts a single-instance database in place: each top-level unit becomes an organization, former operators become platform owners, and each organization's owner is its top unit's leader (the former operators where it had none). An instance archive from before organizations is adopted the same way on import.

**Authority** (`shared/permissions.ts`, `server/authz/scope.ts`).
- Platform roles (owner, admin, support, auditor) replace the Instance Operator flag, which is no longer read.
- Organization roles (owner, admin, records, auditor) hold only the structural unit bits, never record reading. Organization owners and admins staff any role below Unit Leader. An admin cannot give themselves a role that reads records; an owner who does is reported to the other owners.
- Vantage access (`server/services/access.ts`) is the only way staff see inside an organization: requested with a reason, approved by an owner (or notify-only, by the organization's choice), read-only, at most 24 hours, revocable, audited in both trails.
- Unit and organization roles can end on a date. Scope ignores an expired grant at once; a sweep every minute removes it and audits the end.
- "Why can they?" (`server/services/explain.ts`) lists every source of a person's permissions in each unit.
- One organization's roster extract cannot change or separate an account that belongs only to another. Separation ends that organization's memberships (restorable on return) and deactivates the account only when it belongs nowhere else.
- Direct enrollment of an account the enroller does not already lead is refused for everyone; people join by invitation or join code.
- CAC and OIDC roster provisioning seat the new account in the organization whose roster lists it.

**Two consoles, two APIs.**
- The admin dashboard (`admin.html`, `/admin`, `/api/platform`) is for Vantage staff. The owner console (`/console/:orgId`, `/api/orgs/:orgId`) is for an organization's owners, administrators, records officers and auditors.
- Each API answers only on its own face's host. `VANTAGE_ADMIN_URL` gives the dashboard a host of its own, and old `/operator?tab=` links land on whichever console now holds the tab.
- `/api/admin` and the account actions under `/api/org/team` are gone. Account resets moved to `/api/platform/accounts`.

**Tests.**
- `tests/server/tenancy.test.ts` covers tenant isolation, the access flow (approve, revoke, notify mode, expiry), organization-role staffing and self-grants, time-bound roles, the explainer, a roster scoped to its own people, and support's limits.
- The 015 migration is tested from a legacy-shaped database.
- `hosts.test.ts` covers an admin dashboard with a host of its own.
- Browser specs cover both consoles and the redirects between them.
- Existing tests now seat people through join codes or the service layer, since direct enrollment needs consent.


## What changed (2026-10-05: cradle to grave)

**One Marine through the whole lifecycle** (`tests/server/lifecycle.test.ts`). The test takes one Marine through eight stages in the real application, each building on the last:
1. joins by code, and the personnel feed sets their rank;
2. claims and verifies a case and keeps the draft, and Quick Logs;
3. the lead sees the counts, not the private entry;
4. JEPES input is written in Appendix E's form;
5. the feed promotes them to Sgt, and the same entries become MRO worksheet input;
6. they leave the unit: held work is released, and the record stays theirs;
7. they export their record, and the feed separates them;
8. nothing is disposed of by default, and the audit chain verifies.

Writing it confirmed two behaviours:
- the Marine who verifies is credited with the verification, and whoever resolves is credited with the resolution;
- leaving a unit ends the Marine's sessions.

## What changed (2026-10-05: FITREP, and the two open data bugs)

**FITREP input, checked against the form and the MARADMINs.** marines.mil refused this environment, so MCO 1610.7B was not read directly. The form (NAVMC 10835), the A-PES MRO worksheet as reproduced in an NPS thesis, the NPS FITREP bulletin and MARADMINs 308/23, 634/23, 575/24, 630/24, 066/26 and 209/26 (on a verbatim mirror) were. What changed:
- **The worksheet's form.** FITREP input is the MRO worksheet's: a Section C draft for its major accomplishments block, and its PME/self-education and Other blocks beside it (`shared/writer/worksheet.ts`, on Analysis and in the PDF).
  - **Section C** is one list of dash bullets with no headings, as the NPS bulletin writes it. It is ordered by the section each line gives evidence for, D to H. The studio shows the section beside each group; Copy and the PDF leave it out.
  - **Routing.** On FITREP, PME completions and Volunteer Service entries go to their own blocks instead of spending Section C's characters. They can still be kept in Section C.
- **One reading of the fourteen attributes** (`shared/writer/attributes.ts`), from the verb and then the words that name an attribute:
  - JEPES command input or FITREPs written are Evaluations, so Section H;
  - a course is PME;
  - "checked on", welfare and barracks are Ensuring Well-Being;
  - decisions are Decision Making Ability; recommendations are Judgment;
  - "no-notice" and "48-hour window" add Effectiveness Under Stress.
  An untagged FITREP entry sits in its attribute's section. Readiness coverage is counted from the same reading, replacing a keyword list that disagreed with the draft. Attribute names are as the form prints them ("Ensuring Well-Being of Subordinates", "Professional Military Education (PME)").
- **Section H.** It was missing from the writer: a Sgt's entry tagged Evaluation Responsibilities was reported as untagged and filed by its verb. It is now an area of its own. Readiness quotes the form ("serving as a reporting official") and treats H as applying only then.
- **Advice corrected:**
  - **PME.** "Complete resident PME for your grade" was shown to everyone, including Marines whose distance PME was complete. Readiness now asks for PME status when it is blank. When status is none, it quotes the PME attribute's baseline from the form. For a Sgt with distance PME, it cites MARADMIN 630/24: the distance program plus Sergeants School or its seminar.
  - **Section references.** The outcome advice named Section I (the reporting senior's comments); it now names Section C.
  - **Fitness.** Fitness scores are placed in Section A, item 8.
  - **Empty sections.** Five near-identical "nothing tagged" cards became one. Missing attributes come with what evidence for each looks like (labelled coaching).
- **Reporting period end.** When it is blank, Readiness says how annual periods end. It offers the date only where a MARADMIN confirms it (active Capt, Maj, LtCol, E-9: 634/23). The other grades follow MCO 1610.7B Appendix A, which was seen only in an excerpt.
- **JEPES citations kept to JEPES.** On FITREP input, holds for annual training and earlier awards no longer cite MCO 1616.1. The AI draft prompt follows the same form.
- **The demo's section lead (SSgt Diaz) has a FITREP record**, so the FITREP side can be explored.
- **Smaller fixes.** Today's readiness reminders link straight to `/career/readiness`. The PDF names its sections in each order's terms.

**The two open data bugs from the audit, fixed** (`docs/AUDIT-2026-10-03.md`):
- **Separated on first sighting.** A personnel extract that lists someone for the first time, already Separated, now turns off the active account their EDIPI is on, within the mass-separation guard. Those accounts count as active before the extract, and a held row is not written, so the next extract raises it again.
- **One document number, two reports.** An import row whose report shares under half its columns with the matched case's report is refused, not written over that case. The preview says how to bring both in. A re-export of the same report with a column added still updates. The import wizard can now key a sheet by a second column.

**Types.** The import wizard and the roster console are typed; explicit `any` in the client went from 212 to 186. Typing the wizard found telemetry that always reported 0 unmapped columns (it read `.length` off a number).

## What changed (2026-10-04: the narrative writer)

The JEPES and FITREP narrative is written by a new engine, `shared/writer/` (design and sources: `docs/product/NARRATIVE_WRITER.md`). The old builder headlined each area with a generic "Processed N things", pasted titles in strength order and cut what did not fit. The writer:

- **Writes in the order's own form.** JEPES input is MCO 1616.1 Appendix E's billet accomplishments: under the three command input lines (Individual Character; MOS and/or Mission Accomplishment; Leadership), a dash, a past-tense verb, the number and the result, acronyms spelled out once. FITREP input is a Section C draft by section, at Section C's 1,232 characters (NPS bulletin), objective and without superlatives. Paragraph form stays one click away.
- **Reads each entry.**
  - Tense ("Reconciling" becomes "Reconciled") and word order ("14 ULOs reconciled" becomes "Reconciled 14 ULOs") are put right.
  - First person, filler and praise adverbs go.
  - A noun phrase gets a plain verb ("Brief to the CO" becomes "Delivered brief to the CO").
  - "Helped" stays "Helped": a stronger verb would change the claim.
  - The entries themselves are untouched.
- **Weighs, groups and plans.**
  - Each entry is scored, with reasons.
  - Every area with work gets its best sentence first.
  - Several plans are tried, and the one that says the most within the limit is kept.
  - The same work is totalled when it would not all fit, or would repeat.
  - Totals account for counted work left out.
  - Case-history credit appears in its own sentence: "Researched 39 documents (2-Way UMT); recorded 66 verified outcomes and resolved 33 cases."
- **Holds back what the order excludes.** Required annual training is set aside with the rule, and can be kept anyway.
- **Never writes the reporting chain's judgments.** It writes no rankings, recommendations or word pictures. The reviewer flags them if typed.
- **Reviews its own writing.** A 100-point grade (areas, outcomes, numbers, openings, length) and findings, each naming the entries that would fix it and what it rests on: an order (MCO 1616.1, NAVMC 10835), guidance (NPS bulletin, Marine Corps Gazette) or style. "Helped" is marked as a preference, because no order forbids it.

**Tested against real typing.** Messy entries from four MOSs (motor transport, admin, infantry, supply) and a harsher batch found real faults, all now fixed and covered by tests:
- **No invented claims.**
  - A title with no verb is never given one ("Completed working on…" claimed something unfinished).
  - Work in progress is held until it is done.
  - Unknown past tenses read as verbs ("Licensed 8 Marines", "Drove in the convoy").
  - A verbless title with the Marine's own classification becomes "Reconciled 30 ULOs … in support of FY26 year-end close".
- **No double counting.** The same entry logged twice (same words, numbers and day) counts once and is held as "looks logged twice".
- **Held back by rule.** Awards for a previous period are held (Appendix E). So are entries still saying "I" or ranking the Marine.
- **Weak lines don't fill a slot.** A line like "Responsible for the armory keys" no longer fills an area just to fill it; the reviewer asks for real work instead.
- **Typing cleaned up:**
  - shouting capitals are set in sentence case, keeping acronyms ("ULOs");
  - a second sentence is joined to the first;
  - "!!!" and emoji are removed; output is plain ASCII;
  - number words become numerals ("twelve MIPRs" → "12 MIPRs");
  - "my degree" reads "degree";
  - "with a 3.8 GPA";
  - an outcome that only repeats the title is dropped;
  - no "(1 Marine)".

**One phrasing everywhere.** Quick Log's preview, an entry's page and the Bullets tab now use the writer, and Quick Log coaches with the reviewer's own notes as you type. The notes come most useful first: what is held back and why, then the outcome, a vague word, a weak opening.

The **narrative studio** on Analysis writes live in the browser:
- **Explains every sentence:** select one to see its sources, score, attribute and why it made the cut.
- **Lets the Marine shape it:** Always keep or Leave out, Another wording (never changes a figure), Best fit/Full/Compact, Bullets/Paragraph, length, and spell-out.
- **Edits by hand,** with a live review as you type.
- **Keeps what was left out** in a Left out list, held entries included.
- **The PDF takes the same choices,** or the edited text.

The optional AI draft is instructed with the same rules.

## What changed (2026-10-04: everyday use)

- **No empty October.** Activities, the JEPES/FITREP input page, Today's outcomes, a Marine's page and the goal metric list opened on the fiscal year, so on 1 October every one of them read as if nobody had done anything. They open on a rolling twelve months ("Last 12 months", a new period everywhere), and a saved choice still wins.
- **A tab bar on phones.** Today, Work, a log button and the Record sit at the bottom where a thumb reaches, with everything else behind More. It steps aside while someone types and while the drawer is open, and toasts and the footer clear it. The header's log button is for wider screens now.
- **Filters that fold.** On a phone the Activities filters sit behind one Filters button with a count, instead of six menus before the first entry. "JEPES" and "FITREP" keep their capitals in every label.
- **Due dates in words.** "Due 07 Oct 26 · tomorrow", "1 day overdue", "in 4 days" on Today, the queue and every case row.
- **⌘K does things.** Switch theme, keyboard shortcuts, import activities from a CSV, and download your record as a PDF, ranked above the catch-all "log this" when they match what was typed.
- **Undo after delete.** Tasks, projects, goals, training, awards, counselings and an entry's own page offer Undo, as the activity list already did.
- **Smaller things.** A case page is titled "Work / Case" (it said "Vantage"), and Quick Log drops the word that introduced a date ("…in DAI on Sep 30" no longer leaves "…in DAI on").
- **The bar follows the role.** Somebody who leads a team gets Team in the tab bar where a Marine gets the Record; the Record stays under More.
- **Titles read whole on a phone.** Case and task rows put the due date under the title instead of beside it, and a title may take two lines before it is cut. The queue's "All open work · Open to claim · Mine · Overdue · Resolved" is one row that scrolls sideways.
- **The demo banner is one line on a phone** ("Demo · Marine | Section lead · Start over"), giving back about half the first screen it took on every page.
- **Packages explain themselves.** Beside the list, four steps say what a package is (choose the period, write against the records, save a revision that re-reads them, export what was reviewed), and each package says when it last changed.
- **Undo after logging.** "Activity logged." carries Undo for the slip of a thumb; the entry goes to the recycle bin like any other delete.
- **Cards that read like headings.** Today's outcome cards say "Dollars reconciled" and "Hours logged" instead of "Dollars, Reconciled" and "hours". A unit or value type an owner named keeps its own wording and case.
- **Reminders that say how many.** The record card read "readiness fields incomplete"; it now reads "3 readiness fields incomplete · rifle qualification · MCMAP belt · PFT".
- **Time zones by place.** Settings lists "New York · EDT" and "Okinawa / Tokyo · GMT+9" instead of raw zone names.
- **What's new, in the app and on the site.** The user menu, ⌘K and the version in the footer open a dated list of the changes a Marine would notice (`src/config/changes.ts`). A small dot on the avatar marks it until it has been read, for people who were here before the latest change. The same list is a public page, `/changes`, prerendered, in the sitemap, and linked from the site's menu and footer.
- **⌘K forgives apostrophes.** "what's new" typed with a straight apostrophe finds "What’s new".
- **The plain-language pages are checked like the rest.** Security, privacy, accessibility and what's new now run through axe in the browser suite, and their bulleted lists show their bullets again (the CSS reset had removed them).
- **Goals know their pace.** A goal that builds over its period (increase or decrease) says "Ahead of pace", "On pace" or "Behind pace" against the share of its period gone, within ten points, with a tick on its bar where an even pace would be; a behind goal's bar turns amber, on the Goals page and on Today. It says nothing in the first tenth of a period, after it ends, once it is met, or for a threshold (a PFT score) or a completion goal (`goalPace` in `shared/metricEngine.ts`). The countdown reads "30 days left" rather than "(30d left)", and the figures read "21 of 30 UMTs" and "60 of 100% complete" instead of repeating the unit.
- **Tasks say who.** A Marine without the roster saw "→ Assigned from Assigned" on a task their section lead set. Task rows now carry the setter's and holder's names (only on rows the reader can already open, and never their own), so it reads "from SSgt Diaz". Titles take two lines on a phone and due dates say "tomorrow" or "in 3 days".
- **Projects and stat cards.** A project opens from its title (the stray "Open" link is gone), counts read "2 of 5 tasks done" or "No tasks yet", and its due date says how close it is. Stat cards let a label and a hint take two lines, so three across a phone read "Training hours" and "Awards in progress" instead of "Training ho…".
- **Steadier timing tests.** One full server run failed once, straight after a production build, and did not fail again in five more full runs. The likeliest cause was the speed tests added in the audit, whose budgets (50–400 ms) were tight for a busy machine. Each now has 10–30 times its usual time and still fails on the slowdowns it guards against: the Quick Log test uses 20,000 figures (30 ms linear, seconds if quadratic).
- **The roster fits a phone.** On a phone the six-column table left a name two words wide and the controls off the screen; it is a list now (name, billet · MOS · team, roles, and the same controls). Each "Open" names whom it opens, for a screen reader.
- **Each Team page says what it is for.** Workload, Roster, Unit dashboard, Roles, Units and Access log each have their own one-line lede instead of the overview's paragraph; the privacy promise stays on the overview and the roster.
- **Age of open work, said exactly.** "One to four weeks" counted 7 to 30 days; the rows now read "Under 7 days", "7 to 30 days" and "Over 30 days", each with a bar for its share, over 30 days in amber.
- **One way to write a date.** Today's "Who holds what" read "since 2026-09-05", a package's heading "2026-07-07 to 2026-10-04", and award, counseling, access-log, conflict and entry-history times used the browser's own format ("9/18/2026, 9:31:02 AM"). All now read the way the rest of Vantage does ("05 Sep 26", "28 Sep 26 1432").
- **Smaller things.** Drafts with nothing in them use the full width and offer "Open my work"; the unit dashboard no longer says "the rest need a result written" at 100%.
- **Quick Log hears the outcome.** "…in DAI on Sep 30, all cleared on the next report" used to leave Result empty and the preview asking "so what?". A closing clause that says what came of the work (after a comma, semicolon or dash, opening with "resulting in", "which", "so", "saving", "clearing", "all", "each", "zero", "no" and the like) fills Result and leaves the title, while a list such as "for G-8, S-4 and S-1" stays put (`parseQuickLog`'s `result`).
- **A bullet says a figure once.** A title that already named its amount ("$48,250", "$1.2 million") got it again at the end ("…, $48,250.00."); the bullet now compares the title's figures by value.
- **An entry's gaps are one tap from the fix.** On an entry's page each gap ("No quantity (how many?)") opens Edit, and a missing area reads "Untagged" there as it does in the list (it said "Unassigned" on one and "Untagged" on the other).
- **Smaller things.** Activities' delete is a trash icon named for its entry ("Delete Cleared 4 2-Way UMTs…") instead of an anonymous "×", and the Career cards (training hours, awards, counselings) open their tabs.
- **The narrative's opening line makes sense.** The JEPES/FITREP narrative opened "MISSION: Processed 10 km, 6 hours and 4 UMTs valued at $6K." Its headline now counts work products only ("Processed 4 UMTs valued at $6K."); a hike's kilometres, points and percentages are left to the sentences about those entries, and hours appear only when nothing countable was logged ("Completed 3 documented actions over 22 hours."). The PDF uses the same text.
- **Each package section says what it wants.** Every section's empty box said "Write what changed because of the work, in the units it was measured in.", Leadership and Individual character included. Mission, Leadership, Character, Intellect and Wisdom, and Evaluation responsibilities each have their own prompt.
- **⌘K's search box has no stray outline.** The global focus ring drew a hard rectangle into the palette's top edge; the caret and the highlighted result already show where focus is.

## What changed (2026-10-03 audit and upgrade)

A second outside review, of the live site and the code, found two high-severity security problems and fixed them:
an unauthenticated request that could freeze the server (an exponential password-policy pattern), and a goal "measured
across the unit" that let a member read entries they could not open. It also fixed four denial-of-service and
disclosure issues (workbook reader, email sanitizer, lockout name disclosure, rate limits behind Cloudflare), more
than twenty correctness bugs (among them FITREP packages losing every Quick Log entry, roster sync deactivating people
for good, Quick Log dating "Sep 30" as today), and the live site's broken pages. The public site gained security,
privacy and accessibility pages, `security.txt`, a hero and a "built for your role" section aimed at the Marines it is
for, and a real footer. Details, verification and what is left for the owner: `docs/AUDIT-2026-10-03.md`.

## What changed (2026-10-02 audit)

An outside review of the code, the running demo and the security model found the issues below; each is fixed
with a test unless noted.

**Bugs.** A workbook that understated its sizes expanded past its limit (239 KB to 240 MB); the real expanded
size is now charged. A case history whose seals were removed read as "unsealed" and passed the check; it now reads
as broken, and the check covers every case. The Record, contribution history and team workload treated local days
as UTC days, so work done after 8pm Eastern dropped out of today (and the test suite failed every evening); windows
now span the instants their days really cover. nodemailer carried five high-severity advisories; it is on 10.0.13.

**Accreditation controls.** 15-minute idle sessions (10 for owners) that a background poll cannot keep alive, with a
warning before sign-out; a lockout after three failures kept in the database; PBKDF2-HMAC-SHA256 password hashing
with scrypt hashes replaced at sign-in; the DoD Notice and Consent Banner, enforced on the server
(`VANTAGE_CONSENT_BANNER=dod`); CRL checking for direct-mode CAC, failing closed; clamd scanning of every upload
(attachments and email too), optionally refusing what could not be scanned; audit records sent off the host to a
syslog collector as they are committed; a rotatable `VANTAGE_SECRET`; browser backups that can be turned off and
that notify every other owner, plus `npm run backup` on the server; direct mail never connecting to private
addresses. See `docs/security.md` and `docs/operations.md`.

**Daily use.** ⌘K finds cases by document number; a Marine's Today opens on their own work; the queue shows cents,
whole titles, and overdue items with an Overdue filter; one date style throughout, with full timestamps in case
history; per-person time zones; the theme follows the device; shorter page headers; scroll cues on tab strips; and a
demo whose team view, Reports and Owner console show something.

**Engineering.** CI gates on `npm audit`, publishes a CycloneDX SBOM, scans the image with Trivy and runs CodeQL;
the base image is pinned by digest; versions are tagged on main; the hand-written parsers are fuzzed.

**Organization sign-in.** Entra ID (commercial, GCC High, DoD) or any OpenID Connect provider can sign people in:
code flow with PKCE, single-use hashed state and nonce, the ID token verified against the provider's keys, and the
account bound to the provider's subject. It can link by verified email or an EDIPI claim, create accounts for active
roster members, and be the only way in (`VANTAGE_OIDC_EXCLUSIVE`). See `docs/cac-and-records.md`.

**Types.** The case page, assigned work, team workload, the record stores, the roster, a member's page, the org and
roles now have one shared response type each, which the server's builders are checked against, so a change on one
side the other does not expect fails the typecheck. Doing so found a counseling list that offered "for <name>" from a
field the server never sent (it sends it now). Explicit `any` went from 323 to 221 (186 in the client by 2026-10-05) and cannot grow: `npm run lint`
fails when a directory holds more than its budget in `scripts/any-budget.json`.

**Still open.** PostgreSQL (and with it running more than one server process), SAML, and the remaining `any` in the
owner console's retention and privacy panels. Owner decisions outside the code are unchanged (below).

## Earlier (2026-09-25)

**The FMRA knowledge, in the product.** The FMRAC reference (the 3451 Financial Management Resource
Analyst course material) is encoded as a typed, cited knowledge base in `shared/fmra/`: the four
lifecycle phases, the seven purchase methods with their supporting documents, the normal conditions
(OCMT, UDOU, DOU, OTO) and their causes, abnormal conditions (feeder rejects, interface errors, invoice
holds, UMTs and their error classes), roles and separation of duties, the data elements, the glossary,
the discrepancies found in the source, and the answer format and "never" rules. Every statement is
cited and labelled source, editorial or discrepancy. It powers:

- **Reference** (a new destination): the desk reference, searchable from ⌘K, and a balance diagnoser
  that opens a case with the figures already recorded.
- **Eight FMRA procedures** alongside the 2-Way UMT (now v0.2.0 with the NON-1081 match step), on a
  generalized procedure engine: pinned versions with explicit, attributed migration; conditional
  branches; evidence gates shown before they refuse; not-shown figures; stale calculations; resolution
  only on a verified outcome.
- **The case page**, rebuilt around that engine: a lifecycle reading with the method's supporting
  documents, the procedure checklist, the current step's form, corrections that keep the original, the
  history's seal status, and (where AI is enabled) a case brief in the reference's answer order.
- **Imports** that apply a procedure (one, or chosen per row from the figures) and map the lifecycle
  columns; a queue filter and chip by procedure; Today's count of open work by procedure.
- **Tamper evidence**: every case history is sealed in a per-case HMAC chain with a signed head, and the
  day's heads are anchored in the audit chain. The Owner console's integrity check covers both.

**The interface, rebuilt on one design system.** Geist type, navy-tinted depth tokens, a navy rail,
spring motion, restyled primitives, dialogs, toasts, menus and command palette (six overlapping
stylesheets folded into one). A new public landing page and a split sign-in page. An update banner when
a newer build is published. See `docs/design/DESIGN_SYSTEM.md`.

**All sixteen recorded defects (F01–F16) closed**, each with a test:

| | Defect | Now |
|---|---|---|
| F01 | Legacy resolution bypassed the verification gate | Every path that resolves a procedure case answers to its resolution condition |
| F06 | Correcting an input left the old calculation standing | A calculation is marked stale, with the reason, once an input is corrected or re-read |
| F12 | Append-only history was not tamper evidence | Per-case HMAC chain with signed heads, anchored daily in the audit chain |
| F13 | The stored procedure version did not select the definition run | A case runs the version it is pinned to; moving it is explicit and attributed |
| F14 | Reimported source changes did not reach the case history | A `source_revised` event records what changed; seeded values are superseded, research is untouched |
| F16 | The service worker's version was maintained by hand | The build stamps its own hash into the worker and `/api/health` |
| F02 | Leaving a unit left claimed-work access | Access to shared work follows current membership only; leaving releases held work, with the reason in each case's history |
| F03 | Private case activity in shared totals | Every unit total and member breakdown counts only live, unit-visible work of that unit |
| F04 | Corrected verifications still counted | A verified outcome counts only while it stands and is not overtaken; verification actions are counted separately |
| F05 | A claim alone could become an accomplishment | A draft needs substantive facts; an empty draft cannot be saved |
| F07 | Automatic cleanup bypassed legal holds | The recycle-bin purge and source pruning read the same holds and write disposition evidence |
| F08 | Mailbox sign-in stopped before a token | OAuth code flow with PKCE per national cloud, bound to the person and the mailbox, read-only enforced, tokens encrypted and renewed, failures visible, and an honest notice when unconfigured |
| F09 | Case facts did not feed metrics | A saved draft links its case, cites each fact, counts once, and credits money only for a resolved outcome the person verified |
| F10 | Mutations left views stale | One invalidation map by kind of change |
| F11 | Failures looked like emptiness or denial | Offline, signed out, denied, missing and server errors are told apart, with retry |
| F15 | A red commit could deploy | `autoDeployTrigger: checksPass`, and the browser suite passes |

**The films, made in code** (`film/`, `npm run film`). A 90-second hero film for the public page and
six narrated chapters for the field guide (Quick Log, working a case, reading a balance, the Record,
Report Studio, leading a section), recorded on the real application in the synthetic demo. One script
drives the narration (ElevenLabs, cached), the timing, the captions, the capture (Playwright on a
virtual clock, synced to the narrator's words), the picture (Remotion) and an original synthesised
score, mixed to −14 LUFS. A film is published to the landing page and field guide only when all its
narration is recorded voice. Making them surfaced and fixed four product defects: the case history's
doubled verbs, a doubled full stop in the figures' reading, "1 quantity" where Quick Log had read "30
ULOs", and a case opened from the diagnoser that its opener did not hold.

**Hardening.** CORP, Origin-Agent-Cluster and related headers; `upgrade-insecure-requests` in
production; null-prototype registries for anything looked up by a request's key; every table declared
in the privacy inventory; the financial answering rules on every AI prompt.

## Verification

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (server, web, browser tests) | clean |
| `npm test` (server suite, in-memory SQLite) | **607 / 607 pass** (2026-10-05) |
| `npm run test:browser` (Playwright, Chromium, built client) | **104 / 104 pass** (2026-10-05) |
| Accessibility | axe: no serious or critical violations in either theme on every core page, the case page, the Reference, the public page and the security, privacy, accessibility and changes pages |
| `npm audit` | 0 vulnerabilities |

### Not verified

- A live Microsoft tenant. The mailbox flow and organization sign-in are tested end to end against local stand-ins
  for Microsoft and an OIDC provider; a real Entra registration in GCC High or DoD has not been exercised.
- The FMRA procedures against a current SOP or an SME. They are labelled "formal training reference,
  not verified against current policy", and screen paths are left undocumented until confirmed.
- PostgreSQL, Windows Server, a real CAC (revocation is tested with a fixture CA and CRL), a real clamd (tested against
  a stand-in speaking its protocol), a real SIEM, a restricted-network host, backup and restore drills.

## Owner decisions

1. The FMRAC reference content is committed to this public repository at the owner's instruction,
   although the source is marked for the DoD community. The public landing page describes the FMRA
   features at feature level only; the reference itself is inside the signed-in application.
2. The old walkthrough recordings stay unpublished (`91566f1`). They are replaced by the films above,
   which publish only once narrated; until then the landing page shows no player, and its test checks
   that no empty player is shown (and, once published, that every film loads).

## Next actions

1. Walk an FMRA through the diagnoser and one procedure of each family, and correct the step wording
   and screen paths from what they say.
2. Register a Microsoft Entra application in the target cloud and run one real mailbox sign-in and one real
   organization sign-in (`VANTAGE_OIDC_ISSUER`).
3. The films are published without narration, at the owner's request (score, sound and captions,
   which play by default; `voiced: false` in `src/config/films.generated.json`). To add the voice: put
   `ELEVENLABS_API_KEY` in the environment's settings and run `npm run film`, which voices the script,
   re-times and re-captures every scene to the real delivery, and republishes (film/README.md).
4. Protect `main` in GitHub with the three CI checks required (see `docs/deploy-render.md`).
