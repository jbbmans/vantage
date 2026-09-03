import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { PROJECT_ROOT } from './config.ts';
import { openDatabase, metaGet, metaSet, type Db } from './db/index.ts';
import type { AppContext, RuntimeSettings } from './context.ts';
import { createMailer } from './services/email.ts';
import { attachContext } from './auth/middleware.ts';
import { HttpError } from './lib/errors.ts';
import { sendError } from './lib/http.ts';
import { VERSION } from './version.ts';
import { authRouter } from './routes/auth.ts';
import { meRouter } from './routes/me.ts';
import { recordsRouter } from './routes/records.ts';
import { orgRouter } from './routes/org.ts';
import { miscRouter } from './routes/misc.ts';
import { adminRouter } from './routes/admin.ts';
import { pruneSessions } from './auth/sessions.ts';
import { configureLimits, configureAiLimits, pruneLimiters } from './auth/limiter.ts';
import { syncMaradmins } from './services/maradmins.ts';
import { runDigestTick } from './services/digest.ts';
import { now } from './lib/ids.ts';
import { purgeDeleted } from './services/records.ts';

export function loadRuntime(db: Db, config: AppConfig): RuntimeSettings {
  const defaults: RuntimeSettings = {
    displayName: 'Vantage', organizationName: 'Marine Corps', announcement: '', selfRegistration: config.selfRegistration,
    aiEnabled: config.ai.enabled, aiModels: [...config.ai.models], aiDefaultModel: config.ai.defaultModel,
    attachmentsEnabled: config.attachments.enabled, maradminsEnabled: config.maradmins.enabled, maintenance: false,
  };
  try {
    const saved = JSON.parse(metaGet(db, 'runtime') || '{}') as Partial<RuntimeSettings>;
    return { ...defaults, ...saved };
  } catch { return defaults; }
}

export function createContext(config: AppConfig): AppContext {
  const db = openDatabase(config.databasePath);
  const runtime = loadRuntime(db, config);
  const ctx: AppContext = { db, config, mailer: createMailer(config, db), runtime, saveRuntime: () => metaSet(db, 'runtime', JSON.stringify(runtime)) };
  configureLimits({ mutations: config.limits.mutationsPer15Minutes, registrations: config.limits.registrationsPer15Minutes });
  configureAiLimits({ global: config.ai.requestsPerMinute, perUser: config.ai.perUserRequestsPerMinute });
  // Usernames named in VANTAGE_OPERATOR always hold operator authority.
  if (config.operatorUsernames.length) {
    db.prepare(`UPDATE users SET is_operator = 1 WHERE lower(username) IN (${config.operatorUsernames.map(() => '?').join(',')})`).run(...config.operatorUsernames);
  }
  pruneSessions(ctx);
  return ctx;
}

function inlineScriptHashes(distDir: string): string[] {
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) return [];
  const html = readFileSync(indexPath, 'utf8');
  const hashes: string[] = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) hashes.push(`'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`);
  return hashes;
}

export function createApp(ctx: AppContext) {
  const { config } = ctx;
  const app = express();
  const distDir = join(PROJECT_ROOT, 'dist');
  const scriptSrc = ["'self'", ...inlineScriptHashes(distDir)].join(' ');
  const build = String(process.env.RENDER_GIT_COMMIT || process.env.VANTAGE_BUILD_ID || VERSION).slice(0, 64);

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);
  app.use(attachContext(ctx));

  app.use((req, res, next) => {
    res.setHeader('X-Vantage-Build', build);
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=(), publickey-credentials-get=(self), publickey-credentials-create=(self)');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.setHeader('Pragma', 'no-cache'); }
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  app.get('/api/health', (req, res) => {
    try {
      ctx.db.prepare('SELECT 1').get();
      res.json({ ok: true, version: VERSION, build, uptime: Math.round(process.uptime()), maintenance: ctx.runtime.maintenance });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({ ok: false, error: 'Database health check failed.' });
    }
  });

  app.use('/api', (req, res, next) => {
    if (ctx.runtime.maintenance && !req.path.startsWith('/auth') && !req.path.startsWith('/admin') && req.path !== '/me') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'Vantage is in scheduled maintenance. Try again shortly.', code: 'maintenance' });
    }
    next();
  });

  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());

  app.get('/api/ranks', (_req, res) => res.json(ctx.db.prepare('SELECT id, grade, abbr, name, tier FROM ranks ORDER BY sort').all()));
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/records', recordsRouter);
  app.use('/api/org', orgRouter);
  app.use('/api', miscRouter);
  app.use('/api/admin', adminRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No such API route.', code: 'not_found' }));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return sendError(res, err);
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.', code: 'too_large' });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'bad_json' });
    console.error('Unhandled request error:', err);
    return res.status(500).json({ error: 'The server could not complete that request.', code: 'server_error' });
  });

  if (existsSync(distDir)) {
    app.use('/assets', express.static(join(distDir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    app.use(express.static(distDir, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get(/^(?!\/api\/).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(join(distDir, 'index.html')); });
  }
  return app;
}

export function startSchedulers(ctx: AppContext) {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); };
  every(15 * 60_000, () => { pruneLimiters(); try { pruneSessions(ctx); } catch {} });
  every(6 * 60 * 60_000, () => { try { const r = purgeDeleted(ctx); if (r.records) console.log(`${now()} purged ${r.records} records from the recycle bin`); } catch (e) { console.warn(`Purge failed: ${(e as Error).message}`); } });
  if (ctx.runtime.maradminsEnabled && !ctx.config.test) {
    const run = () => syncMaradmins(ctx).catch((e: Error) => console.warn(`MARADMIN refresh skipped: ${e.message}`));
    const first = setTimeout(run, 3_000); first.unref?.(); timers.push(first);
    every(5 * 60_000, run);
  }
  if (!ctx.config.test) {
    every(60 * 60_000, () => { runDigestTick(ctx).then((r) => { if (r.sent) console.log(`${now()} digest: sent ${r.sent}`); }).catch((e: Error) => console.warn(`Digest tick failed: ${e.message}`)); });
  }
  return () => timers.forEach((t) => clearInterval(t));
}
