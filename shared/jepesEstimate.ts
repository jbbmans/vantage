import { MCMAP_BELTS } from './constants.ts';
import {
  JEPES_BONUS, JEPES_GRADE_LABEL, JEPES_MCMAP_TABLES, JEPES_MENTAL_AGILITY, JEPES_SCORE_TABLES, JEPES_TABLES, JEPES_WORKSHEET,
  MCMAP_CODES, SCORE_SCALE, type BonusKey, type JepesGrade, type McmapCode, type McmapRow, type ScoreBand, type ScoreKey,
} from './jepesTables.ts';
import type { Citation } from './versioned.ts';

/**
 * A JEPES estimate from the published tables (ADR-0046), worked the way MCO 1616.1 Appendix B's worksheet works it,
 * line by line, for one Marine from their own figures. It reads no one else's: no peers, no unit, no pool. Every line
 * carries a low and a high, equal when its figure is entered and the line's whole range when it is blank, so the
 * pillars and the total are exact or a range. MOL holds the score of record; this says how the order's tables read
 * the figures the Marine entered.
 */

export interface Range { low: number; high: number }
export type PillarKey = 'warfighting' | 'physical' | 'mental' | 'command' | 'bonus';

export interface JepesLine {
  key: string;
  /** The worksheet line it fills, such as "1a". */
  line: string;
  label: string;
  /** The figure as entered, in words, or null when blank. */
  shown: string | null;
  entered: boolean;
  value: Range;
  max: number;
  reason: string;
  cite: Citation;
}
export interface JepesPillar {
  key: PillarKey;
  label: string;
  lines: JepesLine[];
  /** The worksheet's line sum (1c, 2c, 3e, 4d, 5g) and the points it gives (1d, 2d, 3f, 4e, 5h). */
  sum: Range;
  points: Range;
  max: number;
  arithmetic: string;
}
export interface JepesEstimate {
  on: string;
  /** The tables the grade reads, or null when the rank is not known (the estimate then spans both). */
  grade: JepesGrade | null;
  gradeLabel: string;
  /** False for Sergeant and above, who are not on JEPES. */
  applies: boolean;
  versions: Array<{ table: string; id: string; effective_from: string; cites: readonly Citation[]; notes: readonly string[] }>;
  pillars: JepesPillar[];
  total: Range;
  max: number;
  exact: boolean;
  /** The keys of the inputs left blank that the estimate reads. */
  blanks: string[];
}

/** The readiness figures the estimate reads, as saved or as typed. */
export type JepesInputs = Record<string, unknown>;

/** The readiness columns kept for the estimate alone (migration 044), beside the figures readiness already kept. */
export const JEPES_READINESS_COLUMNS = [
  'rifle_score', 'mcmap_instructor', 'associate_degrees', 'courses_in_service', 'courses_in_grade', 'mos_qual_points',
  'bonus_di_school', 'bonus_recruiter_school', 'bonus_msg_school', 'bonus_combat_instructor', 'bonus_security_forces',
  'bonus_reserve_affiliation', 'recruiting_referrals',
] as const;

const entered = (v: unknown) => !(v === null || v === undefined || String(v).trim() === '');
const num = (v: unknown): number | null => {
  if (!entered(v)) return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const flag = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';
const exact = (n: number): Range => ({ low: n, high: n });
const span = (low: number, high: number): Range => ({ low, high });
const add = (a: Range, b: Range): Range => ({ low: a.low + b.low, high: a.high + b.high });
const isExact = (r: Range) => r.low === r.high;
const show = (r: Range) => (isExact(r) ? fmt(r.low) : `${fmt(r.low)} to ${fmt(r.high)}`);
/** A figure as the worksheet would write it: whole numbers with commas, a fraction to as many places as it has, up to four. */
export const formatFigure = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
const fmt = formatFigure;
/** A command mark as entered: one place at least ("4.0"), and every place it was entered with, up to four. */
export const formatMark = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 4 });
/** What is still open on a set of lines: a blank figure, or a rank that would pick between the two tables. */
function stillOpen(lines: JepesLine[]): string {
  const blank = lines.some((l) => !l.entered);
  const rank = lines.some((l) => l.entered && l.value.low !== l.value.high);
  return [blank && 'every line is entered', rank && 'your rank is set, since the Lance Corporal and Corporal tables differ'].filter(Boolean).join(' and ');
}

/** The worksheet's rounding (p. B-2): to the nearest whole number, .5 and above up. Float noise is cleared first. */
export function roundHalfUp(n: number): number {
  return Math.floor(Math.round(n * 1e6) / 1e6 + 0.5);
}

