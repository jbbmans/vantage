import { versioned, type Citation } from './versioned.ts';

/**
 * The JEPES scoring tables as published (ADR-0046): MCO 1616.1 Appendix B ("JEPES Manual Scoring Instructions") and the
 * MARADMINs that changed it. Every number here is from the page each version cites. A change to any of them is a new
 * version with its own effective date and source; a released version is never edited, and its fingerprint is pinned in
 * tests/server/jepesEstimate.test.ts so an edit fails there.
 */

export const MCO_1616_1_URL = 'https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/2431802/mco-16161/';
const MCO_1616_1 = 'MCO 1616.1 (25 Nov 2020)';
const order = (where: string): Citation => ({ source: MCO_1616_1, where, url: MCO_1616_1_URL });
const MARADMIN_367_21: Citation = {
  source: 'MARADMIN 367/21 (132330Z JUL 21)', where: 'paragraphs 3 and 6',
  url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/2693294/jepes-mos-courses-and-qualifications-initiative/',
};
const MARADMIN_046_24: Citation = {
  source: 'MARADMIN 046/24 (011100Z FEB 24)', where: 'paragraphs 1 and 2',
  url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/3662965/updates-to-the-implementation-of-military-occupational-specialty-qualifications/',
};
const MARADMIN_695_21: Citation = {
  source: 'MARADMIN 695/21 (071515Z DEC 21)', where: 'paragraphs 1, 4.a and 7',
  url: 'https://www.marines.mil/News/Messages/Messages-Display/Article/2864282/reserve-affiliation-junior-enlisted-performace-evaluation-system-score-points-i/',
};

/** Which tables a Marine's grade reads: Lance Corporal and below, or Corporal (worksheet heading, page B-1). */
export type JepesGrade = 'lcpl' | 'cpl';
export const JEPES_GRADE_LABEL: Record<JepesGrade, string> = { lcpl: 'Lance Corporal and below', cpl: 'Corporal' };

/** A band of scores and the value the table gives it: [lowest score, highest score, value]. */
export type ScoreBand = readonly [number, number, number];
export interface ScoreColumns { pft: readonly ScoreBand[]; cft: readonly ScoreBand[]; rifle: readonly ScoreBand[] }
export type ScoreKey = keyof ScoreColumns;
export const SCORE_SCALE: Record<ScoreKey, number> = { pft: 300, cft: 300, rifle: 350 };

/**
 * Tables 3 and 4: the PFT, CFT and rifle score against the value it earns, 0 to 100. Read from the order's text row by
 * row; each column is one unbroken run of whole scores from 0 to the top of its scale, and a value no score reaches is
 * left out, as the order leaves it blank. Page B-2: "The tables for these comparisons (tables 3 and 4) are updated
 * yearly." These are the tables the order prints; later years' tables are on MOL, not published.
 */
