# ADR-0036 · The trailer: the ten outcomes, on the product as it ships

**Status:** accepted · **Date:** 2026-11-18 · **Builds on:** [ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md) (MCEN is the
production target; the public site is a legacy adapter), [ADR-0034](0034-task-based-tutorials.md) (the films stay,
each marked when it was recorded before the current look), `docs/design/DESIGN_SYSTEM.md` (dress blues)

## Context

Task 27 of `VANTAGE_CLAUDE_MASTER.md`: "Priority P3. Only after the final product stabilizes. Show actual final product.
Focus on outcomes: Marine dashboard, Personnel, Records, Duty, Training, FM workflows, Error analysis, Case guidance,
Reports, Analytics. Do not portray Vantage as a public SaaS site."

At `634598a` the Field guide and the public page led with two films published on 2026-09-28, in the look before dress
blues:

- **The ad** ("Vantage in a minute", 62 s) and **the tour** (81 s), built from designed scenes (`film/src/story/`,
  `film/src/moments.ts`) rather than the application. The tour closed on "Private by default. Can run on your own
  network.", the pitch of a public product. Neither showed Personnel, Duty, Training, error reports, case diagnosis or
  the unit dashboard, which came later.
- **Thirteen Field guide chapters**, one task each, also from before the look.

The synthetic demo seeded no duty types and no duty scoring, so Duty could not be shown from it: a Unit Instance's
duty types and scoring are set in the Unit Manager console, which the demo's section lead does not hold.

## Decision

### 1. One trailer replaces the ad and the tour

`film/src/script.ts` `TRAILER`: a one-line cold open, the mark, then one scene for each outcome, in the specification's
order, then a close on who governs a Unit Instance, and an end card. About 100 seconds. Each outcome scene names its
outcome in the masthead (`01 · MARINE DASHBOARD` … `10 · ANALYTICS`), counts it among the ten, and keeps "Demo data"
beside the count while the application is on screen. `src/config/videos.ts` gives it the first slot under Starting out;
the public page (legacy profile only) plays it as "The film".

### 2. Real footage, from one synthetic workspace

Every outcome is one take of the application in the synthetic demo (`film/tools/shots.mjs` `trailer`), at 2×, in one
browser context that changes persona the way the demo's own switch does. What the demo does not seed is made first
through the product's own API, as its users would make it: the Marine records two duties (`POST /api/records/duties`);
the section lead files last week's and this week's ULO reports (`POST /api/work/sources`, then
`POST /api/error-reports/snapshots`). Every click in the film is a real click; a capture that cannot find what a scene
needs fails rather than publishing a take without it.

### 3. Never a public site

The trailer shows no address, price, trial or sign-up. Its last words before the end card are "Each command runs its
own Unit Instance, kept apart from every other. / Unit Managers govern it. Vantage Administrators run the service.",
over the application's own footer and the Unit Manager console. The end card carries only the mark and what the demo
banner and the application's footer say: "Synthetic demo data. Not an official DoD or USMC system of record."
`tests/server/trailer.test.ts` holds the script and the composition to the ten outcomes, in order, and to that wording.

### 4. In the current look

Dress blues: the navy coat, the gold rule and scarlet stripe, the serif of page titles for the cold open, the
application in one plate with a gold hairline and no browser chrome. Its score is synthesised like the chapters', with
a chime rising one step at each outcome, normalised to −14 LUFS.

### 5. A text alternative beside the player

The film has no narration; everything it says is on screen. Publishing now writes each text-only film's cards, in
order, as `transcript` in `src/config/films.generated.json`, and the Field guide's card and the public page show it under
the player as "What the film says" (a media alternative for prerecorded video, WCAG 2.2 1.2.1 and 1.2.3). The thirteen
chapters get theirs from the same script, whose chapter cards have not changed since the chapters were published
(`eb67311`); a test holds every published film's transcript to its cards.

### 6. The demo scores duty

Each new demo workspace gets the standard duty types (`addStandardDutyTypes`) and one scoring version, the
specification's worked examples (DNCO 5, ADNCO 3, barracks bands, per-day SAF and range, per-hour working parties and
events, holiday ×1.5 and weekend ×1.25, the higher applying), in force from 120 days back, recorded as published by the section lead 121 days
ago. It is the workspace's invented past, like the rest of its history, so no audit entry stamped today claims it was
published today. The content is held to the console's own rules (`scoringPolicyProblems`) before it is written; the
console's `publishScoringPolicy` itself is not reused, because it rightly refuses a version that takes effect before
tomorrow. A Marine's duty in the demo is
scored and goes to the section lead for review. It is removed with the workspace, like everything else in it.

### 7. Retired

The ad, the tour and the earlier hero film's code (`film/src/story/`, `film/src/moments.ts`, their captures and
designed sounds) and their published files (`public/videos/films/ad.*` and `tour.*`, about 74 MB).

## Consequences

- The Field guide's first film shows the product as it ships today. The thirteen chapters stay as they were, still
  marked as recorded before the current look; their end card still shows the old public address. Re-recording them is
  separate work.
- A re-render needs the synthetic demo, Playwright's Chromium and Remotion's headless shell (`film/README.md`). The
  trailer's figures change with the day it is captured (dates, the demo's relative days), never with real data.
- The repository carries the trailer's MP4 and poster in place of the two retired films.
