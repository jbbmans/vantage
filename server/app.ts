import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.ts';
import { PROJECT_ROOT } from './config.ts';
import { openDatabase, metaSet } from './db/index.ts';
import type { AppContext } from './context.ts';
import { createMailer } from './services/email.ts';
import { attachContext } from './auth/middleware.ts';
import { SESSION_COOKIE, SIGNED_IN_COOKIE } from './auth/sessions.ts';
import { HttpError } from './lib/errors.ts';
import { sendError } from './lib/http.ts';
import { VERSION } from './version.ts';
import { authRouter } from './routes/auth.ts';
import { meRouter } from './routes/me.ts';
import { recordsRouter } from './routes/records.ts';
import { workRouter } from './routes/work.ts';
import { correspondenceRouter } from './routes/correspondence.ts';
import { recordRouter } from './routes/record.ts';
import { demoRouter, demoGuard } from './routes/demo.ts';
import { assertDatabaseMatchesMode, purgeExpired } from './services/demo.ts';
import { startPostHogForwarding } from './services/posthog.ts';
import { record } from './services/telemetry.ts';
import { pruneEvents } from './services/usage.ts';
import { pruneSources, reconcileInterruptedJobs } from './services/intake.ts';
import { orgRouter } from './routes/org.ts';
import { miscRouter } from './routes/misc.ts';
import { adminRouter } from './routes/admin.ts';
import { supportRouter, publicSupportRouter } from './routes/support.ts';
import { pruneSessions } from './auth/sessions.ts';
import { configureLimits, configureAiLimits, pruneLimiters } from './auth/limiter.ts';
import { syncMaradmins } from './services/maradmins.ts';
import { runDigestTick } from './services/digest.ts';
import { now } from './lib/ids.ts';
import { purgeDeleted } from './services/records.ts';
import { releaseStaleClaims } from './services/work.ts';
import { loadRuntime } from './runtime.ts';
export { loadRuntime };

