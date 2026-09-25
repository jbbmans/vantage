# Operations

## Backups

Render disks are not backed up for you. From **Owner console → Backup and move → Download backup** you get a consistent copy of the SQLite file (uses SQLite's online backup API, safe while the app runs). Do it weekly and before every upgrade. Store it somewhere the data classification allows.

Restoring a `.db` file: turn on maintenance mode, replace `/data/vantage.db` (a Render shell: `render ssh`, then `cp`), delete any `-wal` and `-shm` siblings, restart the service.

## Moving to another host

1. **Owner console → Export instance.** One JSON file with everything: accounts (password hashes, TOTP secrets, passkeys), units, roles, memberships, every record, attachments, notifications, audit log.
2. Stand up Vantage on the new host (Docker image, or `npm ci && npm run build && npm start`). Use the same `VANTAGE_PUBLIC_URL` and the same `VANTAGE_SECRET`, otherwise TOTP secrets cannot be decrypted and the audit chain will not verify. Passkeys survive only if the hostname is unchanged.
3. Complete setup on the new host with any throwaway owner account, then **Import** the JSON. The import replaces everything, including that throwaway account, and resets every session.
4. Point DNS at the new host.

## Adding people from a roster

**Owner console → Accounts → Import accounts** takes an `.xlsx` or `.csv` with a header row. `Username`, `First Name` and `Last Name` are required; `Rank`, `L2 Command` (or `Command`), `Fire Team` (or `Team`, `Unit`, `Section`), `Email`, `Temporary Password`, `Role` and `Billet` are used when present. The file is read and every row is shown first: what will be created, what already exists, and what is skipped and why. Nothing is written until you confirm.

- Each command and team is matched to an existing unit by name or short name, or created, with the team placed under its command. Units the import creates are led by the owner who ran it.
- Roles are the unit's role names (`Marine`, `NCO`, `Fire Team Leader`, `SNCO`, `SNCOIC`). Unit Leader goes with ownership and cannot be imported.
- Every account starts on its temporary password and must choose its own at first sign-in. A row with no temporary password gets one, shown once after the import with a download.
- A username that already exists is left as it is, so the same roster can be imported again safely.

The roster holds names, email addresses and passwords. Keep it out of the repository and delete it once everyone has signed in.

## Starting over

This erases every account, unit and record. Download a backup first if anything might be needed later.

1. Render → the `vantage` service → **Shell**, then run
   `cd /app && VANTAGE_FACTORY_RESET=1 node scripts/factory-reset.ts ERASE-EVERYTHING`
2. Render → **Manual Deploy → Restart service**. The new instance starts on an empty database.
3. Open the site. It shows first-run setup, which asks for the **Deployment setup token** (Render → Environment → `VANTAGE_SETUP_TOKEN`). The account created here is the Instance Operator and leads the first unit; name that unit what the roster calls its command so the import files people under it.
4. Import the roster as above.

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
