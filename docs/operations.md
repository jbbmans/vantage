# Operations

This is the Vantage team's run book for the central service. Commands do not run Vantage; what a Unit Instance's
Unit Managers do for themselves is in the Unit Manager console, and is noted where it touches these steps.

## Backups

Render disks are not backed up for you. Take a consistent copy of the SQLite file (SQLite's online backup API, safe while the app runs) weekly and before every upgrade, and store it somewhere the data classification allows.

- **On the server** (the way to do it on an accredited host): `VANTAGE_DB=/data/vantage.db npm run backup -- /backups/vantage-$(date +%F).db`. The copy is written readable by its owner only; encrypt it before it leaves the host.
- **From the browser**: **Vantage Administrator console → Backup and recovery → Download backup** (Lead Vantage Administrators). Every other Lead Vantage Administrator is notified each time a backup or service archive is downloaded. Set `VANTAGE_BROWSER_BACKUPS=false` to close this path where policy requires backups to stay on the server.

Each backup taken either way is recorded in the database it copied: when, how, its size and file name, and for a download, who took it. **Vantage Administrator console → Operations → Backups** shows the last 20 and whether the newest is fresh. One older than `VANTAGE_BACKUP_MAX_AGE_HOURS` (default 168, a week) or none at all needs attention on the console's health check. If the script cannot record the backup, the copy still stands and the script says so. A snapshot the hosting environment takes on its own (a volume snapshot, storage replication) never passes through Vantage and is not shown (I-28).

Restoring a `.db` file: turn on maintenance mode, replace `/data/vantage.db` (a Render shell: `render ssh`, then `cp`), delete any `-wal` and `-shm` siblings, restart the service.

## Moving the service to another host

1. **Vantage Administrator console → Backup and recovery → Export the service.** One JSON file with everything: organizations and their roles, platform staff, accounts (password hashes, TOTP secrets, passkeys), units, roles, memberships, every record, attachments, notifications, Vantage access history, the audit trail.
2. Stand up Vantage on the new host (Docker image, or `npm ci && npm run build && npm start`). Use the same `VANTAGE_PUBLIC_URL` (or `VANTAGE_SITE_URL`, `VANTAGE_APP_URL`, `VANTAGE_CONSOLE_URL` and `VANTAGE_ADMIN_URL`) and the same `VANTAGE_SECRET` (or the new secret with the old one as `VANTAGE_SECRET_PREVIOUS`, see [Changing the secret](#changing-the-secret)), otherwise TOTP secrets cannot be decrypted and the audit chain will not verify. Passkeys survive only if the hostname is unchanged.
3. Complete setup on the new host with any throwaway account, then **Import** the JSON from the Vantage Administrator console. The import replaces everything, including that throwaway account, and resets every session.
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
anchor of every case history's head is an audit record and travels the same way. The Vantage Administrator console's Audit chain
panel says where copies go, how many were sent, and warns when there are none.

## Adding people from a roster

A Unit Instance's Unit Managers do this themselves: **Unit Manager console → People → Import accounts** takes an `.xlsx` or `.csv` with a header row. `Username`, `First Name` and `Last Name` are required; `Rank`, `L2 Command` (or `Command`), `Fire Team` (or `Team`, `Unit`, `Section`), `Email`, `Temporary Password`, `Role` and `Billet` are used when present. The file is read and every row is shown first: what will be created, what already exists, and what is skipped and why. Nothing is written until you confirm.

- Each command and team is matched to a unit of that organization by name or short name, or created inside it: a command directly under the organization's top unit (or the top unit itself, if the roster names it), a team under its command. New units are governed from above, by the top unit's leader and the Unit Instance's Unit Managers. A row that names no unit joins the top unit. Units of other organizations are never matched.
- Roles are the unit's role names (`Marine`, `NCO`, `Fire Team Leader`, `SNCO`, `SNCOIC`). Unit Leader goes with ownership and cannot be imported.
- Every account starts on its temporary password and must choose its own at first sign-in. A row with no temporary password gets one, shown once after the import with a download.
- A username that already exists is left as it is (it may belong to someone in another organization), so the same roster can be imported again safely. Invite that person with a join code instead.

The roster holds names, email addresses and passwords. Keep it out of the repository and delete it once everyone has signed in.

## Starting over

`scripts/start-over.ts` erases every account, unit and record, creates the Lead Vantage Administrator account and its first unit, and optionally imports a roster, in one run. It first saves a copy of the database beside it (`/data/vantage-before-start-over-<time>.db`). It empties the tables in place, so the running server carries on without a restart, and everyone who was signed in is signed out.

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

The new account is `vantage.admin` (`--admin` to change it), named Vantage Admin (`--first`, `--last`): a Lead Vantage Administrator, and Lead Unit Manager and leader of the first Unit Instance. Name the unit what the roster calls its command, so the import files people under it. Nothing is erased if the password is too weak, the arguments are wrong, or the roster cannot be read. Once the new setup is confirmed, delete the backup: `rm /data/vantage-before-start-over-*.db`.

Without a shell, the same result takes three steps: `VANTAGE_FACTORY_RESET=1 node scripts/factory-reset.ts ERASE-EVERYTHING` and **Manual Deploy → Restart service**; first-run setup on the site, which asks for the **Deployment setup token** (Render → Environment → `VANTAGE_SETUP_TOKEN`); then **Import accounts** as above.

## Recovering access

- **A Unit Instance with no Lead Unit Manager left** (moved, separated, locked out): **Vantage Administrator console → Unit Instances → Name Lead Unit Manager** names one, only for a Unit Instance with none, and never the Vantage Administrator doing it (ADR-0010). Someone not yet a member is seated in its top unit. A Unit Instance that has Lead Unit Managers names its own. A Lead Unit Manager who has left every unit of the instance, or been separated by the roster feed, no longer counts.
- **Every Lead Vantage Administrator locked out:** `VANTAGE_RECOVERY=1 npm run recover-operator -- <username>` on the server makes that account a Lead Vantage Administrator, clears its authenticator, and prints a temporary password. On Render use `render ssh vantage` then `cd /app && VANTAGE_RECOVERY=1 node scripts/recover-operator.ts <username>`. Sessions for that user are reset; sign in with the temporary password and set a new one.

## Lost phone

Anyone can clear their own after signing in with a recovery code. Otherwise it is Vantage support's: **Vantage Administrator console → Accounts → Reset 2FA** removes the authenticator, recovery codes and passkeys, signs the person out everywhere, and tells them. Then **Temp password** if the password is lost too. An account can belong to more than one organization, so a Unit Instance's Unit Managers can unlock and sign out their members but not reset their credentials. Each step Vantage support takes on an account is written into the audit trail of every Unit Instance the person serves in, and where they hold a Unit Instance role or lead a unit, its Lead Unit Managers are told. A Vantage staff member's own account is recovered only by a Lead Vantage Administrator.

## Maintenance mode

**Vantage Administrator console → Maintenance → Start maintenance** (Lead Vantage Administrators and Vantage Administrators, `platform.maintenance`) blocks everyone but Vantage staff with a 503, in every Unit Instance, including registration, invitations and password resets. Others can still sign in, but every other request is refused until it ends. Turn it on before a restore or a move.

- **Starting** needs a reason of at least ten characters, kept with staff and in the audit trail. It may carry a message for everyone else and an expected end within a week. Every refused request and the sign-in page show that message and the expected end, in the deployment's time zone.
- **It ends only when somebody ends it** (**End maintenance**, with an optional note). An expected end that passes needs attention on the health check; it does not open the service on its own.
- **The other Vantage staff are told** each time it starts and ends, and the audit trail records `maintenance_on` with the reason and expected end, and `maintenance_off` with how long it lasted and the note. A banner on every console page says it is on.
- Maintenance is no longer a setting: `PUT /api/platform/runtime` refuses `maintenance`, and Settings and Backup and recovery link here.

### Database tasks

**Maintenance → Database tasks** runs a fixed list of tasks, never a statement typed in. Each run is audited as `maintenance_task` with its result, which is counts and table names only.

| Task | What it runs | When |
|---|---|---|
| Check the database for damage | `PRAGMA quick_check` | any time |
| Check references between records | `PRAGMA foreign_key_check` | any time |
| Fold the write-ahead log into the database | `PRAGMA wal_checkpoint(TRUNCATE)` | any time |
| Refresh query statistics | `PRAGMA optimize` | any time |
| Clear expired sessions | the nightly session prune, now | any time |
| Verify the audit trail and case histories | the audit chain and every case history | any time |
| Compact the database | `VACUUM` | only during maintenance, and only with free disk of about twice the database (its working copy goes to disk, not memory) |

Compacting holds the database for its whole run. Take a backup first.

## Vantage access to an organization

Staff never see inside an organization by holding a platform role. **Vantage Administrator console → Organizations → Ask for access** (or Vantage access) names the reason and the length (four hours by default, never more than a day). Its Lead Unit Managers approve or deny it in **Unit Manager console → Vantage access**; a Unit Instance can instead choose to be told rather than asked. Access is read-only, covers its units and the work shared with them (never member detail or private entries), ends on its own or when a Lead Unit Manager ends it, and every step is in both the organization's audit trail and the platform's. A request nobody answers lapses after a day.

## Upgrading from Vantage 4

5.0 uses a fresh schema and does not migrate 4.x data. On first start against a 4.x database file, the server moves it aside as `vantage.db.legacy-<timestamp>` and creates a new database; nothing is overwritten. Keep the legacy file if you need it on a 4.x build.

## Health

`GET /api/health` returns `{ ok, version, build, client, uptime, maintenance, mode, profile }` and exercises the database. Render polls it; a failing deploy never goes live. It says only whether the service answers.

**Vantage Administrator console → Operations** is the full report, for staff (ADR-0011). Each check is OK, needs attention or failing, and the Overview shows the worst of them:

| Check | Needs attention | Failing |
|---|---|---|
| Database size against `VANTAGE_MAX_DB_BYTES` | 80% | 100% (new records pause) |
| Free disk where the database lives | under 15% | under 5% |
| Schema against this build | the database is newer than the build | the database is older |
| Audit trail | forwarding off on MCEN, or dropping entries | the chain does not verify |
| Backups | older than `VANTAGE_BACKUP_MAX_AGE_HOURS`, or none | |
| Email in the last day | more failed than sent, or mail queued over six hours | |
| Scheduled jobs | none running, overdue, or failing | |
| Sign-in | a CRL within 48 hours of its next update, a CA expired or within 30 days of expiry, revocation checking off, staff with no second factor | no CRL, an unreadable one, or one past its next update; every CA expired |
| Maintenance | on, or past its expected end | |
| Unit Instances | an active one with no Lead Unit Manager | |

The same page shows the build and when each build first served this database, every migration this build carries with when it ran and under which version, the last 20 backups and the scheduled jobs (runs, failures, the last error). Job tracking lives in the process and starts empty on each start.

**Sign-in health** lists each revocation list with its issuer and next update, each trusted CA with its expiry, organization sign-in (with **Check the provider**, which reads the discovery document and keys fresh and is audited), the lockout policy, second-factor coverage and the last day's sign-ins and refusals. All of it is counts and dates; nobody is named.

## Retention

- Deleted records sit in a recycle bin for 30 days, then purge nightly.
- Sessions expire after 15 minutes idle (10 for an owner) and 12 hours absolute (`VANTAGE_IDLE_MINUTES`, `VANTAGE_OPERATOR_IDLE_MINUTES`, `VANTAGE_SESSION_HOURS`). Background polls do not count as activity.
- The audit log is append-only and never purged.
