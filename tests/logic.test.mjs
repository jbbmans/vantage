import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} — ${err.message}`]);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} — ${err.message}`]);
  }
}

const M = await import('../src/lib/metrics.js');
const C = await import('../src/lib/constants.js');
const B = await import('../src/lib/bullets.js');
const Q = await import('../src/lib/quickLogParser.js');
const N = await import('../src/lib/narrative.js');
const D = await import('../src/lib/duplicates.js');
const J = await import('../src/lib/jepes.js');
const H = await import('../src/lib/health.js');
const E = await import('../src/lib/evaluation.js');
const N2 = await import('../src/lib/narrative.js');

test('FY starts 1 October', () => {
  assert.equal(M.fiscalYearOf(new Date(2025, 8, 30)), 2025);
  assert.equal(M.fiscalYearOf(new Date(2025, 9, 1)), 2026);
});

test('FY range spans Oct 1 to Sep 30', () => {
  const r = M.fiscalYearRange(new Date(2026, 1, 15));
  assert.equal(r.start.getFullYear(), 2025);
  assert.equal(r.start.getMonth(), 9);
  assert.equal(r.start.getDate(), 1);
  assert.equal(r.end.getFullYear(), 2026);
  assert.equal(r.end.getMonth(), 8);
  assert.equal(r.end.getDate(), 30);
  assert.equal(r.label, 'FY26');
});

test('fiscal quarters map Oct-Dec to Q1', () => {
  assert.equal(M.fiscalQuarterOf(new Date(2025, 9, 5)), 1);
  assert.equal(M.fiscalQuarterOf(new Date(2026, 0, 5)), 2);
  assert.equal(M.fiscalQuarterOf(new Date(2026, 3, 5)), 3);
  assert.equal(M.fiscalQuarterOf(new Date(2026, 6, 5)), 4);
});

test('fiscal quarter range covers exactly three months', () => {
  const r = M.fiscalQuarterRange(new Date(2026, 7, 19));
  assert.equal(r.label, 'FY26 Q4');
  assert.equal(r.start.getMonth(), 6);
  assert.equal(r.end.getMonth(), 8);
  assert.equal(r.end.getDate(), 30);
});

test('FY progress stays within bounds', () => {
  const p = M.fiscalYearProgress(new Date(2026, 7, 19));
  assert.ok(p.fraction > 0 && p.fraction <= 1);
  assert.ok(p.total === 365 || p.total === 366);
});

