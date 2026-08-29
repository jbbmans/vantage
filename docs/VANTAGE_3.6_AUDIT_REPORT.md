# VANTAGE 3.6 — Comprehensive Product Audit

## Executive result

VANTAGE was inspected as a complete signed-in product, not as a collection of screenshots. The review covered public access, authentication, every primary route, safe dialogs and controls, source-to-API contracts, authorization boundaries, accessibility, responsive behavior, dependencies, production deployment health, and isolated multi-user workloads.

The highest-impact defects found during the audit were repaired:

- the Recognition source field used a name the API silently discarded;
- new multi-unit actions defaulted to the first tree item instead of the Marine's primary assignment;
- goals, training, and recognition hid their disclosure scope;
- authenticated deep links presented a blank screen during startup;
- registration did not disclose the password floor and could enable submission without credentials;
- several icon-only destructive actions had no accessible name;
- task cards lacked the requested direct drag-and-drop status movement;
- shared record dialogs allowed repeat clicks while a save was in flight;
- abbreviated time filters lacked complete accessible names; and
- the browser-test dependency carried a high-severity development-only advisory.

The repaired code passes lint, production build, dependency audit, and the complete server/security/tenancy/migration suite. A new deterministic 100-persona run also passes.

## Scope and evidence

### Live product coverage

The live VANTAGE 3.6 deployment was inspected in authenticated and public states across:

- Sign in and Create account
- Command Center
- Activities and Activity detail
- Readiness
- Team and member detail
- Unit management
- Team-local role management
- Work tasks and projects
- Goals
- Career, Training & PME, and Recognition
- Reports
- Settings
- Help
- Search and command palette
- Quick Log
- account menu and keyboard shortcuts
- legacy redirects and the unknown-route state

Safe dialogs were opened and inspected without saving destructive or synthetic data into production. Production personnel records, units, roles, configuration, and sessions were not changed by the audit.

### Code and automated coverage

The review traced the UI's submitted field names into the API validation schemas and SQLite columns, then ran:

- ESLint
- Vite production build
- configuration and hardening invariants
- domain and parser logic
- API behavior
- scenario journeys
- security and privilege-escalation checks
- permission matrix
- exact-unit tenancy isolation
- legacy database migrations
- 50-account concurrency/isolation load
- 100-persona first-session simulation
- production and full dependency audits

## Findings and implemented repairs

### 1. Recognition source did not persist — critical functional defect

The UI wrote and displayed `from`, while the API and database contract use `from_whom`. Unknown record keys are intentionally ignored. A user could type a source, save successfully, and later see “Source not recorded.”

Implemented:

- changed the form, timeline, and global search to `from_whom`;
- added an API regression proving the value survives a round trip; and
- added the same assertion to every Recognition journey in the 100-persona simulation.

### 2. Multi-unit actions selected the wrong unit — high impact

Add Marine, Enroll existing, and New unit chose the first allowed item. On the inspected account that meant a top-level or neighboring unit rather than the primary CE Support assignment.

Implemented:

- one shared preferred-unit policy;
- primary assignment first, then owned unit, assignment, membership, and finally the first allowed item; and
- the same policy in visibility and exact-unit target controls.

### 3. Disclosure scope was hidden — high trust and usability impact

The server defaulted Training and Recognition to unit visibility and Goals to private visibility, but those forms did not show the choice. Users could not predict or adjust who would see the record.

Implemented:

- explicit “Who sees this…” controls for Goals, Training, Recognition, Tasks, and Projects;
- an exact-unit selector whenever unit sharing is selected; and
- primary-assignment-aware scope hints.

### 4. Authenticated deep links appeared broken while loading — high first-impression impact

The application rendered an empty dark canvas until identity, organization, preferences, and six stores finished loading. During the live route sweep this persisted long enough to look like a failed page.

Implemented:

- a visible, accessible “Loading Vantage…” status;
- a reduced-motion-compatible spinner; and
- parallel loading of organization data, preferences, and record stores after identity resolves.

### 5. Registration validation was unclear — medium impact

Create account did not disclose the 15-character password policy before submission. The submit control could also enable without username and password state.

Implemented:

- the password requirement appears during both setup and registration;
- required credentials participate in the disabled state; and
- returned errors use an assertive accessible alert.

### 6. Repeat submissions and silent async failures — medium impact

Shared record dialogs did not lock while saving. Fast repeat clicks could issue duplicate requests, while simple Career forms had no local rejection handling.

Implemented:

- one in-flight save guard in the shared dialog;
- disabled Cancel and Save controls until completion;
- visible “Saving…” feedback; and
- centralized user-readable failure reporting.

### 7. Task movement lacked direct manipulation — requested enhancement

Status could be advanced or edited, but the board did not support direct drag-and-drop movement.

Implemented:

- draggable task handles on pointer-capable layouts;
- animated drop-target feedback;
- server-backed status updates with success/failure feedback; and
- retained click/edit alternatives for keyboard and touch users.

### 8. Accessibility gaps — medium impact

Several screens produced a second page-level heading inside the application shell. Raw icon-only delete and remove controls lacked names. Fiscal abbreviations such as `FQ` and `FY` were the entire accessible label.

Implemented:

- secondary page headers now use `h2`;
- destructive and reference actions have specific accessible names and explicit button types;
- abbreviated tabs expose Week, Month, Fiscal quarter, Fiscal year, Calendar year, and All time to assistive technology; and
- task drag remains optional because equivalent button and form controls remain available.

