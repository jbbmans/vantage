# ADR-0016 · Information architecture: one menu in the specification's structure, and pages that keep their address

**Status:** accepted · **Date:** 2026-10-19 · **Builds on:** [ADR-0010](0010-vantage-administrator-and-unit-manager.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0015](0015-core-record-architecture.md)

## Context

Task 10 of the governing specification (VANTAGE_CLAUDE_MASTER.md) is the UX and information architecture redesign,
at P0. It asks Vantage to be easier to understand: audit navigation, cards, forms, tables, modals, dashboards,
filters, naming and duplicate workflows; consider a top level of Today, Work, Records, Personnel, Training /
Development, Reports / Analytics and Administration; use progressive disclosure; standardize common actions;
preserve keyboard efficiency; and test accessibility and responsive behaviour. Section 16's UX definition of done
lists twelve things a new user should be able to tell quickly, from what Vantage is to how to find help.

What main held before this Task (at `15e37d0`):

- **One menu config already drove everything.** `src/config/nav.ts` fed the rail, the phone drawer, the tab bar,
  ⌘K, the G-key shortcuts, the header breadcrumb and the document title. Old addresses already redirected through
  `MOVED`, `TABS` and `movedTo`.
- **Seven groups that did not match the specification:** Today, Work, Record (with Goals), Career (with Awards and
  Counseling), Reports, Team (eight pages mixing people, figures and administration) and Knowledge (Reference,
  MARADMINs, the field guide and support), with Settings and both consoles in the footer.
- **`groupFor` resolved by URL prefix.** A page could not change group without changing its address.
- **Headings disagreed with the menu.** Goals was headed "Targets"; Reference "Know what the balance is telling
  you."; every Team page the unit's short name ("G8"); the field guide "How Vantage works"; Support "Ask a person".
- **One action had many names.** The quick capture was "Log activity", "Log an activity", "Log what you did",
  "Capture it" and "Log one"; creating was "New entry" (which opened "New activity"), "Log training", "Track an
  award" and "Record counseling"; moving data in and out was "Import CSV", "Import a spreadsheet", "Export CSV",
  "CSV", "Analysis PDF" and "Export PDF".
- **Copy named places by hand.** Six sentences said "under Career", and Help's shortcut line listed a key (J) that no
  longer existed.
- **The shortcuts dialog listed every key,** including consoles and pages the person could not open.
- **Activities showed six filter controls in a row** on a desk; a phone already folded them.
- **Nothing told a new user** where things live, how to import or export, or where duty is.

## Decision

### 1. The menu follows the specification's structure

`GROUPS` in `src/config/nav.ts`, in this order:

| Group | Key | Pages | Who sees it |
| --- | --- | --- | --- |
| Today | D | (one page) | everyone |
| Work | W | Queue, Tasks, Projects, Correspondence, Reference (F) | everyone |
| Records | R | Overview, Timeline, Activities, Awards, Counseling, Drafts, Contributions | everyone |
| Personnel | T | Overview, Roster, Workload | unit members whose view holds those sections |
| Training & Development | C | Training, Career plan, Goals (G), Readiness, MARADMINs (M) | everyone; MARADMINs when enabled |
| Reports & Analytics | P | Packages, Analysis, Unit dashboard | everyone; Unit dashboard by section |
| Administration | A | Invitations, Roles, Units, Access log, Unit Manager console (O), Vantage Administrator console | by section, role or staff role |
| Help (at the foot) | H | Field guide, Support | everyone; Support outside the demo |
| Settings (at the foot) | S | (one page) | everyone |

- **A page sits in the group that answers its question.** Awards and Counseling are records, so they are under
  Records; Training sits with the career plan, goals and readiness; Reference is what work is done from; the unit
  dashboard is analytics; invitations, roles, units, the access log and both consoles are administration.
- **A group a person cannot use does not appear.** `useNav()` (`src/lib/useNav.ts`) filters groups and pages by the
  same requirements as before (`unit`, `orgRole`, `staff`, `maradmins`, `team`, `demo`, `notDemo`). What it hides is
  presentation; every page's data is still authorized by the server, as ADR-0008 and ADR-0013 require.
- **The consoles are marked as leaving.** A console is an application of its own, so its link carries an outward
  arrow (`away`).
- **Long labels wrap in the rail** instead of being cut short.

### 2. A page keeps its address when it changes group

- `/career/awards` is Records → Awards, and `/team/dashboard` is Reports & Analytics → Unit dashboard. Addresses sit
  in notifications, emails, the audit trail, bookmarks and other Tasks' tests; renaming them buys nothing a reader
  sees, because the header, the title, the eyebrow and the menu all say where a page is.
- `groupFor(pathname)` now resolves by the page that owns the path (`pageFor`, longest match, honouring `end`) and
  falls back to a group's `also` prefixes for detail pages (`/work/items/…` under Work, `/records/…` under Records,
  a member's page `/team/:id` under Personnel).
