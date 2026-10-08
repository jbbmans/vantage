import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { badRequest } from '../lib/errors.ts';
import { createHash } from 'node:crypto';
import { addMember, primaryOrgOf, removeMember, setPrimaryUnit } from './org.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { RECORD_TABLE_NAMES } from './records.ts';

export const SOURCED_FIELDS = ['first_name', 'last_name', 'middle_initial', 'rank_id', 'mos', 'eas'] as const;
export type SourcedField = (typeof SOURCED_FIELDS)[number];

export interface RosterRow {
  edipi: string;
  last_name: string;
  first_name: string;
  middle_initial: string | null;
  rank_id: string | null;
  mos: string | null;
  eas: string | null;
  unit_code: string | null;
  billet: string | null;
  status: 'active' | 'separated';
}

export const isEdipi = (v: unknown): v is string => typeof v === 'string' && /^\d{10}$/.test(v);

const clean = (v: unknown, max = 120): string | null => {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};
const rowHash = (row: RosterRow) =>
  createHash('sha256').update(JSON.stringify([row.edipi, row.last_name, row.first_name, row.middle_initial, row.rank_id, row.mos, row.eas, row.unit_code, row.billet, row.status])).digest('hex').slice(0, 32);

const ALIASES: Record<string, string[]> = {
  edipi: ['edipi', 'dodid', 'dod_id', 'dod id', 'edi_pi', 'person_id'],
  last_name: ['last_name', 'last', 'surname', 'lastname'],
  first_name: ['first_name', 'first', 'given_name', 'firstname'],
  middle_initial: ['middle_initial', 'mi', 'middle'],
  rank_id: ['rank_id', 'rank', 'grade', 'pay_grade', 'paygrade'],
  mos: ['mos', 'pmos', 'primary_mos'],
  eas: ['eas', 'eas_date', 'end_of_active_service'],
  unit_code: ['unit_code', 'unit', 'ruc', 'mcc', 'unit_id'],
  billet: ['billet', 'duty', 'billet_title', 'duty_title'],
  status: ['status', 'duty_status', 'personnel_status'],
};

function headerIndex(headers: string[]): Record<string, number> {
  const norm = headers.map((h) => h.replace(/\uFEFF/g, '').trim().toLowerCase());
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) out[field] = i;
  }
  return out;
}

/** Split a delimited line, honouring quoted fields. */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export interface ParseResult { rows: RosterRow[]; rejected: Array<{ line: number; reason: string }> }

export function parseRoster(text: string, maxRows = 200_000): ParseResult {
  const rows: RosterRow[] = [];
  const rejected: Array<{ line: number; reason: string }> = [];
  const body = text.trim(); // trim() also drops the byte-order mark Excel puts at the front of a CSV
  if (!body) throw badRequest('The roster file is empty.');

  const take = (get: (field: string) => unknown, line: number) => {
    const edipi = clean(get('edipi'), 32);
    if (!isEdipi(edipi)) { rejected.push({ line, reason: edipi ? `not a ten-digit EDIPI: ${edipi}` : 'no EDIPI column value' }); return; }
    const last = clean(get('last_name'));
    const first = clean(get('first_name'));
    if (!last || !first) { rejected.push({ line, reason: 'missing a name' }); return; }
    const statusRaw = (clean(get('status'), 20) || 'active').toLowerCase();
    const row: RosterRow = {
      edipi,
      last_name: last,
      first_name: first,
      middle_initial: clean(get('middle_initial'), 1),
      rank_id: clean(get('rank_id'), 16),
      mos: clean(get('mos'), 16),
      eas: clean(get('eas'), 10),
      unit_code: clean(get('unit_code'), 40),
      billet: clean(get('billet'), 120),
      status: /sep|disch|inactive|loss/.test(statusRaw) ? 'separated' : 'active',
    };
    rows.push(row);
  };

  if (body.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw badRequest('That JSON roster could not be read.'); }
    if (!Array.isArray(parsed)) throw badRequest('A JSON roster must be an array of rows.');
    if (parsed.length > maxRows) throw badRequest(`That roster has more than ${maxRows.toLocaleString()} rows.`);
    parsed.forEach((entry, i) => {
      const obj = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const lower: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) lower[k.trim().toLowerCase()] = v;
      take((field) => { for (const name of ALIASES[field]) if (name in lower) return lower[name]; return null; }, i + 1);
    });
    return { rows, rejected };
  }

  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > maxRows + 1) throw badRequest(`That roster has more than ${maxRows.toLocaleString()} rows.`);
  const delimiter = (lines[0].match(/\t/g)?.length || 0) > (lines[0].match(/,/g)?.length || 0) ? '\t' : ',';
  const index = headerIndex(splitLine(lines[0], delimiter));
  if (index.edipi == null) throw badRequest('The roster needs an EDIPI column (EDIPI, DODID, or DoD ID).');
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitLine(lines[i], delimiter);
    take((field) => (index[field] == null ? null : cells[index[field]]), i + 1);
  }
  return { rows, rejected };
}