export const JEPES_SCORE_TABLES = versioned<Record<JepesGrade, ScoreColumns>>('JEPES Tables 3 and 4', [{
  id: 'mco-1616.1-tables-3-4',
  effective_from: '2021-02-01',
  cites: [order('Appendix B, Table 3, p. B-8'), order('Appendix B, Table 4, p. B-9')],
  notes: [
    'Updated yearly on MOL; only the tables the order prints are published.',
    'The rifle line reads the 0 to 350 score MOL lists. The annual qualification is scored in destroys (MCO 3574.2M) and no published rule converts destroys to that scale, so none is applied.',
    'Appendix A’s dashboard example gives a Corporal’s 310 as the 37th percentile; Table 4 gives 310 the value 43. The estimate follows the table.',
  ],
  data: {
    // Table 3, page B-8: Lance Corporal and below.
    lcpl: {
      pft: [
        [0, 149, 0], [150, 150, 1], [151, 158, 2], [159, 166, 3], [167, 173, 4], [174, 178, 5], [179, 183, 6],
        [184, 187, 7], [188, 190, 8], [191, 193, 9], [194, 196, 10], [197, 198, 11], [199, 200, 12],
        [201, 202, 13], [203, 204, 14], [205, 206, 15], [207, 207, 16], [208, 209, 17], [210, 210, 18],
        [211, 212, 19], [213, 213, 20], [214, 215, 21], [216, 216, 22], [217, 217, 23], [218, 218, 24],
        [219, 220, 25], [221, 221, 26], [222, 222, 27], [223, 223, 28], [224, 224, 29], [225, 225, 30],
        [226, 226, 31], [227, 227, 32], [228, 229, 33], [230, 230, 34], [231, 231, 35], [232, 232, 36],
        [233, 233, 37], [234, 234, 38], [235, 235, 40], [236, 236, 41], [237, 237, 42], [238, 238, 43],
        [239, 239, 45], [240, 240, 46], [241, 241, 47], [242, 242, 49], [243, 243, 50], [244, 244, 51],
        [245, 245, 52], [246, 246, 54], [247, 247, 55], [248, 248, 56], [249, 249, 58], [250, 250, 59],
        [251, 251, 60], [252, 252, 61], [253, 253, 63], [254, 254, 64], [255, 255, 65], [256, 256, 66],
        [257, 257, 67], [258, 258, 69], [259, 259, 70], [260, 260, 71], [261, 261, 72], [262, 262, 73],
        [263, 263, 75], [264, 264, 76], [265, 265, 77], [266, 266, 78], [267, 267, 79], [268, 268, 80],
        [269, 269, 81], [270, 270, 82], [271, 271, 83], [272, 272, 84], [273, 273, 85], [274, 274, 86],
        [275, 275, 87], [276, 276, 88], [277, 277, 89], [278, 278, 90], [279, 279, 91], [280, 280, 92],
        [281, 282, 93], [283, 283, 94], [284, 285, 95], [286, 287, 96], [288, 289, 97], [290, 291, 98],
        [292, 294, 99], [295, 300, 100]
      ],
      cft: [
        [0, 149, 0], [150, 173, 1], [174, 187, 2], [188, 196, 3], [197, 202, 4], [203, 207, 5], [208, 211, 6],
        [212, 215, 7], [216, 218, 8], [219, 220, 9], [221, 223, 10], [224, 225, 11], [226, 227, 12],
        [228, 229, 13], [230, 231, 14], [232, 233, 15], [234, 234, 16], [235, 236, 17], [237, 237, 18],
        [238, 239, 19], [240, 240, 20], [241, 241, 21], [242, 242, 22], [243, 244, 23], [245, 245, 24],
        [246, 246, 25], [247, 247, 26], [248, 248, 27], [249, 249, 28], [250, 250, 29], [251, 251, 30],
        [252, 252, 31], [253, 253, 32], [254, 254, 34], [255, 255, 35], [256, 256, 36], [257, 257, 37],
        [258, 258, 38], [259, 259, 40], [260, 260, 41], [261, 261, 42], [262, 262, 44], [263, 263, 45],
        [264, 264, 46], [265, 265, 48], [266, 266, 49], [267, 267, 50], [268, 268, 52], [269, 269, 53],
        [270, 270, 54], [271, 271, 56], [272, 272, 57], [273, 273, 59], [274, 274, 60], [275, 275, 62],
        [276, 276, 63], [277, 277, 65], [278, 278, 66], [279, 279, 68], [280, 280, 69], [281, 281, 70],
        [282, 282, 72], [283, 283, 74], [284, 284, 75], [285, 285, 76], [286, 286, 78], [287, 287, 79],
        [288, 288, 81], [289, 289, 82], [290, 290, 83], [291, 291, 85], [292, 292, 86], [293, 293, 87],
        [294, 294, 89], [295, 295, 90], [296, 296, 91], [297, 297, 92], [298, 298, 93], [299, 299, 94],
        [300, 300, 100]
      ],
      rifle: [
        [0, 249, 0], [250, 250, 4], [251, 266, 5], [267, 272, 6], [273, 275, 7], [276, 278, 8], [279, 279, 9],
        [280, 281, 10], [282, 282, 11], [283, 283, 12], [284, 284, 13], [285, 285, 14], [286, 286, 15],
        [287, 287, 16], [288, 288, 17], [289, 289, 18], [290, 290, 19], [291, 291, 21], [292, 292, 22],
        [293, 293, 23], [294, 294, 25], [295, 295, 26], [296, 296, 28], [297, 297, 29], [298, 298, 31],
        [299, 299, 33], [300, 300, 34], [301, 301, 36], [302, 302, 38], [303, 303, 40], [304, 304, 42],
        [305, 305, 44], [306, 306, 46], [307, 307, 48], [308, 308, 50], [309, 309, 53], [310, 310, 55],
        [311, 311, 58], [312, 312, 60], [313, 313, 62], [314, 314, 65], [315, 315, 67], [316, 316, 69],
        [317, 317, 72], [318, 318, 74], [319, 319, 76], [320, 320, 78], [321, 321, 80], [322, 322, 82],
        [323, 323, 84], [324, 324, 86], [325, 325, 88], [326, 326, 89], [327, 327, 90], [328, 328, 91],
        [329, 329, 93], [330, 330, 94], [331, 331, 95], [332, 332, 96], [333, 333, 97], [334, 335, 98],
        [336, 338, 99], [339, 350, 100]
      ],
    },
    // Table 4, page B-9: Corporal.
    cpl: {
      pft: [
        [0, 149, 0], [150, 150, 1], [151, 168, 2], [169, 179, 3], [180, 188, 4], [189, 194, 5], [195, 198, 6],
        [199, 202, 7], [203, 205, 8], [206, 207, 9], [208, 209, 10], [210, 211, 11], [212, 213, 12],
        [214, 215, 13], [216, 217, 14], [218, 219, 15], [220, 220, 16], [221, 222, 17], [223, 223, 18],
        [224, 224, 19], [225, 226, 20], [227, 227, 21], [228, 229, 22], [230, 230, 23], [231, 231, 24],
        [232, 232, 25], [233, 233, 26], [234, 234, 27], [235, 235, 28], [236, 236, 29], [237, 237, 30],
        [238, 238, 31], [239, 239, 33], [240, 240, 34], [241, 241, 35], [242, 242, 37], [243, 243, 38],
        [244, 244, 39], [245, 245, 41], [246, 246, 42], [247, 247, 43], [248, 248, 44], [249, 249, 46],
        [250, 250, 47], [251, 251, 49], [252, 252, 50], [253, 253, 52], [254, 254, 53], [255, 255, 54],
        [256, 256, 56], [257, 257, 57], [258, 258, 58], [259, 259, 60], [260, 260, 61], [261, 261, 63],
        [262, 262, 64], [263, 263, 66], [264, 264, 67], [265, 265, 68], [266, 266, 70], [267, 267, 71],
        [268, 268, 73], [269, 269, 74], [270, 270, 76], [271, 271, 77], [272, 272, 78], [273, 273, 80],
        [274, 274, 81], [275, 275, 82], [276, 276, 84], [277, 277, 85], [278, 278, 86], [279, 279, 87],
        [280, 280, 88], [281, 281, 89], [282, 282, 90], [283, 283, 91], [284, 284, 92], [285, 286, 93],
        [287, 287, 94], [288, 288, 95], [289, 290, 96], [291, 292, 97], [293, 294, 98], [295, 298, 99],
        [299, 300, 100]
      ],
      cft: [
        [0, 149, 0], [150, 192, 1], [193, 204, 2], [205, 212, 3], [213, 218, 4], [219, 222, 5], [223, 226, 6],
        [227, 230, 7], [231, 233, 8], [234, 235, 9], [236, 236, 10], [237, 238, 11], [239, 240, 12],
        [241, 242, 13], [243, 243, 14], [244, 245, 15], [246, 246, 16], [247, 247, 17], [248, 249, 18],
        [250, 250, 19], [251, 251, 20], [252, 252, 21], [253, 253, 22], [254, 254, 23], [255, 255, 24],
        [256, 256, 25], [257, 257, 26], [258, 258, 27], [259, 259, 28], [260, 260, 29], [261, 261, 30],
        [262, 262, 32], [263, 263, 33], [264, 264, 34], [265, 265, 35], [266, 266, 36], [267, 267, 38],
        [268, 268, 39], [269, 269, 40], [270, 270, 42], [271, 271, 43], [272, 272, 45], [273, 273, 46],
        [274, 274, 48], [275, 275, 49], [276, 276, 51], [277, 277, 52], [278, 278, 54], [279, 279, 56],
        [280, 280, 57], [281, 281, 59], [282, 282, 61], [283, 283, 62], [284, 284, 64], [285, 285, 65],
        [286, 286, 67], [287, 287, 69], [288, 288, 71], [289, 289, 73], [290, 290, 74], [291, 291, 76],
        [292, 292, 78], [293, 293, 79], [294, 294, 81], [295, 295, 83], [296, 296, 85], [297, 297, 86],
        [298, 298, 88], [299, 299, 89], [300, 300, 100]
      ],
      rifle: [
        [0, 249, 0], [250, 250, 1], [251, 258, 2], [259, 274, 3], [275, 279, 4], [280, 281, 5], [282, 284, 6],
        [285, 285, 7], [286, 287, 8], [288, 288, 9], [289, 289, 10], [290, 290, 11], [291, 291, 12],
        [292, 292, 13], [293, 293, 14], [294, 294, 15], [295, 295, 16], [296, 296, 17], [297, 297, 19],
        [298, 298, 20], [299, 299, 21], [300, 300, 23], [301, 301, 24], [302, 302, 26], [303, 303, 27],
        [304, 304, 29], [305, 305, 31], [306, 306, 33], [307, 307, 36], [308, 308, 38], [309, 309, 41],
        [310, 310, 43], [311, 311, 45], [312, 312, 48], [313, 313, 51], [314, 314, 53], [315, 315, 56],
        [316, 316, 59], [317, 317, 61], [318, 318, 64], [319, 319, 66], [320, 320, 69], [321, 321, 71],
        [322, 322, 74], [323, 323, 76], [324, 324, 78], [325, 325, 81], [326, 326, 83], [327, 327, 85],
        [328, 328, 87], [329, 329, 88], [330, 330, 90], [331, 331, 92], [332, 332, 93], [333, 333, 94],
        [334, 334, 95], [335, 335, 96], [336, 336, 97], [337, 338, 98], [339, 340, 99], [341, 350, 100]
      ],
    },
  },
}]);

