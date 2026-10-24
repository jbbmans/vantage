import { TIMEFRAMES, OPEN_END, OPEN_START, type TimeframedTable, type TimeframeSpec } from '../../shared/timeframe.ts';

/**
 * The SQL side of shared/timeframe.ts (ADR-0018): the first and last day a record covers, and the clause that picks the
 * records falling in a period. The same tests as coveredDays and inPeriod there, so a list, a report, an analysis and a
 * chart agree on what is in a period. The first day is the bare column where it can be, so an index on it still serves.
 */
export function coveredDaysSql(table: TimeframedTable, alias: string): { first: string; last: string; dated: string } {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  const start = `${alias}.${spec.start}`, end = `${alias}.${spec.end}`;
  if (spec.inPeriod === 'end') return { first: end, last: end, dated: `${end} IS NOT NULL` };
  if (spec.open) return { first: `COALESCE(${start}, '${OPEN_START}')`, last: `COALESCE(${end}, '${OPEN_END}')`, dated: `(${start} IS NOT NULL OR ${end} IS NOT NULL)` };
  const last = `COALESCE(${end}, ${start})`;
  return { first: start, last: spec.ongoing ? `CASE WHEN ${alias}.ongoing = 1 THEN '${OPEN_END}' ELSE ${last} END` : last, dated: `${start} IS NOT NULL` };
}

/**
 * Where a row of `table` (as `alias`) falls in the period from..to, both days included and either left open, with its
 * parameters. With neither, every row, dated or not.
 */
export function periodClause(table: TimeframedTable, alias: string, from?: string | null, to?: string | null): { sql: string; params: string[] } {
  const { first, last, dated } = coveredDaysSql(table, alias);
  const bounds: string[] = [];
  const params: string[] = [];
  if (to) { bounds.push(`${first} <= ?`); params.push(to); }
  if (from) { bounds.push(`${last} >= ?`); params.push(from); }
  return bounds.length ? { sql: `(${[dated, ...bounds].join(' AND ')})`, params } : { sql: '1 = 1', params };
}
