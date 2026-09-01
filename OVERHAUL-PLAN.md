# VANTAGE 3.7 Overhaul Plan

**Audit baseline:** `4fbc756` (`feat: deliver Vantage 3.7 platform overhaul`), inspected 1 September 2026. This is a read-only code and test review; no application behavior was changed.

## Decision

Do not expand the product surface yet. First close two data-scope correctness defects, resolve the remaining evaluation-security gates, and make the release evidence reproducible. The recommended order is P1 scope integrity, P1 deployment/privacy boundary, P2 UX consistency, then scale and operational hardening.

The requested Sol Advisor/Terra route and fresh Sol review could not be performed in this mobile session because that plugin is not available here. This report is therefore a best-available independent audit, **not** a Sol-reviewed acceptance decision.

## Verification status

The declared scripts are present: `lint`, the composite `test`, browser suite, `test:load50`, and `test:persona100` ([`package.json:15-34`](https://github.com/jbbmans/vantage/blob/4fbc756/package.json#L15-L34)). I could not freshly run them: the locked install failed while `better-sqlite3` attempted to compile under the audit runner's Node 24, whereas the production image uses Node 22 ([`Dockerfile:3-14`](https://github.com/jbbmans/vantage/blob/4fbc756/Dockerfile#L3-L14)). Treat the prior 406-check claim as historical, not current-release evidence ([`RELEASE-REVIEW.md:20-27`](https://github.com/jbbmans/vantage/blob/4fbc756/RELEASE-REVIEW.md#L20-L27)).

## Prioritized findings

### P1 — Fix scope selection before further rollout

1. **Quick Log can display a unit choice that is not part of the payload, leaving the server to silently select the primary unit.**

   Quick Log sets unit visibility but renders no unit-target control ([`src/components/QuickLog.jsx:56-76, 232-234`](https://github.com/jbbmans/vantage/blob/4fbc756/src/components/QuickLog.jsx#L56-L76)). The shared picker displays a preferred unit when its `value` is empty and only later attempts to call `onChange` from an effect ([`src/components/VisibilityPicker.jsx:61-87`](https://github.com/jbbmans/vantage/blob/4fbc756/src/components/VisibilityPicker.jsx#L61-L87)). The API then chooses `primary assignment → first membership` when `unit_id` is missing ([`server/index.js:1960-1978`](https://github.com/jbbmans/vantage/blob/4fbc756/server/index.js#L1960-L1978)). In a multi-unit account, what the user sees, what is persisted, and what the server defaults can diverge.

   **Plan:** make an explicit `unit_id` part of every non-personal draft at creation time, render the same target picker in Quick Log, and make the API reject an omitted non-personal target rather than choosing one. Preserve a deterministic default only as a pre-save field value. This is the smallest safe 3.7.1 patch.

2. **Goals and Career use the entire visible collection without an explicit personal/unit scope, unlike Report Studio.**

   A goal's automatic progress sums every visible matching activity, without filtering by owner, goal visibility, or goal unit ([`src/pages/Goals.jsx:29-48`](https://github.com/jbbmans/vantage/blob/4fbc756/src/pages/Goals.jsx#L29-L48)). Career totals and its timeline likewise aggregate every training, recognition, and goal returned by the store ([`src/pages/Career.jsx:20-52`](https://github.com/jbbmans/vantage/blob/4fbc756/src/pages/Career.jsx#L20-L52)). Those stores legitimately contain authorized unit records: the server's list policy returns shared unit rows as well as the caller's rows ([`server/permissions.js:192-223`](https://github.com/jbbmans/vantage/blob/4fbc756/server/permissions.js#L192-L223)). In contrast, Report Studio explicitly filters “Me” by `user_id` and only offers a unit pool when export authority exists ([`src/pages/Reports.jsx:75-108`](https://github.com/jbbmans/vantage/blob/4fbc756/src/pages/Reports.jsx#L75-L108)).

   **Plan:** make **Me** the default and clearly label it on Goals and Career; add a permitted **Unit** view only where the policy decision supports aggregation. Make auto-count logic scope-aware and use the goal's target unit for a unit goal. Do not silently combine peers' records into a Marine's career story or personal target.

3. **The default MARADMIN feature violates the stated no-data-egress principle unless it is explicitly accepted as a bounded exception.**

   The configuration enables MARADMIN polling by default ([`config/app.yaml:59-66`](https://github.com/jbbmans/vantage/blob/4fbc756/config/app.yaml#L59-L66)). Production begins an outbound sync shortly after boot and every five minutes ([`server/index.js:2359-2372`](https://github.com/jbbmans/vantage/blob/4fbc756/server/index.js#L2359-L2372)); the route also refreshes on reads ([`server/index.js:807-815`](https://github.com/jbbmans/vantage/blob/4fbc756/server/index.js#L807-L815)), using `fetch()` to Marines.mil ([`server/maradmins.js:5, 116-123`](https://github.com/jbbmans/vantage/blob/4fbc756/server/maradmins.js#L5-L123)). This is not an AI or analytics SDK, but it is outbound network activity from an application intended to be self-contained.

   **Plan:** decide and document one policy: (a) ship it disabled and require an operator opt-in with a visible external-feed notice, or (b) remove the runtime fetch and import an approved feed snapshot through an administrator-controlled process. Keep no external AI services and no analytics SDKs in either design.

### P1 — Security hardening gates remain unresolved for real operational data

The security review itself says controlled evaluation only—not official/ATO-ready ([`SECURITY-REVIEW.md:3-7`](https://github.com/jbbmans/vantage/blob/4fbc756/SECURITY-REVIEW.md#L3-L7)). The unresolved items are substantive deployment gates:

| Gate | Evidence | Required outcome |
| --- | --- | --- |
| Phishing-resistant authentication | Local-password access has no MFA; CAC/PIV is disabled and described as a scaffold ([`SECURITY-REVIEW.md:87-91`](https://github.com/jbbmans/vantage/blob/4fbc756/SECURITY-REVIEW.md#L87-L91)); configuration still selects password and disables CAC/PIV ([`config/app.yaml:20-32`](https://github.com/jbbmans/vantage/blob/4fbc756/config/app.yaml#L20-L32)). | Do not use real operational data until CAC/PIV/mTLS validation, trusted-header stripping, identity linking, negative-path tests, and sponsor approval are complete—or deploy an approved interim MFA. |
| Attachment safety | Attachments are enabled with PDFs, images, and text, but validation is signature/UTF-8 checking only ([`config/app.yaml:49-53`](https://github.com/jbbmans/vantage/blob/4fbc756/config/app.yaml#L49-L53); [`server/attachments.js:31-49`](https://github.com/jbbmans/vantage/blob/4fbc756/server/attachments.js#L31-L49)). The roadmap explicitly calls out missing malware handling ([`SECURITY-REVIEW.md:91-94`](https://github.com/jbbmans/vantage/blob/4fbc756/SECURITY-REVIEW.md#L91-L94)). | Keep uploads disabled for sensitive deployment, or use an approved internal malware/quarantine control. |
| Boundary, retention, recovery | The review identifies no ATO/boundary decision, no retention authority, and unproven off-host encrypted recovery ([`SECURITY-REVIEW.md:90-100`](https://github.com/jbbmans/vantage/blob/4fbc756/SECURITY-REVIEW.md#L90-L100)). The app intentionally prohibits purging ([`server/config.js:229-234`](https://github.com/jbbmans/vantage/blob/4fbc756/server/config.js#L229-L234)). | Obtain records/privacy/OPSEC/RMF decisions, define correction/legal-hold/removal policy, and exercise restore before operational use. |

### P2 — Normalize the product model and navigation

1. **The navigation represents overlapping destinations as separate peers.** Work links to Goals while the rail also lists Goals; it additionally marks Work active when Goals is open ([`src/pages/Work.jsx:184-195`](https://github.com/jbbmans/vantage/blob/4fbc756/src/pages/Work.jsx#L184-L195); [`src/config/nav.js:12-14`](https://github.com/jbbmans/vantage/blob/4fbc756/src/config/nav.js#L12-L14)). Readiness is a first-class rail item but Career also marks itself active there ([`src/config/nav.js:9-16`](https://github.com/jbbmans/vantage/blob/4fbc756/src/config/nav.js#L9-L16)). Both active states make location and information ownership unclear.

   **Plan:** choose one model: Work contains Projects/Tasks/Goals as subviews, while Career contains Timeline/Development/Recognition and Readiness remains independent. Remove cross-active rail states and replace cross-page buttons with contextual links that do not impersonate tabs.

2. **The pages now have useful distinct compositions, but the design evidence proves Command much more than the rest.** Design QA is explicitly a comparison of a single authenticated Command capture ([`design-qa.md:3-16`](https://github.com/jbbmans/vantage/blob/4fbc756/design-qa.md#L3-L16)); the interaction pass only samples Quick Log, Records, Work, and Settings ([`design-qa.md:33-41`](https://github.com/jbbmans/vantage/blob/4fbc756/design-qa.md#L33-L41)). It cannot substantiate the “no P1/P2 visual findings” conclusion across Goals, Career, Readiness, Reports, Team, Units/Roles, or Settings ([`design-qa.md:47-52`](https://github.com/jbbmans/vantage/blob/4fbc756/design-qa.md#L47-L52)).

   **Plan:** create a route-by-route visual acceptance matrix with populated, empty, permission-denied, long-text, dark-mode, 375px, and keyboard states. Keep the approved ocean-light tokens, but define a page job: Command=operational picture; Quick Log=capture; Records=ledger; Work=flow; Goals=targets; Career=personal story; Readiness=readiness form; Reports=package studio; Team=access directory; Units/Roles=governance; Settings=account/instance controls.

3. **The command center’s aggregate is not labeled as “me” or “unit,” while Reports is.** Command calculates its metrics directly from all visible activities ([`src/pages/CommandCenter.jsx:142-176`](https://github.com/jbbmans/vantage/blob/4fbc756/src/pages/CommandCenter.jsx#L142-L176)); Report Studio has explicit scope controls ([`src/pages/Reports.jsx:81-108, 209-215`](https://github.com/jbbmans/vantage/blob/4fbc756/src/pages/Reports.jsx#L81-L108)).

   **Plan:** add a scope label/control or filter Command to the signed-in Marine by default. Match the same terminology in dashboard, goals, career, and reports.

### P2 — Testing and release evidence gaps

1. **No regression test proves the exact multi-unit fallback failure is impossible.** Browser coverage selects a private project’s unit manually and asserts the saved result ([`tests/browser.test.mjs:120-150`](https://github.com/jbbmans/vantage/blob/4fbc756/tests/browser.test.mjs#L120-L150)); it does not save an untouched Quick Log, goal, training, task, or project under two memberships. Add one browser test per record family plus an API negative test for missing non-personal `unit_id`.

2. **Load and persona suites are personal-only, so they do not exercise permissions, leaders, multi-unit records, attachments, reports, or concurrent edits.** Load-50 writes only personal activities/tasks/goals ([`tests/load-50.test.mjs:79-107`](https://github.com/jbbmans/vantage/blob/4fbc756/tests/load-50.test.mjs#L79-L107)); Persona-100 does the same for all five cohorts ([`tests/persona-100.test.mjs:74-128`](https://github.com/jbbmans/vantage/blob/4fbc756/tests/persona-100.test.mjs#L74-L128)). Add a mixed-role, multi-unit workload with enforced latency/error budgets and a separate write-contention test against SQLite.

3. **Accessibility and mobile checks prove route shell quality, not task completion.** Axe scans each page after a single setup identity ([`tests/browser-a11y.test.mjs:41-59`](https://github.com/jbbmans/vantage/blob/4fbc756/tests/browser-a11y.test.mjs#L41-L59)); mobile checks overflow across routes and only exercises navigation, notifications, and rank request ([`tests/browser-mobile.test.mjs:29-89`](https://github.com/jbbmans/vantage/blob/4fbc756/tests/browser-mobile.test.mjs#L29-L89)). Add keyboard and screen-reader journeys for Quick Log, Record detail, goals, unit/role administration, reports, uploads, session revocation, and error/conflict dialogs.

4. **CAC/PIV, egress policy, backup/restore, malware handling, and production configuration are not release-tested.** The static and security tests are strong authorization regression checks, but they cannot certify the deployment controls above. Add isolated integration tests for CAC proxy failure modes and CI gates for locked Node 22, dependency audit, secret/container scan, restore drill, and the selected MARADMIN egress policy.

### P2 — Architecture and operations

- **SQLite plus in-memory throttling are explicitly single-process.** The roadmap says not to use SQLite for multiple writers/replicas and notes that limiter state does not coordinate across replicas ([`SECURITY-REVIEW.md:95-100`](https://github.com/jbbmans/vantage/blob/4fbc756/SECURITY-REVIEW.md#L95-L100)); the code confirms process-local maps ([`server/security.js:3-12, 52-74`](https://github.com/jbbmans/vantage/blob/4fbc756/server/security.js#L3-L12)). Keep one instance for evaluation, define performance/availability thresholds, then move to PostgreSQL and a shared limiter before enterprise rollout.
- **YAML and database runtime overrides create two configuration authorities.** Startup reads saved database config ([`server/index.js:45-51`](https://github.com/jbbmans/vantage/blob/4fbc756/server/index.js#L45-L51)) while admin edits mutate a limited in-memory configuration and persist it to `meta` ([`server/config.js:285-325`](https://github.com/jbbmans/vantage/blob/4fbc756/server/config.js#L285-L325); [`server/index.js:165-180`](https://github.com/jbbmans/vantage/blob/4fbc756/server/index.js#L165-L180)). Define precedence, show source-of-truth and restart requirements, and version/audit a config export for recovery.
- **Release documentation is stale relative to the code.** The package declares 3.7.0 ([`package.json:2-8`](https://github.com/jbbmans/vantage/blob/4fbc756/package.json#L2-L8)) but the security and release reviews are titled 3.6.0 ([`SECURITY-REVIEW.md:1`](https://github.com/jbbmans/vantage/blob/4fbc756/SECURITY-REVIEW.md#L1); [`RELEASE-REVIEW.md:1`](https://github.com/jbbmans/vantage/blob/4fbc756/RELEASE-REVIEW.md#L1)). Require a release-specific evidence bundle tied to commit SHA and executed job IDs.

## Execution sequence

1. **3.7.1 correctness patch:** explicit non-personal unit selection; scope-safe Goal/Career/Command aggregation; regression tests for multi-unit defaulting.
2. **Evaluation-boundary decision:** disable or formally approve MARADMIN egress; keep attachments disabled where scanning/quarantine is absent; publish the evaluation-data policy.
3. **Security readiness:** CAC/PIV/mTLS validation, MFA interim decision, recovery and retention controls, then independent security review.
4. **UX pass:** navigation taxonomy, scope language, and route-level design acceptance matrix across all named workspaces.
5. **Enterprise readiness:** reproducible Node 22 CI, operational tests, Postgres/shared limiter plan, and a versioned release evidence bundle.

**Exit criterion:** a newly run, commit-pinned suite—including the new scope and deployment policy cases—plus an independent security/design review. Until then, retain the 3.6 review’s controlled-evaluation posture.