const sample = [
  { date: '2026-08-01', category: 'Fiscal & Financial', jepes_area: 'MOS / Mission Accomplishment', quantity: 30, unit: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled' },
  { date: '2026-08-02', category: 'Fiscal & Financial', jepes_area: 'MOS / Mission Accomplishment', quantity: 5, unit: 'UMTs', dollar_amount: 4000000, dollar_type: 'reviewed' },
  { date: '2026-08-03', category: 'Leadership', jepes_area: 'Leadership', quantity: 22, unit: 'Marines' },
  { date: '2026-08-03', category: 'Fiscal & Financial', jepes_area: 'MOS / Mission Accomplishment', quantity: 10, unit: 'ULOs', dollar_amount: 500, dollar_type: 'saved' },
];

test('reviewed dollars are excluded from the headline total', () => {
  const m = M.aggregateMetrics(sample);
  assert.equal(m.totalDollars, 1618.38);
  assert.equal(m.reviewedDollars, 4000000);
});

test('quantities roll up per unit, not across units', () => {
  const m = M.aggregateMetrics(sample);
  const ulos = m.byUnit.find((u) => u.unit === 'ulos');
  assert.equal(ulos.total, 40);
  assert.equal(ulos.count, 2);
  assert.equal(m.totalQuantity, 67);
});

test('category and JEPES buckets both count every record', () => {
  const m = M.aggregateMetrics(sample);
  assert.equal(m.byCategory['Fiscal & Financial'].count, 3);
  assert.equal(m.byJepes['Leadership'].count, 1);
  assert.equal(m.totalActivities, 4);
});

test('empty input aggregates to zeroes, not NaN', () => {
  const m = M.aggregateMetrics([]);
  assert.equal(m.totalDollars, 0);
  assert.equal(m.totalQuantity, 0);
  assert.equal(m.totalActivities, 0);
  assert.deepEqual(m.byUnit, []);
});

test('dollar abbreviation thresholds', () => {
  assert.equal(M.formatDollars(0), '$0');
  assert.equal(M.formatDollars(940), '$940');
  assert.equal(M.formatDollars(18600), '$18.6K');
  assert.equal(M.formatDollars(1240000), '$1.24M');
  assert.equal(M.formatDollars(-500), '-$500');
});

test('exact dollars keep cents', () => {
  assert.equal(M.formatDollarsExact(1118.38), '$1,118.38');
  assert.equal(M.formatDollarsExact(0), '$0.00');
});

test('bad dates degrade to a dash, not Invalid Date', () => {
  assert.equal(M.formatDate(null), '—');
  assert.equal(M.formatDate('not-a-date'), '—');
  assert.equal(M.toDate('not-a-date'), null);
});

test('delta handles a zero baseline without dividing by zero', () => {
  assert.equal(M.delta(5, 0), null);
  assert.equal(M.delta(0, 0), 0);
  assert.equal(M.delta(150, 100), 50);
  assert.equal(M.delta(50, 100), -50);
});

test('previous range is the same length and does not overlap', () => {
  const r = M.rangeForPeriod('month', new Date(2026, 7, 19));
  const p = M.previousRange(r);
  assert.ok(p.end < r.start);
  const span = (d) => d.end - d.start;
  assert.ok(Math.abs(span(p) - span(r)) < 1000 * 60 * 60 * 24);
});

test('streak counts back from today', () => {


  const ref = new Date(2026, 7, 19, 12);
  const iso = (d) => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  const day = (n) => { const d = new Date(ref); d.setDate(d.getDate() - n); return iso(d); };
  const list = [{ date: day(0) }, { date: day(1) }, { date: day(2) }, { date: day(5) }];
  assert.equal(M.currentStreak(list, ref), 3);
  assert.equal(M.daysSinceLastActivity(list, ref), 0);
});

test('streak of zero when nothing recent', () => {
  assert.equal(M.currentStreak([{ date: '2020-01-01' }]), 0);
  assert.equal(M.currentStreak([]), 0);
});

test('bullet folds quantity, dollars, system and result into one line', () => {
  const text = B.composeBullet({
    title: 'FY26 year-end close',
    category: 'Fiscal & Financial',
    quantity: 30,
    unit: 'ULOs',
    dollar_amount: 1118.38,
    dollar_type: 'reconciled',
    system: 'DAI',
    organization: 'G-8',
    result: 'cleared the section backlog',
  });
  assert.ok(text.startsWith('Reconciled 30 ULOs totaling $1,118.38'), text);
  assert.ok(text.includes('via DAI'), text);
  assert.ok(text.includes('for G-8'), text);
  assert.ok(text.endsWith('cleared the section backlog.'), text);
});

test('bullet works with no figures at all', () => {
  const text = B.composeBullet({ title: 'Stood duty as section watch', category: 'Operations' });
  assert.ok(text.length > 10);
  assert.ok(text.endsWith('.'));
  assert.equal(text[0], text[0].toUpperCase());
});

test('acronyms survive lowercasing', () => {
  const text = B.composeBullet({ title: 'ULO reconciliation drill', category: 'Fiscal & Financial' });
  assert.ok(text.includes('ULO'), text);
  assert.ok(!text.includes('uLO'), text);
});

test('strength scoring and gap detection agree', () => {
  const strong = { dollar_amount: 100, quantity: 5, result: 'done', jepes_area: 'Leadership', evidence_links: [{ url: 'x' }] };
  assert.equal(B.strength(strong), 4);
  assert.equal(B.weaknesses(strong).length, 0);

  const weak = { title: 'did a thing' };
  assert.equal(B.strength(weak), 0);
  assert.ok(B.weaknesses(weak).length >= 3);
});

test('rollup sums summable dollars and separates reviewed', () => {
  const text = B.composeRollup(sample, { period: 'FY26' });
  assert.ok(text.includes('$1,618.38'), text);
  assert.ok(text.includes('$4,000,000.00'), text);
  assert.ok(text.includes('reviewed'), text);
});

test('action amount and transaction value aggregate independently by dollar type', () => {
  const metrics = M.aggregateMetrics([
    { quantity: 30, unit: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled' },
    { quantity: 5, unit: 'UMTs', dollar_amount: 4000000, dollar_type: 'reviewed' },
    { quantity: 2, unit: 'MIPRs', dollar_amount: 90000, dollar_type: 'obligated' },
  ]);

  assert.equal(metrics.totalQuantity, 37);
  assert.equal(metrics.totalDollars, 91118.38);
  assert.equal(metrics.reviewedDollars, 4000000);
  assert.deepEqual(metrics.dollarsByType, {
    reconciled: 1118.38,
    reviewed: 4000000,
    obligated: 90000,
  });
});

test('package groups into the three scored JEPES areas', () => {
  const pkg = B.buildPackage(sample, { periodLabel: 'FY26' });
  const areas = pkg.map((g) => g.area);
  for (const core of C.JEPES_CORE) assert.ok(areas.includes(core), `missing ${core}`);
  const leadership = pkg.find((g) => g.area === 'Leadership');
  assert.equal(leadership.count, 1);
});

test('package text export is non-empty and structured', () => {
  const text = B.packageToText(B.buildPackage(sample, { periodLabel: 'FY26' }), 'FY26 summary');
  assert.ok(text.includes('FY26 SUMMARY'));
  assert.ok(text.includes('LEADERSHIP'));
  assert.ok(text.includes('  - '));
});

test('a title that already carries a verb is not double-verbed', () => {
  const text = B.composeBullet({
    title: 'Served on color guard detail',
    category: 'Volunteer Service',
    quantity: 1,
    unit: 'ceremonies',
    organization: 'Command Element',
    result: 'represented the command at a formal ceremony',
  });
  assert.ok(!/in support of served/i.test(text), text);
  assert.ok(text.startsWith('Served on color guard detail'), text);
});

test('units agree with their count', () => {
  const one = B.composeBullet({ title: 'Audit', category: 'Administration', quantity: 1, unit: 'vouchers', dollar_amount: 900, dollar_type: 'reviewed' });
  assert.ok(/1 voucher\b/.test(one), one);
  assert.ok(!/1 vouchers/.test(one), one);

  const many = B.composeBullet({ title: 'Audit', category: 'Administration', quantity: 4, unit: 'vouchers', dollar_amount: 900, dollar_type: 'reviewed' });
  assert.ok(/4 vouchers/.test(many), many);

  const ies = B.composeBullet({ title: 'Ceremony', category: 'Other', quantity: 1, unit: 'ceremonies', dollar_amount: 1 });
  assert.ok(/1 ceremony\b/.test(ies), ies);
});

test('a lone count of one is dropped when it adds nothing', () => {
  const text = B.composeBullet({ title: 'Served on color guard detail', category: 'Volunteer Service', quantity: 1, unit: 'ceremonies' });
  assert.ok(!/\b1 ceremony/.test(text), text);
});

test('bullets never contain doubled or dangling punctuation', () => {
  const samples = [
    { title: 'Reconciled aged obligations', quantity: 30, unit: 'ULOs', dollar_amount: 100, dollar_type: 'reconciled', system: 'DAI', organization: 'G-8', result: 'cleared it' },
    { title: 'Stood duty', quantity: 21, unit: 'hours' },
    { title: 'Quarterly review', category: 'Administration' },
  ];
  for (const s of samples) {
    const text = B.composeBullet(s);
    assert.ok(!/,\s*,/.test(text), `double comma: ${text}`);
    assert.ok(!/\s,/.test(text), `space before comma: ${text}`);
    assert.ok(!/,\./.test(text), `comma before period: ${text}`);
    assert.ok(/[.]$/.test(text), `no terminal period: ${text}`);
  }
});

test('detail already in the title is not restated', () => {
  const text = B.composeBullet({
    title: 'Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8',
    category: 'Fiscal & Financial',
    quantity: 30,
    unit: 'ULOs',
    dollar_amount: 1118.38,
    dollar_type: 'reconciled',
    system: 'DAI',
    organization: 'G-8',
  });
  assert.equal(text, 'Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8.');
  assert.equal(text.match(/ULOs/g).length, 1, text);
  assert.equal(text.match(/DAI/g).length, 1, text);
});

test('"Reconciled" does not match the leadership pattern', () => {
  assert.equal(C.suggestJepesArea('Reconciled 30 ULOs in DAI', 'Fiscal & Financial'), 'MOS / Mission Accomplishment');
  assert.equal(C.suggestCategory('Reconciled 30 ULOs in DAI'), 'Fiscal & Financial');
  assert.equal(C.suggestJepesArea('Mentored junior analysts', 'Leadership'), 'Leadership');
});

test('parses the canonical fiscal entry', () => {
  const p = Q.parseQuickLog('Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8');
  assert.equal(p.dollar_amount, 1118.38);
  assert.equal(p.dollar_type, 'reconciled');
  assert.equal(p.system, 'DAI');
  assert.equal(p.category, 'Fiscal & Financial');
  const q = Q.primaryQuantity(p.quantities);
  assert.equal(q.quantity, 30);
  assert.equal(q.unit, 'ULOs');
});

test('sums multiple dollar figures', () => {
  const p = Q.parseQuickLog('Recovered $1,200.50 and $800 in expired funds');
  assert.equal(p.dollar_amount, 2000.5);
  assert.equal(p.dollar_type, 'saved');
});

test('expands K and M suffixes', () => {
  assert.equal(Q.parseQuickLog('Obligated $1.5M for the contract').dollar_amount, 1500000);
  assert.equal(Q.parseQuickLog('Reviewed $250k in vouchers').dollar_amount, 250000);
});

test('resolves relative dates', () => {
  const today = new Date(2026, 7, 19);
  const y = Q.parseQuickLog('Logged 5 reports yesterday', today);
  assert.equal(y.date.getDate(), 18);
  const ago = Q.parseQuickLog('Processed 3 MIPRs 4 days ago', today);
  assert.equal(ago.date.getDate(), 15);
});

test('does not treat a relative-date number as a quantity', () => {
  const p = Q.parseQuickLog('Briefed the section 3 days ago', new Date(2026, 7, 19));
  assert.ok(!p.quantities.some((q) => /day/i.test(q.unit)), JSON.stringify(p.quantities));
});

test('picks the largest quantity as primary', () => {
  const p = Q.parseQuickLog('Reconciled 30 ULOs and 5 UMTs');
  const q = Q.primaryQuantity(p.quantities);
  assert.equal(q.quantity, 30);
  assert.equal(p.quantities.length, 2);
});

test('strips stopwords out of inferred units', () => {
  const p = Q.parseQuickLog('Processed 12 MIPRs totaling $40,000');
  assert.ok(p.quantities.some((q) => q.unit === 'MIPRs'), JSON.stringify(p.quantities));
  assert.ok(!p.quantities.some((q) => /totaling/i.test(q.unit)));
});

test('empty and garbage input do not throw', () => {
  assert.doesNotThrow(() => Q.parseQuickLog(''));
  assert.doesNotThrow(() => Q.parseQuickLog('!!! ??? $$$'));
  assert.doesNotThrow(() => Q.parseQuickLog('$'));
});

test('category inference hits the obvious cases', () => {
  assert.equal(C.suggestCategory('reconciled ULOs in DAI'), 'Fiscal & Financial');
  assert.equal(C.suggestCategory('mentored a junior Marine'), 'Leadership');
  assert.equal(C.suggestCategory('completed a MarineNet course'), 'Training & PME');
  assert.equal(C.suggestCategory('xyzzy'), 'Other');
});

const NOW = new Date('2026-08-20T12:00:00Z');

test('overdue tasks and near-deadline goals surface in Today', () => {
  const out = H.todayActions({
    now: NOW,
    tasks: [
      { title: 'Late one', status: 'active', due_date: '2026-08-10' },
      { title: 'Fine', status: 'active', due_date: '2026-09-01' },
      { title: 'Done late', status: 'completed', due_date: '2026-08-01' },
    ],
    goals: [{ title: 'Quarter close', status: 'active', period_end: '2026-08-30' }],
  });
  assert.equal(out.find((a) => a.key === 'overdue').count, 1);
  assert.equal(out.find((a) => a.key === 'goals-due').count, 1);
});

test('a clean record produces an empty Today list', () => {
  const out = H.todayActions({ now: NOW, tasks: [], goals: [], activities: [] });
  assert.equal(out.length, 0);
});

test('the FITREP countdown appears only on the fitrep track inside 45 days', () => {
  const base = { now: NOW, fitrepPeriodEnd: '2026-09-20' };
  assert.ok(H.todayActions({ ...base, track: 'fitrep' }).some((a) => a.key === 'fitrep-period'));
  assert.ok(!H.todayActions({ ...base, track: 'jepes' }).some((a) => a.key === 'fitrep-period'));
  assert.ok(!H.todayActions({ now: NOW, track: 'fitrep', fitrepPeriodEnd: '2026-12-01' })
    .some((a) => a.key === 'fitrep-period'));
});

test('record health scores the activity itself and never requires an attachment', () => {
  const activities = [
    { id: '1', title: 'Reconciled ULOs', date: '2026-08-01', jepes_area: 'Leadership', result: 'closed 30' },
    { id: '2', title: 'Big claim', date: '2026-08-02', jepes_area: 'Leadership', result: 'x', dollar_amount: 50000 },
    { id: '3', title: 'No outcome yet', date: '2026-08-03', jepes_area: 'Unassigned' },
  ];
  const issues = H.recordHealth({ now: NOW, activities, goals: [], profile: null });
  const by = Object.fromEntries(issues.map((i) => [i.key, i.count]));
  assert.equal(by.outcomes, 1);
  assert.equal(by.untagged, 1);
  assert.equal(by.evidence, undefined, 'supporting material is optional even for a large-dollar entry');
  assert.equal(by.duplicates, undefined, 'nothing here duplicates');
  for (const i of issues) assert.ok(i.to && i.detail, `${i.key} must carry a route and an explanation`);
});

test('duplicate pairs and stale goals are flagged', () => {
  const twin = { title: 'Reconciled 30 ULOs', date: '2026-08-05', quantity: 30, dollar_amount: 1118.38, result: 'ok', jepes_area: 'Leadership' };
  const issues = H.recordHealth({
    now: NOW,
    activities: [{ id: 'a', ...twin }, { id: 'b', ...twin, created_at: '2026-08-06' }],
    goals: [
      { title: 'Old push', status: 'active', period_end: '2026-06-30', updated_at: '2026-06-01' },
      { title: 'Fresh', status: 'active', period_end: '2026-12-31', updated_at: '2026-08-19' },
      { title: 'Done', status: 'achieved', period_end: '2026-06-30', updated_at: '2026-06-01' },
    ],
  });
  const by = Object.fromEntries(issues.map((i) => [i.key, i.count]));
  assert.equal(by.duplicates, 1);
  assert.equal(by.goals, 1);
});

test('readiness gaps are named per track', () => {
  const issues = H.recordHealth({ now: NOW, activities: [], goals: [], profile: { pft_score: 280 }, track: 'jepes' });
  const r = issues.find((i) => i.key === 'readiness');
  assert.ok(r && r.count >= 5);
  assert.match(r.detail, /CFT/);
});

const NARRATIVE_SET = [
  { date: '2026-07-05', title: 'Reconciled aged obligations', jepes_area: 'MOS / Mission Accomplishment',
    quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled', system: 'DAI',
    result: "cleared the section's aged ULO backlog" },
  { date: '2026-07-12', title: 'Corrected unmatched transactions', jepes_area: 'MOS / Mission Accomplishment',
    quantity: 5, unit_label: 'UMTs', dollar_amount: 842000, dollar_type: 'saved', system: 'SABRS' },
  { date: '2026-07-22', title: 'Served as Class Leader for the LCpl seminar', jepes_area: 'Leadership',
    quantity: 22, unit_label: 'Marines', result: '100% graduation with zero safety incidents' },
  { date: '2026-08-04', title: 'Stood Staff Action Fund duty', jepes_area: 'Individual Character',
    quantity: 1, unit_label: 'watch' },
];

test('narrative stays inside the character ceiling', () => {
  const n = N.composeNarrative(NARRATIVE_SET, { limit: 1000 });
  assert.ok(n.length <= 1000, `got ${n.length}`);
  assert.equal(n.fits, true);
});

test('narrative holds the ceiling under heavy load', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({
    date: '2026-07-01',
    title: `Processed batch ${i} of fiscal documents for the command element`,
    jepes_area: 'MOS / Mission Accomplishment',
    quantity: 10, unit_label: 'documents', dollar_amount: 5000, dollar_type: 'obligated',
    result: 'closed within the reporting window without exception',
  }));
  const n = N.composeNarrative(many, { limit: 1000 });
  assert.ok(n.length <= 1000, `overflowed to ${n.length}`);
  assert.ok(n.omitted > 0, 'should report what it left out');
});