export interface FieldChange { field: string; from: string | null; to: string | null }
export interface SyncPlan {
  /** The organization the extract is for (ADR-0006): its roster, its memberships. */
  orgId: string;
  source: string;
  rowsSeen: number;
  massSeparation?: { count: number; activeBefore: number; share: number };
  rejected: Array<{ line: number; reason: string }>;
  creates: RosterRow[];
  updates: Array<{ edipi: string; name: string; changes: FieldChange[] }>;
  /** `listed`: on the extract with a separated status, rather than missing from it. */
  separations: Array<{ edipi: string; name: string; hasAccount: boolean; listed: boolean }>;
  conflicts: Array<{ edipi: string; reason: string }>;
  unchanged: number;
}

interface RosterDbRow extends RosterRow { row_hash: string }

export const MASS_SEPARATION_SHARE = 0.2;

const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Extracts write a rank their own way (SGT, Sgt, E5, E-5). Each resolves to a rank Vantage knows, or to nothing. */
function rankResolver(ctx: AppContext) {
  const known = new Map<string, string | null>();
  const add = (key: string, id: string) => { const k = squash(key); known.set(k, known.has(k) && known.get(k) !== id ? null : id); };
  for (const r of ctx.db.prepare('SELECT id, abbr, grade FROM ranks').all() as Array<{ id: string; abbr: string; grade: string }>) {
    add(r.id, r.id); add(r.abbr, r.id); add(r.grade, r.id); // E-8 and E-9 are two ranks each, so a bare grade there resolves to nothing
  }
  return (raw: string) => known.get(squash(raw)) ?? null;
}

/** An EAS as YYYY-MM-DD, from that form, YYYYMMDD or MM/DD/YYYY. */
function rosterDate(raw: string): string | null {
  const iso = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!iso && !us) return null;
  const [y, mo, d] = iso ? [iso[1], iso[2], iso[3]] : [us![3], us![1].padStart(2, '0'), us![2].padStart(2, '0')];
  const date = new Date(Date.UTC(+y, +mo - 1, +d));
  return date.getUTCMonth() === +mo - 1 && date.getUTCDate() === +d ? `${y}-${mo}-${d}` : null;
}

/**
 * Whether an organization's extract speaks for this account: it belongs to one of the organization's units, or to no
 * unit at all. An account that belongs only to other organizations is theirs to separate, not this one's, and an account
 * that runs the service (a platform role) and sits in no unit belongs to no organization's feed (ADR-0008).
 */
function speaksFor(ctx: AppContext, orgId: string, edipi: string, activeOnly: boolean): boolean {
  return Boolean(ctx.db.prepare(
    `SELECT 1 FROM users u WHERE u.edipi = ? ${activeOnly ? 'AND u.active = 1' : ''}
       AND (EXISTS (SELECT 1 FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE um.user_id = u.id AND un.org_id = ?)
            OR (NOT EXISTS (SELECT 1 FROM unit_members um WHERE um.user_id = u.id)
                AND NOT EXISTS (SELECT 1 FROM platform_roles pr WHERE pr.user_id = u.id)))`
  ).get(edipi, orgId));
}

/**
 * Whether this organization's extract keeps the person's profile: it holds their primary unit, or they have none
 * (ADR-0009). Someone who serves in two Unit Instances has one name, rank and MOS; two feeds writing them in turn would
 * flip them back and forth, and the instance they serve in secondarily would be rewriting what the other reads.
 */
function keepsProfile(ctx: AppContext, orgId: string, edipi: string): boolean {
  const home = ctx.db.prepare(`SELECT un.org_id FROM users u JOIN unit_members um ON um.user_id = u.id AND um.is_primary = 1 JOIN units un ON un.id = um.unit_id WHERE u.edipi = ? LIMIT 1`)
    .get(edipi) as { org_id: string | null } | undefined;
  return !home || home.org_id === orgId;
}

