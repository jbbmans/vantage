import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-scenario-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';

process.env.VANTAGE_OPERATOR = 'boletz';

const { app, db } = await import('../server/index.js');
const { seedTestUnits } = await import('./helpers/seed-test-units.mjs');
seedTestUnits(db);
const { composeNarrative } = await import('../src/lib/narrative.js');
const { comparePeriods } = await import('../src/lib/delta.js');
const { fiscalQuarterRange } = await import('../src/lib/metrics.js');
const { estimate, recommend } = await import('../src/lib/jepes.js');

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://localhost:${server.address().port}`;

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message}`]); }
};

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const login = async (u, p) => (await call('POST', '/api/login', { body: { username: u, password: p } })).body.token;

await call('POST', '/api/setup', {
  body: {
    username: 'boletz', password: 'a-long-enough-passphrase-here',
    first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', mos: '3451',
    unit_code: 'MFR', billet_title: 'Accounting Chief',
  },
});
const chief = await login('boletz', 'a-long-enough-passphrase-here');
const chiefMe = (await call('GET', '/api/me', { token: chief })).body;

for (const unitId of ['G8-FMRAC', 'G8-BUDGET']) {
  const res = await call('POST', `/api/org/units/${unitId}/claim`, {
    token: chief, body: { owner_user_id: chiefMe.user.id, template_id: 'default' },
  });
  assert.equal(res.status, 200, `claim ${unitId}: ${res.status} ${JSON.stringify(res.body)}`);
}

const people = [
  ['ohara', 'Sean', 'OHara', 'Sgt', 'G8-FMRAC', 'fire-team-leader', 'G8-FMRAC:fire-team-leader'],
  ['delgado', 'Ana', 'Delgado', 'LCpl', 'G8-FMRAC', 'financial-management-resource-analyst', null],
  ['whitfield', 'Marcus', 'Whitfield', 'PFC', 'G8-FMRAC', 'financial-management-resource-analyst', null],
  ['kramer', 'Dale', 'Kramer', 'Sgt', 'G8-BUDGET', 'budget-chief', 'G8-BUDGET:fire-team-leader'],
];
for (const [username, first, last, rank, unit, billet, roleId] of people) {
  await call('POST', '/api/team', {
    token: chief,
    body: {
      username, password: `${username}-long-enough-passphrase`, first_name: first, last_name: last,
      rank_id: rank, mos: '3451', unit_id: unit, billet_id: billet, role_id: roleId,
    },
  });
}

const teamLead = await login('ohara', 'ohara-long-enough-passphrase');
const analyst = await login('delgado', 'delgado-long-enough-passphrase');
const budgetLead = await login('kramer', 'kramer-long-enough-passphrase');
const delgadoId = (await call('GET', '/api/me', { token: analyst })).body.user.id;

const WORK = [
  ['2026-07-05', 'Reconciled aged unliquidated obligations', 30, 'ULOs', 1118.38, 'reconciled', 'DAI',
    'MOS / Mission Accomplishment', "cleared the section's aged ULO backlog"],
  ['2026-07-14', 'Corrected unmatched transactions', 5, 'UMTs', 842000, 'saved', 'SABRS',
    'MOS / Mission Accomplishment', 'prevented an FY-end deobligation shortfall'],
  ['2026-08-02', 'Processed MIPRs for the command element', 12, 'MIPRs', 3200000, 'obligated', 'DAI',
    'MOS / Mission Accomplishment', null],
  ['2026-08-09', 'Served on Color Guard for command ceremonies', 4, 'ceremonies', null, null, null,
    'Individual Character', null],
];
for (const [date, title, quantity, unit, dollar_amount, dollar_type, system, jepes_area, result] of WORK) {
  await call('POST', '/api/activities', {
    token: analyst,
    body: { date, title, quantity, unit_label: unit, dollar_amount, dollar_type, system, jepes_area, result,
      category: 'Fiscal & Financial', visibility: 'unit', unit_id: 'G8-FMRAC' },
  });
}

await call('POST', '/api/activities', {
  token: analyst,
  body: { date: '2026-05-02', title: 'Reconciled obligations', quantity: 8, unit_label: 'ULOs',
    dollar_amount: 400, dollar_type: 'reconciled', jepes_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8-FMRAC' },
});

await call('POST', '/api/activities', {
  token: analyst,
  body: { date: '2026-08-11', title: 'Personal note about a counseling session', visibility: 'private' },
});

await test('a fire team leader sees their team but not the whole section', async () => {
  const res = await call('GET', '/api/team', { token: teamLead });
  const names = res.body.roster.map((r) => r.last_name).sort();



  assert.deepEqual(names, ['Boletz', 'Delgado', 'OHara', 'Whitfield']);
});

await test('a peer team lead in another branch sees only their own', async () => {
  const res = await call('GET', '/api/team', { token: budgetLead });
  const names = res.body.roster.map((r) => r.last_name).sort();
  assert.deepEqual(names, ['Boletz', 'Kramer']);
  assert.ok(!names.includes('Delgado'), 'a Budget lead must not see an FMRAC analyst');
});

await test('the section head sees every branch', async () => {
  const res = await call('GET', '/api/team', { token: chief });
  const names = res.body.roster.map((r) => r.last_name).sort();
  assert.deepEqual(names, ['Boletz', 'Delgado', 'Kramer', 'OHara', 'Whitfield']);
});

await test("a team lead can open their Marine's record", async () => {
  const res = await call('GET', `/api/team/${delgadoId}`, { token: teamLead });
  assert.equal(res.status, 200);
  assert.equal(res.body.person.billet_title, 'Financial Management Resource Analyst');
});

await test('the private entry never reaches the chain of command', async () => {
  const lead = await call('GET', '/api/activities', { token: teamLead });
  const head = await call('GET', '/api/activities', { token: chief });
  for (const view of [lead, head]) {
    assert.ok(!view.body.some((a) => a.title.includes('counseling')), 'private entry leaked');
  }
});

await test('shared work rolls up to both the team lead and the section head', async () => {
  const lead = await call('GET', '/api/activities', { token: teamLead });
  const head = await call('GET', '/api/activities', { token: chief });
  for (const view of [lead, head]) {
    assert.ok(view.body.some((a) => a.title.includes('unliquidated')), 'shared entry did not roll up');
  }
});

await test('a Marine in a different branch sees none of it', async () => {
  const res = await call('GET', '/api/activities', { token: budgetLead });
  assert.equal(res.body.length, 0);
});

await test('a section head tasks each shop they hold, and it reaches the bottom', async () => {
  for (const unitId of ['G8-FMRAC', 'G8-BUDGET']) {
    const res = await call('POST', '/api/tasks', {
      token: chief,
      body: { title: 'Submit FY26 Q4 JEPES inputs', visibility: 'unit', unit_id: unitId,
        priority: 'high', due_date: '2026-09-15' },
    });
    assert.equal(res.status, 200, `tasking ${unitId}: ${res.status}`);
  }
  for (const [who, token] of [['team lead', teamLead], ['analyst', analyst], ['budget lead', budgetLead]]) {
    const res = await call('GET', '/api/tasks', { token });
    assert.ok(res.body.some((t) => t.title.includes('JEPES inputs')), `${who} did not receive the tasking`);
  }
});

await test('a task posted to one shop does not appear in the other', async () => {
  await call('POST', '/api/tasks', {
    token: chief,
    body: { title: 'FMRAC-only reconciliation sweep', visibility: 'unit', unit_id: 'G8-FMRAC' },
  });
  const budget = await call('GET', '/api/tasks', { token: budgetLead });
  assert.ok(
    !budget.body.some((t) => t.title.includes('reconciliation sweep')),
    'a task aimed at one shop reached another'
  );
});

await test('a fire team goal reaches the team and stops there', async () => {
  await call('POST', '/api/goals', {
    token: teamLead,
    body: { title: 'Zero aged ULOs by 30 SEP', target_value: 0, visibility: 'unit', unit_id: 'G8-FMRAC' },
  });
  const inTeam = await call('GET', '/api/goals', { token: analyst });
  assert.ok(inTeam.body.some((g) => g.title.includes('Zero aged ULOs')));

  const outside = await call('GET', '/api/goals', { token: budgetLead });
  assert.ok(!outside.body.some((g) => g.title.includes('Zero aged ULOs')), 'goal leaked to another branch');
});

await test('the section head sees the goal their subordinate leader set', async () => {
  const res = await call('GET', '/api/goals', { token: chief });
  assert.ok(res.body.some((g) => g.title.includes('Zero aged ULOs')));
});

await test("a JEPES narrative composes from the Marine's real record", async () => {
  const record = await call('GET', `/api/team/${delgadoId}`, { token: teamLead });
  const narrative = composeNarrative(record.body.activities, { limit: 1000 });
  assert.ok(narrative.length > 0 && narrative.length <= 1000, `length ${narrative.length}`);
  assert.ok(/MISSION/.test(narrative.text));
  assert.ok(/\$4\.04M|\$4,04/.test(narrative.text) || /ULOs/.test(narrative.text), narrative.text);
  assert.ok(!/counseling/.test(narrative.text), 'private entry reached the narrative');
});

await test('the change report compares this quarter against the last', async () => {
  const record = await call('GET', `/api/team/${delgadoId}`, { token: teamLead });
  const acts = record.body.activities.map((a) => ({ ...a, unit: a.unit_label }));
  const cmp = comparePeriods(acts, fiscalQuarterRange(new Date(2026, 7, 20)));
  assert.equal(cmp.counts.current, 4);
  assert.equal(cmp.counts.prior, 1);
  assert.ok(cmp.headline.dollars.diff > 0, 'dollars should be up on the prior quarter');
  assert.ok(cmp.headline.activities.pct > 0);
});

await test('the Marine can see who read their record', async () => {
  await call('GET', `/api/team/${delgadoId}`, { token: chief });
  const res = await call('GET', '/api/audit', { token: analyst });
  assert.ok(res.body.length > 0);
  assert.ok(res.body.some((r) => r.last_name === 'Boletz' || r.last_name === 'OHara'));
});

await test('a Marine cannot promote themselves', async () => {
  const res = await call('PUT', `/api/team/${delgadoId}/assignment`, {
    token: analyst,
    body: { unit_id: 'MFR', role: 'unit_leader' },
  });
  assert.equal(res.status, 403);
});

await test('a Marine can build their own JEPES plan from their record', async () => {
  await call('PUT', '/api/readiness', {
    token: analyst,
    body: {
      pft_score: 268, cft_score: 245, mcmap_belt: 'Grey', rifle_qual: 'Sharpshooter',
      ceus: 18, college_credits: 12, cmd_character: 3.4, cmd_mos: 3.3, cmd_leadership: 3.5,
    },
  });
  const profile = (await call('GET', '/api/readiness', { token: analyst })).body;
  const est = estimate(profile);
  assert.equal(est.total, undefined, 'the dashboard must not fabricate a composite');
  assert.equal(est.completeness, 1, 'all four pillars should have data');
  assert.ok(est.pillars.physical.items.find((i) => i.key === 'pft').value.includes('1st class'));

  const recs = recommend(profile, { total: 5, withOutcome: 4, thinAreas: [] });
  assert.ok(recs.length > 0);
  assert.ok(recs.some((r) => r.id === 'mcmap'), 'should flag the belt');
  assert.ok(recs.some((r) => r.id === 'rifle'), 'should flag the rifle qual');
  assert.ok(recs.some((r) => r.id === 'ceus'), 'should flag CEUs');

  assert.ok(recs[0].priority >= recs[1].priority);
  assert.ok(recs.every((r) => r.gain === undefined && ['data', 'heuristic', 'official'].includes(r.kind)));
});

await test('a section head can stand up a fire team and staff it', async () => {
  const unit = await call('POST', '/api/org/units', {
    token: chief,
    body: { name: 'Audit Readiness Cell', short_name: 'ARC', echelon: 'fire_team', parent_id: 'MFR' },
  });
  assert.equal(unit.status, 200);




  await call('POST', '/api/team', {
    token: chief,
    body: {
      username: 'reyes', password: 'reyes-long-enough-passphrase', first_name: 'Luis', last_name: 'Reyes',
      rank_id: 'Cpl', unit_id: unit.body.id, role_id: `${unit.body.id}:nco`,
    },
  });

  const roster = await call('GET', '/api/team', { token: chief });
  assert.ok(roster.body.roster.some((r) => r.last_name === 'Reyes'));




  const token = await login('reyes', 'reyes-long-enough-passphrase');
  const theirs = await call('GET', '/api/team', { token });
  assert.deepEqual(theirs.body.roster.map((r) => r.last_name).sort(), ['Boletz', 'Reyes']);
  const upward = await call('GET', `/api/team/${chiefMe.user.id}`, { token });
  assert.equal(upward.status, 403, 'must not be able to read upward');
});

server.close();
try {
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
} catch {  }

const failed = results.filter(([s]) => s === 'FAIL');
for (const [status, name] of results) console.log(`  ${status === 'PASS' ? 'ok  ' : 'FAIL'}  ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
