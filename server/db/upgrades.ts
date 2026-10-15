import type Database from 'better-sqlite3';

type Db = Database.Database;

/**
 * Upgrade verification (ADR-0014). Before a start migrates a database that already holds data, it counts the rows of every
 * table, in total and for each Unit Instance; after, it counts again and keeps the difference in the database's upgrade
 * history (`upgrade_history`). An upgrade that lost rows, in the service or in one Unit Instance, says so in the Vantage
 * Administrator console and in that Unit Instance's operations view until a Vantage Administrator marks it reviewed. A
 * migration that fails is recorded with its error before the start gives up.
 *
 * Counting reads every table once on each side of the migrations, and only on a start that has migrations to run. It
 * imports nothing from server/db/index.ts, which imports it, so it holds its own small meta helpers.
 */

/** Tables an upgrade is not held to: what signs people in, queues and caches that come and go, and the records of the service itself. */
const NOT_COUNTED = new Set([
  'meta', 'sqlite_sequence', 'sessions', 'tokens', 'email_queue', 'oidc_states', 'connector_auth_states', 'product_events', 'demo_workspaces',
]);

export interface RowCounts {
  /** Rows in each table counted. */
  tables: Record<string, number>;
  /** Rows each Unit Instance holds, by table: tables that name it (org_id), and tables that name one of its units (unit_id). */
  instances: Record<string, Record<string, number>>;
}

export interface CountChange { table: string; before: number; after: number | null; intended?: boolean }

export interface UpgradeRecord {
  id: string;
  at: string;
  kind: 'schema';
  /** The version of Vantage that ran it. */
  version: string;
  schema: { from: number; to: number };
  /** verified: no table lost rows. changed: some did. failed: a migration threw, and the start stopped. */
  status: 'verified' | 'changed' | 'failed';
  ms: number;
  migrations: number[];
  failed?: { id: number; name: string; error: string };
  /** Tables whose service-wide count fell, or that are gone. */
  service: CountChange[];
  /** Unit Instances that hold fewer rows than before, and in which tables. */
  instances: Array<{ org_id: string; changes: CountChange[] }>;
  /** How many tables were counted. */
  checked: number;
  /** Written to the audit trail by the start that ran it (auditUpgrades). */
  audited: boolean;
  /** A Vantage Administrator looked at the losses and said so. */
  reviewed?: { at: string; by: string; byName: string; note: string } | null;
}

const UPGRADES_KEPT = 50;
const INSTANCES_KEPT = 200;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const columnsOf = (db: Db, table: string) => new Set((db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((c) => c.name));
const metaRead = (db: Db, key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const metaWrite = (db: Db, key: string, value: string) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

export function rowCounts(db: Db): RowCounts {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map((r) => r.name).filter((name) => !NOT_COUNTED.has(name));
  const tables: Record<string, number> = {};
  const instances: Record<string, Record<string, number>> = {};
  const unitsCarryOrg = names.includes('units') && columnsOf(db, 'units').has('org_id');
  for (const table of names) {
    tables[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n;
    if (table === 'organizations') continue;
    const columns = columnsOf(db, table);
    const grouped = columns.has('org_id')
      ? db.prepare(`SELECT org_id AS org, COUNT(*) AS n FROM ${quote(table)} WHERE org_id IS NOT NULL GROUP BY org_id`).all()
      : columns.has('unit_id') && unitsCarryOrg
        ? db.prepare(`SELECT u.org_id AS org, COUNT(*) AS n FROM ${quote(table)} t JOIN units u ON u.id = t.unit_id WHERE u.org_id IS NOT NULL GROUP BY u.org_id`).all()
        : [];
    for (const row of grouped as Array<{ org: string; n: number }>) (instances[row.org] ??= {})[table] = row.n;
  }
  return { tables, instances };
}

/** Where the second count holds fewer rows than the first, in the service and in each Unit Instance. A table now gone counts as null. */
export function compareCounts(before: RowCounts, after: RowCounts, intended: ReadonlySet<string> = new Set()) {
  const fell = (was: Record<string, number>, now: Record<string, number> | undefined): CountChange[] =>
    Object.entries(was).flatMap(([table, n]) => {
      const left = table in after.tables ? (now?.[table] ?? 0) : null;
      return (left ?? 0) < n ? [{ table, before: n, after: left, ...(intended.has(table) ? { intended: true } : {}) }] : [];
    });
  const service = fell(before.tables, after.tables);
  const instances = Object.entries(before.instances).flatMap(([org_id, counts]) => {
    const changes = fell(counts, after.instances[org_id]);
    return changes.length ? [{ org_id, changes }] : [];
  });
  return { service, instances };
}

/** The record's status from its count changes: any fall a migration did not declare makes it changed. */
export const upgradeStatus = (service: CountChange[], instances: Array<{ changes: CountChange[] }>): 'verified' | 'changed' =>
  service.some((c) => !c.intended) || instances.some((i) => i.changes.some((c) => !c.intended)) ? 'changed' : 'verified';

export function upgradeHistory(db: Db): UpgradeRecord[] {
  try {
    const parsed = JSON.parse(metaRead(db, 'upgrade_history') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function recordUpgrade(db: Db, record: UpgradeRecord) {
  const kept: UpgradeRecord = { ...record, instances: record.instances.slice(0, INSTANCES_KEPT) };
  db.transaction(() => metaWrite(db, 'upgrade_history', JSON.stringify([...upgradeHistory(db), kept].slice(-UPGRADES_KEPT)))).immediate();
  return kept;
}

/** Replaces one record of the history by its id, inside the caller's transaction. */
export function updateUpgrade(db: Db, id: string, change: (record: UpgradeRecord) => UpgradeRecord) {
  const history = upgradeHistory(db);
  const at = history.findIndex((r) => r.id === id);
  if (at < 0) return null;
  history[at] = change(history[at]);
  metaWrite(db, 'upgrade_history', JSON.stringify(history));
  return history[at];
}
