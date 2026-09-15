# Synthetic video staging

This isolated deployment supports the approved Vantage SEO/video audit. Audited base: `3e0bcf412cf1db86734af7618eeb9c21b3925374`. Production frontend, server entry point, and deployment configuration are unchanged.

## Deployment and isolation

- Branch: `seo-video-growth-2026-09-14` (draft PR; do not merge).
- New Render service: `vantage-video-staging`; native Node; free compute; Ohio; auto-deploy off.
- Build: `npm ci --include=dev && node scripts/build-video-staging.ts`.
- Start: `node scripts/start-video-staging.ts`.
- Set `NODE_VERSION=22.18.0` and `VANTAGE_STAGE_MODE=synthetic-only`.
- Render supplies `RENDER_SERVICE_NAME`, `RENDER_EXTERNAL_URL`, `PORT` and commit identity.
- Do not attach production environment groups, domains, disks, backups or databases.

The startup validates service identity and a dedicated HTTPS onrender.com origin before touching a database. Every process start creates a new private temporary directory, fresh synthetic SQLite database, and random app/setup secrets. All edits and sessions reset on restart. Nothing is imported from production. Free Render storage is ephemeral; this is not durable storage or a production deployment pattern.

Production-mode authentication remains enabled; test mode is rejected. Registration is closed and setup is already initialized. Email, AI, CAC and MARADMIN integrations are disabled; background schedulers are not started. Administrator mutations, including runtime changes and whole-instance imports, are blocked in a staging-only wrapper. Read-only operator screens remain accessible to the synthetic owner. These restrictions mean setup/governance configuration-saving flows cannot be represented as verified by this staging deployment.

The build writes the actual staging origin, noindex metadata, a disallow-all robots file, empty sitemap and staging llms text to dist only. Every response includes an X-Robots-Tag noindex header, even if the unchanged client-side metadata code updates its robots tag. Indexing signals are not access controls.

## Synthetic accounts

| Username | Fictional name | Authority | Environment key |
| --- | --- | --- | --- |
| demo.member | Alex Example | Ordinary member | VANTAGE_STAGE_MEMBER_PASSWORD |
| demo.leader | Jordan Sample | SNCOIC in example section | VANTAGE_STAGE_LEADER_PASSWORD |
| demo.owner | Casey Fiction | Unit owner and staging instance operator | VANTAGE_STAGE_OWNER_PASSWORD |

Accounts remain inactive until their dedicated variable contains a valid, distinct passphrase. No default passwords exist. Provision new staging-only passphrases securely in Render's Environment settings, then deploy/restart. Do not reuse production, personal, or chat-posted passwords. Never include secret values in logs, recordings, PRs, or documentation. Removing a variable and restarting locks that account and resets all sessions and demo data.

Seeded data includes eight activities (one private), a project, assigned task, manual goal, training, and counseling. All identities, emails, units, locations, quantities and narratives are invented. Do not enter real or operational information.

## Validation and review

The dedicated server tests cover service/origin restrictions, inherited-config isolation, locked accounts, invalid credentials, production-mode cookie login, no bearer-token disclosure, closed setup/registration, role access, private versus shared visibility, noindex headers and blocked operator mutations. Existing repository CI remains unchanged and runs lint, typecheck, server tests, frontend build, browser tests and Docker build on the PR.

Before footage: securely provision synthetic credentials; verify desktop/mobile flows in the actual staging UI; check quick log, visibility, import mapping, queue actions, Report Studio provenance and exports. Automated checks do not substitute for UI evidence. Use no production accounts or data.

Real UI recordings, captions, posters, transcripts, final scripts, and production SEO implementation remain pending. The static legacy prototype is not evidence of working product behavior. Do not invent integrations, outcomes or government endorsement. No production merge/deployment is included in this change.
