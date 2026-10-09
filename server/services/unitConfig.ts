import type { AppContext, SessionUser } from '../context.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { scoringOverview } from './dutyScoring.ts';
import { getOrg, orgSettings } from './organizations.ts';
import { VERSION } from '../version.ts';
import { PERIOD_OPTIONS, type PeriodKey } from '../../shared/metrics.ts';
import { TRAINING_TYPES } from '../../shared/constants.ts';
import {
  REPORT_PERIODS, STANDARD_DUTY_TYPES, UNIT_CONFIG_FORMAT, UNIT_SETTING_LIMITS, normalizeUnitSettings,
  type Billet, type DutyType, type TrainingRequirement, type TrainingRequirementType, type UnitSettings,
} from '../../shared/unitConfig.ts';

/**
 * A Unit Instance's own configuration (VANTAGE_CLAUDE_MASTER §19, ADR-0012): the billets it staffs, the duty it stands,
 * the training it requires, how long a claim on its work holds, and the period its reports open on. Unit Managers keep
 * it in the Unit Manager console. None of it is a Marine's record, and none of it reaches a sign-in, security or audit
 * setting: those are the enterprise's, and the console shows them read-only (enterpriseControls).
 *
 * Every change names its Unit Instance and is audited in that instance's trail. A row is retired rather than deleted,
 * so what the trail refers to still resolves. A unit a row names is one of the instance's own active units; the
 * database refuses any other (instanceBoundaryTriggers), and this service says so first, without saying where it is.
 */

type Kind = 'billet' | 'duty_type' | 'training_requirement';
const TABLE: Record<Kind, 'unit_billets' | 'duty_types' | 'training_requirements'> = { billet: 'unit_billets', duty_type: 'duty_types', training_requirement: 'training_requirements' };
const LABEL: Record<Kind, string> = { billet: 'billet', duty_type: 'duty type', training_requirement: 'training requirement' };

const isUnique = (e: unknown) => ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes((e as { code?: string } | null)?.code ?? '');
const text = (v: string | null | undefined) => (v == null ? null : v.trim() || null);

