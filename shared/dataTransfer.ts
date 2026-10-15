/**
 * Everything Vantage writes out or takes in as a file, in two kinds that are never confused (ADR-0014):
 *
 * - **Infrastructure backups** are the whole service as it is stored: the database file and the service archive. They
 *   hold every Unit Instance, account, password hash, sealed secret, record and the audit trail. They are taken and put
 *   back by Lead Vantage Administrators only, and a database backup is restored on the host, with the service stopped.
 * - **Data exports and imports** are one person's, one unit's or one Unit Instance's data in a portable form, for its own
 *   use: a structure file, a roster, a configuration, a report, a spreadsheet to import. None of them is a backup, and
 *   none restores anything.
 *
 * tests/server/dataTransfer.test.ts holds this list to the routers: every bulk download and every import route is here.
 * The import routes refuse an infrastructure backup, and the service archive import refuses a data export, with a message
 * saying which is which.
 */

export type TransferKind = 'infrastructure' | 'data';

export interface DataTransfer {
  id: string;
  kind: TransferKind;
  label: string;
  format: string;
  holds: string;
  who: string;
  /** The routes that write it out or take it in, as METHOD /path. */
  routes: string[];
  /** Host commands that make or use it. */
  commands?: string[];
  /** How it comes back, or why it does not. */
  restores: string;
}

export const SERVICE_ARCHIVE_FORMAT = 'vantage-instance/1';
/** The formats of Vantage's data exports: one Unit Instance's, one unit's, one person's. */
export const DATA_EXPORT_FORMATS = ['vantage-organization/1', 'vantage-unit-configuration/1', 'vantage-personal/1'] as const;

export const DATA_TRANSFERS: readonly DataTransfer[] = [
  {
    id: 'database_backup', kind: 'infrastructure', label: 'Database backup', format: 'SQLite database file (.db)',
    holds: 'The whole service exactly as stored: every Unit Instance, account, password hash, sealed secret, record and the audit trail.',
    who: 'Lead Vantage Administrators (Backups and recovery); on the host, whoever runs the command.',
    routes: ['GET /api/platform/backup'], commands: ['npm run backup -- <file>', 'npm run restore'],
    restores: 'Only on the host, with the service stopped: npm run restore checks it, keeps the database it replaces, and is audited.',
  },
  {
    id: 'service_archive', kind: 'infrastructure', label: 'Service archive', format: `${SERVICE_ARCHIVE_FORMAT} JSON`,
    holds: 'The whole service as portable JSON, attachments and the audit trail included, for moving it to a new host under the same VANTAGE_SECRET.',
    who: 'Lead Vantage Administrators (Backups and recovery).',
    routes: ['GET /api/platform/export', 'POST /api/platform/import'],
    restores: 'Imported into a fresh service only, from the Vantage Administrator console; audited, and recorded as a restore.',
  },
  {
    id: 'organization_structure', kind: 'data', label: 'Unit Instance structure', format: 'vantage-organization/1 JSON',
    holds: 'Units, unit roles, members and who holds which role. No records.', who: 'Unit Managers (Export structure).',
    routes: ['GET /api/orgs/:orgId/export'], restores: 'Not imported: a copy for the command’s own files.',
  },
  {
    id: 'organization_roster', kind: 'data', label: 'Roster', format: 'CSV', holds: 'Who is in which unit, with rank and billet. No EDIPI, email address or records.',
    who: 'Unit Managers (Export structure).', routes: ['GET /api/orgs/:orgId/roster.csv'], restores: 'Not imported.',
  },
  {
    id: 'unit_configuration', kind: 'data', label: 'Unit configuration', format: 'vantage-unit-configuration/1 JSON',
    holds: 'Billets, duty types, training requirements and settings.', who: 'Unit Managers (Unit configuration; Export structure to download).',
    routes: ['GET /api/orgs/:orgId/configuration/export', 'POST /api/orgs/:orgId/configuration/import'],
    restores: 'Imported into a Unit Instance as configuration, planned first; it never replaces records.',
  },
  {
    id: 'organization_audit', kind: 'data', label: 'Unit Instance audit trail', format: 'CSV', holds: 'The Unit Instance’s audit entries in a period.',
    who: 'Unit Auditors and others with Audit trail.', routes: ['GET /api/orgs/:orgId/audit/export'], restores: 'Not imported: the trail itself stays in the service.',
  },
  {
    id: 'platform_audit', kind: 'data', label: 'Platform audit trail', format: 'CSV', holds: 'The platform’s own audit entries in a period.',
    who: 'Vantage Auditors and Lead Vantage Administrators (Platform audit trail).', routes: ['GET /api/platform/audit/export'], restores: 'Not imported.',
  },
  {
    id: 'accounts_import', kind: 'data', label: 'Account roster', format: 'Spreadsheet (.xlsx or .csv)', holds: 'Accounts to open, and the units they go in.',
    who: 'Unit Managers (Members).', routes: ['POST /api/orgs/:orgId/accounts/import'], restores: 'Opens accounts; planned first.',
  },
  {
    id: 'personnel_feed', kind: 'data', label: 'Personnel feed', format: 'Roster extract (CSV or JSON)', holds: 'Names, ranks, EAS dates and units from the personnel system.',
    who: 'Unit Managers (Personnel feed).', routes: ['POST /api/orgs/:orgId/personnel/sync'], restores: 'Keeps people current; planned first.',
  },
  {
    id: 'unit_work', kind: 'data', label: 'A unit’s shared work', format: 'CSV', holds: 'The work shared with a unit and the units beneath it. Never private entries.',
    who: 'Members whose unit role allows exporting.', routes: ['GET /api/org/units/:unitId/export'], restores: 'Not imported.',
  },
  {
    id: 'personal_export', kind: 'data', label: 'Personal export', format: 'vantage-personal/1 JSON, or a ZIP with attachments', holds: 'Everything one person keeps.',
    who: 'The person, for themselves.', routes: ['GET /api/me/export'], restores: 'Not imported.',
  },
  {
    id: 'reports', kind: 'data', label: 'Reports', format: 'CSV or PDF', holds: 'A report one can already read in Vantage.',
    who: 'The person, and leaders whose unit role allows it.', routes: ['GET /api/reports/csv', 'GET /api/reports/pdf', 'GET /api/reports/analysis.pdf'], restores: 'Not imported.',
  },
  {
    id: 'activities_import', kind: 'data', label: 'Activities', format: 'Rows from a spreadsheet', holds: 'One person’s activities.',
    who: 'The person, for their own record.', routes: ['POST /api/records/activities/import'], restores: 'Adds or updates entries.',
  },
  {
    id: 'work_intake', kind: 'data', label: 'Spreadsheet intake', format: 'Spreadsheet (.xlsx or .csv)', holds: 'Work to bring into a unit’s queue.',
    who: 'Members who can share work with the unit.', routes: ['POST /api/work/sources', 'POST /api/work/imports/preview', 'POST /api/work/imports'], restores: 'Adds or updates work, planned first.',
  },
  {
    id: 'email_import', kind: 'data', label: 'Saved email', format: '.eml message', holds: 'One message and its attachments, filed with a unit’s correspondence.',
    who: 'Members who can share correspondence with the unit.', routes: ['POST /api/correspondence/messages/import'], restores: 'Files the message.',
  },
];

