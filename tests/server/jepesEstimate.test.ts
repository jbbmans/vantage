import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonical, versioned } from '../../shared/versioned.ts';
import {
  JEPES_BONUS, JEPES_MCMAP_TABLES, JEPES_MENTAL_AGILITY, JEPES_SCORE_TABLES, JEPES_TABLES, JEPES_WORKSHEET, MCMAP_CODES, SCORE_SCALE,
} from '../../shared/jepesTables.ts';
import { JEPES_READINESS_COLUMNS, estimateJepes, jepesGrade, jepesLevers, mcmapCode, roundHalfUp, totalArithmetic, type JepesEstimate } from '../../shared/jepesEstimate.ts';
import { readinessSchema } from '../../shared/schemas.ts';
import { READINESS_COLUMNS } from '../../shared/recordTransfer.ts';
import { startApp, enroll, type TestApp } from './helpers.ts';

/**
 * The JEPES estimate (ADR-0046). The tables are MCO 1616.1 Appendix B's and the MARADMINs that changed it, each version
 * pinned here as released; the worked examples below are worked by hand from the worksheet (p. B-1) and its instructions
 * (pp. B-2 to B-6), each line from the table the line names.
 */

const TODAY = '2026-11-24';
const pillar = (est: JepesEstimate, key: string) => est.pillars.find((p) => p.key === key)!;
const line = (est: JepesEstimate, key: string) => est.pillars.flatMap((p) => p.lines).find((l) => l.key === key)!;
const exact = (n: number) => ({ low: n, high: n });

/** Each released version as it was released. Changing one is refused here: a change is a new version, never an edit. */
const RELEASED: Record<string, string> = {
  'mco-1616.1-tables-3-4': 'c6c4e72ef3ed971c1e066f493be05e60bdf1ec319806bb259765bb6427670970',
  'mco-1616.1-tables-1-2': 'c18526dc453741464b5cf9945362da9acb352a51e6e7e9bf101b90b514a75da1',
  'mco-1616.1-worksheet': 'f899676c00d2cd1990d78493004d93327d2705a766a5f35385d78f2a884adab2',
  'mco-1616.1-line-3': 'f26b0b79ec7a7f1fadc70a1eb0686967159fc7f6b293a769d8aff7b77872d646',
  'maradmin-367-21': '8b89efb17f084bfa15317edee18310a8baee00e70f0a97464e50dd4462c2ac15',
  'mco-1616.1-line-5': '7982901eecf5d8a4f12d42c2c6384a01ec628d58a9b3a907f948e53131457b7e',
  'maradmin-695-21': '3c63babf51ad0bdd4939e24f2ebbdbc15a4e46df80eb11f68cf5f427bf9debf6',
};