/** A unit of this Unit Instance that is still active, or a refusal that does not say whether it exists elsewhere. */
function ownUnit(ctx: AppContext, orgId: string, unitId: string | null | undefined): string | null {
  if (!unitId) return null;
  if (!ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND org_id = ? AND active = 1').get(unitId, orgId)) throw badRequest('No such unit in this Unit Instance.', { fieldErrors: { unit_id: 'Choose one of this Unit Instance’s units.' } });
  return unitId;
}

/**
 * The unit a row names after a change. One it already names stays as it is, even if that unit has since been archived,
 * so a title can still be corrected. A new unit, or a row brought back into use, needs one of the instance's active units.
 */
function nextUnit(ctx: AppContext, orgId: string, input: string | null | undefined, before: { unit_id: string | null; active: number } | null, active: number): string | null {
  const unit = input === undefined ? before?.unit_id ?? null : input || null;
  if (!before || unit !== before.unit_id) return ownUnit(ctx, orgId, unit);
  if (!unit || !active || before.active) return unit;
  if (!ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND org_id = ? AND active = 1').get(unit, orgId)) {
    throw badRequest('Its unit has been archived. Move it to another unit, or to the whole Unit Instance, to bring it back.', { fieldErrors: { unit_id: 'Archived.' } });
  }
  return unit;
}

function rowOf<T>(ctx: AppContext, kind: Kind, orgId: string, id: string): T {
  const row = ctx.db.prepare(`SELECT * FROM ${TABLE[kind]} WHERE id = ? AND org_id = ?`).get(id, orgId) as T | undefined;
  if (!row) throw notFound(`No such ${LABEL[kind]} in this Unit Instance.`);
  return row;
}

/** The changed fields, as "field: before → after", for the audit detail. */
function changes(before: object, after: object): string {
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return Object.keys(a).filter((k) => (b[k] ?? null) !== (a[k] ?? null)).map((k) => `${k}: ${b[k] ?? '—'} → ${a[k] ?? '—'}`).join('; ');
}

const lifecycle = (before: { active: number } | null, after: { active: number }) =>
  !before ? 'created' as const : before.active && !after.active ? 'retired' as const : !before.active && after.active ? 'restored' as const : 'updated' as const;

function record(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, kind: Kind, action: ReturnType<typeof lifecycle>, row: { id: string; unit_id?: string | null }, detail: string, ip?: string) {
  audit(ctx, { actor_id: actor.id, action: `${kind}_${action}`, entity: TABLE[kind], entity_id: row.id, org_id: orgId, unit_id: row.unit_id ?? null, detail, ip });
}

// ——— Billets ———

export interface BilletInput { unit_id?: string | null; title?: string; code?: string | null; description?: string | null; active?: boolean }

export function listBillets(ctx: AppContext, orgId: string): Billet[] {
  return ctx.db.prepare('SELECT * FROM unit_billets WHERE org_id = ? ORDER BY active DESC, title COLLATE NOCASE').all(orgId) as Billet[];
}

export function saveBillet(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, input: BilletInput, id?: string, ip?: string): Billet {
  const before = id ? rowOf<Billet>(ctx, 'billet', orgId, id) : null;
  const title = input.title === undefined ? before?.title : input.title.trim();
  if (!title) throw badRequest('A billet needs a title.', { fieldErrors: { title: 'Required.' } });
  const active = input.active === undefined ? before?.active ?? 1 : input.active ? 1 : 0;
  const next = {
    unit_id: nextUnit(ctx, orgId, input.unit_id, before, active),
    title,
    code: input.code === undefined ? before?.code ?? null : text(input.code),
    description: input.description === undefined ? before?.description ?? null : text(input.description),
    active,
  };
  const at = now();
  const rowId = id ?? newId();
  try {
    if (before) ctx.db.prepare('UPDATE unit_billets SET unit_id = ?, title = ?, code = ?, description = ?, active = ?, updated_at = ? WHERE id = ?').run(next.unit_id, next.title, next.code, next.description, next.active, at, rowId);
    else ctx.db.prepare('INSERT INTO unit_billets (id, org_id, unit_id, title, code, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)').run(rowId, orgId, next.unit_id, next.title, next.code, next.description, actor.id, at, at);
  } catch (e) {
    if (isUnique(e)) throw conflict(`${next.unit_id ? 'That unit' : 'The Unit Instance'} already has a billet called ${next.title}.`, 'duplicate');
    throw e;
  }
  const row = rowOf<Billet>(ctx, 'billet', orgId, rowId);
  record(ctx, actor, orgId, 'billet', lifecycle(before, row), row, before ? changes(before, next) || 'no change' : `${row.title}${row.unit_id ? ` in ${row.unit_id}` : ''}`, ip);
  return row;
}

// ——— Duty types ———

export interface DutyTypeInput { code?: string; name?: string; description?: string | null; active?: boolean }

/** A duty type's code: short, upper case, letters, digits and hyphens, as on a duty roster. */
export const dutyCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

export function listDutyTypes(ctx: AppContext, orgId: string): DutyType[] {
  return ctx.db.prepare('SELECT * FROM duty_types WHERE org_id = ? ORDER BY active DESC, name COLLATE NOCASE').all(orgId) as DutyType[];
}

export function saveDutyType(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, input: DutyTypeInput, id?: string, ip?: string): DutyType {
  const before = id ? rowOf<DutyType>(ctx, 'duty_type', orgId, id) : null;
  const name = input.name === undefined ? before?.name : input.name.trim();
  if (!name) throw badRequest('A duty type needs a name.', { fieldErrors: { name: 'Required.' } });
  const code = input.code === undefined ? before?.code ?? dutyCode(name) : dutyCode(input.code);
  if (!code) throw badRequest('A duty type needs a code of letters or digits.', { fieldErrors: { code: 'Letters, digits and hyphens.' } });
  const next = {
    code, name,
    description: input.description === undefined ? before?.description ?? null : text(input.description),
    active: input.active === undefined ? before?.active ?? 1 : input.active ? 1 : 0,
  };
  const at = now();
  const rowId = id ?? newId();
  try {
    if (before) ctx.db.prepare('UPDATE duty_types SET code = ?, name = ?, description = ?, active = ?, updated_at = ? WHERE id = ?').run(next.code, next.name, next.description, next.active, at, rowId);
    else ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(rowId, orgId, next.code, next.name, next.description, actor.id, at, at);
  } catch (e) {
    if (isUnique(e)) throw conflict(`This Unit Instance already has a duty type with the code ${next.code}. Restore or rename that one.`, 'duplicate');
    throw e;
  }
  const row = rowOf<DutyType>(ctx, 'duty_type', orgId, rowId);
  record(ctx, actor, orgId, 'duty_type', lifecycle(before, row), row, before ? changes(before, next) || 'no change' : `${row.code} ${row.name}`, ip);
  return row;
}

/**
 * The specification's starting list (Task 17), less what the Unit Instance already has by code or by name, retired ones
 * included: a "Barracks Duty" added by hand keeps its own code and is not added again.
 */
export function addStandardDutyTypes(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, ip?: string): { added: string[] } {
  const rows = ctx.db.prepare('SELECT code, name FROM duty_types WHERE org_id = ?').all(orgId) as Array<{ code: string; name: string }>;
  const have = new Set(rows.flatMap((r) => [r.code, `name:${r.name.trim().toLowerCase()}`]));
  const added: string[] = [];
  const at = now();
  ctx.db.transaction(() => {
    for (const d of STANDARD_DUTY_TYPES) {
      if (have.has(d.code) || have.has(`name:${d.name.toLowerCase()}`)) continue;
      ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?)').run(newId(), orgId, d.code, d.name, actor.id, at, at);
      added.push(d.code);
    }
  })();
  if (added.length) audit(ctx, { actor_id: actor.id, action: 'duty_types_standard_added', entity: 'duty_types', org_id: orgId, detail: added.join(', '), ip });
  return { added };
}

