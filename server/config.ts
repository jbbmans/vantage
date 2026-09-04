import { isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface AppConfig {
  production: boolean;
  test: boolean;
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
  ai: {
    enabled: boolean; apiKey: string; baseUrl: string; models: string[]; defaultModel: string; maxOutputTokens: number; timeoutMs: number;
    requestsPerMinute: number; perUserRequestsPerMinute: number; dailyTokenBudget: number; perUserDailyTokens: number;
  };
  email: { provider: 'none' | 'resend' | 'smtp' | 'memory'; from: string; resendApiKey: string; smtpUrl: string };
  maradmins: { enabled: boolean; refreshMinutes: number; source: string };
  selfRegistration: boolean;
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

  return {
    production,
    test,
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
      enabled: envBool(env, 'VANTAGE_MARADMIN_ENABLED', !test),
      refreshMinutes: envNumber(env, 'VANTAGE_MARADMIN_REFRESH_MINUTES', 30),
      source: env.VANTAGE_MARADMIN_SOURCE || 'https://www.marines.mil/DesktopModules/ArticleCS/RSS.ashx?ContentType=6&Site=481&category=14336&max=50',
    },
    selfRegistration: envBool(env, 'VANTAGE_SELF_REGISTRATION', true),
  };
}

export const generatedSecret = () => randomBytes(32).toString('base64url');
export const PROJECT_ROOT = ROOT;
