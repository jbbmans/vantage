# Design system

What ships. One stylesheet, `src/styles/index.css`, defines every token and shared component rule;
`tailwind.config.ts` maps the tokens to utilities. The public page (`src/pages/PublicSite.css`) and the
sign-in page (`src/styles/login-premium.css`) are the only other stylesheets, and both are scoped to
their own root. The six overlapping stylesheets this replaced (`brand-2026.css`,
`experience-motion.css`, `public-site.css`, `public-showcase.css`, `public-site-a11y.css`,
`login-reference.css`) are gone. Brand rules are in `docs/brand-2026.md`. (The root `DESIGN.md`
describes a different product's styling and is not the Vantage design system.)

## Palette

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | Paper `#F6F7F9` | `#0B1320` | Page background, gaps between cards |
| `--surface` | White | `#111C2E` | Cards and panels |
| `--surface-2` / `--surface-3` | `#F3F5F8` / `#E9EDF3` | `#17253B` / `#20314C` | Quiet fills, table heads; hover and tracks |
| `--ink` | Deep Navy `#0A1B33` (16.9:1) | `#EAF0F8` (14.5:1) | Primary text |
| `--ink-2` / `--ink-3` | 8.9:1 / 5.4:1 on white | 9.3:1 / 5.9:1 | Secondary and muted text |
| `--accent` | Cobalt `#2563EB` | lifted Cobalt `#7AA2FF` | The one primary action, selection, data emphasis |
| `--good` `--warn` `--bad` `--info` | semantic; `--info` is `#1D4ED8` so an info badge clears AA at 11px | same | Status only, never decoration |
| `--rail` | Deep Navy `#08162A` | `#09111E` | The navigation rail |
| `--deep` / `--deep-2` | `#0A1B33` / `#12294A` | the rail's shade | Tooltips, icon tiles, specimen blocks, modal scrims |
| `--brand-teal` | `#14B8A6` | `#2DD4BF` | The mark and the rail's active marker only |

The colour setting (Settings → Appearance) picks a whole palette, not only the signal colour: Cobalt
(the brand, above), Ocean, Scarlet & Gold, Olive, Steel and Ember. Each sets its own `--accent` family
and a family of neutrals in its hue (canvas, surfaces, lines, ink, rail, deep, and the shadow tint
`--shadow-rgb`), in light and dark. The neutrals keep Cobalt's lightness role for role, carried to each
hue in OKLCH, so every contrast pair holds in every palette. Nothing in a component may name a colour:
tooltips, icon tiles, scrims and glows read these tokens, so a palette reaches every pixel of the app.
The public site keeps the brand palette.

Every muted tone clears WCAG AA on the darkest surface it can land on. Axe checks both themes on every
core page, the case page, the Reference and the public page (`tests/browser/06-a11y.spec.ts`,
`22-demo.spec.ts`).

## Depth

Shadows are tinted navy, never black, and come as tokens: `--shadow-hairline` (a 1px ring instead of a
grey border), `--shadow-card`, `--shadow-lift`, `--shadow-pop` (menus, popovers) and `--shadow-modal`.
All of them read `--shadow-rgb`, the palette's ink. Dark mode swaps them for deeper, black-based versions
with a faint light ring. `--highlight` is the
inset top light on raised controls.

## Type

Geist (variable, served from `public/fonts`, OFL) for everything, with Inter as the fallback while it
loads. No remote fonts. Figures use tabular numerals (`.fig`, `.stat-value`). Headlines are tight
(negative tracking), sentence case, semibold. Eyebrows are small uppercase labels, preceded by a short
accent rule in page headers. JetBrains Mono appears only in code and identifiers that need it.

## Shape and motion

Radii step with size: 5 / 6 / 8 / 10 / 14 / 18 / 24px (`rounded-sm` … `rounded-3xl`); inner elements
use a smaller radius than the container they sit in. Primary calls to action in the shell are pills.

Motion uses one curve, `--ease-spring: cubic-bezier(.32,.72,0,1)`, and animates transform and opacity
only. Pages rise in (`page-in`), sections stagger (`section-in`), menus pop (`pop-in`), drawers slide.
`prefers-reduced-motion` turns all of it off. On the public page, reveal motion moves elements but
never hides them: at rest everything is opaque (asserted by `20-public-site.spec.ts`).

## Shell

A navy rail (collapsible with `[`) holding the workspace chip, grouped destinations with their `G`
shortcuts shown on hover, and the account. A translucent sticky header with the search pill (⌘K opens
the command palette, which also searches the Reference) and the "Log activity" pill. One demo banner in
the synthetic demo, with a segmented persona switch. An update banner appears when a newer build is
published (the service worker and `/api/health` both carry the build's hash).

## Components

`src/components/ui/primitives.tsx`: Button (one primary per screen), Input, NumberInput, Textarea,
Field (label, hint and error wired to the control), Select (Radix), Badge, Panel, EmptyState, Stat,
Segmented, Tabs, Progress, PageHeader, Switch, Tooltip. `Dialog`/`ConfirmDialog`, `toast` and `Menu`
are restyled on the same tokens.

Case components (`src/components/work.tsx`): `StageBadge` (colours from `STAGE_TONE`; waiting shows its
category) and `WorkRow` (document number, stage, overdue flag, next step or waiting time, due date).

FMRA components (`src/components/fmra/`):
- `LifecycleBars`: commitment, obligation, delivered and paid on one scale. The open residual is a
  hatched segment labelled with its condition (OCMT, UDOU, DOU, OTO), so the gap never rests on colour.
  A figure the source did not show is a dashed outline marked "Not shown", never a zero. It carries a
  screen-reader table; `decorative` draws an unlabelled illustration for empty states.
- `DiagnosisView`: the eight-part reading in the order the reference teaches.
- `Diagnoser`: figures in, reading out, and "open a case" with the figures already recorded.

`QueryFailure` (`src/components/QueryFailure.tsx`) tells offline, signed out, denied, missing and
server error apart, with a retry where one can help.

## Patterns

- **Cards** summarize something that opens: every figure links to the records behind it.
- **Tables** compare records: the queue, workload by person, calculation inputs.
- **Charts** only where shape matters: `LifecycleBars`, `BarList` for who holds what, `AreaChart` for
  outcomes over time.
- **Gates are shown before they refuse.** A step waiting on evidence (a verification, a passed funds
  check) says so in a warning strip with a link to the step that satisfies it, and its button is
  disabled; the server enforces the same rule.
- **Corrections are added, never edited.** An observation's "Correct" action supersedes it; the
  original stays in the history marked "Corrected later", and any calculation that used it shows as
  stale.
- **Disclosure** holds secondary detail: "How to do this", "Everything the source said", procedure
  source and limitations, the causes the reference offers. Routine actions are never hidden behind one.
- **One demo indicator.** Pages show no other demo labels, except the flagship item's synthetic system
  values, labelled where they appear.
- **Language.** Real names for real concepts: document, tasker, stage, waiting on posting, handed off,
  verified, not shown. No table names or adapter names in the interface.

## Public page

Its own fixed palette (it has no stored preference to follow): deep navy hero and footer around a cool
paper body, brand teal as the accent on dark and cobalt on light. A floating glass navigation pill,
double-bezel frames around product stills (drawn in HTML, so they are crisp and readable to crawlers),
an asymmetric bento, pill calls to action with a nested icon. It is prerendered to static HTML at build
time and must stay whole without JavaScript.

## Not used

Streaks, gamification, tactical styling, purple gradients, AI branding, decorative KPI walls,
arbitrary animation, grey drop shadows, 1px grey borders on cards.
