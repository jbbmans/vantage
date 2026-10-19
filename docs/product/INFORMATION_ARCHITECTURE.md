# Information architecture

The menu is the specification's top-level structure (VANTAGE_CLAUDE_MASTER.md, Task 10), defined once in
`src/config/nav.ts` and decided in [ADR-0016](../engineering/ADR/0016-information-architecture.md). The rail, the
phone drawer, the tab bar, ⌘K, the G-key shortcuts, the shortcuts dialog, the header, the document title, each
page's eyebrow and every sentence that names a place read it from there.

| Destination | Question it answers | Pages | Route |
|---|---|---|---|
| **Today** (D) | What do I need to do, what am I waiting on, what changed, what can I quickly record? | Leader: your section (unassigned, overdue, blocked, waiting; needs a decision; who holds what). Everyone: your work with next steps; waiting on someone else; open to claim; quick capture; since you last looked; record and development; outcomes you logged | `/` |
| **Work** (W) | What work exists, what is mine, what can I claim, where does it stand? | Queue, Tasks, Projects, Correspondence, Reference (F) | `/work/…`, `/reference` |
| Work item | What is this, what happened, what comes next? | Header with stage and holder; next step with help and a form for that step; candidate calculation; add any entry; history; procedure checklist; who worked this; source; correspondence | `/work/items/:id` |
| **Records** (R) | What have I done, and what backs it up? | Overview, Timeline, Activities, Awards, Counseling, Drafts, Contributions | `/record/…`, `/career/awards`, `/career/counseling`, `/records/:id` |
| **Personnel** (T, leaders) | Who is in my units, and what do they hold? | Overview, Roster, Workload; a member's page | `/team`, `/team/roster`, `/team/workload`, `/team/:id` |
| **Training & Development** (C) | Where am I headed, and what have I completed toward it? | Training, Career plan, Goals (G), Readiness, MARADMINs (M, when enabled) | `/career/…`, `/goals`, `/maradmins` |
| **Reports & Analytics** (P) | What evaluation input do the records give, and what do they show? | Packages, Analysis, Unit dashboard (leaders) | `/reports`, `/reports/analysis`, `/team/dashboard` |
| **Administration** (A) | Who may do what, and who opened what? | Invitations, Roles, Units, Access log, Unit Manager console (O), Vantage Administrator console | `/team/…`, `/console`, `/admin` |
| Help (H, at the foot) | How does Vantage work, and who can I ask? | Field guide (opens with Find your way), Support | `/help`, `/support` |
| Settings (S, at the foot) | My profile, security, appearance, digest and data | Profile, Security, Appearance, Weekly digest, Your data | `/settings` |

A group appears only with a page the person may open; the server authorizes every page's data regardless.

## Placement rules

- **A page sits in the group that answers its question, and keeps its address when it moves** (ADR-0016). The
  header, the eyebrow and the title say where it is.
- **A page is headed with its menu label**, or that label made specific to the person ("Your record", "JEPES
  readiness"), never a slogan. Its eyebrow is its group, with the unit or view on unit pages.
- **A sentence that names a place uses `placeName()`**, never a hand-written "under Career".
- **Records are what happened; Training & Development is where you are headed.** Awards and counseling are records;
  training sits with the career plan, goals and readiness it feeds.
- **Administration holds who may do what**, both consoles included. A leader's view of people and workload lives in
  Personnel and on their Today, never only in a console.
- Research belongs inside the work item, not in a separate research area.
- **Import belongs beside what it fills** (Import activities on Activities, Import work on the Queue), and export
  beside what it takes out. Both are in ⌘K too.
- Procedure help sits under the step it explains, behind "How to do this".
- Quick capture ("Log activity") is available from every screen (header pill, tab bar and `N`) and on Today.
- **Secondary controls fold.** On Activities, search, period and layout stay; the other filters fold behind
  "Filters" with a count, and open when a link sets one.

## Where a new user finds each thing (section 16)

Help → Field guide opens with these answers, linked to the pages this person may open.

| Question | Answer |
|---|---|
| What is Vantage? | One place for your work, records and training, turned into evaluation input you can cite |
| What to do today | Today |
| Where work lives | Work → Queue, Work → Tasks |
| Where records live | Records → Overview, Records → Timeline |
| Where training lives | Training & Development → Training, and → Readiness |
| Where personnel live | Personnel → Roster, and → Workload, when the person leads a unit or holds a role that sees its members |
| How to record | N or Log activity anywhere; New award, New training and New counseling on their pages |
| How to import | Import activities (Records → Activities); Import work (Work → Queue) |
| How to export | Export activities; Export analysis PDF and Export JEPES input PDF (Reports & Analytics → Analysis); Settings → Your data |
| How to view performance | Reports & Analytics → Analysis; Training & Development → Readiness; the Unit dashboard for leaders |
| How to view duty | Logged as an activity and filed under Operations; Activities filtered to Operations, and the Timeline (duty records are Task 17) |
| How to find help | Help → Field guide, ⌘K or /, ? for shortcuts, Help → Support |

## Audit (2026-10-19, desktop 1440px and phone 390px, every page in the menu)

| Area | Found | Done in Task 10 | Left, and to which Task |
|---|---|---|---|
| Navigation | Seven groups unlike the specification's; awards and counseling under Career; Goals under Record; Team mixing people, figures and administration; Knowledge a catch-all; consoles in the footer; a console's name cut off in the rail | The specification's groups; pages placed by question; consoles under Administration with an outward arrow; long labels wrap | — |
| Naming | Headings unlike the menu: "Targets", a slogan on Reference, every Team page headed "G8", "How Vantage works", "Ask a person" | Heading = menu label, eyebrow = group | — |
| Common actions | Five names for the quick capture; "New entry" opening "New activity"; "Log training", "Track an award", "Record counseling"; "CSV", "Import CSV", "Import a spreadsheet", "Analysis PDF", "Export PDF" | Log activity; New …; Import … and Export … naming what moves; all in ⌘K | Import and export themselves: Task 13 |
| Copy | "Under Career" six times; Help's keys listed J, which no longer existed | `placeName()`; Help's keys and the shortcuts dialog read from the menu the person has | — |
| Filters | Six controls in a row on Activities on a desk | Folded behind Filters with a count | — |
| Forms and modals | A create dialog titled differently from the button that opened it | Button and dialog share the "New …" name | The NAVMC 2795 counseling form: Task 20 |
| Cards and dashboards | Today and the Records overview each answer one question; Packages and Analysis overlap (both read the record for evaluation input) | Left in place, named consistently | Reports and printable output: Task 14; unified analytics: Task 21 |
| Tables | Wide tables scroll inside their card; no page scrolled sideways at 390px except Help, after its keyboard line grew | Help's keyboard line fixed | Personnel tables: Task 11; performance and responsive pass: Task 25 |
| Duplicate workflows | Two ways in for awards and training (an activity, or its own record) | Settled by Task 9's move suggestions; Find your way points to the right place | — |
| Discoverability | Nothing told a new user where things are, how to import or export, or where duty is | Find your way; Getting started links to it | Tutorials: Task 26; duty records: Task 17; drafts: Task 23 |

## Retired paths

`/queue`, `/correspondence`, `/studio`, `/activities`, `/records`, `/readiness`, `/assist`, and the old `?tab=` forms
of `/work`, `/record`, `/career`, `/reports` and `/team` redirect to their current pages and keep their query string
(`MOVED`, `TABS` and `movedTo` in `src/config/nav.ts`). Task 10 moved no address.