test('narrative covers every area that has entries', () => {
  const n = N.composeNarrative(NARRATIVE_SET, { limit: 1000 });
  for (const label of ['CHARACTER', 'MISSION', 'LEADERSHIP']) {
    assert.ok(n.text.includes(label), `missing ${label}`);
  }
});

test('narrative uses a leadership verb for leadership', () => {
  const n = N.composeNarrative(
    [{ date: '2026-07-22', title: 'Led the seminar', jepes_area: 'Leadership', quantity: 22, unit_label: 'Marines' }],
    { limit: 1000 }
  );
  assert.ok(/Led 22 Marines/.test(n.text), n.text);
});

test('unmapped entries are folded in rather than dropped', () => {
  const n = N.composeNarrative(
    [{ date: '2026-07-01', title: 'Untagged work', quantity: 4, unit_label: 'reports' }],
    { limit: 1000 }
  );
  assert.ok(n.text.includes('MISSION'), n.text);
  assert.ok(n.text.length > 0);
});

test('an empty period produces nothing rather than a stub sentence', () => {
  const n = N.composeNarrative([], { limit: 1000 });
  assert.equal(n.text, '');
  assert.equal(n.fits, true);
});

test('same day, same money, same words is a duplicate', () => {
  const a = { date: '2026-07-05', title: 'Reconciled 30 ULOs', dollar_amount: 1118.38, quantity: 30 };
  const b = { date: '2026-07-05', title: 'ULOs reconciled 30', dollar_amount: 1118.38, quantity: 30 };
  assert.equal(D.signature(a), D.signature(b));
});

