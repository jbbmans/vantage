import { z } from 'zod';
import {
  EVAL_AREAS, ACTIVITY_STATUS, WORK_STATUS, PRIORITIES, GOAL_TYPES, GOAL_STATUS, GOAL_METRICS,
  TRAINING_TYPES, TRAINING_STATUS, AWARD_TYPES, AWARD_STATUS, COUNSELING_TYPES, VISIBILITIES, DEGREES, PME_STATUS, MCMAP_BELTS, RIFLE_QUALS, ACCENTS,
} from './constants.ts';
import { passwordProblem } from './password.ts';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUL = '\u0000';

export const isoDate = z.string().regex(ISO_DATE, 'Must be a date (YYYY-MM-DD).').refine((v) => {
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() + 1 === m && t.getUTCDate() === d && y >= 1940 && y <= 2100;
}, 'Not a real calendar date.');

const text = (max: number) => z.string().max(max, `Too long (limit ${max} characters).`).refine((v) => !v.includes(NUL), 'Contains a null byte.');
const optText = (max: number) => text(max).nullish().transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v));
const optDate = isoDate.nullish().or(z.literal('')).transform((v) => (v === undefined ? undefined : v ? v : null));
const optNumber = (lo: number, hi: number, integer = false) =>
  z.union([z.number(), z.string(), z.null()]).optional().transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n)) { ctx.addIssue({ code: 'custom', message: 'Must be a number.' }); return z.NEVER; }
    if (integer && !Number.isInteger(n)) { ctx.addIssue({ code: 'custom', message: 'Must be a whole number.' }); return z.NEVER; }
    if (n < lo) { ctx.addIssue({ code: 'custom', message: `Must be at least ${lo}.` }); return z.NEVER; }
    if (n > hi) { ctx.addIssue({ code: 'custom', message: `Must be at most ${hi}.` }); return z.NEVER; }
    return n;
  });
const optEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).nullish().or(z.literal('')).transform((v) => (v === undefined ? undefined : v ? v : null));

const badScheme = (s: string) => /^\s*(javascript|data|vbscript):/i.test(s);
export const evidenceLink = z.object({
  label: z.string().max(200).nullish(),
  url: z.string().max(500).nullish().refine((u) => !u || !badScheme(u), 'That link scheme is not allowed.'),
});
const evidenceLinks = z.array(evidenceLink).max(20).optional();

export const visibilityField = z.enum(VISIBILITIES).optional();
export const unitIdField = z.string().max(64).nullish();