export function planSync(
  ctx: AppContext,
  orgId: string,
  rows: RosterRow[],
  source: string,
  rejected: ParseResult['rejected'] = [],
  allowMassSeparation = false,
): SyncPlan {
  const { db } = ctx;
  const existing = new Map<string, RosterDbRow>();
  for (const r of db.prepare('SELECT * FROM personnel_roster WHERE org_id = ?').all(orgId) as RosterDbRow[]) existing.set(r.edipi, r);

  const plan: SyncPlan = { orgId, source, rowsSeen: rows.length, rejected, creates: [], updates: [], separations: [], conflicts: [], unchanged: 0 };
  const seen = new Set<string>();
  const rank = rankResolver(ctx);
  const hasAccount = (edipi: string) => speaksFor(ctx, orgId, edipi, false);
  const activeAccount = (edipi: string) => speaksFor(ctx, orgId, edipi, true);
  const marked: SyncPlan['separations'] = [];
  // People new to the roster whose EDIPI is already on an active account. The guard counts them as active before
  // this extract, as it does a roster row; those the extract marks separated wait on the guard before being written.
  let firstSeenActive = 0;
  const firstSeen: Array<{ row: RosterRow; sep: SyncPlan['separations'][number] }> = [];

  for (const raw of rows) {
    // A value Vantage cannot place is left as it is on the account, and said so, rather than failing the whole sync.
    const row = { ...raw, rank_id: raw.rank_id && rank(raw.rank_id), eas: raw.eas && rosterDate(raw.eas) };
    if (raw.rank_id && !row.rank_id) plan.conflicts.push({ edipi: raw.edipi, reason: `rank “${raw.rank_id}” is not one Vantage knows, so the rank was left as it is` });
    if (raw.eas && !row.eas) plan.conflicts.push({ edipi: raw.edipi, reason: `EAS “${raw.eas}” is not a date, so it was left as it is` });
    if (seen.has(row.edipi)) { plan.conflicts.push({ edipi: row.edipi, reason: 'the extract lists this EDIPI more than once' }); continue; }
    seen.add(row.edipi);
    const prior = existing.get(row.edipi);
    if (!prior) {
      if (activeAccount(row.edipi)) {
        firstSeenActive += 1;
        // First on the roster already separated: the account it matches is turned off, as it would be had an earlier
        // extract listed them active.
        if (row.status === 'separated') { firstSeen.push({ row, sep: { edipi: row.edipi, name: `${row.last_name}, ${row.first_name}`, hasAccount: true, listed: true } }); continue; }
      }
      plan.creates.push(row);
      continue;
    }
    // Rows separated before the hash was cleared on separation still carry their last active hash.
    if (prior.row_hash === rowHash(row) && prior.status === row.status) { plan.unchanged += 1; continue; }
    const changes: FieldChange[] = [];
    for (const field of ['last_name', 'first_name', 'middle_initial', 'rank_id', 'mos', 'eas', 'unit_code', 'billet', 'status'] as const) {
      const from = (prior[field] ?? null) as string | null;
      const to = (row[field] ?? null) as string | null;
      if (from !== to) changes.push({ field, from, to });
    }
    if (changes.length) plan.updates.push({ edipi: row.edipi, name: `${row.last_name}, ${row.first_name}`, changes });
    else plan.unchanged += 1;
    // An extract that marks someone separated separates them as surely as leaving them off it does.
    if (prior.status === 'active' && row.status === 'separated') marked.push({ edipi: row.edipi, name: `${row.last_name}, ${row.first_name}`, hasAccount: hasAccount(row.edipi), listed: true });
  }

  const activeBefore = [...existing.values()].filter((r) => r.status === 'active').length + firstSeenActive;
  const missing: SyncPlan['separations'] = [];
  for (const [edipi, prior] of existing) {
    if (seen.has(edipi) || prior.status === 'separated') continue;
    missing.push({ edipi, name: `${prior.last_name}, ${prior.first_name}`, hasAccount: hasAccount(edipi), listed: false });
  }
  const leaving = [...missing, ...marked, ...firstSeen.map((f) => f.sep)];
  const share = activeBefore ? leaving.length / activeBefore : 0;
  if (leaving.length && share > MASS_SEPARATION_SHARE && !allowMassSeparation) {
    plan.massSeparation = { count: leaving.length, activeBefore, share };
    for (const m of missing) plan.conflicts.push({ edipi: m.edipi, reason: 'missing from the extract, held back pending confirmation' });
    for (const m of marked) {
      plan.conflicts.push({ edipi: m.edipi, reason: 'marked separated in the extract, held back pending confirmation' });
      // Held back means still active on the roster too, so the next extract raises it again.
      const update = plan.updates.find((u) => u.edipi === m.edipi)!;
      update.changes = update.changes.filter((c) => c.field !== 'status');
      if (!update.changes.length) plan.updates.splice(plan.updates.indexOf(update), 1);
    }
    // Not written at all, so the next extract that lists them raises it again.
    for (const f of firstSeen) plan.conflicts.push({ edipi: f.row.edipi, reason: 'new to the roster, marked separated and matching an active account; held back pending confirmation' });
  } else {
    plan.creates.push(...firstSeen.map((f) => f.row));
    plan.separations.push(...leaving);
  }

  for (const dup of db.prepare(`SELECT edipi, COUNT(*) AS n FROM users WHERE edipi IN (SELECT edipi FROM personnel_roster WHERE org_id = ?) GROUP BY edipi HAVING n > 1`).all(orgId) as Array<{ edipi: string; n: number }>) {
    plan.conflicts.push({ edipi: dup.edipi, reason: `${dup.n} accounts claim this EDIPI` });
  }
  return plan;
}