function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** E-1 to E-3 read the Lance Corporal tables, E-4 the Corporal's; Sergeant and above are not on JEPES. */
export function jepesGrade(rankGrade: unknown): { grade: JepesGrade | null; applies: boolean } {
  const m = /^E-(\d+)$/.exec(String(rankGrade ?? '').trim());
  if (!m) return { grade: null, applies: true };
  const n = Number(m[1]);
  if (n >= 5) return { grade: null, applies: false };
  return { grade: n === 4 ? 'cpl' : 'lcpl', applies: true };
}

/** The MCTFS belt code for a belt and whether the Marine is a certified instructor at it. */
export function mcmapCode(belt: unknown, instructor: unknown): McmapCode | null {
  const b = String(belt ?? '').trim();
  if (!b) return null;
  const i = flag(instructor);
  if (b === 'Unqualified') return 'MMA';
  if (b === 'Tan') return 'MMB';
  if (b === 'Grey') return 'MMC';
  if (b === 'Green') return i ? 'MME' : 'MMD';
  if (b === 'Brown') return i ? 'MMG' : 'MMF';
  if ((MCMAP_BELTS as readonly string[]).includes(b) && b.startsWith('Black')) return 'MMH';
  return null;
}
const codeRank = (c: McmapCode) => MCMAP_CODES.indexOf(c);
/** The row a belt reads: its own, or the highest row below it when the table stops short of it. */
function mcmapRow(rows: readonly McmapRow[], code: McmapCode): McmapRow {
  return [...rows].reverse().find((r) => codeRank(r.code) <= codeRank(code)) ?? rows[0];
}
function bandValue(bands: readonly ScoreBand[], score: number): number {
  const s = Math.floor(score);
  return bands.find(([lo, hi]) => s >= lo && s <= hi)?.[2] ?? 0;
}

const TABLE_NAME: Record<JepesGrade, { score: string; mcmap: string; scorePage: string }> = {
  lcpl: { score: 'Table 3', mcmap: 'Table 1', scorePage: 'p. B-8' },
  cpl: { score: 'Table 4', mcmap: 'Table 2', scorePage: 'p. B-9' },
};
const GRADES: JepesGrade[] = ['lcpl', 'cpl'];

export interface EstimateOptions { on?: string }

/** The three command marks by the names the rest of Vantage gives the JEPES areas. */
export const MARK_NAMES = { cmd_mos: 'MOS / Mission Accomplishment', cmd_leadership: 'Leadership', cmd_character: 'Individual Character' } as const;