test('every released table version keeps the fingerprint it was released with', () => {
  const seen = new Set<string>();
  for (const table of JEPES_TABLES) {
    for (const v of table.versions) {
      seen.add(v.id);
      const fingerprint = createHash('sha256').update(canonical(v)).digest('hex');
      assert.ok(RELEASED[v.id], `${table.name} ${v.id} is new: record its fingerprint here once its numbers are checked against ${v.cites.map((c) => c.source).join(' and ')}`);
      assert.equal(fingerprint, RELEASED[v.id], `${table.name} ${v.id} was edited. A released version is never changed: add a new version with its own effective date and source.`);
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(RELEASED).sort(), 'a released version is never removed either');
});

test('a versioned table is frozen, dated in order, cited, and picks the version in force on a day', () => {
  for (const table of JEPES_TABLES) {
    assert.ok(Object.isFrozen(table.versions));
    for (const v of table.versions) {
      assert.ok(Object.isFrozen(v) && Object.isFrozen(v.data) && Object.isFrozen(v.cites), `${v.id} is frozen`);
      assert.ok(v.cites.every((c) => c.url.startsWith('https://www.marines.mil/')), `${v.id} cites the published source`);
    }
  }
  const rows = JEPES_SCORE_TABLES.versions[0].data.lcpl.pft;
  assert.throws(() => { (rows[0] as unknown as number[])[2] = 5; }, TypeError, 'a released number cannot be changed at run time');
  assert.throws(() => versioned('t', []), /at least one version/);
  const cite = [{ source: 's', where: 'w', url: 'https://www.marines.mil/x' }];
  assert.throws(() => versioned('t', [{ id: 'a', effective_from: '2021-01-01', cites: cite, data: 1 }, { id: 'a', effective_from: '2021-02-01', cites: cite, data: 2 }]), /unique/);
  assert.throws(() => versioned('t', [{ id: 'a', effective_from: '2021-02-01', cites: cite, data: 1 }, { id: 'b', effective_from: '2021-02-01', cites: cite, data: 2 }]), /after a/);
  assert.throws(() => versioned('t', [{ id: 'a', effective_from: '2021-2-1', cites: cite, data: 1 }]), /YYYY-MM-DD/);
  assert.throws(() => versioned('t', [{ id: 'a', effective_from: '2021-02-01', cites: [], data: 1 }]), /cite/);
  // Each table's dates: the order took effect 1 Feb 2021; MARADMIN 367/21 on 29 Jul 2021; 695/21 on 7 Dec 2021.
  assert.equal(JEPES_WORKSHEET.inForce('2021-01-31'), null);
  assert.equal(JEPES_WORKSHEET.inForce('2021-02-01')?.id, 'mco-1616.1-worksheet');
  assert.equal(JEPES_MENTAL_AGILITY.inForce('2021-07-28')?.id, 'mco-1616.1-line-3');
  assert.equal(JEPES_MENTAL_AGILITY.inForce('2021-07-29')?.id, 'maradmin-367-21');
  assert.equal(JEPES_BONUS.inForce('2021-12-06')?.id, 'mco-1616.1-line-5');
  assert.equal(JEPES_BONUS.inForce(TODAY)?.id, 'maradmin-695-21');
  assert.throws(() => JEPES_BONUS.inForce('24 Nov 2026'), /YYYY-MM-DD/);
  assert.throws(() => estimateJepes({}, { on: '2021-01-31' }), /JEPES began on 2021-02-01/);
});

test('Tables 3 and 4 give every score one value, rising, with the order’s anchors', () => {
  const data = JEPES_SCORE_TABLES.versions[0].data;
  for (const grade of ['lcpl', 'cpl'] as const) {
    for (const key of ['pft', 'cft', 'rifle'] as const) {
      const bands = data[grade][key];
      let next = 0;
      let value = -1;
      for (const [lo, hi, v] of bands) {
        assert.equal(lo, next, `${grade} ${key}: ${lo} follows ${next - 1} with no gap or overlap`);
        assert.ok(hi >= lo && v > value, `${grade} ${key}: values rise band by band (${lo} to ${hi} is ${v})`);
        next = hi + 1;
        value = v;
      }
      assert.equal(next - 1, SCORE_SCALE[key], `${grade} ${key} reaches the top of its scale`);
      assert.equal(bands[0][2], 0);
      assert.equal(bands.at(-1)![2], 100);
      assert.equal(bands[0][1], key === 'rifle' ? 249 : 149, 'below 150 (PFT, CFT) and below 250 (rifle) is 0');
    }
  }
  // Rows read straight off pages B-8 and B-9.
  const at = (grade: 'lcpl' | 'cpl', key: 'pft' | 'cft' | 'rifle', score: number) => data[grade][key].find(([lo, hi]) => score >= lo && score <= hi)![2];
  assert.deepEqual([at('lcpl', 'pft', 250), at('lcpl', 'cft', 280), at('lcpl', 'rifle', 310), at('lcpl', 'pft', 295)], [59, 69, 55, 100]);
  assert.deepEqual([at('cpl', 'pft', 265), at('cpl', 'cft', 290), at('cpl', 'rifle', 300), at('cpl', 'rifle', 310)], [68, 74, 23, 43]);
});

test('Tables 1 and 2 read the MCTFS belt codes, and a belt above a table takes its top row', () => {
  const data = JEPES_MCMAP_TABLES.versions[0].data;
  assert.deepEqual(data.lcpl.map((r) => [r.code, r.value]), [['MMA', 0], ['MMB', 33], ['MMC', 67], ['MMD', 100]]);
  assert.deepEqual(data.cpl.map((r) => [r.code, r.value]), [['MMA', 0], ['MMB', 16], ['MMC', 33], ['MMD', 50], ['MME', 66], ['MMF', 83], ['MMG', 100]]);
  assert.deepEqual(MCMAP_CODES, ['MMA', 'MMB', 'MMC', 'MMD', 'MME', 'MMF', 'MMG', 'MMH']);
  assert.deepEqual(['Tan', 'Grey', 'Green', 'Brown', 'Black 1st', 'Black 3rd'].map((b) => mcmapCode(b, 0)), ['MMB', 'MMC', 'MMD', 'MMF', 'MMH', 'MMH']);
  assert.deepEqual([mcmapCode('Green', 1), mcmapCode('Brown', true), mcmapCode('Tan', 1), mcmapCode('', 1), mcmapCode('Purple', 0)], ['MME', 'MMG', 'MMB', null, null]);
  const lcplBrown = line(estimateJepes({ rank_grade: 'E-3', mcmap_belt: 'Brown' }, { on: TODAY }), 'mcmap_belt');
  assert.deepEqual(lcplBrown.value, exact(100));
  assert.match(lcplBrown.reason, /above Table 1's top row, Green, so 100/);
  assert.deepEqual(line(estimateJepes({ rank_grade: 'E-4', mcmap_belt: 'Green', mcmap_instructor: 1 }, { on: TODAY }), 'mcmap_belt').value, exact(66));
  assert.deepEqual(line(estimateJepes({ rank_grade: 'E-4', mcmap_belt: 'Black 1st' }, { on: TODAY }), 'mcmap_belt').value, exact(100));
});

/** A Lance Corporal's figures, worked below by hand. */
const LCPL = {
  rank_grade: 'E-3', rifle_score: 310, mcmap_belt: 'Grey', pft_score: 250, cft_score: 280,
  ceus: 25, degree: 'associate', courses_in_service: 2, courses_in_grade: 3, mos_qual_points: 30,
  cmd_mos: 4.2, cmd_leadership: 4.0, cmd_character: 4.4, recruiting_referrals: 1,
};

test('a Lance Corporal worked through the worksheet line by line', () => {
  const est = estimateJepes(LCPL, { on: TODAY });
  assert.equal(est.grade, 'lcpl');
  assert.ok(est.applies && est.exact);
  assert.deepEqual(est.blanks, []);
  // Line 1: rifle 310 is 55 on Table 3; Grey is 67 on Table 1; 122 x 1.25 = 152.5, rounded up to 153.
  assert.deepEqual([line(est, 'rifle_score').value, line(est, 'mcmap_belt').value], [exact(55), exact(67)]);
  assert.deepEqual(pillar(est, 'warfighting').points, exact(153));
  assert.equal(pillar(est, 'warfighting').arithmetic, 'Line 1c: 55 + 67 = 122. Line 1d: 122 × 1.25 = 152.5, rounded to 153.');
  // Line 2: PFT 250 is 59, CFT 280 is 69; 128 x 1.25 = 160.
  assert.deepEqual(pillar(est, 'physical').points, exact(160));
  // Line 3 under MARADMIN 367/21: MarineNet 25, one associate 10, two courses in service 10, three in grade 15, MOS
  // qualifications 30; 90 x 1.25 = 112.5, rounded up to 113.
  assert.deepEqual(pillar(est, 'mental').lines.map((l) => l.value.low), [25, 10, 10, 15, 30]);
  assert.deepEqual(pillar(est, 'mental').points, exact(113));
  // Line 4: 4.2, 4.0 and 4.4 times 50 are 210, 200 and 220; 630 / 3 = 210.
  assert.deepEqual(pillar(est, 'command').lines.map((l) => l.value.low), [210, 200, 220]);
  assert.deepEqual(pillar(est, 'command').points, exact(210));
  // Line 5: one referral who enlisted, 20.
  assert.deepEqual(pillar(est, 'bonus').points, exact(20));
  // Line 6a: 153 + 160 + 113 + 210 + 20.
  assert.deepEqual(est.total, exact(656));
  assert.equal(totalArithmetic(est), 'Line 6a: 153 + 160 + 113 + 210 + 20 = 656, of 1,000.');
  assert.match(line(est, 'rifle_score').reason, /Rifle 310 is value 55 on Table 3/);
  assert.equal(line(est, 'rifle_score').cite.where, 'Appendix B, Table 3, p. B-8');
  assert.deepEqual(est.versions.map((v) => v.id), ['mco-1616.1-tables-3-4', 'mco-1616.1-tables-1-2', 'mco-1616.1-worksheet', 'maradmin-367-21', 'maradmin-695-21']);
});

test('a Corporal worked through the worksheet, with the bonus held to 100', () => {
  const est = estimateJepes({
    rank_grade: 'E-4', rifle_score: 300, mcmap_belt: 'Brown', pft_score: 265, cft_score: 290,
    ceus: 40, degree: 'bachelor', courses_in_service: 5, courses_in_grade: 1, mos_qual_points: 70,
    cmd_mos: 4.5, cmd_leadership: 4.3, cmd_character: 4.6,
    bonus_security_forces: 1, bonus_reserve_affiliation: 1, recruiting_referrals: 1,
  }, { on: TODAY });
  assert.equal(est.grade, 'cpl');
  // Line 1: rifle 300 is 23 on Table 4, Brown is 83 on Table 2; 106 x 1.25 = 132.5, rounded up to 133.
  assert.deepEqual(pillar(est, 'warfighting').points, exact(133));
  // Line 2: PFT 265 is 68, CFT 290 is 74; 142 x 1.25 = 177.5, rounded up to 178.
  assert.deepEqual(pillar(est, 'physical').points, exact(178));
  // Line 3: MarineNet 40, bachelor's 20, five courses in service 25 held to 20, one in grade 5, MOS qualifications 70;
  // 155 x 1.25 = 193.75, rounded to 194.
  assert.deepEqual(pillar(est, 'mental').lines.map((l) => l.value.low), [40, 20, 20, 5, 70]);
  assert.deepEqual(pillar(est, 'mental').points, exact(194));
  // Line 4: 225 + 215 + 230 = 670; 670 / 3 = 223.33, rounded to 223.
  assert.deepEqual(pillar(est, 'command').points, exact(223));
  // Line 5: Security Forces 50, reserve affiliation 50, one referral 20: 120, held to 100.
  assert.deepEqual(pillar(est, 'bonus').sum, exact(120));
  assert.deepEqual(pillar(est, 'bonus').points, exact(100));
  assert.equal(line(est, 'bonus_security_forces').value.low, 50, 'line 5e is 50, as the worksheet prints it');
  assert.deepEqual(est.total, exact(133 + 178 + 194 + 223 + 100));
});

test('before MARADMIN 367/21 the order’s own Mental Agility applies, and before the reserve message there is no affiliation bonus', () => {
  const est = estimateJepes({ ...LCPL, bonus_reserve_affiliation: 1 }, { on: '2021-03-01' });
  // MarineNet 25, one associate 20, two courses in service 20, three in grade 30; no MOS qualification line yet.
  assert.deepEqual(pillar(est, 'mental').lines.map((l) => [l.key, l.value.low]), [['ceus', 25], ['degree', 20], ['courses_in_service', 20], ['courses_in_grade', 30]]);
  // 95 x 1.25 = 118.75, rounded to 119.
  assert.deepEqual(pillar(est, 'mental').points, exact(119));
  assert.deepEqual(pillar(est, 'bonus').points, exact(20), 'the reserve affiliation incentive began on 7 Dec 2021');
  assert.deepEqual(est.total, exact(153 + 160 + 119 + 210 + 20));
  assert.equal(est.versions.find((v) => v.table === 'JEPES Mental Agility')!.id, 'mco-1616.1-line-3');
});

test('rounding is half up, as the order says 200.5 is 201, and every cap holds', () => {
  assert.deepEqual([roundHalfUp(200.5), roundHalfUp(200.49), roundHalfUp(152.5), roundHalfUp(605 / 3), roundHalfUp(122 * 1.25)], [201, 200, 153, 202, 153]);
  const most = estimateJepes({
    rank_grade: 'E-3', rifle_score: 350, mcmap_belt: 'Black 3rd', pft_score: 300, cft_score: 300,
    ceus: 400, degree: 'master', courses_in_service: 99, courses_in_grade: 99, mos_qual_points: 100,
    cmd_mos: 5, cmd_leadership: 5, cmd_character: 5,
    bonus_di_school: 1, bonus_recruiter_school: 1, bonus_msg_school: 1, bonus_security_forces: 1, recruiting_referrals: 9,
  }, { on: TODAY });
  for (const key of ['warfighting', 'physical', 'mental', 'command']) assert.deepEqual(pillar(most, key).points, exact(250), key);
  assert.deepEqual(pillar(most, 'bonus').points, exact(100));
  assert.equal(line(most, 'recruiting_referrals').value.low, 100, 'command recruiting is held to 100');
  assert.deepEqual(most.total, exact(1000), '1,100 on the lines is held to 1,000');
  assert.match(line(most, 'degree').reason, /counted as a bachelor’s/);
  assert.deepEqual(estimateJepes({ rank_grade: 'E-3', bonus_security_forces: 1 }, { on: TODAY }).pillars.at(-1)!.points, exact(50));
});

test('a blank figure is its line’s whole range, a missing rank reads both tables, and Sergeants are not on JEPES', () => {
  const blank = estimateJepes({}, { on: TODAY });
  assert.equal(blank.grade, null);
  assert.ok(!blank.exact);
  // Every line open: 250 + 250 + (40 + 20 + 20 + 100) x 1.25 + 250, with no degree and no bonus.
  assert.deepEqual(blank.total, { low: 0, high: 975 });
  assert.deepEqual(blank.blanks.sort(), ['ceus', 'cft_score', 'cmd_character', 'cmd_leadership', 'cmd_mos', 'courses_in_grade', 'courses_in_service', 'mcmap_belt', 'mos_qual_points', 'pft_score', 'rifle_score']);
  assert.match(totalArithmetic(blank), /0 to 975 of 1,000 until the blank lines are entered/);
  const noRank = line(estimateJepes({ rifle_score: 310 }, { on: TODAY }), 'rifle_score');
  assert.deepEqual(noRank.value, { low: 43, high: 55 });
  assert.match(noRank.reason, /55 on Table 3 and 43 on Table 4; your rank picks the table/);
  // Spaces, a stray comma or a blank are nothing typed, never a 0.
  assert.deepEqual(line(estimateJepes({ rank_grade: 'E-3', pft_score: '  ' }, { on: TODAY }), 'pft_score').value, { low: 0, high: 100 });
  assert.deepEqual(line(estimateJepes({ rank_grade: 'E-3', pft_score: '2,50' }, { on: TODAY }), 'pft_score').value, exact(59));
  assert.deepEqual([jepesGrade('E-1'), jepesGrade('E-4'), jepesGrade('E-5'), jepesGrade(null)], [{ grade: 'lcpl', applies: true }, { grade: 'cpl', applies: true }, { grade: null, applies: false }, { grade: null, applies: true }]);
  assert.equal(estimateJepes({ rank_grade: 'E-5' }, { on: TODAY }).applies, false);
  assert.deepEqual(jepesLevers({ rank_grade: 'E-6', pft_score: 200 }, { on: TODAY }), []);
});

test('levers: blank figures first, then each step by the points it adds, and each step is the difference of two estimates', () => {
  const inputs = { rank_grade: 'E-3', rifle_score: 280, mcmap_belt: 'Tan', pft_score: 230, ceus: 10, cmd_mos: 3.8, cmd_leadership: 4.2, cmd_character: 4.0 };
  const levers = jepesLevers(inputs, { on: TODAY });
  const now = estimateJepes(inputs, { on: TODAY }).total.low;
  const order = levers.map((l) => (l.kind === 'data' ? 0 : l.points === null ? 2 : 1));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'blank figures, then steps with points, then steps no table here sizes');
  const steps = levers.filter((l) => l.kind === 'points' && l.points !== null);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i - 1].points! >= steps[i].points!, `${steps[i - 1].id} ranks above ${steps[i].id}`);
  for (const l of steps) {
    assert.ok(l.change, `${l.id} names the figures it changes`);
    assert.equal(estimateJepes({ ...inputs, ...l.change }, { on: TODAY }).total.low - now, l.points, `${l.id}: the what-if of its change adds what it says`);
    assert.ok(l.upTo >= l.points!, `${l.id}: the next step is no more than what is left`);
  }
  assert.deepEqual(new Set(levers.filter((l) => l.kind === 'data').map((l) => l.input)), new Set(['cft_score', 'courses_in_grade', 'courses_in_service', 'mos_qual_points']));
  const belt = levers.find((l) => l.id === 'mcmap')!;
  assert.equal(belt.title, 'Advance to Grey belt');
  // Rifle 280 is 10 on Table 3: (10 + 67) x 1.25 = 96.25 is 96, against (10 + 33) x 1.25 = 53.75, 54.
  assert.equal(belt.points, 96 - 54, 'Tan 33 to Grey 67 on Table 1');
  assert.equal(levers.find((l) => l.id === 'command-input')!.title, 'Raise your MOS / Mission Accomplishment average from 3.8 to 4.3');
  // A step that ten more points of score would not move goes to the next score that does.
  const rifle = levers.find((l) => l.id === 'rifle')!;
  assert.ok((rifle.points ?? 0) > 0, 'the rifle step adds points');
});

