import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, parseConfigYaml, validateConfig } from '../server/config.js';

const parsed = parseConfigYaml(`
app:
  name: VANTAGE
  data_mode: evaluation
features:
  enabled: true
  count: 12
  types: [application/pdf, image/png]
`);

assert.deepEqual(parsed, {
  app: { name: 'VANTAGE', data_mode: 'evaluation' },
  features: { enabled: true, count: 12, types: ['application/pdf', 'image/png'] },
});
assert.throws(() => parseConfigYaml('app:\n   name: VANTAGE'), /two-space indentation/i);
assert.throws(() => parseConfigYaml('app:\n  name: one\n  name: two'), /duplicate key/i);
assert.throws(() => parseConfigYaml('constructor: unsafe'), /unsafe configuration key/i);

const cacWithoutBoundary = structuredClone(DEFAULT_CONFIG);
cacWithoutBoundary.auth.cac_piv.enabled = true;
assert.throws(() => validateConfig(cacWithoutBoundary), /trusted_proxy_ips/i);
const cacWithBoundary = structuredClone(cacWithoutBoundary);
cacWithBoundary.auth.cac_piv.trusted_proxy_ips = ['10.10.0.0/16', '2001:db8::1'];
assert.equal(validateConfig(cacWithBoundary).auth.cac_piv.trusted_proxy_ips.length, 2);
const unsafeCacHeader = structuredClone(cacWithBoundary);
unsafeCacHeader.auth.cac_piv.subject_header = 'x-forwarded-user';
assert.throws(() => validateConfig(unsafeCacHeader), /forwarding header/i);

const integrations = structuredClone(DEFAULT_CONFIG);
integrations.integrations.enabled = true;
integrations.integrations.requests_per_15_minutes = 30;
assert.equal(validateConfig(integrations).integrations.enabled, true);
integrations.integrations.requests_per_15_minutes = 29;
assert.throws(() => validateConfig(integrations), /integrations\.requests_per_15_minutes/i);

console.log('  ok    strict YAML configuration parser');
