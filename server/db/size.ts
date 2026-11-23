import type Database from 'better-sqlite3';

/**
 * The size of a database, one measure for every place that compares, shows or plans around it (ADR-0042).
 *
 * `bytes` is every page of the database as it now stands: page_count times page_size, read from the newest committed
 * state, so what is still in the write-ahead log counts and nothing in it counts twice. Free pages count too: they take
 * room in the file until compacting gives it back, and compacting is what lowers this number. The file on disk can
 * differ in both directions (it lags the log, and the log keeps its high-water size), so no comparison reads the file.
 * `usedBytes` leaves out the free pages: what a compacted copy needs. Works the same for a database in
 * memory and for a read-only connection, and costs three reads of the header.
 */
export interface DatabaseSize { bytes: number; usedBytes: number; freeBytes: number; pageSize: number }

export function databaseSize(db: Pick<Database.Database, 'pragma'>): DatabaseSize {
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pages = Number(db.pragma('page_count', { simple: true }));
  const free = Number(db.pragma('freelist_count', { simple: true }));
  return { bytes: pages * pageSize, usedBytes: (pages - free) * pageSize, freeBytes: free * pageSize, pageSize };
}

/** What the database may still take before it reaches its safety threshold, by the measure above; never below 0. */
export function databaseRoom(db: Pick<Database.Database, 'pragma'>, maxBytes: number): number {
  return Math.max(0, maxBytes - databaseSize(db).bytes);
}
