/**
 * Everything a Marine has put into Vantage, in one archive they can keep: profile, rank, units and roles, every record
 * (including what sits in the recycle bin), readiness figures, attachments, notifications, preferences, the audit trail
 * of what happened to their record, and their AI usage. Secrets never leave: no password hash, authenticator secret,
 * passkey credential, session, or token.
 */
import type { AppContext } from '../context.ts';
import { RECORD_TABLE_NAMES, hydrate, withGoalProgress } from './records.ts';
import type { RecordTable } from '../../shared/schemas.ts';
import { listPasskeys } from '../auth/passkeys.ts';
import { listPermissions } from '../../shared/permissions.ts';
import { rowsToCsv, activityToCsvRow, ACTIVITY_CSV_COLUMNS } from '../../shared/csv.ts';
import { VERSION } from '../version.ts';
import { now } from '../lib/ids.ts';
import { buildZip, type ZipEntry } from '../lib/zip.ts';

type Row = Record<string, unknown>;

export function buildPersonalExport(ctx: AppContext, userId: string, { attachments = true } = {}) {
  const db = ctx.db;
  const user = db.prepare('SELECT id, username, email, first_name, last_name, middle_initial, rank_id, mos, eas, is_operator, active, totp_enabled, prefs, digest_last_sent_at, last_login_at, created_at, updated_at FROM users WHERE id = ?').get(userId) as Row | undefined;
  if (!user) throw new Error('No such user.');
  const rank = user.rank_id ? (db.prepare('SELECT id, grade, abbr, name FROM ranks WHERE id = ?').get(String(user.rank_id)) as Row | undefined) : null;
  let prefs: unknown = {};
  try { prefs = JSON.parse(String(user.prefs || '{}')); } catch { /* keep the raw string below */ }

  const memberships = db.prepare(`SELECT m.unit_id, m.is_primary, m.billet, m.joined_at, u.code AS unit_code, u.name AS unit_name, u.short_name AS unit_short, u.echelon, u.location, u.parent_id, p.name AS parent_name
    FROM unit_members m JOIN units u ON u.id = m.unit_id LEFT JOIN units p ON p.id = u.parent_id WHERE m.user_id = ? ORDER BY m.is_primary DESC, m.joined_at`).all(userId) as Row[];
  const roles = (db.prepare(`SELECT mr.unit_id, mr.created_at AS granted_at, r.id AS role_id, r.key, r.name, r.description, r.color, r.position, r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? ORDER BY mr.unit_id, r.position DESC`).all(userId) as Row[])
    .map((r) => ({ ...r, permission_names: listPermissions(Number(r.permissions)) }));
  const units = db.prepare(`SELECT id, code, name, short_name, echelon, location, parent_id, owner_user_id = ? AS owned_by_me, created_at FROM units WHERE id IN (SELECT unit_id FROM unit_members WHERE user_id = ?) OR owner_user_id = ? ORDER BY name`).all(userId, userId, userId) as Row[];
  const readiness = db.prepare('SELECT * FROM readiness WHERE user_id = ?').get(userId) as Row | undefined;

  const records: Record<string, Row[]> = {};
  for (const table of RECORD_TABLE_NAMES) {
    const where = table === 'counselings' ? '(user_id = ? OR counselor_id = ?)' : table === 'tasks' || table === 'goals' ? '(user_id = ? OR assignee_id = ?)' : 'user_id = ?';
    const params = where.includes('OR') ? [userId, userId] : [userId];
    let rows = (db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY created_at DESC`).all(...params) as Row[]).map((r) => hydrate(r, table as RecordTable)!);
    if (table === 'goals') rows = withGoalProgress(ctx, rows as never) as Row[];
    records[table] = rows;
  }
  const recordIds = new Map<string, Set<string>>();
  for (const [table, rows] of Object.entries(records)) recordIds.set(table, new Set(rows.map((r) => String(r.id))));

  const attachmentRows = (db.prepare('SELECT id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, created_at, deleted_at FROM attachments WHERE uploaded_by = ? OR (record_table = ? AND record_id IN (SELECT id FROM activities WHERE user_id = ?)) ORDER BY created_at').all(userId, 'activities', userId) as Row[])
    .filter((a) => recordIds.get(String(a.record_table))?.has(String(a.record_id)) || a.uploaded_by === userId);
  const attachmentFiles: Array<Row & { content: Buffer }> = attachments ? attachmentRows.map((a) => ({ ...a, content: (db.prepare('SELECT content FROM attachments WHERE id = ?').get(String(a.id)) as { content: Buffer }).content })) : [];

  const notifications = db.prepare('SELECT id, kind, title, message, action_url, read_at, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Row[];
  const auditTrail = db.prepare(`SELECT al.id, al.at, al.action, al.entity, al.entity_id, al.unit_id, al.detail, al.ip, CASE WHEN al.actor_id = ? THEN 'me' ELSE COALESCE(u.username, al.actor_id) END AS actor, CASE WHEN al.subject_id = ? THEN 'me' ELSE COALESCE(s.username, al.subject_id) END AS subject
    FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id WHERE al.actor_id = ? OR al.subject_id = ? ORDER BY al.seq DESC LIMIT 20000`).all(userId, userId, userId, userId) as Row[];
  const aiUsage = db.prepare('SELECT day, workflow, model, requests, prompt_tokens, completion_tokens, total_tokens, failures FROM ai_usage_daily WHERE user_id = ? ORDER BY day DESC').all(userId) as Row[];
  const emails = db.prepare('SELECT id, to_address, kind, subject, status, error, created_at FROM email_log WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Row[];
  const maradminState = db.prepare('SELECT s.*, m.number, m.title FROM maradmin_user_state s LEFT JOIN maradmins m ON m.id = s.maradmin_id WHERE s.user_id = ?').all(userId) as Row[];
  const passkeys = listPasskeys(ctx, userId);
  const sessions = db.prepare('SELECT created_at, last_used_at, method, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC').all(userId) as Row[];

  const counts = Object.fromEntries(Object.entries(records).map(([t, rows]) => [t, rows.length]));
  return {
    format: 'vantage-personal/1', version: VERSION, exported_at: now(), instance: { display_name: ctx.runtime.displayName, organization: ctx.runtime.organizationName, metrics: ctx.runtime.metrics },
    profile: { ...user, prefs, rank } as Row & { username: string; rank: Row | null | undefined; prefs: unknown },
    readiness: readiness || null,
    units, memberships, roles,
    records,
    attachments: attachmentRows,
    notifications, audit_trail: auditTrail, ai_usage: aiUsage, email_log: emails, maradmin_state: maradminState,
    security: { passkeys, sessions, authenticator_enabled: Boolean(user.totp_enabled) },
    counts: { ...counts, attachments: attachmentRows.length, notifications: notifications.length, audit_trail: auditTrail.length },
    _files: attachmentFiles,
  };
}

const flat = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v != null && typeof v === 'object' ? JSON.stringify(v) : v]));
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file';

export function buildPersonalExportZip(ctx: AppContext, userId: string): { buffer: Buffer; filename: string; counts: Record<string, number> } {
  const data = buildPersonalExport(ctx, userId);
  const { _files, ...archive } = data;
  const stamp = archive.exported_at.slice(0, 10);
  const entries: ZipEntry[] = [];
  const readme = [
    `Vantage personal export for ${archive.profile.username} (${stamp})`, '',
    'vantage-export.json holds everything in one structured file. The CSVs are the same data one dataset per file, for spreadsheets.',
    'attachments/ holds the files you uploaded, named <record>-<attachment id>-<original name>.', '',
    'Records include entries in the recycle bin (deleted_at is set). Nothing here is a system of record; MOL is.',
    '', 'Datasets:', ...Object.entries(archive.counts).map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n');
  entries.push({ name: 'README.txt', data: readme });
  entries.push({ name: 'vantage-export.json', data: JSON.stringify(archive, null, 2) });
  entries.push({ name: 'profile.csv', data: rowsToCsv([flat({ ...archive.profile, rank: archive.profile.rank ? (archive.profile.rank as Row).abbr : null })]) });
  if (archive.readiness) entries.push({ name: 'readiness.csv', data: rowsToCsv([flat(archive.readiness)]) });
  entries.push({ name: 'units.csv', data: rowsToCsv(archive.units.map(flat)) });
  entries.push({ name: 'memberships.csv', data: rowsToCsv(archive.memberships.map(flat)) });
  entries.push({ name: 'roles.csv', data: rowsToCsv(archive.roles.map(flat)) });
  for (const [table, rows] of Object.entries(archive.records)) {
    if (table === 'activities') entries.push({ name: 'activities.csv', data: `﻿${rowsToCsv(rows.map((r) => ({ ...activityToCsvRow(r), 'Visibility': r.visibility, 'Unit': r.unit_id, 'Deleted at': r.deleted_at })), [...ACTIVITY_CSV_COLUMNS.map((c) => c.header), 'Visibility', 'Unit', 'Deleted at'])}` });
    else entries.push({ name: `${table}.csv`, data: rowsToCsv(rows.map(flat)) });
  }
  entries.push({ name: 'attachments.csv', data: rowsToCsv(archive.attachments.map(flat)) });
  entries.push({ name: 'notifications.csv', data: rowsToCsv(archive.notifications.map(flat)) });
  entries.push({ name: 'audit-trail.csv', data: rowsToCsv(archive.audit_trail.map(flat)) });
  entries.push({ name: 'ai-usage.csv', data: rowsToCsv(archive.ai_usage.map(flat)) });
  entries.push({ name: 'email-log.csv', data: rowsToCsv(archive.email_log.map(flat)) });
  for (const f of _files) entries.push({ name: `attachments/${safeName(String(f.record_table))}-${String(f.id).slice(0, 8)}-${safeName(String(f.original_name))}`, data: f.content as Buffer, modified: new Date(String(f.created_at)) });
  return { buffer: buildZip(entries), filename: `vantage-${safeName(String(archive.profile.username))}-${stamp}.zip`, counts: archive.counts };
}
