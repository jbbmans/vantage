/** Boots Vantage in synthetic demo mode for the demo journey spec: in-memory database, built client. */
import { createServer } from 'node:http';
import { loadConfig } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';

const port = Number(process.env.VANTAGE_DEMO_PORT || 8798);
const config = loadConfig({
  ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_ACCESS_MODE: 'demo', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'none',
  VANTAGE_MARADMIN_ENABLED: 'false', VANTAGE_AI_ENABLED: 'false', VANTAGE_SECRET: 'demo-browser-secret-demo-browser-secret-1234', VANTAGE_PUBLIC_URL: `http://localhost:${port}`,
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
const app = createApp(ctx);
createServer(app).listen(port, '127.0.0.1', () => console.log(`Vantage demo server on http://localhost:${port}`));