export function createContext(config: AppConfig): AppContext {
  const db = openDatabase(config.databasePath);
  const runtime = loadRuntime(db, config);
  const ctx: AppContext = { db, config, mailer: createMailer(config, db), runtime, saveRuntime: () => metaSet(db, 'runtime', JSON.stringify(runtime)) };
  // Refuses a demo database in accounts mode and a real database in demo mode, before anything else runs.
  assertDatabaseMatchesMode(ctx);
  if (config.accessMode === 'demo') {
    // A visitor may not stand up units outside their own workspace, or register anybody.
    runtime.selfServiceUnits = false;
    runtime.selfRegistration = false;
    runtime.aiEnabled = false;
    runtime.maradminsEnabled = false;
  }
  configureLimits({ mutations: config.limits.mutationsPer15Minutes, registrations: config.limits.registrationsPer15Minutes });
  configureAiLimits({ global: config.ai.requestsPerMinute, perUser: config.ai.perUserRequestsPerMinute });
  // Usernames named in VANTAGE_OPERATOR always hold operator authority.
  if (config.operatorUsernames.length) {
    db.prepare(`UPDATE users SET is_operator = 1 WHERE lower(username) IN (${config.operatorUsernames.map(() => '?').join(',')})`).run(...config.operatorUsernames);
  }
  pruneSessions(ctx);
  // An import that was mid-flight when the process stopped is closed out honestly rather than
  // left pending forever. Its apply ran in one transaction, so nothing is half-written.
  const interrupted = reconcileInterruptedJobs(ctx);
  if (interrupted) console.warn(`Marked ${interrupted} interrupted import job(s) as failed.`);
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
  // Every script, style, font and image is served from this origin. Nothing in the page reaches a
  // third party: no tag manager, no analytics, no CDN. A restricted network that blocks public egress
  // loses nothing it needs.
  const scriptSrc = ["'self'", ...inlineScriptHashes(distDir)].join(' ');
  const build = String(process.env.RENDER_GIT_COMMIT || process.env.VANTAGE_BUILD_ID || VERSION).slice(0, 64);

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('etag', false);
  app.use(attachContext(ctx));

  let aiOrigin = '';
  try { aiOrigin = new URL(config.ai.baseUrl).origin; } catch {}
  app.use((req, res, next) => {
    res.setHeader('X-Vantage-Build', build);
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${aiOrigin}; frame-src 'none'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`);
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
      res.json({ ok: true, version: VERSION, build, uptime: Math.round(process.uptime()), maintenance: ctx.runtime.maintenance, mode: ctx.config.accessMode });
    } catch (error) {
      console.error('Health check failed:', error);
      res.status(503).json({ ok: false, error: 'Database health check failed.' });
    }
  });

  // In maintenance, sign-in stays open so owners can work, but nothing else under /auth may write (registration, resets, invitations, setup).
  // Signed-in non-owners are turned away in requireAuth.
  const MAINTENANCE_OPEN = new Set(['/auth/login', '/auth/login/mfa', '/auth/passkey/options', '/auth/passkey/verify', '/auth/logout', '/auth/sudo']);
  app.use('/api', (req, res, next) => {
    if (ctx.runtime.maintenance && req.path.startsWith('/auth') && !MAINTENANCE_OPEN.has(req.path) && req.method !== 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({ error: 'Vantage is in scheduled maintenance. Try again shortly.', code: 'maintenance' });
    }
    next();
  });

  const json = express.json({ limit: '4mb' });
  const RAW_BODY_PATHS = /^\/api\/(admin\/import|work\/sources$|correspondence\/messages\/import$)/;
  app.use((req, res, next) => (RAW_BODY_PATHS.test(req.path) ? next() : json(req, res, next)));
  app.use(cookieParser());

  // In demo mode, anything that reaches past a visitor's own synthetic workspace is closed.
  app.use(demoGuard);
  app.use('/api/demo', demoRouter);

  app.get('/api/ranks', (_req, res) => res.json(ctx.db.prepare('SELECT id, grade, abbr, name, tier FROM ranks ORDER BY sort').all()));
  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/records', recordsRouter);
  app.use('/api/work', workRouter);
  app.use('/api/record', recordRouter);
  app.use('/api/correspondence', correspondenceRouter);
  app.use('/api/org', orgRouter);
  app.use('/api/support', supportRouter);
  // Raising a ticket without signing in: the commonest reason to need help is that you cannot sign
  // in, and a queue you must sign in to reach is no use to that person. This has to mount ahead of
  // miscRouter, which is mounted at bare '/api' and applies requireAuth to everything after it.
  app.use('/api/public-support', publicSupportRouter);
  app.use('/api', miscRouter);
  app.use('/api/admin', adminRouter);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'No such API route.', code: 'not_found' }));

  /**
   * Which part of the API a path belongs to, for reliability reporting. A fixed set of words rather
   * than the path itself: a path can carry an id, and an id is not something analytics may hold.
   */
  const routeFamily = (path: string): string => {
    const segment = path.replace(/^\/api\//, '').split('/')[0] || 'other';
    const known = ['records', 'record', 'work', 'correspondence', 'studio', 'metrics', 'reports', 'org', 'auth', 'admin', 'ai'];
    if (segment === 'imports') return 'imports';
    return known.includes(segment) ? segment : 'other';
  };

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      // A refusal is a security fact worth counting: which surface, never who or what they asked for.
      if (err.status === 403) record(ctx, 'security.authorization_denied', { route: routeFamily(req.path) });
      if (err.status >= 500) record(ctx, 'reliability.request_failed', { status: err.status, route: routeFamily(req.path) });
      return sendError(res, err);
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.', code: 'too_large' });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.', code: 'bad_json' });
    console.error('Unhandled request error:', err);
    record(ctx, 'reliability.request_failed', { status: 500, route: routeFamily(req.path) });
    return res.status(500).json({ error: 'The server could not complete that request.', code: 'server_error' });
  });

  if (existsSync(distDir)) {
    // Only public marketing routes are indexable, before any JavaScript runs.
    const publicRoutes = new Set(['/', '/display', '/about']);
    const appRoute = /^\/(?:login|register|reset|invite|setup|work|record|goals|career|maradmins|readiness|reports|settings|operator|help|queue|correspondence|studio|assist)\/?$/;
    // Two segments, not one: a record detail is /records/:id for an activity and
    // /records/:table/:id for a task, project or goal, which is the link shape a mention
    // notification points at. One segment 404s the second form.
    const recordRoute = /^\/(?:records|activities|team)(?:\/[^/]+){0,2}\/?$|^\/work\/items\/[^/]+\/?$/;
    const indexHtml = readFileSync(join(distDir, 'index.html'), 'utf8');
    const shell = indexHtml
      .replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex, nofollow" />')
      .replace(/<link rel="canonical"[^>]*>/, '')
      .replace(/<script[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, '');
    app.use((req, res, next) => {
      if (req.path === '/index.html' || req.path === '/public.html') {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }
      next();
    });
    app.use('/assets', express.static(join(distDir, 'assets'), { immutable: true, maxAge: '1y', index: false }));
    app.use(express.static(distDir, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));

    /*
     * The public page is served with its markup already in it, to requests that are not signed in.
     *
     * Vantage is client-rendered, so the plain shell hands a crawler an empty <div id="root"> and
     * asks it to run JavaScript to find out what this site is. Google usually will. The engines
     * behind the other half of the traffic — Bing, and the crawlers feeding AI answers — largely
     * will not, and "usually" is a poor foundation for the one page that has to rank.
     *
     * Only requests with no session cookie get it, which covers every crawler and every first-time
     * visitor while making sure somebody who is signed in never sees a flash of the marketing page
     * on their way to the dashboard. And only for the three routes that actually render it: a
     * prerendered public page served at /records would be worse than nothing.
     *
     * Falls back to the shell whenever dist/public.html is absent, so a build that skipped the
     * prerender step degrades to the previous behaviour instead of failing.
     */
    const prerendered = join(distDir, 'public.html');
    app.get(/^(?!\/api\/).*/, (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.vary('Cookie');
      const signedIn = Boolean(req.cookies?.[SESSION_COOKIE] || req.cookies?.[SIGNED_IN_COOKIE]);
      if ((!signedIn || req.path !== '/') && publicRoutes.has(req.path) && existsSync(prerendered)) {
        // Crawlers and shared caches must not be handed one visitor's variant of this URL.
        return res.sendFile(prerendered);
      }
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (!publicRoutes.has(req.path) && !appRoute.test(req.path) && !recordRoute.test(req.path)) {
        return res.status(404).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Page not found | VANTAGE</title></head><body><main><h1>Page not found</h1><p>This address does not exist.</p><a href="/">Return to VANTAGE</a></main></body></html>`);
      }
      return res.type('html').send(shell);
    });
  }
  return app;
}

