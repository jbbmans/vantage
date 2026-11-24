import { versioned, type Citation } from './versioned.ts';

/**
 * How the Performance Evaluation System turns a fitness report into its Fitness Report Average and Relative Value
 * (ADR-0047), as a versioned table (ADR-0046): a change is a new version with its own date and source, never an edit,
 * and the version's fingerprint is pinned in tests/server/fitrepStanding.test.ts.
 *
 * The order is MCO 1610.7B (5 Jun 2023). Its Chapter 8 was not readable where these rules were gathered, so each rule
 * cites the Marine Corps' own instruction (The Basic School's handouts, an MMOA-4 brief) and the CNA studies that quote
 * the PES Manual, and the notes say what they leave open.
 */

export const MCO_1610_7B: Citation = {
  source: 'MCO 1610.7B (5 Jun 2023)', where: 'Chapter 8, the reporting senior profile and relative value',
  url: 'https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/1513503/mco-16107b/',
};
const MCO_1610_7A: Citation = {
  source: 'MCO 1610.7A (1 May 2018)', where: 'Chapter 3, paragraph 4.h.(3): EN reports generate no relative value',
  url: 'https://www.marines.mil/Portals/1/Publications/MCO%201610.7A.pdf',
};
const TBS_W3G0001XQ: Citation = {
  source: 'The Basic School, W3G0001XQ Fitness Reports I', where: 'p. 6: the RV of 100, 90 and 80; three reports per grade',
  url: 'https://www.trngcmd.marines.mil/Portals/207/Docs/TBS/W3G0001XQ%20Fitness%20Reports%20I.pdf',
};
const TBS_B3K3738: Citation = {
  source: 'The Basic School, B3K3738 Fitness Reports', where: 'p. 5: the profile is one RS and one rank',
  url: 'https://www.trngcmd.marines.mil/Portals/207/Docs/TBS/B3K3738%20Fitness%20Report.pdf',
};
const MMOA_4: Citation = {
  source: 'MMOA-4 Career Counseling Brief, Performance Evaluation System', where: '"Calculating the FitRep Average" and "Items to be Aware of"',
  url: 'https://archive.org/download/mipc-manpower_usmc_mil/manpower.usmc.mil_2Y46J5GXQUMSSBM44ZPTJABL7ZQGQZRU.pdf',
};
const CNA_2012: Citation = {
  source: 'CNA DRM-2012-U-001003-Final, An Evaluation of the Fitness Report System for Marine Officers', where: 'p. 7 and p. 8, footnote 5',
  url: 'https://apps.dtic.mil/sti/tr/pdf/AD1014581.pdf',
};
const CNA_2024: Citation = {
  source: 'CNA DOP-2023-U-037367-Final, Stop Using Relative Values (Jan 2024)', where: 'pp. 3 to 8, footnotes 6, 7 and 13, Figure 1; p. 8 quotes the PES Manual, p. 8-6',
  url: 'https://www.cna.org/reports/2024/01/Stop-Using-Relative-Values-They-Dont-Work-As-Advertised.pdf',
};

/** The occasion codes a report is written on, as Section A prints them. */
export const OCCASIONS = ['AN', 'CH', 'TR', 'CD', 'GC', 'DC', 'TD', 'FD', 'EN', 'CS', 'SA', 'RT'] as const;
export type Occasion = (typeof OCCASIONS)[number];
export const OCCASION_NAMES: Record<Occasion, string> = {
  AN: 'Annual', CH: 'Change of reporting senior', TR: 'Transfer', CD: 'Change in duty', GC: 'Grade change', DC: 'Directed by the Commandant',
  TD: 'To temporary duty', FD: 'From temporary duty', EN: 'End of service', CS: 'Change in status', SA: 'Semiannual', RT: 'Reserve training',
};

