# Vantage hardening candidate: implementation and handoff

Baseline: `b1892945a9d6fccceb2b7cc5cba8948d9c7d0dbc` from `jbbmans/vantage`.
Working branch: `codex/cradle-to-grave-hardening`.
This is a tested engineering candidate, not a statement that the product is perfect or authorized for operational Marine Corps data.

## What changed, including the small details

### Dependencies and delivery checks

1. Update Express to 5.3, reaching the patched body parser and proxy-address dependencies through the lockfile.
2. Update Nodemailer to 10.5 and Zod to 4.6.7.
3. Resolve patched `body-parser`, `proxy-addr` and `qs` versions; keep their integrity hashes in the lockfile.
4. Update compatible development tools, including Vite, selector parsing and source-map parsing.
5. Scope a Minimatch 11 override to TypeScript ESLint's parser dependency, because its declared 10.x range still selects an advisory-affected version. Remove the override when upstream accepts a patched version; keep lint/typecheck checks as compatibility guards. Do not downgrade TypeScript ESLint to satisfy an automatic audit suggestion.
6. Update the four pinned Remotion packages together to 4.0.543 in the separate film project; retain their existing licensing model.
7. Resolve patched film URI and source-map dependencies in its own lockfile.
8. Audit both dependency trees in CI. Publish separate application and film bills of materials.
9. Add a reproducible inventory command and a CI inventory artifact. Every tracked/nonignored file is hashed; text lines and function syntax are counted. This is not a claim of manual review or executed-line coverage.

### Request and validation boundaries

10. Let the actual privileged `/api/platform/import` route own its large JSON parser, rather than letting the ordinary 4 MB parser consume it first.
11. Anchor every special-parser exemption to the exact upload/import route, allowing an optional trailing slash. Preserve authentication before the large platform import parser.
12. Return explicit 415 errors for unsupported character sets and content encodings, and a 400 error for invalid body size.
13. Retain ordinary request size limits, JSON parse errors and legitimate compressed requests.
14. Forward an error after response headers have already been sent, preventing a second attempted JSON response during a failed stream/download.
15. Validate real calendar dates for observations, external events and waiting deadlines, reusing the established date validator.
16. Bound validation responses to 25 fields, 160 characters per field path and 400 per message.
17. Safely represent reserved field names such as `__proto__` without changing an error object's prototype.

### Work queue and case integrity

18. Add typed shared contracts for bulk actions, selected versions, candidates and per-case results.
19. Add preview, apply and eligible-recipient routes behind existing authentication and scope checks.
20. Limit a request to 100 distinct cases and validate action, IDs, integer versions and note lengths.
21. Require a recipient and a useful handoff note for assignment.
22. Keep preview read-only and return generic unavailable messages for inaccessible/nonexistent cases.
23. Refuse closed cases, stale versions, cases held by someone else and unauthorized release/reassignment.
24. Verify each active recipient's own read and claim permissions; a list of names is never authority to assign.
25. Return partial success and individual refusal reasons, preserving unsuccessful work for review.
26. Reuse existing claim, release and handoff transactions, sealed history, notifications and audit behavior.
27. Bind bulk retry keys to actor, case, operation and parsed payload; persist them with the sealed event.
28. Detect conflicting reuse of a retry key; recognize an identical retry without repeating history or changing a later holder.
29. Check current read access before returning a previous research entry. Prior access does not survive membership removal or a case transfer.
30. Bind new research-entry retry keys to payload fingerprints; preserve legacy retries for events created before fingerprints existed.
31. Stop appending release history or incrementing versions when an authorized release finds nobody holding the case.
32. Refuse release of a held, closed case.
33. Cache recipient scopes within one bulk candidate request, avoiding repeated permission reconstruction for the same Marine.
34. Add a preview/apply dialog with explicit ready/applied/unchanged labels, bounded notes, a busy state and recoverable errors.
35. Freeze selected case versions when the dialog opens; automatic refresh cannot change the reviewed payload.
36. Keep a stable request key for a retry after a network/server error, and explain how to retry safely.
37. Leave failed cases selected when they remain in the current view; remove selections that no longer belong to that view after closing the dialog.
38. Suspend queue keyboard shortcuts while the bulk dialog is open.
39. Provide phone card checkboxes with touch-sized labels, visible selection styling and separate case-opening controls.
40. Name the desktop selection column for assistive technology.
41. Refresh visible queue and assigned-work queries every 30 seconds; cancel abandoned reads and pause periodic polling in hidden pages.
42. Mark automatic reads as background requests so they do not keep idle sessions alive; explain refresh behavior in the queue.
43. Expose the existing server capability for sharing a saved queue view, offering only authorized units and defaulting to private.
44. Prevent duplicate saved-view submissions, disable controls while saving and match the server's 80-character name limit.

