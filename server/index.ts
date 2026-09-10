import { loadConfig } from './config.ts';
import { createApp, createContext, startSchedulers } from './app.ts';
import { VERSION } from './version.ts';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
const stopSchedulers = startSchedulers(ctx);

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Vantage v${VERSION} listening on :${config.port} (${config.production ? 'production' : 'development'}) db=${config.databasePath}`);
});

const shutdown = (signal: string) => () => {
  console.log(`${signal} received, shutting down.`);
  stopSchedulers();
  server.close(() => { try { ctx.db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
