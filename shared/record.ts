export const CONTRIBUTION_DEFINITIONS = {
  documents_researched: 'Distinct work items on which you recorded research: a question, observation, finding, decision, note, calculation or action. One document counts once however many entries it has.',
  research_actions: 'Every research entry you recorded, including corrections.',
  submitted_actions: 'Actions you recorded as submitted in an authoritative system. Submitted is not approved.',
  verified_outcomes: 'Distinct checks you recorded as verified that still stand: not corrected since, and not overtaken by a later check of the same thing. Each carries the reference you looked at.',
  verification_actions: 'Every verification entry you recorded, including ones later corrected or overtaken. This is what you did, not what currently holds.',
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
