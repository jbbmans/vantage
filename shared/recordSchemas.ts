/** What the Record and Career routes accept from a request, apart from the labels in record.ts that the browser imports. */
import { z } from 'zod';
import { CAREER_CATEGORIES, CAREER_STATUSES } from './record.ts';

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