export function estimateJepes(inputs: JepesInputs = {}, opts: EstimateOptions = {}): JepesEstimate {
  const on = opts.on ?? localDay();
  const { grade, applies } = jepesGrade(inputs.rank_grade);
  const grades = grade ? [grade] : GRADES;
  const versionOf = <T,>(t: { inForce(d: string): T | null; name: string }) => {
    const v = t.inForce(on);
    if (!v) throw new Error(`${t.name}: no version in force on ${on}; JEPES began on 2021-02-01.`);
    return v;
  };
  const scores = versionOf(JEPES_SCORE_TABLES);
  const mcmap = versionOf(JEPES_MCMAP_TABLES);
  const sheet = versionOf(JEPES_WORKSHEET).data;
  const mental = versionOf(JEPES_MENTAL_AGILITY);
  const bonus = versionOf(JEPES_BONUS);
  const blanks: string[] = [];
  const order = (where: string): Citation => ({ ...scores.cites[0], where });

  const scoreLine = (key: ScoreKey, inputKey: string, line: string, label: string): JepesLine => {
    const raw = num(inputs[inputKey]);
    const page = grade ? `Appendix B, ${TABLE_NAME[grade].score}, ${TABLE_NAME[grade].scorePage}` : 'Appendix B, Tables 3 and 4, pp. B-8 and B-9';
    if (raw === null) {
      blanks.push(inputKey);
      return { key: inputKey, line, label, shown: null, entered: false, value: span(0, 100), max: 100, cite: order(page), reason: `Not entered, so 0 to 100. Enter the ${label.toLowerCase()} score MOL lists (0 to ${SCORE_SCALE[key]}).` };
    }
    const score = Math.min(Math.max(raw, 0), SCORE_SCALE[key]);
    const values = grades.map((g) => bandValue(scores.data[g][key], score));
    const value = span(Math.min(...values), Math.max(...values));
    const reason = grade
      ? `${label} ${fmt(score)} is value ${values[0]} on ${TABLE_NAME[grade].score} (${JEPES_GRADE_LABEL[grade]}).`
      : `${label} ${fmt(score)} is value ${values[0]} on Table 3 and ${values[1]} on Table 4; your rank picks the table.`;
    return { key: inputKey, line, label, shown: fmt(score), entered: true, value, max: 100, cite: order(page), reason };
  };

  const mcmapLine = (): JepesLine => {
    const code = mcmapCode(inputs.mcmap_belt, inputs.mcmap_instructor);
    const page = 'Appendix B, Tables 1 and 2, p. B-7';
    if (!code) {
      blanks.push('mcmap_belt');
      return { key: 'mcmap_belt', line: '1b', label: 'MCMAP belt', shown: null, entered: false, value: span(0, 100), max: 100, cite: order(page), reason: 'Not entered, so 0 to 100.' };
    }
    const belt = code === 'MMA' ? 'Unqualified' : `${inputs.mcmap_belt} belt${flag(inputs.mcmap_instructor) && (code === 'MME' || code === 'MMG') ? ', instructor' : ''}`;
    const read = grades.map((g) => ({ g, row: mcmapRow(mcmap.data[g], code) }));
    const values = read.map((r) => r.row.value);
    const says = ({ g, row }: { g: JepesGrade; row: McmapRow }) => (row.code === code || (code === 'MMH' && row.code === 'MMG' && g === 'cpl')
      ? `value ${row.value} on ${TABLE_NAME[g].mcmap}`
      : `above ${TABLE_NAME[g].mcmap}'s top row, ${row.belt}, so ${row.value}`);
    const reason = grade ? `${belt} (${code}) is ${says(read[0])}.` : `${belt} (${code}) is ${says(read[0])}, and ${says(read[1])}; your rank picks the table.`;
    return { key: 'mcmap_belt', line: '1b', label: 'MCMAP belt', shown: belt, entered: true, value: span(Math.min(...values), Math.max(...values)), max: 100, cite: order(page), reason };
  };

  const composite = (sum: Range): Range => ({
    low: Math.min(sheet.pillarCap, roundHalfUp(sum.low * sheet.multiplier)),
    high: Math.min(sheet.pillarCap, roundHalfUp(sum.high * sheet.multiplier)),
  });
  const compositeText = (sumLine: string, pointsLine: string, lines: JepesLine[], sum: Range, points: Range) => {
    if (isExact(sum)) {
      const raw = sum.low * sheet.multiplier;
      const rounded = roundHalfUp(raw);
      const capped = rounded > sheet.pillarCap ? `, most ${sheet.pillarCap}` : '';
      return `Line ${sumLine}: ${lines.map((l) => fmt(l.value.low)).join(' + ')} = ${fmt(sum.low)}. Line ${pointsLine}: ${fmt(sum.low)} × ${sheet.multiplier} = ${fmt(raw)}${Number.isInteger(raw) ? '' : `, rounded to ${rounded}`}${capped}.`;
    }
    return `Line ${sumLine}: ${show(sum)}. Line ${pointsLine}: ${show(points)} (× ${sheet.multiplier}, rounded) until ${stillOpen(lines)}.`;
  };
  const pillar = (key: PillarKey, label: string, lines: JepesLine[], sumLine: string, pointsLine: string): JepesPillar => {
    const sum = lines.reduce((acc, l) => add(acc, l.value), exact(0));
    const points = composite(sum);
    return { key, label, lines, sum, points, max: sheet.pillarCap, arithmetic: compositeText(sumLine, pointsLine, lines, sum, points) };
  };

  // Line 1: Warfighting.
  const warfighting = pillar('warfighting', 'Warfighting', [scoreLine('rifle', 'rifle_score', '1a', 'Rifle'), mcmapLine()], '1c', '1d');
  // Line 2: Physical Toughness.
  const physical = pillar('physical', 'Physical Toughness', [scoreLine('pft', 'pft_score', '2a', 'PFT'), scoreLine('cft', 'cft_score', '2b', 'CFT')], '2c', '2d');

  // Line 3: Mental Agility, under the version in force.
  const ma = mental.data;
  const maCite = (where: string): Citation => (mental.id === 'mco-1616.1-line-3' ? order(where) : mental.cites[0]);
  const countLine = (key: string, line: string, label: string, rule: { each: number; cap: number }, what: string): JepesLine => {
    const n = num(inputs[key]);
    if (n === null) {
      blanks.push(key);
      return { key, line, label, shown: null, entered: false, value: span(0, rule.cap), max: rule.cap, cite: maCite(`Appendix B, line ${line}, pp. B-3 to B-5`), reason: `Not entered, so 0 to ${rule.cap}. ${what}` };
    }
    const count = Math.max(0, Math.floor(n));
    const value = Math.min(rule.cap, count * rule.each);
    return { key, line, label, shown: `${count} course${count === 1 ? '' : 's'}`, entered: true, value: exact(value), max: rule.cap, cite: maCite(`Appendix B, line ${line}, pp. B-3 to B-5`), reason: `${count} × ${rule.each} = ${count * rule.each}${count * rule.each > rule.cap ? `, most ${rule.cap}` : ''}.` };
  };
  const ceus = num(inputs.ceus);
  if (ceus === null) blanks.push('ceus');
  const marinenet: JepesLine = ceus === null
    ? { key: 'ceus', line: '3a', label: 'MarineNet', shown: null, entered: false, value: span(0, ma.marinenetCap), max: ma.marinenetCap, cite: maCite('Appendix B, line 3a, pp. B-3 to B-5'), reason: `Not entered, so 0 to ${ma.marinenetCap}. The CEUs of MarineNet courses since your date of rank, from your MarineNet transcript.` }
    : { key: 'ceus', line: '3a', label: 'MarineNet', shown: `${fmt(Math.max(0, ceus))} CEUs`, entered: true, value: exact(Math.min(ma.marinenetCap, Math.max(0, ceus))), max: ma.marinenetCap, cite: maCite('Appendix B, line 3a, pp. B-3 to B-5'), reason: `${fmt(Math.max(0, ceus))} CEUs since your date of rank${ceus > ma.marinenetCap ? `, most ${ma.marinenetCap}` : ''}.` };
  const degree = String(inputs.degree ?? '').trim();
  const bachelor = ['bachelor', 'master', 'doctorate'].includes(degree);
  // The count, or one when the highest degree is an associate's and no count is entered.
  const associates = bachelor ? 0 : Math.max(Math.floor(num(inputs.associate_degrees) ?? 0), degree === 'associate' ? 1 : 0);
  const degreeValue = Math.min(ma.degree.cap, bachelor ? ma.degree.bachelor : associates >= 2 ? ma.degree.twoAssociates : associates === 1 ? ma.degree.oneAssociate : 0);
  const degreeShown = bachelor ? `${degree.charAt(0).toUpperCase()}${degree.slice(1)}'s degree` : associates >= 2 ? `${associates} associate degrees` : associates === 1 ? 'One associate degree' : 'None';
  const degreeLine: JepesLine = {
    key: 'degree', line: '3b', label: 'Degrees', shown: degreeShown, entered: true, value: exact(degreeValue), max: ma.degree.cap, cite: maCite('Appendix B, line 3b, pp. B-3 to B-5'),
    reason: `${degreeShown}: ${degreeValue}${bachelor && degree !== 'bachelor' ? ' (counted as a bachelor’s)' : ''}. Bachelor’s ${ma.degree.bachelor}, one associate ${ma.degree.oneAssociate}, two or more ${ma.degree.twoAssociates}.`,
  };
  const mentalLines = [
    marinenet, degreeLine,
    countLine('courses_in_service', '3c', 'Off-duty courses in service', ma.inService, 'Courses passed from your Armed Forces Active Duty Base Date to the day before your date of rank.'),
    countLine('courses_in_grade', '3d', 'Off-duty courses in grade', ma.inGrade, 'Courses passed since your date of rank.'),
  ];
  if (ma.mosQualsCap > 0) {
    const pts = num(inputs.mos_qual_points);
    if (pts === null) blanks.push('mos_qual_points');
    mentalLines.push(pts === null
      ? { key: 'mos_qual_points', line: '3', label: 'MOS qualifications', shown: null, entered: false, value: span(0, ma.mosQualsCap), max: ma.mosQualsCap, cite: mental.cites[1] ?? mental.cites[0], reason: `Not entered, so 0 to ${ma.mosQualsCap}. The points MOL shows from the JEPES MOS Quals Scoring Table for your PMOS.` }
      : { key: 'mos_qual_points', line: '3', label: 'MOS qualifications', shown: `${fmt(pts)} points`, entered: true, value: exact(Math.min(ma.mosQualsCap, Math.max(0, pts))), max: ma.mosQualsCap, cite: mental.cites[1] ?? mental.cites[0], reason: `${fmt(pts)} points from the MOL table for your PMOS, most ${ma.mosQualsCap}.` });
  }
  const mentalPillar = pillar('mental', 'Mental Agility', mentalLines, '3e', '3f');

  // Line 4: Command Input, the average marks in grade.
  const marks: Array<[string, string, string]> = [['cmd_mos', '4a', MARK_NAMES.cmd_mos], ['cmd_leadership', '4b', MARK_NAMES.cmd_leadership], ['cmd_character', '4c', MARK_NAMES.cmd_character]];
  const markLines: JepesLine[] = marks.map(([key, line, label]) => {
    const m = num(inputs[key]);
    const cite = order('Appendix B, lines 4a to 4e, pp. B-5 and B-6');
    if (m === null) { blanks.push(key); return { key, line, label, shown: null, entered: false, value: span(0, 5 * sheet.perMark), max: 5 * sheet.perMark, cite, reason: `Not entered, so 0 to ${5 * sheet.perMark}. Your average mark in grade, 0.0 to 5.0, as MOL shows it.` }; }
    const mark = Math.min(Math.max(m, 0), 5);
    const value = mark * sheet.perMark;
    return { key, line, label, shown: formatMark(mark), entered: true, value: exact(Math.round(value * 1e6) / 1e6), max: 5 * sheet.perMark, cite, reason: `Average ${formatMark(mark)} × ${sheet.perMark} = ${fmt(Math.round(value * 1e6) / 1e6)}.` };
  });
  const markSum = markLines.reduce((acc, l) => add(acc, l.value), exact(0));
  const command = (s: number) => Math.min(sheet.pillarCap, roundHalfUp(s / sheet.commandDivisor));
  const commandPoints = span(command(markSum.low), command(markSum.high));
  const commandPillar: JepesPillar = {
    key: 'command', label: 'Command Input', lines: markLines, sum: markSum, points: commandPoints, max: sheet.pillarCap,
    arithmetic: isExact(markSum)
      ? `Line 4d: ${markLines.map((l) => fmt(l.value.low)).join(' + ')} = ${fmt(markSum.low)}. Line 4e: ${fmt(markSum.low)} / ${sheet.commandDivisor} = ${fmt(Math.round((markSum.low / sheet.commandDivisor) * 100) / 100)}${Number.isInteger(markSum.low / sheet.commandDivisor) ? '' : `, rounded to ${commandPoints.low}`}.`
      : `Line 4d: ${show(markSum)}. Line 4e: ${show(commandPoints)} (/ ${sheet.commandDivisor}, rounded) until every mark is entered.`,
  };

  // Line 5: Bonus. A yes or no the Marine knows, so a blank reads as no.
  const bonusCite = (where: string): Citation => ({ ...bonus.cites[0], where });
  const bonusLines: JepesLine[] = bonus.data.items.filter((item) => flag(inputs[item.key])).map((item) => {
    const cite = item.key === 'bonus_reserve_affiliation' ? (bonus.cites[1] ?? bonus.cites[0]) : bonusCite(`Appendix B, line ${item.line}, pp. B-1 and B-6`);
    // The reserve affiliation incentive is for an eligible Corporal (MARADMIN 695/21), so the rank decides it.
    if (item.key === 'bonus_reserve_affiliation' && grade !== 'cpl') {
      return grade === null
        ? { key: item.key, line: item.line, label: item.label, shown: 'Yes', entered: true, value: span(0, item.points), max: item.points, cite, reason: `${item.label}: ${item.points} for an eligible Corporal, so 0 to ${item.points} until your rank is set.` }
        : { key: item.key, line: item.line, label: item.label, shown: 'Yes', entered: true, value: exact(0), max: item.points, cite, reason: `${item.label}: for an eligible Corporal only, so 0 at your grade.` };
    }
    return { key: item.key, line: item.line, label: item.label, shown: 'Yes', entered: true, value: exact(item.points), max: item.points, cite, reason: `${item.label}: ${item.points}.` };
  });
  const referrals = Math.max(0, Math.floor(num(inputs.recruiting_referrals) ?? 0));
  if (referrals > 0) {
    const r = bonus.data.recruiting;
    bonusLines.push({
      key: 'recruiting_referrals', line: r.line, label: 'Command recruiting', shown: `${referrals} referral${referrals === 1 ? '' : 's'}`, entered: true,
      value: exact(Math.min(r.cap, referrals * r.each)), max: r.cap, cite: bonusCite(`Appendix B, line ${r.line}, p. B-6`),
      reason: `${referrals} × ${r.each} = ${referrals * r.each}${referrals * r.each > r.cap ? `, most ${r.cap}` : ''}.`,
    });
  }
  const bonusSum = bonusLines.reduce((acc, l) => add(acc, l.value), exact(0));
  const bonusPoints = span(Math.min(bonus.data.cap, bonusSum.low), Math.min(bonus.data.cap, bonusSum.high));
  const bonusPillar: JepesPillar = {
    key: 'bonus', label: 'Bonus', lines: bonusLines, sum: bonusSum, points: bonusPoints, max: bonus.data.cap,
    arithmetic: !bonusLines.length ? 'None entered.'
      : isExact(bonusSum)
        ? `Line 5g: ${bonusLines.length > 1 ? `${bonusLines.map((l) => fmt(l.value.low)).join(' + ')} = ` : ''}${fmt(bonusSum.low)}. Line 5h: ${fmt(bonusPoints.low)}${bonusSum.low > bonus.data.cap ? `, most ${bonus.data.cap}` : ''}.`
        : `Line 5g: ${show(bonusSum)}. Line 5h: ${show(bonusPoints)} (most ${bonus.data.cap}) until ${stillOpen(bonusLines)}.`,
  };

  const pillars = [warfighting, physical, mentalPillar, commandPillar, bonusPillar];
  const raw = pillars.reduce((acc, p) => add(acc, p.points), exact(0));
  const total = span(Math.min(sheet.totalCap, raw.low), Math.min(sheet.totalCap, raw.high));
  const used = [scores, mcmap, versionOf(JEPES_WORKSHEET), mental, bonus];
  return {
    on, grade, gradeLabel: grade ? JEPES_GRADE_LABEL[grade] : 'Rank not set', applies,
    versions: used.map((v, i) => ({ table: JEPES_TABLES[i].name, id: v.id, effective_from: v.effective_from, cites: v.cites, notes: v.notes ?? [] })),
    pillars, total, max: sheet.totalCap, exact: isExact(total), blanks,
  };
}

