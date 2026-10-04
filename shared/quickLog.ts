import { suggestCategory, suggestEvalArea, UNIT_SUGGESTIONS } from './constants.ts';
import { subDays, startOfDay, parse, isValid } from 'date-fns';

const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'totaling', 'totalling', 'worth',
  'amounting', 'across', 'over', 'via', 'plus', 'about', 'approximately', 'roughly', 'per', 'each', 'more', 'than',
  'after', 'before', 'during', 'through', 'while', 'last', 'this', 'next',
]);
const SYSTEMS = ['DAI', 'ADVANA', 'SABRS', 'GCSS-MC', 'DTS', 'WAWF', 'iRAPT', 'PRISM', 'MCTFS', 'FMS', 'GFEBS', 'CDD', 'EDA', 'SAM', 'MOCAS', 'IPAC', 'MarineNet', 'MCTIMS', 'MOL'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A date written without a year is the latest one not yet to come: Quick Log records work already done. */
function latest(d: Date, now: Date, yearGiven: boolean): Date {
  if (yearGiven || d <= now) return d;
  const prior = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
  return prior.getMonth() === d.getMonth() ? prior : d;
}

const MONTH = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
// Only a written-out year, or '26: "On 30 Sep 14 UDOs closed" is fourteen UDOs, not 2014.
const YEAR = `(?:,?\\s+((?:19|20)\\d{2})|\\s*['’](\\d{2}))?\\b`;
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH})\\b\\.?${YEAR}`, 'i');
const MONTH_FIRST = new RegExp(`\\b(${MONTH})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b${YEAR}`, 'i');
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY = new RegExp(`\\b(?:last\\s+)?(${WEEKDAYS.join('|')})\\b`, 'i');

function dayMonth(day: string, month: string, year4: string | undefined, year2: string | undefined, now: Date): Date | null {
  const year = year4 || (year2 ? `20${year2}` : String(now.getFullYear()));
  const d = parse(`${day} ${month.slice(0, 3)} ${year}`, 'd MMM yyyy', new Date());
  return isValid(d) ? startOfDay(latest(d, now, Boolean(year4 || year2))) : null;
}

function parseWhen(text: string, now: Date): { date: Date; matched: string | null } {
  const lower = text.toLowerCase();
  if (/\byesterday\b/.test(lower)) return { date: startOfDay(subDays(now, 1)), matched: 'yesterday' };
  if (/\btoday\b/.test(lower)) return { date: startOfDay(now), matched: 'today' };
  if (/\blast week\b/.test(lower)) return { date: startOfDay(subDays(now, 7)), matched: 'last week' };
  const daysAgo = lower.match(/\b(\d{1,2})\s+days?\s+ago\b/);
  if (daysAgo) return { date: startOfDay(subDays(now, parseInt(daysAgo[1], 10))), matched: daysAgo[0] };
  const dmy = text.match(DAY_FIRST);
  const dmyDate = dmy && dayMonth(dmy[1], dmy[2], dmy[3], dmy[4], now);
  if (dmy && dmyDate) return { date: dmyDate, matched: dmy[0] };
  // "Sep 30", "September 30", "Sept. 30, 2026": how most US users write a date.
  const mdy = text.match(MONTH_FIRST);
  // Lowercase "march" and "may" are words before they are months: "led a road march 2 hours" is two hours, not March 2.
  const word = mdy && /^(?:march|may)$/.test(mdy[1]);
  const mdyDate = mdy && !word && dayMonth(mdy[2], mdy[1], mdy[3], mdy[4], now);
  if (mdy && mdyDate) return { date: mdyDate, matched: mdy[0] };
  // "3/4 of the backlog" is a fraction.
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b(?!\s+of\b)/);
  if (slash) {
    const y = slash[3] ? (slash[3].length === 2 ? 2000 + +slash[3] : +slash[3]) : now.getFullYear();
    const [month, day] = [+slash[1], +slash[2]];
    const d = new Date(y, month - 1, day);
    // 13/45 is not a date; JavaScript would roll it over into one.
    if (d.getMonth() === month - 1 && d.getDate() === day) return { date: startOfDay(latest(d, now, Boolean(slash[3]))), matched: slash[0] };
  }
  // "Friday", "on Friday", "last Friday": the most recent one before today, since the work is already done.
  const weekday = text.match(WEEKDAY);
  if (weekday) {
    const back = (now.getDay() - WEEKDAYS.indexOf(weekday[1].toLowerCase()) + 7) % 7 || 7;
    return { date: startOfDay(subDays(now, back)), matched: weekday[0] };
  }
  return { date: startOfDay(now), matched: null };
}

export interface ParsedQuickLog {
  title: string; quantities: Array<{ value: number; unit: string }>; dollar_amount: number | null; dollar_type: string;
  category: string; eval_area: string; system: string | null; date: Date; inferred: string[];
  /** What came of it, when the sentence ends by saying so ("…, all cleared on the next report"). */
  result: string | null;
}

// A trailing clause that says what came of the work, after a comma, semicolon or dash. Only words that open an outcome
// count, so "for G-8, S-4 and S-1" stays in the title. The lead-in that only links the clause is dropped.
const RESULT_CLAUSE = /\s*(?:[,;]|\s[-–—])\s*((?:resulting in|which|so that|so|leading to|saving|clearing|cutting|reducing|all|each|every one|zero|no)\b.+)$/i;
const RESULT_LINK = /^(?:resulting in|leading to|which|so that|so)\s+/i;

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mil: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

export function parseQuickLog(text = '', now = new Date()): ParsedQuickLog {
  const raw = text.trim();
  const inferred: string[] = [];
  let dollar_amount: number | null = null;
  // "$1.2 million", "$3M", "$1.234M", "$10.999": the whole figure, scaled, then to the cent.
  const dollarMatches = [...raw.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(thousand|million|billion|mil|mm|bn|k|m|b)?\b/gi)];
  if (dollarMatches.length) {
    let total = 0;
    for (const m of dollarMatches) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isNaN(v)) continue;
      total += v * (SCALE[(m[2] || '').toLowerCase()] || 1);
    }
    dollar_amount = Math.round(total * 100) / 100;
    inferred.push(dollarMatches.length > 1 ? `summed ${dollarMatches.length} dollar figures` : 'dollar figure');
  }
  const lower = raw.toLowerCase();
  let dollar_type = 'impact';
  if (/reconcil/.test(lower)) dollar_type = 'reconciled';
  else if (/deobligat|recover|saved|savings|avoided/.test(lower)) dollar_type = 'saved';
  else if (/obligat|committed/.test(lower)) dollar_type = 'obligated';
  else if (/review|validat|audit/.test(lower)) dollar_type = 'reviewed';
  if (dollar_amount) inferred.push(`type: ${dollar_type}`);

  const when = parseWhen(raw, now);
  if (when.matched) inferred.push(`date: ${when.matched}`);

  // Blank the dollar figures in one pass; a replace per figure is quadratic on a pasted ledger.
  let scan = '';
  let at = 0;
  for (const dm of dollarMatches) { scan += raw.slice(at, dm.index) + ' '.repeat(dm[0].length); at = dm.index + dm[0].length; }
  scan += raw.slice(at);
  if (when.matched) scan = scan.replace(new RegExp(escapeRe(when.matched), 'i'), (s) => ' '.repeat(s.length));

  const quantities: Array<{ value: number; unit: string }> = [];
  const pattern = /\b(\d+(?:,\d{3})*(?:\.\d+)?)\s+([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)?)/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(scan)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(value)) continue;
    const words = m[2].trim().split(/\s+/).filter((w) => !STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    // A plural is the whole unit ("7 MIPRs after lunch"); a modifier needs its noun ("9 travel claims", "4 DTS vouchers", "5 status reports").
    const unit = /[^isu]s$/.test(words[0]) ? words[0] : words.join(' ');
    if (STOPWORDS.has(unit.toLowerCase())) continue;
    if (/^(days?|weeks?|months?|years?)\b/i.test(unit)) continue;
    const known = UNIT_SUGGESTIONS.find((u) => u.toLowerCase() === unit.toLowerCase());
    quantities.push({ value, unit: known || unit });
  }
  const byUnit: Record<string, { value: number; unit: string }> = {};
  for (const q of quantities) {
    const k = q.unit.toLowerCase();
    if (!byUnit[k] || q.value > byUnit[k].value) byUnit[k] = q;
  }
  const deduped = Object.values(byUnit);
  if (deduped.length === 1) inferred.push(`${deduped[0].value.toLocaleString('en-US')} ${deduped[0].unit}`);
  else if (deduped.length > 1) inferred.push(`${deduped.length} quantities`);

  const system = SYSTEMS.find((s) => new RegExp(`\\b${s.replace(/[-/]/g, '[-/]')}\\b`, 'i').test(raw)) || null;
  if (system) inferred.push(`system: ${system}`);

  const category = suggestCategory(raw);
  const eval_area = suggestEvalArea(raw, category);
  inferred.push(`category: ${category}`);

  let title = raw;
  // The date leaves the title with the word that introduced it: "…in DAI on Sep 30" is "…in DAI", not "…in DAI on".
  if (when.matched) title = title.replace(new RegExp(`\\s*(?:\\b(?:on|dated|as of)\\s+)?\\b${escapeRe(when.matched)}\\b\\s*`, 'i'), ' ').trim();
  title = title.replace(/\s+/g, ' ').replace(/[,;]\s*$/, '');
  let result: string | null = null;
  const outcome = RESULT_CLAUSE.exec(title);
  if (outcome && outcome.index >= 8) {
    const said = outcome[1].replace(RESULT_LINK, '').replace(/[.;,]\s*$/, '').trim();
    if (said.length >= 6) { result = said; title = title.slice(0, outcome.index).trim(); inferred.push('outcome'); }
  }

  return { title: title || raw, quantities: deduped, dollar_amount, dollar_type, category, eval_area, system, date: when.date, inferred, result };
}

export function primaryQuantity(quantities: Array<{ value: number; unit: string }> = []): { quantity: number | null; unit: string } {
  if (!quantities.length) return { quantity: null, unit: '' };
  const primary = [...quantities].sort((a, b) => b.value - a.value)[0];
  return { quantity: primary.value, unit: primary.unit };
}
