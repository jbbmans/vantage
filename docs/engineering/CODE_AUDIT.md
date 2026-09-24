# Code audit

A line-by-line review of Vantage for two things:

- **Discrepancies:** places where the product does not do what it says, or where two parts disagree.
- **Security weaknesses.**

Written 2026-09-24 against version 5.0.0, schema 9. Where each request goes is mapped in
[`code-map.md`](code-map.md).

This is an internal review, not a penetration test or an accreditation, and it claims neither.

## Method and coverage

- **Inventory.** Every route declaration (217) was listed with its router guard, per-route middleware, the permission bits its handler names, and its file and line. Every client API function was matched to a server route, and every SQL statement to the tables it reads and writes. The result is `code-map.md`.
- **Read in full.** Everything under `server/`:
  - auth, authorization, lib, db, all route files and all services;
  - `shared/` and `scripts/`;
  - `public/sw.js`, `Dockerfile` and `render.yaml`.

  The most time went to the security surfaces:
  - sign-in, sessions, MFA, step-up and CSRF;
  - the permission model and every place it is checked;
  - uploads and archive parsing;
  - HTML handling, exports and imports;
  - retention and deletion;
  - anything that fetches from the network.
- **Client.** The client was swept by pattern: raw HTML, links built from data, storage, `window.open`, `eval` and `postMessage`. Its key files were read whole: `src/lib/api.ts`, `src/App.tsx`, Login, Settings, RecordDetail, Team, People, AppShell and navigation.
- **Dependencies.** `npm audit` reported no known vulnerabilities, in production or development dependencies.
- **Not done.**
  - No fuzzing.
  - No dynamic scanning against a deployed instance.
  - No review of third-party package source.
  - No outside penetration test.

Every fix in the security table, and D8 and D11–D13, has a regression test. Each test was run against the code before the fix and failed there, then passed after it. After the fixes:

- the full server suite passed (389 tests);
- the browser suites for setup, records, security, teams, work, governance, the demo, and people and record kinds passed (27 tests);
- lint and typecheck were clean.

## Summary

| | Fixed | Open |
| --- | --- | --- |
| Security | 13 | 9 |
| Discrepancies | 7 | 8 |

The two high-severity problems are fixed: an archive could expand past its size limits, and the recycle-bin purge could erase records under a legal hold. None of the open items lets a signed-in person read or change data outside their permissions. The open items are:

- deployment configuration;
- product decisions;
- features the server has but the interface does not.

## Security: fixed

