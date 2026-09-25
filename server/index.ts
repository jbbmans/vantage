import { readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { loadConfig } from './config.ts';
import { createApp, createContext, startSchedulers } from './app.ts';
import { VERSION } from './version.ts';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
const stopSchedulers = startSchedulers(ctx);

const banner = (scheme: string, extra = '') =>
  `Vantage v${VERSION} listening on ${scheme}://0.0.0.0:${config.port} (${config.production ? 'production' : 'development'}) db=${config.databasePath}${extra}`;

const server = config.cac.mode === 'direct'
  ? createHttpsServer(
      {
        cert: readFileSync(requireEnv('CAC_TLS_CERT')),
        key: readFileSync(requireEnv('CAC_TLS_KEY')),
        ca: readFileSync(config.cac.caBundlePath),
        requestCert: true,
        rejectUnauthorized: false,
      },
      app,
    ).listen(config.port, '0.0.0.0', () => console.log(banner('https', ' cac=direct')))
  : app.listen(config.port, '0.0.0.0', () => console.log(banner('http', config.cac.mode === 'proxy' ? ' cac=proxy' : '')));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`CAC_MODE=direct needs ${name} pointing at this server's own TLS certificate and key.`);
  return value;
}

const shutdown = (signal: string) => () => {
  console.log(`${signal} received, shutting down.`);
  stopSchedulers();
  server.close(() => { try { ctx.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
