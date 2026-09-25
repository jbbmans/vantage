import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnose, sourceExamples, describeError, ERROR_OPTIONS, METHODS, METHOD_KEYS, routeRequirement, trueAvailableBalance,
  NORMAL_CONDITIONS, UMT_ERRORS, ROUTES, GLOSSARY, searchGlossary, DISCREPANCIES, citeText, cite, PRINTED_THRESHOLDS,
} from '../../shared/fmra/index.ts';

test('the diagnoser classifies all eight of the reference’s numerical examples', () => {
  const examples = sourceExamples();
  assert.equal(examples.length, 8);
  for (const ex of examples) {
    const d = diagnose(ex.input);
    assert.ok(d.ok, ex.id);
    if (!d.ok) continue;
    assert.equal(d.findings.length, 1, `${ex.id}: ${JSON.stringify(d.findings)}`);
    assert.equal(d.findings[0].condition, ex.condition, ex.id);
    assert.equal(d.findings[0].pattern, ex.pattern, ex.id);
    assert.equal(d.findings[0].residualCents, ex.residualCents, ex.id);
    assert.equal(d.anomalies.length, 0, ex.id);
    assert.equal(d.procedure, `${ex.condition}_research`);
  }
});

test('causes are filtered to the pattern the figures show', () => {
  const full = diagnose({ commitment: 10_000, obligation: 10_000 });
  assert.ok(full.ok);
  if (!full.ok) return;
  const keys = full.causes.map((c) => c.key);
  assert.ok(keys.includes('valid_back_order'));
  assert.ok(keys.includes('erroneous_award'), 'erroneous award is a full-pattern cause');
  assert.ok(!keys.includes('final_price_lower'), 'lower final price is a partial-pattern cause');

  const partial = diagnose({ commitment: 10_000, obligation: 10_000, delivered: 5_000, paid: 5_000 });
  assert.ok(partial.ok);
  if (!partial.ok) return;
  const pk = partial.causes.map((c) => c.key);
  assert.ok(pk.includes('final_price_lower'));
  assert.ok(!pk.includes('erroneous_award'));
});

test('a MIPR cause is only offered when the method could be a MIPR', () => {
  const unknown = diagnose({ commitment: 10_000 });
  const gpc = diagnose({ commitment: 10_000, method: 'gpc' });
  const mipr = diagnose({ commitment: 10_000, method: 'mipr' });
  assert.ok(unknown.ok && gpc.ok && mipr.ok);
  if (!unknown.ok || !gpc.ok || !mipr.ok) return;
  assert.ok(unknown.causes.some((c) => c.key === 'mipr_not_acknowledged'));
  assert.ok(!gpc.causes.some((c) => c.key === 'mipr_not_acknowledged'));
  assert.ok(mipr.causes.some((c) => c.key === 'mipr_not_acknowledged'));
  assert.ok(mipr.limits.some((l) => l.includes('DD 448-2')));
});

test('a figure that is not shown is not treated as a zero balance, and travel carries no commitment', () => {
  const d = diagnose({ method: 'tdy', obligation: 10_000 });
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(d.findings[0].condition, 'oto');
  assert.ok(!d.limits.some((l) => l.includes('commitment is shown')));
  const noCommit = diagnose({ obligation: 10_000 });
  assert.ok(noCommit.ok);
  if (!noCommit.ok) return;
  assert.ok(noCommit.limits.some((l) => l.includes('No commitment is shown')), 'a blank commitment is flagged, not assumed missing');
  assert.equal(noCommit.findings[0].condition, 'udou');
});

test('several open phases on one document are all reported, in lifecycle order', () => {
  const d = diagnose({ commitment: 20_000, obligation: 10_000, delivered: 5_000, paid: 0 });
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.deepEqual(d.findings.map((f) => [f.condition, f.residualCents]), [['ocmt', 10_000], ['udou', 5_000], ['dou', 5_000]]);
});

test('out-of-order figures are anomalies pointing at the abnormal-condition procedures', () => {
  const overpaid = diagnose({ commitment: 10_000, obligation: 10_000, delivered: 10_000, paid: 12_000 });
  assert.ok(overpaid.ok);
  if (!overpaid.ok) return;
  assert.ok(overpaid.anomalies.some((a) => a.key === 'paid_exceeds_obligation'));
  assert.equal(overpaid.procedure, 'umt_four_stage');

  const homeless = diagnose({ paid: 5_000 });
  assert.ok(homeless.ok);
  if (!homeless.ok) return;
  assert.equal(homeless.anomalies[0].title, 'Payment with no obligation shown');

  const overReceived = diagnose({ commitment: 10_000, obligation: 10_000, delivered: 15_000 });
  assert.ok(overReceived.ok);
  if (!overReceived.ok) return;
  assert.ok(overReceived.anomalies.some((a) => a.key === 'delivered_exceeds_obligation' && a.procedure === 'invoice_hold'));
});

