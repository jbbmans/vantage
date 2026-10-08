# Deploying on Render

> **Legacy deployment.** This page is for the pre-MCEN public site at vantageusmc.com (`VANTAGE_DEPLOYMENT_PROFILE=legacy-public`). It is not the production target; see [deploy-mcen.md](deploy-mcen.md) and [ADR-0007](engineering/ADR/0007-mcen-enterprise-deployment-and-unit-instances.md).

The whole system is one web service with a persistent disk. Budget: the Starter plan plus a 1 GB disk, which is what the previous version cost.

## First deploy

1. `main` is the deploy branch.
2. In Render, choose **New → Blueprint**, pick the repository, and accept `render.yaml`. Render creates the `vantage` service, the `vantage-data` disk mounted at `/data`, and generates `VANTAGE_SECRET` and `VANTAGE_SETUP_TOKEN`.
3. Wait for the first build (5 to 8 minutes; it compiles `better-sqlite3` and the client).
4. Open the service's **Environment** tab and copy the value of `VANTAGE_SETUP_TOKEN`.
5. Visit the site. The setup page asks for that token, then creates the Lead Vantage Administrator account and the first unit. This only works once; afterwards the token is inert.
6. Sign in, open **Settings → Security**, add a passkey and an authenticator app.

Auto-deploy waits for CI: `render.yaml` sets `autoDeployTrigger: checksPass`, so a push to `main` is released only after every GitHub check on that commit passes (lint, typecheck, server tests, build, browser tests, Docker build), and then only once the health check at `/api/health` passes. A red commit is never released, and failed builds never replace the running version. `/api/health` reports the running commit and the built client's hash, so what is live can always be matched to a CI run.

Protect `main` in GitHub too (**Settings → Branches → Add rule**): require a pull request, and require the `Lint, typecheck, server tests, build`, `Browser tests (Playwright)` and `Docker image builds` checks to pass. The blueprint cannot set this itself. If a check ever has to be bypassed, record why in the pull request; do not switch the trigger back to every commit.

Changes only to `docs/`, `film/`, `tests/`, `.github/` or Markdown files do not redeploy (`buildFilter` in `render.yaml`).

## Caching

Turn on Render's edge cache: **Settings → Edge Caching → Common static files**. The application already
labels everything:

| Path | Cache-Control |
| --- | --- |
| `/assets/*` (content-hashed) | one year, immutable |
| `/videos/*?v=<hash>` | one year, immutable; the version is the file's hash, written by the film pipeline |
| `/fonts/*` | 30 days |
| `/brand/*` | 7 days |
| other static files | 1 hour |
| pages, `/sw.js` | `no-cache`, plus `CDN-Cache-Control: no-store` so the edge never holds them |
| `/api/*` | `no-store` |

A deploy purges the edge cache. To check, request a file under `/assets/` twice: the second response
should carry `cf-cache-status: HIT`.

A service with a persistent disk cannot deploy with zero downtime; Render stops the old instance before
starting the new one, so a deploy is a gap of a few seconds.

## Custom domains: one address for each face

Vantage has four faces (ADR-0006), and production gives each an address of its own:

| Address | What it serves |
| --- | --- |
| `www.vantageusmc.com` | the public page, its sitemap and `robots.txt`; nothing behind sign-in |
| `secure.vantageusmc.com` | sign-in and the app. Every link in an email points here |
| `dev.vantageusmc.com` | the Unit Manager console, a separate app for each Unit Instance's Unit Managers, Records Officers and Unit Auditors. Only they sign in, and an organization's API (`/api/orgs`) answers here and nowhere else |
| `dev.vantageusmc.com/admin`, or `admin.vantageusmc.com` with `VANTAGE_ADMIN_URL` | the Vantage Administrator console, for Vantage staff. Only staff sign in, and the platform API (`/api/platform`) answers only on its host |

The bare `vantageusmc.com` serves the public page too, and anything else that reaches it (a reset link emailed
before the move, an old bookmark) is sent on to the address that now serves it, path and all. `/login` on www goes to
secure; an old `/operator?tab=` link goes to whichever console that tab now lives in.

A deployment that sets only `VANTAGE_PUBLIC_URL` keeps serving everything from that one address, with the Unit
Manager console at `/console` and the Vantage Administrator console at `/admin`. That is also what happens between merging this and finishing the steps below, so the order is safe.

### Moving vantageusmc.com to three addresses

1. **Cloudflare → DNS.** Add `CNAME secure` and `CNAME dev`, each pointing to the service's `*.onrender.com`
   hostname, set to **DNS only** for now. Keep the `www` CNAME and the apex `A` record. See
   [dns-namecheap.md](dns-namecheap.md).
2. **Render → the service → Settings → Custom Domains.** Render redirects between the bare domain and `www` toward
   whichever one was added first. Make `www` the primary: if `vantageusmc.com` is listed as the primary, delete
   both, then add `www.vantageusmc.com` first (Render adds the bare domain back and redirects it to www). Add
   `secure.vantageusmc.com` and `dev.vantageusmc.com`. Wait until each shows its certificate as issued, then set
   the Cloudflare records to **Proxied**.
