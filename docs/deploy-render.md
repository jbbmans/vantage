# Deploying on Render

The whole system is one web service with a persistent disk. Budget: the Starter plan plus a 1 GB disk, which is what the previous version cost.

## First deploy

1. The code lives at https://github.com/jbbmans/vantage-main (`main` is the deploy branch).
2. In Render, choose **New → Blueprint**, pick the repository, and accept `render.yaml`. Render creates the `vantage` service, the `vantage-data` disk mounted at `/data`, and generates `VANTAGE_SECRET` and `VANTAGE_SETUP_TOKEN`.
3. Wait for the first build (5 to 8 minutes; it compiles `better-sqlite3` and the client).
4. Open the service's **Environment** tab and copy the value of `VANTAGE_SETUP_TOKEN`.
5. Visit the site. The setup page asks for that token, then creates the owner account and the first unit. This only works once; afterwards the token is inert.
6. Sign in, open **Settings → Security**, add a passkey and an authenticator app.

Auto-deploy is on: every push to `main` builds and replaces the running container after the health check at `/api/health` passes. Failed builds never replace the running version.

## Custom domain

`render.yaml` lists `vantageusmc.com` and `www.vantageusmc.com`. Render issues and renews the TLS certificate once DNS points at it; see [dns-namecheap.md](dns-namecheap.md). Keep `VANTAGE_PUBLIC_URL` equal to the canonical origin. Passkeys are bound to that hostname, so changing it later invalidates every registered passkey.

## Optional services

- **Email** (reset links, invitations, digests): set `VANTAGE_EMAIL_PROVIDER=resend` and `RESEND_API_KEY`, or `smtp` and `SMTP_URL`. See [email.md](email.md).
- **AI drafting needs a DoD-network host.** GenAI.mil answers every API call from outside DoD networks with a 503 "Unauthorized Access" page, whatever key is sent. Render, like every commercial host, is outside those networks, so on Render the AI features stay unavailable and the Owner console explains why. To use AI, run Vantage on a host inside a DoD network (the same Docker image works anywhere) and then: add `VANTAGE_GENAI_API_KEY` (your GenAI.mil key) in the service's Environment tab and let Render redeploy. AI is on by default once a key exists; the owner console's AI tab shows the key fingerprint, discovers the models the key can reach, edits the allowlist in `VANTAGE_GENAI_MODELS`, and switches AI off without a redeploy. Without a key the AI pages explain what is missing.
- **Self-registration**: `VANTAGE_SELF_REGISTRATION=true` lets anyone with the URL create an account. Default is off; leaders invite by link or email.

## Sizing

SQLite on the Render disk handles this workload comfortably. The app refuses new writes when the database file nears `VANTAGE_MAX_DB_BYTES` (default 800 MB) so a full disk never corrupts anything. Attachments count toward that; the owner can disable them.

## Upgrades

Push to `main`. Schema migrations run automatically at boot inside a transaction. Take a backup first from **Owner console → Backup and move** when a release note says so.

## If Render goes away

The owner console exports the entire instance as JSON (accounts, credentials, units, roles, records, attachments, audit log). A fresh Vantage on any host imports it. See [operations.md](operations.md).