test('a complete lifecycle is recognized and still asks for its evidence', () => {
  const d = diagnose({ commitment: 10_000, obligation: 10_000, delivered: 10_000, paid: 10_000, method: 'gcss' });
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(d.complete, true);
  assert.equal(d.findings.length, 0);
  assert.deepEqual(d.evidence.map((e) => e.group), ['Request and order', 'Receipt and acceptance', 'Payment']);
  assert.ok(d.evidence[1].items.includes('DD 1348-1A'));
});

test('invalid input is refused rather than guessed at', () => {
  assert.equal(diagnose({}).ok, false);
  assert.equal(diagnose({ commitment: -100 }).ok, false);
  assert.equal(diagnose({ commitment: 1.5 }).ok, false);
});

test('the guard against a receipt with no delivery travels with every UDOU', () => {
  const d = diagnose({ commitment: 10_000, obligation: 10_000 });
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.ok(d.limits.includes(NORMAL_CONDITIONS.udou.guard!));
});

test('age alone never establishes invalidity', () => {
  const d = diagnose({ commitment: 10_000, ageDays: 400 });
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.ok(d.limits.some((l) => l.includes('400 days old') && l.includes('age alone does not establish')));
});

test('an exact UMT error label maps to its correction and posting route', () => {
  const mismatch = describeError('umt', 'data_elements_mismatch');
  assert.equal(mismatch?.route, '1081');
  assert.match(mismatch!.correction, /DFAS/);
  for (const e of UMT_ERRORS.filter((x) => x.key !== 'data_elements_mismatch')) assert.equal(e.route, 'NON-1081', e.key);
  assert.equal(ROUTES['1081'].performer, 'DFAS-Cleveland');
  assert.equal(ROUTES['NON-1081'].performer, 'FMRA');

  const d = diagnose({ paid: 5_000, error: { kind: 'umt', key: 'no_matching_record' } });
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(d.procedure, 'umt_four_stage');
  assert.ok(d.research[0].includes('mismatched identifier'), 'no matching record is validated before anything is posted');
  assert.ok(d.next[0].includes('NON-1081'));
});

test('every error option resolves to a description', () => {
  for (const group of ERROR_OPTIONS) for (const o of group.options) assert.ok(describeError(group.kind, o.key), `${group.kind}:${o.key}`);
  assert.equal(describeError('umt', 'nonsense'), null);
});

test('every method carries the three evidence groups and a verification', () => {
  assert.equal(METHOD_KEYS.length, 7);
  for (const key of METHOD_KEYS) {
    const m = METHODS[key];
    assert.ok(m.ksd.request.length && m.ksd.receipt.length && m.ksd.payment.length, key);
    assert.ok(m.verification.length > 40, key);
    assert.ok(m.phases[0].steps[0].text.includes('POET'), `${key} starts from the shared POET setup`);
  }
  assert.ok(METHODS.fuel.ksd.note?.includes('never permission to omit'));
});

test('the router narrows the method and never presents a printed threshold as a rule', () => {
  assert.deepEqual(routeRequirement({ kind: 'travel' }).methods, ['tdy']);
  assert.deepEqual(routeRequirement({ kind: 'good', hasNsn: true, nsnUse: 'maintenance' }).methods, ['gcss']);
  assert.deepEqual(routeRequirement({ kind: 'good', hasNsn: true }).methods, ['servmart']);
  const big = routeRequirement({ kind: 'service', amountCents: 500_000 });
  assert.deepEqual(big.methods, ['contract']);
  assert.ok(big.cautions.some((c) => c.includes('not a verified current limit')));
  const small = routeRequirement({ kind: 'good', amountCents: 999_999 });
  assert.deepEqual(small.methods, ['gpc', 'contract']);
  assert.ok(small.cautions.some((c) => c.includes('does not by itself authorize')));
  assert.equal(PRINTED_THRESHOLDS.find((t) => t.category === 'Services')?.cents, 350_000);
});

test('true available balance never deducts a posted item twice', () => {
  const r = trueAvailableBalance({ displayedAvailableCents: 100_000, pendingNotReflected: [{ label: 'toner', cents: 15_000 }, { label: 'paper', cents: 5_000, posted: true }] });
  assert.equal(r.adjustedCents, 85_000);
  assert.equal(r.ignored.length, 1);
});

test('the glossary and the discrepancy register are searchable and cited', () => {
  assert.ok(GLOSSARY.length > 50);
  assert.ok(searchGlossary('1081').some((t) => t.term.includes('1081')));
  assert.ok(DISCREPANCIES.length >= 17);
  assert.equal(citeText(cite('8.3', '100-102')), 'FMRAC 8.3 · orig. pp. 100-102');
  assert.equal(citeText(cite('11.3', '117')), 'FMRAC 11.3 · orig. p. 117');
});

test('the reading of the figures is one sentence with one full stop', () => {
  const one = diagnose({ commitment: 3_200_000 });
  assert.ok(one.ok);
  if (!one.ok) return;
  assert.match(one.meaning, /^OCMT \(full\) — \$32,000\.00 open: a requisition amount not yet covered by an obligation\.$/);
  const two = diagnose({ commitment: 10_000, obligation: 8_000, delivered: 5_000 });
  assert.ok(two.ok);
  if (!two.ok) return;
  assert.ok(!/\.\.|\.;/.test(two.meaning), two.meaning);
});
