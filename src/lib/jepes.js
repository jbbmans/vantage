export const PILLARS = [
  { key: 'warfighting', label: 'Warfighting', composition: 'Rifle (ARQ) percentile + MCMAP belt', hint: 'Rifle qualification and MCMAP belt.' },
  { key: 'physical', label: 'Physical Toughness', composition: 'PFT + CFT percentiles vs. your grade', hint: 'PFT and CFT scores.' },
  { key: 'mental', label: 'Mental Agility', composition: 'MarineNet CEUs, education, MOS quals', hint: 'MarineNet, formal PME, off-duty education, MOS quals.' },
  { key: 'command', label: 'Command Input', composition: 'Three marks 0.0–5.0 from your chain', hint: 'Three marks from your chain of command.' },
];

export const MCMAP_BELTS = ['Tan', 'Grey', 'Green', 'Brown', 'Black 1st', 'Black 2nd', 'Black 3rd'];

export const RIFLE_QUALS = ['Unqualified', 'Marksman', 'Sharpshooter', 'Expert'];

export const ARQ_BANDS = [
  { qual: 'Expert', band: '43–50 destroys, plus one iteration of all three drills' },
  { qual: 'Sharpshooter', band: '31–42 destroys, plus two drill types' },
  { qual: 'Marksman', band: '15–30 destroys, plus any one drill type' },
];

export function fitnessClass(score) {
  if (score === null || score === undefined || score === '') return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 235) return '1st class';
  if (n >= 200) return '2nd class';
  if (n >= 150) return '3rd class';
  return 'below 3rd class';
}

const isCorporal = (grade) => grade === 'E-4';
const entered = (v) => !(v === null || v === undefined || v === '');

const item = (key, label, value, state, note) => ({ key, label, value, state, ...(note ? { note } : {}) });

export function estimate(profile = {}) {
  const grade = profile.rank_grade || 'E-4';
  const cpl = isCorporal(grade);

  const rifleState = { Expert: 'top', Sharpshooter: 'solid', Marksman: 'attention', Unqualified: 'attention' };
  const beltIdx = MCMAP_BELTS.indexOf(profile.mcmap_belt);
  const beltState = beltIdx >= 3 ? 'top' : beltIdx === 2 ? 'solid' : 'attention';

  const fitItem = (key, label, raw) => {
    if (!entered(raw)) return item(key, label, null, 'missing');
    const cls = fitnessClass(raw);
    const state = Number(raw) >= 285 ? 'top' : cls === '1st class' ? 'solid' : 'attention';
    return item(key, label, `${raw} · ${cls}`, state, 'Enters JEPES as a percentile vs. your grade — MOL holds the points.');
  };

  const markItem = (key, label, raw) => {
    if (!entered(raw)) return item(key, label, null, 'missing');
    const n = Number(raw);
    const state = n >= 4 ? 'top' : n >= 3 ? 'solid' : 'attention';
    return item(key, label, n.toFixed(1), state);
  };

  const pillars = {
    warfighting: {
      items: [
        entered(profile.rifle_qual)
          ? item('rifle', 'Rifle (ARQ)', profile.rifle_qual, rifleState[profile.rifle_qual] || 'attention',
              'ARQ classifies by destroys and drills; JEPES uses your percentile.')
          : item('rifle', 'Rifle (ARQ)', null, 'missing'),
        entered(profile.mcmap_belt)
          ? item('belt', 'MCMAP belt', profile.mcmap_belt, beltState)
          : item('belt', 'MCMAP belt', null, 'missing'),
      ],
    },
    physical: {
      items: [fitItem('pft', 'PFT', profile.pft_score), fitItem('cft', 'CFT', profile.cft_score)],
    },
    mental: {
      items: [
        entered(profile.ceus)
          ? item('ceus', 'MarineNet CEUs', String(profile.ceus), Number(profile.ceus) >= 30 ? 'solid' : 'attention')
          : item('ceus', 'MarineNet CEUs', null, 'missing'),
        (entered(profile.college_credits) || profile.degree)
          ? item('education', 'Off-duty education',
              profile.degree ? (profile.degree === 'bachelor' ? 'Bachelor’s degree' : 'Associate degree')
                : `${profile.college_credits} credits`,
              profile.degree ? 'top' : 'solid')
          : item('education', 'Off-duty education', null, 'missing'),
        entered(profile.pme_complete) && profile.pme_complete !== ''
          ? item('pme', 'PME for grade', profile.pme_complete === 'resident' ? 'Resident' : 'Distance',
              profile.pme_complete === 'resident' ? 'top' : 'solid')
          : item('pme', 'PME for grade', null, 'missing'),
        item('mosquals', 'MOS qualifications', 'See the MOL / MCTIMS table', 'external',
          'Point values come from the JEPES MOS Quals table (MARADMIN 046/24). Vantage never estimates them.'),
      ],
    },
    command: {
      items: [
        markItem('cmd_character', 'Individual Character', profile.cmd_character),
        markItem('cmd_mos', 'MOS / Mission', profile.cmd_mos),
        markItem('cmd_leadership', 'Leadership', profile.cmd_leadership),
      ],
    },
  };

  for (const p of Object.values(pillars)) {
    const real = p.items.filter((i) => i.state !== 'external');
    p.enteredCount = real.filter((i) => i.state !== 'missing').length;
    p.itemCount = real.length;
    p.known = p.enteredCount > 0;
    p.complete = p.enteredCount === real.length;
  }

  const knownCount = Object.values(pillars).filter((p) => p.known).length;

  return {
    grade,
    isCorporal: cpl,
    pillars,
    known: Object.fromEntries(Object.entries(pillars).map(([k, p]) => [k, p.known])),
    missing: PILLARS.filter((p) => !pillars[p.key].known).map((p) => p.key),
    completeness: knownCount / PILLARS.length,
  };
}