/**
 * The organization roster row that vouches for an EDIPI, for signing in with a card or the organization's provider:
 * the most recently synced active row, if any organization lists them.
 */
export function rosterVouching(ctx: AppContext, edipi: string): (Record<string, string | null> & { org_id: string }) | undefined {
  return ctx.db.prepare(`SELECT r.* FROM personnel_roster r JOIN organizations o ON o.id = r.org_id
                          WHERE r.edipi = ? AND r.status = 'active' AND o.status = 'active' ORDER BY r.synced_at DESC LIMIT 1`).get(edipi) as (Record<string, string | null> & { org_id: string }) | undefined;
}

/** An account provisioned from an organization's roster joins it: the unit its row names, or the organization's top unit. */
export function seatFromRoster(ctx: AppContext, userId: string, row: { org_id: string; unit_code?: string | null }) {
  const unit = (row.unit_code
    ? ctx.db.prepare('SELECT id FROM units WHERE org_id = ? AND active = 1 AND (code = ? COLLATE NOCASE OR short_name = ? COLLATE NOCASE) LIMIT 1').get(row.org_id, row.unit_code, row.unit_code) as { id: string } | undefined
    : undefined) ?? ctx.db.prepare('SELECT root_unit_id AS id FROM organizations WHERE id = ?').get(row.org_id) as { id: string | null } | undefined;
  if (unit?.id) addMember(ctx, userId, unit.id, { primary: true, reason: 'roster' });
  audit(ctx, { actor_id: null, action: 'personnel_provisioned', entity: 'users', entity_id: userId, subject_id: userId, org_id: row.org_id, unit_id: unit?.id ?? null, detail: 'account created from the roster at first sign-in' });
}

/** A plan as the console shows it: counts, and the first hundred of each kind of change. */
export function summarizePlan(plan: SyncPlan) {
  return {
    source: plan.source,
    rowsSeen: plan.rowsSeen,
    massSeparation: plan.massSeparation ?? null,
    unchanged: plan.unchanged,
    counts: { creates: plan.creates.length, updates: plan.updates.length, separations: plan.separations.length, conflicts: plan.conflicts.length, rejected: plan.rejected.length },
    creates: plan.creates.slice(0, 100).map((c) => ({ edipi: c.edipi, name: `${c.last_name}, ${c.first_name}`, rank_id: c.rank_id, unit_code: c.unit_code })),
    updates: plan.updates.slice(0, 100),
    separations: plan.separations.slice(0, 100),
    conflicts: plan.conflicts.slice(0, 100),
    rejected: plan.rejected.slice(0, 100),
  };
}

