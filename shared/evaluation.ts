import { startOfDay } from 'date-fns';
import { JEPES_CORE } from './constants.ts';
import { EVAL_REFERENCES } from './evalRefs.ts';
import { readEntry, type EntryInput } from './writer/facts.ts';
import { ATTRIBUTE_PROMPTS, FITREP_NAMES, type Attribute } from './writer/attributes.ts';

export type Track = 'jepes' | 'fitrep';

export const TRACKS: Record<Track, { key: Track; name: string; inputName: string; system: string; order: string; narrativeLimit: number; balanceLabel: string; areaLabel: string; readinessTitle: string }> = {
  jepes: {
    key: 'jepes', name: 'JEPES', inputName: 'JEPES input', system: 'Junior Enlisted Performance Evaluation System',
    order: EVAL_REFERENCES.jepes.citation, narrativeLimit: 1000, balanceLabel: 'JEPES balance', areaLabel: 'JEPES area', readinessTitle: 'JEPES readiness',
  },
  fitrep: {
    key: 'fitrep', name: 'FITREP', inputName: 'FITREP input', system: 'Performance Evaluation System (fitness reports)',
    order: EVAL_REFERENCES.fitrep.citation, narrativeLimit: 1232, balanceLabel: 'Attribute coverage', areaLabel: 'FITREP section', readinessTitle: 'FITREP readiness',
  },
};

export function trackForGrade(grade?: string | null): Track {
  if (!grade) return 'jepes';
  const match = /^E-(\d+)$/.exec(String(grade).trim());
  if (match) return Number(match[1]) <= 4 ? 'jepes' : 'fitrep';
  return 'fitrep';
}

export const trackMeta = (track?: string | null) => TRACKS[(track as Track) || 'jepes'] || TRACKS.jepes;

/** Sections D to H of NAVMC 10835 and the attributes each marks, by the names the form prints. `key` is the area name entries are tagged with. */
export const FITREP_SECTIONS = [
  { key: 'Mission Accomplishment', title: 'Mission Accomplishment', section: 'D', attributes: ['Performance', 'Proficiency'] },
  { key: 'Individual Character', title: 'Individual Character', section: 'E', attributes: ['Courage', 'Effectiveness Under Stress', 'Initiative'] },
  { key: 'Leadership', title: 'Leadership', section: 'F', attributes: ['Leading Subordinates', 'Developing Subordinates', 'Setting the Example', 'Ensuring Well-Being of Subordinates', 'Communication Skills'] },
  { key: 'Intellect and Wisdom', title: 'Intellect and Wisdom', section: 'G', attributes: ['Professional Military Education (PME)', 'Decision Making Ability', 'Judgment'] },
  { key: 'Evaluation Responsibilities', title: 'Fulfillment of Evaluation Responsibilities', section: 'H', attributes: ['Evaluations'] },
] as const;

const FITREP_AREA_KEYS: string[] = FITREP_SECTIONS.map((s) => s.key);

export function areasFor(track: Track): readonly string[] {
  return track === 'fitrep' ? FITREP_AREA_KEYS : JEPES_CORE;
}

export function areaOptions(track: Track): Array<{ value: string; label: string }> {
  if (track === 'fitrep') {
    return [{ value: 'Unassigned', label: 'Unassigned' }, ...FITREP_SECTIONS.map((s) => ({ value: s.key, label: `${s.section}: ${s.key}` }))];
  }
  return [{ value: 'Unassigned', label: 'Unassigned' }, ...JEPES_CORE.map((a) => ({ value: a, label: a }))];
}

/**
 * How each track's input is written. JEPES: accomplishments under the three command input lines, by the names MCO
 * 1616.1 gives them, as Appendix E's dash bullets. The order sets no length; 1,000 keeps it readable. FITREP: billet
 * accomplishments for the MRO worksheet, by section, at Section C's 1,232 characters (NPS FITREP bulletin, 2025).
 */