test('a different dollar figure is not a duplicate', () => {
  const a = { date: '2026-07-05', title: 'Reconciled ULOs', dollar_amount: 1118.38 };
  const b = { date: '2026-07-05', title: 'Reconciled ULOs', dollar_amount: 2118.38 };
  assert.notEqual(D.signature(a), D.signature(b));
});

test('re-importing a sheet does not double the figures', () => {
  const existing = [
    { id: '1', date: '2026-07-05', title: 'Reconciled 30 ULOs', dollar_amount: 1118.38, quantity: 30 },
    { id: '2', date: '2026-07-06', title: 'Processed 12 MIPRs', dollar_amount: 90000, quantity: 12 },
  ];
  const { fresh, exact } = D.screenImport(existing.map(({ id, ...r }) => r), existing);
  assert.equal(fresh.length, 0);
  assert.equal(exact.length, 2);
});

test('genuinely new rows still come through', () => {
  const existing = [{ id: '1', date: '2026-07-05', title: 'Reconciled 30 ULOs', dollar_amount: 1118.38 }];
  const incoming = [
    { date: '2026-07-05', title: 'Reconciled 30 ULOs', dollar_amount: 1118.38 },
    { date: '2026-07-09', title: 'Briefed the comptroller', dollar_amount: null },
  ];
  const { fresh, exact } = D.screenImport(incoming, existing);
  assert.equal(fresh.length, 1);
  assert.equal(exact.length, 1);
});

