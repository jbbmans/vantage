import type { EntryInput } from '../../shared/writer/facts.ts';
import type { Grade, PartKey } from '../../shared/writer/grade.ts';

/**
 * Fixed examples the one grade is held to (ADR-0045), each worked out by hand from the scale: areas covered 25, outcomes
 * stated 25, numbers 20, strong openings 15, length 15 (full from 60% of the limit, 10 from 35%, 5 for any text that
 * fits). A part shared over sentences is rounded: 1 of 3 areas is 25 / 3 = 8.3, so 8.
 *
 * `edits` change the written text the way a Marine does in the box. A sentence left as written keeps its entry's
 * reading; a sentence typed or changed is read from its words.
 */
export interface GradeExample {
  name: string;
  track: 'jepes' | 'fitrep';
  limit: number;
  entries: EntryInput[];
  score: number;
  grade: Grade;
  parts: Record<PartKey, number>;
  why: string;
  edits?: Array<{ name: string; edit: (text: string) => string; score: number; grade: Grade; parts: Record<PartKey, number>; why: string }>;
}

const C = 'Individual Character';
const M = 'MOS / Mission Accomplishment';
const L = 'Leadership';

const FULL: EntryInput[] = [
  { id: 'u', title: 'Reconciled ULOs in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'all cleared on the next report', eval_area: M },
  { id: 't', title: 'Trained section Marines on DAI requisition amendments', quantity: 5, unit_label: 'Marines', result: 'rework fell from 9 to 2 amendments a month', eval_area: L },
  { id: 'v', title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', result: 'sorted the weekly delivery', eval_area: C },
];

export const GRADE_EXAMPLES: GradeExample[] = [
  {
    name: 'every part full',
    track: 'jepes', limit: 400, entries: FULL,
    score: 100, grade: 'Strong', parts: { coverage: 25, outcomes: 25, measured: 20, verbs: 15, fit: 15 },
    why: 'Three areas of three; each sentence opens with a verb, has a number and states an outcome; 319 of 400 characters is over 60%.',
    edits: [
      {
        name: 'Edit text pressed, nothing changed',
        edit: (t) => t,
        score: 100, grade: 'Strong', parts: { coverage: 25, outcomes: 25, measured: 20, verbs: 15, fit: 15 },
        why: 'Every sentence is the one the writer wrote, so each keeps its entry’s reading.',
      },
      {
        name: 'numbered, a heading typed another way, a title on top and a bullet wrapped by hand',
        edit: (t) => `Billet accomplishments\n${t}`
          .replace('MOS and/or Mission Accomplishment', 'Mission Accomplishment:')
          .split('\n').map((line, i) => line.replace(/^-/, `${i}. `)).join('\n')
          .replace('; all cleared', ';\nall cleared'),
        score: 100, grade: 'Strong', parts: { coverage: 25, outcomes: 25, measured: 20, verbs: 15, fit: 15 },
        why: 'Every sentence still stands as written: a list marker, a heading named another way, a title line and a line break inside a sentence change nothing it says.',
      },
      {
        name: 'the lines put in another order',
        edit: (t) => t.split('\n').reverse().join('\n'),
        score: 92, grade: 'Strong', parts: { coverage: 17, outcomes: 25, measured: 20, verbs: 15, fit: 15 },
        why: 'Reversed, each bullet sits under the heading of the next area: the food pantry under MOS, the ULOs under Leadership, and the training line under none, so it keeps its entry’s Leadership. The text covers 2 of 3 areas: 16.7, so 17.',
      },
      {
        name: 'one outcome cut',
        edit: (t) => t.replace('; all cleared on the next report', ''),
        score: 92, grade: 'Strong', parts: { coverage: 25, outcomes: 17, measured: 20, verbs: 15, fit: 15 },
        why: 'The changed sentence is read from its words: a verb and a number, no outcome. Outcomes 2 of 3 is 16.7, so 17; 287 of 400 characters is still over 60%.',
      },
      {
        name: 'a sentence typed in the first person',
        edit: (t) => `${t}\n-I helped with several ULOs.`,
        score: 85, grade: 'Strong', parts: { coverage: 25, outcomes: 19, measured: 15, verbs: 11, fit: 15 },
        why: 'The typed sentence opens with "I", has no number ("several") and no outcome: 3 of 4 on each, so 18.75 (19), 15 and 11.25 (11).',
      },
      {
        name: 'the text typed over',
        edit: () => 'MISSION: Reconciled 14 ULOs in DAI; all cleared.',
        score: 73, grade: 'Solid', parts: { coverage: 8, outcomes: 25, measured: 20, verbs: 15, fit: 5 },
        why: 'One typed sentence under the MISSION label covers 1 of 3 areas (8); 48 of 400 characters fits but is under 35% (5).',
      },
    ],
  },
  {
    name: 'no outcomes',
    track: 'jepes', limit: 400,
    entries: FULL.map(({ result: _result, ...e }) => e),
    score: 70, grade: 'Solid', parts: { coverage: 25, outcomes: 0, measured: 20, verbs: 15, fit: 10 },
    why: 'Nothing in Result, so no sentence states an outcome; 214 of 400 characters is between 35% and 60%.',
  },
  {
    name: 'one area and a weak opening',
    track: 'jepes', limit: 1000,
    entries: [
      { id: 'u', title: 'Reconciled ULOs in DAI', quantity: 14, unit_label: 'ULOs', result: 'all cleared on the next report', eval_area: M },
      { id: 'h', title: 'Helped the S-4 inventory the warehouse', quantity: 120, unit_label: 'items', result: 'all accounted for', eval_area: M },
    ],
    score: 66, grade: 'Needs work', parts: { coverage: 8, outcomes: 25, measured: 20, verbs: 8, fit: 5 },
    why: '1 of 3 areas is 8.3 (8); "Helped" does not say what was done, so openings are 1 of 2, 7.5 (8); 165 of 1,000 characters is under 35%.',
  },
  {
    name: 'FITREP, three sections of four',
    track: 'fitrep', limit: 1232,
    entries: [
      { id: 'm', title: 'Processed MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', dollar_amount: 240000, dollar_type: 'obligated', result: 'zero returned for correction', eval_area: 'Mission Accomplishment' },
      { id: 'l', title: 'Mentored junior Marines on the DTS approval chain', quantity: 4, unit_label: 'Marines', eval_area: 'Leadership' },
      { id: 'c', title: 'Volunteered at the base food pantry', result: 'sorted the weekly delivery', eval_area: 'Individual Character' },
    ],
    score: 69, grade: 'Needs work', parts: { coverage: 19, outcomes: 17, measured: 13, verbs: 15, fit: 5 },
    why: 'Evaluation duty is not expected without any, so 3 of 4 sections (18.75, 19); outcomes and numbers 2 of 3 (16.7 and 13.3); a short text.',
  },
];