export function narrativeConfig(track: Track) {
  if (track === 'fitrep') {
    return {
      areas: FITREP_AREA_KEYS,
      labels: { 'Mission Accomplishment': 'MISSION', 'Individual Character': 'CHARACTER', Leadership: 'LEADERSHIP', 'Intellect and Wisdom': 'INTELLECT', 'Evaluation Responsibilities': 'EVALUATIONS' } as Record<string, string>,
      headers: { 'Mission Accomplishment': 'Mission Accomplishment', 'Individual Character': 'Individual Character', Leadership: 'Leadership', 'Intellect and Wisdom': 'Intellect and Wisdom', 'Evaluation Responsibilities': 'Fulfillment of Evaluation Responsibilities' } as Record<string, string>,
      names: FITREP_NAMES,
      fallbackArea: 'Mission Accomplishment',
      // Section C is one list of dash bullets: no headings to spend characters on.
      headings: false,
      limit: TRACKS.fitrep.narrativeLimit,
      track: 'fitrep' as const,
    };
  }
  return {
    areas: [...JEPES_CORE],
    labels: { 'Individual Character': 'CHARACTER', 'MOS / Mission Accomplishment': 'MISSION', Leadership: 'LEADERSHIP' } as Record<string, string>,
    headers: { 'Individual Character': 'Individual Character', 'MOS / Mission Accomplishment': 'MOS and/or Mission Accomplishment', Leadership: 'Leadership' } as Record<string, string>,
    // Courses and PME count toward a JEPES line, not a line of their own; they read as character, the Marine's own effort.
    names: { mission: 'MOS / Mission Accomplishment', leadership: 'Leadership', character: 'Individual Character', intellect: 'Individual Character' },
    fallbackArea: 'MOS / Mission Accomplishment',
    headings: true,
    limit: TRACKS.jepes.narrativeLimit,
    track: 'jepes' as const,
  };
}

const JEPES_TO_FITREP: Record<string, string> = { 'Individual Character': 'Individual Character', 'MOS / Mission Accomplishment': 'Mission Accomplishment', Leadership: 'Leadership' };
const FITREP_TO_JEPES: Record<string, string> = {
  'Mission Accomplishment': 'MOS / Mission Accomplishment', 'Individual Character': 'Individual Character', Leadership: 'Leadership',
  'Intellect and Wisdom': 'MOS / Mission Accomplishment', 'Evaluation Responsibilities': 'Leadership',
};

export function mapAreaToTrack(area: string | null | undefined, track: Track): string {
  if (!area || area === 'Unassigned') return area || 'Unassigned';
  const valid = areasFor(track);
  if (valid.includes(area)) return area;
  const mapped = track === 'fitrep' ? JEPES_TO_FITREP[area] : FITREP_TO_JEPES[area];
  return mapped || 'Unassigned';
}

/**
 * The area an entry counts under in a breakdown over `areas`. An entry keeps the name of the track it was logged
 * under, so a Sgt's "MOS / Mission Accomplishment" (the Quick Log default) is FITREP "Mission Accomplishment".
 */
export function areaAmong(area: string | null | undefined, areas: readonly string[]): string {
  if (area && areas.includes(area)) return area;
  for (const track of ['fitrep', 'jepes'] as const) {
    const mapped = mapAreaToTrack(area, track);
    if (areas.includes(mapped)) return mapped;
  }
  return 'Unassigned';
}

interface EvalActivity extends EntryInput { notes?: string | null }

/**
 * Which attributes each section's evidence reaches, read by the narrative writer (shared/writer/attributes.ts), so
 * Readiness and the Section C draft agree on what an entry shows. An entry counts for every attribute it speaks to;
 * one held back from the input (an award for an earlier period, say) counts for none.
 */
export function fitrepCoverage(activities: EvalActivity[] = []) {
  const cfg = narrativeConfig('fitrep');
  const read = activities.map((a) => ({ a, f: readEntry({ ...a, eval_area: mapAreaToTrack(a.eval_area, 'fitrep') }, { names: cfg.names, areas: cfg.areas, track: 'fitrep' }) }))
    // Routed to another block of the worksheet (PME, community involvement) is still evidence.
    .filter(({ f }) => !f.held || f.held.route);
  return FITREP_SECTIONS.map((section) => {
    const tagged = activities.filter((a) => mapAreaToTrack(a.eval_area, 'fitrep') === section.key);
    const attributes = section.attributes.map((attr) => {
      const hits = read.filter(({ f }) => f.attributes.includes(attr));
      return { attribute: attr, likely: hits.length, examples: hits.slice(0, 2).map(({ a }) => a.title || '') };
    });
    const entries = read.filter(({ f }) => f.attributes.some((a) => (section.attributes as readonly string[]).includes(a))).length;
    return { key: section.key, title: section.title, section: section.section, tagged: tagged.length, entries, attributes, uncovered: attributes.filter((a) => a.likely === 0).map((a) => a.attribute) };
  });
}

export interface Recommendation { id: string; title: string; detail: string; effort: 'trivial' | 'low' | 'medium' | 'high'; category: string; kind: 'data' | 'heuristic' | 'official'; priority: number }
const rec = (o: Partial<Recommendation> & { id: string; title: string; detail: string; priority: number }): Recommendation => ({ effort: 'medium', category: 'FITREP', kind: 'heuristic', ...o });