test('an already-doubled log is detectable after the fact', () => {
  const rows = [
    { id: 'a', date: '2026-07-05', title: 'Reconciled ULOs', dollar_amount: 1000, created_at: '1' },
    { id: 'b', date: '2026-07-05', title: 'Reconciled ULOs', dollar_amount: 1000, created_at: '2' },
    { id: 'c', date: '2026-07-06', title: 'Something else', dollar_amount: 50, created_at: '3' },
  ];
  const dupes = D.findDuplicates(rows);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].records.length, 2);
  assert.equal(dupes[0].inflatedBy, 1000);
});

const STYLE_RECORD = {
  title: 'Reconciled aged obligations', quantity: 30, unit_label: 'ULOs', unit: 'ULOs',
  dollar_amount: 1118.38, dollar_type: 'reconciled', system: 'DAI', organization: 'G-8',
  category: 'Fiscal & Financial', result: 'cleared the backlog',
};

test('the three bullet styles produce three different sentences', () => {
  const j = B.composeBullet(STYLE_RECORD, { style: 'jepes' });
  const f = B.composeBullet(STYLE_RECORD, { style: 'fitrep' });
  const r = B.composeBullet(STYLE_RECORD, { style: 'resume' });
  assert.notEqual(j, f);
  assert.notEqual(j, r);
  assert.notEqual(f, r);
});

