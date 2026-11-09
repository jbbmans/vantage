/**
 * Gathers what the case diagnoser reads (shared/caseDiagnosis.ts, ADR-0022) for one reader, and runs it.
 *
 * The engine is pure; this is where the reader's rights decide what it is given. Every case a reader opens gets a
 * diagnosis from what the reader may already see on the case: its sheet row, its events, its procedure. On top of that:
 * - guidance on file: the service's and the case's own Unit Instance's, with a validated example only when the reader may
 *   open that example's own case (caseGuidance.ts guidanceForCase);
 * - error reports that list the case: only for a case shared with its unit, and only to a reader who may read that unit's
 *   error reports (VIEW_RECORDS there, as errorReports.ts readerOf requires). Status, amount and age only: never a row's
 *   owner, which the error report pages show only to readers with member detail.
 *
 * Nothing here is stored. The diagnosis is derived on each read, so it always reflects the case, the guidance and the
 * reports as they stand, and an engine change reaches every case at once.
 */
import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, PERMISSIONS } from '../authz/scope.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { sameReport } from './intake.ts';
import { caseEventsOf, eventsFor, procedureOf, stageOf, type EventRow } from './cases.ts';
import type { WorkItemRow } from './work.ts';
import { guidanceForCase } from './caseGuidance.ts';
import {
  diagnoseCase, summarize, type CaseDiagnosis, type DiagnosisInput, type DiagnosisSummary, type ReportFact, type SheetField,
} from '../../shared/caseDiagnosis.ts';

const SHEET_FIELDS = new Set<string>(['commitment', 'obligation', 'delivered', 'paid', 'purchase_method', 'error_text']);

const json = <T>(text: string | null | undefined, fallback: T): T => {
  try { return text ? (JSON.parse(text) as T) : fallback; } catch { return fallback; }
};

/** The cells the import's column mapping gave a financial meaning. `mappings` caches a job's mapping across rows. */
function sheetOf(ctx: AppContext, row: WorkItemRow, mappings = new Map<string, Record<string, string>>()): NonNullable<DiagnosisInput['sheet']> {
  if (!row.import_job_id) return [];
  let mapping = mappings.get(row.import_job_id);
  if (!mapping) {
    const job = ctx.db.prepare('SELECT mapping FROM import_jobs WHERE id = ?').get(row.import_job_id) as { mapping: string } | undefined;
    mapping = json<Record<string, string>>(job?.mapping, {});
    mappings.set(row.import_job_id, mapping);
  }
  const data = json<Record<string, string>>(row.data, {});
  const out: NonNullable<DiagnosisInput['sheet']> = [];
  for (const [column, target] of Object.entries(mapping)) {
    if (SHEET_FIELDS.has(target) && Object.prototype.hasOwnProperty.call(data, column)) out.push({ field: target as SheetField, column, value: String(data[column] ?? '') });
  }
  return out;
}

/**
 * What the unit's error reports say about this case: per report type that ever listed it (keyed the same way and from the
 * same layout, as the error report drill-down links a case), the newest report that listed it and whether the latest report
 * still does.
 */
export function reportFactsFor(ctx: AppContext, scope: Scope, row: WorkItemRow): ReportFact[] {
  if (row.visibility !== 'unit' || !row.unit_id || !can(scope, PERMISSIONS.VIEW_RECORDS, row.unit_id)) return [];
  const hits = ctx.db.prepare(
    `SELECT s.id AS snapshot_id, s.type_id, s.as_of, r.source_row, r.status, r.closed, r.amount_cents, r.age_days, r.data
       FROM error_snapshot_rows r JOIN error_snapshots s ON s.id = r.snapshot_id
      WHERE s.unit_id = ? AND s.withdrawn_at IS NULL AND r.natural_key = ?
      ORDER BY s.as_of DESC, s.filed_at DESC`
  ).all(row.unit_id, row.natural_key) as Array<{ snapshot_id: string; type_id: string; as_of: string; source_row: number; status: string | null; closed: number; amount_cents: number | null; age_days: number | null; data: string }>;
  if (!hits.length) return [];
  const caseColumns = Object.keys(json<Record<string, string>>(row.data, {}));
  const newest = new Map<string, (typeof hits)[number]>();
  for (const h of hits) if (!newest.has(h.type_id) && sameReport(caseColumns, Object.keys(json<Record<string, string>>(h.data, {})))) newest.set(h.type_id, h);
  const out: ReportFact[] = [];
  for (const [typeId, h] of newest) {
    const latest = ctx.db.prepare(
      'SELECT id, as_of FROM error_snapshots WHERE unit_id = ? AND type_id = ? AND withdrawn_at IS NULL ORDER BY as_of DESC, filed_at DESC LIMIT 1'
    ).get(row.unit_id, typeId) as { id: string; as_of: string };
    const type = ctx.db.prepare('SELECT name FROM error_report_types WHERE id = ?').get(typeId) as { name: string } | undefined;
    out.push({
      report: type?.name || 'Error report', latest_as_of: latest.as_of, on_latest: latest.id === h.snapshot_id, listed_as_of: h.as_of,
      source_row: h.source_row, status: h.status, closed: Boolean(h.closed), amount_cents: h.amount_cents, age_days: h.age_days,
    });
  }
  return out.sort((a, b) => a.report.localeCompare(b.report));
}

