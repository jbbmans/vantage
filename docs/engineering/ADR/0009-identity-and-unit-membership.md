# ADR-0009 · One identity, many unit memberships

**Status:** accepted · **Date:** 2026-10-08 · **Builds on:** [ADR-0006](0006-centralized-tenancy-and-authority.md), [ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md), [ADR-0008](0008-unit-instance-data-isolation.md)

## Context

The governing specification (VANTAGE_CLAUDE_MASTER.md, Task 3) asks Vantage to separate a person's
identity from their unit membership. It should preserve one identity through transfers, model
membership historically, prepare approved CAC/PIV integration, inspect the existing mTLS and proxy
approach, keep development and test sign-in out of production authentication, and keep the session
and security hardening already in place. It is done when an identity persists while its memberships
change safely.

An inspection of the identity and membership code found the separation half built:

- **The account was already the identity.** `users` holds the id, username, email, password hash,
  passkeys, TOTP, `edipi` and `oidc_subject`. Records point at `users.id`. A membership
  (`unit_members`) points at the account; it is never a copy of it.
- **Membership had no history.** `unit_members` holds the memberships held now, with a join date.
  Leaving deleted the row, a move replaced it, and a new billet or primary unit overwrote it. The
  audit trail recorded each event, but not in a form anyone could read as "where has this Marine
  served".
- **A transfer made a second account.** An email invitation could be accepted only by creating a new
  account, and inviting an address that already had an account was refused. A Marine moving to a new command either was enrolled
  directly, which is possible only where the new command already led them, or got a second account
  with an empty record. Join codes did work with an existing account.
- **CAC/PIV sign-in is sound and stays as it is.**
  - `direct` mode: Node terminates TLS and validates the chain against `CAC_CA_BUNDLE`. It checks
    revocation against `CAC_CRL_DIR` during the handshake (`server/index.ts`, `server/auth/crl.ts`).
  - `proxy` mode: a gateway forwards the certificate, its own verdict and a shared secret of at least
    32 characters. A request whose secret fails is treated as having no card.
  - The identity is the EDIPI from the subject alternative name, cross-checked against the common
    name. Required certificate policies fail closed.
  - Automatic provisioning creates an account only for an EDIPI the personnel roster lists.
  - What CAC/PIV lacked: a password was the only step-up, so an account a card or the roster created,
    which has no password, could never confirm a sensitive change. And a card-only deployment
    (`CAC_EXCLUSIVE`) still issued password reset links and accepted invitation sign-ups with a password.
- **Two governance gaps were deferred from Task 2** (ADR-0008, "Found in review"):
  - **Shared accounts.** An account that serves in two Unit Instances is one account. ADR-0008 left
    open which instance may unlock it, sign it out, edit its profile or feed it from a roster, and
    how the other instance learns of it.
  - **EDIPI relinking inside one instance.** An organization administrator holding `org.personnel`
    could change a member's EDIPI at will. The EDIPI is the CAC sign-in key, so this was an
    impersonation path. The attack: clear the administrator's own link, then link that EDIPI to a
    member's account, and the administrator's card signs in as the member.
- **Test sign-in.** `VANTAGE_TEST=1` turns on bearer-token sessions for the test suite. It was refused
  with `NODE_ENV=production` but accepted with any other `NODE_ENV`. The MCEN profile also ran
  without `NODE_ENV=production`, which falls back to development settings (a built-in secret, no
  setup token, cookies without `Secure`).

## Decision

### 1. The account is the identity, for a whole career

A Marine has one account. Its id, sign-in methods, EDIPI, profile and the records it wrote do not
change when its units do. Nothing in this ADR copies an account, merges two, or moves a record because
a membership changed. A membership is a relationship from a Unit Instance's unit to the account.

What a membership change does to records is unchanged from ADR-0008. Records a Marine shared with a
unit they leave stay in that unit, frozen. Their private records, career plan and personal export
stay with the account. Another command sees what the Marine shares with it from the day they join.

### 2. Membership is kept as history

Migration `018_identity_and_membership_history` adds `unit_membership_periods`. Each row is one
stretch of one membership: unit, billet, primary flag, start, end, why it started and ended, and who
started and ended it.

- **The database writes it.** Triggers on `unit_members` keep it, so the history is complete whatever
  path changed a membership:
  - an insert opens a period;
  - a change of billet or primary flag closes one period and opens the next;
  - a delete closes the open period.
- **The application names the reasons.** In the same transaction, `server/services/membership.ts` adds
  the reason and the actor:
  - start reasons: `enrolled`, `invitation`, `join_code`, `roster`, `roster_restored`, `transfer`,
    `account_import`, `unit_created`, `leader_assigned`, `demo`;
  - end reasons: `removed`, `removed_from_instance`, `roster_separation`, `transfer`, `left`.
  - The triggers name `billet_changed` and `primary_changed` themselves. A path that names nothing
    still leaves a dated period.
