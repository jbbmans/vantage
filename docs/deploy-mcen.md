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
- a `VANTAGE_SITE_URL` different from the application's address.

The Vantage Administrator console cannot turn self-registration or self-service Unit Instances back on.

## Enterprise services Vantage can use

Each is off until it is set. Each points at a service the enterprise names.

| Need | Setting | Question |
|---|---|---|
| Sign-in with CAC/PIV | `CAC_MODE=proxy` (with `CAC_PROXY_SECRET`) or `direct` (with `CAC_CA_BUNDLE`, `CAC_CRL_DIR`) | I-05 |
| Sign-in with the enterprise IdP | `VANTAGE_OIDC_ISSUER`, `VANTAGE_OIDC_CLIENT_ID`, `VANTAGE_OIDC_CLIENT_SECRET` | I-05 |
| Mail through the enterprise relay | `VANTAGE_EMAIL_PROVIDER=smtp`, `SMTP_URL`, `VANTAGE_EMAIL_FROM` | I-15 |
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
    VANTAGE_PROVISION=1 npm run provision-instance -- --by <administrator> g1.json --dry-run
    VANTAGE_PROVISION=1 npm run provision-instance -- --by <administrator> g1.json
    ```

  The manager is the first Lead Unit Manager, and their account must already exist. It is never the
  Vantage Administrator running the manifest (ADR-0010), and the run is refused before anything is
  written if it is. Someone who is not yet a member of an existing Unit Instance is seated in its top
  unit. Running the manifest again changes nothing. Every run is in the audit trail under the
  Vantage Administrator who ran it.
- **Dedicated topology.** A new Unit Instance is a new deployment of the same build, with its own
  database and `VANTAGE_TOPOLOGY=dedicated`.

## Backups and recovery

- **Back up on the host.** Run `npm run backup` (a consistent copy of the database, attachments
  included) and keep copies where the enterprise keeps backups (I-09). Each run is recorded, and the
  Vantage Administrator console (**Operations → Backups**) says when the last one was taken. Set
  `VANTAGE_BACKUP_MAX_AGE_HOURS` to the enterprise's backup interval (default 168). A snapshot the host
  takes on its own is not seen by Vantage (I-28).
- **Before a restore or an upgrade**, start maintenance in the Vantage Administrator console
  (**Maintenance**) with a reason, such as the change record's number (I-29), and an expected end.
  Everyone else sees the message until a Vantage Administrator ends it.
- **Health.** `/api/health` is for the platform's probe. The Vantage Administrator console's
  **Operations** page is the full report, including revocation lists and CAs nearing expiry
  (**Sign-in health**).
- **Moving or restoring the whole service.** Use the service archive. See
  [operations.md](operations.md#moving-the-service-to-another-host).

## Moving from the legacy site

The legacy deployment's database can run under `mcen` as it is. On the first MCEN start:

- self-registration and self-service Unit Instances are held off;
- the public pages stop being served.

Accounts, Unit Instances, roles and records are unchanged.
