import { z } from 'zod';

/**
 * Definitions for what the Record counts. Shown beside every figure, because a count without its
 * definition is a number people argue about instead of a fact they can check.
 */
export const CONTRIBUTION_DEFINITIONS = {
  documents_researched: 'Distinct work items on which you recorded research: a question, observation, finding, decision, note, calculation or action. One document counts once however many entries it has.',
  research_actions: 'Every research entry you recorded, including corrections.',
  submitted_actions: 'Actions you recorded as submitted in an authoritative system. Submitted is not approved.',
  verified_outcomes: 'Distinct checks you recorded as verified, each with the reference you looked at.',
  resolved_work: 'Distinct work items you resolved.',
  handoffs: 'Work you handed to somebody else, with a note saying why.',
} as const;

export const WORKLOAD_LIMITATIONS = [
  'Counts show what was recorded in Vantage during the window. Work done outside Vantage, or not yet recorded, does not appear.',
  'Zero recorded activity is not evidence of zero work.',
  'Counts do not measure effort, difficulty or quality. Compare them with assigned workload, case type, and time spent waiting.',
  'Individual totals can add up to more than the section total, because several Marines can research the same document.',
  'Waiting time is elapsed time on the calendar. It is not active work and is never added to it.',
] as const;

export const CAREER_CATEGORIES = ['pme', 'military', 'certification', 'education', 'skill', 'civilian', 'evaluation'] as const;
export const CAREER_CATEGORY_LABEL: Record<(typeof CAREER_CATEGORIES)[number], string> = {
  pme: 'PME', military: 'Military progression', certification: 'Certification', education: 'Education',
  skill: 'Professional skill', civilian: 'Civilian career', evaluation: 'JEPES / FITREP preparation',
};
export const CAREER_STATUSES = ['planned', 'in_progress', 'done', 'dropped'] as const;

const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const optDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').nullish().or(z.literal('')).transform((v) => (v ? v : null));
const safeUrl = z.string().trim().max(500).nullish().transform((v) => (v ? v : null))
  .refine((v) => !v || /^https?:\/\//i.test(v), 'Links must start with http:// or https://.');

export const careerStepSchema = z.object({
  title: z.string().trim().min(1, 'Required.').max(200),
  category: z.enum(CAREER_CATEGORIES).default('military'),
  status: z.enum(CAREER_STATUSES).default('planned'),
  due_date: optDate,
  notes: opt(2000),
  source_label: opt(200),
  source_url: safeUrl,
  source_checked_on: optDate,
  version: z.number().int().optional(),
});

export const careerProfileSchema = z.object({
  military_goal: opt(500),
  civilian_interests: opt(1000),
});

export const draftUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  wording: z.string().max(4000).optional(),
  version: z.number().int().optional(),
});
