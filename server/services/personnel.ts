import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { badRequest } from '../lib/errors.ts';
import { createHash } from 'node:crypto';

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
  const body = text.replace(/^ /, '').trim();
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
  source: string;
  rowsSeen: number;
  massSeparation?: { count: number; activeBefore: number; share: number };
  rejected: Array<{ line: number; reason: string }>;
  creates: RosterRow[];
  updates: Array<{ edipi: string; name: string; changes: FieldChange[] }>;
  separations: Array<{ edipi: string; name: string; hasAccount: boolean }>;
  conflicts: Array<{ edipi: string; reason: string }>;
  unchanged: number;
}

interface RosterDbRow extends RosterRow { row_hash: string }

export const MASS_SEPARATION_SHARE = 0.2;

export function planSync(
  ctx: AppContext,
  rows: RosterRow[],
  source: string,
  rejected: ParseResult['rejected'] = [],
  allowMassSeparation = false,
): SyncPlan {
  const { db } = ctx;
  const existing = new Map<string, RosterDbRow>();
  for (const r of db.prepare('SELECT * FROM personnel_roster').all() as RosterDbRow[]) existing.set(r.edipi, r);

  const plan: SyncPlan = { source, rowsSeen: rows.length, rejected, creates: [], updates: [], separations: [], conflicts: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.edipi)) { plan.conflicts.push({ edipi: row.edipi, reason: 'the extract lists this EDIPI more than once' }); continue; }
    seen.add(row.edipi);
    const prior = existing.get(row.edipi);
    if (!prior) { plan.creates.push(row); continue; }
    if (prior.row_hash === rowHash(row)) { plan.unchanged += 1; continue; }
    const changes: FieldChange[] = [];
    for (const field of ['last_name', 'first_name', 'middle_initial', 'rank_id', 'mos', 'eas', 'unit_code', 'billet', 'status'] as const) {
      const from = (prior[field] ?? null) as string | null;
      const to = (row[field] ?? null) as string | null;
      if (from !== to) changes.push({ field, from, to });
    }
    if (changes.length) plan.updates.push({ edipi: row.edipi, name: `${row.last_name}, ${row.first_name}`, changes });
    else plan.unchanged += 1;
  }

  const activeBefore = [...existing.values()].filter((r) => r.status === 'active').length;
  const missing: Array<{ edipi: string; name: string; hasAccount: boolean }> = [];
  for (const [edipi, prior] of existing) {
    if (seen.has(edipi) || prior.status === 'separated') continue;
    const account = db.prepare('SELECT id FROM users WHERE edipi = ?').get(edipi) as { id: string } | undefined;
    missing.push({ edipi, name: `${prior.last_name}, ${prior.first_name}`, hasAccount: Boolean(account) });
  }
  const share = activeBefore ? missing.length / activeBefore : 0;
  if (missing.length && share > MASS_SEPARATION_SHARE && !allowMassSeparation) {
    plan.massSeparation = { count: missing.length, activeBefore, share };
    for (const m of missing) plan.conflicts.push({ edipi: m.edipi, reason: 'missing from the extract, held back pending confirmation' });
  } else {
    plan.separations.push(...missing);
  }

  for (const dup of db.prepare('SELECT edipi, COUNT(*) AS n FROM users WHERE edipi IS NOT NULL GROUP BY edipi HAVING n > 1').all() as Array<{ edipi: string; n: number }>) {
    plan.conflicts.push({ edipi: dup.edipi, reason: `${dup.n} accounts claim this EDIPI` });
  }
  return plan;
}

