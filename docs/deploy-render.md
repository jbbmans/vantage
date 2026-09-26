# Deploying on Render

The whole system is one web service with a persistent disk. Budget: the Starter plan plus a 1 GB disk, which is what the previous version cost.

## First deploy

1. `main` is the deploy branch.
2. In Render, choose **New → Blueprint**, pick the repository, and accept `render.yaml`. Render creates the `vantage` service, the `vantage-data` disk mounted at `/data`, and generates `VANTAGE_SECRET` and `VANTAGE_SETUP_TOKEN`.
3. Wait for the first build (5 to 8 minutes; it compiles `better-sqlite3` and the client).
4. Open the service's **Environment** tab and copy the value of `VANTAGE_SETUP_TOKEN`.
5. Visit the site. The setup page asks for that token, then creates the owner account and the first unit. This only works once; afterwards the token is inert.
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

## Custom domain

`render.yaml` lists `vantageusmc.com` and `www.vantageusmc.com`. Render issues and renews the TLS certificate once DNS points at it; see [dns-namecheap.md](dns-namecheap.md), which also covers Cloudflare, email records and DNSSEC. Keep `VANTAGE_PUBLIC_URL` equal to the canonical origin. Passkeys are bound to that hostname, so changing it later invalidates every registered passkey.

## Optional services

- **Email** (reset links, invitations, digests, team messages): `VANTAGE_EMAIL_PROVIDER=direct` sends from `vantageusmc.com` itself, with no email service; finish it in **Owner console → Email**. Resend or any SMTP relay also work. See [email.md](email.md).
- **AI drafting needs a DoD-network host.** GenAI.mil answers every API call from outside DoD networks with a 503 "Unauthorized Access" page, whatever key is sent. Render, like every commercial host, is outside those networks, so on Render the AI features stay unavailable and the Owner console explains why. To use AI, run Vantage on a host inside a DoD network (the same Docker image works anywhere) and then: add `VANTAGE_GENAI_API_KEY` (your GenAI.mil key) in the service's Environment tab and let Render redeploy. AI is on by default once a key exists; the owner console's AI tab shows the key fingerprint, discovers the models the key can reach, edits the allowlist in `VANTAGE_GENAI_MODELS`, and switches AI off without a redeploy. Without a key the AI pages explain what is missing.
- **Microsoft 365 mailboxes** (Correspondence reads mail from a connected mailbox, read-only): register a web application in Microsoft Entra for the cloud your mailboxes are in (commercial, GCC High or DoD). Add the redirect URI `https://<your domain>/api/correspondence/connectors/callback`, grant the delegated permissions `User.Read`, `Mail.Read` and `offline_access` and nothing broader, create a client secret, and set `VANTAGE_M365_CLIENT_ID`, `VANTAGE_M365_CLIENT_SECRET`, and optionally `VANTAGE_M365_TENANT` (a tenant id pins sign-in to one directory; the default `organizations` accepts any work account). Each person then adds their mailbox by address and authorizes it; the sign-in must match the address, a grant broader than read is refused, tokens are stored encrypted with `VANTAGE_SECRET`, and a revoked or expired grant shows on the mailbox as needing authorization. Rotating `VANTAGE_SECRET` makes stored tokens unreadable, so every mailbox has to be authorized again.
- **Self-registration**: `VANTAGE_SELF_REGISTRATION=true` lets anyone with the URL create an account. Default is off; leaders invite by link or email.

## Sizing

SQLite on the Render disk handles this workload comfortably. The app refuses new writes when the database file nears `VANTAGE_MAX_DB_BYTES` (default 800 MB) so a full disk never corrupts anything. Attachments count toward that; the owner can disable them.

## Upgrades

Push to `main`. Schema migrations run automatically at boot inside a transaction. Take a backup first from **Owner console → Backup and move** when a release note says so.

## If Render goes away

The owner console exports the entire instance as JSON (accounts, credentials, units, roles, records, attachments, audit log). A fresh Vantage on any host imports it. See [operations.md](operations.md).
