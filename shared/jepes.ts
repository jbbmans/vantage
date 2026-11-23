import { MCMAP_BELTS, RIFLE_QUALS } from './constants.ts';
import type { Recommendation } from './evaluation.ts';

export const PILLARS = [
  { key: 'warfighting', label: 'Warfighting', composition: 'Rifle (ARQ) percentile + MCMAP belt', hint: 'Rifle qualification and MCMAP belt.' },
  { key: 'physical', label: 'Physical Toughness', composition: 'PFT + CFT percentiles vs. your grade', hint: 'PFT and CFT scores.' },
  { key: 'mental', label: 'Mental Agility', composition: 'MarineNet CEUs, education, MOS quals', hint: 'MarineNet, formal PME, off-duty education, MOS quals.' },
  { key: 'command', label: 'Command Input', composition: 'Three marks 0.0 to 5.0 from your chain', hint: 'Three marks from your chain of command.' },
] as const;
export type PillarKey = (typeof PILLARS)[number]['key'];

export const ARQ_BANDS = [
  { qual: 'Expert', band: '43 to 50 destroys, plus one iteration of all three drills' },
  { qual: 'Sharpshooter', band: '31 to 42 destroys, plus two drill types' },
  { qual: 'Marksman', band: '15 to 30 destroys, plus any one drill type' },
];

export function fitnessClass(score: unknown): string | null {
  if (score === null || score === undefined || String(score).trim() === '') return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 235) return '1st class';
  if (n >= 200) return '2nd class';
  if (n >= 150) return '3rd class';
  return 'below 3rd class';
}

/** A value the Marine entered: blank, missing or spaces only is not one. */
const entered = (v: unknown) => !(v === null || v === undefined || String(v).trim() === '');
export type ItemState = 'top' | 'solid' | 'attention' | 'missing' | 'external';
export interface PillarItem { key: string; label: string; value: string | null; state: ItemState; note?: string }
const item = (key: string, label: string, value: string | null, state: ItemState, note?: string): PillarItem => ({ key, label, value, state, ...(note ? { note } : {}) });

export interface Estimate {
  grade: string; pillars: Record<PillarKey, { items: PillarItem[]; enteredCount: number; itemCount: number; known: boolean; complete: boolean }>;
  known: Record<string, boolean>; missing: PillarKey[]; completeness: number;
}

export function estimate(profile: Record<string, unknown> = {}): Estimate {
  const grade = String(profile.rank_grade || 'E-4');
  const rifleState: Record<string, ItemState> = { Expert: 'top', Sharpshooter: 'solid', Marksman: 'attention', Unqualified: 'attention' };
  const beltIdx = MCMAP_BELTS.indexOf(profile.mcmap_belt as never);
  const beltState: ItemState = beltIdx >= 3 ? 'top' : beltIdx === 2 ? 'solid' : 'attention';
  const fitItem = (key: string, label: string, raw: unknown) => {
    if (!entered(raw)) return item(key, label, null, 'missing');
    const cls = fitnessClass(raw);
    const state: ItemState = Number(raw) >= 285 ? 'top' : cls === '1st class' ? 'solid' : 'attention';
    return item(key, label, `${raw} · ${cls}`, state, 'Enters JEPES as a percentile vs. your grade; MOL holds the points.');
  };
  const markItem = (key: string, label: string, raw: unknown) => {
    const n = Number(raw);
    if (!entered(raw) || !Number.isFinite(n)) return item(key, label, null, 'missing');
    return item(key, label, n.toFixed(1), n >= 4 ? 'top' : n >= 3 ? 'solid' : 'attention');
  };
  const build = (items: PillarItem[]) => {
    const real = items.filter((i) => i.state !== 'external');
    const enteredCount = real.filter((i) => i.state !== 'missing').length;
    return { items, enteredCount, itemCount: real.length, known: enteredCount > 0, complete: enteredCount === real.length };
  };
  const pillars = {
    warfighting: build([
      entered(profile.rifle_qual)
        ? item('rifle', 'Rifle (ARQ)', String(profile.rifle_qual), rifleState[String(profile.rifle_qual)] || 'attention', 'ARQ classifies by destroys and drills; JEPES uses your percentile.')
        : item('rifle', 'Rifle (ARQ)', null, 'missing'),
      entered(profile.mcmap_belt) ? item('belt', 'MCMAP belt', String(profile.mcmap_belt), beltState) : item('belt', 'MCMAP belt', null, 'missing'),
    ]),
    physical: build([fitItem('pft', 'PFT', profile.pft_score), fitItem('cft', 'CFT', profile.cft_score)]),
    mental: build([
      entered(profile.ceus) ? item('ceus', 'MarineNet CEUs', String(profile.ceus), Number(profile.ceus) >= 30 ? 'solid' : 'attention') : item('ceus', 'MarineNet CEUs', null, 'missing'),
      entered(profile.college_credits) || profile.degree
        ? item('education', 'Off-duty education', profile.degree ? `${String(profile.degree).charAt(0).toUpperCase()}${String(profile.degree).slice(1)} degree` : `${profile.college_credits} credits`, profile.degree ? 'top' : 'solid')
        : item('education', 'Off-duty education', null, 'missing'),
      // "None" is an answer: the Marine has no PME for grade yet, which is not the same as not saying.
      profile.pme_complete === 'resident' ? item('pme', 'PME for grade', 'Resident', 'top')
        : profile.pme_complete === 'distance' ? item('pme', 'PME for grade', 'Distance', 'solid')
        : profile.pme_complete === 'none' ? item('pme', 'PME for grade', 'None', 'attention')
        : item('pme', 'PME for grade', null, 'missing'),
      item('mosquals', 'MOS qualifications', 'See the MOL / MCTIMS table', 'external', 'Point values come from the JEPES MOS Quals table (MARADMIN 046/24). Vantage never estimates them.'),
    ]),
    command: build([
      markItem('cmd_character', 'Individual Character', profile.cmd_character),
      markItem('cmd_mos', 'MOS / Mission', profile.cmd_mos),
      markItem('cmd_leadership', 'Leadership', profile.cmd_leadership),
    ]),
  };
  const knownCount = Object.values(pillars).filter((p) => p.known).length;
  return {
    grade, pillars,
    known: Object.fromEntries(Object.entries(pillars).map(([k, p]) => [k, p.known])),
    missing: PILLARS.filter((p) => !pillars[p.key].known).map((p) => p.key),
    completeness: knownCount / PILLARS.length,
  };
}