function peopleOf(ctx: AppContext, events: EventRow[]): Record<string, string> {
  const ids = [...new Set(events.map((e) => e.actor_id).filter(Boolean) as string[])];
  if (!ids.length) return {};
  const rows = ctx.db.prepare(`SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as Array<{ id: string; name: string }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

function filenameOf(ctx: AppContext, row: WorkItemRow, files = new Map<string, string | null>()): string | null {
  if (!row.source_file_id) return null;
  if (!files.has(row.source_file_id)) {
    files.set(row.source_file_id, (ctx.db.prepare('SELECT filename FROM source_files WHERE id = ?').get(row.source_file_id) as { filename: string } | undefined)?.filename ?? null);
  }
  return files.get(row.source_file_id) ?? null;
}

function itemOf(row: WorkItemRow, filename: string | null): DiagnosisInput['item'] {
  return {
    title: row.title, reference: row.reference, due_date: row.due_date, created_at: row.created_at, stage: stageOf(row),
    filename, source_row: row.source_row, cells: Object.values(json<Record<string, string>>(row.data, {})).map(String),
  };
}

/** The whole diagnosis of one case, for a reader who may open it. `events` saves a second read when the caller has them. */
export function diagnosisFor(ctx: AppContext, user: SessionUser, scope: Scope, row: WorkItemRow, events?: EventRow[]): CaseDiagnosis {
  const rows = events ?? eventsFor(ctx, row.id);
  return diagnoseCase({
    item: itemOf(row, filenameOf(ctx, row)),
    sheet: sheetOf(ctx, row),
    events: caseEventsOf(rows),
    procedure: procedureOf(row).procedure,
    guidance: guidanceForCase(ctx, user, scope, row),
    reports: reportFactsFor(ctx, scope, row),
    people: peopleOf(ctx, rows),
    today: zonedDay(zoneOf(ctx, user)),
  });
}

/**
 * A one-line reading for each case of a list: the issue type, the headline, and how many unknowns and decisions are open.
 * Read from each case's own sheet row, events and procedure only, so it costs one query for the page's events, and it
 * says nothing a reader of the list could not already see on the case.
 */
export function summariesFor(ctx: AppContext, user: SessionUser, rows: WorkItemRow[]): Record<string, DiagnosisSummary> {
  if (!rows.length) return {};
  const all = ctx.db.prepare(
    'SELECT * FROM work_events WHERE work_item_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid'
  ).all(JSON.stringify(rows.map((r) => r.id))) as EventRow[];
  const byItem = new Map<string, EventRow[]>();
  for (const e of all) { const list = byItem.get(e.work_item_id); if (list) list.push(e); else byItem.set(e.work_item_id, [e]); }
  const mappings = new Map<string, Record<string, string>>();
  const files = new Map<string, string | null>();
  const today = zonedDay(zoneOf(ctx, user));
  const out: Record<string, DiagnosisSummary> = {};
  for (const row of rows) {
    const events = byItem.get(row.id) || [];
    out[row.id] = summarize(diagnoseCase({
      item: itemOf(row, filenameOf(ctx, row, files)),
      sheet: sheetOf(ctx, row, mappings),
      events: caseEventsOf(events),
      procedure: procedureOf(row).procedure,
      today,
    }));
  }
  return out;
}
