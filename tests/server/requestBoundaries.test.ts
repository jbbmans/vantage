import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { startApp, type TestApp } from './helpers.ts';
import { fieldErrors } from '../../shared/schemas.ts';
import { entrySchema, stageChangeSchema } from '../../shared/caseSchemas.ts';

let app: TestApp;
let token: string;
before(async () => { app = await startApp(); token = (await app.setupOperator()).token; });
after(async () => { await app.close(); });

test('large platform imports reach the privileged route parser; they do not fall into the ordinary 4 MB parser', async () => {
  const body = { format: 'invalid-test-archive', padding: 'x'.repeat(4 * 1024 * 1024 + 100) };
  const result = await app.call('POST', '/api/platform/import', { token, body });
  assert.equal(result.status, 400, result.text.slice(0, 500));
  assert.match(result.body.error, /not a Vantage instance archive/i);
  const anonymous = await app.call('POST', '/api/platform/import', { body: { format: 'invalid' } });
  assert.equal(anonymous.status, 401);
});

test('ordinary requests retain size limits and useful 400/415 errors; valid gzip still works', async () => {
  const tooLarge = await app.call('POST', '/api/auth/login', { body: { padding: 'x'.repeat(4 * 1024 * 1024 + 100) } });
  assert.equal(tooLarge.status, 413);
  const invalid = await app.call('POST', '/api/auth/login', { raw: Buffer.from('{'), headers: { 'content-type': 'application/json' } });
  assert.equal(invalid.status, 400);
  const charset = await app.call('POST', '/api/auth/login', { raw: Buffer.from('{}'), headers: { 'content-type': 'application/json; charset=iso-8859-1' } });
  assert.equal(charset.status, 415); assert.equal(charset.body.code, 'unsupported_charset');
  const encoding = await app.call('POST', '/api/auth/login', { raw: Buffer.from('{}'), headers: { 'content-type': 'application/json', 'content-encoding': 'unsupported' } });
  assert.equal(encoding.status, 415); assert.equal(encoding.body.code, 'unsupported_encoding');
  const zipped = await app.call('POST', '/api/auth/login', { raw: gzipSync(Buffer.from('{}')), headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  assert.equal(zipped.status, 400, 'decompression succeeds and login validation rejects missing fields');
  assert.equal((await app.call('GET', '/api/health')).status, 200);
});

test('case dates reject impossible calendar days and accept leap days', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10']) {
    assert.equal(entrySchema.safeParse({ kind: 'observation', field: 'other', observed_on: date }).success, false, date);
    assert.equal(stageChangeSchema.safeParse({ stage: 'waiting', expected_by: date }).success, false, date);
  }
  assert.equal(entrySchema.safeParse({ kind: 'observation', field: 'other', observed_on: '2028-02-29' }).success, true);
});

test('validation output is bounded and represents reserved property names without changing the object prototype', () => {
  const error = new z.ZodError(Array.from({ length: 2000 }, (_, i) => ({ code: 'custom', path: [i === 0 ? '__proto__' : `field-${i}-${'x'.repeat(200)}`], message: 'm'.repeat(1000) })));
  const fields = fieldErrors(error);
  assert.equal(Object.getPrototypeOf(fields), Object.prototype);
  assert.equal(Object.keys(fields).length, 25);
  assert.ok(Object.hasOwn(fields, '__proto__'));
  assert.ok(Object.keys(fields).every((k) => k.length <= 160));
  assert.ok(Object.values(fields).every((message) => message.length <= 400));
  assert.ok(JSON.stringify(fields).length < 15000);
});