const rec = (o: Partial<Recommendation> & { id: string; title: string; detail: string; priority: number }): Recommendation => ({ effort: 'medium', category: 'General', kind: 'heuristic', ...o });

export function recommend(profile: Record<string, unknown> = {}, activityStats: { total?: number; withOutcome?: number; thinAreas?: string[] } = {}): Recommendation[] {
  const est = estimate(profile);
  const out: Recommendation[] = [];
  for (const key of est.missing) {
    const pillar = PILLARS.find((p) => p.key === key)!;
    out.push(rec({ id: `missing-${key}`, title: `Enter your ${pillar.label.toLowerCase()} figures`, detail: `Vantage cannot show where ${pillar.label} stands without them, and neither can you plan around it. ${pillar.hint}`, kind: 'data', effort: 'trivial', category: 'Data', priority: 95 }));
  }
  const belt = profile.mcmap_belt as string | undefined;
  if (belt && belt !== 'Black 3rd') {
    const idx = MCMAP_BELTS.indexOf(belt as never);
    const next = MCMAP_BELTS[idx + 1];
    out.push(rec({ id: 'mcmap', title: `Advance to ${next} belt`, detail: 'A unit-run belt course is a few weeks of training you are largely doing anyway, costs nothing, and never expires. This is usually the cheapest ground on the board; per-belt point values live in MCO 1616.1 on MOL.', effort: idx >= 3 ? 'high' : 'low', category: 'Warfighting', priority: 90 - idx * 5 }));
  }
  const rifleQual = profile.rifle_qual as string | undefined;
  if (rifleQual && rifleQual !== 'Expert') {
    out.push(rec({ id: 'rifle', title: 'Shoot Expert at your next range', detail: 'Rifle enters JEPES as a percentile against peers in your grade, so moving up a classification moves you past a large part of the field. Expert is 43 to 50 destroys plus all three drills (MCO 3574.2M).', effort: RIFLE_QUALS.indexOf(rifleQual as never) <= 1 ? 'high' : 'medium', category: 'Warfighting', priority: 85 }));
  }
  const pftScore = Number(profile.pft_score) || 0;
  const cftScore = Number(profile.cft_score) || 0;
  if (entered(profile.pft_score) && pftScore < 300) {
    out.push(rec({ id: 'pft', title: pftScore < 235 ? 'Get the PFT to a first class' : 'Push the PFT toward 300', detail: `You are at ${pftScore} (${fitnessClass(pftScore)}). JEPES converts it against peers in your grade, so ground at the top of the scale is contested ground. The run is almost always the binding constraint.`, effort: pftScore < 235 ? 'high' : 'medium', category: 'Physical', priority: 80 }));
  }
  if (entered(profile.cft_score) && cftScore < 300) {
    out.push(rec({ id: 'cft', title: 'Train the CFT specifically', detail: `You are at ${cftScore} (${fitnessClass(cftScore)}). Movement-to-contact and maneuver-under-fire respond to sprint intervals and rehearsing the course, not to more time under the bar.`, effort: 'medium', category: 'Physical', priority: 82 }));
  }
  if (entered(profile.ceus) && Number(profile.ceus) < 60) {
    out.push(rec({ id: 'ceus', title: `Add MarineNet CEUs; you have ${Number(profile.ceus) || 'none recorded'}`, detail: 'Informal PME is CEU-weighted by course length (MARADMIN 025/21), so a handful of long courses beats a pile of short ones. This lever costs nothing but evenings.', effort: 'low', category: 'Mental', priority: 88 }));
  }
  if (est.known.mental && !profile.degree && (Number(profile.college_credits) || 0) < 60) {
    out.push(rec({ id: 'credits', title: 'Log your off-duty education credits', detail: 'Credits you have already earned count whether or not the degree is finished. Make sure they are on your record, not just on a transcript.', kind: 'data', effort: 'trivial', category: 'Mental', priority: 78 }));
  }
  if (profile.pme_complete === 'none') {
    out.push(rec({ id: 'pme', title: 'Complete the PME for your grade', detail: 'PME for grade counts toward Mental Agility and is tracked separately for promotion eligibility. Finish the distance program for your grade, or enroll in it, and ask what resident seats your command has.', effort: 'high', category: 'Mental', priority: 72 }));
  } else if (profile.pme_complete === 'distance') {
    out.push(rec({ id: 'pme', title: 'Complete the resident PME for your grade', detail: 'Resident PME sits above the distance equivalent in the Mental Agility tables, and grade-appropriate PME is tracked separately for promotion eligibility. Ask what seats your command has.', effort: 'high', category: 'Mental', priority: 72 }));
  } else if (est.known.mental && profile.pme_complete !== 'resident') {
    out.push(rec({ id: 'pme-unknown', title: 'Enter your PME status', detail: 'Vantage cannot say what PME to plan for until it knows where you stand for your grade: none yet, distance or resident.', kind: 'data', effort: 'trivial', category: 'Data', priority: 72 }));
  }
  out.push(rec({ id: 'mos-quals', title: 'Check the JEPES MOS Qualification table for your MOS', detail: 'MOS Courses and Qualifications are part of Mental Agility (MARADMIN 046/24), reported through MCTIMS, and their point values change. Read the current table on MOL and log completed qualifications here as training.', kind: 'official', effort: 'trivial', category: 'Mental', priority: 87 }));
  // Only the marks entered are compared: a blank mark is not a 0.0.
  const weakest = [
    { label: 'Individual Character', raw: profile.cmd_character },
    { label: 'MOS / Mission Accomplishment', raw: profile.cmd_mos },
    { label: 'Leadership', raw: profile.cmd_leadership },
  ].filter((m) => entered(m.raw)).map((m) => ({ label: m.label, value: Number(m.raw) })).filter((m) => Number.isFinite(m.value)).sort((a, b) => a.value - b.value)[0];
  if (weakest && weakest.value < 4.0) {
    out.push(rec({ id: 'command-input', title: `${weakest.label} is your weakest command mark at ${weakest.value.toFixed(1)}`, detail: 'Marks move when a reporting senior has specific, quantified accomplishments in front of them: take your bullet package to your next counseling.', effort: 'medium', category: 'Command', priority: 86 }));
  }
  const { total = 0, withOutcome = 0, thinAreas = [] } = activityStats;
  if (total >= 5 && withOutcome / total < 0.6) {
    out.push(rec({ id: 'outcomes', title: `Only ${Math.round((withOutcome / total) * 100)}% of your logged entries state an outcome`, detail: 'An entry without a result is a task you did, not an accomplishment. Those are the ones that get cut from a package.', kind: 'data', effort: 'low', category: 'Command', priority: 76 }));
  }
  for (const area of thinAreas) {
    out.push(rec({ id: `thin-${area}`, title: `Nothing logged under ${area}`, detail: 'Command input is marked across all three areas separately. An empty area is marked as an empty area, however strong the other two are.', kind: 'data', effort: 'low', category: 'Command', priority: 74 }));
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export const EFFORT_ORDER: Record<string, number> = { trivial: 0, low: 1, medium: 2, high: 3 };
