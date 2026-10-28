import type { AppContext } from '../context.ts';
import { RECORD_TABLE_NAMES, hydrate, withGoalProgress } from './records.ts';
import type { RecordTable } from '../../shared/schemas.ts';
import { listPasskeys } from '../auth/passkeys.ts';
import { listPermissions } from '../../shared/permissions.ts';
import { rowsToCsv } from '../../shared/csv.ts';
import { PERSONAL_FORMAT, RECORD_FORMAT, PROFILE_COLUMNS, READINESS_COLUMNS, TABLE_LABELS, categoryOf, inCategory, selectSections, sheetHeaders, sheetRow, type ImportTable, type SectionSelection } from '../../shared/recordTransfer.ts';
import { writeWorkbook, type SheetOut } from '../lib/workbook.ts';
import { badRequest } from '../lib/errors.ts';
import { VERSION } from '../version.ts';
import { now } from '../lib/ids.ts';
import { buildZip, type ZipEntry } from '../lib/zip.ts';
import { membershipHistory } from './membership.ts';

type Row = Record<string, unknown>;

/** A person as their own export names them: "Cpl Diaz, Ana". */
function personLabel(ctx: AppContext, id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null;
  const u = ctx.db.prepare('SELECT u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?').get(id) as { first_name: string; last_name: string; abbr: string | null } | undefined;
  return u ? `${u.abbr ? `${u.abbr} ` : ''}${u.last_name}, ${u.first_name}` : null;
}

/**
 * Where an attachment sits in the ZIP: attachments/<record type>-<first 8 of its id>-<its name>. The import finds each
 * file by this path, written beside the attachment in vantage-export.json as `file`.
 */
export const attachmentPath = (a: Record<string, unknown>) =>
  `attachments/${safeName(String(a.record_table))}-${String(a.id).slice(0, 8)}-${safeName(String(a.original_name))}`;

/**
 * Everything one person keeps, as vantage-personal/1 (ADR-0019). `sections` chooses categories of it (shared/recordTransfer.ts):
 * none is all of it. `attachments` loads the files' bytes into `_files` for a ZIP.
 */
