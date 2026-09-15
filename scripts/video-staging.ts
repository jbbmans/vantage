import express from 'express';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../server/config.ts';
import { createApp } from '../server/app.ts';
import type { AppContext } from '../server/context.ts';
import { hashPassword } from '../server/lib/crypto.ts';
import { addMember, claimUnit } from '../server/services/org.ts';
import { passwordProblem } from '../shared/password.ts';

export const ACCOUNTS = [
  { key: 'MEMBER', id: 'synthetic-member', username: 'demo.member', first: 'Alex', last: 'Example', rank: 'Cpl' },
  { key: 'LEADER', id: 'synthetic-leader', username: 'demo.leader', first: 'Jordan', last: 'Sample', rank: 'SSgt' },
  { key: 'OWNER', id: 'synthetic-owner', username: 'demo.owner', first: 'Casey', last: 'Fiction', rank: 'Capt' },
] as const;

export function stagingOrigin(env: NodeJS.ProcessEnv): string {
  if (env.VANTAGE_STAGE_MODE !== 'synthetic-only' || env.RENDER_SERVICE_NAME !== 'vantage-video-staging') {
    throw new Error('Staging requires its dedicated service and synthetic-only mode.');
  }
  const url = new URL(env.RENDER_EXTERNAL_URL || '');
  if (url.protocol !== 'https:' || !/^vantage-video-staging(?:-[a-z0-9]+)?\.onrender\.com$/.test(url.hostname)
      || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Staging requires its own HTTPS onrender.com origin.');
  }
  if (env.VANTAGE_TEST === '1') throw new Error('Test mode is forbidden on staging.');
  return url.origin;
}

export function stagingConfig(env: NodeJS.ProcessEnv, databasePath: string) {
  // Never inherit production paths, secrets, operators or integration credentials.
  return loadConfig({
    NODE_ENV: 'production', PORT: env.PORT || '10000', TRUST_PROXY: '1',
    VANTAGE_PUBLIC_URL: stagingOrigin(env), VANTAGE_DB: databasePath,
    VANTAGE_SECRET: randomBytes(32).toString('base64url'),
    VANTAGE_SETUP_TOKEN: randomBytes(32).toString('base64url'),
    VANTAGE_SELF_REGISTRATION: 'false', VANTAGE_EMAIL_PROVIDER: 'none',
    VANTAGE_AI_ENABLED: 'false', VANTAGE_MARADMIN_ENABLED: 'false', CAC_MODE: 'off',
  });
}

export function seedVideoStaging(ctx: AppContext, env: NodeJS.ProcessEnv) {
  if (ctx.db.prepare('SELECT 1 FROM users LIMIT 1').get() || ctx.db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
    throw new Error('Staging only seeds a new, empty database.');
  }
  const passwords = ACCOUNTS.map(a => env['VANTAGE_STAGE_' + a.key + '_PASSWORD'] || '');
  passwords.forEach((p, i) => {
    if (p && passwordProblem(p)) throw new Error('Invalid staging credential for ' + ACCOUNTS[i].key);
  });
  const supplied = passwords.filter(Boolean);
  if (new Set(supplied).size !== supplied.length) throw new Error('Staging passwords must be distinct.');
  const timestamp = new Date().toISOString();
  const date = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  ctx.db.transaction(() => {
    const insert = ctx.db.prepare('INSERT INTO users (id, username, email, password_hash, first_name, last_name, rank_id, active, is_operator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ACCOUNTS.forEach((a, i) => insert.run(a.id, a.username, a.username + '@example.invalid',
      hashPassword(passwords[i] || randomBytes(32).toString('base64url')), a.first, a.last, a.rank,
      passwords[i] ? 1 : 0, a.key === 'OWNER' ? 1 : 0, timestamp, timestamp));
    ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-section', 'synthetic-section', 'Example Support Section — Fictional', 'EXAMPLE', 'section', 'Synthetic training location', timestamp);
    claimUnit(ctx, 'synthetic-section', 'synthetic-owner');
    addMember(ctx, 'synthetic-member', 'synthetic-section');
    addMember(ctx, 'synthetic-leader', 'synthetic-section');
    ctx.db.prepare('INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('synthetic-leader', 'synthetic-section:sncoic', 'synthetic-section', 'synthetic-owner', timestamp);
    const activity = ctx.db.prepare('INSERT INTO activities (id, user_id, unit_id, visibility, date, title, category, quantity, unit_label, result, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 8; i++) activity.run('synthetic-activity-' + i, 'synthetic-member', 'synthetic-section', i === 7 ? 'private' : 'unit', date(i + 1),
      i === 7 ? 'Private reflection — synthetic' : 'Practice inventory review ' + (i + 1) + ' — synthetic',
      'Operations', 4 + i, 'items', 'Reviewed fictional training items.', 'Fictional demonstration record only.', timestamp, timestamp);
    ctx.db.prepare('INSERT INTO projects (id, user_id, unit_id, visibility, name, description, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-project', 'synthetic-member', 'synthetic-section', 'unit', 'Workshop preparation — synthetic', 'Prepare fictional training materials.', 40, timestamp, timestamp);
    ctx.db.prepare('INSERT INTO tasks (id, user_id, assignee_id, unit_id, visibility, project_id, title, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-task', 'synthetic-leader', 'synthetic-member', 'synthetic-section', 'unit', 'synthetic-project', 'Prepare checklist — synthetic', 'Fictional materials only.', timestamp, timestamp);
    ctx.db.prepare('INSERT INTO goals (id, user_id, unit_id, visibility, title, description, current_value, target_value, unit_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-goal', 'synthetic-member', 'synthetic-section', 'unit', 'Practice workshops — synthetic', 'Demonstration manual goal.', 2, 5, 'workshops', timestamp, timestamp);
    ctx.db.prepare('INSERT INTO trainings (id, user_id, unit_id, visibility, date, title, type, hours, provider, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-training', 'synthetic-member', 'synthetic-section', 'unit', date(4), 'Facilitation workshop — synthetic', 'Professional development', 2, 'Fictional Training Office', 'Fictional course; no certification claimed.', timestamp, timestamp);
    ctx.db.prepare('INSERT INTO counselings (id, user_id, counselor_id, counselor_name, unit_id, visibility, date, summary, strengths, improvements, goals_set, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('synthetic-counseling', 'synthetic-member', 'synthetic-leader', 'Jordan Sample', 'synthetic-section', 'unit', date(2), 'Synthetic workshop preparation discussion.', 'Clear fictional checklist.', 'Practice concise summaries.', 'Complete five practice workshops.', timestamp, timestamp);
  })();
  Object.assign(ctx.runtime, {
    displayName: 'Vantage — Synthetic Staging', organizationName: 'Fictional Example Section',
    announcement: 'SYNTHETIC STAGING: fictional users and records only. Data resets on restart. Do not enter real information.',
    selfRegistration: false, aiEnabled: false, maradminsEnabled: false,
  });
  ctx.saveRuntime();
}

export function createVideoStagingApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive'); next(); });
  // Protect the staging restrictions from runtime reconfiguration and instance imports.
  app.use((req, res, next) => {
    const path = req.path.toLowerCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (path === '/api/admin' || path.startsWith('/api/admin/'))) {
      res.status(403).json({ error: 'Instance changes are disabled on synthetic staging.', code: 'staging_locked' });
      return;
    }
    next();
  });
  app.use(createApp(ctx));
  return app;
}

export function stagingHtml(html: string): string {
  return html.replace(/<meta\s+name="robots"[^>]*>/i, '')
    .replace('</head>', '<meta name="robots" content="noindex, nofollow, noarchive" /></head>');
}