### Authentication, sessions and update notices

45. Add migration 034 and the bounded, indexed pending-passkey table; preserve existing rows and credentials.
46. Scope challenges to their database and purpose, expire them after five minutes and consume them atomically before verification.
47. Preserve a pending passkey operation across process restart, without presenting that as general multi-process support.
48. Exclude challenges from portable/personal exports and row-loss accounting; classify every new column in the privacy inventory.
49. Clear pending challenges during restore/import and prune expired challenges with session cleanup.
50. Atomically consume account tokens and refuse a token at its exact expiry boundary.
51. Retain the server session deadline before the idle guard mounts, so the first response is not lost.
52. Show errors and a busy state for the stay-signed-in request.
53. Correct the idle warning: unsaved text/temporary drafts clear at sign-out. Do not extend sensitive browser retention as an implicit recovery mechanism.
54. Reject an unreadable successful JSON response instead of silently reporting a successful null result; tell the person to check the outcome before resubmitting.
55. Validate the stored theme choice and fall back to the system preference for unknown values.
56. Advertise CAC/organization sign-in on the login panel only when that method is configured.
57. Stamp the served HTML documents and service worker with a shared build identity, including changes in console/admin/public documents.
58. Compare update checks to the build actually loaded by the page; detect a newer server on the first health check.
59. Bound update-check network time, prevent overlapping checks, skip hidden pages and abort on unmount.

### Operations, documentation and verification

60. Prevent a scheduled job from overlapping itself within a process, release its running flag after failure and expose running/skipped state.
61. Correct the README navigation and distinguish algorithm choice from deployment cryptographic validation and configured malware scanning.
62. Correct stale security documentation about OIDC and case-history chains; retain the administrator/key-control limitation.
63. Document the supported single-process SQLite topology, migration/rollback consequences, and what remains process-local.
64. Add regression tests for bulk authority, partial results, retry collisions, later-holder preservation and sealed-history integrity.
65. Add request/parser, bounded-error and impossible-date regression tests.
66. Add restart, wrong-purpose, expiry, capacity, isolation and single-use authentication tests.
67. Add scheduled-overlap/failure tests and update schema-version expectations.
68. Add desktop/phone browser specifications for preview-before-apply and stale-version refusal.
69. Add a pilot, measurement, ownership-review and adoption packet for command review. It does not send messages, assign intellectual property or enroll the project in a competition.
70. Refuse malformed/newer schema-version metadata before applying base schema changes, closing the database handle on refusal.
71. Require the second-factor and email-confirmation callers to check the result of token consumption; a successful earlier lookup cannot substitute for a successful one-time use.
72. Conditionally spend recovery codes, and commit email confirmation together with token consumption and its audit record.
73. Apply the current-access replay check to the older work-action endpoint too, so a former member cannot use an old request key to retrieve a case's current content.
74. Add deterministic client-state tests for invalid success responses, cancellation, early session deadlines and corrupt theme preferences.
75. Separate browser composition and Node film-entry typechecking, declare the generated capture/score asset contracts without creating placeholder assets, and add the film composition check to CI. Full video rendering still requires its browser/media prerequisites.
76. Refresh both Docker stages to the current official Node 22 Bookworm slim digest and apply Debian security updates during builds; retain the final scanned image digest.
77. Remove unused npm/npx/Yarn/Corepack from the runtime image, preserve them in the build stage, and document direct Node operational-script invocation.
78. Give the private film package explicit version metadata so its CycloneDX bill of materials can be generated.
79. Preserve extended CodeQL analysis as a retained SARIF artifact, leave repository default setup responsible for alert uploads, and document the explicit advanced-upload switch rather than masking GitHub's conflicting-setup failure.
80. Run the new bulk-work browser specifications as a focused CI smoke check before the full browser suite, so a new-flow failure is reported promptly.
81. Invoke the focused browser check through the npm browser-test script so its required production-build prehook runs on a clean CI checkout.

