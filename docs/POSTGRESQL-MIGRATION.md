# PostgreSQL migration path

VANTAGE remains a SQLite runtime today. This toolkit prepares and proves a lossless, security-conscious PostgreSQL import before the application is allowed to cut over. It does not change the configured production database or delete the SQLite source.

## Safety properties

- The source database is opened read-only and copied through SQLite's online backup API.
- The copy must pass `integrity_check`, `foreign_key_check`, current-schema, and tamper-evident audit-chain verification.
- The PostgreSQL target must be empty. Existing VANTAGE tables make the import fail and the transaction roll back.
- All application foreign keys are deferred during import and forced valid before commit.
- PostgreSQL identity sequences preserve append order for the audit chain and incident-event history, replacing SQLite's implicit `rowid` dependency.
- Every table has an in-transaction row-count assertion.
- Binary attachment contents are transferred as PostgreSQL `bytea` without decoding them into text.
- Values are SQL-escaped; unsupported NUL text and non-finite numbers stop the export.
- Active sessions are intentionally omitted, forcing every browser to authenticate again after cutover.
- The SQL export and its manifest are created with owner-only file permissions and are never overwritten.

The export contains password hashes, financial records, attachments, and confidential security cases. Treat both files as controlled sensitive data and move them only through approved encrypted storage and transport.

## 1. Prepare an import package

Use the same `VANTAGE_AUDIT_HMAC_KEY` as the running deployment so the exporter can authenticate the audit chain. Provide absolute source and output paths:

```bash
npm run migrate:postgres:prepare -- \
  --source /data/vantage.db \
  --output /data/secure-export/vantage-postgres.sql
```

The command produces:

- `vantage-postgres.sql` — PostgreSQL schema, data, constraints, and row-count assertions in one transaction.
- `vantage-postgres.sql.manifest.json` — source snapshot digest, schema version, audit count, and source/exported row counts per table.

Run `npm run test:postgres-migration` before using the generated package.

## 2. Provision the Render database

Create a new Render Managed PostgreSQL database in the same workspace and region as the VANTAGE service. Choose the database name, database user, region, and PostgreSQL major version deliberately; Render does not allow those fields to be changed in place later.

Use PostgreSQL 15 or newer. Size storage with recovery headroom; Render storage cannot be shrunk after an increase. Confirm the plan's backup retention and, when required, point-in-time recovery before importing production data.

Do not attach the application yet. The current VANTAGE runtime is SQLite-only.

## 3. Rehearse on an empty non-production target

Use the Render **external** URL from an approved migration workstation and require TLS. Keep the credential outside shell history:

```bash
read -s VANTAGE_POSTGRES_EXTERNAL_URL
export VANTAGE_POSTGRES_EXTERNAL_URL
psql "$VANTAGE_POSTGRES_EXTERNAL_URL" -f /secure/path/vantage-postgres.sql
unset VANTAGE_POSTGRES_EXTERNAL_URL
```

The script uses `ON_ERROR_STOP`, one transaction, deferred foreign keys, forced constraint validation, and exact row-count checks. Any failure rolls back the import.

After import, compare the target counts with the manifest and verify:

```sql
SELECT value FROM meta WHERE key = 'schema_version';
SELECT COUNT(*) FROM audit_log;
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM units;
SELECT COUNT(*) FROM activities;
SELECT COUNT(*) FROM attachments;
SELECT COUNT(*) FROM security_incidents;
SELECT COUNT(*) FROM sessions;
```

The `sessions` result must be zero. Validate attachment downloads, exact-unit visibility, audit-chain verification, and all security/tenancy tests against the future PostgreSQL runtime before production cutover.

## 4. Runtime-conversion gate

Do not point production at PostgreSQL until a separate runtime adapter passes all of these gates:

1. Every database operation uses the adapter; no request path reaches `better-sqlite3` when PostgreSQL is selected.
2. Transactions are awaited and preserve the existing atomic boundaries.
3. Username case-folding, partial uniqueness, role/unit consistency, optimistic versions, and identity-sequence audit/event ordering behave identically.
4. The full API, security, exact-unit tenancy, migration, load-50, persona-100, browser, accessibility, and mobile suites pass against PostgreSQL.
5. Backup, capacity, health, maintenance, recovery, and factory-reset operations either support PostgreSQL or fail closed with accurate operator guidance.
6. The PostgreSQL connection uses a bounded application pool and shuts down cleanly on `SIGTERM`.

For the Render-hosted service, use the database's **internal** connection URL so traffic remains on Render's private network. Render does not supply a managed pooler; the application must own its pool and stay below the plan's connection limit.

## 5. Production cutover

Use a planned maintenance window:

1. Enable VANTAGE maintenance mode and stop writes.
2. Download and retain the audited SQLite backup plus its WAL companions.
3. Generate a fresh PostgreSQL import and manifest.
4. Import into a new empty PostgreSQL database.
5. Run target verification and the release smoke suite.
6. Deploy the PostgreSQL-capable application with the Render internal URL supplied as a secret.
7. Keep the SQLite volume read-only and retained through the rollback window.
8. Require all users to sign in again.

Never place either Render connection URL in YAML, source control, logs, screenshots, or tickets.

## Rollback

Before PostgreSQL accepts production writes, rollback is safe: redeploy the prior SQLite image, restore the retained SQLite snapshot and WAL state, and validate health and audit integrity.

After PostgreSQL accepts writes, switching back to the old SQLite snapshot would lose those writes. A post-write rollback therefore requires a separately tested PostgreSQL-to-SQLite recovery path or restoration into another PostgreSQL instance. Keep the maintenance window active until the canary and smoke gates pass; do not use dual writes.

Render database deletion is not a rollback method. Deleting a Render PostgreSQL instance also removes its retained backups, so export or restore it elsewhere first.
