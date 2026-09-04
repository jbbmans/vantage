import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../shared/metrics.ts';
import * as B from '../../shared/bullets.ts';
import * as N from '../../shared/narrative.ts';
import * as Q from '../../shared/quickLog.ts';
import * as C from '../../shared/csv.ts';
import * as D from '../../shared/duplicates.ts';
import * as E from '../../shared/evaluation.ts';
import * as J from '../../shared/jepes.ts';
import { recordHealth, todayActions } from '../../shared/health.ts';
import { passwordProblem, passwordStrength } from '../../shared/password.ts';
import { activitySchema, fieldErrors, registrationSchema } from '../../shared/schemas.ts';
import { totpCode, verifyTotp, base32Encode, base32Decode, generateTotpSecret } from '../../server/auth/totp.ts';
import { parseMaradminFeed } from '../../server/services/maradmins.ts';
import { encryptSecret, decryptSecret, hashPassword, verifyPassword } from '../../server/lib/crypto.ts';
import { comparePeriods } from '../../shared/delta.ts';
import { localClock } from '../../server/services/digest.ts';

test('fiscal year starts 1 October and quarters map correctly', () => {
  assert.equal(M.fiscalYearOf(new Date(2025, 8, 30)), 2025);
  assert.equal(M.fiscalYearOf(new Date(2025, 9, 1)), 2026);
  const r = M.fiscalYearRange(new Date(2026, 1, 15));
  assert.equal(r.label, 'FY26');
  assert.equal(r.start.getMonth(), 9);
  assert.equal(r.end.getMonth(), 8);
  assert.equal(M.fiscalQuarterOf(new Date(2025, 9, 5)), 1);
  assert.equal(M.fiscalQuarterOf(new Date(2026, 6, 5)), 4);
  assert.equal(M.fiscalQuarterRange(new Date(2026, 7, 19)).label, 'FY26 Q4');
});

