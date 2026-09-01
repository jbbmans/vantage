import { suggestCategory, suggestJepesArea, UNIT_SUGGESTIONS } from './constants.js';
import { subDays, startOfDay, parse, isValid } from 'date-fns';

const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'to', 'for', 'with', 'in', 'on', 'at', 'by',
  'from', 'totaling', 'totalling', 'worth', 'amounting', 'across', 'over', 'via',
  'plus', 'about', 'approximately', 'roughly', 'per', 'each', 'more', 'than',
]);

const SYSTEMS = [
  'DAI', 'ADVANA', 'SABRS', 'GCSS-MC', 'DTS', 'WAWF', 'iRAPT', 'PRISM', 'MCTFS',
  'FMS', 'GFEBS', 'CDD', 'EDA', 'SAM', 'MOCAS', 'IPAC', 'MarineNet',
];

function parseWhen(text, now = new Date()) {
  const lower = text.toLowerCase();
  if (/\byesterday\b/.test(lower)) return { date: startOfDay(subDays(now, 1)), matched: 'yesterday' };
  if (/\btoday\b/.test(lower)) return { date: startOfDay(now), matched: 'today' };
  if (/\blast week\b/.test(lower)) return { date: startOfDay(subDays(now, 7)), matched: 'last week' };
  const daysAgo = lower.match(/\b(\d{1,2})\s+days?\s+ago\b/);
  if (daysAgo) {
    return { date: startOfDay(subDays(now, parseInt(daysAgo[1], 10))), matched: daysAgo[0] };
  }

  const dmy = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(\s+\d{2,4})?\b/i);
  if (dmy) {
    const year = dmy[3] ? dmy[3].trim() : String(now.getFullYear());
    const full = `${dmy[1]} ${dmy[2].slice(0, 3)} ${year.length === 2 ? `20${year}` : year}`;
    const d = parse(full, 'd MMM yyyy', new Date());
    if (isValid(d)) return { date: startOfDay(d), matched: dmy[0] };
  }
  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const y = slash[3] ? (slash[3].length === 2 ? 2000 + +slash[3] : +slash[3]) : now.getFullYear();
    const d = new Date(y, +slash[1] - 1, +slash[2]);
    if (isValid(d)) return { date: startOfDay(d), matched: slash[0] };
  }
  return { date: startOfDay(now), matched: null };
}

export function parseQuickLog(text = '', now = new Date()) {
  const raw = text.trim();
  const inferred = [];

  let dollar_amount = null;
  const dollarMatches = [...raw.matchAll(/\$\s?([\d,]+(?:\.\d{1,2})?)(\s?[kKmM]\b)?/g)];
  if (dollarMatches.length) {
    let total = 0;
    for (const m of dollarMatches) {
      let v = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isNaN(v)) continue;
      const suffix = (m[2] || '').trim().toLowerCase();
      if (suffix === 'k') v *= 1_000;
      if (suffix === 'm') v *= 1_000_000;
      total += v;
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

  let scan = raw;
  for (const dm of dollarMatches) {
    scan = scan.replace(dm[0], ' '.repeat(dm[0].length));
  }
  if (when.matched) {
    scan = scan.replace(new RegExp(escapeRe(when.matched), 'i'), (s) => ' '.repeat(s.length));
  }

  const quantities = [];
  const pattern = /\b(\d+(?:,\d{3})*(?:\.\d+)?)\s+([A-Za-z][A-Za-z-]*(?:\s+[A-Za-z][A-Za-z-]*)?)/g;
  let m;
  while ((m = pattern.exec(scan)) !== null) {
    const value = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(value)) continue;
    let unit = m[2].trim();

    const words = unit.split(/\s+/).filter((w) => !STOPWORDS.has(w.toLowerCase()));
    if (!words.length) continue;
    unit = words.join(' ');
    if (STOPWORDS.has(unit.toLowerCase())) continue;
    if (/^(days?|weeks?|months?|years?)\b/i.test(unit)) continue;

    const known = UNIT_SUGGESTIONS.find((u) => u.toLowerCase() === unit.toLowerCase());
    quantities.push({ value, unit: known || unit });
  }

  const byUnit = {};
  for (const q of quantities) {
    const k = q.unit.toLowerCase();
    if (!byUnit[k] || q.value > byUnit[k].value) byUnit[k] = q;
  }
  const deduped = Object.values(byUnit);
  if (deduped.length) inferred.push(`${deduped.length} quantit${deduped.length === 1 ? 'y' : 'ies'}`);

  const system = SYSTEMS.find((s) => new RegExp(`\\b${s.replace(/[-/]/g, '[-/]')}\\b`, 'i').test(raw)) || null;
  if (system) inferred.push(`system: ${system}`);

  const category = suggestCategory(raw);
  const jepes_area = suggestJepesArea(raw, category);
  inferred.push(`category: ${category}`);

  let title = raw;
  if (when.matched) title = title.replace(new RegExp(`\\s*\\b${escapeRe(when.matched)}\\b\\s*`, 'i'), ' ').trim();
  title = title.replace(/\s+/g, ' ').replace(/[,;]\s*$/, '');

  return {
    title: title || raw,
    quantities: deduped,
    dollar_amount,
    dollar_type,
    category,
    jepes_area,
    system,
    date: when.date,
    inferred,
  };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function primaryQuantity(quantities = []) {
  if (!quantities.length) return { quantity: null, unit: '' };
  const primary = [...quantities].sort((a, b) => b.value - a.value)[0];
  return { quantity: primary.value, unit: primary.unit };
}
