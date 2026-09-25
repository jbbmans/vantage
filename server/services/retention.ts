import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { RECORD_TABLE_NAMES } from './records.ts';
import type { RecordTable } from '../../shared/schemas.ts';
import { badRequest } from '../lib/errors.ts';
import { holdState } from './holds.ts';

export type Disposition = 'destroy' | 'anonymize' | 'review';

export interface RetentionSchedule {
  id: string;
  record_type: string;
  retain_days: number;
  disposition: Disposition;
  authority: string | null;
  notes: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface LegalHold {
  id: string;
  scope: 'instance' | 'user' | 'record_type';
  subject_id: string | null;
  record_type: string | null;
  reason: string;
  placed_by: string;
  placed_at: string;
  released_by: string | null;
  released_at: string | null;
}

/** The date column that starts the retention clock for each kind of record. */
const CLOCK: Record<string, string> = {
  activities: 'date', trainings: 'date', awards: 'date', counselings: 'date',
  goals: 'period_end', tasks: 'updated_at', projects: 'updated_at',
};

export const REDACTED = '[redacted under retention schedule]';

const IDENTIFYING: Record<string, string[]> = {
  activities: ['title', 'result', 'notes'],
  trainings: ['title', 'provider', 'notes'],
  awards: ['citation', 'notes', 'recommending_official', 'approving_authority'],
  counselings: ['summary', 'strengths', 'improvements', 'goals_set', 'counselor_name'],
  goals: ['title', 'description'],
  tasks: ['title', 'notes'],
  projects: ['name', 'description'],
};

export const RETAINABLE_TYPES = RECORD_TABLE_NAMES.filter((t) => CLOCK[t]);

export const HOLDABLE_TYPES = [...RECORD_TABLE_NAMES, 'work_items', 'source_files'] as const;

export function listSchedules(ctx: AppContext): RetentionSchedule[] {
  return ctx.db.prepare('SELECT * FROM retention_schedules ORDER BY record_type').all() as RetentionSchedule[];
}

export function saveSchedule(
  ctx: AppContext,
  input: { record_type: string; retain_days: number; disposition: Disposition; authority?: string | null; notes?: string | null; enabled?: boolean },
  actorId: string,
): RetentionSchedule {
  if (!RETAINABLE_TYPES.includes(input.record_type as RecordTable)) throw badRequest(`No retention clock is defined for ${input.record_type}.`);
  if (!Number.isInteger(input.retain_days) || input.retain_days < 1) throw badRequest('Retention has to be at least one day.');
  const at = now();
  const existing = ctx.db.prepare('SELECT * FROM retention_schedules WHERE record_type = ?').get(input.record_type) as RetentionSchedule | undefined;
  const id = existing?.id || newId();
  ctx.db.prepare(`
    INSERT INTO retention_schedules (id, record_type, retain_days, disposition, authority, notes, enabled, created_at, updated_at)
    VALUES (@id, @record_type, @retain_days, @disposition, @authority, @notes, @enabled, @at, @at)
    ON CONFLICT(record_type) DO UPDATE SET
      retain_days = excluded.retain_days, disposition = excluded.disposition, authority = excluded.authority,
      notes = excluded.notes, enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .run({ id, record_type: input.record_type, retain_days: input.retain_days, disposition: input.disposition,
           authority: input.authority ?? null, notes: input.notes ?? null, enabled: input.enabled ? 1 : 0, at });
  audit(ctx, {
    actor_id: actorId, action: 'retention_schedule_saved', entity: 'retention_schedules', entity_id: id,
    detail: `${input.record_type}: ${input.retain_days}d ${input.disposition}${input.enabled ? ' enabled' : ' disabled'}${input.authority ? ` (${input.authority})` : ''}`,
  });
  return ctx.db.prepare('SELECT * FROM retention_schedules WHERE id = ?').get(id) as RetentionSchedule;
}

export function openHolds(ctx: AppContext): LegalHold[] {
  return ctx.db.prepare('SELECT * FROM legal_holds WHERE released_at IS NULL ORDER BY placed_at DESC').all() as LegalHold[];
}

export function placeHold(ctx: AppContext, input: { scope: LegalHold['scope']; subject_id?: string | null; record_type?: string | null; reason: string }, actorId: string): LegalHold {
  if (!input.reason?.trim()) throw badRequest('A hold needs a reason.');
  if (input.scope === 'user' && !input.subject_id) throw badRequest('A user hold needs the person it covers.');
  if (input.scope === 'record_type' && !input.record_type) throw badRequest('A record-type hold needs the record type it covers.');
  if (input.scope === 'record_type' && !(HOLDABLE_TYPES as readonly string[]).includes(String(input.record_type))) throw badRequest(`A hold cannot name ${input.record_type}: nothing by that name is kept here.`);
  const id = newId(); const at = now();
  ctx.db.prepare(`INSERT INTO legal_holds (id, scope, subject_id, record_type, reason, placed_by, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.scope, input.subject_id ?? null, input.record_type ?? null, input.reason.trim().slice(0, 1000), actorId, at);
  audit(ctx, { actor_id: actorId, action: 'legal_hold_placed', entity: 'legal_holds', entity_id: id, subject_id: input.subject_id ?? null, detail: `${input.scope}: ${input.reason.slice(0, 200)}` });
  return ctx.db.prepare('SELECT * FROM legal_holds WHERE id = ?').get(id) as LegalHold;
}

export function releaseHold(ctx: AppContext, id: string, actorId: string): void {
  const hold = ctx.db.prepare('SELECT * FROM legal_holds WHERE id = ? AND released_at IS NULL').get(id) as LegalHold | undefined;
  if (!hold) throw badRequest('No open hold with that id.');
  ctx.db.prepare('UPDATE legal_holds SET released_by = ?, released_at = ? WHERE id = ?').run(actorId, now(), id);
  audit(ctx, { actor_id: actorId, action: 'legal_hold_released', entity: 'legal_holds', entity_id: id, subject_id: hold.subject_id, detail: hold.reason.slice(0, 200) });
}

export interface DispositionLine {
  record_type: string;
  disposition: Disposition;
  retain_days: number;
  cutoff: string;
  eligible: number;
  held: number;
  acted: number;
  skipped?: string;
}

export function runDisposition(ctx: AppContext, opts: { dryRun: boolean; actorId: string | null; at?: Date }): { lines: DispositionLine[]; blocked: string | null } {
  const at = opts.at ?? new Date();
  const holds = holdState(ctx);
  const stamp = now();

  if (holds.instance) {
    ctx.db.prepare(`INSERT INTO disposition_runs (id, actor_id, dry_run, record_type, disposition, eligible, acted, held, detail, at)
                    VALUES (?, ?, ?, '(all)', 'review', 0, 0, 0, ?, ?)`)
      .run(newId(), opts.actorId, opts.dryRun ? 1 : 0, 'an instance-wide legal hold is open', stamp);
    return { lines: [], blocked: 'An instance-wide legal hold is open. Nothing is disposed of while it stands.' };
  }

  const lines: DispositionLine[] = [];
  for (const schedule of listSchedules(ctx)) {
    if (!schedule.enabled) continue;
    const clock = CLOCK[schedule.record_type];
    if (!clock) continue;
    const cutoff = new Date(at.getTime() - schedule.retain_days * 86_400_000).toISOString().slice(0, 10);

    if (holds.types.has(schedule.record_type)) {
      lines.push({ record_type: schedule.record_type, disposition: schedule.disposition, retain_days: schedule.retain_days, cutoff, eligible: 0, held: 0, acted: 0, skipped: 'a hold covers this record type' });
      continue;
    }

    const heldUsers = [...holds.users];
    const exclusion = heldUsers.length ? ` AND user_id NOT IN (${heldUsers.map(() => '?').join(',')})` : '';
    const params = [cutoff, ...heldUsers];

    const eligible = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${schedule.record_type} WHERE ${clock} IS NOT NULL AND ${clock} < ?${exclusion}`).get(...params) as { n: number }).n;
    const held = heldUsers.length
      ? (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${schedule.record_type} WHERE ${clock} IS NOT NULL AND ${clock} < ? AND user_id IN (${heldUsers.map(() => '?').join(',')})`).get(cutoff, ...heldUsers) as { n: number }).n
      : 0;

    let acted = 0;
    if (!opts.dryRun && schedule.disposition !== 'review' && eligible > 0) {
      ctx.db.transaction(() => {
        if (schedule.disposition === 'destroy') {
          acted = ctx.db.prepare(`DELETE FROM ${schedule.record_type} WHERE ${clock} IS NOT NULL AND ${clock} < ?${exclusion}`).run(...params).changes;
        } else {
          const declared = IDENTIFYING[schedule.record_type] || [];
          const live = new Set((ctx.db.prepare(`PRAGMA table_info(${schedule.record_type})`).all() as Array<{ name: string }>).map((c) => c.name));
          const columns = declared.filter((c) => live.has(c));
          if (columns.length) {
            const sets = columns.map((c) => `${c} = ?`).join(', ');
            acted = ctx.db.prepare(`UPDATE ${schedule.record_type} SET ${sets}, updated_at = ? WHERE ${clock} IS NOT NULL AND ${clock} < ?${exclusion}`)
              .run(...columns.map(() => REDACTED), stamp, ...params).changes;
          }
        }
      })();
    }

    lines.push({ record_type: schedule.record_type, disposition: schedule.disposition, retain_days: schedule.retain_days, cutoff, eligible, held, acted });
    ctx.db.prepare(`INSERT INTO disposition_runs (id, actor_id, dry_run, record_type, disposition, eligible, acted, held, detail, at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), opts.actorId, opts.dryRun ? 1 : 0, schedule.record_type, schedule.disposition, eligible, acted, held, `cutoff ${cutoff}${schedule.authority ? `; ${schedule.authority}` : ''}`, stamp);
  }

  if (!opts.dryRun && lines.some((l) => l.acted > 0)) {
    audit(ctx, { actor_id: opts.actorId, action: 'disposition_run', detail: lines.filter((l) => l.acted).map((l) => `${l.record_type}: ${l.disposition} ${l.acted}`).join('; ') });
  }
  return { lines, blocked: null };
}

export function dispositionHistory(ctx: AppContext, limit = 100) {
  return ctx.db.prepare('SELECT * FROM disposition_runs ORDER BY at DESC LIMIT ?').all(limit);
}