const sample = [
  { date: '2026-08-01', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled', result: 'cleared backlog' },
  { date: '2026-08-02', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', quantity: 5, unit_label: 'UMTs', dollar_amount: 4000000, dollar_type: 'reviewed' },
  { date: '2026-08-03', category: 'Leadership', eval_area: 'Leadership', quantity: 22, unit_label: 'Marines' },
  { date: '2026-08-03', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', quantity: 10, unit_label: 'ULOs', dollar_amount: 500, dollar_type: 'saved' },
];

test('metrics separate reviewed dollars and roll quantities per unit', () => {
  const m = M.aggregateMetrics(sample);
  assert.equal(m.totalDollars, 1618.38);
  assert.equal(m.reviewedDollars, 4000000);
  assert.equal(m.byUnit.find((u) => u.unit === 'ulos')?.total, 40);
  assert.equal(m.totalQuantity, 67);
  assert.equal(m.withOutcome, 1);
  assert.deepEqual(M.aggregateMetrics([]).byUnit, []);
});

test('formatters', () => {
  assert.equal(M.formatDollars(18600), '$18.6K');
  assert.equal(M.formatDollars(1240000), '$1.24M');
  assert.equal(M.formatDollars(-500), '-$500');
  assert.equal(M.formatDollarsExact(1118.38), '$1,118.38');
  assert.equal(M.formatDate('not-a-date'), '—');
  assert.equal(M.delta(5, 0), null);
  assert.equal(M.delta(150, 100), 50);
});

test('bullets fold figures into one defensible line', () => {
  const text = B.composeBullet({ title: 'FY26 year-end close', category: 'Fiscal & Financial', quantity: 30, unit_label: 'ULOs', dollar_amount: 1118.38, dollar_type: 'reconciled', system: 'DAI', organization: 'G-8', result: 'cleared the section backlog' });
  assert.ok(text.startsWith('Reconciled 30 ULOs totaling $1,118.38'), text);
  assert.ok(text.includes('via DAI') && text.includes('for G-8') && text.endsWith('cleared the section backlog.'), text);
  assert.ok(B.composeBullet({ title: 'ULO reconciliation drill', category: 'Fiscal & Financial' }).includes('ULO'));
  const resume = B.composeBullet({ title: 'Processed 12 MIPRs', category: 'Fiscal & Financial' }, { style: 'resume' });
  assert.ok(resume.includes('military interdepartmental purchase requests'), resume);
  assert.equal(B.strength({ dollar_amount: 100, quantity: 5, result: 'done' }), 4);
  assert.ok(B.weaknesses({ title: 'did a thing' }).length >= 3);
  assert.equal(B.unitFor('ULOs', 1), 'ULO');
  assert.equal(B.unitFor('entries', 1), 'entry');
});

test('package and narrative respect limits and group by area', () => {
  const pkg = B.buildPackage(sample, { periodLabel: 'FY26', limitPerArea: 1 });
  const mission = pkg.find((g) => g.area === 'MOS / Mission Accomplishment')!;
  assert.equal(mission.count, 3);
  assert.equal(mission.bullets.length, 1);
  assert.equal(mission.withheld, 2);
  assert.ok(B.packageToText(pkg, 'Test').includes('MOS / MISSION ACCOMPLISHMENT'));
  const n = N.composeNarrative(sample, { limit: 400 });
  assert.ok(n.text.startsWith('MISSION:'));
  assert.ok(n.length <= 400 && n.fits);
  assert.ok(n.areas.length >= 2);
  assert.equal(N.composeNarrative([]).text, '');
});

test('quick log parser extracts money, quantities, dates, systems', () => {
  const p = Q.parseQuickLog('Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday for G-8', new Date(2026, 8, 3));
  assert.equal(p.dollar_amount, 1118.38);
  assert.equal(p.dollar_type, 'reconciled');
  assert.equal(p.system, 'DAI');
  assert.equal(p.category, 'Fiscal & Financial');
  assert.equal(p.eval_area, 'MOS / Mission Accomplishment');
  assert.equal(p.date.getDate(), 2);
  assert.deepEqual(Q.primaryQuantity(p.quantities), { quantity: 30, unit: 'ULOs' });
  assert.ok(!p.title.includes('yesterday'));
  const k = Q.parseQuickLog('Saved $2.5k across 4 contracts');
  assert.equal(k.dollar_amount, 2500);
  assert.equal(k.dollar_type, 'saved');
});

test('csv parse, mapping, and export round-trip', () => {
  const rows = [{ id: 'abc', title: 'Led 22 Marines', date: '2026-08-03', category: 'Leadership', eval_area: 'Leadership', quantity: 22, unit_label: 'Marines', dollar_amount: null, dollar_type: null, result: 'all graduated, "top" class', organization: null, system: null, status: 'completed', visibility: 'unit', notes: '=SUM(1)', evidence_links: [{ label: 'Roster', url: 'https://example.mil/r' }] }];
  const csv = C.rowsToCsv(rows.map(C.activityToCsvRow), C.ACTIVITY_CSV_COLUMNS.map((c) => c.header));
  const parsed = C.parseCsvText(csv);
  assert.deepEqual(parsed.columns, C.ACTIVITY_CSV_COLUMNS.map((c) => c.header));
  const mapping = C.guessMapping(parsed.columns);
  assert.equal(mapping.title, 'Title');
  assert.equal(mapping.eval_area, 'Evaluation Area');
  const { records, problems } = C.applyMapping(parsed.rows, mapping);
  assert.equal(problems.length, 0);
  assert.equal(records[0].id, 'abc');
  assert.equal(records[0].quantity, 22);
  assert.equal(records[0].result, 'all graduated, "top" class');
  assert.equal(records[0].notes, "'=SUM(1)");
  assert.deepEqual(records[0].evidence_links, [{ label: 'Roster', url: 'https://example.mil/r' }]);
  assert.equal(C.guessMapping(['Quantity', 'Dollar Amount', 'JEPES Area']).quantity, 'Quantity');
  assert.throws(() => C.parseDelimited('"a,b', ','));
});

test('duplicate screening', () => {
  const existing = [{ title: 'Reconciled 30 ULOs', date: '2026-08-01', dollar_amount: 100, quantity: 30 }];
  const r = D.screenImport([{ title: 'reconciled 30 ULOs', date: '2026-08-01', dollar_amount: 100, quantity: 30 }, { title: 'Reconciled thirty ULOs quickly', date: '2026-08-01', dollar_amount: 200, quantity: 30 }], existing);
  assert.equal(r.exact.length, 1);
  assert.equal(r.fresh.length, 1);
  assert.equal(D.findDuplicates([...existing, ...existing]).length, 1);
});

test('evaluation track mapping and coaching', () => {
  assert.equal(E.trackForGrade('E-4'), 'jepes');
  assert.equal(E.trackForGrade('E-5'), 'fitrep');
  assert.equal(E.trackForGrade('O-3'), 'fitrep');
  assert.equal(E.mapAreaToTrack('MOS / Mission Accomplishment', 'fitrep'), 'Mission Accomplishment');
  assert.equal(E.mapAreaToTrack('Intellect and Wisdom', 'jepes'), 'MOS / Mission Accomplishment');
  const recs = J.recommend({ rank_grade: 'E-4', pft_score: 220, mcmap_belt: 'Tan', rifle_qual: 'Marksman', ceus: 5, pme_complete: 'distance', cmd_character: 3.2 }, { total: 10, withOutcome: 2 });
  assert.ok(recs.find((r) => r.id === 'pft'));
  assert.ok(recs.find((r) => r.id === 'outcomes'));
  const est = J.estimate({ pft_score: 290 });
  assert.equal(est.pillars.physical.items[0].state, 'top');
  const cov = E.fitrepCoverage([{ title: 'Mentored 3 Marines', eval_area: 'Leadership' }]);
  assert.ok(cov.find((s) => s.key === 'Leadership')!.attributes.find((a) => a.attribute === 'Developing Subordinates')!.likely >= 1);
  const frecs = E.recommendFitrep({ pft_score: 240 }, { total: 6, withOutcome: 2 }, { coverage: cov, daysToEnd: 10 });
  assert.equal(frecs[0].id, 'period-end');
});

test('health and today actions', () => {
  const issues = recordHealth({ activities: [{ title: 'x', eval_area: 'Unassigned', date: null }], goals: [{ status: 'active', period_end: '2020-01-01' }], profile: { pft_score: null }, track: 'jepes' });
  assert.ok(issues.find((i) => i.key === 'untagged') && issues.find((i) => i.key === 'dates') && issues.find((i) => i.key === 'goals') && issues.find((i) => i.key === 'readiness'));
  const actions = todayActions({ tasks: [{ status: 'planned', due_date: '2020-01-01', title: 'late' }], track: 'fitrep', fitrepPeriodEnd: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) });
  assert.equal(actions[0].key, 'overdue');
  assert.ok(actions.find((a) => a.key === 'fitrep-period'));
});

test('delta compares against the prior equivalent window', () => {
  const range = { start: new Date(2026, 7, 1), end: new Date(2026, 7, 31, 23, 59, 59), label: 'Aug' };
  const cmp = comparePeriods([...sample, { date: '2026-07-10', category: 'Operations', eval_area: 'Leadership', quantity: 1 }], range);
  assert.equal(cmp.headline.activities.current, 4);
  assert.equal(cmp.headline.activities.prior, 1);
  assert.ok(cmp.notes.length);
});

test('password policy and strength', () => {
  assert.equal(passwordProblem('short'), 'At least 15 characters.');
  assert.ok(passwordProblem('passwordpassword2024'));
  assert.ok(passwordProblem('semperfi-semperfi'));
  assert.equal(passwordProblem('cobalt-orbit-velvet-anchor-927'), null);
  assert.ok(passwordStrength('cobalt-orbit-velvet-anchor-927').score >= 3);
  assert.equal(passwordStrength('abc').score, 0);
});

test('schemas coerce and validate', () => {
  const r = activitySchema.safeParse({ title: '  Did work ', quantity: '30', dollar_amount: '$1,118.38', date: '2026-02-30', eval_area: 'Nope' });
  assert.ok(!r.success);
  assert.ok(fieldErrors(r.error!).date);
  const ok = activitySchema.parse({ title: 'Did work', quantity: '30', dollar_amount: '$1,118.38', date: '2026-02-28', eval_area: 'Nope', category: '' });
  assert.equal(ok.quantity, 30);
  assert.equal(ok.dollar_amount, 1118.38);
  assert.equal(ok.eval_area, 'Unassigned');
  assert.equal(ok.category, null);
  const reg = registrationSchema.safeParse({ username: 'Bad Name!', password: 'x', first_name: '', last_name: 'M' });
  assert.ok(!reg.success);
  const errs = fieldErrors(reg.error!);
  assert.ok(errs.username && errs.password && errs.first_name);
});

test('TOTP follows RFC 6238 vectors and tolerates one step of drift', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(totpCode(secret, 1, 8), '94287082');
  assert.equal(totpCode(secret, 37037036, 8), '07081804');
  const now = Date.now();
  const code = totpCode(secret, Math.floor(now / 30000));
  assert.ok(verifyTotp(secret, code, { nowMs: now }));
  assert.ok(verifyTotp(secret, code, { nowMs: now + 30_000 }));
  assert.ok(!verifyTotp(secret, code, { nowMs: now + 90_000 }));
  assert.ok(!verifyTotp(secret, '000000', { nowMs: now }) || code === '000000');
  assert.equal(generateTotpSecret().length, 32);
});

test('secret encryption and password hashing round-trip', () => {
  const key = 'k'.repeat(40);
  const enc = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
  assert.equal(decryptSecret(key, enc), 'JBSWY3DPEHPK3PXP');
  assert.equal(decryptSecret('wrong'.repeat(8), enc), null);
  const hash = hashPassword('cobalt-orbit-velvet-anchor-927');
  assert.ok(verifyPassword('cobalt-orbit-velvet-anchor-927', hash));
  assert.ok(!verifyPassword('nope', hash));
});

test('MARADMIN feed parser', () => {
  const xml = `<rss><channel><item><title><![CDATA[FY27 SERGEANT PROMOTION SELECTIONS]]></title><link>https://www.marines.mil/x/1</link><description><![CDATA[<p>MARADMIN 412/26 announces...</p>]]></description><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate></item>
  <item><title>Broken</title><link>https://x</link><description>no number</description><pubDate>bad</pubDate></item></channel></rss>`;
  const rows = parseMaradminFeed(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].number, '412/26');
  assert.ok(rows[0].tags.includes('Promotions'));
  assert.equal(rows[0].id, 'maradmin-412-26');
});

