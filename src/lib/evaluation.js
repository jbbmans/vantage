import { JEPES_CORE } from './constants.js';
import { EVAL_REFERENCES } from './evalRefs.js';

export const TRACKS = {
  jepes: {
    key: 'jepes',
    name: 'JEPES',
    inputName: 'JEPES input',
    system: 'Junior Enlisted Performance Evaluation System',
    order: EVAL_REFERENCES.jepes.citation,
    narrativeLimit: 1000,
    balanceLabel: 'JEPES balance',
    areaLabel: 'JEPES area',
    readinessTitle: 'JEPES readiness',
  },
  fitrep: {
    key: 'fitrep',
    name: 'FITREP',
    inputName: 'FITREP input',
    system: 'Performance Evaluation System (fitness reports)',
    order: EVAL_REFERENCES.fitrep.citation,

    narrativeLimit: 2000,
    balanceLabel: 'Attribute coverage',
    areaLabel: 'FITREP section',
    readinessTitle: 'FITREP readiness',
  },
};

export function trackForGrade(grade) {
  if (!grade) return 'jepes';
  const match = /^E-(\d+)$/.exec(String(grade).trim());
  if (match) return Number(match[1]) <= 4 ? 'jepes' : 'fitrep';
  return 'fitrep';
}

export const trackMeta = (track) => TRACKS[track] || TRACKS.jepes;
export const trackForPerson = (person = {}) =>
  trackForGrade(person.rank_grade || person.rank?.grade || person.grade);

export const FITREP_SECTIONS = [
  {
    key: 'Mission Accomplishment',
    section: 'D',
    attributes: ['Performance', 'Proficiency'],
  },
  {
    key: 'Individual Character',
    section: 'E',
    attributes: ['Courage', 'Effectiveness Under Stress', 'Initiative'],
  },
  {
    key: 'Leadership',
    section: 'F',
    attributes: [
      'Leading Subordinates',
      'Developing Subordinates',
      'Setting the Example',
      'Ensuring Well-being of Subordinates',
      'Communication Skills',
    ],
  },
  {
    key: 'Intellect and Wisdom',
    section: 'G',
    attributes: ['Professional Military Education', 'Decision Making Ability', 'Judgment'],
  },
  {
    key: 'Evaluation Responsibilities',
    section: 'H',
    attributes: ['Evaluations'],
  },
];

const FITREP_AREA_KEYS = FITREP_SECTIONS.map((s) => s.key);

export function areasFor(track) {
  return track === 'fitrep' ? FITREP_AREA_KEYS : JEPES_CORE;
}

export function areaOptions(track) {
  if (track === 'fitrep') {
    return [
      { value: 'Unassigned', label: 'Unassigned' },
      ...FITREP_SECTIONS.map((s) => ({ value: s.key, label: `${s.section} — ${s.key}` })),
    ];
  }
  return [
    { value: 'Unassigned', label: 'Unassigned' },
    ...JEPES_CORE.map((a) => ({ value: a, label: a })),
  ];
}

export function narrativeConfig(track) {
  if (track === 'fitrep') {
    return {
      areas: FITREP_AREA_KEYS,
      labels: {
        'Mission Accomplishment': 'MISSION',
        'Individual Character': 'CHARACTER',
        Leadership: 'LEADERSHIP',
        'Intellect and Wisdom': 'INTELLECT',
        'Evaluation Responsibilities': 'EVALUATIONS',
      },
      fallbackArea: 'Mission Accomplishment',
      limit: TRACKS.fitrep.narrativeLimit,
    };
  }
  return {
    areas: JEPES_CORE,
    labels: {
      'Individual Character': 'CHARACTER',
      'MOS / Mission Accomplishment': 'MISSION',
      Leadership: 'LEADERSHIP',
    },
    fallbackArea: 'MOS / Mission Accomplishment',
    limit: TRACKS.jepes.narrativeLimit,
  };
}