export function startSchedulers(ctx: AppContext) {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => void) => { const t = setInterval(fn, ms); t.unref?.(); timers.push(t); };
  every(15 * 60_000, () => { pruneLimiters(); try { pruneSessions(ctx); } catch {} });
  every(6 * 60 * 60_000, () => { try { const r = purgeDeleted(ctx); if (r.records) console.log(`${now()} purged ${r.records} records from the recycle bin`); } catch (e) { console.warn(`Purge failed: ${(e as Error).message}`); } });
  // A claim nobody has touched in three days goes back on the queue. Somebody claims a dozen rows
  // on a Friday and goes on leave; without this the work waits for a leader to notice.
  every(60 * 60_000, () => { try { const n = releaseStaleClaims(ctx); if (n) console.log(`${now()} released ${n} stale work claims`); } catch (e) { console.warn(`Stale claim sweep failed: ${(e as Error).message}`); } });
  // Analytics steer a product; they are not a memory. Anything past the window goes on its own.
  every(24 * 60 * 60_000, () => { try { const removed = pruneEvents(ctx); if (removed) console.log(`${now()} pruned ${removed} product events past the retention window`); } catch (e) { console.warn(`Event prune failed: ${(e as Error).message}`); } });
  // Uploaded workbooks are evidence for as long as the retention policy says, and no longer.
  every(24 * 60 * 60_000, () => { try { const released = pruneSources(ctx); if (released) console.log(`${now()} released the bytes of ${released} source files past the retention window`); } catch (e) { console.warn(`Source prune failed: ${(e as Error).message}`); } });
  // Expired demo workspaces are removed whole. A no-op on any instance not in demo mode.
  if (ctx.config.accessMode === 'demo') every(10 * 60_000, () => { try { const n = purgeExpired(ctx); if (n) console.log(`${now()} removed ${n} expired demo workspaces`); } catch (e) { console.warn(`Demo purge failed: ${(e as Error).message}`); } });
  // Catalogued demo events to PostHog, when VANTAGE_POSTHOG_KEY is set. Off otherwise.
  const stopPostHog = startPostHogForwarding(ctx);
  if (!ctx.config.test) {
    // Registered whether or not the feed is on: syncMaradmins is a no-op while the runtime switch is off, so enabling it later starts refreshes without a restart.
    const run = () => syncMaradmins(ctx).catch((e: Error) => console.warn(`MARADMIN refresh skipped: ${e.message}`));
    const first = setTimeout(run, 3_000); first.unref?.(); timers.push(first);
    every(5 * 60_000, run);
  }
  if (!ctx.config.test) {
    every(60 * 60_000, () => { runDigestTick(ctx).then((r) => { if (r.sent) console.log(`${now()} digest: sent ${r.sent}`); }).catch((e: Error) => console.warn(`Digest tick failed: ${e.message}`)); });
  }
  return () => { timers.forEach((t) => clearInterval(t)); stopPostHog?.(); };
}
