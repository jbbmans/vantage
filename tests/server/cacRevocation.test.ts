import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request, type Server } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { readCrls } from '../../server/auth/crl.ts';
import { loadConfig } from '../../server/config.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cac-crl');
const file = (name: string) => readFileSync(join(DIR, name));

/** The same TLS options server/index.ts uses in direct mode, with the fixture CA and CRLs. */
async function directServer(withCrl: boolean): Promise<{ server: Server; port: number }> {
  const server = createServer({
    cert: file('server.pem'), key: file('server.key'), ca: file('ca.pem'),
    ...(withCrl ? { crl: readCrls(join(DIR, 'crls')) } : {}),
    requestCert: true, rejectUnauthorized: false,
  }, (req, res) => {
    const socket = req.socket as TLSSocket;
    res.end(JSON.stringify({ authorized: socket.authorized, error: String(socket.authorizationError || '') }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as { port: number }).port };
}

function present(port: number, card: 'good' | 'revoked'): Promise<{ authorized: boolean; error: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', ca: file('ca.pem'), cert: file(`${card}.pem`), key: file(`${card}.key`), servername: 'localhost' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c)).on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end();
  });
}

test('in direct mode a revoked card is refused and a good one accepted', async () => {
  const { server, port } = await directServer(true);
  try {
    assert.deepEqual(await present(port, 'good'), { authorized: true, error: '' });
    const revoked = await present(port, 'revoked');
    assert.equal(revoked.authorized, false);
    assert.match(revoked.error, /revoked/i);
  } finally { server.close(); }
});

test('without the CRL the revoked card would have been accepted, which is why direct mode requires one', async () => {
  const { server, port } = await directServer(false);
  try {
    assert.equal((await present(port, 'revoked')).authorized, true);
  } finally { server.close(); }
  const env = { NODE_ENV: 'test', VANTAGE_TEST: '1', CAC_MODE: 'direct', CAC_CA_BUNDLE: join(DIR, 'ca.pem') } as NodeJS.ProcessEnv;
  assert.throws(() => loadConfig(env), /CAC_CRL_DIR/);
  assert.equal(loadConfig({ ...env, CAC_REVOCATION: 'off' }).cac.revocation, 'off', 'turning the check off has to be said out loud');
  assert.equal(loadConfig({ ...env, CAC_CRL_DIR: join(DIR, 'crls') }).cac.crlDir, join(DIR, 'crls'));
});

test('a CRL directory with no CRLs in it is refused rather than silently checking nothing', () => {
  assert.throws(() => readCrls(join(DIR)), /no CRL files/);
});