test('resume style expands an acronym on first use', () => {
  const r = B.composeBullet(STYLE_RECORD, { style: 'resume' });
  assert.ok(/unliquidated obligation/i.test(r), r);
});

test('fitrep style drops the organization the report already names', () => {
  const f = B.composeBullet(STYLE_RECORD, { style: 'fitrep' });
  assert.ok(!/for G-8/.test(f), f);
});

test('a package reports what it withheld rather than dropping it silently', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), title: `Entry ${i}`, jepes_area: 'Leadership', quantity: 1, unit_label: 'items',
  }));
  const pkg = B.buildPackage(many, { limitPerArea: 8 });
  const group = pkg.find((g) => g.area === 'Leadership');
  assert.equal(group.bullets.length, 8);
  assert.equal(group.withheld, 22);
  assert.ok(B.packageToText(pkg).includes('22 further'));
});

test('an unlimited package withholds nothing', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), title: `Entry ${i}`, jepes_area: 'Leadership',
  }));
  const pkg = B.buildPackage(many, { limitPerArea: 0 });
  assert.equal(pkg.find((g) => g.area === 'Leadership').withheld, 0);
});

const PROFILE = {
  rank_grade: 'E-4', pft_score: 268, cft_score: 245, mcmap_belt: 'Grey',
  rifle_qual: 'Sharpshooter', ceus: 18, college_credits: 12,
  cmd_character: 3.4, cmd_mos: 3.3, cmd_leadership: 3.5,
};

const ITEM_STATES = ['top', 'solid', 'attention', 'missing', 'external'];

test('a full profile lights all four pillars', () => {
  const est = J.estimate(PROFILE);
  assert.equal(est.completeness, 1);
  for (const p of J.PILLARS) {
    assert.ok(est.pillars[p.key].known, `${p.key} should be known`);
    assert.ok(Array.isArray(est.pillars[p.key].items) && est.pillars[p.key].items.length > 0);
  }
});

test('the dashboard fabricates no score — not even a maxed one', () => {
  const maxed = {
    rank_grade: 'E-4', pft_score: 300, cft_score: 300, mcmap_belt: 'Black 3rd',
    rifle_qual: 'Expert', ceus: 999, college_credits: 999, degree: 'bachelor',
    pme_complete: 'resident', cmd_character: 5, cmd_mos: 5, cmd_leadership: 5,
  };
  for (const est of [J.estimate(maxed), J.estimate(PROFILE), J.estimate({})]) {
    assert.equal(est.total, undefined, 'no composite total may exist');
    assert.equal(est.maxScored, undefined, 'no point ceiling may exist');
    for (const p of J.PILLARS) {
      for (const it of est.pillars[p.key].items) {
        assert.ok(ITEM_STATES.includes(it.state), `bad state ${it.state}`);
      }
    }
  }
});