const JEPES_TO_FITREP = {
  'Individual Character': 'Individual Character',
  'MOS / Mission Accomplishment': 'Mission Accomplishment',
  Leadership: 'Leadership',
};
const FITREP_TO_JEPES = {
  'Mission Accomplishment': 'MOS / Mission Accomplishment',
  'Individual Character': 'Individual Character',
  Leadership: 'Leadership',
  'Intellect and Wisdom': 'MOS / Mission Accomplishment',
  'Evaluation Responsibilities': 'Leadership',
};

export function mapAreaToTrack(area, track) {
  if (!area || area === 'Unassigned') return area || 'Unassigned';
  const valid = areasFor(track);
  if (valid.includes(area)) return area;
  const mapped = track === 'fitrep' ? JEPES_TO_FITREP[area] : FITREP_TO_JEPES[area];
  return mapped || 'Unassigned';
}

const ATTRIBUTE_HINTS = {
  Performance: ['completed', 'processed', 'executed', 'delivered', 'produced', 'closed'],
  Proficiency: ['certified', 'qualified', 'expert', 'reconciled', 'audit', 'system', 'technical'],
  Courage: ['stood', 'reported', 'confronted', 'raised', 'intervened'],
  'Effectiveness Under Stress': ['no-notice', 'short notice', 'deadline', 'surge', 'crisis', 'incident', 'response'],
  Initiative: ['built', 'created', 'designed', 'proposed', 'volunteered', 'unprompted', 'identified'],
  'Leading Subordinates': ['led', 'supervised', 'directed', 'ran', 'managed'],
  'Developing Subordinates': ['mentored', 'trained', 'taught', 'coached', 'developed', 'counseled'],
  'Setting the Example': ['color guard', 'ceremony', 'uniform', 'standard', 'example', 'first to'],
  'Ensuring Well-being of Subordinates': ['welfare', 'well-being', 'checked on', 'barracks', 'family', 'support'],
  'Communication Skills': ['briefed', 'presented', 'wrote', 'drafted', 'authored', 'published', 'spoke'],
  'Professional Military Education': ['pme', 'marinenet', 'course', 'seminar', 'college', 'degree', 'certification'],
  'Decision Making Ability': ['decided', 'prioritized', 'selected', 'triaged', 'allocated'],
  Judgment: ['assessed', 'evaluated', 'weighed', 'recommended', 'advised'],
  Evaluations: ['jepes', 'fitrep', 'evaluation', 'counseling', 'marked', 'proficiency and conduct'],
};

export function fitrepCoverage(activities = []) {
  return FITREP_SECTIONS.map((section) => {
    const tagged = activities.filter((a) => mapAreaToTrack(a.jepes_area, 'fitrep') === section.key);
    const attributes = section.attributes.map((attr) => {
      const needles = ATTRIBUTE_HINTS[attr] || [];
      const hits = activities.filter((a) => {
        const text = `${a.title || ''} ${a.result || ''} ${a.notes || ''}`.toLowerCase();
        return needles.some((n) => text.includes(n));
      });
      return { attribute: attr, likely: hits.length, examples: hits.slice(0, 2).map((a) => a.title) };
    });
    return {
      ...section,
      tagged: tagged.length,
      attributes,
      uncovered: attributes.filter((a) => a.likely === 0).map((a) => a.attribute),
    };
  });
}

const rec = (o) => ({ effort: 'medium', category: 'FITREP', kind: 'heuristic', ...o });