/** The first bytes of every SQLite database file. */
const SQLITE_HEADER = 'SQLite format 3\u0000';
const ARCHIVE_MARK = /"format"\s*:\s*"vantage-instance\/1"/;

const BACKUP_REFUSED = 'That is a Vantage database backup, not a file to import. A backup is the whole service and is only ever restored on the host by Vantage staff (npm run restore).';
const ARCHIVE_REFUSED = 'That is the Vantage service archive, every Unit Instance at once, not a file to import here. Only Lead Vantage Administrators load it, into a fresh service.';

/**
 * Why this file cannot go into a data import, if it is an infrastructure backup: a database file or the service archive.
 * Uploading either into a unit would put every Unit Instance's data into one, so neither gets as far as being read.
 */
export function infrastructureFileProblem(content: Uint8Array | string | null | undefined): string | null {
  if (!content || !content.length) return null;
  const head = typeof content === 'string' ? content.slice(0, 512) : new TextDecoder('latin1').decode(content.subarray(0, 512));
  if (head.startsWith(SQLITE_HEADER)) return BACKUP_REFUSED;
  if (ARCHIVE_MARK.test(head)) return ARCHIVE_REFUSED;
  return null;
}

/** The same, for an import whose body is already parsed JSON. */
export function infrastructureBodyProblem(body: unknown): string | null {
  const format = body && typeof body === 'object' ? (body as { format?: unknown }).format : undefined;
  return format === SERVICE_ARCHIVE_FORMAT ? ARCHIVE_REFUSED : null;
}

/** Why a file given to the service archive import is not one, when it is one of the data exports. */
export function dataExportProblem(body: unknown): string | null {
  const format = body && typeof body === 'object' ? (body as { format?: unknown }).format : undefined;
  if (typeof format !== 'string' || !(DATA_EXPORT_FORMATS as readonly string[]).includes(format)) return null;
  const what = DATA_TRANSFERS.find((t) => t.format.startsWith(format))?.label ?? 'a data export';
  return `That is a data export (${what}, ${format}), not a backup: it holds one Unit Instance’s, unit’s or person’s data and cannot restore the service. Restore from a database backup on the host, or a service archive.`;
}
