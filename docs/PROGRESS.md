# Progress

_Updated 2026-10-04_

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
field the server never sent (it sends it now). Explicit `any` went from 323 to 221 and cannot grow: `npm run lint`
fails when a directory holds more than its budget in `scripts/any-budget.json`.

**Still open.** PostgreSQL (and with it running more than one server process), SAML, and the remaining `any` in the
owner console and import screens. Owner decisions outside the code are unchanged (below).

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
| `npm test` (server suite, in-memory SQLite) | **570 / 570 pass** (2026-10-04) |
| `npm run test:browser` (Playwright, Chromium, built client) | **102 / 102 pass** (2026-10-04) |
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
