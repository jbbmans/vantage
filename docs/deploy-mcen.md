# Deploying on MCEN

Vantage's production target is an enterprise deployment on the Marine Corps Enterprise Network
([ADR-0007](engineering/ADR/0007-mcen-enterprise-deployment-and-unit-instances.md)). This page says what
the application needs and what it refuses. It does not describe MCEN's own infrastructure. Where that is
not yet known, the answer is a setting, and the open question is listed in
[INFRASTRUCTURE_QUESTIONS.md](engineering/INFRASTRUCTURE_QUESTIONS.md).

The public site at vantageusmc.com ([deploy-render.md](deploy-render.md)) is the legacy deployment. It is
not the target.

## What runs

- **One process.** It runs Node.js 22.18 or later, either from the image `Dockerfile` builds or as a native
  service (I-02, I-03, I-17).
- **One database file** on a persistent volume (`VANTAGE_DB`), with attachments inside it (I-04, I-14).
- **TLS** terminated by the enterprise reverse proxy (`TRUST_PROXY` names it), or by Vantage itself with
  `CAC_MODE=direct` (I-05, I-06).

The browser loads nothing from outside the deployment, and the server opens no outbound connection unless
one is configured.

## The minimum MCEN configuration

```sh
NODE_ENV=production
VANTAGE_DEPLOYMENT_PROFILE=mcen
VANTAGE_TOPOLOGY=shared            # or dedicated: this deployment holds exactly one Unit Instance (I-13)
VANTAGE_APP_URL=https://<host>     # I-16; the public-site address is the same host
VANTAGE_DB=/data/vantage.db
VANTAGE_SECRET=<at least 32 random characters, from the environment's secret store>
VANTAGE_SETUP_TOKEN=<at least 24 random characters, for first-run setup only>
TRUST_PROXY=<the hop count or address of the enterprise proxy>
```

With `mcen`, these come on without being set:

- the DoD Notice and Consent Banner (`VANTAGE_CONSENT_BANNER=custom` replaces its text);
- self-registration off;
- browser downloads of the database off;
- no public marketing site.

## What MCEN refuses

The start fails, naming every problem at once, if any of these is set:

- `VANTAGE_ACCESS_MODE=demo`;
- `VANTAGE_INDEXNOW`;
- `VANTAGE_GOOGLE_SITE_VERIFICATION` or `VANTAGE_BING_SITE_VERIFICATION`;
- `VANTAGE_CLIENT_IP=cloudflare`;
- `VANTAGE_EMAIL_PROVIDER=resend` or `direct`;
- `VANTAGE_SELF_REGISTRATION=true`;
- `VANTAGE_CONSENT_BANNER=off`;
- a `VANTAGE_SITE_URL` different from the application's address;
- `VANTAGE_EMAIL_PROVIDER=smtp` with an `SMTP_URL` that is empty, is not `smtp://` or `smtps://`, or sets its own TLS
  terms in its query (`secure`, `requireTLS`, `ignoreTLS`, `opportunisticTLS`, `tls.*`), or whose user name or
  password holds a `%` that starts no escape (write it `%25`);
- `VANTAGE_EMAIL_PROVIDER=smtp` with no `VANTAGE_EMAIL_ALLOWED_DOMAINS`: on MCEN mail goes only to the domains the
  enterprise names (I-37), for example `usmc.mil, mail.mil`. `*.usmc.mil` names every subdomain of `usmc.mil`. A
  recipient outside the list is refused and audited (`email_refused`, ADR-0048).

Mail to the relay goes only over TLS 1.2 or later, to a certificate that checks: `smtps://` is TLS from the first byte
(port 465 unless the address names one), and `smtp://` must start TLS (port 587 unless it names one). The
certificate is checked against Node's bundled roots, not the host's store, so a relay whose certificate an enterprise
CA signed needs that CA in `NODE_EXTRA_CA_CERTS`.

On every profile, a numeric setting that is not a whole number written in digits, within its range, stops the start
and is named. The ranges are wide; how tight a session limit the accredited host sets is the ISSM's to decide.

The Vantage Administrator console cannot turn self-registration or self-service Unit Instances back on.

