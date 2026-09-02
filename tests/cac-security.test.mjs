import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'vantage-cac-'));
const configPath = join(dir, 'app.yaml');
const DB = join(dir, 'vantage.db');
writeFileSync(
  configPath,
  readFileSync('config/app.yaml', 'utf8')
    .replace('enabled: false', 'enabled: true')
    .replace('trusted_proxy_ips: []', 'trusted_proxy_ips: [127.0.0.1, ::1]')
);
process.env.VANTAGE_CONFIG = configPath;
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_CAC_PROXY_SECRET = 'cac-test-secret-material-that-is-longer-than-thirty-two-bytes';

const { app } = await import('../server/index.js');
const { resetCounters, LOGIN_LIMITS } = await import('../server/security.js');
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://localhost:${server.address().port}`;

const call = async (headers = {}) => {
  const response = await fetch(`${BASE}/api/auth/cac-piv`, { method: 'POST', headers });
  return { status: response.status, body: await response.json() };
};

const setup = await fetch(`${BASE}/api/setup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'operator', password: 'operator-long-passphrase-927', first_name: 'Ops', last_name: 'User', unit_code: 'MFR' }),
});
assert.equal(setup.status, 200);

const assertionHeaders = {
  'x-vantage-proxy-secret': process.env.VANTAGE_CAC_PROXY_SECRET,
  'x-vantage-cac-verified': 'verified',
  'x-vantage-cac-subject': 'test-subject-001',
  'x-vantage-cac-username': 'cacuser',
  'x-vantage-cac-first-name': 'CAC',
  'x-vantage-cac-last-name': 'User',
};
assert.equal((await call(assertionHeaders)).status, 200, 'allowlisted proxy assertion signs in');

resetCounters();
for (let i = 0; i < LOGIN_LIMITS.IP_MAX; i += 1) {
  const rejected = await call({ ...assertionHeaders, 'x-vantage-proxy-secret': `bad-${i}` });
  assert.equal(rejected.status, 401);
}
const throttled = await call(assertionHeaders);
assert.equal(throttled.status, 429, 'CAC failures consume the shared auth connection budget');

server.close();
rmSync(dir, { recursive: true, force: true });
console.log('  ok    CAC/PIV assertions require proxy proof and are rate limited');