- `MOVED`, `TABS` and `movedTo` are unchanged, so every old address still lands where it did.
- **Shortcuts keep their letters.** D, W, R, G, P, T, F, M, H, S and O open what they opened; T now names Personnel.
  A group's letter opens the group's first page, as clicking the group does, so C, which opened the career plan,
  opens Training & Development → Training; the career plan is one click on from there. What's new says so. A is new,
  for Administration. K (Knowledge) is retired, since each of its pages has its own letter.

### 3. A page is named as the menu names it

- The header breadcrumb and document title read the group and page from `nav.ts`, as before.
- A page's eyebrow is its group (`usePlace()`, `src/lib/place.ts`). On Personnel, Reports & Analytics and
  Administration pages built from a unit's sections, it is the group and the unit or view ("Administration · G8").
- A page's heading is its menu label, or that label made specific to the person ("Your record" for Records →
  Overview, "Your career plan", "JEPES readiness", "JEPES input" on Analysis, the unit's name on Personnel →
  Overview). It is never a slogan.
- **A sentence that names a place reads it from the menu** with `placeName(to)` ("Records → Awards"), so copy cannot
  drift from the menu again. Toasts, Quick Log's notes, the import dialog, Today, Records and Help use it.

### 4. One vocabulary for common actions

| Action | Name | Where |
| --- | --- | --- |
| Quick capture, from anywhere (N) | **Log activity** | header pill, tab bar, empty states, Today, Records pages |
| Create a record of a kind | **New …** (New activity, New award, New training, New counseling, New goal, New task, New report) | the page's header and its empty state; the dialog has the same title |
| Bring data in | **Import …** naming what comes in (Import activities, Import work) | the page the data lands on, and ⌘K |
| Take data out | **Export …** naming what goes out (Export activities, Export analysis PDF, Export JEPES input PDF) | the page it comes from, and ⌘K |

⌘K carries Import activities, Import work, Export activities (CSV), Export my record as a PDF and Export everything
(Settings → Your data). The vocabulary is kept in `docs/design/DESIGN_SYSTEM.md`.

### 5. Help answers the definition of done

The field guide opens with **Find your way** (`src/components/FindYourWay.tsx`): the twelve questions of section 16,
each answered in a sentence and linked to the pages that answer it, named with `placeName`. A link to a page this
person cannot open is left out; the Personnel answer says when that group appears instead. Getting started on Today
links to it.

- **Duty** is answered as Vantage holds it today: a duty is logged as an activity, which the category hints file
  under Operations, and the link opens Activities filtered to Operations. Task 17 builds duty records
  (ADR-0015's registry lists Duty with no store yet).
- **Help's keyboard line** and the **shortcuts dialog** (`?`) list only the letters of pages this person may open,
  from the same `useNav()` as the menu; each key appears once, and "Switch view" only for someone with more than one
  view.

### 6. Progressive disclosure on Activities

Search, the period and the layout stay in view. Category, the evaluation area, quality, owner and sort fold behind
one **Filters** button (`aria-expanded`, `aria-controls`) that counts the filters set, on a desk as on a phone, with
"Clear filters" inside. A link that sets one (the narrative studio's "Needs detail" and "Tag them", Find your way's
duty link) opens the panel with it.

## Consequences

- Navigation is the specification's, and every page, heading and sentence names the same place the same way.
- No route, API, permission or schema changed. There is no migration; the server is untouched.
- Tests that clicked old names were updated to the new ones (see Verification); no test was skipped.
- Pages whose own content is another Task's are placed but not redesigned: Personnel's pages (Task 11), import and
  export (Task 13), reports and printable output (Task 14), duty (Task 17), Packages and Analysis, which overlap
  (Tasks 14 and 21), drafts (Task 23), tutorials (Task 26) and the performance and responsive pass (Task 25).
  `docs/product/INFORMATION_ARCHITECTURE.md` lists them.

## Alternatives considered

- **Move the addresses with the groups** (`/records/awards`, `/development/training`, `/personnel/roster`). Rejected
  for now: it changes every stored link for no visible gain, and the redirect table would double. If John wants
  addresses to match, `MOVED` can carry them later without changing the menu.
- **Keep Knowledge as a group.** Rejected: the specification's structure has no such group, and each of its pages
  has a better home (Reference with Work, MARADMINs with Training & Development, the guide and Support under Help).
- **Leave the consoles in the footer.** Rejected: administering a unit or the service is the specification's
  Administration, and the footer set it apart from the unit administration it belongs with.
- **Fold the filters on a desk into a side drawer.** Rejected: an inline panel under the search keeps the results in
  view and needs no focus trap.

## Verification

- **`tests/server/navigation.test.ts`:** the menu's invariants: unique keys, every page in one group, the
  specification's order, every old address landing on a page, `groupFor` by page with addresses unchanged, and
  `placeName`.
- **`tests/browser/17-navigation.spec.ts`:** the rail's groups and pages, every page in the menu opening with its
  heading and eyebrow, the collapsed rail's strip of a group's pages, and old addresses.
- **`tests/browser/39-information-architecture.spec.ts`:** the definition of done walked for a new Marine and for a
  unit leader, Find your way's links, the import and export actions in ⌘K, the Activities filters, the shortcuts
  dialog listing only pages the person can open, and axe on desktop and phone.
- Every other spec that named an old label or place was updated to the new one.