const rec = (o) => ({ effort: 'medium', category: 'General', kind: 'heuristic', ...o });

export function recommend(profile = {}, activityStats = {}) {
  const est = estimate(profile);
  const out = [];

  for (const key of est.missing) {
    const pillar = PILLARS.find((p) => p.key === key);
    out.push(rec({
      id: `missing-${key}`,
      title: `Enter your ${pillar.label.toLowerCase()} figures`,
      detail: `Vantage cannot show where ${pillar.label} stands without them, and neither can you plan around it. ${pillar.hint}`,
      kind: 'data',
      effort: 'trivial',
      category: 'Data',
      priority: 95,
    }));
  }

  const belt = profile.mcmap_belt;
  if (belt && belt !== 'Black 3rd') {
    const idx = MCMAP_BELTS.indexOf(belt);
    const next = MCMAP_BELTS[idx + 1];
    out.push(rec({
      id: 'mcmap',
      title: `Advance to ${next} belt`,
      detail:
        'A unit-run belt course is a few weeks of training you are largely doing anyway, costs nothing, and never '
        + 'expires. In Vantage’s experience this is usually the cheapest ground on the board — the per-belt point '
        + 'values live in MCO 1616.1’s tables on MOL.',
      effort: idx >= 3 ? 'high' : 'low',
      category: 'Warfighting',
      priority: 90 - idx * 5,
    }));
  }

  const rifleQual = profile.rifle_qual;
  if (rifleQual && rifleQual !== 'Expert') {
    out.push(rec({
      id: 'rifle',
      title: 'Shoot Expert at your next range',
      detail:
        'Rifle enters JEPES as a percentile against peers in your grade, so moving up a classification moves you past '
        + 'a large part of the field. Expert is 43–50 destroys plus all three drills (MCO 3574.2M). One range week a '
        + 'year, and it carries until you requalify.',
      effort: RIFLE_QUALS.indexOf(rifleQual) <= 1 ? 'high' : 'medium',
      category: 'Warfighting',
      priority: 85,
    }));
  }

  const pftScore = Number(profile.pft_score) || 0;
  const cftScore = Number(profile.cft_score) || 0;
  if (entered(profile.pft_score) && pftScore < 300) {
    out.push(rec({
      id: 'pft',
      title: pftScore < 235 ? 'Get the PFT to a first class' : 'Push the PFT toward 300',
      detail:
        `You are at ${pftScore} (${fitnessClass(pftScore)}). JEPES converts it against peers in your grade, so ground `
        + 'at the top of the scale is contested ground. The run is almost always the binding constraint, not the pull-ups.',
      effort: pftScore < 235 ? 'high' : 'medium',
      category: 'Physical',
      priority: 80,
    }));
  }
  if (entered(profile.cft_score) && cftScore < 300) {
    out.push(rec({
      id: 'cft',
      title: 'Train the CFT specifically',
      detail:
        `You are at ${cftScore} (${fitnessClass(cftScore)}). Movement-to-contact and maneuver-under-fire are anaerobic `
        + 'and skill-dependent — they respond to sprint intervals and rehearsing the course, not to more time under '
        + 'the bar. The CFT is the more commonly neglected of the two.',
      effort: 'medium',
      category: 'Physical',
      priority: 82,
    }));
  }

  if (profile.bulking && pftScore && pftScore < 290) {
    out.push(rec({
      id: 'bulk-conflict',
      title: 'Your bulk and your run score are pulling against each other',
      detail:
        'Added bodyweight costs you on the three-mile and on maneuver-under-fire, and both are scored against peers. '
        + 'If you are gaining, hold two hard runs a week the whole way through, or plan the gain for after your next PFT.',
      effort: 'low',
      category: 'Physical',
      priority: 70,
    }));
  }

  if (entered(profile.ceus) && Number(profile.ceus) < 60) {
    out.push(rec({
      id: 'ceus',
      title: `Add MarineNet CEUs — you have ${Number(profile.ceus) || 'none recorded'}`,
      detail:
        'Informal PME is CEU-weighted by course length (MARADMIN 025/21), so a handful of long courses beats a pile '
        + 'of short ones. This is the one lever that costs nothing but evenings.',
      effort: 'low',
      category: 'Mental',
      priority: 88,
    }));
  }
  if (est.known.mental && !profile.degree && (Number(profile.college_credits) || 0) < 60) {
    out.push(rec({
      id: 'credits',
      title: 'Log your off-duty education credits',
      detail:
        'Off-duty education counts toward Mental Agility, and credits you have already earned count whether or not '
        + 'the degree is finished. Make sure they are on your record, not just on a transcript.',
      kind: 'data',
      effort: 'trivial',
      category: 'Mental',
      priority: 78,
    }));
  }
  if (est.known.mental && profile.pme_complete !== 'resident') {
    out.push(rec({
      id: 'pme',
      title: 'Complete the resident PME for your grade',
      detail:
        'Resident PME sits above the distance equivalent in the Mental Agility tables, and grade-appropriate PME is '
        + 'tracked separately for promotion eligibility — confirm the current requirement with your career planner. '
        + 'Ask what seats your command has.',
      effort: 'high',
      category: 'Mental',
      priority: 72,
    }));
  }
  out.push(rec({
    id: 'mos-quals',
    title: 'Check the JEPES MOS Qualification table for your MOS',
    detail:
      'MOS Courses and Qualifications are part of Mental Agility (MARADMIN 046/24), reported through MCTIMS, and '
      + 'their point values change. Vantage will not estimate them — read the current table on MOL and log the '
      + 'qualifications you complete here as trainings.',
    kind: 'official',
    effort: 'trivial',
    category: 'Mental',
    priority: 87,
  }));

  const marks = [profile.cmd_character, profile.cmd_mos, profile.cmd_leadership].filter((m) => entered(m));
  if (marks.length) {
    const weakest = [
      { key: 'cmd_character', label: 'Individual Character', value: Number(profile.cmd_character) },
      { key: 'cmd_mos', label: 'MOS / Mission Accomplishment', value: Number(profile.cmd_mos) },
      { key: 'cmd_leadership', label: 'Leadership', value: Number(profile.cmd_leadership) },
    ]
      .filter((m) => !Number.isNaN(m.value))
      .sort((a, b) => a.value - b.value)[0];

    if (weakest && weakest.value < 4.0) {
      out.push(rec({
        id: 'command-input',
        title: `${weakest.label} is your weakest command mark at ${weakest.value.toFixed(1)}`,
        detail:
          'Command input is a quarter of the score and the only part someone else controls. Under JEPES a Marine who '
          + 'meets expectations centers around 2.0–3.0, so a mark above that is earned, not given. Marks move when a '
          + 'reporting senior has specific, quantified accomplishments in front of them — take your bullet package to '
          + 'your next counselling rather than arriving empty-handed.',
        effort: 'medium',
        category: 'Command',
        priority: 86,
      }));
    }
  }

  const { total = 0, withOutcome = 0, thinAreas = [] } = activityStats;
  if (total >= 5 && withOutcome / total < 0.6) {
    out.push(rec({
      id: 'outcomes',
      title: `Only ${Math.round((withOutcome / total) * 100)}% of your logged entries state an outcome`,
      detail:
        'An entry without a result is a task you did, not an accomplishment. Those are the ones that get cut from a '
        + 'package, and they are the reason a command mark comes back lower than the work deserved.',
      kind: 'data',
      effort: 'low',
      category: 'Command',
      priority: 76,
    }));
  }
  for (const area of thinAreas) {
    out.push(rec({
      id: `thin-${area}`,
      title: `Nothing logged under ${area}`,
      detail:
        'Command input is marked across all three areas separately. An empty area is marked as an empty area, however '
        + 'strong the other two are.',
      kind: 'data',
      effort: 'low',
      category: 'Command',
      priority: 74,
    }));
  }

  return out.sort((a, b) => b.priority - a.priority);
}

export function biggestLever(profile = {}) {
  const est = estimate(profile);
  const gaps = PILLARS
    .map((p) => ({
      ...p,
      gaps: est.pillars[p.key].items.filter((i) => i.state === 'missing' || i.state === 'attention').length,
    }))
    .sort((a, b) => b.gaps - a.gaps);
  return gaps[0]?.gaps ? gaps[0] : null;
}

export const EFFORT_ORDER = { trivial: 0, low: 1, medium: 2, high: 3 };
