import assert from 'node:assert/strict';
import { parseConfigYaml } from '../server/config.js';

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

console.log('  ok    strict YAML configuration parser');
