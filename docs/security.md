# Security model

## Identities and sessions

- Usernames plus a 15-character-minimum password, checked against common patterns, hashed with PBKDF2-HMAC-SHA256 (600,000 iterations by default, `VANTAGE_PBKDF2_ITERATIONS`, at least 210,000 in production), the FIPS 140 approved choice. Hashes made with scrypt by earlier versions still verify and are replaced the next time the person signs in. Verification runs off the event loop.
- Passkeys (WebAuthn, discoverable credentials) with the site hostname as relying party. Passkeys sign in without a password.
- Organization sign-in over OpenID Connect (Entra ID commercial, GCC High or DoD, or any OIDC provider): code flow with PKCE, single-use hashed state and nonce, ID token signature and claims verified against the provider's published keys. It can be the only way in (`VANTAGE_OIDC_EXCLUSIVE`). See docs/cac-and-records.md.
- Authenticator app (TOTP, RFC 6238) as a second step for password sign-in, with eight single-use recovery codes. Each code is accepted once, and a code older than the last one used is refused. Setting up a new authenticator leaves the current one in force until the new one is confirmed.
- Sessions are random 256-bit tokens stored only as SHA-256 digests, in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie. Idle timeout 15 minutes, 10 for Vantage staff (`VANTAGE_IDLE_MINUTES`, `VANTAGE_STAFF_IDLE_MINUTES`), absolute 12 hours, at most 8 active per user. A background poll (the notification bell) is marked as such and does not count as activity, so an open tab still times out. The client is told when the session will end and asks two minutes before.
- Lockout: three consecutive failures (a wrong password at sign-in, a wrong second factor, or a wrong password at a step-up or password change) lock the account for 15 minutes (`VANTAGE_LOCKOUT_ATTEMPTS`, `VANTAGE_LOCKOUT_MINUTES`). The count is kept in the database, so a restart does not lift it. The right password does not open a locked account; a passkey, a CAC or organization sign-in still does. A Unit Manager can unlock from the Accounts tab (except an account that also serves in another Unit Instance or runs the service, ADR-0009), and issuing a temporary password unlocks too. Each lock and unlock is audited.
- Notice and consent: `VANTAGE_CONSENT_BANNER=dod` shows the standard DoD Notice and Consent Banner before sign-in, and the server refuses to create an account or a session for a client that has not accepted it. `custom` shows `VANTAGE_CONSENT_TEXT`. Off by default, because it states the conditions of a U.S. Government system.
- Step-up: sensitive changes require confirming it is you within a 10-minute window (`sudo_until` on the session): the password, or the CAC the account carries (`POST /api/auth/cac/step-up`, which refuses somebody else's card and any card on an account with none linked). The dialog offers what the account can use; with neither, signing in again confirms. A card-only deployment refuses the password step-up.
- Password change, role change, membership change, MFA reset, and deactivation revoke the affected user's other sessions.
- Accounts can be created in bulk from a roster only by a Unit Instance's Unit Managers, into that Unit Instance, after re-entering their password. Temporary passwords in the roster must meet the password policy, and every imported account has to set its own password before it can do anything else.

## Authorization

- A user always reads and writes their own records.
- Records have `visibility` of `private` or `unit`, and a `unit_id`. Only `unit` records in a unit where the reader holds `VIEW_RECORDS` are visible to others; `VIEW_MEMBER_DETAIL` opens a Marine's page; `MANAGE_RECORDS` edits shared entries; `COUNSEL` records counselings and award recommendations.
- Permissions are a bitmask on roles, and roles belong to one unit. Authority flows down the unit tree, never up: a role in a command carries into every team beneath it, one position above that team's own role of the same rank, so a command leader outranks a team leader in the team. A role in a team confers nothing in the command above it.
- Members see an overview of their own team and of each command above it: the roster, the goals, and aggregate totals. Totals built from fewer than three contributors are withheld, so an overview never reveals one person's entries. Shared records, member pages and dashboards still need `VIEW_RECORDS` or `VIEW_MEMBER_DETAIL` in that unit or a unit above it.
- Moving a Marine between teams needs `MANAGE_MEMBERS` in both teams and a higher position than the Marine in each. It runs as one transaction, is audited as `move_member`, revokes the Marine's sessions, and carries a role only where the mover may grant it.
- A role is granted, invited or put on a join code only by someone who could have defined it: it sits below their own position and carries no permission they lack. Unit Leader moves only by ownership transfer.
- Enrolling an existing account skips that person's consent, so it is limited to Marines the leader already leads (below them in a unit where they manage members). Nobody else, a Unit Instance's Unit Managers and Vantage staff included, pulls an account into a unit: everyone else joins with an invitation or join code they accept themselves, and the directory offers only people the searcher could enroll.

## Tenancy and the three tiers (ADR-0006)

A Unit Instance is what this section calls an organization ([ADR-0007](engineering/ADR/0007-mcen-enterprise-deployment-and-unit-instances.md)). A deployment shares one database among many Unit Instances (`VANTAGE_TOPOLOGY=shared`), or holds exactly one (`dedicated`). With `dedicated`, a temporary trigger on the database connection refuses a second one, whichever path tries to found it. Under the MCEN profile, self-registration and self-service Unit Instances are held off, and the Vantage Administrator console cannot turn them back on.

- **Organizations are tenants.** Every unit belongs to exactly one organization (`units.org_id`), enforced by database triggers as well as in code: a new unit inherits its parent's, a top-level unit founds its own, and no unit moves between organizations or changes the one it is in. A suspended organization's units confer nothing.
- **Platform roles** (Vantage staff: Lead Vantage Administrator, Vantage Administrator, Vantage Support, Vantage Auditor; stored as `owner`, `admin`, `support`, `auditor`) run the service and confer no unit permission. The platform API (`/api/platform`) answers only on the Vantage Administrator console's host and requires a recent password confirmation on every call. Granting a staff role needs another Lead Vantage Administrator and a second factor on the account; support cannot reset a Lead Vantage Administrator's credentials.
- **Unit Instance roles** (Lead Unit Manager, Unit Manager, Records Officer, Unit Auditor; stored as `owner`, `admin`, `records`, `auditor`) run one Unit Instance's structure through `/api/orgs/:orgId`, which answers only on the Unit Manager console's host. A Unit Instance another person holds no role in is answered as not found. Each Unit Instance permission confers one structural unit permission in every unit of the instance (`ORG_STRUCTURE_GRANTS`: members, units, roles, and view), never `VIEW_RECORDS`, `VIEW_MEMBER_DETAIL` or `EXPORT_DATA`. Unit Managers can staff any role below Unit Leader without holding it. A unit created through Unit Instance authority alone is led from above, not by its creator. The Unit Instance export is its structure only. The rules that keep Unit Managers scoped and stop anyone elevating themselves are in the next section.
- **Vantage access** is the only way staff see inside an organization: a request with a reason and a length (15 minutes to 24 hours), approved by a Lead Unit Manager unless the Unit Instance chose to be told instead; read-only (`VIEW_UNIT`, `VIEW_RECORDS`, `VIEW_AUDIT` in its units); ended by expiry, by a Lead Unit Manager, or with the staff member's last platform role; audited in both trails. A request unanswered for a day lapses.
- **Time-bound grants.** Unit and organization roles can be granted until a date. Authority is computed per request and ignores an expired grant at once; a sweep every minute removes it and records the end in the audit trail.
- **"Why can they?"** explains, for each unit, every source of a person's permissions: the role and where it was granted, inheritance down the chain, unit leadership, Unit Instance roles, Vantage access, with end dates.
- **The roster feed is organization-scoped.** An extract changes only accounts that belong to that organization or to none; leaving an organization's roster ends its memberships and releases claims, and the account is deactivated only if it belongs to no other organization. A return restores the memberships the feed ended.
- **Credential resets are Vantage support's,** because an account can belong to several organizations. A Unit Instance's Unit Managers may unlock and sign out their own members; an account with authority beyond the organization is unlocked only by Vantage support or by its own reset link (ADR-0009).
- Every cross-person read is audited (`view_member`, `view_record`, `list_records`, `view_readiness`, `build_report`, `export_*`) with actor, subject, unit, IP.

## Vantage Administrator and Unit Manager (ADR-0010)

[ADR-0010](engineering/ADR/0010-vantage-administrator-and-unit-manager.md) names the roles and closes the ways either tier could widen its own reach. Stored role keys, permission keys and API paths are unchanged; only the names people read changed.

- **Permissions decide.** Every check asks for a permission from the platform or Unit Instance catalogue (`shared/permissions.ts`), never for a role name. `tests/server/roleModel.test.ts` drives every role of both catalogues against the console routes its permissions open, and the ones they do not.
- **Unit Managers are scoped to their Unit Instances, and only while they belong to them.** A Unit Instance role confers authority only while its holder is a member of a unit of that instance (`seatedOrgRole` in `server/authz/scope.ts`). Leaving the last unit ends the role, audited as `org_role_ended`; a move between units of the same instance keeps it; a roster separation leaves it dormant, conferring nothing, so the feed's own restore brings it back. Taking a role holder out of their last unit, or archiving the last unit you belong to, needs `org.owners` and is refused for the instance's last Lead Unit Manager (`assertMayEndInstanceRoles`). Owner counts, notices and console sign-in count only holders who are still members.
- **No Unit Manager elevates themselves.** Nobody grants, extends or changes their own Unit Instance roles. Nobody gives themselves reach into records through Unit Instance authority, by whichever door: granting themselves a role, naming themselves a unit's leader or taking it by transfer, redeeming their own join code or invitation, or widening a role they hold (`guardSelfReach` in `server/services/org.ts`, code `self_grant`). This holds for Lead Unit Managers too; another Unit Manager, or the unit's chain of command, grants it, and the audit trail shows who. Each check runs before anything is written. Platform authority is out of reach: `/api/platform` refuses anyone without a platform role (`not_staff`).
- **No Vantage Administrator makes themselves a Unit Manager.** A Vantage Administrator never names themselves a Unit Instance's Lead Unit Manager, in the create form, in "name a Lead Unit Manager", or in a provisioning manifest (`self_grant`). Holding `platform.orgs` no longer bypasses the self-service switch on creating a top-level unit, so staff found Unit Instances only in the Vantage Administrator console or from a manifest, which gives them no role in it. A Vantage Administrator names a first Lead Unit Manager only for a Unit Instance that has none; someone not yet a member is seated in its top unit (start reason `manager_assigned`).
- **The first-run exception.** Setup makes one account Lead Vantage Administrator, the first Unit Instance's Lead Unit Manager and the leader of its top unit. [deploy-mcen.md](deploy-mcen.md) gives the hand-off that ends the dual hat.

## The Unit Instance boundary (ADR-0008)

Permissions are held per unit, so a person who serves in one Unit Instance only ever stands in its units. Someone attached to two commands holds real authority in each, and may work in each; what no authority allows is carrying one instance's data, or a reference to it, into the other. Where an operation names two units, or a unit and a row from another unit, the server checks that both are in one Unit Instance (`sameInstance` and `assertSameInstance` in `server/authz/scope.ts`, refusals with the code `cross_instance`):

- **People.** A Marine is never moved between teams in different Unit Instances, nor enrolled directly into one on the strength of being led in another: they join it by invitation or join code. A primary unit held in one instance is not taken, moved or reassigned by enrollment or departure in another.
- **Records.** A record manager or counselor may correct and re-place another Marine's record inside its own instance, never into another, and only its Marine takes it out of every unit. A Marine may re-place their own record among the units they belong to, because the record is theirs, unless it carries someone else's comments, attachments or filed work from another instance; comments and files are judged by the unit they were added in, and re-importing an entry by its id is the same move. Both instances' audit trails record the move.
- **References by id.** A project filed against an entry, a task or a queue item; a contact on a thread; a thread linked to work; an uploaded sheet imported into a unit; a record cited by a report revision. Each is checked for the instance it belongs to, not only for whether the caller can read it, from both ends: the row pointed at cannot move out from under the row that points. A thread shows only the links its reader could open.
- **Reports and exports.** A unit id from another instance is refused rather than answered with the caller's own figures, and a report about another Marine cites one instance's records. A unit export, a CSV, a report, and the metrics and dashboards for a unit carry one instance's rows; a view with no unit is the caller's own and counts what they can read in each instance they serve in.
- **Identity.** An organization cannot link or change the EDIPI, which is the CAC sign-in key, of an account that serves in another instance or runs the service, and a changed EDIPI ends the account's sessions. The roster feed never renames or deactivates an account that runs the service and sits in none of the organization's units, and never deactivates any account that runs the service.
- **Archives.** An instance archive restores as its instance was kept: links it brings across instances are kept and counted into `meta.instance_boundary_violations` and the import's audit entry, as migration 016 does for a live database, and the boundary holds for every change after.
- **The database keeps the boundary too.** Migration 016 adds triggers that refuse a change to a unit's organization and refuse cross-instance project links, thread contacts and thread links in the engine itself, from both ends. An engine refusal is answered as a 403 `cross_instance` and written to the audit trail. They are a second line: authorization is decided in the server. PostgreSQL row-level security is the equivalent for the PostgreSQL target and is written when that adapter lands ([ADR-0003](engineering/ADR/0003-postgresql-migration-path.md)); SQLite has no RLS, so triggers are what this engine offers.
- `tests/server/unitIsolation.test.ts` proves it from the outside: two Unit Instances, a Marine in each, and a leader with authority in both.

## One identity, many memberships (ADR-0009)

An account is the person for a whole career; Unit Instances hold memberships to it, never copies of it. What changes the identity itself is governed once (`server/services/identity.ts`):

- **Transfers keep the account.** An email invitation is accepted into the account signed in (`POST /api/auth/invite/claim`), only by the account holding the invited address, once, after a recent confirmation, and never as an administrator's own way into a role that reads records. Creating a second account for an address that has one is refused (`account_exists`). Inviting such an address is allowed.
- **Membership history** (`unit_membership_periods`) is written by database triggers on every membership change, with the reason and the actor added by the server. The person reads all of theirs; a leader reads the part in units of their own instance they can open, and a Unit Instance's managers the part inside it.
- **The EDIPI.** `users.edipi_verified_at` records when the person's card (sign-in or step-up), roster provisioning or the organization's identity provider proved the EDIPI the account carries. A proven EDIPI is changed only by Vantage support (`POST /api/platform/accounts/:userId/edipi`, with a reason), never by a Unit Instance, its administrators' own accounts included. An unproven one can still be corrected by the person's own Unit Instance. Every change is audited, ends the account's sessions, and tells the person. The first link of an EDIPI that was never proven remains trusted to the person's own Unit Instance; closing that fully needs an outside source to vouch for the pairing (INFRASTRUCTURE_QUESTIONS I-25).
- **Shared accounts.** For an account that serves in another Unit Instance or runs the service, a single instance cannot change its EDIPI or unlock it. Only the instance holding its primary unit edits its profile, by hand or through its personnel feed. Any instance may sign it out everywhere; the person is notified and each other instance gets a `shared_account_notice` in its own audit trail.
- **Card-only and provider-only deployments** (`CAC_EXCLUSIVE`, `VANTAGE_OIDC_EXCLUSIVE`) refuse every password path: sign-in, registration, the reset request and the reset, account creation from an invitation, and the emailed sign-in details.
- **Test sign-in.** The test suite's bearer tokens (`VANTAGE_TEST=1`) need `NODE_ENV=test` as well and are refused in production. The MCEN profile refuses to start without `NODE_ENV=production`. The Vantage Administrator console's deployment posture lists the sign-in methods in force and warns when test tokens are on.
- `tests/server/identityMembership.test.ts` proves it.

## Integrity

- The audit log is an HMAC hash chain under a chain key kept in the database and sealed with `VANTAGE_SECRET`; the head is stored separately and verified in the Vantage Administrator console. Each entry carries its organization (sealed into the hash when set), so an organization reads its own trail and the platform reads its own. Case histories are chained the same way, and a history whose seals were removed reads as broken.
- Both chains detect a change made by somebody who has the database but not the secret. Against somebody who holds the whole server, the evidence is a copy they do not control: `VANTAGE_AUDIT_SYSLOG` sends every audit record, with its hash, to a syslog collector as it is committed (see `docs/operations.md`).
- `VANTAGE_SECRET` can be changed: set the old one as `VANTAGE_SECRET_PREVIOUS` for one start and every stored secret is re-sealed.
- Records carry a `version`; concurrent edits are rejected with the current copy (409) and the client offers reload or overwrite.
- CSV import screens exact and near duplicates; the database enforces a per-user fingerprint.

## Transport and browser

- The Unit Manager console and the Vantage Administrator console can each have a host of their own (`VANTAGE_CONSOLE_URL`, `VANTAGE_ADMIN_URL`). On the console's host only people who hold an organization role can sign in, and on the Vantage Administrator console's only Vantage staff; each session cookie is its own host's, and each API answers on its own host alone, so a session stolen from the app can never reach either.
- HTTPS only in production (every configured address must be `https://`), HSTS with preload, a strict CSP with hashed inline bootstrap and `connect-src` limited to this server and the GenAI.mil gateway (the Vantage Administrator console checks from the browser whether the gateway is reachable), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`.
- CSRF: state-changing requests must carry `x-vantage-client`; cookies are `SameSite=Lax`.
- Rate limits per IP and per account on sign-in, registration, reset, MFA, and mutations. Behind Cloudflare, set `VANTAGE_CLIENT_IP=cloudflare`: the visitor's address is then taken from `CF-Connecting-IP`, but only when the request's peer is inside Cloudflare's published ranges, so each visitor has their own limit instead of sharing one with everyone on the same edge, and a request that reaches the origin another way cannot choose its address.
- A name with no account "locks" exactly as a real one does (same count, answer and duration), so the lockout cannot be used to learn which usernames exist. A password reset link clears a lock, since it proves the mailbox.
- Password policy, the workbook reader and the email sanitizer run in linear time: each once had a pattern that a few hundred crafted bytes could make take seconds on the server's single thread. The current-password check on the change-password form shares the sign-in limit. Reset emails are capped at three an hour per account, and mail sent on a user's request (address confirmation, digests, invitations) at ten per 15 minutes.
- Links a user saves as evidence must be `http`, `https` or `mailto`, checked the way a browser reads a scheme (ignoring control characters and whitespace). MARADMIN links are kept only when they are `https`.
- Attachments are sniffed for type (PDF, PNG, JPEG, plain text, CSV), size-limited, hashed, stored in the database, and served with `Content-Disposition: attachment`.
- Every upload (evidence attachments, imported workbooks, saved `.eml` messages) is scanned when a scanner is configured: clamd over its socket (`VANTAGE_CLAMD=tcp://host:3310` or a unix socket path) or the `clamdscan` command (`VANTAGE_SCANNER_COMMAND`). A rejected file is never stored. `VANTAGE_SCAN_REQUIRED=true` refuses a file that could not be scanned instead of keeping it marked "not scanned".
- A workbook is charged against its size limit by what it really expands to, not by the sizes it declares.

## AI

- Only through GenAI.mil, with the key server-side. Each workflow sends a bounded payload of the caller's own data (or exact-unit aggregates for command briefs); inputs are labeled untrusted in the system prompt.
- Per-user daily token limits and an instance budget. A key lock from the gateway pauses AI and notifies owners.
- Nothing is written from an AI result without the user pressing save.

## Correspondence and mailboxes

- Message HTML is sanitized server-side from an allowlist before storage; scripts, handlers, and non-`http(s)`/`mailto`/`tel` links never survive. Every attribute the sanitizer writes is re-quoted with its quotes escaped, so a value cannot close its attribute and add another.
- Remote images are stripped rather than proxied. A tracking pixel would otherwise report when a Marine opened their mail, and from which network.
- Mailbox connectors are read-only (`offline_access`, `User.Read`, `Mail.Read`) and name their national cloud explicitly. Delta sync keys on the provider's message ids, and a message deleted upstream never deletes the local record of the work.
- Live syncing is not wired to a token flow in this build. The authorization plan is shown before anything is authorized, and an unauthorized sync says so rather than reporting an empty mailbox.

## Outbound email

- In direct mode Vantage signs every message with DKIM. The private key is generated on the server, stored in `meta` encrypted with `VANTAGE_SECRET` (AES-256-GCM), and never leaves the instance; only the public key is shown, for DNS.
- Mail a receiver asks to retry is queued in `email_queue` encrypted with the same secret, and deleted once delivered or given up: 30 minutes for a reset link, two days at most otherwise.
- Delivery uses opportunistic STARTTLS, as mail servers do between themselves; a receiver that offers no TLS still gets the message in the clear, which is the norm for server-to-server mail.
- Direct delivery resolves each mail host itself and never connects to a private, loopback, link-local or reserved address, so a recipient domain cannot point delivery into the host's own network. It connects to the address it checked. `VANTAGE_EMAIL_ALLOW_PRIVATE=true` is for a network whose mail hosts really are private.
- The Vantage Administrator console's email checks are for staff with the email permission, behind step-up confirmation, and each run is audited (`email_setup_checked`).
- Team messages need `MANAGE_MEMBERS` in the unit, go to each member separately so no address is shared, set Reply-To to the sender, are limited to five an hour per sender, and are audited (`team_message`). Subjects are flattened to one line, so typed text cannot add mail headers.

## Product analytics

- The event catalog is closed. A client can only send names and properties declared in `server/services/telemetry.ts`; anything else is dropped with a reason.
- No property can hold free text. Values are numbers, booleans, or one of a fixed set of words, so passwords, keystrokes, cancelled drafts, email bodies, and workbook cells have nowhere to go.
- The actor is taken from the session, never from the request body, and a client cannot raise an event the server is responsible for.
- No Unit Instance role grants privilege over privacy here: the console reports counts and distributions only, and withholds any breakdown fewer than three people produced.
- Events are retained for a bounded window and can be pruned from the console.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Credential stuffing | Rate limits, a lockout after three failures kept in the database, long passwords, passkeys, TOTP |
| Replaying an observed authenticator code | Each code accepted once per account |
| Pulling a Marine into your own unit to read them | Direct enrollment only for Marines already led; everyone else by invitation |
| Escalating through a lower role | Grants limited to permissions the granter holds |
| A Unit Manager handing themselves reach into records | `guardSelfReach` refuses it at every door, for Lead Unit Managers too, before anything is written; another person grants it, on the record (ADR-0010) |
| A Vantage Administrator making themselves a Unit Manager | Never named Lead Unit Manager by themselves, in any form or manifest; `platform.orgs` does not found a Unit Instance in the app (ADR-0010) |
| A Unit Manager who has left keeping authority | A Unit Instance role confers nothing once its holder belongs to no unit of the instance, and ends when they leave (ADR-0010) |
| Flooding an inbox with reset or confirmation mail | Per-account caps on every email a user can trigger |
| Sidestepping the demo's closed routes | Paths compared case-insensitively, without trailing slashes |
| Session theft | Digest storage, short idle timeout, revocation on sensitive changes, device list |
| Insider read of private records | Not reachable through the API; audit of every shared read |
| Tampering with the audit trail | HMAC chain verified in both consoles; a copy of every record sent off the host |
| A forged or replayed organization sign-in | Signature checked against the provider's keys, `none` and HMAC refused, issuer, audience, expiry and nonce checked, state used once |
| One organization identity taking over another's account | An account is bound to one provider subject; a second subject with the same address is refused |
| A revoked CAC | Direct mode checks the issuing CAs' CRLs and fails closed; proxy mode relies on the gateway's check |
| A Unit Manager re-keying a member's CAC link to their own card | A proven EDIPI is changed only by Vantage support, with a reason; any change is audited, ends the account's sessions and tells the person |
| A second account splitting a Marine's record at a transfer | Invitations are accepted into the existing account; a new account for an address that has one is refused |
| Test-only bearer sign-in left on in a deployment | `VANTAGE_TEST` needs `NODE_ENV=test` and is refused in production; the MCEN profile runs only as production |
| A workbook that expands without limit | Real expanded size charged against the limit |
| Malware in an upload | clamd scan of every upload; optionally refuse what could not be scanned |
| Mail delivery aimed at the host's own network | Private and reserved addresses refused |
| A copy of the whole instance walking out | Browser downloads can be turned off; every other Lead Vantage Administrator is notified of each one |
| CSRF / clickjacking | Client header, `SameSite`, `frame-ancestors 'none'` |
| Malicious upload | Type sniffing, size cap, attachment disposition, no inline render |
| Prompt injection via records | Data labeled untrusted; no tool access; output is a draft |
| Disk full | Write refusal near the size threshold; backups from the console |
| Tracking pixel in imported mail | Remote images stripped, never fetched; the reader is told |
| Script in an email body | Allowlist sanitizer; scripts and handlers dropped before storage |
| Reading a government mailbox from the wrong cloud | The national cloud is declared, never inferred from an address |
| Content leaking into analytics | Closed catalog with scalar-only properties; undeclared values dropped |
| De-anonymizing a small cohort | Breakdowns under three contributors withheld |