export function recommendFitrep(profile = {}, activityStats = {}, opts = {}) {
  const out = [];
  const { total = 0, withOutcome = 0 } = activityStats;
  const coverage = opts.coverage || [];
  const daysToEnd = opts.daysToEnd ?? null;

  if (daysToEnd !== null && daysToEnd <= 45 && daysToEnd >= 0) {
    out.push(rec({
      id: 'period-end',
      kind: 'data',
      title: `Reporting period ends in ${daysToEnd} day${daysToEnd === 1 ? '' : 's'}`,
      detail:
        'Get your input to your Reporting Senior before they sit down to write, not after. An RS drafting from memory '
        + 'writes a weaker report than one drafting from your package — print the FITREP input from Reports and hand it over.',
      effort: 'low',
      priority: 100,
    }));
  }

  const empty = coverage.filter((s) => s.tagged === 0);
  for (const section of empty) {

    const names = section.attributes.map((a) => a.attribute || a);
    out.push(rec({
      id: `section-${section.section}`,
      kind: 'data',
      title: `Nothing tagged under Section ${section.section} — ${section.key}`,
      detail:
        `Your RS marks ${names.length === 1 ? 'an attribute' : `${names.length} attributes`} `
        + `here (${names.join(', ')}). A section with no evidence gets marked from impression, and `
        + 'impression regresses to the middle.',
      effort: 'low',
      priority: 90,
    }));
  }

  const thinAttrs = coverage.flatMap((s) => s.uncovered.map((a) => ({ section: s.section, attr: a })));
  if (thinAttrs.length && thinAttrs.length <= 6) {
    out.push(rec({
      id: 'thin-attributes',
      kind: 'data',
      title: `${thinAttrs.length} of 14 attributes have no obvious supporting entry`,
      detail:
        `Nothing logged plausibly evidences: ${thinAttrs.map((t) => t.attr).join(', ')}. Some of these you are doing `
        + 'and not writing down — mentoring and welfare checks are the classic unlogged work. Log them.',
      effort: 'low',
      priority: 84,
    }));
  }

  if (total >= 5 && withOutcome / total < 0.7) {
    out.push(rec({
      id: 'outcomes',
      kind: 'data',
      title: `Only ${Math.round((withOutcome / total) * 100)}% of entries state an outcome`,
      detail:
        'Section I runs on results, not activity. "Managed the budget" is a billet description; "closed the fiscal '
        + 'year with zero unresolved ULOs across $4.6M" is a sentence an RS can defend to a Reviewing Officer.',
      effort: 'low',
      priority: 82,
    }));
  }

  if (profile.pme_complete !== 'resident') {
    out.push(rec({
      id: 'pme',
      title: 'Complete resident PME for your grade',
      detail:
        'PME is one of the fourteen attributes your RS marks (Section G, MCO 1610.7B) — the order sets no cap tied '
        + 'to it, but an incomplete-for-grade mark is a hard thing for a narrative to carry, and resident completion '
        + 'is tracked separately for promotion eligibility. Confirm the current requirement with your career planner.',
      effort: 'high',
      priority: 80,
    }));
  }

  const pft = Number(profile.pft_score) || 0;
  const cft = Number(profile.cft_score) || 0;
  if (profile.pft_score != null && pft < 250) {
    out.push(rec({
      id: 'fitness',
      title: `PFT ${pft} will be on the front page of the report`,
      detail:
        'Fitness scores print on the report, but MCO 1610.7B attaches no point value or cap to them — what boards '
        + 'read is your RS\'s relative-value profile. A low score is one more thing the narrative has to carry. '
        + 'That judgement is Vantage\'s coaching view, not a policy rule.',
      effort: 'high',
      priority: 76,
    }));
  } else if (profile.cft_score != null && cft < 250) {
    out.push(rec({
      id: 'fitness-cft',
      title: `CFT ${cft} is the weaker of your two recorded scores`,
      detail: 'Same coaching logic as the PFT: it rides on the report without a point value. Sprint work and course rehearsal move it fastest.',
      effort: 'medium',
      priority: 74,
    }));
  }

  out.push(rec({
    id: 'brief-rs',
    title: 'Book fifteen minutes with your RS before drafting starts',
    detail:
      'The mark that matters is relative to every Marine your RS has ever reported on. The single highest-leverage '
      + 'thing you control is what is in front of them when they write: your quantified input, on paper, early.',
    effort: 'trivial',
    priority: 70,
  }));

  return out.sort((a, b) => b.priority - a.priority);
}

export function daysUntil(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - now.getTime()) / 86_400_000);
}