test('digest local clock resolves weekday and hour in a timezone', () => {
  const c = localClock('America/New_York', new Date('2026-09-07T10:30:00Z'));
  assert.equal(c.weekday, 1);
  assert.equal(c.hour, 6);
});

test('quick log does not read "14 Marines" as a March date', async () => {
  const { parseQuickLog } = await import('../../shared/quickLog.ts');
  const now = new Date('2026-09-03T12:00:00');
  const parsed = parseQuickLog('Briefed 14 Marines on the new travel policy', now);
  assert.equal(parsed.date.getMonth(), 8);
  assert.equal(parsed.date.getDate(), 3);
  const dated = parseQuickLog('Briefed 14 Marines on 12 Mar', now);
  assert.equal(dated.date.getMonth(), 2);
  assert.equal(dated.date.getDate(), 12);
});

test('zonedNow reports the wall clock of the configured timezone', async () => {
  const { zonedNow } = await import('../../server/lib/clock.ts');
  const at = new Date('2026-10-01T02:30:00Z');
  const ny = zonedNow('America/New_York', at);
  assert.equal(ny.getMonth(), 8);
  assert.equal(ny.getDate(), 30);
  assert.equal(ny.getHours(), 22);
  const tokyo = zonedNow('Asia/Tokyo', at);
  assert.equal(tokyo.getDate(), 1);
  assert.equal(tokyo.getHours(), 11);
});

test('csv import rejects impossible slash dates instead of rolling them forward', () => {
  const parsed = C.parseCsvText('Date,Title\n02/30/2026,Rolled\n2/28/26,Fine\n13/01/2026,Bad month\n');
  const { records, problems } = C.applyMapping(parsed.rows, C.guessMapping(parsed.columns));
  assert.deepEqual(records.map((r) => r.date), ['2026-02-28']);
  assert.deepEqual(problems.map((p) => p.row), [2, 4]);
  assert.ok(problems.every((p) => p.issue === 'unreadable date'));
});
