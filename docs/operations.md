# Operations

## Backups

Render disks are not backed up for you. Take a consistent copy of the SQLite file (SQLite's online backup API, safe while the app runs) weekly and before every upgrade, and store it somewhere the data classification allows.

- **On the server** (the way to do it on an accredited host): `VANTAGE_DB=/data/vantage.db npm run backup -- /backups/vantage-$(date +%F).db`. The copy is written readable by its owner only; encrypt it before it leaves the host.
- **From the browser**: **Owner console → Backup and move → Download backup**. Every other owner is notified each time a backup or instance archive is downloaded. Set `VANTAGE_BROWSER_BACKUPS=false` to close this path where policy requires backups to stay on the server.

Restoring a `.db` file: turn on maintenance mode, replace `/data/vantage.db` (a Render shell: `render ssh`, then `cp`), delete any `-wal` and `-shm` siblings, restart the service.

## Moving to another host

1. **Owner console → Export instance.** One JSON file with everything: accounts (password hashes, TOTP secrets, passkeys), units, roles, memberships, every record, attachments, notifications, audit log.
2. Stand up Vantage on the new host (Docker image, or `npm ci && npm run build && npm start`). Use the same `VANTAGE_PUBLIC_URL` and the same `VANTAGE_SECRET` (or the new secret with the old one as `VANTAGE_SECRET_PREVIOUS`, see [Changing the secret](#changing-the-secret)), otherwise TOTP secrets cannot be decrypted and the audit chain will not verify. Passkeys survive only if the hostname is unchanged.
3. Complete setup on the new host with any throwaway owner account, then **Import** the JSON. The import replaces everything, including that throwaway account, and resets every session.
4. Point DNS at the new host.

## Changing the secret

`VANTAGE_SECRET` seals the values Vantage keeps encrypted (authenticator secrets, mailbox tokens, the DKIM key,
queued mail) and the chain key the audit log and case histories are signed with. To change it, for a schedule or
because it may have been exposed:

1. Set the new value as `VANTAGE_SECRET` and the old one as `VANTAGE_SECRET_PREVIOUS`.
2. Start Vantage once. That start re-seals every stored value and the chain key under the new secret, and logs how
   many values it changed. The audit chain and case histories keep verifying: they are signed with the chain key,
   which does not change.
3. Remove `VANTAGE_SECRET_PREVIOUS` and restart.

Started with a secret that opens nothing in the database, Vantage refuses to start and says which variable to set.
Exports taken before the change still import while `VANTAGE_SECRET_PREVIOUS` holds the old value.

If you believe the chain key itself was exposed, the copies of the audit log held off the host (see
[Audit records off the host](#audit-records-off-the-host)) are the evidence a rewrite would have to match.

## Audit records off the host

The audit chain and case seals detect a change made by somebody who has the database but not the secret. Somebody
who has the whole server has both. What catches them is a copy they do not control. Send one:

- `VANTAGE_AUDIT_SYSLOG=tls://siem.example.mil:6514` (or `tcp://`, `udp://`) sends every audit record, as it is
  committed, to a syslog collector in RFC 5424 format (facility 13, log audit; octet-counted framing on TCP and TLS).
  `VANTAGE_AUDIT_SYSLOG_CA` names a CA bundle for a collector whose certificate is not in the system store.
- `VANTAGE_AUDIT_STDOUT=true` writes each record to standard output as one JSON line, for a platform that already
  ships container logs somewhere you keep.

Each record carries its `entry_hash`, so a collector's copy can be compared with the chain at any time. The daily
anchor of every case history's head is an audit record and travels the same way. The Owner console's Audit chain
panel says where copies go, how many were sent, and warns when there are none.

## Adding people from a roster

**Owner console → Accounts → Import accounts** takes an `.xlsx` or `.csv` with a header row. `Username`, `First Name` and `Last Name` are required; `Rank`, `L2 Command` (or `Command`), `Fire Team` (or `Team`, `Unit`, `Section`), `Email`, `Temporary Password`, `Role` and `Billet` are used when present. The file is read and every row is shown first: what will be created, what already exists, and what is skipped and why. Nothing is written until you confirm.

- Each command and team is matched to an existing unit by name or short name, or created, with the team placed under its command. Units the import creates are led by the owner who ran it: a new command directly, and a new team through the command above it, so the owner is not listed as a member of every team.
- Roles are the unit's role names (`Marine`, `NCO`, `Fire Team Leader`, `SNCO`, `SNCOIC`). Unit Leader goes with ownership and cannot be imported.
- Every account starts on its temporary password and must choose its own at first sign-in. A row with no temporary password gets one, shown once after the import with a download.
- A username that already exists is left as it is, so the same roster can be imported again safely.

The roster holds names, email addresses and passwords. Keep it out of the repository and delete it once everyone has signed in.

## Starting over

`scripts/start-over.ts` erases every account, unit and record, creates the owner account and its first unit, and optionally imports a roster, in one run. It first saves a copy of the database beside it (`/data/vantage-before-start-over-<time>.db`). It empties the tables in place, so the running server carries on without a restart, and everyone who was signed in is signed out.

On Render, open the `vantage` service → **Shell**:

```sh
cd /app
cat > /tmp/roster.csv <<'ROSTER'
Rank,First Name,Last Name,L2 Command,Fire Team,Username,Email,Temporary Password,Role,Billet
...one line per person...
ROSTER
VANTAGE_START_OVER=1 VANTAGE_ADMIN_PASSWORD='<owner password>' node scripts/start-over.ts ERASE-EVERYTHING \
  --unit "Marine Forces Reserve" --short MARFORRES --roster /tmp/roster.csv
rm /tmp/roster.csv
```

The owner account is `vantage.admin` (`--admin` to change it), named Vantage Admin (`--first`, `--last`). Name the unit what the roster calls its command, so the import files people under it. Nothing is erased if the password is too weak, the arguments are wrong, or the roster cannot be read. Once the new setup is confirmed, delete the backup: `rm /data/vantage-before-start-over-*.db`.

Without a shell, the same result takes three steps: `VANTAGE_FACTORY_RESET=1 node scripts/factory-reset.ts ERASE-EVERYTHING` and **Manual Deploy → Restart service**; first-run setup on the site, which asks for the **Deployment setup token** (Render → Environment → `VANTAGE_SETUP_TOKEN`); then **Import accounts** as above.

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
- Sessions expire after 15 minutes idle (10 for an owner) and 12 hours absolute (`VANTAGE_IDLE_MINUTES`, `VANTAGE_OPERATOR_IDLE_MINUTES`, `VANTAGE_SESSION_HOURS`). Background polls do not count as activity.
- The audit log is append-only and never purged.
