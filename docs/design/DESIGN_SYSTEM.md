# Design system

The Vantage visual identity is kept from the reference product. This file documents what ships. The
tokens are defined in `src/styles/index.css` and mapped in `tailwind.config.ts`; the brand rules are in
`docs/brand-2026.md`. (The root `DESIGN.md` describes a different product's styling and is not the
Vantage design system.)

## Palette

| Token | Light | Dark | Use |
|---|---|---|---|
| `--canvas` | Glacier tint `#F4F7FB` | `#0B1729` | Page background, gaps between cards |
| `--surface` | White | `#12243D` | Cards and panels |
| `--surface-2` | Glacier `#EAF0F6` | `#1A3050` | Table heads, quiet fills, the rail |
| `--ink` | Deep Navy `#0B2D5B` (13.6:1) | `#E2EAF4` | Primary text |
| `--ink-2` / `--ink-3` | 7.9:1 / 5.7:1 on white | tuned for AA | Secondary and muted text |
| `--accent` | Cobalt `#2563EB` | lifted Cobalt | The one primary action, selection, data emphasis |
| `--good` `--warn` `--bad` `--info` | semantic, AA on both surfaces | same | Status only, never decoration |

The rail is Glacier in light mode and navy in dark mode. The active destination is a solid Deep Navy
block in light mode and Cobalt in dark. Every muted tone clears WCAG AA on the darkest surface it can
land on. Axe checks both themes (`tests/browser/06-a11y.spec.ts`, `22-demo.spec.ts`).

## Type

Inter for interface text, served locally from `public/fonts` (no remote fonts). JetBrains Mono is not
used for body text. Figures use tabular numerals (`.fig`). Page titles are sentence case and bold.
Eyebrows are small uppercase labels.

## Components

`src/components/ui/primitives.tsx`: Button (one primary per screen), Input, NumberInput, Textarea,
Field (label, hint and error wired to the control), Select (Radix), Badge, Panel, EmptyState, Stat,
Segmented, Tabs, Progress, PageHeader, Switch, Tooltip. `Dialog` and `ConfirmDialog` are in
`ui/Dialog.tsx`.

Case components (`src/components/work.tsx`):
- `StageBadge`: stage colors come from `STAGE_TONE`. Waiting shows its category, for example "Waiting on posting".
- `WorkRow`: a work item as it appears on Today, in Record and in Workload. It shows the document
  number, stage, overdue flag, the next step (or the waiting time and blocked reason), and the due date.

## Patterns

- **Cards** summarize something that opens: every figure links to the records behind it.
- **Tables** are for comparing records: the queue, the workload by person, calculation inputs.
- **Charts** only where shape matters: `BarList` for who holds what, `AreaChart` for outcomes over time.
- **Disclosure** holds secondary detail: "How to do this", "Everything the source said", procedure
  source and limitations, "How to read these numbers". Record, Career, identifiers and routine actions
  are never hidden behind one.
- **One demo indicator.** In the synthetic demo, a single banner under the header names the persona
  and offers the persona switch and a reset. Pages show no other demo labels, except the flagship
  item's synthetic system values, which are labelled where they appear.
- **Language.** Real names for real concepts: document, tasker, stage, waiting on posting, handed off,
  verified. No table names, adapter names or revision numbers in the interface.

## Motion

Motion explains a change the person caused. It never decorates, never waits, and never moves a
figure through wrong values. The policy and the tokens live in `src/lib/motion.ts`; each library has
one job, so no two animate the same thing.

| Layer | Job | Where |
|---|---|---|
| CSS (`experience-motion.css`) | Page entrances, hover and press feedback | Unchanged |
| Motion (`motion/react`) | Layout: the tab underline and segmented selection slide to the new choice; work rows fold out of one list and into another when claimed; toasts make room; the next step's form rises in; a new history entry slides in; the procedure highlight moves to the picked step | `primitives.tsx`, `work.tsx`, `toast.tsx`, `WorkItemPage.tsx` |
| React Spring | Progress meters spring to a new reading (goals, projects, the procedure) | `Progress` in `primitives.tsx` |
| GSAP | One timeline: a calculation the person just asked for plays its arithmetic in order, inputs first and the adjustment last, then settles. Clicking skips it | `CalculationPanel` |
| Anime.js | A completed step draws its own check mark; a stage badge pulses once when its stage changes | `components/motion.tsx` |

Rules:

- **Change, not arrival.** Lists, meters and the calculation are still when a page opens with the
  state already there. Only a change made while the page is open animates.
- **Figures are records.** Money and counts are exact from the first frame. Only position, opacity
  and emphasis move.
- **Nothing waits on motion.** Controls work mid-animation; no content is hidden until something ends.
- **Reduced motion everywhere.** The operating-system setting stops all four libraries, not only the
  CSS. Tested in `tests/browser/23-motion.spec.ts`.
- **Durations** are the CSS tokens: 120, 190 and 320 ms, on the same two curves.
- **Cost.** Motion's layout features, GSAP and Anime.js load on demand. The first download grew by
  about 34 KB gzipped (Motion's core and React Spring), from 171 KB to 205 KB.

## Not used

Streaks, gamification, tactical styling, purple gradients, AI branding, decorative KPI walls,
animation at rest, looping motion, number counters, scroll-triggered reveals (the public page must
carry its substance in the first render).
