import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { loadConfig } from '../../server/config.ts';
import { createApp, createContext } from '../../server/app.ts';
import type { AppContext } from '../../server/context.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';
import { addMember } from '../../server/services/org.ts';
import { zonedDay } from '../../server/lib/clock.ts';

export interface TestApp {
  ctx: AppContext;
  base: string;
  close: () => Promise<void>;
  call: (method: string, path: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: Buffer; binary?: boolean }) => Promise<{ status: number; body: any; headers: Headers; text: string; buffer?: Buffer }>;
  setupOperator: () => Promise<{ token: string; id: string; unitId: string }>;
  register: (username: string, extra?: Record<string, unknown>) => Promise<{ token: string; id: string }>;
  login: (username: string, password?: string) => Promise<{ status: number; body: any }>;
}

export const PASSWORD = 'cobalt-orbit-velvet-anchor-927';

/** Today in the test instance's timezone, as a Marine there would date an entry. The UTC date is tomorrow every evening. */
export const today = () => zonedDay(process.env.VANTAGE_TIMEZONE || 'America/New_York');

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
    if (opts.binary) { const buffer = Buffer.from(await res.arrayBuffer()); return { status: res.status, body: null, headers: res.headers, text: '', buffer }; }
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

/**
 * Seat someone in a unit. Through the API when the enroller may enroll them directly (they already lead them); a
 * freshly registered account accepts a join code or invitation itself in the product, so tests seat it in the service.
 */
export async function enroll(app: TestApp, operatorToken: string, unitId: string, userId: string, roleKey?: string) {
  const res = await app.call('POST', `/api/org/units/${unitId}/members`, { token: operatorToken, body: { user_id: userId, role_id: roleKey ? `${unitId}:${roleKey}` : null } });
  if (res.status === 201) return;
  if (res.body?.code !== 'invite_required') throw new Error(`enroll failed: ${res.status} ${JSON.stringify(res.body)}`);
  addMember(app.ctx, userId, unitId, { invitedBy: null });
  if (roleKey) app.ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, NULL, ?)').run(userId, `${unitId}:${roleKey}`, unitId, new Date().toISOString());
}

type GenAiAnswer = { status?: number; json?: unknown; html?: string };
/** A stand-in for the GenAI provider. A handler may answer later (a Promise), as a slow provider would. */
export function mockGenAi(handler: (body: any, url: string) => GenAiAnswer | Promise<GenAiAnswer>): Promise<{ url: string; close: () => void; calls: any[] }> {
  const calls: any[] = [];
  const server: Server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      void Promise.resolve(handler(body, req.url || '')).then((out) => {
        if (out.html != null) { res.writeHead(out.status || 200, { 'content-type': 'text/html; charset=UTF-8' }); res.end(out.html); return; }
        res.writeHead(out.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close(), calls })));
}

/**
 * A stand-in for clamd (INSTREAM): finds a file that begins with the EICAR test string, and holds its answer while a
 * gate is shut. It does not look inside archives, which is why an import scans each file a ZIP carries on its own.
 *
 * It keeps its side of the connection open after the scanner client has ended its own (allowHalfOpen), as clamd does:
 * otherwise the connection would close the moment the file had been sent, the client would read that as no verdict,
 * and nothing would be held at all.
 */
export async function fakeClamd() {
  let hold: Promise<void> = Promise.resolve();
  let letGo = () => {};
  let arrived = () => {};
  const server = createNetServer({ allowHalfOpen: true }, (socket) => {
    let data = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.on('data', (c) => {
      data = Buffer.concat([data, c]);
      if (data.length >= 4 && data.subarray(-4).equals(Buffer.alloc(4))) {
        // zINSTREAM, a null, the first chunk's four-byte length, then the file.
        const answer = data.subarray(14).toString('latin1').startsWith(EICAR.toString('latin1')) ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0';
        arrived();
        void hold.then(() => socket.end(answer));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    address: `tcp://127.0.0.1:${(server.address() as { port: number }).port}`,
    /** Opens a gate still shut, so a test that fails while a file is held does not wait out the scanner client's timeout. */
    close: () => { letGo(); server.close(); },
    /** Shuts the gate: no answer leaves until `release`. `seen` resolves once a file has reached the scanner. */
    gate() {
      let release!: () => void;
      hold = new Promise<void>((r) => { release = r; });
      letGo = release;
      const seen = new Promise<void>((r) => { arrived = r; });
      return { seen, release: () => { hold = Promise.resolve(); release(); } };
    },
  };
}
export const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

/**
 * Whether a request is still unanswered after a pause many times longer than a scan nobody held would take. A test that
 * changes something "while the scanner has the file" proves with this that the scanner does have it.
 */
export async function unanswered(request: Promise<unknown>) {
  let answered = false;
  void request.then(() => { answered = true; }, () => { answered = true; });
  await new Promise((r) => setTimeout(r, 150));
  return !answered;
}