test('the readiness record, the import columns and the schema carry every figure the estimate reads', () => {
  const shape = Object.keys(readinessSchema.shape);
  const columns = READINESS_COLUMNS.map((c) => c.key);
  for (const key of JEPES_READINESS_COLUMNS) {
    assert.ok(shape.includes(key), `${key} is saved`);
    assert.ok(columns.includes(key), `${key} is in the spreadsheet columns`);
  }
  assert.deepEqual(readinessSchema.parse({ rifle_score: '310', mcmap_instructor: true, bonus_msg_school: 0, courses_in_grade: ' ' }), { rifle_score: 310, mcmap_instructor: 1, bonus_msg_school: 0, courses_in_grade: null });
  for (const bad of [{ rifle_score: 351 }, { rifle_score: 310.5 }, { mos_qual_points: 101 }, { associate_degrees: -1 }, { bonus_di_school: 2 }]) assert.throws(() => readinessSchema.parse(bad), JSON.stringify(bad));
});

let app: TestApp;
let marine: { token: string; id: string };
let leader: { token: string; id: string };
let outsider: { token: string; id: string };

before(async () => {
  app = await startApp();
  const op = await app.setupOperator();
  marine = await app.register('lcpljepes', { rank_id: 'LCpl' });
  leader = await app.register('sgtjepes', { rank_id: 'Sgt' });
  outsider = await app.register('elsewhere');
  await enroll(app, op.token, 'G8', marine.id);
  await enroll(app, op.token, 'G8', leader.id, 'snco');
});
after(() => app?.close());

