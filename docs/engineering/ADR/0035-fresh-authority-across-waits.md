# ADR-0035 · Fresh authority across waits, one rule for contacts, and organization sign-in bound to its browser

**Status:** accepted · **Date:** 2026-11-18 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md) (the
Unit Instance boundary), [ADR-0013](0013-security-audit-least-privilege.md) (sessions, step-up, audit),
[ADR-0020](0020-reports-printable-output.md) (reports and the export line), [ADR-0025](0025-training-evidence.md)
(scanned uploads)

## Context

The security review `Vantage_MCEN_Security_Review_and_Coding_Plan.pdf` (17 November 2026, made at `d8471cb`) confirmed
six findings and asked that their fixes come first (its Stage 1: C01 to C05 and C26). Every cited line was read again
on `2d83940`, where all six were still present:

| Finding | What happened |
|---|---|
| F01 | A thread's list row and detail carried its contact's current name, organization, email, phone and notes to every reader of the thread, whether the contact was private, removed or shared with another unit. |
| F02 | Anyone with `MANAGE_RECORDS` in a contact's unit could edit it whatever its visibility, so a manager could rewrite a private contact and share it again. Edits had no version check and no audit. |
| F03 | An organization (OIDC) sign-in's state, nonce and PKCE verifier lived only on the server: its callback completed in whichever browser presented the URL. |
| F04 | Password sign-in, step-up, password change and passkey sign-in read the account before awaiting the proof's check and acted on that read afterwards: a reset and session wipe during the wait did not stop the old password opening a session. |
| F05 | Who may export a report was decided before the export line; the queued work then read data with the authority captured at the request, and the file was sent without asking again. |
| F06 | After a malware scan, an attachment or saved message was kept if its session row existed and its account was open; the session's idle and absolute deadlines were not checked. |

C06 (one policy for which sign-in methods an instance allows) is also P0 in the review, but it needs the identity owner
to choose the methods, so it is not part of this decision.

## Decision

### 1. One question for "is this session still good, now", asked without renewing it

`liveSession(ctx, sessionId, userId?)` (`server/auth/sessions.ts`) answers it: the session exists, its account is open,
neither deadline has passed (at the very instant of a deadline it still stands, exactly as `resolveSession` decides,
through the same `pastDeadline`), it was opened under its account's current authentication epoch (§2), and it is
`userId`'s when one is given. It reads the row whether or not pruning has run, and it never extends the session: a
scanner answering is not the person using Vantage. `sessionStands` is that check as a yes or no.

`freshAuthority(ctx, sessionId, userId)` (`server/auth/fresh.ts`) is what a request has after a wait: the live session,
the account as it stands (`currentSessionUser`), and a scope built afresh rather than from the request's cache. A
session that no longer stands is a 401, as the next request on it would be. What the caller may do with its resource is
then decided again by the caller's own rule.

Every continuation that awaits something outside the database before writing or answering asks one of these after the
wait:

| Continuation | After | Asks |
|---|---|---|
| Attachment upload, saved-message import | the malware scan | `sessionStands`, then the record's or unit's own placement rule (F06) |
| Record import staging, work intake upload | the malware scan | `sessionStands`; intake also places the file again on a fresh scope |
| Report center export | its turn in the export line, and again once the file is drawn | `freshAuthority`, then the export target and formats again; the second answer must cover the first (§3) |
| FITREP/JEPES input and analysis PDFs | the render | `freshAuthority`, then the Marine is still one the reader may report on |
| Counseling worksheet PDF | the render | `freshAuthority`, then the counseling is still the reader's to read |
| Full database backup (Vantage Administrator console) | the copy | `freshPlatformAuthority`: live, still confirmed, still holding `platform.data`; a refused copy is deleted, and the other Vantage Administrators are told of a copy only once it is handed over |
| Course catalog import | the malware scan | `freshPlatformAuthority` for `platform.settings`, inside the transaction that stages the load |
| AI assist | the provider's answer | `freshAuthority`, then the workflow's own payload rule again on that authority (`assertAiInputStillAllowed`) |
| Mailbox sync | each page from Microsoft Graph | `freshAuthority`, then the thread placement again, then the mailbox read again (still the reader's, still connected, still read-only), before anything on the page is stored |
| Password sign-in, step-up, password change, passkey registration | the password check or the passkey verification | the epoch (§2); passkey registration also its confirmation (`assertConfirmedProof`) |

### 2. An authentication epoch

Migration 041 adds `users.auth_epoch` and `sessions.auth_epoch` (integers, default 0, never negative).
`invalidateUserSessions` already ran on every security transition (a password changed or reset, a second factor reset,
an account deactivated or separated, a role or a seat changed); it now advances the account's epoch in the same
transaction as it deletes the sessions, and re-stamps the one session it keeps, so the person who made the change stays
signed in. A session stands only while its epoch is its account's.

A proof carries the epoch it began under:

- **Password sign-in** reads the account again after the check. A moved epoch or a closed account refuses
  (`401 credentials_changed`, audited as `login_failed` with "the account changed while it was checked"). A second
  factor turned on meanwhile is asked for, because the account is read as it now stands.
- **The TOTP challenge** carries the epoch it was issued under. One issued before a reset, a second-factor reset or a
  session wipe is spent unanswered (`challenge_expired`), as is one issued before the epoch existed.
- **Passkey sign-in** captures the epoch with the passkey and requires the passkey still to be there when its counter is
  written.
- **`createSession`** takes the epoch and refuses in the same transaction as its insert if the account moved on.
- **Step-up, password change and passkey registration** commit only while the asking session is live under the epoch
  the proof began under. The password change is a conditional update (`WHERE auth_epoch = ? AND active = 1`). A
  session that ended meanwhile hears 401. A session that still stands under a newer epoch (its own person signed the
  others out from it meanwhile) hears 403 `credentials_changed`, so the page asks again instead of signing out
  (`assertProofCurrent`).

Rehashing an old password, and turning an authenticator on or off, do not advance the epoch: they open nothing a proof
in flight could use, and advancing it would refuse sign-ins for no reason.

### 3. Exports and drawn files decide again before anything leaves

`exportReport` takes the session id. When its turn in the export line comes it asks `freshAuthority`, resolves the
target and its allowed formats again on that authority, and builds the document from it. After the file is drawn it
asks again, and the target decided then must cover the one the file was drawn for: the same report, the same subject,
and no unit or Marine more (`covers`). A refusal sends no file, and nothing is audited as exported. The PDFs drawn
outside the report center (§1) check at delivery the same way.

A reader who leaves while the export waits (their connection closes before the response ends) is drawn nothing when the
turn comes, and a file drawn as they leave is dropped: neither is sent, and neither is audited as exported.

A mailbox sync that is refused part way stops at that page. The pages stored before stay (each was stored while the
reader could still store it), the mailbox keeps the place it had, and it is not marked as failing; the next sync reads
from there, and anything already held is skipped. A mailbox disconnected or removed while Microsoft answered stops the
sync the same way, and every write of a mailbox's place or status after a sync is conditional on it still being
connected, so a sync that ends late never brings a disconnected mailbox back, nor marks it as needing authorization.

### 4. One rule for reading a contact, one for changing it

In `server/services/correspondence.ts`, beside the thread rules:

- **Read** (`contactReadable`, and `contactReadableSql`, its SQL twin): not removed, and the reader's own or shared
  (`visibility = 'unit'`) with a unit the reader is a member of. A thread the reader may open does not lend them its
  contact.
- **Write** (`contactWritable`): readable, and the reader's own or shared with a unit where they hold `MANAGE_RECORDS`.
  A private contact is its owner's alone, whoever manages the unit it was once shared with.

The contacts list, the thread list's join and the thread detail use only these. A thread whose contact the reader may not
read shows that it has one (`contact_hidden`, "Contact not shared with you") and nothing of it; the thread itself is
unchanged. `saveContact` checks and writes in one transaction against the version the editor read (409
`version_conflict`), answers a contact the editor cannot read as missing (404), lets only the owner make a shared contact
private (403 `owner_only`), and moves a shared contact for a manager only to a unit where they also manage records, and
never into another Unit Instance. Every create and change is audited (`create_contact`, `edit_contact`) by the kind of
change alone (`owner edited`, `unit_manager moved`, `owner unit_to_private`), never the contact's words. When an edit
is refused as stale or missing, the contact dialog closes and the list reloads, so opening it again starts from the
contact as it now stands.

### 5. An organization sign-in completes only in the browser that began it

`/api/auth/oidc/start` sets a binding cookie: `__Host-vantage_oidc` over HTTPS, `vantage_oidc` on local http,
`HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, ten minutes. Only `sha256('oidc-browser:' + binding)` is stored, in
`oidc_states.browser_hash`. The provider returns to the configured address of the face (`redirect_uri`), and the cookie
belongs to one host, so a start reached under any other host name (an alias, an IP address, the platform's own
hostname, an admin-only host) is first sent to the same path on that configured address, before any cookie, state or
rate count; the target comes from configuration, never from the request's `Host`. Only the host name is compared (a
port added by a proxy is not another host), and the redirect is made once: it carries `moved=1`, and a start that
carries it begins where it is, so a proxy that presents another name upstream cannot send the browser round in a loop. The callback checks, in this order and before the
state is spent or any account is linked, provisioned or signed in: the state is known and unused (`oidc_state`); it has
not expired (`oidc_state`; first, because the cookie lasts as long as the sign-in, so a late return carries none and
should be told it was late); the browser presents the binding it was started with (`oidc_browser`); it came back on the
same console it left from (`oidc_browser`). Parallel tabs in one browser share one binding, so each completes; a browser holds at most five pending
sign-ins; the cookie is cleared once that browser has none pending. Nonce, PKCE, issuer, audience and signature checks
are unchanged.

## Migration 041 (`041_auth_epoch`)

`tests/server/migrations.test.ts` upgrades a version 40 database holding an account, a session and a pending
organization sign-in: every row is as it was, the new columns are 0 (or empty), and the session still resolves.


Additive only, each column behind a check that it is not already there, in the migration's transaction:
`users.auth_epoch INTEGER NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0)`, the same on `sessions`, and
`oidc_states.browser_hash TEXT`. Accounts and sessions all start at 0 and still match, so nobody is signed out by the
upgrade. An organization sign-in in flight during the upgrade (ten minutes at most) has no browser hash and is refused;
the person starts again. A TOTP challenge issued before it (five minutes at most) carries no epoch and is refused the
same way. No rows are added, changed or removed. Rollback: restore the pre-upgrade backup with the previous build;
`schema_version` is never lowered. The privacy inventory records the three columns as authentication data.

## Alternatives considered

- **Holding a database transaction across the wait.** Rejected: a scan, a password check or a render can take
  seconds, and SQLite has one writer; every other request would wait behind it.
- **Renewing the session when a continuation asks.** Rejected: a scanner answering would keep a session alive that its
  person had left, against the idle limit.
- **A credential version per credential (password, passkeys, TOTP) instead of one epoch.** Rejected for now: every
  transition already funnels through `invalidateUserSessions`, and one counter there covers all of them with one check.
- **Refusing every TOTP change while a sign-in is in flight.** Rejected: re-reading the account after the check asks
  for a newly enabled factor, which is what the person wants.
- **Binding the OIDC callback by IP address.** Rejected: proxies and mobile networks change addresses mid-sign-in, and
  an address is not a browser.

## Consequences

- A new continuation that awaits outside the database (a scan, a hash, a render, a queue, a provider, a copy) must ask
  `sessionStands`, `freshAuthority` or `freshPlatformAuthority` after the wait, then its own resource rule.
  `tests/server/securityStage1.test.ts` (with the mailbox cases in `mailboxAuthorization.test.ts` and
  `correspondence.test.ts`, and the sign-in cases in `oidc.test.ts`) holds each existing one open while access changes,
  and each was checked to fail with its fix taken out. One guard is not held on its own: the condition that a mailbox is
  still connected when a sync writes its place. Nothing awaits between the last page's check and that write, so the
  per-page check refuses first and the test passes either way; the condition guards a future change that adds a wait.
- A new security transition must go through `invalidateUserSessions`, or proofs in flight will not notice it.
- A reader who could open a thread but not its contact now sees "Contact not shared with you" where the name used to be.
  A G8 leader who manages records in a team below by the chain of command, but holds no seat in that team, no longer
  edits that team's shared contacts: they never could read them.
- Passkey registration is held with a software authenticator built in the test (`softwareRegistration`). Not covered
  by a test here: passkey sign-in racing the passkey's removal; the code requires the passkey row to still be there
  when its counter is written. The contact dialog's reload after a 404 (a contact removed while it was open) is not
  driven in the browser suite; its 409 twin is.
- C06 and the rest of the review's backlog (C07 onwards, including C34's machine-readable control register) stay open.