### 9. Public sign-in contrast failed in light mode — high visual impact

The sign-in hero referenced a `bg-nav` design token that did not exist. In light mode the white hero copy could sit on a light surface and become unreadable.

Implemented:

- a stable dark navigation surface token shared by light and dark themes; and
- preserved the existing VANTAGE ocean-ledger design language rather than introducing a disconnected landing-page aesthetic.

### 10. Development dependency advisory — resolved

Production dependencies were clean. The full dependency scan identified the Playwright development version as affected by a high-severity advisory.

Implemented:

- upgraded Playwright to the current 1.62 line; and
- reran both production-only and complete dependency audits with zero known vulnerabilities.

## 100-persona simulation

### Method

The simulation creates 100 brand-new identities against an ephemeral instance of the real Express application and temporary SQLite database. It does not touch the deployed site. The group is evenly divided into five behavioral cohorts:

| Cohort | Accounts | First-session emphasis |
| --- | ---: | --- |
| Quick capture | 20 | Record an accomplishment and verify extracted facts |
| Planner | 20 | Create and organize work with status and priority |
| Career builder | 20 | Add training and recognition records |
| Privacy-first | 20 | Keep records personal and verify isolation |
| Report builder | 20 | Configure reporting preferences and source data |

Each account registers, signs in, saves preferences, creates Activity, Task, Goal, Recognition, and Training records, reloads all related collections, and verifies ownership and disclosure boundaries.

### Results

- 100/100 accounts registered and authenticated.
- 600/600 core writes completed.
- 700/700 authenticated reads completed.
- Activity, Task, Goal, Recognition, Training, preferences, and identity isolation round-tripped for every account.
- Recognition source survived for every Career journey.
- Goal measurement unit survived for every Goal journey.
- No personal record crossed an account boundary.
- Observed request latency in the full-suite run: p50 187 ms, p95 699 ms, maximum 4.623 s. The isolated run immediately before it measured p50 91 ms and p95 346 ms, showing the long maximum was suite-host contention rather than a repeated application failure.

### Heuristic new-user feedback

This section is a design simulation grounded in the inspected interfaces; it is not represented as interviews with human participants.

Before repair, the most plausible first-session comments were:

- “Did the page load?” on blank authenticated deep links.
- “Why did this save without the person who recognized me?” from the dropped Recognition source.
- “Who can see this?” in Career and Goal forms.
- “Why is MARFORRES selected instead of my shop?” in multi-unit workflows.
- “What does FQ mean?” in reporting period tabs.
- “Can I drag this card?” on the work board.
- “Why did account creation reject my password?” when the policy appeared only after submit.

The implemented changes answer each question at the point where it occurs.

## Production and hosting observations

- Render is connected to `jbbmans/vantage`, branch `main`, with commit-triggered auto-deploy.
- The service is on a Starter web instance with one persistent 1 GB disk mounted at `/data` and `/api/health` configured as the health check.
- CPU and memory use during the inspected period were far below the instance limits; scaling up would add cost without addressing an observed bottleneck.
- The 502 count aligned with deployment transition windows rather than sustained runtime errors; the current production deployment was healthy when inspected.
- The chart library remains isolated in a lazy route chunk. The build reports that chunk above 500 kB, but it does not block first paint; further chart-level splitting is an optional optimization rather than a current reliability defect.

## MCEN access note

The exact MCEN error image referenced during the audit was not present in the conversation payload. Public search could not reproduce an authoritative MCEN-specific error. VANTAGE already enforces HTTPS and production HSTS, but an MCEN block can also come from domain categorization, authorization, proxy inspection, or approval policy rather than application code. The precise block page, error code, and timestamp are required before attributing it to DNS, TLS, Render, or MCEN policy.

The application should continue to be treated as a controlled evaluation until command sponsorship, privacy/data-owner review, hosting approval, and the applicable MCEN/RMF path authorize operational personnel information.

## Verification status

Passed after repair:

- ESLint
- Vite production build
- 51 static authorization invariants
- 16 hardening invariants
- 5 delimited-file safety checks
- 82 domain logic checks
- 57 API checks
- 17 realistic command scenarios
- 50 security and escalation checks
- 56 permission-matrix cases
- 36 tenancy-isolation checks
- 50-account concurrent isolation load
- 100-persona first-session simulation
- 29 migration checks
- production dependency audit: 0 vulnerabilities
- complete dependency audit: 0 vulnerabilities

The local container could not execute the packaged Chromium UI suite because the browser process is incompatible with the sandbox. The live product was therefore inspected through the cloud browser, while the repaired build was verified through lint, build, API, security, tenancy, migration, and persona suites. A post-deploy cloud-browser sweep remains the final release gate.

## Remaining recommendations

1. Capture the exact MCEN block screen and submit the domain/application through the appropriate G-6/MCEN review channel.
2. Run moderated usability sessions with at least one junior Marine, one NCO, one SNCO, and one operator; bot personas test behavior and consistency, not human comprehension.
3. Move to managed PostgreSQL before horizontal scaling or enterprise multi-instance service.
4. Keep CAC/PIV disabled until an approved certificate-validating proxy and identity-linking process are in place.
5. Add continuous deployment smoke checks for sign-in, health, primary routes, and console errors after every Render deployment.