export function applySync(ctx: AppContext, plan: SyncPlan, actorId: string | null): { runId: string } {
  const { db } = ctx;
  const at = now();
  const runId = newId();

  db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO personnel_roster (edipi, last_name, first_name, middle_initial, rank_id, mos, eas, unit_code, billet, status, source, row_hash, synced_at, created_at, updated_at)
      VALUES (@edipi, @last_name, @first_name, @middle_initial, @rank_id, @mos, @eas, @unit_code, @billet, @status, @source, @row_hash, @at, @at, @at)
      ON CONFLICT(edipi) DO UPDATE SET
        last_name = excluded.last_name, first_name = excluded.first_name, middle_initial = excluded.middle_initial,
        rank_id = excluded.rank_id, mos = excluded.mos, eas = excluded.eas, unit_code = excluded.unit_code,
        billet = excluded.billet, status = excluded.status, source = excluded.source,
        row_hash = excluded.row_hash, synced_at = excluded.synced_at, updated_at = excluded.updated_at`);

    const write = (row: RosterRow) => upsert.run({ ...row, source: plan.source, row_hash: rowHash(row), at });
    for (const row of plan.creates) write(row);

    const byEdipi = new Map<string, RosterRow>();
    for (const row of [...plan.creates]) byEdipi.set(row.edipi, row);

    for (const update of plan.updates) {
      const merged = Object.fromEntries(update.changes.map((c) => [c.field, c.to]));
      const prior = db.prepare('SELECT * FROM personnel_roster WHERE edipi = ?').get(update.edipi) as RosterDbRow;
      const row: RosterRow = { ...prior, ...merged } as RosterRow;
      write(row);
      byEdipi.set(update.edipi, row);
      audit(ctx, {
        actor_id: actorId, action: 'personnel_sync_update', entity: 'personnel_roster', entity_id: update.edipi,
        detail: `${plan.source}: ${update.changes.map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}`,
      });
    }

    // Push the sourced fields onto any account that carries this EDIPI.
    const applyToAccount = (row: RosterRow) => {
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
        subject_id: account.id as string,
        detail: `${plan.source}: ${changes.map((c) => `${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join('; ')}`,
      });
    };
    for (const row of byEdipi.values()) applyToAccount(row);

    for (const sep of plan.separations) {
      db.prepare("UPDATE personnel_roster SET status = 'separated', synced_at = ?, updated_at = ? WHERE edipi = ?").run(at, at, sep.edipi);
      const account = db.prepare('SELECT id FROM users WHERE edipi = ?').get(sep.edipi) as { id: string } | undefined;
      if (account) db.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ?').run(at, account.id);
      audit(ctx, {
        actor_id: actorId, action: 'personnel_separated', entity: 'personnel_roster', entity_id: sep.edipi,
        subject_id: account?.id ?? null, detail: `${plan.source}: no longer on the roster${account ? '; account deactivated' : ''}`,
      });
    }

    db.prepare(`INSERT INTO personnel_sync_runs (id, source, actor_id, dry_run, rows_seen, created, updated, separated, conflicts, detail, at)
                VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, plan.source, actorId, plan.rowsSeen, plan.creates.length, plan.updates.length, plan.separations.length, plan.conflicts.length,
           JSON.stringify({ unchanged: plan.unchanged, rejected: plan.rejected.length }), at);
  })();

  audit(ctx, { actor_id: actorId, action: 'personnel_sync', detail: `${plan.source}: +${plan.creates.length} ~${plan.updates.length} -${plan.separations.length}` });
  return { runId };
}

export function divergence(ctx: AppContext) {
  const { db } = ctx;
  return {
    accountsWithoutRoster: db.prepare(`
      SELECT u.id, u.username, u.edipi, u.first_name, u.last_name FROM users u
      WHERE u.edipi IS NOT NULL AND NOT EXISTS (SELECT 1 FROM personnel_roster r WHERE r.edipi = u.edipi)
      ORDER BY u.last_name LIMIT 500`).all(),
    accountsWithoutEdipi: db.prepare(`
      SELECT id, username, first_name, last_name FROM users WHERE edipi IS NULL AND active = 1 ORDER BY last_name LIMIT 500`).all(),
    rosterWithoutAccount: db.prepare(`
      SELECT r.edipi, r.last_name, r.first_name, r.rank_id, r.unit_code FROM personnel_roster r
      WHERE r.status = 'active' AND NOT EXISTS (SELECT 1 FROM users u WHERE u.edipi = r.edipi)
      ORDER BY r.last_name LIMIT 500`).all(),
  };
}

export function rosterStats(ctx: AppContext) {
  const { db } = ctx;
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM personnel_roster GROUP BY status").all() as Array<{ status: string; n: number }>;
  const last = db.prepare('SELECT * FROM personnel_sync_runs ORDER BY at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  return {
    active: counts.find((c) => c.status === 'active')?.n || 0,
    separated: counts.find((c) => c.status === 'separated')?.n || 0,
    linkedAccounts: (db.prepare("SELECT COUNT(*) AS n FROM users WHERE identity_source = 'roster'").get() as { n: number }).n,
    lastSync: last || null,
  };
}

export function sourcedFieldsFor(ctx: AppContext, userId: string): SourcedField[] {
  const row = ctx.db.prepare('SELECT identity_source, edipi FROM users WHERE id = ?').get(userId) as { identity_source?: string; edipi?: string | null } | undefined;
  if (!row || row.identity_source !== 'roster' || !row.edipi) return [];
  const roster = ctx.db.prepare('SELECT * FROM personnel_roster WHERE edipi = ?').get(row.edipi) as Record<string, unknown> | undefined;
  if (!roster) return [];
  return SOURCED_FIELDS.filter((f) => roster[f] != null && roster[f] !== '');
}
