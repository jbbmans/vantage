/**
 * The kinds of draft and what each is called (ADR-0030). They are apart from shared/drafts.ts, which holds the schemas
 * the server checks a saved form with, so a page that only names a kind, as Today does, does not load the schema library.
 */

/** Every kind the Drafts page lists, in the order its filters show them. */
export const DRAFT_KINDS = ['counseling', 'report', 'goal', 'award', 'training', 'personnel_change', 'task', 'correspondence', 'entry'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

export const DRAFT_KIND_LABELS: Record<DraftKind, { one: string; many: string }> = {
  counseling: { one: 'Counseling', many: 'Counselings' },
  report: { one: 'Report', many: 'Reports' },
  goal: { one: 'Goal', many: 'Goals' },
  award: { one: 'Award', many: 'Awards' },
  training: { one: 'Training entry', many: 'Training entries' },
  personnel_change: { one: 'Personnel change', many: 'Personnel changes' },
  task: { one: 'Task', many: 'Tasks' },
  correspondence: { one: 'Correspondence', many: 'Correspondence' },
  entry: { one: 'Entry from work', many: 'Entries from work' },
};
