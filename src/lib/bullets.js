/**
 * Vantage — bullet composition.
 *
 * The point of logging anything is that it eventually becomes a line on a
 * fitness report, a board package, or a résumé. This module does that
 * conversion mechanically, from fields you already captured, so a year of
 * work doesn't have to be reconstructed from memory the week it's due.
 *
 * It composes; it does not invent. Every figure in an output bullet traces
 * back to a field on a record.
 *
 * Three styles, and they are actually different:
 *
 *   jepes   Full sentence. Names the org and the system. What a board package
 *           wants, because the board is reading a hundred of these and needs
 *           to place you without asking.
 *   fitrep  Compressed. Articles and connective tissue removed, org dropped
 *           (the report already names your unit), figures kept. Built to fit
 *           the space a reporting senior actually has.
 *   resume  Civilian. Acronyms expanded on first use, military framing dropped,
 *           the outcome promoted into the sentence rather than trailing it.
 *           A hiring manager outside the Marine Corps has no idea what a ULO is.
 */

import { formatDollarsExact, formatNumber, formatDTG, toDate } from './metrics.js';
import { JEPES_CORE, SUMMABLE_DOLLAR_TYPES } from './constants.js';

/** Past-tense verbs that survive a board's follow-up question. */
const VERB_BY_DOLLAR_TYPE = {
  reconciled: 'Reconciled',
  obligated: 'Obligated',
  saved: 'Recovered',
  reviewed: 'Reviewed',
  impact: 'Processed',
};

const VERB_BY_CATEGORY = {
  'Fiscal & Financial': 'Executed',
  Leadership: 'Led',
  'Training & PME': 'Completed',
  Administration: 'Processed',
  Operations: 'Executed',
  'Project Work': 'Developed',
  Recognition: 'Earned',
  'Volunteer Service': 'Volunteered',
  Communications: 'Briefed',
  Other: 'Completed',
};

/**
 * Civilian equivalents. A résumé bullet that opens "Executed" reads as filler
 * outside the service; these are the verbs a finance recruiter scans for.
 */
const RESUME_VERB_BY_DOLLAR_TYPE = {
  reconciled: 'Reconciled',
  obligated: 'Committed',
  saved: 'Recovered',
  reviewed: 'Audited',
  impact: 'Managed',
};

const RESUME_VERB_BY_CATEGORY = {
  'Fiscal & Financial': 'Managed',
  Leadership: 'Led',
  'Training & PME': 'Completed',
  Administration: 'Administered',
  Operations: 'Coordinated',
  'Project Work': 'Built',
  Recognition: 'Received',
  'Volunteer Service': 'Volunteered',
  Communications: 'Presented',
  Other: 'Delivered',
};

/**
 * First-use expansions for résumé output. Everyone in a G-8 knows what a ULO
 * is. Nobody on a banking interview panel does, and an unexplained acronym is
 * a line the reader skips.
 */
export const ACRONYM_GLOSS = {
  ULO: 'unliquidated obligation',
  ULOS: 'unliquidated obligations',
  UMT: 'unmatched transaction',
  UMTS: 'unmatched transactions',
  MIPR: 'military interdepartmental purchase request',
  MIPRS: 'military interdepartmental purchase requests',
  DAI: 'Defense Agencies Initiative (DoD financial system of record)',
  SABRS: 'Standard Accounting, Budgeting and Reporting System',
  ADVANA: 'ADVANA (DoD enterprise analytics platform)',
  DTS: 'Defense Travel System',
  'GCSS-MC': 'Global Combat Support System',
  PME: 'professional military education',
  JEPES: 'Junior Enlisted Performance Evaluation System',
  LOA: 'Letter of Appreciation',
  FITREP: 'fitness report',
};

function leadVerb(a, style) {
  const civilian = style === 'resume';
  if (a.dollar_amount && a.dollar_type) {
    const table = civilian ? RESUME_VERB_BY_DOLLAR_TYPE : VERB_BY_DOLLAR_TYPE;
    return table[a.dollar_type] || (civilian ? 'Managed' : 'Processed');
  }
  const table = civilian ? RESUME_VERB_BY_CATEGORY : VERB_BY_CATEGORY;
  return table[a.category] || 'Completed';
}