| # | Severity | What was wrong | Fix | Test |
| --- | --- | --- | --- | --- |
| S13 | High | **Archive expansion.** The ZIP reader checked the sizes an archive *declared*, but let each part inflate to 64 MB whatever it declared. Any signed-in person could upload a small workbook that expanded to gigabytes in memory. | Each part now inflates only up to the size it declares, and within what is left of the whole budget. A part whose real size differs from its declared size is refused. `server/lib/zip.ts:115` | `workbook.test.ts`: "understates what a part expands to" |
| S7 | High | **Legal holds did not stop the recycle-bin purge.** Retention honoured holds, but the six-hourly purge permanently erased deleted records whatever holds were open. | A new `server/services/holds.ts` answers "is this held?" for every path that erases data. `purgeDeleted` keeps held records and attachments in the bin and reports how many it kept (`server/services/records.ts:402`). Deleting a held record still moves it to the bin, where it stays restorable, because nothing is erased. | `retention.test.ts`: "recycle-bin purge keeps whatever a legal hold covers" |
| S12 | Medium | **Removed members kept their claims.** Removing someone from a team left their claims on its work, and holding a claim is enough to read and act on a case, so a former member kept both. | Removal releases every open claim they held in that team and records a `released` event with the reason (`server/services/org.ts:77-88`). Closed cases keep their holder, because that is how the person's own record credits finished work. | `org.test.ts`: "lets go of the team work they were holding" |
| D15 | Medium | **Procedure verification could be skipped.** A case that follows a procedure resolves only after "condition cleared" is verified. The stage and action paths enforced that; `PATCH /api/work/items/:id {state: "resolved"}` did not. | One `requireVerification` check (`server/services/cases.ts:75`) is called by every path that resolves work, including `server/services/work.ts:439`. | `cases.test.ts`: "nor can setting the state directly" |
| S9 | Medium | **Join codes could hand out roles without role authority.** A join code could grant a role to anyone with *manage members*. Emailed invitations and direct grants need *manage roles*, so a Team leader could hand out roles they could not grant by hand. | Role-granting codes now need *manage roles* and a position above the role, or team ownership. Unit Leader cannot be handed out by code. `server/services/invites.ts:80-92` | `people.test.ts`: "a join code grants a role only as the same authority" |
| S10 | Medium | **Restarting authenticator setup switched MFA off.** Starting setup while an authenticator was already on set it off at once, so an abandoned setup left the account on a password alone. | Setup refuses to start while an authenticator is on. Replacing one means turning it off first, which asks for the password again and is audited. `server/routes/me.ts:175` | `auth.test.ts`: "Starting setup again must not switch off…" |
| S14 | Medium | **The email sanitizer did not encode quotes in attribute values.** A value written in single quotes or none could carry a `"` that ended the attribute and added a `style`, enough to cover the page. The content security policy already blocked scripts. | Attribute values are encoded for double quotes and apostrophes as well as markup. `server/lib/sanitizeHtml.ts:49` | `correspondenceParsing.test.ts`: "a quote inside a single-quoted or bare value" |
| S4 | Low | **Authenticator codes could be replayed.** A code stayed valid for its whole ±1-step window (up to 90 seconds) after its owner had used it. | A code signs somebody in once (`server/auth/totp.ts:60`, `server/routes/auth.ts:161`). This is kept in memory, which suits one process; a restart inside the window is the only gap. | `auth.test.ts`: "a code signs somebody in once" |
| S11 | Low | **The password-change form was an unmetered oracle.** It checked the current password without the limiter that sign-in and step-up use, so an open session could guess it without limit. | It reads and feeds the same per-account meter. `server/routes/me.ts:121` | `auth.test.ts`: "cannot be used to guess the current password without limit" |
| S17 | Low | **Evidence links were checked against a denylist.** `java\tscript:`, other control characters and schemes not on the list (`file:`, `blob:`) got through. | An allowlist (`http`, `https`, `mailto`, or no scheme) that reads the link the way a browser does (`shared/schemas.ts:42`). The record page also refuses to render an unsafe link stored before this change. | `shared.test.ts`: "an evidence link is allowed by its scheme" |
| S16 | Low | **Signed-in help requests could name any team.** Anyone could fill any team's support queue. | A request may name only a team its author is on. `server/routes/support.ts:72` | `support.test.ts`: "names only a team its author is on" |
| — | Low | **The MARADMIN feed download had no size cap.** | It is read up to 8 MB and refused past that, declared or not. `server/services/maradmins.ts:117` | `workbook.test.ts`: "a remote feed is read only up to its cap" |
| D14 | Low | **Drafting a record from work skipped the per-person record limit.** | The same capacity check as direct entry applies. `server/services/work.ts:561` | `workbench.test.ts`: "counts against the same per-person limit" |

## Security: open

None of these lets a signed-in person reach data outside their permissions. Each needs either a
configuration the owner controls or a product decision.

| # | Severity | Finding | Recommendation |
| --- | --- | --- | --- |
| S1 | Medium (configuration) | **Production protections depend on one variable.** They switch on only when `NODE_ENV=production`: a required strong secret, a setup token, HTTPS public URL and secure cookies. A server started without it accepts a built-in development secret, and its setup is open to the first visitor. The `Dockerfile` and `render.yaml` both set production. | Keep deployments on those files, or refuse to start on a non-local address without it. Changing that default changes how development runs, so it is left to the owner. |
| S2 | Medium (configuration) | **`VANTAGE_OPERATOR` trusts a username.** It grants owner authority to whoever holds the named username when the server starts. If self-registration is on and that username has not been taken yet, anyone can take it. | Name only accounts that already exist, and keep self-registration off in production (`render.yaml` does). A stronger fix would match on account id rather than username. |
| S3 | Low (by design) | **The team list is visible to every account.** Any signed-in account sees every team's name and size (never its people), as requested. With self-registration on, which is the default outside `render.yaml`, that includes anyone who makes an account. | Keep self-registration off where team names are sensitive. |
| S5 | Low | **Account existence leaks through passkeys.** The passkey sign-in options answer differently for an existing username. | Return decoy options for unknown usernames. |
| S6 | Low | **Lockout can be used against a known username.** Anyone who knows a username can lock that account's password sign-in for 15 minutes. | This is the usual trade-off of per-account throttling. A passkey still signs the person in. |
| S8 | Low (product) | **Counselors keep access after leaving.** A counselor keeps reading and editing counselings they wrote after they leave the team. | Decide whether authorship should outlive membership. |
| S15 | Low | **Workbook parsing can be slow on crafted input.** A few regular expressions in the workbook XML reader are super-linear on crafted input. S13 now bounds the input. | Replace them with a streaming tokenizer if large workbooks become common. |
| — | Low | **Minor hardening gaps:** <ul><li>The offline outbox in IndexedDB is not cleared at sign-out. This matters on shared devices.</li><li>Telemetry accepts any unit id.</li><li>The owner console edits a person's profile without asking for the password again.</li></ul> | Clear the outbox at sign-out, check telemetry unit ids against the person's teams, and require step-up for profile edits in the owner console. |
| D10 | Low | **Certificate accounts cannot step up.** Accounts made by certificate sign-in have no password, so after the first ten minutes they cannot complete step-up. | Accept the certificate as step-up in proxy mode, or offer a passkey. |

