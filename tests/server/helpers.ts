import { createServer, type Server } from 'node:http';
import { loadConfig } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';
import type { AppContext } from '../../server/context.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';

export interface TestApp {
  ctx: AppContext;
  base: string;
  close: () => Promise<void>;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: Buffer }) => Promise<{ status: number; body: any; headers: Headers; text: string }>;
  setupOperator: () => Promise<{ token: string; id: string; unitId: string }>;
  register: (username: string, extra?: Record<string, unknown>) => Promise<{ token: string; id: string }>;
  login: (username: string, password?: string) => Promise<{ status: number; body: any }>;
}

export const PASSWORD = 'cobalt-orbit-velvet-anchor-927';

export async function startApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: ':memory:', VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
    VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_PUBLIC_URL: 'http://localhost:5173', VANTAGE_OPERATOR: '', ...env,
  } as NodeJS.ProcessEnv);
  const ctx = createContext(config);
  const app = createApp(ctx);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetLimiters();

  const call: TestApp['call'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.raw ? {} : { 'content-type': 'application/json' }), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers || {}) };
    const res = await fetch(base + path, { method, headers, body: opts.raw ? new Uint8Array(opts.raw) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, headers: res.headers, text };
  };

  const login = async (username: string, password = PASSWORD) => call('POST', '/api/auth/login', { body: { username, password } });

  const setupOperator = async () => {
    const res = await call('POST', '/api/auth/setup', { body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', mos: '3451', email: 'boletz@example.mil', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' } });
    if (res.status !== 200) throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const me = await call('GET', '/api/me', { token: res.body.token });
    return { token: res.body.token as string, id: me.body.user.id as string, unitId: 'G8' };
  };

  const register = async (username: string, extra: Record<string, unknown> = {}) => {
    const res = await call('POST', '/api/auth/register', { body: { username, password: PASSWORD, first_name: username.charAt(0).toUpperCase() + username.slice(1), last_name: 'Marine', rank_id: 'LCpl', ...extra } });
    if (res.status !== 200) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    const me = await call('GET', '/api/me', { token: res.body.token });
    return { token: res.body.token as string, id: me.body.user.id as string };
  };

  return {
    ctx, base, call, setupOperator, register, login,
    close: async () => { await new Promise<void>((r) => server.close(() => r())); try { ctx.db.close(); } catch {} },
  };
}

/** Enroll an existing user into a unit as a leader with a given template role key. */
export async function enroll(app: TestApp, operatorToken: string, unitId: string, userId: string, roleKey?: string) {
  const res = await app.call('POST', `/api/org/units/${unitId}/members`, { token: operatorToken, body: { user_id: userId, role_id: roleKey ? `${unitId}:${roleKey}` : null } });
  if (res.status !== 201) throw new Error(`enroll failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export function mockGenAi(handler: (body: any) => { status?: number; json: unknown }): Promise<{ url: string; close: () => void; calls: any[] }> {
  const calls: any[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      const out = handler(body);
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close(), calls })));
}
