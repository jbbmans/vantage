import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { loadConfig } from './config.ts';
import { createApp, createContext, startSchedulers } from './app.ts';
import { VERSION } from './version.ts';
import { closeAuditSink } from './services/auditSink.ts';
import { readCrls, crlStamp } from './auth/crl.ts';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
const stopSchedulers = startSchedulers(ctx);

const banner = (scheme: string, extra = '') =>
  `Vantage v${VERSION} listening on ${scheme}://0.0.0.0:${config.port} (${config.production ? 'production' : 'development'}) db=${config.databasePath}${extra}`;

const tlsOptions = () => ({
  cert: readFileSync(requireEnv('CAC_TLS_CERT')),
  key: readFileSync(requireEnv('CAC_TLS_KEY')),
  ca: readFileSync(config.cac.caBundlePath),
  ...(config.cac.revocation === 'crl' ? { crl: readCrls(config.cac.crlDir) } : {}),
  requestCert: true,
  rejectUnauthorized: false,
});

const server = config.cac.mode === 'direct'
  ? createHttpsServer(tlsOptions(), app)
    .listen(config.port, '0.0.0.0', () => console.log(banner('https', ` cac=direct revocation=${config.cac.revocation}`)))
  : app.listen(config.port, '0.0.0.0', () => console.log(banner('http', config.cac.mode === 'proxy' ? ' cac=proxy' : '')));

if (config.cac.mode === 'direct' && config.cac.revocation === 'off') {
  console.warn('CAC_REVOCATION=off: cards are accepted without checking whether they were revoked.');
}
if (config.cac.mode === 'direct' && config.cac.revocation === 'crl') {
  // CRLs are refreshed by a job outside Vantage. Pick up new ones without a restart; keep the old ones if a refresh is unreadable.
  let stamp = crlStamp(config.cac.crlDir);
  const reload = setInterval(() => {
    try {
      const next = crlStamp(config.cac.crlDir);
      if (next === stamp) return;
      (server as HttpsServer).setSecureContext(tlsOptions());
      stamp = next;
      console.log(`${new Date().toISOString()} CAC revocation lists reloaded from ${config.cac.crlDir}`);
    } catch (e) { console.warn(`CAC revocation lists not reloaded: ${(e as Error).message}`); }
  }, 10 * 60_000);
  reload.unref();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CAC_MODE=direct needs ${name} pointing at this server's own TLS certificate and key.`);
  return value;
}

const shutdown = (signal: string) => () => {
  console.log(`${signal} received, shutting down.`);
  stopSchedulers();
  server.close(() => { closeAuditSink(ctx); try { ctx.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