test('missing data reads as unknown, not as zero', () => {
  const est = J.estimate({ rank_grade: 'E-4', pft_score: 280, cft_score: 280 });
  assert.equal(est.pillars.warfighting.known, false, 'no rifle or belt should be unknown');
  assert.ok(est.pillars.warfighting.items.every((i) => i.state === 'missing'));
  assert.ok(est.pillars.physical.known);
  assert.ok(est.missing.includes('warfighting'));
  assert.ok(est.completeness < 1);
});

test('half a pillar reports the half we know', () => {
  const only = J.estimate({ rank_grade: 'E-4', rifle_qual: 'Expert' });
  const w = only.pillars.warfighting;
  assert.ok(w.known);
  assert.equal(w.enteredCount, 1);
  assert.equal(w.items.find((i) => i.key === 'rifle').state, 'top');
  assert.equal(w.items.find((i) => i.key === 'belt').state, 'missing');
});

test('fitness classes follow the MCO 6100.13A floors', () => {
  assert.equal(J.fitnessClass(268), '1st class');
  assert.equal(J.fitnessClass(235), '1st class');
  assert.equal(J.fitnessClass(200), '2nd class');
  assert.equal(J.fitnessClass(150), '3rd class');
  assert.equal(J.fitnessClass(149), 'below 3rd class');
  assert.equal(J.fitnessClass(''), null);
});

test('recommendations are ordered by priority and never invent a point value', () => {
  const recs = J.recommend(PROFILE, { total: 10, withOutcome: 9, thinAreas: [] });
  for (let i = 1; i < recs.length; i += 1) assert.ok(recs[i - 1].priority >= recs[i].priority, 'out of order');
  for (const r of recs) {
    assert.equal(r.gain, undefined, `${r.id} carries an invented point value`);
    assert.ok(['data', 'heuristic', 'official'].includes(r.kind), `${r.id} has no kind`);
  }
});

test('an empty profile asks for data before it asks for push-ups', () => {
  const recs = J.recommend({}, {});
  assert.ok(recs.length >= 4);
  const firstFour = recs.slice(0, 4);
  assert.ok(firstFour.every((r) => r.kind === 'data' && r.id.startsWith('missing-')));
});

test('the MOS qualification pointer is always present and points at policy, not a number', () => {
  const recs = J.recommend(PROFILE, {});
  const mos = recs.find((r) => r.id === 'mos-quals');
  assert.ok(mos, 'MOS quals pointer missing');
  assert.equal(mos.kind, 'official');
  assert.match(mos.detail, /MARADMIN 046\/24/);
  assert.match(mos.detail, /will not estimate/);
});

test('a maxed profile stops nagging about the maxed pillars', () => {
  const recs = J.recommend({
    rank_grade: 'E-4', pft_score: 300, cft_score: 300, mcmap_belt: 'Black 3rd',
    rifle_qual: 'Expert', ceus: 80, degree: 'bachelor', pme_complete: 'resident',
    cmd_character: 4.8, cmd_mos: 4.8, cmd_leadership: 4.8,
  }, { total: 20, withOutcome: 20, thinAreas: [] });
  for (const id of ['mcmap', 'rifle', 'pft', 'cft', 'ceus', 'pme', 'command-input']) {
    assert.ok(!recs.some((r) => r.id === id), `should not still suggest ${id}`);
  }
});

test('a thin JEPES area is called out', () => {
  const recs = J.recommend(PROFILE, { total: 10, withOutcome: 9, thinAreas: ['Leadership'] });
  assert.ok(recs.some((r) => r.id === 'thin-Leadership'));
});

test('weak evidence is flagged separately from weak fitness', () => {
  const recs = J.recommend(PROFILE, { total: 10, withOutcome: 3, thinAreas: [] });
  const outcome = recs.find((r) => r.id === 'outcomes');
  assert.ok(outcome, 'should flag the outcome rate');
  assert.match(outcome.title, /30%/);
  assert.equal(outcome.kind, 'data');
});

test('the biggest lever is the pillar with the most gaps, and a topped profile has none', () => {
  const lever = J.biggestLever(PROFILE);
  assert.ok(lever && lever.gaps > 0);
  assert.equal(lever.key, 'mental', `expected mental (ceus + missing PME), got ${lever.key}`);
  const none = J.biggestLever({
    rank_grade: 'E-4', pft_score: 300, cft_score: 300, mcmap_belt: 'Black 3rd',
    rifle_qual: 'Expert', ceus: 80, degree: 'bachelor', pme_complete: 'resident',
    cmd_character: 4.8, cmd_mos: 4.8, cmd_leadership: 4.8,
  });
  assert.equal(none, null);
});

