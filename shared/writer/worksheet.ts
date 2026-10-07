import { readEntry, type EntryInput } from './facts.ts';
import { finish, sentenceFor } from './realize.ts';
import { FITREP_AREAS, FITREP_NAMES } from './attributes.ts';
import type { MetricsConfig } from '../constants.ts';

/**
 * The MRO worksheet's blocks beside Section C. The worksheet (MROW, in A-PES) asks for "Major Accomplishments During
 * This Period", which the Section C draft fills, then "PME/Self Education" and "Other (i.e. Awards, Commendatory
 * Correspondence, Community Involvement)". These are those two blocks, from the period's training, awards and the
 * entries the writer routed to them.
 */
export interface WorksheetBlocks { pme: string[]; other: string[] }

const AWARD_STATE: Record<string, string> = { planned: 'planned', recommended: 'recommended', submitted: 'submitted', approved: 'approved', declined: '' };
const TRAINING_STATE: Record<string, string> = { in_progress: 'in progress', scheduled: 'scheduled' };
const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '');

export function worksheetBlocks(input: {
  activities: EntryInput[];
  trainings?: Array<{ title: string; hours?: number | null; status?: string | null }>;
  awards?: Array<{ name: string; status?: string | null }>;
  metrics?: MetricsConfig;
}): WorksheetBlocks {
  const courses = (input.trainings || []).map((t) => {
    const state = TRAINING_STATE[String(t.status)] || '';
    return { title: t.title, line: finish(`${t.title}${t.hours ? `, ${t.hours} hours` : ''}${state ? ` (${state})` : ''}`) };
  });
  const extra: string[] = [];
  const other: string[] = [];
  for (const a of input.awards || []) {
    if (a.status === 'declined') continue;
    const state = AWARD_STATE[String(a.status)] || '';
    other.push(finish(`${a.name}${state ? ` (${state})` : ''}`));
  }
  for (const entry of input.activities) {
    const f = readEntry(entry, { names: FITREP_NAMES, areas: FITREP_AREAS, metrics: input.metrics, track: 'fitrep' });
    if (!f.held?.route) continue;
    const line = sentenceFor(f, 'full', 0, 'bullets');
    if (f.held.route === 'other') { other.push(line); continue; }
    // A course logged both as training and as an entry is listed once, from the entry, which says more.
    const title = String(entry.title || '');
    const course = courses.find((c) => same(c.title, title) || title.toLowerCase().includes(c.title.toLowerCase()));
    if (course) course.line = line;
    else extra.push(line);
  }
  const pme = [...courses.map((c) => c.line), ...extra];
  return { pme, other };
}