/** An MCMAP belt level as MCTFS codes it, lowest first: MMA (unqualified) to MMG (Brown Instructor) and the black belts above it. */
export const MCMAP_CODES = ['MMA', 'MMB', 'MMC', 'MMD', 'MME', 'MMF', 'MMG', 'MMH'] as const;
export type McmapCode = (typeof MCMAP_CODES)[number];
export interface McmapRow { code: McmapCode; belt: string; value: number }

/**
 * Tables 1 and 2 (page B-7): the belt against the value it earns. The order's text prints both headings and then both
 * lists, so which list is which rank is read from the lists: the instructor belts need the Martial Arts Instructor
 * course, which a Lance Corporal does not normally attend, so the four-row list (Green is 100) is the Lance Corporal's
 * and the seven-row list is the Corporal's. A belt above a table's top row takes the top row's value: Table 2 says
 * "Brown Instructor or above", and Table 1 stops at Green.
 */
export const JEPES_MCMAP_TABLES = versioned<Record<JepesGrade, readonly McmapRow[]>>('JEPES Tables 1 and 2', [{
  id: 'mco-1616.1-tables-1-2',
  effective_from: '2021-02-01',
  cites: [order('Appendix B, Tables 1 and 2, p. B-7')],
  notes: [
    'The order’s text does not place each list under its heading; the four-row list is read as the Lance Corporal’s.',
    'A belt above a table’s top row takes its value.',
  ],
  data: {
    lcpl: [
      { code: 'MMA', belt: 'Unqualified', value: 0 }, { code: 'MMB', belt: 'Tan', value: 33 },
      { code: 'MMC', belt: 'Grey', value: 67 }, { code: 'MMD', belt: 'Green', value: 100 },
    ],
    cpl: [
      { code: 'MMA', belt: 'Unqualified', value: 0 }, { code: 'MMB', belt: 'Tan', value: 16 },
      { code: 'MMC', belt: 'Grey', value: 33 }, { code: 'MMD', belt: 'Green', value: 50 },
      { code: 'MME', belt: 'Green Instructor', value: 66 }, { code: 'MMF', belt: 'Brown', value: 83 },
      { code: 'MMG', belt: 'Brown Instructor or above', value: 100 },
    ],
  },
}]);

