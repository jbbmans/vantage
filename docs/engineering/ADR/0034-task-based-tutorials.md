# ADR-0034 · Short task-based tutorials, offered where the task is done and followed in the application

**Status:** accepted · **Date:** 2026-11-17 · **Builds on:** [ADR-0016](0016-information-architecture.md) (the menu and
its rules), [ADR-0024](0024-duty-review-permissions-scoring.md) (approving one's own duty),
[ADR-0032](0032-performance-accessibility-responsive.md) (WCAG 2.2 AA, focus and the phone's tab bar)

## Context

Task 26 of VANTAGE_CLAUDE_MASTER.md:

> Only redo tutorials after UX stabilizes. Use short task-based tutorials: Getting Started, Logging Work, Personnel,
> Import/Export, Error Reports, Case Diagnosis, Duty, Training, Certificates, Counselings, Reports, Analytics. Prefer
> contextual guidance over one giant walkthrough.

The interface settled with Task 25 (layout, focus, widths) and the Dress blues look (the edit recorded in ADR-0033).
Before this change Vantage had no tutorial in the application: the Field guide's answers (`src/config/help.ts`), "Where
everything is" (`FindYourWay`), the Getting started card on Today, and recorded films (`src/config/videos.ts`). The
films show the screens as they were before the current look. Reading every area for the tutorials also found Field
guide answers and page hints that described the application as it was before Tasks 13 to 25; those are corrected in
the same change.

## Decision

### 1. Twelve tutorials, one task each

`src/config/tutorials.ts` holds the twelve the specification names, in its order (ids in `shared/tutorials.ts`, so the
settings schema can check them). Each has a one-sentence outcome and three to six steps. A step names:

- `at`, the page it happens on: an app path, a pattern with a parameter for a page reached from another
  (`/team/:id`, with `from`, the page "Go to" opens instead), or one tab of a page (`/settings?tab=data`, with
  `place`, how a sentence names it). A page shows its first tab without saying so in its address, so
  `src/lib/tutorialPaths.ts` holds each such page's first tab (`DEFAULT_QUERY`, checked against the pages by a test):
  `/reference` is `/reference?tab=diagnose`, and a step on another tab is not "here";
- `anchor` and `control`, the control it is about: a static `data-tutorial` name on that control, and the control's
  visible name, which the step's words use;
- `when`, a gate for a step only some people have (below).

A body is at most two plain sentences, true of this build. The words are written from the code, each claim checked
against the page, the server rule and the permission behind it.

### 2. Offered in context, never opened by itself

- **A line under the title** of each page a tutorial is about names it and its length ("Tutorial · Duty, 6 steps"),
  with a mark once it is finished (`TutorialPrompt`, drawn by `PageHeader` and by the case page's own header). It can
  be turned off in Settings → Appearance → Tutorials.
- **Help → Field guide** lists every tutorial the person may take, with Start or Take again; its search finds a
  tutorial by the words of its steps, above the answers.
- **The command palette** (⌘K / Ctrl+K) names each as "Tutorial: …".
- **Today's Getting started card** links to the Getting started tutorial.

Nothing opens on a first visit or after a change: a tutorial is there when someone wants it, on the page where they
need it, which is what "contextual guidance over one giant walkthrough" asks.

### 3. The panel sits beside the page; it is not a dialog

`TutorialPanel` is a complementary landmark fixed at the foot of the screen (above the phone's tab bar, z-index 45),
so the person does each step in the application itself rather than watching it.

- Every step is listed and can be opened, so it is never a wizard. The open step says what to do and where.
- **Go to** opens the step's page and then shows its control. For a Marine's page it opens the page it is reached
  from, or, already on that Marine's page, the step's tab of it; on the page a Marine's page is reached from, the step
  says to open one. Focus waits on the tutorial's heading and the live region names the page it went to.
- **Show me** scrolls the control to the middle of the screen, outlines it for a few seconds, and gives it focus when it
  takes focus, so a keyboard or screen reader user lands on it. When the control is not there (a list with nothing in
  it yet), the step says so in words.
- It stays open from page to page and across a reload, for this tab and this person only (`sessionStorage`, key
  `vantage.tutorial`: the person's id, the tutorial and the step; nothing else).
- On a phone, on a screen less than 480 pixels tall, and wherever it would cover the control it shows, it folds down
  to its heading (and is at most 45% of a short screen when unfolded). Where the screen is too short to keep a control
  clear of it, keyboard focus moving to a control it covers folds it too (WCAG 2.4.11). On a phone, Go to folds it only
  once nothing is left to read there: a step whose control is not on the page says so with the panel open. Folding
  never leaves focus on a hidden button: it moves to the button that unfolds it.
- Started, its heading takes focus; found open after a reload, it leaves focus where the page put it; closed, focus goes
  back to what opened it; Other tutorials takes focus to the list in Help, in place of a search showing there; a live
  region says each move. Started again, even the same one, it lets go of what the last one was still doing; hidden by a
  View switch and shown again, it is not a new start. The page
  keeps room to scroll out from under it, keyboard focus is kept clear of it (`keepFocusClear`), toasts rise above it,
  and it never prints.

### 4. Modal windows make it wait

A Radix modal (a form, a confirmation, a menu, the phone's menu drawer) turns off pointer events on the page and hides
everything outside it from assistive technology, the panel too. So **a step points at a control on the page, never at
one inside a form**; what is done in a form is the words of the step that opens it, one step per form. While one is
open the panel says "The tutorial waits while a window or menu is open". Over a form or a confirmation its step stays
readable above the dimmed page; the phone's menu drawer covers it. A popover that is not modal (the bell) leaves the
panel working and is not counted.

### 5. Who is offered what

A tutorial and a step carry a `TutorialGate`: the menu's own rule (`useNav().allowed`, ADR-0016), so a tutorial never
shows a page the menu hides, plus, where a step needs more, a permission held in at least one unit (`anyOf`) or file
attachments on for the service (`attachments`). Vantage can still withhold attachments from one Unit Instance
(ADR-0014), which the client does not know ahead; the training then says so, and the step's words allow for it. A Marine is offered Counselings without the counselor's two
steps; a person with no unit is not offered Personnel, Duty or Error reports.

This only decides what is offered. **The server decides every action, as before; nothing on the server changes.** Where
the client cannot say the whole rule (Review duty and View shared records in the same unit; Counsel plus outranking the
Marine), a step can be offered to someone the page then gives no button; "Show me" then says the control is not on the
page.

The client's `can()` now uses the shared `has()` rule, as the server does: ADMINISTRATOR holds every permission except
the ones a role must name (Approve own duty, ADR-0024). It had shown leaders controls the server refuses.

### 6. Progress is a setting, not a table

Finishing a tutorial adds its id to `prefs.tutorials.done`, to the list as saved (read again first, so one finished in
another tab is kept); the line under titles is `prefs.tutorialPrompts`. Both go
through `PUT /api/me/prefs`, which validates them with `prefsSchema` (known ids only, at most twelve, duplicates
dropped) and merges them key by key (`server/routes/me.ts`). No migration, no new endpoint, and nobody reads anyone
else's progress.

### 7. Light on the first load

The tutorials' words load after the page has drawn (`useTutorialList`, a dynamic import), as What's new does;
`tests/server/startupBundle.test.ts` keeps them out of the startup bundle.

### 8. Anchors are checked twice

`tests/server/tutorials.test.ts` checks that every anchor is a static `data-tutorial` name present in the source, that a
named control is in its step's words, that every page exists, and that a step leads only where the menu lets the same
person go (its gate holds the menu's own rule for that page); the type of `anyOf` admits only real permissions. Browser
spec 57 walks every step offered to a unit leader: it goes where the step says, presses Show me,
and checks the control outlined is the one named.

### 9. The films stay, labelled

A film recorded before the current look says so beside it: "Recorded …, before the current look, so some screens differ
from yours. The tutorials follow this build."

## Alternatives considered

- **One guided tour of the whole application.** Rejected by the specification.
- **Opening a tutorial on a first visit.** Rejected: it interrupts the task the person came to do, on every new page.
- **A coach-mark library (an overlay that dims the page around a control).** Rejected: no gap the application's own
  primitives cannot fill, so no external code (project rule); and an overlay is itself modal, which would fight the
  application's own dialogs and the keyboard rules of ADR-0032.
- **A table of tutorial progress.** Rejected: one list of ids per person is a setting, and the settings column already
  carries per-person choices with a schema.

## Consequences

- A new task-based tutorial is a registry entry plus a `data-tutorial` name on each control it points at; both tests
  fail when a name or a page goes missing.
- A control renamed in the interface must be renamed in its step; spec 57 fails until it is.
- Seventeen steps point at controls that appear only once there are records of their kind (a filed error report, a
  duty, a package, a chart with figures); spec 57 checks their pages and the source checks their tags, and Show me says
  in words when one is not there yet. The four case steps need a case, which spec 57 does not file.