The PDF includes the complete patch, including lockfile changes, and a per-file inventory. These numbered entries explain intent; the patch is the exact minor-edit record.

## Verification and release handoff

Run `npm ci`, `npm run check`, `npm audit`, `npm --prefix film ci`, `npm --prefix film audit`, and the browser suite on a supported runner. The PDF records the observed counts/results and any unexecuted checks. Browser launch restrictions in a review workspace are not evidence that browser behavior passed.

No production data was opened or migrated. No production deployment, DNS change, merge, ownership transfer, submission or message to the chain of command is part of this branch.

The patch preserves the existing permission bits, three authority tiers, database adapter, financial controls, append-only history and private-record boundaries. Existing upload parsers, backup/restore tools, report generators and personnel services were reused rather than replaced merely to increase the size of the rewrite. No new runtime dependency or direct integration with an authoritative finance system was introduced.

## Deployment, rollback and support

1. Use a staging copy with synthetic or explicitly authorized data; take and verify a consistent pre-upgrade backup. Keep the secret and the matching baseline build recoverable through approved operations controls.
2. Run CI, smoke tests, a real passkey/CAC/SSO check as applicable, and a restore rehearsal. Check scanners, proxy headers, timezones and identity-provider settings on the intended host.
3. Start the candidate. Migration 034 adds only the pending challenge table/index. Check migration history, account/record counts, audit and case integrity, and operations health.
4. Exercise import preview/reimport, claim/release/handoff, stale versions, a partial batch, record visibility, reporting, attachments, sign-out and retry after loss of connectivity. Confirm that background reads do not renew an idle session.
5. Pilot with a named command sponsor, data owner, host operator, support owner and stop criteria before wider rollout. Operations must schedule backups and retain verified off-host copies; backup age monitoring does not create backups.
6. If rollback is necessary, enter maintenance, stop writers, preserve the failed candidate's database/logs, and assess work since the backup. Follow the supported restore runbook using the matching build. Reconcile actions after the backup. Do not edit schema-version metadata to force an old binary to open schema 034.

## Remaining work requiring additional evidence or decisions

These are recommendations and release conditions, not implemented capabilities:

- MCEN/RMF/authorizing-official decisions, data categorization, privacy/records determinations, approved hosting and identity-provider enrollment.
- Independent penetration testing, authenticated accessibility testing on assistive technology, actual-host/browser/CAC validation, disaster-recovery exercises and agreed performance targets.
- A production PostgreSQL migration if the approved central deployment requires it: refactor synchronous transaction/service boundaries, translate every SQL statement and trigger, preserve seals and money types, build migration/reconciliation tooling, exercise rollback and prove concurrency. A connection-string change cannot accomplish this.
- Multi-process scheduling leases, distributed rate limits, durable cross-process presence and a supported high-availability topology if that scale is approved. The new overlap guard is process-local.
- Approved external integrations and service credentials for DAI/GCSS-MC/Advana/M365, with data-owner and access-control agreements; no invented endpoints or permissions.
- User research with junior analysts and leaders, error-rate and task-time baselines, measured adoption, and a funded support/maintenance owner.
- Written ownership, outside-activity and contracting guidance before commercialization or accepting terms that affect the government's rights.

Read [the pilot and career packet](pilot-and-career-packet.md) and [ADR-0026](engineering/ADR/0026-workflow-and-auth-continuity.md).