export function recommendFitrep(profile: Record<string, unknown> = {}, activityStats: { total?: number; withOutcome?: number } = {}, opts: { coverage?: ReturnType<typeof fitrepCoverage>; daysToEnd?: number | null } = {}): Recommendation[] {
  const out: Recommendation[] = [];
  const { total = 0, withOutcome = 0 } = activityStats;
  const coverage = opts.coverage || [];
  const daysToEnd = opts.daysToEnd ?? null;

  if (daysToEnd !== null && daysToEnd <= 45 && daysToEnd >= 0) {
    out.push(rec({ id: 'period-end', kind: 'data', title: `Reporting period ends in ${daysToEnd} day${daysToEnd === 1 ? '' : 's'}`,
      detail: 'Your input reaches your reporting senior on the MRO worksheet (MROW). Copy the Section C draft from Analysis into its major accomplishments block, and the PME and other blocks beside it, before your RS sits down to write. An RS drafting from memory writes a weaker report than one drafting from your input.', effort: 'low', priority: 100 }));
  } else if (daysToEnd === null && profile.fitrep_period_end == null) {
    const annual = annualEnd(String(profile.rank_grade || ''));
    out.push(rec({ id: 'period-unset', kind: annual ? 'official' : 'data', title: 'Set when your reporting period ends',
      detail: `${annual ? `${annual.text} ` : 'Annual reports end on a date MCO 1610.7B, Appendix A, sets by grade; your admin section can confirm yours. '}A change of reporting senior or a transfer ends a period sooner. With the date set, Vantage counts down to it and reminds you on Today.`, effort: 'trivial', priority: 78 }));
  }
  // A section has evidence when anything logged speaks to one of its attributes, tagged there or not. Section H is
  // only marked for a Marine with evaluation duties, so an empty H is a question, not a gap.
  const evidenced = (s: (typeof coverage)[number]) => s.attributes.some((a) => a.likely > 0);
  const empty = coverage.filter((s) => s.section !== 'H' && !evidenced(s));
  if (total === 0 && coverage.length) {
    out.push(rec({ id: 'nothing-logged', kind: 'data', title: 'Nothing logged for this report yet',
      detail: 'Your RS marks fourteen attributes across Sections D to H. Log what you did as it happens, with the count and what came of it, and Vantage shows which attributes it gives evidence for.', effort: 'low', priority: 92 }));
  } else if (empty.length) {
    const list = empty.map((s) => `Section ${s.section}`);
    const named = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    out.push(rec({ id: 'empty-sections', kind: 'data', title: `No evidence yet under ${named}`,
      detail: `${empty.map((s) => `${s.title}: ${s.attributes.map((a) => a.attribute).join(', ')}`).join('. ')}. A section with no evidence gets marked from impression, and impression regresses to the middle.`, effort: 'low', priority: 90 }));
  }
  const h = coverage.find((s) => s.section === 'H');
  if (total > 0 && h && !evidenced(h)) {
    out.push(rec({ id: 'section-H', kind: 'official', title: 'Section H: log the evaluations you were responsible for',
      detail: 'NAVMC 10835 marks “the extent to which this officer serving as a reporting official conducted, or required others to conduct, accurate, uninflated, and timely evaluations.” If you wrote FITREPs as reporting senior or reviewing officer, or conducted your Marines’ evaluations, log how many and whether they were on time. If you served in no such role, there is nothing to log here.', effort: 'trivial', priority: 72 }));
  }
  // Attributes still without evidence in sections that have some: the gaps an RS would notice.
  const thinAttrs = coverage.filter((s) => s.section !== 'H' && evidenced(s)).flatMap((s) => s.uncovered);
  if (total > 0 && thinAttrs.length) {
    const asks = thinAttrs.slice(0, 3).map((a) => `${a}: ${ATTRIBUTE_PROMPTS[a as Attribute]}`);
    out.push(rec({ id: 'thin-attributes', kind: 'data', title: `${thinAttrs.length} attribute${thinAttrs.length === 1 ? ' has' : 's have'} no supporting entry`,
      detail: `Nothing logged gives evidence for ${thinAttrs.join(', ')}. Worth logging, if you did it: ${asks.join('; ')}.`, effort: 'low', priority: 84 }));
  }
  if (total >= 5 && withOutcome / total < 0.7) {
    out.push(rec({ id: 'outcomes', kind: 'data', title: `Only ${Math.round((withOutcome / total) * 100)}% of entries state an outcome`,
      detail: 'Section C lists results, not duties. "Managed the budget" is a billet description; "Closed the fiscal year with zero unresolved ULOs across $4.6M" is an accomplishment your RS can cite.', effort: 'low', priority: 82 }));
  }
  const pme = profile.pme_complete;
  if (pme == null || pme === '') {
    out.push(rec({ id: 'pme-unknown', kind: 'data', title: 'Enter your PME status',
      detail: 'Professional Military Education is one of the attributes in Section G. Enter where you stand for your grade so Vantage can plan around it.', effort: 'trivial', priority: 79 }));
  } else if (pme === 'none') {
    out.push(rec({ id: 'pme', kind: 'official', title: 'Complete or enroll in PME for your grade',
      detail: 'The PME attribute’s baseline on NAVMC 10835 includes having “completed or is enrolled in appropriate level of PME for grade and level of experience.” It also counts nonresident courses, civilian coursework and a personal reading program, so log what you study.', effort: 'high', priority: 80 }));
  } else if (pme === 'distance' && profile.rank_grade === 'E-5') {
    out.push(rec({ id: 'pme-sgt', kind: 'official', title: 'Sergeants: the distance program is part of PME for grade, not all of it',
      detail: 'MARADMIN 630/24: a Sergeant completes the Sergeants School Distance Education Program and either Sergeants School or the Sergeants School Seminar. Check that your record shows both.', effort: 'high', priority: 80 }));
  }
  const pft = Number(profile.pft_score) || 0;
  const cft = Number(profile.cft_score) || 0;
  if (profile.pft_score != null && profile.pft_score !== '' && pft < 250) {
    out.push(rec({ id: 'fitness', title: `PFT ${pft} prints in Section A of the report`,
      detail: 'Section A, item 8 carries your PFT and CFT scores. MCO 1610.7B attaches no point value to them, but a low score is one more thing the rest of the report has to carry. That is coaching, not a policy rule.', effort: 'high', priority: 76 }));
  } else if (profile.cft_score != null && profile.cft_score !== '' && cft < 250) {
    out.push(rec({ id: 'fitness-cft', title: `CFT ${cft} is the weaker of your two recorded scores`, detail: 'Same coaching logic as the PFT. Sprint work and course rehearsal move it fastest.', effort: 'medium', priority: 74 }));
  }
  out.push(rec({ id: 'brief-rs', title: 'Book fifteen minutes with your RS before drafting starts',
    detail: 'The mark that matters is relative to every Marine your RS has ever reported on. The highest-leverage thing you control is what is in front of them when they write: your quantified input, early.', effort: 'trivial', priority: 70 }));
  return out.sort((a, b) => b.priority - a.priority);
}

