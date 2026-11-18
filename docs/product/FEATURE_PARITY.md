# Feature parity checklist

The reference product is `jbbmans/vantage` at `main` = `ac51ce9` (Vantage 5.0.0, 16 Sep 2026). It was
inspected by running it with synthetic data at 1440×900 in both themes before anything was changed
(screens under `artifacts/baseline/`, which is not committed). Every existing capability is listed
here with what happened to it on this branch, and the test that shows it still works.

Classification: **KEEP** unchanged · **IMPROVE** same capability, better experience · **REIMPLEMENT**
same user value, new implementation · **DEFER** kept in code, not advanced now · **REMOVE** taken out,
with the reason.

| Capability | Where it lives now | Status | Why | Evidence |
|---|---|---|---|---|
| Today (formerly "Standing") | `/` | IMPROVE | Now answers what to do, what is waiting, what changed, and what to capture; leaders see their section first. The measured-outcome figures and the AI review stay, lower on the page. | `tests/browser/01-setup`, `08-metrics`, `12-metric-drilldown`, `22-demo` |
| Quick Log (press N, one sentence) | Header button, `N`, Today quick capture | KEEP | Fast capture for work that did not start as a tasker. | `02-records`, `22-demo` |
| Case queue (workbench) | Work → Queue | IMPROVE | Shows document numbers instead of internal keys, stage instead of coarse state, who holds each item by name, open work by default, and no Claim on closed rows. Keyboard navigation and copy kept. | `13-workbench` |
| Work item detail (dialog) | `/work/items/:id` | REIMPLEMENT | A page, so reload and back work, with the procedure, the attributed history, research entries, stages, waiting and handoff. The original "What did you do?" form is kept on the page for work without a procedure. | `13-workbench`, `22-demo`, `tests/server/cases.test.ts` |
| Spreadsheet import (wizard, immutable source, idempotent reimport, mangled-identifier refusal) | Work → Queue → Import | KEEP | Imports now also write a `created` event per row. | `13-workbench`, `tests/server/intake.test.ts` |
| Claim, release, assign, stale-claim release | Queue and item page | IMPROVE | Each now writes an event. Handoff added: the holder can pass work to a teammate with a note. | `cases.test.ts`, `workbench.test.ts` |
| Tasks and projects | Work → Taskers and projects, Tasks | KEEP | Projects are presented as taskers and projects. | `02-records` |
| Correspondence (threads, .eml import, M365 connector) | Work → Correspondence, item page | KEEP | Connector routes are closed in the synthetic demo. | `15-correspondence`, `correspondence.test.ts` |
| Records / activities (list, filters, CSV import/export, recycle bin, detail) | Record → Your entries; `/records/:id` | KEEP | Moved under Record. `/records` and `/activities` redirect with their query. | `02-records`, `17-navigation` |
| Goals (typed, automatic or by hand) | `/goals` | KEEP | Unchanged. | `typedGoals.test.ts`, `22-demo` |
| Career: training, awards, counseling | Career tabs | KEEP | Training and awards unchanged. Counseling gains a draft, a review by its Marine, finalization, amendment history and a NAVMC 2795 worksheet to preview, print and download as a PDF (Task 20, ADR-0027). | `02-records`, `04-team`, `49-counseling` |
| Career: plan and next steps | Career → Plan and next steps | new | Owner-only steps with source and date checked; unchecked sources are marked "Not verified". | `record.test.ts`, `22-demo` |
| Readiness (JEPES pillars, FITREP coverage) | Career → Readiness | KEEP | Moved under Career; `/readiness` redirects. | `17-navigation` |
| Record: assigned work, contributions, drafts | Record → Overview, Contributions, Drafts | new | Claiming is shown at once but is not credit; contributions come from the work's own history. Drafts lists every kind of draft, each where it lives (ADR-0030); saved forms and entries from work are private, and the rest say who else reads them. | `record.test.ts`, `drafts.test.ts`, `22-demo`, `53-drafts` |
| Saved forms: goal, award, training, task, personnel change | Save draft on each form; "Your drafts" on each page | new | A form is saved to finish later, only its author's; sent through its kind's own route, which removes it. Closing a form with unsaved text asks first (ADR-0030). | `drafts.test.ts`, `migrations.test.ts`, `53-drafts` |
| Discussion and @mentions on records | Discussion on each record; questions and review requests on a work case | IMPROVE | Only someone who reads the record by their own access and belongs to its Unit Instance, or is its Marine on a record that is private or in no unit, writes on it; Vantage access only reads. A mention is looked up in the Unit Instance alone, a message names at most 10 people, and the answer says who was told. Ask a question and Ask for review go to one named person and stay open until answered or withdrawn; a task or goal assignment carries a note; a case returned from verification for correction says what needs correcting; a counseling's comments before it was final stay between its counselor and its Marine (ADR-0031). | `comments.test.ts`, `workflowMessages.test.ts`, `counselingWorkflow.test.ts`, `dutyReview.test.ts`, `54-workflow-messages.spec.ts` |
| Notifications (the bell) | The bell; `/notifications` (Notices; Asked of you / You asked); Settings → Notifications | IMPROVE | Every notice is in a group and names its Unit Instance and the record it is about, where it has them; one about a record is shown only while its person may still open that record, and never quotes what anybody wrote. Comments on one record coalesce into one unread notice; a bulk hand-off is one notice per person. Discussion, Work updates and Announcements can be turned off. Kept 180 days (ADR-0031). The weekly digest counts what waits on you. | `notifications.test.ts`, `migrations.test.ts`, `dutyReview.test.ts`, `54-workflow-messages.spec.ts` |
| Reports: Report Studio, Analysis, PDF, CSV | `/reports` (under More) | KEEP | Linked from Record. | `02-records`, `10-analysis`, `14-studio` |
| MARADMINs | `/maradmins` (under More, when enabled) | KEEP, default changed | The feed is now **off by default**: it is the only outbound request, and the product must run with public egress blocked. | `tests/server/*` (config) |
| Team: roster, unit dashboard, invitations, roles, units, access log | `/team` | KEEP | Unchanged. | `04-team`, `org.test.ts` |
| Team: workload | Team → Workload (default tab), leader Today | new | Unassigned, waiting, blocked and aging work, per-person counts beside definitions and limits. | `record.test.ts`, `22-demo` |
| Settings: security (passkeys, TOTP, sessions), appearance, personal export | `/settings` | KEEP | Personal export now also includes contributions, drafts and the career plan. | `03-security`, `09-export` |
| Unit Manager console → split (ADR-0006): the **Vantage Administrator console** (`/admin`) has settings, AI allowlist, accounts' sign-in help, audit chain, backup, export/import, usage; the **Unit Manager console** (`/console/:org`) has each organization's people, roles, units, roster, retention, holds, privacy inventory and audit | `/operator` redirects by tab | KEEP | New tables are registered in the privacy inventory and the instance export. | `18-governance`, `16-usage` |
| Support queue | Support / Vantage Administrator console | KEEP | Closed in the synthetic demo. | `support.test.ts` |
| CAC / PIV sign-in (direct mTLS, trusted proxy) | Sign-in | KEEP | Off by default. Test certificates regenerated: the originals expired two days after issue. | `cac.test.ts` |
| Authoritative personnel roster | Unit Manager console | KEEP | Per organization now; an extract speaks only for its own people. | `personnel.test.ts` |
| GenAI.mil assistance | Contextual buttons | KEEP | Off by default; refused in the synthetic demo. | `07-ai`, `ai.test.ts` |
| Offline Quick Log outbox | Service worker + IndexedDB | KEEP | Unchanged. | `05-offline` |
| Public site, `/display`, `/about`, prerender | Signed-out accounts instance | KEEP | A demonstration adapter, not part of the enterprise core. Four of its tests were already failing on `main` (see PROGRESS). | `20-public-site` |
| Walkthrough videos | `public/videos/films`, Help → Field guide | KEEP | The trailer of the ten outcomes (Task 27, ADR-0036) replaces the ad and the tour; the thirteen chapters stay, marked as recorded before the current look. A text-only film lists what it says under the player. | `trailer.test.ts`, `20-public-site` |
| Google Tag Manager | — | REMOVE | Third-party tracking is prohibited, and the page must not reach a public host. The SEO test now asserts it is absent. | `publicSeo.test.ts` |
| Keystroke-derived "active editing" time | — | REMOVE | Timing between keystrokes, tied to a person, is monitoring. Form-open time and the duration a person states are kept. The column stays so old rows still read. | `telemetry.test.ts` |
| SQLite data layer | `server/db` | DEFER → REIMPLEMENT | PostgreSQL is the production target; see `docs/engineering/MIGRATION_PLAN.md`. Not done in this slice. | — |
| Render deployment | `render.yaml`, `Dockerfile` | KEEP as an optional adapter | The enterprise path does not depend on it. | — |

## Open parity questions for the owner

- The Field guide (`/help`) still describes the old navigation in places. Updating its text is deferred
  until the new navigation is accepted.
- "Projects" is presented as "Taskers and projects". If the shop calls these something else, the label
  is one line in `src/pages/WorkHub.tsx`.
