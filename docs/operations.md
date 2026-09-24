# Operations

## Backups

Render disks are not backed up for you. From **Owner console → Backup and move → Download backup** you get a consistent copy of the SQLite file (uses SQLite's online backup API, safe while the app runs). Do it weekly and before every upgrade. Store it somewhere the data classification allows.

On a server, schedule the command instead:

```bash
npm run backup -- --dir /var/backups/vantage --keep 14
```

It takes the same online copy, opens it and runs a full integrity check, writes `<file>.sha256` beside it, records the time (the owner console shows it), and keeps the newest 14. A copy that fails the check is deleted and the command exits non-zero, so the scheduler reports it. Defaults come from `VANTAGE_BACKUP_DIR` and `VANTAGE_BACKUP_KEEP`. A daily cron line:

```cron
15 2 * * * cd /app && VANTAGE_DB=/data/vantage.db npm run backup --silent >> /var/log/vantage-backup.log 2>&1
```

The copies sit on the same host until something moves them. Where they go next (another disk, object storage) is an owner decision; see `docs/engineering/ENTERPRISE_READINESS.md`.

## Health probes

- `GET /api/health/live`: the process is up. Restart it if this fails.
- `GET /api/health/ready`: the database answers and is at this build's schema. Send traffic only when it returns 200; it returns 503 with the failing check otherwise.
- `GET /api/health`: the original combined check, still used by the Dockerfile and `render.yaml`.

Restoring a `.db` file: turn on maintenance mode, replace `/data/vantage.db` (a Render shell: `render ssh`, then `cp`), delete any `-wal` and `-shm` siblings, restart the service.

## Moving to another host

1. **Owner console → Export instance.** One JSON file with everything: accounts (password hashes, TOTP secrets, passkeys), units, roles, memberships, every record, attachments, notifications, audit log.
2. Stand up Vantage on the new host (Docker image, or `npm ci && npm run build && npm start`). Use the same `VANTAGE_PUBLIC_URL` and the same `VANTAGE_SECRET`, otherwise TOTP secrets cannot be decrypted and the audit chain will not verify. Passkeys survive only if the hostname is unchanged.
3. Complete setup on the new host with any throwaway owner account, then **Import** the JSON. The import replaces everything, including that throwaway account, and resets every session.
4. Point DNS at the new host.

## Recovering owner access

If every owner is locked out: `VANTAGE_RECOVERY=1 npm run recover-operator -- <username>` on the server grants owner authority, clears that account's authenticator, and prints a temporary password. On Render use `render ssh vantage` then `cd /app && VANTAGE_RECOVERY=1 node scripts/recover-operator.ts <username>`. Sessions for that user are reset; sign in with the temporary password and set a new one.

## Lost phone

The owner (or any user for themselves after signing in with a recovery code) can clear MFA. **Owner console → Accounts → Reset MFA** removes the authenticator, recovery codes, and passkeys, and signs the user out everywhere. Then **Temp password** if the password is lost too.

## Maintenance mode

**Owner console → Settings → Maintenance** blocks everyone but owners with a 503, including registration, invitations, and password resets. Non-owners can still sign in, but every other request is refused until it is turned off. Turn it on before a restore or a move.

## Upgrading from Vantage 4

5.0 uses a fresh schema and does not migrate 4.x data. On first start against a 4.x database file, the server moves it aside as `vantage.db.legacy-<timestamp>` and creates a new database; nothing is overwritten. Keep the legacy file if you need it on a 4.x build.

## Health

`GET /api/health` returns `{ ok, version, uptime, maintenance }` and exercises the database. Render polls it; a failing deploy never goes live.

## Retention

- Deleted records sit in a recycle bin for 30 days, then purge nightly.
- Sessions expire after 60 minutes idle and 12 hours absolute (`VANTAGE_IDLE_MINUTES`, `VANTAGE_SESSION_HOURS`).
- The audit log is append-only and never purged.