/** What kind of report it is. Only an observed report is marked against the profile. */
export const REPORT_TYPES = ['observed', 'not_observed', 'extended', 'academic'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_TYPE_NAMES: Record<ReportType, string> = { observed: 'Observed', not_observed: 'Not observed', extended: 'Extended', academic: 'Academic' };

/** The fourteen attributes of Sections D to H, in the order the form and the Master Brief Sheet print them. */
export const FITREP_ATTRIBUTES = [
  { abbr: 'Per', name: 'Performance' }, { abbr: 'Pro', name: 'Proficiency' }, { abbr: 'Cou', name: 'Courage' },
  { abbr: 'Eff', name: 'Effectiveness Under Stress' }, { abbr: 'Ini', name: 'Initiative' }, { abbr: 'Lea', name: 'Leading Subordinates' },
  { abbr: 'Dev', name: 'Developing Subordinates' }, { abbr: 'Set', name: 'Setting the Example' }, { abbr: 'Ens', name: 'Ensuring Well-Being of Subordinates' },
  { abbr: 'Co', name: 'Communication Skills' }, { abbr: 'PME', name: 'Professional Military Education (PME)' }, { abbr: 'Dec', name: 'Decision Making Ability' },
  { abbr: 'Jud', name: 'Judgment' }, { abbr: 'Eval', name: 'Evaluations' },
] as const;

export type Third = 'upper' | 'middle' | 'lower';

export interface FitrepMethod {
  /** The value of each observed mark. The not-observed mark has none. */
  marks: Readonly<Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G', number>>;
  notObserved: 'H';
  attributes: number;
  /** Where the RS High, the RS Avg and the floor sit on the relative value scale. */
  scale: { high: number; average: number; floor: number };
  /** The fewest reports an RS must have written on Marines of the grade before a report has a relative value. */
  minimumProfile: number;
  /** Reports that are never marked against the profile. */
  noValue: { occasions: readonly Occasion[]; types: readonly ReportType[] };
  /** The thirds of the scale, by the relative value as printed. */
  thirds: ReadonlyArray<{ key: Third; label: string; from: number; to: number }>;
  /** Places the Master Brief Sheet prints averages and relative values to. */
  decimals: number;
}

export const FITREP_METHOD = versioned<FitrepMethod>('Fitness report average and relative value', [{
  id: 'pes-mco-1610.7b',
  effective_from: '2023-06-05',
  cites: [MCO_1610_7B, TBS_W3G0001XQ, TBS_B3K3738, MMOA_4, CNA_2012, CNA_2024, MCO_1610_7A],
  notes: [
    'Chapter 8 of MCO 1610.7B was not readable where these rules were gathered. They are the rules The Basic School teaches and CNA quotes from the PES Manual; check them against Chapter 8.',
    'The relative value is the straight line through the RS High at 100 and the RS Avg at 90, raised to 80 below the point as far under the average as the high is over it. On CNA’s published Master Brief Sheet row (RPT Avg 2.50, RS Avg 2.99, RS High 5.00) it gives 87.56, as printed.',
    'A profile whose reports all share one average gives each of them 90 (CNA 2024, footnote 6).',
    'The report being worked counts in its own profile: the RS High is the highest of all the reports the RS has written on the grade, that one included.',
    'Figures are worked as the Master Brief Sheet prints them, to two decimals. The sources do not say whether the system rounds the averages before it works the value.',
  ],
  data: {
    marks: { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7 },
    notObserved: 'H',
    attributes: 14,
    scale: { high: 100, average: 90, floor: 80 },
    minimumProfile: 3,
    noValue: { occasions: ['EN'], types: ['not_observed', 'extended', 'academic'] },
    thirds: [
      { key: 'upper', label: 'Upper third', from: 93.34, to: 100 },
      { key: 'middle', label: 'Middle third', from: 86.67, to: 93.33 },
      { key: 'lower', label: 'Lower third', from: 80, to: 86.66 },
    ],
    decimals: 2,
  },
}]);