/** Why an estimate is still a range: blank figures, a rank not set, or both. */
export function openReason(est: JepesEstimate): string {
  const lines = est.pillars.flatMap((p) => p.lines);
  const blank = est.blanks.length > 0;
  const rank = lines.some((l) => l.entered && l.value.low !== l.value.high);
  return [blank && 'the blank figures are entered', rank && 'your rank is set'].filter(Boolean).join(' and ') || 'every figure is entered';
}

/** The arithmetic of line 6a in words. */
export function totalArithmetic(est: JepesEstimate): string {
  const parts = est.pillars.map((p) => show(p.points)).join(' + ');
  return est.exact
    ? `Line 6a: ${parts} = ${fmt(est.total.low)}, of ${fmt(est.max)}.`
    : `Line 6a: ${parts}, so ${fmt(est.total.low)} to ${fmt(est.total.high)} of ${fmt(est.max)} until ${openReason(est)}.`;
}

export interface JepesLever {
  id: string;
  /** The input it changes. */
  input: string;
  title: string;
  detail: string;
  /** What the next step adds to the total, or null when the step's size depends on a table Vantage does not hold. */
  points: number | null;
  /** What the line could add at most, from where it stands. */
  upTo: number;
  kind: 'points' | 'data';
  effort: 'trivial' | 'low' | 'medium' | 'high';
  category: string;
  /** The figures the next step would set, for the what-if; absent when the step has no single next figure. */
  change?: JepesInputs;
}

