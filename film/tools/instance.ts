import { createServer } from 'node:http';
import { loadConfig } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';

/** A fresh accounts-mode instance for the films the demo cannot show: first run, invitations, administration. */
const port = Number(process.env.VANTAGE_FILM_INSTANCE_PORT || 8799);
const config = loadConfig({
  ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_ACCESS_MODE: 'accounts', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory',
  VANTAGE_MARADMIN_ENABLED: 'false', VANTAGE_AI_ENABLED: 'false', VANTAGE_OPERATOR: '', VANTAGE_SECRET: 'film-instance-secret-film-instance-secret-1234',
  VANTAGE_PUBLIC_URL: `http://localhost:${port}`,
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
createServer(createApp(ctx)).listen(port, '127.0.0.1', () => console.log(`Vantage film instance on http://localhost:${port}`));