/**
 * When an active-component annual report ends, for the grades a MARADMIN has confirmed since MCO 1610.7B. Other grades
 * follow Appendix A, which Vantage does not repeat until it is confirmed; the period ends on the month's last day.
 */
const ANNUAL_END: Record<string, { month: number; who: string; cite: string }> = {
  'E-9': { month: 6, who: 'Sergeants Major and Master Gunnery Sergeants', cite: 'MARADMIN 634/23' },
  'O-3': { month: 3, who: 'Captains', cite: 'MARADMIN 634/23' },
  'O-4': { month: 2, who: 'Majors', cite: 'MARADMIN 634/23' },
  'O-5': { month: 2, who: 'Lieutenant Colonels', cite: 'MARADMIN 634/23' },
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The next annual end date for a grade, when it is a confirmed one: the date, and the sentence that says where it is from. */
export function annualEnd(grade: string, now = new Date()): { date: string; text: string } | null {
  const rule = ANNUAL_END[grade];
  if (!rule) return null;
  let year = now.getFullYear();
  const last = (y: number) => new Date(y, rule.month, 0);
  if (last(year) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year += 1;
  const d = last(year);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { date, text: `Annual reports for active-component ${rule.who} end on the last day of ${MONTHS[rule.month - 1]} (${rule.cite}); the next is ${date}.` };
}

/** Calendar days from today to a YYYY-MM-DD where the reader is: 0 on the day itself, whatever the hour. */
export function daysUntil(dateStr?: string | null, now = new Date()): number | null {
  if (!dateStr) return null;
  // new Date('2026-10-31') is UTC midnight, a day early west of Greenwich; read the day as local.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const d = ymd ? new Date(+ymd[1], +ymd[2] - 1, +ymd[3]) : new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  // Round, not ceil: a day across a DST change is 23 or 25 hours.
  return Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
}