## Enterprise services Vantage can use

Each is off until it is set. Each points at a service the enterprise names.

| Need | Setting | Question |
|---|---|---|
| Sign-in with CAC/PIV | `CAC_MODE=proxy` (with `CAC_PROXY_SECRET`) or `direct` (with `CAC_CA_BUNDLE`, `CAC_CRL_DIR`) | I-05 |
| Sign-in with the enterprise IdP | `VANTAGE_OIDC_ISSUER`, `VANTAGE_OIDC_CLIENT_ID`, `VANTAGE_OIDC_CLIENT_SECRET` | I-05 |
| Mail through the enterprise relay | `VANTAGE_EMAIL_PROVIDER=smtp`, `SMTP_URL`, `VANTAGE_EMAIL_FROM`, `VANTAGE_EMAIL_ALLOWED_DOMAINS` | I-15, I-37 |
| Audit records to the SIEM | `VANTAGE_AUDIT_SYSLOG=tls://<collector>:6514` | I-08 |
| Malware scanning of uploads | `VANTAGE_CLAMD`, and `VANTAGE_SCAN_REQUIRED=true` | I-07 |

These leave the enclave and need an approved connection before they are turned on:

| Connection | Setting | Question |
|---|---|---|
| AI through GenAI.mil | `VANTAGE_AI_ENABLED`, `VANTAGE_GENAI_API_KEY` | I-18 |
| MARADMIN feed | `VANTAGE_MARADMIN_ENABLED`, `VANTAGE_MARADMIN_SOURCE` | I-19 |
| Outlook mailbox connections | `VANTAGE_M365_CLIENT_ID`, `VANTAGE_M365_CLIENT_SECRET` | I-22 |

The Vantage Administrator console's overview lists every outbound connection: where it goes, whether it is on, and how
MCEN treats it.

## First start and the first administrator

1. Start the service. The log line names the profile and topology. `/api/health` reports
   `"profile": "mcen"`.
2. Open the application. First-run setup asks for `VANTAGE_SETUP_TOKEN`. It creates one account that is,
   for now, three things at once: the Lead Vantage Administrator, the first Unit Instance's Lead Unit
   Manager, and the leader of that instance's top unit. The token is inert afterwards (I-20).
3. Add further Vantage Administrators in the Vantage Administrator console (**Staff**), or name Lead
   Vantage Administrators at every start with `VANTAGE_PLATFORM_OWNERS`.
4. End the dual hat (ADR-0010). Platform authority should not come with a command's records:
   1. In the Unit Manager console (**People → Grant a role**), make the command's designated person a
      Lead Unit Manager. Add them to a unit first if they are not a member.
   2. Transfer the top unit's leadership to the command's leader (**Units**, or Team in the app).
   3. Remove your own Lead Unit Manager role (**People**). Giving up authority needs nobody else; the
      instance keeps the Lead Unit Manager you named.

   Afterwards the setup account is a Vantage Administrator only. It sees the Unit Instance as a container
   and looks inside only through an approved Vantage access request.

## Adding a Unit Instance

Adding a unit never needs a source change.

- **Shared topology.** A Vantage Administrator provisions it:
  - in the Vantage Administrator console (**Unit Instances → New Unit Instance**); or
  - from a manifest:

    ```sh
    cat > g1.json <<'JSON'
    {"name": "MARFORRES G-1", "code": "G1", "short_name": "G-1", "manager": "<username or 10-digit DoD ID>"}
    JSON
    VANTAGE_PROVISION=1 node scripts/provision-instance.ts --by <administrator> g1.json --dry-run
    VANTAGE_PROVISION=1 node scripts/provision-instance.ts --by <administrator> g1.json
    ```

  The manager is the first Lead Unit Manager, and their account must already exist. It is never the
  Vantage Administrator running the manifest (ADR-0010), and the run is refused before anything is
  written if it is. Someone who is not yet a member of an existing Unit Instance is seated in its top
  unit. Running the manifest again changes nothing. Every run is in the audit trail under the
  Vantage Administrator who ran it.
- **Dedicated topology.** A new Unit Instance is a new deployment of the same build, with its own
  database and `VANTAGE_TOPOLOGY=dedicated`.

