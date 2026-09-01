import { aggregateMetrics, activitiesInRange, previousRange, delta, formatDTG } from './metrics.js';
import { DOLLAR_TYPES, JEPES_CORE, CATEGORIES } from './constants.js';

function movement(current, prior) {
  const diff = current - prior;
  const pct = delta(current, prior);
  return {
    current,
    prior,
    diff,
    pct,
    direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    isNew: prior === 0 && current > 0,
    lapsed: current === 0 && prior > 0,
  };
}

export function comparePeriods(activities = [], range, extras = {}) {
  const areas = extras.areas || JEPES_CORE;
  const prior = previousRange(range);

  const now = activitiesInRange(activities, range);
  const before = activitiesInRange(activities, prior);

  const a = aggregateMetrics(now);
  const b = aggregateMetrics(before);

  const headline = {
    activities: movement(a.totalActivities, b.totalActivities),
    dollars: movement(a.totalDollars, b.totalDollars),
    reviewed: movement(a.reviewedDollars, b.reviewedDollars),
    quantity: movement(a.totalQuantity, b.totalQuantity),
    withOutcome: movement(
      now.filter((x) => x.result).length,
      before.filter((x) => x.result).length
    ),
  };

  const byDollarType = DOLLAR_TYPES.map((d) => ({
    key: d.key,
    label: d.label,
    summable: d.summable,
    ...movement(a.dollarsByType[d.key] || 0, b.dollarsByType[d.key] || 0),
  })).filter((row) => row.current || row.prior);

  const byJepes = areas.map((area) => ({
    area,
    ...movement(a.byJepes[area]?.count || 0, b.byJepes[area]?.count || 0),
    dollars: movement(a.byJepes[area]?.dollars || 0, b.byJepes[area]?.dollars || 0),
  }));

  const byCategory = CATEGORIES.map((cat) => ({
    category: cat,
    ...movement(a.byCategory[cat]?.count || 0, b.byCategory[cat]?.count || 0),
  }))
    .filter((row) => row.current || row.prior)
    .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

  const unitKeys = new Set([...a.byUnit.map((u) => u.unit), ...b.byUnit.map((u) => u.unit)]);
  const byUnit = [...unitKeys]
    .map((unit) => {
      const cur = a.byUnit.find((u) => u.unit === unit)?.total || 0;
      const pre = b.byUnit.find((u) => u.unit === unit)?.total || 0;
      return { unit, ...movement(cur, pre) };
    })
    .sort((x, y) => y.current - x.current);

  const notes = [];
  const emptyAreas = byJepes.filter((j) => j.current === 0);
  if (emptyAreas.length) {
    notes.push(
      `No entries this period under ${emptyAreas.map((j) => j.area.replace(' / Mission Accomplishment', '')).join(' or ')}. A board reads all three areas.`
    );
  }
  const revived = byUnit.filter((u) => u.isNew);
  if (revived.length) {
    notes.push(`New this period: ${revived.slice(0, 4).map((u) => u.unit).join(', ')}.`);
  }
  const dropped = byUnit.filter((u) => u.lapsed);
  if (dropped.length) {
    notes.push(`Nothing logged this period for ${dropped.slice(0, 4).map((u) => u.unit).join(', ')}.`);
  }
  const outcomeRate = now.length ? Math.round((headline.withOutcome.current / now.length) * 100) : 0;
  const priorRate = before.length ? Math.round((headline.withOutcome.prior / before.length) * 100) : 0;
  if (now.length >= 3) {
    notes.push(
      `${outcomeRate}% of entries carry a stated outcome, against ${priorRate}% last period. Entries without one do not survive a follow-up question.`
    );
  }

  return {
    range,
    prior,
    label: {
      current: range.label || `${formatDTG(range.start)} — ${formatDTG(range.end)}`,
      prior: `${formatDTG(prior.start)} — ${formatDTG(prior.end)}`,
    },
    counts: { current: now.length, prior: before.length },
    activities: { current: now, prior: before },
    headline,
    byDollarType,
    byJepes,
    byCategory,
    byUnit,
    notes,
    extras: {
      recognitions: movement(
        countIn(extras.recognitions, range),
        countIn(extras.recognitions, prior)
      ),
      trainingHours: movement(
        sumIn(extras.trainings, range, 'hours'),
        sumIn(extras.trainings, prior, 'hours')
      ),
      goalsAchieved: movement(
        (extras.goals || []).filter((g) => g.status === 'achieved').length,
        0
      ),
    },
  };
}

const inRange = (value, range) => {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d >= range.start && d <= range.end;
};

const countIn = (list = [], range) => (list || []).filter((r) => inRange(r.date, range)).length;
const sumIn = (list = [], range, field) =>
  (list || []).filter((r) => inRange(r.date, range)).reduce((n, r) => n + (Number(r[field]) || 0), 0);

export function arrow(direction) {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—';
}

export function comparisonToText(cmp, header = '') {
  const lines = [];
  if (header) lines.push(header.toUpperCase(), '='.repeat(header.length), '');
  lines.push(`CURRENT   ${cmp.label.current}`);
  lines.push(`PRIOR     ${cmp.label.prior}`, '');

  const row = (label, m, fmt = (v) => String(v)) => {
    const sign = m.diff > 0 ? '+' : '';
    const pct = m.pct == null ? 'n/a' : `${m.pct > 0 ? '+' : ''}${m.pct}%`;
    lines.push(`  ${label.padEnd(30)} ${fmt(m.current).padStart(14)}   was ${fmt(m.prior).padStart(14)}   ${sign}${fmt(m.diff)} (${pct})`);
  };

  const usd = (v) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

  lines.push('HEADLINE', '-'.repeat(8));
  row('Entries logged', cmp.headline.activities);
  row('Dollar impact', cmp.headline.dollars, usd);
  row('Units processed', cmp.headline.quantity);
  row('Entries with outcome', cmp.headline.withOutcome);
  lines.push('');

  if (cmp.byDollarType.length) {
    lines.push('DOLLARS BY TYPE', '-'.repeat(15));
    for (const d of cmp.byDollarType) row(d.label + (d.summable ? '' : ' (excluded)'), d, usd);
    lines.push('');
  }

  lines.push('JEPES BALANCE', '-'.repeat(13));
  for (const j of cmp.byJepes) row(j.area, j);
  lines.push('');

  if (cmp.notes.length) {
    lines.push('NOTES', '-'.repeat(5));
    for (const n of cmp.notes) lines.push(`  - ${n}`);
  }

  return lines.join('\n');
}
