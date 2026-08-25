import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'vantage-maintenance-test-'));
const database = join(root, 'vantage.db');
process.env.VANTAGE_DB = database;
process.env.VANTAGE_TEST = '1';

const { db, maintenanceGuard } = await import('../server/index.js');
const lock = `${database}.maintenance`;

function invoke(path) {
  const response = { statusCode: 200, headers: {}, body: null };
  const res = {
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    status(code) { response.statusCode = code; return this; },
    json(body) { response.body = body; return this; },
  };
  let continued = false;
  maintenanceGuard(lock)({ path }, res, () => { continued = true; });
  return { ...response, continued };
}

try {
  writeFileSync(lock, 'factory-reset test\n', { mode: 0o600 });

  const blocked = invoke('/api/config');
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.headers['cache-control'], 'no-store');
  assert.deepEqual(blocked.body, {
    error: 'Vantage is in scheduled maintenance. Try again after the deployment is reopened.',
    code: 'maintenance',
  });
  assert.equal(blocked.continued, false);

  const health = invoke('/api/health');
  assert.equal(health.continued, true);

  unlinkSync(lock);
  const reopened = invoke('/api/config');
  assert.equal(reopened.continued, true);
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

console.log('  PASS  maintenance lock blocks application APIs while preserving health checks');
