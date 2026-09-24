import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * How people reach this instance. Separate modes, never a fallback from one to another:
 *
 *   accounts  real, persisted accounts: passwords, passkeys, TOTP, and optionally CAC (CAC_MODE).
 *             The default. This is the evaluation and operational mode.
 *   demo      the click-through synthetic demonstration. No sign-in form: each visitor is given a
 *             disposable workspace of synthetic people and records. Refused in production, refused
 *             on a database that holds real accounts, and never entered because an auth call failed.
 */
export type AccessMode = 'accounts' | 'demo';

export interface DemoConfig {
  /** How long a visitor's workspace lasts before it is removed. */
  ttlHours: number;
  /** How many workspaces may exist at once. The demo says so plainly when it is full. */
  maxWorkspaces: number;
}

export interface AppConfig {
  production: boolean;
  test: boolean;
  accessMode: AccessMode;
  demo: DemoConfig;
  port: number;
  databasePath: string;
  publicUrl: string;
  rpId: string;
  secret: string;
  setupToken: string;
  operatorUsernames: string[];
  timezone: string;
  trustProxy: boolean | number | string;
  sessions: { idleMinutes: number; absoluteHours: number; maxActive: number; sudoMinutes: number };
  limits: { mutationsPer15Minutes: number; registrationsPer15Minutes: number; maxRecordsPerUser: number; maxDatabaseBytes: number };
  attachments: { enabled: boolean; maxBytes: number; maxPerRecord: number; allowedTypes: string[] };
  intake: { enabled: boolean; maxBytes: number; maxBytesPerUser: number; maxRows: number; maxColumns: number; retainDays: number; scannerCommand: string | null };
  ai: {
    enabled: boolean; apiKey: string; baseUrl: string; models: string[]; defaultModel: string; maxOutputTokens: number; timeoutMs: number;
    requestsPerMinute: number; perUserRequestsPerMinute: number; dailyTokenBudget: number; perUserDailyTokens: number;
  };
  email: { provider: 'none' | 'resend' | 'smtp' | 'memory'; from: string; resendApiKey: string; smtpUrl: string };
  maradmins: { enabled: boolean; refreshMinutes: number; source: string };
  /**
   * The Microsoft Entra application mailbox connections sign in through. Empty client id means the
   * feature is not configured, and the product says so rather than offering a button that cannot work.
   */
  m365: { clientId: string; clientSecret: string; tenant: string; redirectUri: string; endpointOverride: string | null };
  selfRegistration: boolean;
  cac: CacConfig;
}

export interface CacConfig {
  /**
   * 'off'    — no certificate sign-in. The default, and what every existing deployment stays on.
   * 'direct' — this process terminates TLS and asks for a client certificate itself.
   * 'proxy'  — something in front terminates TLS and forwards the certificate in a header.
   */
  mode: 'off' | 'direct' | 'proxy';
  /** When true, passwords stop being accepted and a certificate is the only way in. */
  exclusive: boolean;
  /** PEM bundle of the CAs a client certificate must chain to. Required in direct mode. */
  caBundlePath: string;
  /** Header carrying the URL-encoded or base64 PEM (nginx: ssl_client_escaped_cert). */
  certHeader: string;
  /** Header carrying the proxy's own verdict, and the value that means it verified the chain. */
  verifyHeader: string;
  verifySuccessValue: string;
  /**
   * Shared secret the proxy must present. Proxy mode refuses to start without one: any client that
   * can reach this process directly could otherwise set the certificate header and become anybody.
   */
  proxySecretHeader: string;
  proxySecret: string;
  /** Certificate policy OIDs to require, if the deployment wants to insist on hardware-backed certs. */
  requirePolicyOids: string[];
  /** Create an account on first sign-in, but only for an EDIPI the personnel roster already lists. */
  autoProvisionFromRoster: boolean;
}

