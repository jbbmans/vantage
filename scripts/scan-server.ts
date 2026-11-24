import { createServer } from 'node:http';
import { loadConfig } from '../server/config.ts';
import { createApp, createContext } from '../server/app.ts';

/**
 * The app as the security scan reaches it: the demo, in memory, with no mail, MARADMIN feed or AI, so the scan never
 * leaves the runner. A scanner sends thousands of requests from one address in minutes, which the per-person limits
 * are there to refuse; they are raised here so the scan reaches the handlers behind them. Production keeps its limits.
 */
const port = Number(process.env.VANTAGE_SCAN_PORT || 8799);
// The scanner's own key is never the app's to read: out of process.env before the app starts, and out of the settings
// it is given. The workflow also starts this step without the key.
delete process.env.HAWK_API_KEY;
delete process.env.API_KEY;
const env = { ...process.env };
const config = loadConfig({
  ...env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_ACCESS_MODE: 'demo', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'none',
  VANTAGE_MARADMIN_ENABLED: 'false', VANTAGE_AI_ENABLED: 'false', VANTAGE_SECRET: 'security-scan-secret-security-scan-secret-12', VANTAGE_PUBLIC_URL: `http://localhost:${port}`,
  VANTAGE_MUTATIONS_PER_15_MINUTES: '100000', VANTAGE_CONSOLE_READS_PER_15_MINUTES: '100000', VANTAGE_REGISTRATIONS_PER_15_MINUTES: '1000',
} as NodeJS.ProcessEnv);
const ctx = createContext(config);
const app = createApp(ctx);
createServer(app).listen(port, '127.0.0.1', () => console.log(`Vantage scan target on http://localhost:${port}`));