export function applySync(ctx: AppContext, plan: SyncPlan, actorId: string | null): { runId: string } {
  const { db } = ctx;
  const at = now();
  const runId = newId();

  db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO personnel_roster (org_id, edipi, last_name, first_name, middle_initial, rank_id, mos, eas, unit_code, billet, status, source, row_hash, synced_at, created_at, updated_at)
      VALUES (@org_id, @edipi, @last_name, @first_name, @middle_initial, @rank_id, @mos, @eas, @unit_code, @billet, @status, @source, @row_hash, @at, @at, @at)
      ON CONFLICT(org_id, edipi) DO UPDATE SET
        last_name = excluded.last_name, first_name = excluded.first_name, middle_initial = excluded.middle_initial,
        rank_id = excluded.rank_id, mos = excluded.mos, eas = excluded.eas, unit_code = excluded.unit_code,
        billet = excluded.billet, status = excluded.status, source = excluded.source,
        row_hash = excluded.row_hash, synced_at = excluded.synced_at, updated_at = excluded.updated_at`);

    // What the feed takes away it can give back: memberships it ended, with their billets and roles, restored if a later
    // extract lists the person as active again. Records frozen on the way out are thawed with them.
    const endMemberships = (userId: string, edipi: string): number => {
      const held = db.prepare(`SELECT um.unit_id, um.is_primary, um.billet FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE um.user_id = ? AND un.org_id = ?`)
        .all(userId, plan.orgId) as Array<{ unit_id: string; is_primary: number; billet: string | null }>;
      if (!held.length) return 0;
      const removed = held.map((m) => ({
        ...m,
        roles: (db.prepare('SELECT role_id, expires_at FROM member_roles WHERE user_id = ? AND unit_id = ?').all(userId, m.unit_id) as Array<{ role_id: string; expires_at: string | null }>),
        frozen_at: at,
      }));
      for (const m of held) removeMember(ctx, userId, m.unit_id, actorId, 'roster_separation');
      db.prepare('UPDATE personnel_roster SET removed_units = ? WHERE org_id = ? AND edipi = ?').run(JSON.stringify(removed), plan.orgId, edipi);
      return held.length;
    };
    const restoreMemberships = (edipi: string, userId: string) => {
      const row = db.prepare('SELECT removed_units FROM personnel_roster WHERE org_id = ? AND edipi = ?').get(plan.orgId, edipi) as { removed_units: string | null } | undefined;
      if (!row?.removed_units) return;
      let removed: Array<{ unit_id: string; is_primary: number; billet: string | null; roles: Array<{ role_id: string; expires_at: string | null }>; frozen_at: string }> = [];
      try { removed = JSON.parse(row.removed_units); } catch { removed = []; }
      for (const m of removed) {
        if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND org_id = ? AND active = 1').get(m.unit_id, plan.orgId)) continue;
        addMember(ctx, userId, m.unit_id, { primary: Boolean(m.is_primary), billet: m.billet, reason: 'roster_restored' });
        // The primary unit this organization's own extract moved away goes back with the rest, even when it went to another
        // Unit Instance meanwhile: giving back what the same feed took is not taking from another instance (ADR-0008).
        if (m.is_primary) setPrimaryUnit(ctx, userId, m.unit_id);
        for (const r of m.roles) db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at, expires_at) SELECT ?, id, unit_id, NULL, ?, ? FROM roles WHERE id = ? AND unit_id = ?').run(userId, at, r.expires_at, r.role_id, m.unit_id);
        for (const table of RECORD_TABLE_NAMES) db.prepare(`UPDATE ${table} SET frozen_at = NULL, updated_at = ? WHERE user_id = ? AND unit_id = ? AND frozen_at = ?`).run(at, userId, m.unit_id, m.frozen_at);
      }
      db.prepare('UPDATE personnel_roster SET removed_units = NULL WHERE org_id = ? AND edipi = ?').run(plan.orgId, edipi);
      audit(ctx, { actor_id: actorId, action: 'personnel_restored', entity: 'personnel_roster', entity_id: edipi, subject_id: userId, org_id: plan.orgId, detail: `${plan.source}: back on the roster; ${removed.length} membership${removed.length === 1 ? '' : 's'} restored` });
    };

    const write = (row: RosterRow) => upsert.run({ ...row, org_id: plan.orgId, source: plan.source, row_hash: rowHash(row), at });

    // Back on the extract as active. Undo a deactivation the roster made, and only that: if an operator
    // deactivated the account since (or before), that decision stands.
    const reactivate = (edipi: string) => {
      const account = db.prepare('SELECT id, active FROM users WHERE edipi = ?').get(edipi) as { id: string; active: number } | undefined;
      if (!account) return;
      restoreMemberships(edipi, account.id);
      if (account.active) return;
      const last = db.prepare(`SELECT action, detail, org_id FROM audit_log WHERE subject_id = ? AND action IN ('personnel_separated', 'deactivate_member', 'reactivate_member', 'deactivate_account', 'reactivate_account')
                                ORDER BY seq DESC LIMIT 1`).get(account.id) as { action: string; detail: string | null; org_id: string | null } | undefined;
      // Only this organization's own separation is this organization's to undo.
      if (last?.action !== 'personnel_separated' || !last.detail?.endsWith('; account deactivated') || (last.org_id && last.org_id !== plan.orgId)) return;
      db.prepare('UPDATE users SET active = 1, updated_at = ? WHERE id = ?').run(at, account.id);
      audit(ctx, {
        actor_id: actorId, action: 'personnel_reactivated', entity: 'personnel_roster', entity_id: edipi, org_id: plan.orgId,
        subject_id: account.id, detail: `${plan.source}: back on the roster as active; account reactivated`,
      });
    };
    for (const row of plan.creates) write(row);

    const byEdipi = new Map<string, RosterRow>();
    for (const row of [...plan.creates]) byEdipi.set(row.edipi, row);

    for (const update of plan.updates) {
      const merged = Object.fromEntries(update.changes.map((c) => [c.field, c.to]));
      const prior = db.prepare('SELECT * FROM personnel_roster WHERE org_id = ? AND edipi = ?').get(plan.orgId, update.edipi) as RosterDbRow;
      const row: RosterRow = { ...prior, ...merged } as RosterRow;
      write(row);
      byEdipi.set(update.edipi, row);
      audit(ctx, {
        actor_id: actorId, action: 'personnel_sync_update', entity: 'personnel_roster', entity_id: update.edipi, org_id: plan.orgId,
        detail: `${plan.source}: ${update.changes.map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}`,
      });
      if (update.changes.some((c) => c.field === 'status' && c.from === 'separated' && c.to === 'active')) reactivate(update.edipi);
    }

    // Push the sourced fields onto the account that carries this EDIPI, if this organization's extract speaks for it and
    // keeps the profile of a person who serves in more than one Unit Instance.
    const applyToAccount = (row: RosterRow) => {
      if (!speaksFor(ctx, plan.orgId, row.edipi, false) || !keepsProfile(ctx, plan.orgId, row.edipi)) return;
      const account = db.prepare('SELECT * FROM users WHERE edipi = ?').get(row.edipi) as Record<string, unknown> | undefined;
      if (!account) return;
      const changes: FieldChange[] = [];
      for (const field of SOURCED_FIELDS) {
        const to = (row[field] ?? null) as string | null;
        const from = (account[field] ?? null) as string | null;
        if (to !== null && from !== to) changes.push({ field, from, to });
      }
      if (!changes.length) return;
      const sets = changes.map((c) => `${c.field} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${sets}, identity_source = 'roster', identity_synced_at = ?, updated_at = ? WHERE id = ?`)
        .run(...changes.map((c) => c.to), at, at, account.id as string);
      audit(ctx, {
        actor_id: actorId, action: 'personnel_profile_updated', entity: 'users', entity_id: account.id as string,
        subject_id: account.id as string, org_id: plan.orgId,
        detail: `${plan.source}: ${changes.map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}`,
      });
    };
    for (const row of byEdipi.values()) applyToAccount(row);

    for (const sep of plan.separations) {
      // A listed row was written with its separated status above. A missing one keeps no hash, so the next
      // extract that lists them reads as a change (a return), not as unchanged.
      if (!sep.listed) db.prepare("UPDATE personnel_roster SET status = 'separated', row_hash = '', synced_at = ?, updated_at = ? WHERE org_id = ? AND edipi = ?").run(at, at, plan.orgId, sep.edipi);
      const account = db.prepare('SELECT id FROM users WHERE edipi = ?').get(sep.edipi) as { id: string } | undefined;
      // Leaving this organization ends the memberships in it, kept so a return can restore them. The account itself is
      // turned off only when the person belongs to no other organization (ADR-0006).
      const left = account ? endMemberships(account.id, sep.edipi) : 0;
      // Nor is an account that runs the service turned off by one organization's extract.
      const elsewhere = account ? Boolean(db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? UNION ALL SELECT 1 FROM platform_roles WHERE user_id = ? LIMIT 1').get(account.id, account.id)) : false;
      const deactivated = account && !elsewhere ? db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ? AND active = 1').run(at, account.id).changes > 0 : false;
      if (deactivated) invalidateUserSessions(ctx, account!.id);
      audit(ctx, {
        actor_id: actorId, action: 'personnel_separated', entity: 'personnel_roster', entity_id: sep.edipi, org_id: plan.orgId,
        subject_id: account?.id ?? null, detail: `${plan.source}: ${sep.listed ? 'marked separated in the extract' : 'no longer on the roster'}${left ? `; left ${left} unit${left === 1 ? '' : 's'}` : ''}${deactivated ? '; account deactivated' : ''}`,
      });
    }

    db.prepare(`INSERT INTO personnel_sync_runs (id, org_id, source, actor_id, dry_run, rows_seen, created, updated, separated, conflicts, detail, at)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, plan.orgId, plan.source, actorId, plan.rowsSeen, plan.creates.length, plan.updates.length, plan.separations.length, plan.conflicts.length,
           JSON.stringify({ unchanged: plan.unchanged, rejected: plan.rejected.length }), at);
  })();

  audit(ctx, { actor_id: actorId, action: 'personnel_sync', org_id: plan.orgId, detail: `${plan.source}: +${plan.creates.length} ~${plan.updates.length} -${plan.separations.length}` });
  return { runId };
}

