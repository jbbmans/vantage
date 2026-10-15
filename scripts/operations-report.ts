import Database from 'better-sqlite3';
import { hostname } from 'node:os';
import { loadConfig } from '../server/config.ts';
import { metaGet, SCHEMA_VERSION } from '../server/db/index.ts';
import { upgradeHistory } from '../server/db/upgrades.ts';
import { VERSION } from '../server/version.ts';
import { backupHistory } from '../server/services/backupLog.ts';
import { restoreHistory } from '../server/services/restoreLog.ts';
import { instanceOperations, operationsSummary } from '../server/services/instanceOperations.ts';
import type { AppContext } from '../server/context.ts';

/**
 * Each Unit Instance's operations as one JSON document, read on the host without starting Vantage or writing anything:
 * `npm run operations-report > operations.json` (ADR-0014). It is the adapter for whatever the enterprise uses to watch
 * many deployments at once (I-13, I-34): a dedicated deployment's one Unit Instance, or a shared one's every Unit
 * Instance, with the version, schema, last upgrade, health, backup freshness, last restore and withheld features of each.
 * The service's own health needs the running process (its jobs, its connections), so here it is not checked; the
 * Vantage Administrator console's Operations page has it.
 */
const config = loadConfig();
if (config.databasePath === ':memory:') { console.error('VANTAGE_DB is in memory here; there is no database to report on.'); process.exit(1); }
const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
const schema = Number(metaGet(db, 'schema_version') || 0);
if (schema !== SCHEMA_VERSION) {
  console.error(`The database is at schema ${schema} and this build reports on ${SCHEMA_VERSION}. Run the report with the build the service runs.`);
  process.exit(1);
}
const ctx = { db, config, mailer: { enabled: true } } as unknown as AppContext;
const instances = instanceOperations(ctx, { service: 'info' });
for (const i of instances) i.health.checks[0] = { id: 'service', label: 'The service', status: 'info', summary: 'Not checked here: the service’s own checks need it running. See Operations in the Vantage Administrator console.' };
const backups = backupHistory(db);
const report = {
  format: 'vantage-operations/1',
  generatedAt: new Date().toISOString(),
  host: hostname(),
  deployment: { profile: config.deployment.profile, topology: config.deployment.topology, database_id: metaGet(db, 'database_id') },
  service: {
    version: VERSION, schema: { database: schema, code: SCHEMA_VERSION },
    lastBackup: backups.at(-1) ? { at: backups.at(-1)!.at, method: backups.at(-1)!.method, seq: backups.at(-1)!.seq ?? null } : null,
    upgrades: upgradeHistory(db).slice(-5).reverse().map(({ id, at, version, schema: s, status, failed, reviewed }) => ({ id, at, version, schema: s, status, failed: failed ?? null, reviewed: Boolean(reviewed) })),
    restores: restoreHistory(db).slice(-5).reverse().map(({ id, at, method, restored, lost, finding }) => ({ id, at, method, restoredTo: restored.at, lost: lost?.entries ?? null, finding: finding ?? null })),
  },
  summary: operationsSummary(instances),
  instances,
};
db.close();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