test('E-1 through E-4 are JEPES; Sgt and above are FITREP', () => {
  for (const g of ['E-1', 'E-2', 'E-3', 'E-4']) assert.equal(E.trackForGrade(g), 'jepes', g);
  for (const g of ['E-5', 'E-6', 'E-9', 'W-2', 'O-3', 'O-6']) assert.equal(E.trackForGrade(g), 'fitrep', g);
});

test('an unknown grade defaults to the junior track', () => {
  assert.equal(E.trackForGrade(null), 'jepes');
  assert.equal(E.trackForGrade(''), 'jepes');
});

test('the FITREP track carries all fourteen attributes across five sections', () => {
  const attrs = E.FITREP_SECTIONS.flatMap((s) => s.attributes);
  assert.equal(attrs.length, 14);
  assert.equal(E.FITREP_SECTIONS.length, 5);
  assert.deepEqual(E.FITREP_SECTIONS.map((s) => s.section), ['D', 'E', 'F', 'G', 'H']);
});

test('a JEPES tag survives the promotion to Sergeant', () => {
  assert.equal(E.mapAreaToTrack('MOS / Mission Accomplishment', 'fitrep'), 'Mission Accomplishment');
  assert.equal(E.mapAreaToTrack('Leadership', 'fitrep'), 'Leadership');
  assert.equal(E.mapAreaToTrack('Individual Character', 'fitrep'), 'Individual Character');
});

test('a FITREP tag maps back down without loss of the record', () => {
  assert.equal(E.mapAreaToTrack('Intellect and Wisdom', 'jepes'), 'MOS / Mission Accomplishment');
  assert.equal(E.mapAreaToTrack('Evaluation Responsibilities', 'jepes'), 'Leadership');
});

test('the FITREP narrative groups by section and holds its ceiling', () => {
  const cfg = E.narrativeConfig('fitrep');
  const acts = [
    { date: '2026-07-01', title: 'Mentored two analysts through certification', jepes_area: 'Leadership',
      quantity: 2, unit_label: 'Marines', result: 'both certified ahead of schedule' },
    { date: '2026-07-10', title: 'Closed the fiscal year', jepes_area: 'Mission Accomplishment',
      dollar_amount: 4600000, dollar_type: 'obligated', result: 'zero unresolved ULOs' },
    { date: '2026-07-15', title: 'Completed Career Course distance education', jepes_area: 'Intellect and Wisdom',
      quantity: 1, unit_label: 'course' },
  ];
  const n = N2.composeNarrative(acts, cfg);
  assert.ok(n.length <= cfg.limit);
  for (const label of ['MISSION', 'LEADERSHIP', 'INTELLECT']) assert.ok(n.text.includes(label), label);
});

test('coverage finds likely evidence and admits what it cannot see', () => {
  const acts = [
    { title: 'Mentored two junior analysts', result: 'both certified' },
    { title: 'Briefed the comptroller on FY close', result: '' },
  ];
  const cov = E.fitrepCoverage(acts);
  const leadership = cov.find((s) => s.section === 'F');
  const developing = leadership.attributes.find((a) => a.attribute === 'Developing Subordinates');
  const comms = leadership.attributes.find((a) => a.attribute === 'Communication Skills');
  assert.ok(developing.likely > 0, 'mentoring should register');
  assert.ok(comms.likely > 0, 'briefing should register');
  const wellbeing = leadership.attributes.find((a) => a.attribute === 'Ensuring Well-being of Subordinates');
  assert.equal(wellbeing.likely, 0, 'nothing claims welfare work');
});

test('the FITREP advisor leads with the period when it is close', () => {
  const recs = E.recommendFitrep({}, { total: 10, withOutcome: 9 }, { coverage: [], daysToEnd: 20 });
  assert.equal(recs[0].id, 'period-end');
});

test('empty sections are called out by letter and attribute', () => {
  const coverage = E.fitrepCoverage([]);
  const recs = E.recommendFitrep({}, { total: 0, withOutcome: 0 }, { coverage, daysToEnd: null });
  assert.ok(recs.some((r) => r.id === 'section-D'));
  assert.ok(recs.find((r) => r.id === 'section-F').detail.includes('Developing Subordinates'));
});

test('the RS briefing is always on the list — it is the point of the track', () => {
  const recs = E.recommendFitrep({}, {}, { coverage: [], daysToEnd: null });
  assert.ok(recs.some((r) => r.id === 'brief-rs'));
});

const failed = results.filter(([s]) => s === 'FAIL');
for (const [status, name] of results) {
  console.log(`${status === 'PASS' ? '  ok' : 'FAIL'}  ${name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