export const activitySchema = z.object({
  title: text(300).trim().min(1, 'Required.'),
  date: optDate,
  category: optText(80),
  eval_area: z.string().max(80).nullish().or(z.literal('')).transform((v) => (v === undefined ? undefined : v && EVAL_AREAS.includes(v) ? v : v ? 'Unassigned' : null)),
  quantity: optNumber(0, 1_000_000_000),
  unit_label: optText(60),
  dollar_amount: optNumber(0, 1_000_000_000_000),
  dollar_type: optText(40).transform((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v)),
  result: optText(2000),
  organization: optText(200),
  system: optText(120),
  project_id: optText(64),
  status: optEnum(ACTIVITY_STATUS),
  notes: optText(8000),
  evidence_links: evidenceLinks,
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const projectSchema = z.object({
  name: text(200).trim().min(1, 'Required.'),
  description: optText(4000),
  status: optEnum(WORK_STATUS),
  priority: optEnum(PRIORITIES),
  progress: optNumber(0, 100),
  start_date: optDate,
  target_date: optDate,
  organization: optText(200),
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const taskSchema = z.object({
  title: text(300).trim().min(1, 'Required.'),
  notes: optText(4000),
  status: optEnum(WORK_STATUS),
  priority: optEnum(PRIORITIES),
  due_date: optDate,
  project_id: optText(64),
  assignee_id: optText(64),
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const goalSchema = z.object({
  title: text(300).trim().min(1, 'Required.'),
  description: optText(4000),
  type: optEnum(GOAL_TYPES),
  category: optText(80),
  metric: optEnum(GOAL_METRICS),
  current_value: optNumber(-1_000_000_000, 1_000_000_000_000),
  target_value: optNumber(-1_000_000_000, 1_000_000_000_000),
  unit_label: optText(60),
  status: optEnum(GOAL_STATUS),
  period_start: optDate,
  period_end: optDate,
  assignee_id: optText(64),
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const trainingSchema = z.object({
  title: text(300).trim().min(1, 'Required.'),
  date: optDate,
  type: optEnum(TRAINING_TYPES),
  hours: optNumber(0, 10_000),
  provider: optText(200),
  status: optEnum(TRAINING_STATUS),
  notes: optText(4000),
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const awardSchema = z.object({
  name: text(200).trim().min(1, 'Required.'),
  user_id: optText(64),
  date: optDate,
  type: optEnum(AWARD_TYPES),
  status: optEnum(AWARD_STATUS),
  recommending_official: optText(200),
  approving_authority: optText(200),
  citation: optText(6000),
  notes: optText(4000),
  submitted_at: optDate,
  approved_at: optDate,
  presented_at: optDate,
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const counselingSchema = z.object({
  summary: text(6000).trim().min(1, 'Required.'),
  date: optDate,
  type: optEnum(COUNSELING_TYPES),
  user_id: optText(64),
  counselor_name: optText(160),
  strengths: optText(4000),
  improvements: optText(4000),
  goals_set: optText(4000),
  follow_up_date: optDate,
  visibility: visibilityField,
  unit_id: unitIdField,
  version: z.number().int().optional(),
});

export const RECORD_SCHEMAS = {
  activities: activitySchema,
  projects: projectSchema,
  tasks: taskSchema,
  goals: goalSchema,
  trainings: trainingSchema,
  awards: awardSchema,
  counselings: counselingSchema,
} as const;
export type RecordTable = keyof typeof RECORD_SCHEMAS;
export const RECORD_TABLES = Object.keys(RECORD_SCHEMAS) as RecordTable[];

export const readinessSchema = z.object({
  pft_score: optNumber(0, 300, true),
  cft_score: optNumber(0, 300, true),
  rifle_qual: optEnum(RIFLE_QUALS),
  mcmap_belt: optEnum(MCMAP_BELTS),
  ceus: optNumber(0, 10_000),
  college_credits: optNumber(0, 1_000),
  degree: optEnum(DEGREES),
  pme_complete: optEnum(PME_STATUS),
  cmd_character: optNumber(0, 5),
  cmd_mos: optNumber(0, 5),
  cmd_leadership: optNumber(0, 5),
  fitrep_period_end: optDate,
});

export const usernameField = z.string().trim().min(3, '3 to 40 characters.').max(40, '3 to 40 characters.')
  .regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dot, dash and underscore only.').transform((v) => v.toLowerCase());
export const passwordField = z.string().superRefine((v, ctx) => { const p = passwordProblem(v); if (p) ctx.addIssue({ code: 'custom', message: p }); });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const optEmail = z.string().trim().max(254).toLowerCase().nullish().or(z.literal('')).transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (!v) return null;
  if (!EMAIL_RE.test(v)) { ctx.addIssue({ code: 'custom', message: 'Not a valid email.' }); return z.NEVER; }
  return v;
});
export const emailField = z.string().trim().max(254).toLowerCase().refine((v) => EMAIL_RE.test(v), 'Not a valid email.');

export const profileSchema = z.object({
  first_name: text(80).trim().min(1, 'Required.').optional(),
  last_name: text(80).trim().min(1, 'Required.').optional(),
  middle_initial: optText(4),
  rank_id: optText(12),
  mos: optText(12),
  eas: optDate,
  email: optEmail,
});

export const registrationSchema = z.object({
  username: usernameField,
  password: passwordField,
  first_name: text(80).trim().min(1, 'Required.'),
  last_name: text(80).trim().min(1, 'Required.'),
  middle_initial: optText(4),
  rank_id: optText(12),
  mos: optText(12),
  email: optEmail,
});

export const setupSchema = registrationSchema.extend({
  unit_name: text(120).trim().min(1, 'Required.'),
  unit_short_name: optText(40),
  setup_token: z.string().optional(),
});

export const prefsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  accent: z.enum(ACCENTS.map((a) => a.id) as unknown as readonly [string, ...string[]]).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  dashboardPeriod: z.string().max(20).optional(),
  reportPeriod: z.string().max(20).optional(),
  reportView: z.string().max(20).optional(),
  quickLogExpanded: z.boolean().optional(),
  defaultVisibility: z.enum(VISIBILITIES).optional(),
  aiModel: z.string().max(100).optional(),
  dashboardLayout: z.object({ hidden: z.array(z.string()).max(20), order: z.array(z.string()).max(20) }).optional(),
  digest: z.object({ enabled: z.boolean(), weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23) }).optional(),
  onboardingDone: z.boolean().optional(),
});
export type Prefs = z.infer<typeof prefsSchema>;

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.map(String).join('.') : '_';
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