/** The worksheet's arithmetic: how each pillar's lines become its points, and the total (page B-1, lines 1d to 6a). */
export interface Worksheet {
  /** Lines 1d, 2d and 3f: the pillar's line sum times this, rounded, capped. */
  multiplier: number;
  pillarCap: number;
  /** Lines 4a to 4c: each average mark times this; line 4e divides their sum by `commandDivisor`. */
  perMark: number;
  commandDivisor: number;
  /** Line 6a: the total's cap. */
  totalCap: number;
}
export const JEPES_WORKSHEET = versioned<Worksheet>('JEPES worksheet', [{
  id: 'mco-1616.1-worksheet',
  effective_from: '2021-02-01',
  cites: [order('Appendix B, worksheet p. B-1 and instructions pp. B-2 to B-6')],
  notes: ['Rounded to the nearest whole number, .5 and above up (p. B-2: 200.5 is 201).'],
  data: { multiplier: 1.25, pillarCap: 250, perMark: 50, commandDivisor: 3, totalCap: 1000 },
}]);

/** Mental Agility's lines (line 3): what each earns and its most. A cap of 0 means the line is not in the score. */
export interface MentalAgility {
  /** Line 3a: the CEU values of MarineNet courses since the date of rank, summed, to this most. */
  marinenetCap: number;
  /** Line 3b: a bachelor's degree, one associate degree, two or more, and the line's most. */
  degree: { bachelor: number; oneAssociate: number; twoAssociates: number; cap: number };
  /** Lines 3c and 3d: points per off-duty course passed, in service before the date of rank and in grade since it. */
  inService: { each: number; cap: number };
  inGrade: { each: number; cap: number };
  /** MOS courses and qualifications, from the MOL scoring table for the Marine's PMOS, to this most. */
  mosQualsCap: number;
}
export const JEPES_MENTAL_AGILITY = versioned<MentalAgility>('JEPES Mental Agility', [
  {
    id: 'mco-1616.1-line-3',
    effective_from: '2021-02-01',
    cites: [order('Appendix B, line 3, pp. B-3 to B-5')],
    data: {
      marinenetCap: 100,
      degree: { bachelor: 40, oneAssociate: 20, twoAssociates: 40, cap: 40 },
      inService: { each: 10, cap: 30 },
      inGrade: { each: 10, cap: 30 },
      mosQualsCap: 0,
    },
  },
  {
    id: 'maradmin-367-21',
    effective_from: '2021-07-29',
    cites: [MARADMIN_367_21, MARADMIN_046_24],
    notes: [
      'MarineNet is read as the CEU sum to 40: the order sums CEU values, and the message makes 40 the most.',
      'Two associate degrees are read as 10 each, to the most of 20.',
      'MOS qualification points come from the MOL JEPES MOS Quals Scoring Table for the PMOS (MARADMIN 046/24), entered by the Marine.',
    ],
    data: {
      marinenetCap: 40,
      degree: { bachelor: 20, oneAssociate: 10, twoAssociates: 20, cap: 20 },
      inService: { each: 5, cap: 20 },
      inGrade: { each: 5, cap: 20 },
      mosQualsCap: 100,
    },
  },
]);