## Backups and restore

- **Back up on the host.** Run `node scripts/backup.ts <file>` (a consistent copy of the database, attachments
  included) and keep copies where the enterprise keeps backups (I-09). Each copy passes SQLite's integrity check
  before it counts, keeps its SHA-256 beside it as `<file>.sha256`, and is refused and removed if the file fails. A
  trail that does not verify is reported and recorded and the copy kept, since it holds what the live database holds;
  a restore refuses it, so look at **Audit integrity** first. `node scripts/backup.ts --verify <file>` checks one again
  at any time, and with `VANTAGE_SECRET` set checks its trail too. Each run is recorded and audited,
  and the Vantage Administrator console (**Operations → Backups**) says when the last one was taken. Set
  `VANTAGE_BACKUP_MAX_AGE_HOURS` to the enterprise's backup interval (default 168). A snapshot the host
  takes on its own is not seen by Vantage (I-28).
- **Drill a restore with the service running.** `node scripts/restore.ts DRILL --from <file>` restores the backup into
  a scratch copy, opens it with this build and removes it, without stopping Vantage or replacing anything; it is
  recorded and audited, and a failed one tells the Vantage staff. Drill the newest backup after every upgrade and at
  least monthly.
- **Restore with `node scripts/restore.ts`, never by copying a file.** A Lead Vantage Administrator authorizes it,
  with the service stopped and maintenance started with the change or incident record's number (I-29,
  I-35). It checks the backup, keeps the database it replaces, signs everyone out and is audited in every
  Unit Instance, whose Lead Unit Managers are told. A database replaced any other way is detected at the
  next start, audited and shown on each Unit Instance's health. See
  [operations.md](operations.md#restoring-from-a-backup). Where the lineage file and the safety copy may
  live, and for how long, is the host's to say (I-36).
- **Data exports are not backups.** A Unit Instance's structure, roster, configuration and audit trail, a
  person's own export and reports are that Unit Instance's or person's data, and restore nothing.
  **Backup and restore → Not backups: data exports** lists them all.
- **Upgrades keep a copy.** A start that migrates the database first keeps a checked copy of it as it was, owner-only,
  in `VANTAGE_UPGRADE_COPY_DIR` (default: beside the database), the newest `VANTAGE_UPGRADE_COPIES_KEPT` (default 3) of
  each database's copies; a start that cannot make one stops with nothing migrated, and a start after a failed upgrade
  keeps the copy that start took while nothing was written since, and never prunes it. Give that directory room for one more database. The
  start then checks every table's rows, and each Unit Instance's, and records, audits and tells the Lead Unit Managers
  about any it lost. The copy is for undoing the upgrade on this host; it does not replace the backup off it.
- **Each Unit Instance's operations.** **Instance operations** in the Vantage Administrator console shows
  each one's version, schema, last upgrade, health, backup freshness and last restore; its Unit Managers
  see theirs under **Operations**. `node scripts/operations-report.ts` prints the same as JSON for whatever
  watches many deployments (I-34).
- **Health.** `/api/health` is for the platform's probe. The Vantage Administrator console's
  **Operations** page is the full report, including revocation lists and CAs nearing expiry
  (**Sign-in health**).
- **Scheduled upkeep.** Every `VANTAGE_DB_UPKEEP_HOURS` (default 24) the service checks the database
  for damage on a thread of its own while people work, then refreshes its query statistics and empties
  its write-ahead log. Each run is audited; damage it finds tells the Vantage staff and fails the health
  check. Text deleted from this release on is overwritten where it lay, so it is not in the file or a
  later backup. What was deleted before stays on free pages, and in backups, until **Compact**.
  See [operations.md](operations.md#scheduled-upkeep).
- **Moving the whole service.** Use the service archive. See
  [operations.md](operations.md#moving-the-service-to-another-host).

## Moving from the legacy site

The legacy deployment's database can run under `mcen` as it is. On the first MCEN start:

- self-registration and self-service Unit Instances are held off;
- the public pages stop being served.

Accounts, Unit Instances, roles and records are unchanged.