- **The migration starts it from what exists.** Each existing membership gets one open period from
  its join date, with the reason `recorded`.
- **A move leaves one clean entry.** `moveMember` now leaves the old team with the primary unit
  unplaced and lets the new team take it. Each team's history then shows one move, not a
  primary-unit shuffle followed by an end.
- **Archives.** An instance archive carries the history. `importInstance` lifts the triggers while it
  loads, then opens a period for any membership the archive brings without one.
- **Who reads it.** The history is read only within the boundary ADR-0008 draws:
  - the person reads all of it, on their own page and in their personal export;
  - a leader reads the part in units of their own Unit Instance they can open (`GET /api/org/team/:userId`);
  - an organization reads its own part through `GET /api/orgs/:orgId/members/:userId/history`,
    including a former member's;
  - nobody learns from it which other commands a Marine served in.

### 3. A transfer accepts an invitation into the existing account

`POST /api/auth/invite/claim` accepts an email invitation into the account that is signed in.

- An invitation sent to an address is for the account holding that address. Any other account is
  refused (`invite_other_account`).
- The unit must still exist. A person already in it is refused (`already_member`).
- The claim needs a recent sign-in or confirmation (`requireSudo`), because joining another Unit
  Instance widens who governs the account.
- The self-reach guard on join codes applies: an organization administrator cannot accept their own
  invitation into a role that reads records.
- `addMember` never takes a primary unit held in another instance (ADR-0008). So a Marine invited
  across instances keeps their old primary unit until the old command releases them, and it then
  passes to the new one.

`POST /api/auth/invite/accept` now refuses to make a second account for an address that already has
one (`account_exists`). The sign-in page tells the person to sign in and accept there. Leaders can now
invite an address that already has an account, which is what makes a transfer possible. A leader holds
the invitation link, so opening it still tells them whether the address has an account, as the refusal
did before; that is no new exposure. The web app opens `/invite?token=…` signed in as an acceptance page, and returns
there after sign-in by password, passkey, CAC or the organization's provider.

### 4. A proven EDIPI is the person's sign-in key

`users.edipi_verified_at` records when the account's current EDIPI was last proven. The following
prove it:

- the person's card signing in or stepping up;
- automatic provisioning from the roster;
- the organization's identity provider asserting it in the configured EDIPI claim.

Migration 018 backfills it from the audit trail. It counts only `cac_verified` and `cac_provisioned`
entries whose detail names exactly the EDIPI the account carries now. Any other EDIPI was typed in by
someone and stays unproven.

- **Once proven, no Unit Instance moves or clears it.** That holds even for the administrator's own
  account, which closes the "free my card, link it to you" path (`edipi_verified`).
- **An unproven EDIPI can still be corrected by the person's own Unit Instance.** Correcting it
  resets the proof, ends the account's sessions, and notifies the person that a card was linked.
- **Vantage support corrects a proven EDIPI.** `POST /api/platform/accounts/:userId/edipi` requires
  `platform.accounts` and a recent confirmation, like every platform call. It takes a reason of at
  least ten characters and refuses an EDIPI another account carries. It clears the proof, ends every
  session, writes `edipi_corrected` to the audit trail and notifies the person. The admin dashboard
  shows each account's link and whether it is proven, with a **CAC link** action.

**Residual risk, accepted for now and named in INFRASTRUCTURE_QUESTIONS I-25.** The *first* link of an
EDIPI that was never proven is still trusted to the person's own Unit Instance (`org.personnel`). An
administrator with an unproven link of their own could clear it and link that EDIPI to a member who
has none. Three things limit this:

- the member is notified at once, and the link is audited;
- the member's own card no longer signs in to their account, because the account now carries another EDIPI;
- a card sign-in proves the EDIPI and locks it.

Closing it fully needs something outside the instance to vouch for the pairing of person and EDIPI,
such as the enterprise identity provider or a DEERS-sourced roster. That is an MCEN approval question,
not a code change.

### 5. A card confirms a sensitive change

`POST /api/auth/cac/step-up` grants the same ten-minute confirmation window as a password step-up.

- **Same card checks as sign-in.** It reads the card the same way: TLS handshake and CRL in `direct`
  mode, the gateway's verdict and shared secret in `proxy` mode.
- **The card must match the account.** The card must carry the EDIPI the signed-in account carries.
  Somebody else's valid card is refused (`cac_mismatch`), and so is any card on an account with no
  linked card (`cac_unlinked`). Refusals are audited (`cac_step_up_refused`) and rate limited with
  sign-in. They return 403, so a refusal does not sign the browser out.
- **A successful step-up proves the EDIPI.**
- **The dialog offers what the account can use.** `GET /api/me` returns `session.stepUp`: password
  where the account has one and passwords are accepted, card where one is linked and cards are on. The
  confirmation dialog shows those choices. With neither, it asks the person to sign in again, which
  confirms too.