/** Bonus inputs the worksheet's line 5 reads. */
export type BonusKey = 'bonus_di_school' | 'bonus_recruiter_school' | 'bonus_msg_school' | 'bonus_combat_instructor' | 'bonus_security_forces' | 'bonus_reserve_affiliation';
export interface BonusItem { key: BonusKey; line: string; label: string; points: number }
export interface Bonus { items: readonly BonusItem[]; recruiting: { line: string; each: number; cap: number }; cap: number }
const SCHOOLS: BonusItem[] = [
  { key: 'bonus_di_school', line: '5a', label: 'Drill Instructor School', points: 50 },
  { key: 'bonus_recruiter_school', line: '5b', label: 'Recruiter School', points: 50 },
  { key: 'bonus_msg_school', line: '5c', label: 'Marine Security Guard School', points: 50 },
  { key: 'bonus_combat_instructor', line: '5d', label: 'Combat Instructor', points: 50 },
  { key: 'bonus_security_forces', line: '5e', label: 'Marine Corps Security Forces', points: 50 },
];
export const JEPES_BONUS = versioned<Bonus>('JEPES bonus', [
  {
    id: 'mco-1616.1-line-5',
    effective_from: '2021-02-01',
    cites: [order('Appendix B, line 5, pp. B-1 and B-6')],
    notes: ['Line 5e is read as the worksheet prints it, yes 50 and no 0; the instruction text on p. B-6 says 100 for no.'],
    data: { items: SCHOOLS, recruiting: { line: '5f', each: 20, cap: 100 }, cap: 100 },
  },
  {
    id: 'maradmin-695-21',
    effective_from: '2021-12-07',
    cites: [order('Appendix B, line 5, pp. B-1 and B-6'), MARADMIN_695_21],
    notes: [
      'Line 5e is read as the worksheet prints it, yes 50 and no 0; the instruction text on p. B-6 says 100 for no.',
      'The reserve affiliation incentive is 50 points for an eligible Corporal, and with command recruiting no more than 100.',
    ],
    data: {
      items: [...SCHOOLS, { key: 'bonus_reserve_affiliation', line: '5', label: 'Reserve affiliation incentive', points: 50 }],
      recruiting: { line: '5f', each: 20, cap: 100 },
      cap: 100,
    },
  },
]);

/** Every JEPES table, for the fingerprint register and for "which rules this estimate read". */
export const JEPES_TABLES = [JEPES_SCORE_TABLES, JEPES_MCMAP_TABLES, JEPES_WORKSHEET, JEPES_MENTAL_AGILITY, JEPES_BONUS] as const;