/** Accounts and roster entries that do not line up, for one organization: none of it is resolved automatically. */
export function divergence(ctx: AppContext, orgId: string) {
  const { db } = ctx;
  const members = `SELECT um.user_id FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.org_id = ?`;
  return {
    accountsWithoutRoster: db.prepare(`
      SELECT u.id, u.username, u.edipi, u.first_name, u.last_name FROM users u
      WHERE u.id IN (${members}) AND u.edipi IS NOT NULL AND NOT EXISTS (SELECT 1 FROM personnel_roster r WHERE r.org_id = ? AND r.edipi = u.edipi)
      ORDER BY u.last_name LIMIT 500`).all(orgId, orgId),
    accountsWithoutEdipi: db.prepare(`
      SELECT id, username, first_name, last_name FROM users WHERE id IN (${members}) AND edipi IS NULL AND active = 1 ORDER BY last_name LIMIT 500`).all(orgId),
    rosterWithoutAccount: db.prepare(`
      SELECT r.edipi, r.last_name, r.first_name, r.rank_id, r.unit_code FROM personnel_roster r
      WHERE r.org_id = ? AND r.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.edipi = r.edipi)
      ORDER BY r.last_name LIMIT 500`).all(orgId),
  };
}

export function rosterStats(ctx: AppContext, orgId: string) {
  const { db } = ctx;
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM personnel_roster WHERE org_id = ? GROUP BY status').all(orgId) as Array<{ status: string; n: number }>;
  const last = db.prepare('SELECT * FROM personnel_sync_runs WHERE org_id = ? ORDER BY at DESC LIMIT 1').get(orgId) as Record<string, unknown> | undefined;
  return {
    active: counts.find((c) => c.status === 'active')?.n || 0,
    separated: counts.find((c) => c.status === 'separated')?.n || 0,
    linkedAccounts: (db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE u.identity_source = 'roster' AND EXISTS (SELECT 1 FROM personnel_roster r WHERE r.org_id = ? AND r.edipi = u.edipi)`).get(orgId) as { n: number }).n,
    lastSync: last || null,
  };
}

export function sourcedFieldsFor(ctx: AppContext, userId: string): SourcedField[] {
  const row = ctx.db.prepare('SELECT identity_source, edipi FROM users WHERE id = ?').get(userId) as { identity_source?: string; edipi?: string | null } | undefined;
  if (!row || row.identity_source !== 'roster' || !row.edipi) return [];
  // The feed of the Unit Instance that holds their primary unit, the only one that writes their profile (ADR-0009); for
  // someone in no unit, whichever organization's feed spoke for them last.
  const home = primaryOrgOf(ctx, userId)?.orgId;
  const roster = (home
    ? ctx.db.prepare('SELECT * FROM personnel_roster WHERE edipi = ? AND org_id = ?').get(row.edipi, home)
    : ctx.db.prepare('SELECT * FROM personnel_roster WHERE edipi = ? ORDER BY synced_at DESC LIMIT 1').get(row.edipi)) as Record<string, unknown> | undefined;
  if (!roster) return [];
  return SOURCED_FIELDS.filter((f) => roster[f] != null && roster[f] !== '');
}