const BELT_STEPS: Array<{ belt: string; instructor: 0 | 1 }> = [
  { belt: 'Unqualified', instructor: 0 }, { belt: 'Tan', instructor: 0 }, { belt: 'Grey', instructor: 0 }, { belt: 'Green', instructor: 0 }, { belt: 'Green', instructor: 1 },
  { belt: 'Brown', instructor: 0 }, { belt: 'Brown', instructor: 1 },
];

/**
 * What would raise the estimate, each worth what the estimator says it adds, ranked by points. A blank figure is a
 * lever too: entering it narrows the range by up to what it is worth.
 */
export function jepesLevers(inputs: JepesInputs = {}, opts: EstimateOptions = {}): JepesLever[] {
  const on = opts.on ?? localDay();
  const now = estimateJepes(inputs, { on });
  if (!now.applies) return [];
  const low = (changes: JepesInputs) => estimateJepes({ ...inputs, ...changes }, { on }).total.low;
  const gain = (changes: JepesInputs) => low(changes) - now.total.low;
  const out: JepesLever[] = [];
  const line = (key: string) => now.pillars.flatMap((p) => p.lines).find((l) => l.key === key);
  const blank = (input: string, label: string, top: JepesInputs, bottom: JepesInputs, detail: string, category: string) => {
    const worth = low(top) - low(bottom);
    if (worth > 0) out.push({ id: `enter-${input}`, input, title: `Enter your ${label}`, detail: `Until it is entered, this line spans ${worth} points of the estimate. ${detail}`, points: null, upTo: worth, kind: 'data', effort: 'trivial', category });
  };
  const step = (lever: Omit<JepesLever, 'points' | 'upTo' | 'kind'> & { next: JepesInputs; best: JepesInputs }) => {
    const points = gain(lever.next);
    const upTo = gain(lever.best);
    if (upTo <= 0) return;
    const { next, best: _best, ...rest } = lever;
    void _best;
    out.push({ ...rest, points, upTo, kind: 'points', change: next });
  };

  for (const [id, key, label, scale, detail, category] of [
    ['rifle', 'rifle_score', 'rifle score', SCORE_SCALE.rifle, 'The value rises with the score band by band; the next band is often a few points away.', 'Warfighting'],
    ['pft', 'pft_score', 'PFT', SCORE_SCALE.pft, 'The run is almost always the binding constraint.', 'Physical'],
    ['cft', 'cft_score', 'CFT', SCORE_SCALE.cft, 'Movement-to-contact and maneuver-under-fire respond to sprint intervals and rehearsing the course, not to more time under the bar.', 'Physical'],
  ] as const) {
    const cur = num(inputs[key]);
    if (cur === null) { blank(key, label, { [key]: scale }, { [key]: 0 }, key === 'rifle_score' ? 'MOL lists the rifle score JEPES reads, 0 to 350.' : `MOL lists it, 0 to ${scale}.`, category); continue; }
    if (cur >= scale) continue;
    // Ten more, or the next score that moves the estimate when ten more stays in the same band.
    const from = Math.floor(cur);
    let next = Math.min(scale, from + 10);
    if (gain({ [key]: next }) <= 0) for (let s = next + 1; s <= scale; s++) if (gain({ [key]: s }) > 0) { next = s; break; }
    step({ id, input: key, title: `Raise the ${label} from ${Math.floor(cur)} to ${next}`, detail, effort: key === 'rifle_score' ? 'medium' : cur < 235 ? 'high' : 'medium', category, next: { [key]: next }, best: { [key]: scale } });
  }

  const code = mcmapCode(inputs.mcmap_belt, inputs.mcmap_instructor);
  if (!code) blank('mcmap_belt', 'MCMAP belt', { mcmap_belt: 'Brown', mcmap_instructor: 1 }, { mcmap_belt: 'Unqualified', mcmap_instructor: 0 }, 'Your belt, and whether you are a certified instructor at it.', 'Warfighting');
  else {
    const at = BELT_STEPS.findIndex((s) => mcmapCode(s.belt, s.instructor) === code);
    const ahead = at < 0 ? [] : BELT_STEPS.slice(at + 1);
    const next = ahead.find((s) => gain({ mcmap_belt: s.belt, mcmap_instructor: s.instructor }) > 0);
    const best = BELT_STEPS.at(-1)!;
    if (next) {
      const title = next.instructor ? `Become a Martial Arts Instructor at ${next.belt} belt` : `Advance to ${next.belt} belt`;
      step({ id: 'mcmap', input: 'mcmap_belt', title, detail: 'A unit-run belt course is a few weeks of training you are largely doing anyway, costs nothing, and never expires.', effort: next.instructor || next.belt === 'Brown' ? 'high' : 'low', category: 'Warfighting', next: { mcmap_belt: next.belt, mcmap_instructor: next.instructor }, best: { mcmap_belt: best.belt, mcmap_instructor: best.instructor } });
    }
  }

  const ceusLine = line('ceus');
  if (ceusLine && !ceusLine.entered) blank('ceus', 'MarineNet CEUs', { ceus: ceusLine.max }, { ceus: 0 }, 'The CEUs of MarineNet courses since your date of rank.', 'Mental');
  else if (ceusLine && ceusLine.value.low < ceusLine.max) {
    const cur = num(inputs.ceus) ?? 0;
    step({ id: 'ceus', input: 'ceus', title: 'Complete 5 more CEUs of MarineNet courses', detail: 'MarineNet courses are weighted in CEUs by length (MARADMIN 025/21), so a few long courses beat many short ones. This lever costs nothing but evenings.', effort: 'low', category: 'Mental', next: { ceus: cur + 5 }, best: { ceus: ceusLine.max } });
  }
  const inGrade = line('courses_in_grade');
  if (inGrade && !inGrade.entered) blank('courses_in_grade', 'off-duty courses in grade', { courses_in_grade: 99 }, { courses_in_grade: 0 }, 'Off-duty courses passed since your date of rank.', 'Mental');
  else if (inGrade && inGrade.value.low < inGrade.max) {
    const cur = Math.floor(num(inputs.courses_in_grade) ?? 0);
    step({ id: 'courses_in_grade', input: 'courses_in_grade', title: 'Pass one more off-duty course', detail: 'A college course passed since your date of rank counts in grade once it is reported to MCTFS. Tuition assistance usually covers it.', effort: 'medium', category: 'Mental', next: { courses_in_grade: cur + 1 }, best: { courses_in_grade: 99 } });
  }
  const inService = line('courses_in_service');
  if (inService && !inService.entered) blank('courses_in_service', 'off-duty courses in service', { courses_in_service: 99 }, { courses_in_service: 0 }, 'Courses passed before your date of rank. New courses count in grade.', 'Mental');
  const degreeLine = line('degree');
  if (degreeLine && degreeLine.value.low < degreeLine.max) {
    const associates = Math.max(Math.floor(num(inputs.associate_degrees) ?? 0), String(inputs.degree ?? '').trim() === 'associate' ? 1 : 0);
    const next: JepesInputs = associates >= 1 ? { degree: 'bachelor' } : { degree: 'associate', associate_degrees: 1 };
    step({ id: 'degree', input: 'degree', title: associates >= 1 ? 'Finish a bachelor’s degree' : 'Finish an associate degree', detail: 'Degrees count from their MCTFS codes whenever they were finished.', effort: 'high', category: 'Mental', next, best: { degree: 'bachelor' } });
  }
  const mosq = line('mos_qual_points');
  if (mosq && !mosq.entered) blank('mos_qual_points', 'MOS qualification points', { mos_qual_points: mosq.max }, { mos_qual_points: 0 }, 'MOL shows them from the JEPES MOS Quals Scoring Table for your PMOS (MARADMIN 046/24).', 'Mental');
  else if (mosq && mosq.value.low < mosq.max) {
    const upTo = gain({ mos_qual_points: mosq.max });
    if (upTo > 0) out.push({ id: 'mos-quals', input: 'mos_qual_points', title: 'Earn the next MOS qualification on the MOL table', detail: `The JEPES MOS Quals Scoring Table on MOL lists each qualification for your PMOS and its points (MARADMIN 046/24), reported through MCTIMS. Up to ${upTo} points are left on this line.`, points: null, upTo, kind: 'points', effort: 'medium', category: 'Mental' });
  }

  const markKeys = ['cmd_mos', 'cmd_leadership', 'cmd_character'] as const;
  const markNames: Record<string, string> = MARK_NAMES;
  for (const key of markKeys) if (num(inputs[key]) === null) blank(key, `${markNames[key]} average`, { [key]: 5 }, { [key]: 0 }, 'Your average mark in grade, as MOL shows it.', 'Command');
  const weakest = markKeys.map((key) => ({ key, mark: num(inputs[key]) })).filter((m): m is { key: (typeof markKeys)[number]; mark: number } => m.mark !== null && m.mark < 5).sort((a, b) => a.mark - b.mark)[0];
  if (weakest) {
    const to = Math.min(5, Math.round((weakest.mark + 0.5) * 1e4) / 1e4);
    step({ id: 'command-input', input: weakest.key, title: `Raise your ${markNames[weakest.key]} average from ${formatMark(weakest.mark)} to ${formatMark(to)}`, detail: 'Marks move when a reporting senior has specific, quantified accomplishments in front of them: take your bullet package to your next counseling.', effort: 'medium', category: 'Command', next: { [weakest.key]: to }, best: { [weakest.key]: 5 } });
  }

  const referrals = Math.max(0, Math.floor(num(inputs.recruiting_referrals) ?? 0));
  step({ id: 'recruiting', input: 'recruiting_referrals', title: 'Refer an applicant who enlists', detail: 'The Command Recruiting Program gives 20 points for each applicant you refer who enlists, to 100 (line 5f), within the bonus’s most of 100.', effort: 'medium', category: 'Bonus', next: { recruiting_referrals: referrals + 1 }, best: { recruiting_referrals: referrals + 5 } });

  // A blank figure first, since until it is entered the estimate is a range; then each step by the points it adds, and
  // a step whose size the tables Vantage holds cannot say after those, by what is left on its line.
  const rank = (l: JepesLever) => (l.kind === 'data' ? 0 : l.points === null ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (b.points ?? 0) - (a.points ?? 0) || b.upTo - a.upTo);
}

/** Every bonus input the tables in force read, for the form. */
export function bonusItems(on: string = localDay()): Array<{ key: BonusKey; label: string; points: number }> {
  return (JEPES_BONUS.inForce(on)?.data.items ?? []).map(({ key, label, points }) => ({ key, label, points }));
}