3. **Render → Environment**, only once steps 1 and 2 are done. Set `VANTAGE_SITE_URL=https://www.vantageusmc.com`,
   `VANTAGE_APP_URL=https://secure.vantageusmc.com`, `VANTAGE_CONSOLE_URL=https://dev.vantageusmc.com` and
   `VANTAGE_RP_ID=vantageusmc.com`. `render.yaml` names all four without values, so a merge never switches the site
   before its addresses resolve. Saving redeploys. `VANTAGE_PUBLIC_URL` can stay; the four take precedence.
4. **Microsoft Entra**, only if mailboxes are connected: change the app registration's redirect URI to
   `https://secure.vantageusmc.com/api/correspondence/connectors/callback`.
5. **Search Console** needs nothing new if its property is the *Domain* property for `vantageusmc.com`, which covers
   every subdomain. Submit `https://www.vantageusmc.com/sitemap.xml` again so it reads the new canonical address.

Afterwards everyone signs in once more at `secure.vantageusmc.com`: a session belongs to the address it was made on.
Passkeys keep working, because `VANTAGE_RP_ID` names the domain they were registered under, and it is shared by the
app and the consoles. Each console is signed in to separately; signing in to one never signs you in to another.

To give the Vantage Administrator console a host of its own, add `CNAME admin` the same way, add `admin.vantageusmc.com` as a
custom domain, and set `VANTAGE_ADMIN_URL=https://admin.vantageusmc.com`. The Unit Manager console's host then stops
answering the platform API.

## Optional services

- **Email** (reset links, invitations, digests, team messages): the blueprint sets `VANTAGE_EMAIL_PROVIDER=direct`, which sends from `vantageusmc.com` itself with no email service; finish it in **Vantage Administrator console → Email**. Resend (`resend` plus `RESEND_API_KEY`) or any SMTP relay also work. See [email.md](email.md).
- **AI drafting needs a DoD-network host.** GenAI.mil answers every API call from outside DoD networks with a 503 "Unauthorized Access" page, whatever key is sent. Render, like every commercial host, is outside those networks, so on Render the AI features stay unavailable and the Vantage Administrator console explains why. To use AI, run Vantage on a host inside a DoD network (the same Docker image works anywhere) and then: add `VANTAGE_GENAI_API_KEY` (your GenAI.mil key) in the service's Environment tab and let Render redeploy. AI is on by default once a key exists; the Vantage Administrator console's AI page shows the key fingerprint, discovers the models the key can reach, edits the allowlist in `VANTAGE_GENAI_MODELS`, and switches AI off without a redeploy. Without a key the AI pages explain what is missing.
- **Microsoft 365 mailboxes** (Correspondence reads mail from a connected mailbox, read-only): register a web application in Microsoft Entra for the cloud your mailboxes are in (commercial, GCC High or DoD). Add the redirect URI `https://<your domain>/api/correspondence/connectors/callback`, grant the delegated permissions `User.Read`, `Mail.Read` and `offline_access` and nothing broader, create a client secret, and set `VANTAGE_M365_CLIENT_ID`, `VANTAGE_M365_CLIENT_SECRET`, and optionally `VANTAGE_M365_TENANT` (a tenant id pins sign-in to one directory; the default `organizations` accepts any work account). Each person then adds their mailbox by address and authorizes it; the sign-in must match the address, a grant broader than read is refused, tokens are stored encrypted with `VANTAGE_SECRET`, and a revoked or expired grant shows on the mailbox as needing authorization. Rotating `VANTAGE_SECRET` makes stored tokens unreadable, so every mailbox has to be authorized again.
- **Self-registration**: `VANTAGE_SELF_REGISTRATION=true` lets anyone with the URL create an account, which joins a unit by a join code or invitation. Default is off; leaders invite by link or email.
- **Organizations** (Unit Instances): Vantage staff create them in the Vantage Administrator console and name each one's first Lead Unit Manager, never themselves. Platform settings can also let a signed-in person start one of their own (self-service organizations, with a per-person limit).

## Sizing

SQLite on the Render disk handles this workload comfortably. The app refuses new writes when the database file nears `VANTAGE_MAX_DB_BYTES` (default 800 MB) so a full disk never corrupts anything. Attachments count toward that; Vantage staff can turn them off in the Vantage Administrator console.

## Upgrades

Push to `main`. Schema migrations run automatically at boot inside a transaction. Take a backup first from **Vantage Administrator console → Backup and recovery** when a release note says so. The organizations migration (`015_organizations`) runs once on the first boot of this release: each top-level unit becomes an organization, former operators become Lead Vantage Administrators, and each organization's Lead Unit Manager is its top unit's leader.

## If Render goes away

The Vantage Administrator console exports the whole service as JSON (organizations, accounts, credentials, units, roles, records, attachments, the audit trail). A fresh Vantage on another host, under the same `VANTAGE_SECRET`, imports it. An archive from before organizations is adopted the way the migration would. See [operations.md](operations.md).