- **Gateway configuration.** The nginx `location /api/auth/cac` in docs/cac-and-records.md is a prefix
  match, so it already forwards the certificate for the step-up path. `direct` mode requests a
  certificate on every connection.

`CAC_EXCLUSIVE` and `VANTAGE_OIDC_EXCLUSIVE` now refuse every password path:

- sign-in and registration, as before;
- the forgotten-password request and the reset itself;
- creating an account from an invitation;
- the emailed sign-in details;
- password step-up, under `CAC_EXCLUSIVE`.

Under `VANTAGE_OIDC_EXCLUSIVE` a password set earlier still confirms a step-up, because the provider
offers no step-up yet.

### 6. A shared account is governed once

An account with authority beyond a Unit Instance either serves in another instance or holds a
platform role (`authorityBeyond` in `server/services/identity.ts`). Weakening its protection or
rewriting its identity is not one instance's to do:

| Action | Rule |
|---|---|
| Link or change its EDIPI | refused to the instance (ADR-0008); Vantage support corrects it |
| Unlock it | refused to the instance (`cross_instance`); the lock lapses, a reset link lifts it, or Vantage support does |
| Edit its profile (name, rank, MOS, EAS) | only the instance holding its primary unit; the refusal does not say where that is |
| The personnel feed updating its profile | only the extract of the instance holding its primary unit (`keepsProfile`), and the sourced fields shown are that instance's |
| Sign it out everywhere | any instance it serves in, because that only protects it; the person is notified, and every other instance it serves in gets a `shared_account_notice` in its own audit trail that says what was done but not by whom |
| Reset its password or second factor | Vantage support, as before (ADR-0006) |

### 7. Test sign-in never reaches production

- `VANTAGE_TEST=1` now also requires `NODE_ENV=test`. One stray variable no longer turns on bearer
  tokens, and production refuses it as before.
- `VANTAGE_DEPLOYMENT_PROFILE=mcen` requires `NODE_ENV=production`, except under the test suite, which
  exercises the profile. The Dockerfile and docs/deploy-mcen.md already set it.
- The admin dashboard's deployment posture lists the sign-in methods in force: password, passkey, CAC
  mode and revocation source, organization sign-in, and whether test tokens are accepted. It warns
  when test tokens are on, when an MCEN deployment has neither CAC nor organization sign-in, and when
  `direct` mode runs without revocation.

## Consequences

- `tests/server/identityMembership.test.ts` proves this decision:
  - a Marine transfers between two Unit Instances and keeps their account id, EDIPI and records;
  - every membership change is recorded, with reasons and actors;
  - each side reads only its own part of the history;
  - invitation acceptance is bound to the address, works once, needs confirmation and is guarded
    against self-reach;
  - the proven-EDIPI lock and support's correction work as described;
  - shared-account unlock, sign-out, profile and feed governance work as described;
  - archives round-trip the history;
  - CAC step-up refuses forged, mismatched and unlinked cards;
  - card-only mode closes every password path;
  - the configuration refusals hold;
  - migration 018's backfill is correct.
- **Behavior changes:**
  - Inviting an address that has an account now succeeds.
  - Accepting such an invitation by creating an account returns `account_exists`.
  - A Unit Instance can no longer unlock an account that also serves elsewhere or runs the service.
  - A Unit Instance can no longer change the profile of a Marine whose primary unit is in another.
  - An organization can no longer change a proven EDIPI, its administrators' own included.
  - Card-only deployments no longer send reset or sign-in-detail emails.
- **Not built here:**
  - **Step-ups.** Organization sign-in step-up (re-authentication at the provider) and passkey
    step-up are missing. An account with neither a password nor a card signs in again to confirm.
  - **Self-service card linking.** A person signed in another way cannot present their card to link
    it. Their Unit Instance links it, and their first card sign-in proves it.
  - **Owner console view of member history.** The owner console does not show a member's history
    yet. The API is in place, and the person's page and a leader's view of a Marine show it.

## Alternatives considered

- **Building the history in the application only.** Every path that changes `unit_members` would
  have to remember to write it. There are at least ten such paths (enrollment, invitations, join codes,
  the roster feed and its restore, moves, organization removal, archiving a unit, account import,
  demo seeding), and a missed one would leave a silent gap. Triggers make the history complete. The
  application adds meaning when it has it.
- **A copy of the account per Unit Instance.** This would make isolation trivial and identity
  meaningless: two sign-ins, two EDIPIs to keep in step, and a record split at every transfer. ADR-0006
  already chose one account; this ADR keeps it.
- **Locking every EDIPI to Vantage support from the start.** This closes the residual risk in
  section 4, but it makes support a bottleneck for every new member of every command and routes their
  sign-in key through people with no tie to the command. The proof lock gives the same protection the
  moment a card has been used, and leaves the first link with the command that knows the person.
