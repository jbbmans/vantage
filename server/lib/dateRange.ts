import { z } from 'zod';
import { badRequest } from './errors.ts';
import { CUSTOM_PERIOD, PERIOD_CHOICES, rangeProblems, type PeriodChoice } from '../../shared/dateRange.ts';

/**
 * The one check on a range a request names (ADR-0038), for every endpoint that reads records by days. The fields
 * stay plain text in each endpoint's schema so a bad day reaches checkRange, which names the field in the 400.
 */
export const rangeDay = z.string().max(200).optional();
export const rangeFields = { from: rangeDay, to: rangeDay };

/** A period a request may name, custom dates included. */
export const periodField = z.enum(PERIOD_CHOICES as [PeriodChoice, ...PeriodChoice[]], { error: 'Choose one of the periods offered.' });

export interface CheckedRange { from: string; to: string }

/**
 * The range in a request, or null when it names none. Both days or neither; with `period=custom`, both. A 400 carries
 * `fieldErrors.from` or `fieldErrors.to`, and the message the picker shows.
 */
export function checkRange(q: { from?: unknown; to?: unknown; period?: unknown }): CheckedRange | null {
  const problem = rangeProblems(q.from, q.to, { required: q.period === CUSTOM_PERIOD });
  if (problem) throw badRequest(problem.message, { fieldErrors: problem.fieldErrors });
  return typeof q.from === 'string' && q.from && typeof q.to === 'string' && q.to ? { from: q.from, to: q.to } : null;
}
