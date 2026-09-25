# Progress

_Updated 2026-09-24 · branch `claude/vantage-redesign-overhaul-src4wq` · base `main` @ `dd76293`_

## What this branch did

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

## Verification (2026-09-24)

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (server, web, browser tests) | clean |
| `npm test` (server suite, in-memory SQLite) | **411 / 411 pass** |
| `npm run test:browser` (Playwright, Chromium, built client) | **67 / 67 pass**, including the four public-site checks that failed on `main` |
| Accessibility | axe: no serious or critical violations in either theme on every core page, the case page, the Reference and the public page |
| `npm audit` | 0 vulnerabilities |

### Not verified

- A live Microsoft tenant. The mailbox flow is tested end to end against a local stand-in for Microsoft;
  a real Entra registration in GCC High or DoD has not been exercised.
- The FMRA procedures against a current SOP or an SME. They are labelled "formal training reference,
  not verified against current policy", and screen paths are left undocumented until confirmed.
- PostgreSQL, Windows Server, a real CAC, a restricted-network host, backup and restore drills.

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
2. Register a Microsoft Entra application in the target cloud and run one real mailbox sign-in.
3. The films are published without narration, at the owner's request (score, sound and captions,
   which play by default; `voiced: false` in `src/config/films.generated.json`). To add the voice: put
   `ELEVENLABS_API_KEY` in the environment's settings and run `npm run film`, which voices the script,
   re-times and re-captures every scene to the real delivery, and republishes (film/README.md).
4. Protect `main` in GitHub with the three CI checks required (see `docs/deploy-render.md`).
