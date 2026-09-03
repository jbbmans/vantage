/** Boots Vantage in test mode for Playwright: in-memory database, memory mailer, built client from dist/. */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';

const port = Number(process.env.VANTAGE_BROWSER_PORT || 8797);
if (!existsSync(join(PROJECT_ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing. Run `npm run build` before the browser tests.');
  process.exit(1);
}
const config = loadConfig({
  ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
  VANTAGE_SECRET: 'browser-test-secret-browser-test-secret-1234', VANTAGE_PUBLIC_URL: `http://localhost:${port}`, VANTAGE_OPERATOR: '', VANTAGE_SELF_REGISTRATION: 'true',
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
const app = createApp(ctx);

const server = createServer((req, res) => {
  if (req.url?.startsWith('/api/__test/mail')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ctx.mailer.outbox));
    return;
  }
  app(req, res);
});
server.listen(port, '127.0.0.1', () => console.log(`Vantage browser-test server on http://localhost:${port}`));