export function buildPersonalExport(ctx: AppContext, userId: string, { attachments = true, sections = null as readonly string[] | null } = {}) {
  const selection = selectSections(sections);
  const db = ctx.db;
  const user = db.prepare('SELECT id, username, email, first_name, last_name, middle_initial, rank_id, mos, eas, is_operator, active, totp_enabled, prefs, digest_last_sent_at, last_login_at, created_at, updated_at FROM users WHERE id = ?').get(userId) as Row | undefined;
  if (!user) throw new Error('No such user.');
  const rank = user.rank_id ? (db.prepare('SELECT id, grade, abbr, name FROM ranks WHERE id = ?').get(String(user.rank_id)) as Row | undefined) : null;
  let prefs: unknown = {};
  try { prefs = JSON.parse(String(user.prefs || '{}')); } catch { /* keep the raw string below */ }

  const memberships = db.prepare(`SELECT m.unit_id, m.is_primary, m.billet, m.billet_id, m.assignment_start, m.assignment_end, m.joined_at, u.code AS unit_code, u.name AS unit_name, u.short_name AS unit_short, u.echelon, u.location, u.parent_id, p.name AS parent_name
    FROM unit_members m JOIN units u ON u.id = m.unit_id LEFT JOIN units p ON p.id = u.parent_id WHERE m.user_id = ? ORDER BY m.is_primary DESC, m.joined_at`).all(userId) as Row[];
  // Every unit they have served in and when, across every Unit Instance: it is their own history (ADR-0009).
  const membershipPeriods = membershipHistory(ctx, userId, null, 10_000);
  const roles = (db.prepare(`SELECT mr.unit_id, mr.created_at AS granted_at, r.id AS role_id, r.key, r.name, r.description, r.color, r.position, r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? ORDER BY mr.unit_id, r.position DESC`).all(userId) as Row[])
    .map((r) => ({ ...r, permission_names: listPermissions(Number(r.permissions)) }));
  const units = db.prepare(`SELECT id, code, name, short_name, echelon, location, parent_id, owner_user_id = ? AS owned_by_me, created_at FROM units WHERE id IN (SELECT unit_id FROM unit_members WHERE user_id = ?) OR owner_user_id = ? ORDER BY name`).all(userId, userId, userId) as Row[];
  const readiness = db.prepare('SELECT * FROM readiness WHERE user_id = ?').get(userId) as Row | undefined;
  // Their personnel record in each Unit Instance, the responsibilities they hold or held, and its history (ADR-0017).
  const personnelRecords = db.prepare(`SELECT pr.org_id, o.name AS organization, s.username AS supervisor, pr.checked_in_on, pr.updated_at
    FROM personnel_records pr LEFT JOIN organizations o ON o.id = pr.org_id LEFT JOIN users s ON s.id = pr.supervisor_id WHERE pr.user_id = ? ORDER BY pr.org_id`).all(userId) as Row[];
  const responsibilities = db.prepare(`SELECT r.id, r.org_id, r.unit_id, r.title, r.starts_on, r.ends_on, a.username AS assigned_by, r.created_at, r.ended_at, e.username AS ended_by, r.end_reason
    FROM personnel_responsibilities r LEFT JOIN users a ON a.id = r.assigned_by LEFT JOIN users e ON e.id = r.ended_by WHERE r.user_id = ? ORDER BY r.created_at`).all(userId) as Row[];
  const personnelHistory = db.prepare(`SELECT ev.at, ev.org_id, ev.unit_id, ev.field, ev.from_value, ev.to_value, ev.source, ev.reason, CASE WHEN ev.actor_id = ? THEN 'me' ELSE a.username END AS actor, ev.batch_id
    FROM personnel_events ev LEFT JOIN users a ON a.id = ev.actor_id WHERE ev.user_id = ? ORDER BY ev.at, ev.id`).all(userId, userId) as Row[];

  const records: Record<string, Row[]> = {};
  for (const table of RECORD_TABLE_NAMES) {
    const where = table === 'counselings' ? '(user_id = ? OR counselor_id = ?)' : table === 'tasks' || table === 'goals' ? '(user_id = ? OR assignee_id = ?)' : 'user_id = ?';
    const params = where.includes('OR') ? [userId, userId] : [userId];
    let rows = (db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY created_at DESC`).all(...params) as Row[]).map((r) => hydrate(r, table as RecordTable)!);
    if (table === 'goals') rows = withGoalProgress(ctx, rows as never) as Row[];
    records[table] = rows;
  }
  // Who wrote what someone else wrote about the Marine: a counseling's counselor, an award's recorder. The ids are this
  // instance's, so the export names them too; an import keeps the name, never the id (ADR-0019).
  for (const r of records.counselings ?? []) if (r.counselor_id && r.counselor_id !== userId) r.counselor_label = personLabel(ctx, r.counselor_id);
  for (const r of records.awards ?? []) if (r.recorded_by && r.recorded_by !== userId) r.recorder_label = personLabel(ctx, r.recorded_by);
  for (const r of records.counselings ?? []) if (r.user_id !== userId) r.subject_label = personLabel(ctx, r.user_id);
  const recordIds = new Map<string, Set<string>>();
  for (const [table, rows] of Object.entries(records)) recordIds.set(table, new Set(rows.map((r) => String(r.id))));

  // What hangs off the Marine's own records: one indexed lookup per record type, however many records there are.
  const onOwnRecords = (columns: string, from: 'attachments' | 'comments') => [...recordIds].flatMap(([table, ids]) => (ids.size
    ? db.prepare(`SELECT ${columns} FROM ${from} WHERE record_table = ? AND record_id IN (SELECT value FROM json_each(?))`).all(table, JSON.stringify([...ids])) as Row[]
    : []));
  const attachmentColumns = 'id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, created_at, deleted_at';
  const byOwnRecord = onOwnRecords(attachmentColumns, 'attachments');
  const byUpload = db.prepare(`SELECT ${attachmentColumns} FROM attachments WHERE uploaded_by = ?`).all(userId) as Row[];
  const seenAttachments = new Set<string>();
  const attachmentRows = [...byOwnRecord, ...byUpload]
    .filter((a) => { const id = String(a.id); if (seenAttachments.has(id)) return false; seenAttachments.add(id); return true; })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const a of attachmentRows) a.file = attachmentPath(a);

  const notifications = db.prepare('SELECT id, kind, title, message, action_url, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Row[];

  const commentColumns = 'id, record_table, record_id, author_id, body, mentions, edited_at, created_at, deleted_at';
  const ownComments = db.prepare(`SELECT ${commentColumns} FROM comments WHERE author_id = ?`).all(userId) as Row[];
  const seenComments = new Set<string>();
  const commentRows = [...ownComments, ...onOwnRecords(commentColumns, 'comments')]
    .filter((c) => { const id = String(c.id); if (seenComments.has(id)) return false; seenComments.add(id); return true; })
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const auditTrail = db.prepare(`SELECT al.id, al.at, al.action, al.entity, al.entity_id, al.unit_id, al.detail, al.ip, CASE WHEN al.actor_id = ? THEN 'me' ELSE COALESCE(u.username, al.actor_id) END AS actor, CASE WHEN al.subject_id = ? THEN 'me' ELSE COALESCE(s.username, al.subject_id) END AS subject
    FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id WHERE al.actor_id = ? OR al.subject_id = ? ORDER BY al.seq DESC LIMIT 20000`).all(userId, userId, userId, userId) as Row[];
  const aiUsage = db.prepare('SELECT day, workflow, model, requests, prompt_tokens, completion_tokens, total_tokens, failures FROM ai_usage_daily WHERE user_id = ? ORDER BY day DESC').all(userId) as Row[];
  const emails = db.prepare('SELECT id, to_address, kind, subject, status, error, created_at FROM email_log WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Row[];
  const maradminState = db.prepare('SELECT s.*, m.number, m.title FROM maradmin_user_state s LEFT JOIN maradmins m ON m.id = s.maradmin_id WHERE s.user_id = ?').all(userId) as Row[];
  const passkeys = listPasskeys(ctx, userId);
  const sessions = db.prepare('SELECT created_at, last_used_at, method, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC').all(userId) as Row[];

  const contributions = db.prepare('SELECT id, work_item_id, unit_id, kind, step, subject_id, body, supersedes_id, occurred_at, created_at FROM work_events WHERE actor_id = ? ORDER BY created_at').all(userId) as Row[];
  const drafts = db.prepare('SELECT * FROM record_drafts WHERE user_id = ? ORDER BY created_at').all(userId) as Row[];
  const careerSteps = db.prepare('SELECT * FROM career_steps WHERE user_id = ? ORDER BY created_at').all(userId) as Row[];
  const careerProfile = db.prepare('SELECT * FROM career_profiles WHERE user_id = ?').get(userId) as Row | undefined;
  // Their entries' moves between record types, with what each said before (ADR-0015).
  const lineage = db.prepare('SELECT * FROM record_lineage WHERE user_id = ? ORDER BY at').all(userId) as Row[];

  const counts = Object.fromEntries(Object.entries(records).map(([t, rows]) => [t, rows.length]));
  const full = {
    format: PERSONAL_FORMAT, version: VERSION, exported_at: now(), instance: { display_name: ctx.runtime.displayName, organization: ctx.runtime.organizationName, metrics: ctx.runtime.metrics },
    profile: { ...user, prefs, rank } as Row & { username: string; rank: Row | null | undefined; prefs: unknown },
    readiness: readiness || null,
    units, memberships, membership_history: membershipPeriods, roles,
    personnel: { records: personnelRecords, responsibilities, history: personnelHistory },
    records,
    attachments: attachmentRows,
    notifications, comments: commentRows, audit_trail: auditTrail, ai_usage: aiUsage, email_log: emails, maradmin_state: maradminState,
    contributions, drafts, career: { profile: careerProfile || null, steps: careerSteps }, record_moves: lineage,
    security: { passkeys, sessions, authenticator_enabled: Boolean(user.totp_enabled) },
    counts: { ...counts, attachments: attachmentRows.length, notifications: notifications.length, comments: commentRows.length, audit_trail: auditTrail.length, contributions: contributions.length, drafts: drafts.length, career_steps: careerSteps.length, record_moves: lineage.length, responsibilities: responsibilities.length, personnel_history: personnelHistory.length },
  };
  const archive = selection.all ? full : narrowExport(full, selection);
  const _files: Array<Row & { content: Buffer }> = attachments
    ? (archive.attachments as Row[]).filter((a) => !a.deleted_at).map((a) => ({ ...a, content: (db.prepare('SELECT content FROM attachments WHERE id = ?').get(String(a.id)) as { content: Buffer }).content }))
    : [];
  return { ...archive, _files };
}

/**
 * The export cut down to the categories chosen: each record type's rows in them, the attachments on those rows, and the
 * other datasets only when chosen. It says what it holds in `sections`, so an import knows what a missing dataset means.
 */
function narrowExport<T extends Record<string, unknown> & { records: Record<string, Row[]>; attachments: Row[]; career: { profile: Row | null; steps: Row[] }; profile: Row }>(full: T, sel: SectionSelection): T {
  const records: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries(full.records)) {
    const chosen = sel.tables.get(table as ImportTable);
    if (!chosen) continue;
    records[table] = chosen === 'all' ? rows : rows.filter((r) => chosen.some((c) => inCategory(c, r)));
  }
  const kept = new Set(Object.entries(records).flatMap(([t, rows]) => rows.map((r) => `${t}:${String(r.id)}`)));
  const attachments = sel.attachments ? full.attachments.filter((a) => kept.has(`${String(a.record_table)}:${String(a.record_id)}`)) : [];
  const career = sel.tables.has('career_steps') ? full.career : null;
  const account = sel.account;
  const out: Record<string, unknown> = {
    format: full.format, version: full.version, exported_at: full.exported_at, instance: full.instance, sections: sel.keys,
    owner: { id: full.profile.id, username: full.profile.username, first_name: full.profile.first_name, last_name: full.profile.last_name },
    ...(sel.profile ? { profile: full.profile, readiness: full.readiness } : {}),
    ...(account ? { units: full.units, memberships: full.memberships, membership_history: full.membership_history, roles: full.roles, notifications: full.notifications, comments: full.comments, audit_trail: full.audit_trail, ai_usage: full.ai_usage, email_log: full.email_log, maradmin_state: full.maradmin_state, contributions: full.contributions, drafts: full.drafts, record_moves: full.record_moves, security: full.security } : {}),
    ...(sel.personnel ? { personnel: full.personnel } : {}),
    ...(career ? { career } : {}),
    records, attachments,
  };
  out.counts = { ...Object.fromEntries(Object.entries(records).map(([t, rows]) => [t, rows.length])), attachments: attachments.length, ...(career ? { career_steps: career.steps.length } : {}) };
  return out as T;
}

const flat = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v != null && typeof v === 'object' ? JSON.stringify(v) : v]));
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file';

type Archive = Omit<ReturnType<typeof buildPersonalExport>, '_files'>;

/** The profile and readiness as one spreadsheet row, under the columns an import reads (shared/recordTransfer.ts). */
function profileRow(archive: Archive): Row {
  const profile = archive.profile as Row & { rank?: Row | null };
  const readiness = (archive.readiness || {}) as Row;
  const row: Row = {};
  for (const c of PROFILE_COLUMNS) row[c.header] = c.key === 'rank_id' ? (profile.rank as Row | null)?.abbr ?? profile.rank_id ?? '' : profile[c.key] ?? '';
  for (const c of READINESS_COLUMNS) row[c.header] = readiness[c.key] ?? '';
  return { ...row, Username: profile.username, Email: profile.email ?? '' };
}

const CSV_NAMES: Record<string, string> = { career_steps: 'career-steps' };

/**
 * The export as a ZIP: README, vantage-export.json, a CSV per dataset, and the files. Each record type's CSV uses the
 * columns an import reads, so the CSVs come back as well as the JSON does.
 */
export function buildPersonalExportZip(ctx: AppContext, userId: string, { sections = null as readonly string[] | null } = {}): { buffer: Buffer; filename: string; counts: Record<string, number> } {
  const data = buildPersonalExport(ctx, userId, { sections });
  const { _files, ...archive } = data;
  const stamp = archive.exported_at.slice(0, 10);
  const owner = String((archive.profile as Row | undefined)?.username ?? (archive as unknown as { owner: Row }).owner?.username ?? 'export');
  const entries: ZipEntry[] = [];
  const readme = [
    `Vantage personal export for ${owner} (${stamp})`, '',
    'vantage-export.json holds everything in one structured file. The CSVs are the same data one dataset per file, for spreadsheets.',
    'Import records (Settings, Your data) reads this ZIP back: awards stay awards, training stays training, files stay on their records.',
    'attachments/ holds the files you uploaded, named <record>-<attachment id>-<original name>.', '',
    'Records include entries in the recycle bin (deleted_at is set). Nothing here is a system of record; MOL is.',
    ...('sections' in archive ? ['', `Holds only: ${(archive as unknown as { sections: string[] }).sections.map((k) => categoryOf(k)?.label ?? k).join(', ')}.`] : []),
    '', 'Datasets:', ...Object.entries(archive.counts).map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n');
  entries.push({ name: 'README.txt', data: readme });
  entries.push({ name: 'vantage-export.json', data: JSON.stringify(archive, null, 2) });
  if (archive.profile) entries.push({ name: 'profile.csv', data: `\uFEFF${rowsToCsv([profileRow(archive)])}` });
  if (archive.readiness) entries.push({ name: 'readiness.csv', data: rowsToCsv([flat(archive.readiness)]) });
  if (archive.units) {
    entries.push({ name: 'units.csv', data: rowsToCsv(archive.units.map(flat)) });
    entries.push({ name: 'memberships.csv', data: rowsToCsv(archive.memberships.map(flat)) });
    entries.push({ name: 'membership-history.csv', data: rowsToCsv(archive.membership_history.map((p) => flat({ ...p }))) });
    entries.push({ name: 'roles.csv', data: rowsToCsv(archive.roles.map(flat)) });
  }
  if (archive.personnel) {
    entries.push({ name: 'personnel-records.csv', data: rowsToCsv(archive.personnel.records.map(flat)) });
    entries.push({ name: 'responsibilities.csv', data: rowsToCsv(archive.personnel.responsibilities.map(flat)) });
    entries.push({ name: 'personnel-history.csv', data: rowsToCsv(archive.personnel.history.map(flat)) });
  }
  for (const [table, rows] of Object.entries(archive.records)) {
    // The import's own columns; a bare "Unit" is an import alias for the action unit, so the unit is "Unit ID".
    entries.push({ name: `${table}.csv`, data: `\uFEFF${rowsToCsv(rows.map((r) => ({ ...sheetRow(table as ImportTable, r), ...extraColumns(table, r) })), [...sheetHeaders(table as ImportTable), ...extraHeaders(table)])}` });
  }
  if (archive.career) entries.push({ name: 'career-steps.csv', data: `\uFEFF${rowsToCsv(archive.career.steps.map((r) => sheetRow('career_steps', r)), sheetHeaders('career_steps'))}` });
  entries.push({ name: 'attachments.csv', data: rowsToCsv(archive.attachments.map(flat)) });
  if (archive.notifications) {
    entries.push({ name: 'notifications.csv', data: rowsToCsv(archive.notifications.map(flat)) });
    entries.push({ name: 'comments.csv', data: rowsToCsv(archive.comments.map(flat)) });
    entries.push({ name: 'audit-trail.csv', data: rowsToCsv(archive.audit_trail.map(flat)) });
    entries.push({ name: 'ai-usage.csv', data: rowsToCsv(archive.ai_usage.map(flat)) });
    entries.push({ name: 'email-log.csv', data: rowsToCsv(archive.email_log.map(flat)) });
    entries.push({ name: 'contributions.csv', data: rowsToCsv(archive.contributions.map(flat)) });
    entries.push({ name: 'drafts.csv', data: rowsToCsv(archive.drafts.map(flat)) });
    entries.push({ name: 'record-moves.csv', data: rowsToCsv(archive.record_moves.map(flat)) });
  }
  for (const f of _files) entries.push({ name: attachmentPath(f), data: f.content as Buffer, modified: new Date(String(f.created_at)) });
  return { buffer: buildZip(entries), filename: `vantage-${safeName(owner)}-${stamp}${'sections' in archive ? '-selected' : ''}.zip`, counts: archive.counts };
}

/** What a record type's spreadsheet carries beyond the import's columns: who else wrote it, and whom it is about. */
const extraHeaders = (table: string) => (table === 'counselings' ? ['Recorded By', 'About'] : table === 'awards' ? ['Recorded By'] : []);
const extraColumns = (table: string, r: Row): Row => (table === 'counselings' ? { 'Recorded By': r.counselor_label ?? '', About: r.subject_label ?? '' } : table === 'awards' ? { 'Recorded By': r.recorder_label ?? '' } : {});

/** The export as one workbook: a sheet per record type under the import's columns, the profile, and an About sheet. */
export function buildPersonalExportWorkbook(ctx: AppContext, userId: string, { sections = null as readonly string[] | null } = {}): { buffer: Buffer; filename: string; counts: Record<string, number> } {
  const { _files, ...archive } = buildPersonalExport(ctx, userId, { sections, attachments: false });
  void _files;
  const stamp = archive.exported_at.slice(0, 10);
  const owner = String((archive.profile as Row | undefined)?.username ?? (archive as unknown as { owner: Row }).owner?.username ?? 'export');
  const sheets: SheetOut[] = [];
  const grid = (headers: string[], rows: Row[]): SheetOut['rows'] => [headers, ...rows.map((r) => headers.map((h) => cellValue(r[h])))];
  if (archive.profile) { const row = profileRow(archive); sheets.push({ name: 'Profile', rows: grid(Object.keys(row), [row]) }); }
  for (const [table, rows] of Object.entries(archive.records)) {
    const t = table as ImportTable;
    sheets.push({ name: TABLE_LABELS[t].many, rows: grid([...sheetHeaders(t), ...extraHeaders(t)], rows.map((r) => ({ ...sheetRow(t, r), ...extraColumns(t, r) }))) });
  }
  if (archive.career) sheets.push({ name: TABLE_LABELS.career_steps.many, rows: grid(sheetHeaders('career_steps'), archive.career.steps.map((r) => sheetRow('career_steps', r))) });
  if (archive.personnel) sheets.push({ name: 'Personnel history', rows: grid(['at', 'org_id', 'unit_id', 'field', 'from_value', 'to_value', 'source', 'reason', 'actor'], archive.personnel.history as Row[]) });
  sheets.push({ name: 'About', rows: [
    ['Vantage personal export'], ['Exported', archive.exported_at], ['For', owner], ['Format', `${PERSONAL_FORMAT} as a workbook`],
    ['Holds', ('sections' in archive ? (archive as unknown as { sections: string[] }).sections : ['everything']).map((k) => categoryOf(k)?.label ?? k).join(', ')],
    ['Files', 'Attachments are not in a workbook. Export a ZIP to keep them.'],
    ['Import', 'Import records (Settings, Your data) reads this workbook back: each sheet goes into its own record type.'],
  ] });
  return { buffer: writeWorkbook(sheets), filename: `vantage-${safeName(owner)}-${stamp}.xlsx`, counts: archive.counts };
}

const cellValue = (v: unknown): string | number | null => (v == null ? null : typeof v === 'number' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** One category as a CSV, under the import's columns: one record type, or the profile. */
export function buildPersonalExportCsv(ctx: AppContext, userId: string, key: string): { text: string; filename: string; counts: Record<string, number> } {
  const category = categoryOf(key);
  if (!category || (!category.table && key !== 'profile')) throw badRequest('A CSV holds one record type. Choose one category, or download a ZIP or a workbook.', { code: 'csv_one_category' });
  const { _files, ...archive } = buildPersonalExport(ctx, userId, { sections: [key], attachments: false });
  void _files;
  const stamp = archive.exported_at.slice(0, 10);
  const owner = String((archive as unknown as { owner: Row }).owner?.username ?? 'export');
  if (key === 'profile') return { text: `\uFEFF${rowsToCsv([profileRow(archive)])}`, filename: `vantage-${safeName(owner)}-profile-${stamp}.csv`, counts: { profile: 1 } };
  const t = category.table!;
  const rows = t === 'career_steps' ? archive.career?.steps ?? [] : archive.records[t] ?? [];
  return {
    text: `\uFEFF${rowsToCsv(rows.map((r) => ({ ...sheetRow(t, r), ...extraColumns(t, r) })), [...sheetHeaders(t), ...extraHeaders(t)])}`,
    filename: `vantage-${safeName(owner)}-${CSV_NAMES[key] ?? key}-${stamp}.csv`, counts: { [key]: rows.length },
  };
}

/**
 * One record and the files on it, as its page downloads it (ADR-0019): vantage-record/1 JSON, a CSV row under the import's
 * columns, or a ZIP of both with the files. The caller has already decided the reader may open the record.
 */
export function buildRecordExport(ctx: AppContext, table: ImportTable, row: Row, format: 'json' | 'csv' | 'zip', { files = true } = {}): { body: Buffer | string; filename: string; contentType: string; attachments: number } {
  const meta = ctx.db.prepare('SELECT id, record_table, record_id, original_name, mime_type, size_bytes, sha256, created_at FROM attachments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL ORDER BY created_at').all(table, String(row.id)) as Row[];
  for (const a of meta) a.file = attachmentPath(a);
  const record: Row = { ...row };
  if (table === 'counselings' && row.counselor_id && row.counselor_id !== row.user_id) record.counselor_label = personLabel(ctx, row.counselor_id);
  if (table === 'awards' && row.recorded_by && row.recorded_by !== row.user_id) record.recorder_label = personLabel(ctx, row.recorded_by);
  const doc = { format: RECORD_FORMAT, version: VERSION, exported_at: now(), table, record, attachments: meta };
  const stem = `vantage-${TABLE_LABELS[table].one.replace(/\s+/g, '-')}-${String(row.id).slice(0, 8)}`;
  const csv = `\uFEFF${rowsToCsv([{ ...sheetRow(table, record), ...extraColumns(table, record) }], [...sheetHeaders(table), ...extraHeaders(table)])}`;
  if (format === 'json') return { body: JSON.stringify(doc, null, 2), filename: `${stem}.json`, contentType: 'application/json; charset=utf-8', attachments: 0 };
  if (format === 'csv') return { body: csv, filename: `${stem}.csv`, contentType: 'text/csv; charset=utf-8', attachments: 0 };
  const entries: ZipEntry[] = [{ name: 'record.json', data: JSON.stringify(doc, null, 2) }, { name: 'record.csv', data: csv }];
  if (files) for (const a of meta) entries.push({ name: String(a.file), data: (ctx.db.prepare('SELECT content FROM attachments WHERE id = ?').get(String(a.id)) as { content: Buffer }).content, modified: new Date(String(a.created_at)) });
  return { body: buildZip(entries), filename: `${stem}.zip`, contentType: 'application/zip', attachments: files ? meta.length : 0 };
}