function readCacConfig(env: NodeJS.ProcessEnv, production: boolean): CacConfig {
  const mode = (env.CAC_MODE || 'off').trim().toLowerCase();
  if (!['off', 'direct', 'proxy'].includes(mode)) throw new Error('CAC_MODE must be off, direct, or proxy.');
  const cfg: CacConfig = {
    mode: mode as CacConfig['mode'],
    exclusive: envBool(env, 'CAC_EXCLUSIVE', false),
    caBundlePath: (env.CAC_CA_BUNDLE || '').trim(),
    certHeader: (env.CAC_CERT_HEADER || 'x-client-cert').trim().toLowerCase(),
    verifyHeader: (env.CAC_VERIFY_HEADER || 'x-client-verify').trim().toLowerCase(),
    verifySuccessValue: (env.CAC_VERIFY_SUCCESS || 'SUCCESS').trim(),
    proxySecretHeader: (env.CAC_PROXY_SECRET_HEADER || 'x-cac-proxy-secret').trim().toLowerCase(),
    proxySecret: env.CAC_PROXY_SECRET || '',
    requirePolicyOids: envList(env, 'CAC_REQUIRE_POLICY_OIDS', []),
    autoProvisionFromRoster: envBool(env, 'CAC_AUTO_PROVISION', false),
  };
  if (cfg.mode === 'proxy') {
    // The whole security of proxy mode rests on this. Without it, a forged header is a sign-in as
    // any EDIPI the attacker names, so the process refuses to start rather than start insecurely.
    if (cfg.proxySecret.length < 32) {
      throw new Error('CAC_MODE=proxy requires CAC_PROXY_SECRET of at least 32 characters. Without it, anyone who can reach this server directly could forge a certificate header.');
    }
  }
  if (cfg.mode === 'direct' && !cfg.caBundlePath) {
    throw new Error('CAC_MODE=direct requires CAC_CA_BUNDLE pointing at the PEM bundle of trusted issuing CAs.');
  }
  if (cfg.exclusive && cfg.mode === 'off') throw new Error('CAC_EXCLUSIVE needs CAC_MODE set to direct or proxy.');
  void production;
  return cfg;
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be numeric.`);
  return n;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`${name} must be true or false.`);
}

function envList(env: NodeJS.ProcessEnv, name: string, fallback: string[]): string[] {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function resolveTrustProxy(raw: string | undefined, production: boolean): boolean | number | string {
  if (raw === undefined || raw === '') return production ? 1 : false;
  const v = raw.trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'none'].includes(v)) return false;
  if (['true', 'yes', 'on'].includes(v)) return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return raw;
}

export function loadConfig(env = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';
  const test = env.VANTAGE_TEST === '1';
  if (production && test) throw new Error('VANTAGE_TEST must never be enabled in production.');

  let secret = String(env.VANTAGE_SECRET || '');
  if (secret.length < 32) {
    if (production) throw new Error('VANTAGE_SECRET must be at least 32 characters in production.');
    secret = env.VANTAGE_SECRET || 'vantage-development-secret-not-for-production-use';
  }
  const setupToken = String(env.VANTAGE_SETUP_TOKEN || '');
  if (production && setupToken.length < 24) throw new Error('VANTAGE_SETUP_TOKEN must be at least 24 characters in production.');

  const publicUrl = String(env.VANTAGE_PUBLIC_URL || (production ? '' : 'http://localhost:5173')).replace(/\/$/, '');
  if (production && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(publicUrl)) {
    throw new Error('VANTAGE_PUBLIC_URL must be the HTTPS origin of the deployment in production.');
  }
  const rpId = env.VANTAGE_RP_ID || new URL(publicUrl || 'http://localhost').hostname;

  const dbPath = env.VANTAGE_DB || (test ? ':memory:' : 'data/vantage.db');
  const emailProvider = (env.VANTAGE_EMAIL_PROVIDER || 'none') as AppConfig['email']['provider'];
  if (!['none', 'resend', 'smtp', 'memory'].includes(emailProvider)) throw new Error('VANTAGE_EMAIL_PROVIDER must be none, resend, or smtp.');
  if (emailProvider === 'memory' && production) throw new Error('The memory email provider is for tests only.');

  const models = envList(env, 'VANTAGE_GENAI_MODELS', ['gemini-2.5-flash']);
  const baseUrl = String(env.VANTAGE_GENAI_BASE_URL || 'https://api.genai.mil/v1').replace(/\/$/, '');
  if (production && !/^https:\/\/([a-z0-9-]+\.)*genai\.mil(\/.*)?$/i.test(baseUrl)) {
    throw new Error('VANTAGE_GENAI_BASE_URL must point at GenAI.mil in production.');
  }

  const accessMode = String(env.VANTAGE_ACCESS_MODE || 'accounts').trim().toLowerCase();
  if (accessMode !== 'accounts' && accessMode !== 'demo') throw new Error('VANTAGE_ACCESS_MODE must be accounts or demo.');
  if (accessMode === 'demo') {
    // The synthetic demo has no sign-in. That is only acceptable where nothing real can be reached,
    // so every combination that could put it near real people, real mail or a real network is refused.
    if (production) throw new Error('VANTAGE_ACCESS_MODE=demo is refused when NODE_ENV=production. The synthetic demo runs as its own non-production instance.');
    if ((env.CAC_MODE || 'off').trim().toLowerCase() !== 'off') throw new Error('The synthetic demo cannot run with CAC sign-in enabled.');
    if (!['', 'none', 'memory'].includes(String(env.VANTAGE_EMAIL_PROVIDER || '').trim().toLowerCase())) throw new Error('The synthetic demo sends no email. Set VANTAGE_EMAIL_PROVIDER=none.');
    if (envBool(env, 'VANTAGE_AI_ENABLED', false)) throw new Error('The synthetic demo runs without AI. Set VANTAGE_AI_ENABLED=false.');
    if (envBool(env, 'VANTAGE_MARADMIN_ENABLED', false)) throw new Error('The synthetic demo makes no outbound requests. Set VANTAGE_MARADMIN_ENABLED=false.');
    if (env.VANTAGE_M365_CLIENT_ID) throw new Error('The synthetic demo reads no mailboxes. Unset VANTAGE_M365_CLIENT_ID.');
  }

  return {
    production,
    test,
    accessMode: accessMode as AccessMode,
    demo: {
      ttlHours: Math.min(Math.max(envNumber(env, 'VANTAGE_DEMO_TTL_HOURS', 24), 1), 168),
      maxWorkspaces: Math.min(Math.max(envNumber(env, 'VANTAGE_DEMO_MAX_WORKSPACES', 200), 1), 5000),
    },
    port: envNumber(env, 'PORT', 8787),
    databasePath: dbPath === ':memory:' || isAbsolute(dbPath) ? dbPath : resolve(ROOT, dbPath),
    publicUrl,
    rpId,
    secret,
    setupToken,
    operatorUsernames: envList(env, 'VANTAGE_OPERATOR', []).map((s) => s.toLowerCase()),
    timezone: env.VANTAGE_TIMEZONE || 'America/New_York',
    trustProxy: resolveTrustProxy(env.TRUST_PROXY, production),
    sessions: {
      idleMinutes: envNumber(env, 'VANTAGE_IDLE_MINUTES', 60),
      absoluteHours: envNumber(env, 'VANTAGE_SESSION_HOURS', 12),
      maxActive: envNumber(env, 'VANTAGE_MAX_SESSIONS', 8),
      sudoMinutes: envNumber(env, 'VANTAGE_SUDO_MINUTES', 10),
    },
    limits: {
      mutationsPer15Minutes: envNumber(env, 'VANTAGE_MUTATIONS_PER_15_MINUTES', 300),
      registrationsPer15Minutes: envNumber(env, 'VANTAGE_REGISTRATIONS_PER_15_MINUTES', 20),
      maxRecordsPerUser: envNumber(env, 'VANTAGE_MAX_RECORDS_PER_USER', 20000),
      maxDatabaseBytes: envNumber(env, 'VANTAGE_MAX_DB_BYTES', 800 * 1024 * 1024),
    },
    attachments: {
      enabled: envBool(env, 'VANTAGE_ATTACHMENTS_ENABLED', true),
      maxBytes: envNumber(env, 'VANTAGE_ATTACHMENT_MAX_BYTES', 10 * 1024 * 1024),
      maxPerRecord: envNumber(env, 'VANTAGE_ATTACHMENTS_PER_RECORD', 10),
      allowedTypes: ['application/pdf', 'image/jpeg', 'image/png', 'text/plain', 'text/csv'],
    },
    intake: {
      enabled: envBool(env, 'VANTAGE_INTAKE_ENABLED', true),
      maxBytes: envNumber(env, 'VANTAGE_INTAKE_MAX_BYTES', 25 * 1024 * 1024),
      maxRows: envNumber(env, 'VANTAGE_INTAKE_MAX_ROWS', 20000),
      maxColumns: envNumber(env, 'VANTAGE_INTAKE_MAX_COLUMNS', 128),
      maxBytesPerUser: envNumber(env, 'VANTAGE_INTAKE_MAX_BYTES_PER_USER', 250 * 1024 * 1024),
      retainDays: envNumber(env, 'VANTAGE_INTAKE_RETAIN_DAYS', 400),
      // A local scanner only. Vantage never uploads a file elsewhere to have it scanned.
      scannerCommand: env.VANTAGE_SCANNER_COMMAND ? String(env.VANTAGE_SCANNER_COMMAND) : null,
    },
    ai: {
      enabled: envBool(env, 'VANTAGE_AI_ENABLED', false),
      apiKey: String(env.VANTAGE_GENAI_API_KEY || ''),
      baseUrl,
      models,
      defaultModel: env.VANTAGE_GENAI_DEFAULT_MODEL || models[0],
      maxOutputTokens: envNumber(env, 'VANTAGE_GENAI_MAX_OUTPUT_TOKENS', 2000),
      timeoutMs: envNumber(env, 'VANTAGE_GENAI_TIMEOUT_MS', 45000),
      requestsPerMinute: envNumber(env, 'VANTAGE_GENAI_REQUESTS_PER_MINUTE', 100),
      perUserRequestsPerMinute: envNumber(env, 'VANTAGE_GENAI_PER_USER_REQUESTS_PER_MINUTE', 12),
      dailyTokenBudget: envNumber(env, 'VANTAGE_GENAI_DAILY_TOKEN_BUDGET', 45_000_000),
      perUserDailyTokens: envNumber(env, 'VANTAGE_GENAI_PER_USER_DAILY_TOKENS', 250_000),
    },
    email: {
      provider: emailProvider,
      from: env.VANTAGE_EMAIL_FROM || 'Vantage <no-reply@localhost>',
      resendApiKey: env.RESEND_API_KEY || '',
      smtpUrl: env.SMTP_URL || '',
    },
    maradmins: {
      // Off unless an operator turns it on: it is the one feature that reaches a public host
      // (marines.mil), and a restricted network must be able to run Vantage with that egress blocked.
      enabled: envBool(env, 'VANTAGE_MARADMIN_ENABLED', false),
      refreshMinutes: envNumber(env, 'VANTAGE_MARADMIN_REFRESH_MINUTES', 30),
      source: env.VANTAGE_MARADMIN_SOURCE || 'https://www.marines.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=6&Site=481&category=14336&max=50',
    },
    m365: readM365Config(env, production, test, publicUrl),
    // A demo visitor is handed a synthetic person; nobody registers.
    selfRegistration: accessMode === 'demo' ? false : envBool(env, 'VANTAGE_SELF_REGISTRATION', true),
    cac: readCacConfig(env, production),
  };
}

export const generatedSecret = () => randomBytes(32).toString('base64url');
export const PROJECT_ROOT = ROOT;

function readM365Config(env: NodeJS.ProcessEnv, production: boolean, test: boolean, publicUrl: string): AppConfig['m365'] {
  const clientId = String(env.VANTAGE_M365_CLIENT_ID || '').trim();
  const clientSecret = String(env.VANTAGE_M365_CLIENT_SECRET || '');
  // 'organizations' accepts any work account; a tenant id pins sign-in to one directory.
  const tenant = String(env.VANTAGE_M365_TENANT || 'organizations').trim();
  if (clientId && !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error('VANTAGE_M365_CLIENT_ID must be the application (client) id, a GUID.');
  if (clientId && !clientSecret) throw new Error('VANTAGE_M365_CLIENT_SECRET is required when VANTAGE_M365_CLIENT_ID is set.');
  if (!/^(organizations|[0-9a-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(tenant)) throw new Error('VANTAGE_M365_TENANT must be organizations, a tenant id, or a verified domain.');
  // Tests point the flow at a local stand-in for Microsoft. Nothing else may: a real deployment only
  // ever talks to the national cloud's own hosts.
  const override = env.VANTAGE_M365_TEST_ENDPOINT ? String(env.VANTAGE_M365_TEST_ENDPOINT).replace(/\/$/, '') : null;
  if (override && (production || !test)) throw new Error('VANTAGE_M365_TEST_ENDPOINT is for the test suite only.');
  return { clientId, clientSecret, tenant, redirectUri: `${publicUrl}/api/correspondence/connectors/callback`, endpointOverride: override };
}
