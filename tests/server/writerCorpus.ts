import type { EntryInput } from '../../shared/writer/facts.ts';
import { LEADER_SEED, PERSONAL_SEED, SHARED_SEED } from '../../server/services/demo.ts';

/**
 * Entries the writer is held to, shared by the writer tests and the bullet checks: the writer's own corpus, the
 * entries the narrative browser spec logs, and the demo seed. Each is exactly what a Marine could type.
 */
const MISSION = 'MOS / Mission Accomplishment';

export type CorpusEntry = EntryInput & { id: string };

export const WRITER_CORPUS: CorpusEntry[] = [
  { id: 'a1', title: 'Cleared 4 2-Way UMTs on the Q4 report', quantity: 4, unit_label: 'UMTs', dollar_amount: 6206.4, dollar_type: 'reconciled', result: 'Each verified cleared on the next report', eval_area: MISSION, date: '2026-09-28' },
  { id: 'a2', title: 'Reconciled 14 ULOs totaling $48,250 in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'all cleared on the next report', system: 'DAI', eval_area: MISSION, date: '2026-09-30' },
  { id: 'a3', title: 'Reconciled 9 ULOs in SABRS', quantity: 9, unit_label: 'ULOs', dollar_amount: 12100, dollar_type: 'reconciled', eval_area: MISSION, date: '2026-08-12' },
  { id: 'a4', title: 'I processed 40 MIPRs for the G-8', quantity: 40, unit_label: 'MIPRs', dollar_amount: 1200000, dollar_type: 'obligated', result: 'zero returned for correction', date: '2026-07-20' },
  { id: 'a5', title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', result: 'Sorted and shelved the weekly delivery', eval_area: 'Individual Character', date: '2026-09-25' },
  { id: 'a6', title: 'Led section PT: 10 km hike', quantity: 10, unit_label: 'km', result: 'Planned the route and the water points for eight Marines', eval_area: 'Leadership', date: '2026-09-11' },
  { id: 'a7', title: 'Training 3 junior marines on DAI requisitions', quantity: 3, unit_label: 'Marines', result: 'all three now process requisitions without review', date: '2026-08-30', category: 'Leadership' },
  { id: 'a8', title: 'Reconciled 22 ULOs in DAI', quantity: 22, unit_label: 'ULOs', dollar_amount: 30400, dollar_type: 'reconciled', eval_area: MISSION, date: '2026-07-02' },
  { id: 'a9', title: 'Helped the section with the end of year close out', date: '2026-09-29' },
  { id: 'a10', title: 'Built a UMT tracker in Excel', result: 'cut the weekly review from 3 hours to 1 hour', date: '2026-08-05' },
];

/** What tests/browser/31-narrative.spec.ts logs before it opens the studio. */
export const NARRATIVE_SPEC_ENTRIES: CorpusEntry[] = [
  { id: 's1', title: 'Reconciled 31 ULOs in DAI', quantity: 31, unit_label: 'ULOs', dollar_amount: 77000, dollar_type: 'reconciled', result: 'all cleared on the next report', eval_area: MISSION },
  { id: 's2', title: 'Processing 18 MIPRs for G-8', quantity: 18, unit_label: 'MIPRs', dollar_amount: 240000, dollar_type: 'obligated', result: 'zero returned for correction', eval_area: MISSION },
  { id: 's3', title: 'Trained 4 junior Marines on requisitions', quantity: 4, unit_label: 'Marines', result: 'all four now reconcile unaided', eval_area: 'Leadership' },
  { id: 's4', title: 'Volunteered 10 hours coaching base little league', quantity: 10, unit_label: 'hours', result: 'team finished the season', eval_area: 'Individual Character' },
  { id: 's5', title: 'Completed annual Cyber Awareness training', eval_area: 'Individual Character' },
];

/** The demo workspace's entries, as the seed writes them. */
export const DEMO_ENTRIES: CorpusEntry[] = [
  ...PERSONAL_SEED.map(([, title, category, quantity, unit_label, result], i) => ({ id: `p${i}`, title, category, quantity, unit_label, result })),
  ...LEADER_SEED.map(([, title, category, area, quantity, unit_label, dollar_amount, dollar_type, result], i) => ({ id: `l${i}`, title, category, eval_area: area ?? undefined, quantity, unit_label, dollar_amount, dollar_type, result })),
  ...SHARED_SEED.map(([, , title, quantity, unit_label, dollar_amount, dollar_type, result], i) => ({ id: `d${i}`, title, category: 'Fiscal & Financial', quantity, unit_label, dollar_amount, dollar_type, result })),
];