test('the Marine saves the figures; a leader who sees their readiness reads them, audited; no one else does', async () => {
  const { rank_grade: _rank, ...figures } = LCPL;
  void _rank;
  const saved = await app.call('PUT', '/api/me/readiness', { token: marine.token, body: { ...figures, mcmap_instructor: 0, bonus_security_forces: 0 } });
  assert.equal(saved.status, 200);
  for (const [key, value] of Object.entries(figures)) assert.equal(saved.body[key], value, key);
  assert.equal(saved.body.rank_grade, 'E-3');
  // The same estimate on the server's figures as on the page.
  assert.deepEqual(estimateJepes(saved.body, { on: TODAY }).total, exact(656));
  assert.equal((await app.call('PUT', '/api/me/readiness', { token: marine.token, body: { rifle_score: 351 } })).status, 400);
  assert.equal((await app.call('PUT', '/api/me/readiness', { token: marine.token, body: { bonus_di_school: 'yes' } })).status, 400);

  const before = (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_readiness' AND actor_id = ? AND subject_id = ?`).get(leader.id, marine.id) as { n: number }).n;
  const read = await app.call('GET', `/api/me/readiness/${marine.id}`, { token: leader.token });
  assert.equal(read.status, 200);
  assert.equal(read.body.rifle_score, 310);
  assert.equal(read.body.mos_qual_points, 30);
  const after = (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_readiness' AND actor_id = ? AND subject_id = ?`).get(leader.id, marine.id) as { n: number }).n;
  assert.equal(after, before + 1, 'a leader’s read is audited');
  assert.equal((await app.call('GET', `/api/me/readiness/${marine.id}`, { token: outsider.token })).status, 403);
  assert.equal((await app.call('GET', `/api/me/readiness/${leader.id}`, { token: marine.token })).status, 403);
});