/** Past-tense openers that mean the title already carries its own action. */
const PAST_VERBS =
  /^(led|ran|built|drove|served|stood|held|processed|reconciled|validated|audited|briefed|mentored|completed|developed|executed|obligated|recovered|deobligated|reviewed|coordinated|managed|trained|drafted|authored|created|designed|delivered|earned|volunteered|supervised|maintained|resolved|corrected|cleared|prepared|conducted|organized|instructed|planned|tracked|updated|submitted|attended|assisted|supported)\b/i;

function titleIsAction(title = '') {
  const first = title.trim().split(/\s+/)[0] || '';
  return PAST_VERBS.test(title) || (/ed$/i.test(first) && first.length > 4);
}

/** "1 ULOs" is the fastest way to look careless on a board package. */
export function unitFor(unit = 'items', n) {
  if (Number(n) !== 1) return unit;
  if (/ies$/i.test(unit)) return unit.replace(/ies$/i, 'y');
  if (/(ch|sh|ss|x|z)es$/i.test(unit)) return unit.replace(/es$/i, '');
  if (/s$/.test(unit) && !/ss$/i.test(unit)) return unit.slice(0, -1);
  return unit;
}

const capitalize = (s = '') => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Expand the first occurrence of each known acronym, once per bullet.
 * "30 ULOs" → "30 unliquidated obligations (ULOs)". Later mentions stay short.
 */
export function expandAcronyms(text = '') {
  if (!text) return text;
  const seen = new Set();
  // The `s?` matters: these acronyms are almost always written plural in the
  // wild — ULOs, UMTs, MIPRs — and \b after an uppercase run never fires when
  // a lowercase plural is hanging off the end.
  return text.replace(/\b([A-Z][A-Z0-9-]{1,9}s?)\b/g, (match) => {
    const key = match.toUpperCase();
    const gloss = ACRONYM_GLOSS[key];
    if (!gloss || seen.has(key)) return match;
    seen.add(key);
    // Some glosses already carry their own parenthetical; don't double it up.
    if (gloss.includes('(')) return gloss;
    return `${gloss} (${match})`;
  });
}

/** Filler a compressed FITREP line can lose without losing meaning. */
const FITREP_CUTS = [
  [/\bin support of\b/gi, 'supporting'],
  [/\btotaling\b/gi, 'valued at'],
  [/\bin order to\b/gi, 'to'],
  [/\ba total of\b/gi, ''],
  [/\bapproximately\b/gi, ''],
  [/\bin excess of\b/gi, 'over'],
  [/\bwas responsible for\b/gi, ''],
];

function compress(sentence = '') {
  let out = sentence;
  for (const [pattern, replacement] of FITREP_CUTS) out = out.replace(pattern, replacement);
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,;.])/g, '$1')
    .replace(/,\s*,/g, ',')
    .trim();
}

/**
 * One activity → one bullet.
 * @param {object} a activity record
 * @param {{ style?: 'jepes'|'fitrep'|'resume', includeDate?: boolean }} opts
 */