## Discrepancies: fixed

| # | What was wrong | Fix |
| --- | --- | --- |
| D8 | **Instance moves dropped whole tables.** The whole-instance export left out ten tables, so a move silently lost them: comments, the help queue, join codes and their uses, retention schedules, legal holds, the disposition history, and the personnel roster and its runs. | All are exported in foreign-key order (`server/services/exports.ts:25`). A test now fails if any table is neither exported nor deliberately left behind (sessions, one-time tokens and demo workspaces). |
| D11, D12 | **Retention's destroy was incomplete or failed.** It left a record's attachments and comments behind. For projects it failed on the work items' foreign key. | Destroy and the recycle-bin purge now share one eraser, `eraseRecords` (`server/services/records.ts:375`). |
| D13 | **An oversized saved view broke the list.** Its settings were cut at 8,000 characters into invalid JSON, and the view list then failed for the whole team. | Oversized settings are refused. A view already stored broken reads as empty. |
| D14 | **Record limit.** See the security table. | |
| D7 | **The AI-lock notification linked to `/operator#ai`.** The owner console reads `?tab=`. | It links to `/operator?tab=ai`. |
| D17 | **The service worker cache name had not changed since 2026-09-17.** Open clients could keep an old app shell. | Bumped. |
| D1 (copy) | **The Team page told people to join with a code**, which the interface has no way to enter. | The copy now says to ask a leader to add them or send an invitation. |

## Discrepancies: open

| # | Finding | Recommendation |
| --- | --- | --- |
| D1 | **Join codes have no interface.** They have a full server feature (create, list, revoke, preview, join) and no screen to create or enter a code. | Add both to Team and People, or remove the routes. |
| D2 | **The help queue has no interface.** It has public and signed-in requests, replies, assignment and a *work the support queue* permission, and no screen. Its notifications link to `/support/:id`, which does not exist. | Build a Support page, or stop issuing those notifications. |
| D3 | **Certificate sign-in has no button.** `POST /api/auth/cac` has no caller in the client. With `CAC_EXCLUSIVE` set, nobody can sign in through the interface. | Add the button to the sign-in page when the server reports certificate mode. |
| D4, D16 | **Mailbox connectors cannot be authorized.** Connectors can be created, but nothing in the product completes an authorization, and sync has no button. The README describes mailbox sync as available. | Finish the authorization flow, or describe connectors as not yet available. |
| D5 | **The demo's sample CSV** is served but not linked anywhere. | Link it from the demo's import step. |
| D6 | **Dead code.** `eventCatalog` and `updateMembership` are unused, and `GET /api/me/prefs` has no caller. | Remove them. |
| D9 | **A catalogued event is never sent.** The event catalogue lists `quality.duplicate_suspected`, and nothing emits it. | Emit it where duplicates are detected, or drop it from the catalogue. |
| D18 | **`.env.example` is incomplete.** It does not document every variable the server reads. | Generate it from `server/config.ts`. |

## Verified sound

These were checked specifically and hold:

- **SQL.** Table and column names come only from fixed lists, and every value is a bound parameter. There is no string-built SQL from input.
- **No server-side request forgery.** The server fetches only addresses set in configuration: the AI endpoint, the MARADMIN feed and the email provider. The mail connector is restricted to its provider.
- **Uploads.** Uploads are checked by type, file signature and extension. They are served as downloads with `nosniff`, never inline.
- **Visibility rules hold everywhere.** Comments follow the visibility of the record they are on. Reports, analytics and metrics count only records shared with the team when they read across people. Report Studio cites only records its author can read.
- **Sign-in:**
  - passkeys require user verification and check their signature counter;
  - the certificate proxy's secret is compared in constant time;
  - passwords use scrypt;
  - MFA secrets are encrypted with AES-GCM;
  - sessions are stored as digests;
  - cookies are `httpOnly` and `SameSite=Lax`, and `Secure` in production.
- **CSRF.** Every state-changing request needs the client header, which another site cannot set without a preflight.
- **Content security policy.** Scripts only from the app itself, no third-party origins.
- **The service worker never caches `/api`.**
- **The container runs as a non-root user.**

## Keeping this current

`code-map.md` is a snapshot of the source on the date above, and goes stale as the code changes.
After large changes, check it against the source or rebuild it.