// ——— Training requirements ———

export interface TrainingRequirementInput {
  unit_id?: string | null; title?: string; type?: TrainingRequirementType; course_code?: string | null; interval_months?: number | null; description?: string | null; active?: boolean;
}

export function listTrainingRequirements(ctx: AppContext, orgId: string): TrainingRequirement[] {
  return ctx.db.prepare('SELECT * FROM training_requirements WHERE org_id = ? ORDER BY active DESC, title COLLATE NOCASE').all(orgId) as TrainingRequirement[];
}

export function saveTrainingRequirement(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, input: TrainingRequirementInput, id?: string, ip?: string): TrainingRequirement {
  const before = id ? rowOf<TrainingRequirement>(ctx, 'training_requirement', orgId, id) : null;
  const title = input.title === undefined ? before?.title : input.title.trim();
  if (!title) throw badRequest('A training requirement needs a title.', { fieldErrors: { title: 'Required.' } });
  const type = input.type ?? before?.type ?? 'training';
  if (!(TRAINING_TYPES as readonly string[]).includes(type)) throw badRequest('That is not a kind of training Vantage records.', { fieldErrors: { type: 'Choose a kind.' } });
  const interval = input.interval_months === undefined ? before?.interval_months ?? null : input.interval_months;
  if (interval != null && (!Number.isInteger(interval) || interval < 1 || interval > 120)) throw badRequest('Recurs every 1 to 120 months, or once.', { fieldErrors: { interval_months: '1 to 120 months.' } });
  const active = input.active === undefined ? before?.active ?? 1 : input.active ? 1 : 0;
  const next = {
    unit_id: nextUnit(ctx, orgId, input.unit_id, before, active),
    title, type,
    course_code: input.course_code === undefined ? before?.course_code ?? null : text(input.course_code),
    interval_months: interval,
    description: input.description === undefined ? before?.description ?? null : text(input.description),
    active,
  };
  const at = now();
  const rowId = id ?? newId();
  try {
    if (before) {
      ctx.db.prepare('UPDATE training_requirements SET unit_id = ?, title = ?, type = ?, course_code = ?, interval_months = ?, description = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(next.unit_id, next.title, next.type, next.course_code, next.interval_months, next.description, next.active, at, rowId);
    } else {
      ctx.db.prepare('INSERT INTO training_requirements (id, org_id, unit_id, title, type, course_code, interval_months, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .run(rowId, orgId, next.unit_id, next.title, next.type, next.course_code, next.interval_months, next.description, actor.id, at, at);
    }
  } catch (e) {
    if (isUnique(e)) throw conflict(`${next.unit_id ? 'That unit' : 'The Unit Instance'} already requires ${next.title}.`, 'duplicate');
    throw e;
  }
  const row = rowOf<TrainingRequirement>(ctx, 'training_requirement', orgId, rowId);
  record(ctx, actor, orgId, 'training_requirement', lifecycle(before, row), row, before ? changes(before, next) || 'no change' : `${row.title} (${row.type}${row.interval_months ? `, every ${row.interval_months} months` : ''})${row.unit_id ? ` in ${row.unit_id}` : ''}`, ip);
  return row;
}

// ——— Work settings and report defaults ———

export const unitSettingsOf = (ctx: AppContext, orgId: string): UnitSettings => {
  const org = getOrg(ctx, orgId);
  return normalizeUnitSettings(org ? orgSettings(org) : {});
};

export interface UnitSettingsPatch { work?: { claimExpiryHours?: number }; reports?: { defaultPeriod?: PeriodKey } }

/**
 * Change the Unit Instance's work settings and report defaults. A value outside the enterprise limit is refused, not
 * clamped: a Unit Manager who asks for something Vantage does not allow is told so.
 */
export function updateUnitSettings(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, patch: UnitSettingsPatch, ip?: string): UnitSettings {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  const limit = UNIT_SETTING_LIMITS.claimExpiryHours;
  const hours = patch.work?.claimExpiryHours;
  if (hours !== undefined && (!Number.isInteger(hours) || hours < limit.min || hours > limit.max)) {
    throw badRequest(`A claim holds for ${limit.min} to ${limit.max} hours on Vantage.`, { fieldErrors: { claimExpiryHours: `${limit.min} to ${limit.max} hours.` } });
  }
  const period = patch.reports?.defaultPeriod;
  if (period !== undefined && !REPORT_PERIODS.includes(period)) throw badRequest('That is not a report period.', { fieldErrors: { defaultPeriod: 'Choose a period.' } });
  const current = orgSettings(org);
  const before = normalizeUnitSettings(current);
  const after: UnitSettings = {
    work: { claimExpiryHours: hours ?? before.work.claimExpiryHours },
    reports: { defaultPeriod: period ?? before.reports.defaultPeriod },
  };
  const detail = [
    after.work.claimExpiryHours !== before.work.claimExpiryHours && `claim expiry: ${before.work.claimExpiryHours}h → ${after.work.claimExpiryHours}h`,
    after.reports.defaultPeriod !== before.reports.defaultPeriod && `report period: ${before.reports.defaultPeriod} → ${after.reports.defaultPeriod}`,
  ].filter(Boolean).join('; ');
  if (!detail) return after;
  ctx.db.prepare('UPDATE organizations SET settings = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...current, ...after }), now(), orgId);
  audit(ctx, { actor_id: actor.id, action: 'unit_settings_updated', entity: 'organization', entity_id: orgId, org_id: orgId, detail, ip });
  return after;
}

// ——— Everything, for the console ———

export function unitConfiguration(ctx: AppContext, orgId: string) {
  return {
    billets: listBillets(ctx, orgId),
    dutyTypes: listDutyTypes(ctx, orgId),
    trainingRequirements: listTrainingRequirements(ctx, orgId),
    settings: unitSettingsOf(ctx, orgId),
    limits: UNIT_SETTING_LIMITS,
    catalog: { trainingTypes: TRAINING_TYPES, periods: PERIOD_OPTIONS, standardDutyTypes: STANDARD_DUTY_TYPES },
    scoring: scoringOverview(ctx, orgId),
    enterprise: enterpriseControls(ctx),
  };
}

/**
 * What Vantage decides for every Unit Instance, shown to Unit Managers read-only so they know where their settings stop
 * (VANTAGE_CLAUDE_MASTER §19). Configuration only: no secret, no host name, nothing about another Unit Instance.
 */
export function enterpriseControls(ctx: AppContext) {
  const { config, runtime } = ctx;
  return {
    version: VERSION,
    signIn: {
      cac: config.cac.mode !== 'off',
      cacRequired: config.cac.mode !== 'off' && config.cac.exclusive,
      organizationSignIn: config.oidc.enabled,
      passwords: !config.cac.exclusive && !config.oidc.exclusive,
    },
    sessions: { idleMinutes: config.sessions.idleMinutes, consoleIdleMinutes: config.sessions.operatorIdleMinutes, absoluteHours: config.sessions.absoluteHours, reconfirmMinutes: config.sessions.sudoMinutes },
    attachments: { enabled: runtime.attachmentsEnabled, maxMegabytes: Math.round((config.attachments.maxBytes / 1_048_576) * 10) / 10, types: config.attachments.allowedTypes.length },
    audit: { tamperEvident: true, forwarded: Boolean(config.audit.stdout || config.audit.syslog) },
    features: { ai: runtime.aiEnabled && Boolean(config.ai.apiKey), email: ctx.mailer.enabled, maradmins: runtime.maradminsEnabled },
  };
}

// ——— Export and import ———

export interface UnitConfigurationFile {
  format: typeof UNIT_CONFIG_FORMAT;
  generated_at?: string;
  organization?: { id: string; name: string };
  billets: Array<Pick<Billet, 'unit_id' | 'title' | 'code' | 'description'>>;
  dutyTypes: Array<Pick<DutyType, 'code' | 'name' | 'description'>>;
  trainingRequirements: Array<Pick<TrainingRequirement, 'unit_id' | 'title' | 'type' | 'course_code' | 'interval_months' | 'description'>>;
  settings?: Partial<{ work: Partial<UnitSettings['work']>; reports: Partial<UnitSettings['reports']> }>;
}

/** The Unit Instance's configuration as one file: what is in use now, not what was retired. */
export function exportUnitConfiguration(ctx: AppContext, orgId: string): UnitConfigurationFile & { settings: UnitSettings } {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  return {
    format: UNIT_CONFIG_FORMAT,
    generated_at: now(),
    organization: { id: org.id, name: org.name },
    billets: listBillets(ctx, orgId).filter((b) => b.active).map(({ unit_id, title, code, description }) => ({ unit_id, title, code, description })),
    dutyTypes: listDutyTypes(ctx, orgId).filter((d) => d.active).map(({ code, name, description }) => ({ code, name, description })),
    trainingRequirements: listTrainingRequirements(ctx, orgId).filter((t) => t.active).map(({ unit_id, title, type, course_code, interval_months, description }) => ({ unit_id, title, type, course_code, interval_months, description })),
    settings: unitSettingsOf(ctx, orgId),
  };
}

export type ImportOutcome = 'add' | 'restore' | 'exists' | 'skip';
export interface ImportLine { kind: Kind | 'setting'; label: string; outcome: ImportOutcome; reason?: string }
export interface ImportPlan { lines: ImportLine[]; counts: Record<ImportOutcome, number>; settings: UnitSettingsPatch }

const titleKey = (unitId: string | null | undefined, title: string) => `${unitId ?? ''}\u0000${title.trim().toLowerCase()}`;

/**
 * What importing a configuration file would do: add what is missing, restore a retired duty type, change a setting.
 * It never removes or overwrites anything the Unit Instance has. A row naming a unit that is not one of this instance's
 * own is skipped: a file from another Unit Instance brings its catalogue, never a reference into that instance.
 */
export function planConfigurationImport(ctx: AppContext, orgId: string, file: UnitConfigurationFile): ImportPlan {
  const lines: ImportLine[] = [];
  const units = new Set((ctx.db.prepare('SELECT id FROM units WHERE org_id = ? AND active = 1').all(orgId) as Array<{ id: string }>).map((u) => u.id));
  const unitOk = (unitId: string | null | undefined) => !unitId || units.has(unitId);
  const elsewhere = 'names a unit that is not in this Unit Instance';

  const billets = new Set(listBillets(ctx, orgId).filter((b) => b.active).map((b) => titleKey(b.unit_id, b.title)));
  for (const b of file.billets) {
    const label = `${b.title}${b.unit_id ? ` (${b.unit_id})` : ''}`;
    if (!unitOk(b.unit_id)) lines.push({ kind: 'billet', label, outcome: 'skip', reason: elsewhere });
    else if (billets.has(titleKey(b.unit_id, b.title))) lines.push({ kind: 'billet', label, outcome: 'exists' });
    else { billets.add(titleKey(b.unit_id, b.title)); lines.push({ kind: 'billet', label, outcome: 'add' }); }
  }

  const duty = new Map(listDutyTypes(ctx, orgId).map((d) => [d.code, d.active]));
  for (const d of file.dutyTypes) {
    const code = dutyCode(d.code || d.name);
    const label = `${code} ${d.name}`;
    if (!code) lines.push({ kind: 'duty_type', label: d.name, outcome: 'skip', reason: 'has no code' });
    else if (duty.get(code)) lines.push({ kind: 'duty_type', label, outcome: 'exists' });
    else { lines.push({ kind: 'duty_type', label, outcome: duty.has(code) ? 'restore' : 'add' }); duty.set(code, 1); }
  }

  const training = new Set(listTrainingRequirements(ctx, orgId).filter((t) => t.active).map((t) => titleKey(t.unit_id, t.title)));
  for (const t of file.trainingRequirements) {
    const label = `${t.title}${t.unit_id ? ` (${t.unit_id})` : ''}`;
    if (!unitOk(t.unit_id)) lines.push({ kind: 'training_requirement', label, outcome: 'skip', reason: elsewhere });
    else if (training.has(titleKey(t.unit_id, t.title))) lines.push({ kind: 'training_requirement', label, outcome: 'exists' });
    else { training.add(titleKey(t.unit_id, t.title)); lines.push({ kind: 'training_requirement', label, outcome: 'add' }); }
  }

  // A setting the file carries is taken within the enterprise limits, the same as one typed into the console.
  const current = unitSettingsOf(ctx, orgId);
  const wanted = normalizeUnitSettings(file.settings);
  const settings: UnitSettingsPatch = {};
  if (file.settings?.work?.claimExpiryHours !== undefined && wanted.work.claimExpiryHours !== current.work.claimExpiryHours) {
    settings.work = { claimExpiryHours: wanted.work.claimExpiryHours };
    lines.push({ kind: 'setting', label: `Claim expiry ${current.work.claimExpiryHours}h → ${wanted.work.claimExpiryHours}h`, outcome: 'add' });
  }
  if (file.settings?.reports?.defaultPeriod !== undefined && wanted.reports.defaultPeriod !== current.reports.defaultPeriod) {
    settings.reports = { defaultPeriod: wanted.reports.defaultPeriod };
    lines.push({ kind: 'setting', label: `Report period ${current.reports.defaultPeriod} → ${wanted.reports.defaultPeriod}`, outcome: 'add' });
  }

  const counts: Record<ImportOutcome, number> = { add: 0, restore: 0, exists: 0, skip: 0 };
  for (const l of lines) counts[l.outcome] += 1;
  return { lines, counts, settings };
}

/** Apply a configuration file, all of it or none of it, as one entry in the audit trail. */
export function applyConfigurationImport(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, file: UnitConfigurationFile, ip?: string): ImportPlan {
  return ctx.db.transaction(() => {
    const plan = planConfigurationImport(ctx, orgId, file);
    const at = now();
    const units = new Set((ctx.db.prepare('SELECT id FROM units WHERE org_id = ? AND active = 1').all(orgId) as Array<{ id: string }>).map((u) => u.id));
    const unitOk = (unitId: string | null | undefined) => !unitId || units.has(unitId);
    const billet = ctx.db.prepare(`INSERT INTO unit_billets (id, org_id, unit_id, title, code, description, active, created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM unit_billets WHERE org_id = ? AND COALESCE(unit_id, '') = COALESCE(?, '') AND lower(title) = lower(?) AND active = 1)`);
    for (const b of file.billets) {
      if (!unitOk(b.unit_id)) continue;
      billet.run(newId(), orgId, b.unit_id || null, b.title.trim(), text(b.code), text(b.description), actor.id, at, at, orgId, b.unit_id || null, b.title.trim());
    }
    for (const d of file.dutyTypes) {
      const code = dutyCode(d.code || d.name);
      if (!code) continue;
      const have = ctx.db.prepare('SELECT id, active FROM duty_types WHERE org_id = ? AND code = ?').get(orgId, code) as { id: string; active: number } | undefined;
      if (have && !have.active) ctx.db.prepare('UPDATE duty_types SET active = 1, updated_at = ? WHERE id = ?').run(at, have.id);
      else if (!have) ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)').run(newId(), orgId, code, d.name.trim(), text(d.description), actor.id, at, at);
    }
    const requirement = ctx.db.prepare(`INSERT INTO training_requirements (id, org_id, unit_id, title, type, course_code, interval_months, description, active, created_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM training_requirements WHERE org_id = ? AND COALESCE(unit_id, '') = COALESCE(?, '') AND lower(title) = lower(?) AND active = 1)`);
    for (const t of file.trainingRequirements) {
      if (!unitOk(t.unit_id)) continue;
      requirement.run(newId(), orgId, t.unit_id || null, t.title.trim(), t.type, text(t.course_code), t.interval_months ?? null, text(t.description), actor.id, at, at, orgId, t.unit_id || null, t.title.trim());
    }
    if (plan.settings.work || plan.settings.reports) updateUnitSettings(ctx, actor, orgId, plan.settings, ip);
    const { add, restore, exists, skip } = plan.counts;
    // What changed, by name, so the trail says what an import did; the file's own name for where it came from is its claim.
    const changed = plan.lines.filter((l) => l.outcome === 'add' || l.outcome === 'restore').map((l) => `${l.outcome === 'restore' ? 'restored ' : ''}${l.label}`);
    const named = changed.slice(0, 20).join('; ') + (changed.length > 20 ? `; and ${changed.length - 20} more` : '');
    const source = file.organization?.name ? `a file naming ${JSON.stringify(file.organization.name.slice(0, 120))}` : 'a file';
    audit(ctx, { actor_id: actor.id, action: 'unit_configuration_imported', entity: 'organization', entity_id: orgId, org_id: orgId, detail: `from ${source}: ${add} added, ${restore} restored, ${exists} already here, ${skip} skipped${named ? ` (${named})` : ''}`, ip });
    return plan;
  })();
}