export function composeBullet(a = {}, opts = {}) {
  const { style = 'jepes', includeDate = false } = opts;
  const title = String(a.title || '').trim().replace(/\.$/, '');

  // Quick-logged titles are whole sentences that already contain the figures.
  // Restating them produces "Reconciled 30 ULOs totaling $1,118.38 in DAI,
  // 30 ULOs totaling $1,118.38, via DAI", so anything already in the title
  // is suppressed here.
  const titleLower = title.toLowerCase();
  const inTitle = (needle) => Boolean(needle) && titleLower.includes(String(needle).toLowerCase());

  const rawMoney = a.dollar_amount ? formatDollarsExact(a.dollar_amount) : null;
  const money = rawMoney && !(inTitle(rawMoney.slice(1)) || inTitle(String(a.dollar_amount))) ? rawMoney : null;

  // A bare count of one adds nothing. Keep it only when a figure rides along.
  const hasQty = a.quantity != null && a.quantity !== '' && (Number(a.quantity) !== 1 || Boolean(rawMoney));
  const unitLabel = unitFor(a.unit || 'items', a.quantity);
  const showQty = hasQty && !inTitle(`${formatNumber(a.quantity)} ${unitLabel}`);
  const qty = showQty ? `${formatNumber(a.quantity)} ${unitLabel}` : null;
  const joiner = style === 'fitrep' ? 'valued at' : 'totaling';
  const measure = qty && money ? `${qty} ${joiner} ${money}` : qty || money || null;

  const parts = [];

  if (title && titleIsAction(title)) {
    // The title already states the action. Generating a second verb in front of
    // it produces "Volunteered 1 ceremonies in support of served on color guard
    // detail", which is how you lose a reader on the first line.
    parts.push(capitalize(title));
    if (measure) parts.push(`, ${measure},`);
  } else {
    const verb = leadVerb(a, style);
    parts.push(measure ? `${verb} ${measure}` : `${verb} ${lowerFirst(title || 'assigned task')}`);
    if (measure && title) parts.push(`${style === 'fitrep' ? 'supporting' : 'in support of'} ${lowerFirst(title)}`);
  }

  if (a.system && !inTitle(a.system)) parts.push(`via ${a.system}`);

  // The org is worth naming on a board package and redundant on a FITREP,
  // which already carries the unit in its header. A résumé wants the employer
  // line to do that work instead.
  if (a.organization && style === 'jepes' && !inTitle(a.organization)) parts.push(`for ${a.organization}`);

  let sentence = parts
    .join(' ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/,$/, '');

  if (a.result) {
    const result = lowerFirst(a.result.trim().replace(/\.$/, ''));
    // A résumé bullet reads better when the outcome is load-bearing inside the
    // sentence than when it's bolted on after a semicolon.
    sentence += style === 'resume' ? `, resulting in ${result}` : `; ${result}`;
  }

  if (style === 'fitrep') sentence = compress(sentence);
  if (style === 'resume') sentence = expandAcronyms(sentence);

  if (includeDate && a.date) sentence += ` (${formatDTG(a.date)})`;

  sentence = capitalize(sentence);
  if (!/[.!?]$/.test(sentence)) sentence += '.';
  return sentence;
}

function lowerFirst(s = '') {
  if (!s) return s;
  // Leave acronyms alone — "ULO" must not become "uLO".
  if (/^[A-Z0-9&/-]{2,}\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Many activities sharing a unit → one rolled-up bullet.
 * This is usually the stronger bullet: "corrected 30 ULOs" beats thirty
 * separate lines each correcting one.
 */
export function composeRollup(activities = [], opts = {}) {
  const { label = 'fiscal actions', period = '', style = 'jepes' } = opts;
  if (!activities.length) return null;

  const unitTotals = {};
  let dollars = 0;
  let reviewed = 0;
  const orgs = new Set();
  const systems = new Set();

  for (const a of activities) {
    if (a.quantity) {
      const unit = (a.unit || 'items').trim();
      unitTotals[unit] = (unitTotals[unit] || 0) + a.quantity;
    }
    if (a.dollar_amount) {
      if (SUMMABLE_DOLLAR_TYPES.includes(a.dollar_type || 'impact')) dollars += a.dollar_amount;
      else reviewed += a.dollar_amount;
    }
    if (a.organization) orgs.add(a.organization);
    if (a.system) systems.add(a.system);
  }

  const unitPhrase = Object.entries(unitTotals)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 3)
    .map(([unit, total]) => `${formatNumber(total)} ${unitFor(unit, total)}`)
    .join(', ');

  const segs = [];
  segs.push(`Across ${activities.length} logged ${activities.length === 1 ? 'action' : 'actions'}${period ? ` in ${period}` : ''}`);
  if (unitPhrase) segs.push(`processed ${unitPhrase}`);
  if (dollars) segs.push(`${unitPhrase ? 'representing' : 'processed'} ${formatDollarsExact(dollars)} in ${label}`);
  if (reviewed) segs.push(`with an additional ${formatDollarsExact(reviewed)} reviewed`);
  if (systems.size) segs.push(`using ${[...systems].slice(0, 3).join(', ')}`);
  if (orgs.size === 1 && style !== 'resume') segs.push(`for ${[...orgs][0]}`);

  let out = segs.join(', ').replace(/,\s*,/g, ',');
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (style === 'resume') out = expandAcronyms(out);
  if (style === 'fitrep') out = compress(out);
  return out.endsWith('.') ? out : `${out}.`;
}

/** Group a period's activities into a track's scored areas. */
export function groupByAreas(activities = [], areas = JEPES_CORE) {
  const groups = areas.map((area) => ({
    area,
    activities: activities.filter((a) => a.jepes_area === area),
  }));
  const unassigned = activities.filter((a) => !a.jepes_area || !areas.includes(a.jepes_area));
  if (unassigned.length) groups.push({ area: 'Unassigned', activities: unassigned });
  return groups;
}

/** Back-compat wrapper: the three JEPES areas. */
export function groupByJepes(activities = []) {
  return groupByAreas(activities, JEPES_CORE);
}

/**
 * Full package: rolled-up + individual bullets per JEPES area, strongest first.
 * "Strongest" = has a dollar figure, then a quantity, then a stated result.
 *
 * `withheld` is the count this group had to leave out. A package that quietly
 * drops two thirds of a fiscal year is worse than no package, because you'd
 * never know to go looking for the rest.
 */
export function buildPackage(activities = [], opts = {}) {
  const { periodLabel = '', style = 'jepes', limitPerArea = 8, areas = JEPES_CORE } = opts;
  const cap = !limitPerArea || limitPerArea === Infinity ? Infinity : limitPerArea;

  return groupByAreas(activities, areas).map(({ area, activities: items }) => {
    const ranked = [...items].sort((a, b) => strength(b) - strength(a));
    const shown = cap === Infinity ? ranked : ranked.slice(0, cap);
    return {
      area,
      count: items.length,
      withheld: Math.max(0, items.length - shown.length),
      rollup: composeRollup(items, { period: periodLabel, style }),
      bullets: shown.map((a) => ({
        id: a.id,
        text: composeBullet(a, { style }),
        date: a.date,
        strength: strength(a),
      })),
    };
  });
}

/** 0–4. Drives ordering and the strength pips in the UI. */
export function strength(a = {}) {
  let s = 0;
  if (a.dollar_amount) s += 2;
  if (a.quantity) s += 1;
  if (a.result) s += 1;
  return s;
}

/**
 * What this record is missing before it makes a defensible bullet.
 *
 * Ordered by how much each gap actually costs the bullet. Optional supporting
 * material is deliberately excluded by default: a complete activity record
 * stands on its own, and users should never need to build a second filing
 * system just to satisfy the quality coach.
 */
export function weaknesses(a = {}, opts = {}) {
  const { includeEvidence = false } = opts;
  const gaps = [];
  if (!a.result) gaps.push('no stated outcome — so what?');
  if (!a.quantity) gaps.push('no quantity — how many?');
  if (!a.dollar_amount && a.category === 'Fiscal & Financial') gaps.push('no dollar figure');
  if (!a.jepes_area || a.jepes_area === 'Unassigned') gaps.push('not mapped to a JEPES area');
  if (includeEvidence && !a.evidence_links?.length) gaps.push('no supporting material linked');
  return gaps;
}

/** Plain-text export of a package, ready to paste into a document. */
export function packageToText(pkg = [], header = '') {
  const lines = [];
  if (header) {
    lines.push(header.toUpperCase(), '='.repeat(header.length), '');
  }
  for (const group of pkg) {
    if (!group.count) continue;
    lines.push(group.area.toUpperCase());
    lines.push('-'.repeat(group.area.length));
    if (group.rollup) lines.push(`  ${group.rollup}`, '');
    for (const b of group.bullets) lines.push(`  - ${b.text}`);
    if (group.withheld > 0) {
      lines.push(
        `  ...and ${group.withheld} further ${group.withheld === 1 ? 'entry' : 'entries'} not shown at the current limit.`
      );
    }
    lines.push('');
  }
  const sorted = [...pkg].filter((g) => g.count);
  if (!sorted.length) lines.push('No activities in this period.');
  return lines.join('\n');
}

/** Sort helper used by the review queue: weakest records first, so they get fixed. */
export function byWeakestFirst(a, b) {
  const d = strength(a) - strength(b);
  if (d !== 0) return d;
  return (toDate(b.date)?.getTime() || 0) - (toDate(a.date)?.getTime() || 0);
}
