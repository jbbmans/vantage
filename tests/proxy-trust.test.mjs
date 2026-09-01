import assert from 'node:assert/strict';
import { isTrustedProxyAddress } from '../server/proxyTrust.js';

assert.equal(isTrustedProxyAddress('10.20.4.8', ['10.20.0.0/16']), true);
assert.equal(isTrustedProxyAddress('10.21.4.8', ['10.20.0.0/16']), false);
assert.equal(isTrustedProxyAddress('::ffff:127.0.0.1', ['127.0.0.1']), true);
assert.equal(isTrustedProxyAddress('2001:db8::7', ['2001:db8::/32']), true);
assert.equal(isTrustedProxyAddress('2001:db9::7', ['2001:db8::/32']), false);

console.log('  ok    trusted CAC/PIV proxy address boundaries');
