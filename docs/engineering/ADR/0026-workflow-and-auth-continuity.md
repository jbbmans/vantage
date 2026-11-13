# ADR-0026: Workflow retries and authentication continuity

Status: accepted and implemented (first proposed in PR #71, merged through its fix-up); deployment authorization remains separate.

## Problem

A queue selection could only be copied. Repeating an entry request could return historical content before checking current access. Passkey challenges lived in one process and disappeared on restart. Background job ticks could overlap. The interface's idle warning promised recovery that sign-out actually removed.

## Decision

Keep the existing React/Express/SQLite architecture and its three authority tiers. Add bulk claim, release and handoff through the existing case services. Accept at most 100 distinct IDs and selected versions. A read-only preview explains individual refusals; commit rechecks every case in its own transaction. Partial success is explicit. No bulk financial resolution or credit operation is introduced.

Bind retry identifiers to actor, case, operation and a SHA-256 fingerprint of the parsed payload. Persist the identifier and fingerprint with the existing sealed event. A replay requires current read access and never changes a later holder or appends another event. New research entries also bind their payload. Older entries without fingerprints retain their established retry behavior after the current-access check.

Freeze the dialog's selected versions when it opens. A visible-page poll may update the queue but cannot silently revise the request the Marine is reviewing. Unsuccessful cases still matching the view remain selected. Hidden pages do not run periodic queue/assigned-work polls. Only the timed refresh carries the existing background header, so a page left open does not extend an idle session, while the reads a person causes (opening the queue, searching, filtering, sorting, paging, returning to the tab) still count as activity. The queue's keyboard cursor follows a case id, so a refresh that reorders or removes rows cannot move it onto another case. Apply sends only the cases the preview showed as ready, and ignores taps for a moment after the preview appears.

Store pending WebAuthn challenges in an additive `passkey_challenges` table, introduced by migration 034. Registration and authentication are separate purposes. Challenges expire after five minutes, are atomically consumed before verification, and are capped at 2,000 per database. Expired challenges are cleaned with sessions and on new challenge issuance. Portable archives and personal exports exclude them; import and restore clear them. Physical backups contain the table like the rest of the database. No existing account, record, credential or financial value is reshaped.

Consume reset/invitation/second-factor/email-change links in an immediate transaction with a conditional update, so one token has one consumer. A scheduled job uses a process-local running flag and counts skipped overlapping ticks; this is not a distributed lease.

## Consequences and limits

- One service process per SQLite deployment remains the supported topology. Rate limits, scheduling and some health state remain process-local. Persistent passkey challenges alone do not establish clustered operation.
- A fingerprint establishes retry identity, not truth of the financial observation. HMAC seals establish local tamper evidence, not protection from an administrator controlling both records and keys.
- Batch work is intentionally partial rather than one all-or-nothing transaction. An infrastructure failure returns an error; retrying the same request safely recognizes earlier committed cases.
- Temporary browser drafts still clear at sign-out. The warning now says so, and retains a server expiry that arrived before the guard mounted. Recovery must not be achieved by silently extending local retention of personnel text.
- Migration 034 is additive. Rollback to a build limited to schema 033 requires the pre-upgrade backup and the matching older build; do not hand-edit schema metadata or drop tables on the live database.
- No direct write-back to DAI, GCSS-MC or other authoritative finance systems is introduced.

## Verification

The focused tests cover partial success, stale versions, unauthorized callers and recipients, unchanged sealed history on retry, restart continuity, challenge purpose/expiry/capacity, token single use, overlapping jobs, request size/encoding boundaries, real calendar dates, and bounded validation errors. Browser specifications cover preview-before-apply from the keyboard, a double tap on a touch phone, stale-version refusal and a mixed selection where only the ready case is sent. Run `npm run check` and `npm run test:browser`; the release report records what actually ran and any environmental block.
