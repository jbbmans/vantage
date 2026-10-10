import { DEFAULT_PERIOD, PERIOD_OPTIONS, type PeriodKey } from './metrics.ts';
import type { TRAINING_TYPES } from './constants.ts';

/**
 * What a Unit Instance configures for itself (VANTAGE_CLAUDE_MASTER §19, ADR-0012): its billets, duty types, training
 * requirements, work settings and report defaults. Each setting has an enterprise limit Vantage sets for every Unit
 * Instance; a value outside it is refused when saved and clamped when read, so unit configuration never goes past it.
 */

export const UNIT_SETTING_LIMITS = {
  /** How long an untouched claim on a unit's work holds before it is released back to the queue. */
  claimExpiryHours: { min: 4, max: 336, default: 72 },
} as const;

export const REPORT_PERIODS: readonly PeriodKey[] = PERIOD_OPTIONS.map((p) => p.value);

export interface UnitSettings {
  work: { claimExpiryHours: number };
  reports: { defaultPeriod: PeriodKey };
}

export const DEFAULT_UNIT_SETTINGS: UnitSettings = {
  work: { claimExpiryHours: UNIT_SETTING_LIMITS.claimExpiryHours.default },
  reports: { defaultPeriod: DEFAULT_PERIOD },
};

const clamp = (n: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, Math.round(n)));

/** A stored settings object, whatever it holds, as settings within the enterprise limits. */
export function normalizeUnitSettings(raw: unknown): UnitSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { work?: { claimExpiryHours?: unknown }; reports?: { defaultPeriod?: unknown } };
  const hours = Number(value.work?.claimExpiryHours);
  const period = value.reports?.defaultPeriod;
  return {
    work: { claimExpiryHours: value.work?.claimExpiryHours != null && Number.isFinite(hours) ? clamp(hours, UNIT_SETTING_LIMITS.claimExpiryHours) : DEFAULT_UNIT_SETTINGS.work.claimExpiryHours },
    reports: { defaultPeriod: REPORT_PERIODS.includes(period as PeriodKey) ? (period as PeriodKey) : DEFAULT_UNIT_SETTINGS.reports.defaultPeriod },
  };
}

/** The duty types the master specification names (Task 17), offered as a starting list. A Unit Instance keeps its own. */
export const STANDARD_DUTY_TYPES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'DNCO', name: 'DNCO' },
  { code: 'ADNCO', name: 'ADNCO' },
  { code: 'BARRACKS', name: 'Barracks Duty' },
  { code: 'SAF', name: 'SAF' },
  { code: 'COLOR-GUARD', name: 'Color Guard' },
  { code: 'FUNERAL', name: 'Funeral Detail' },
  { code: 'RANGE', name: 'Range Support' },
  { code: 'WORKING-PARTY', name: 'Working Party' },
  { code: 'EVENT', name: 'Event Support' },
  { code: 'COMMAND-DUTY', name: 'Command Duty' },
];

/** Echelons that make a unit a team: what the console lists under Teams. */
export const TEAM_ECHELONS: readonly string[] = ['squad', 'fire_team'];

export type TrainingRequirementType = (typeof TRAINING_TYPES)[number];

export interface Billet { id: string; org_id: string; unit_id: string | null; title: string; code: string | null; description: string | null; active: number; created_at: string; updated_at: string }
export interface DutyType { id: string; org_id: string; code: string; name: string; description: string | null; active: number; created_at: string; updated_at: string }
export interface TrainingRequirement {
  id: string; org_id: string; unit_id: string | null; title: string; type: TrainingRequirementType; course_code: string | null;
  interval_months: number | null; description: string | null; active: number; created_at: string; updated_at: string;
}

/** The file a Unit Instance's configuration exports to, and imports from. */
export const UNIT_CONFIG_FORMAT = 'vantage-unit-configuration/1';
