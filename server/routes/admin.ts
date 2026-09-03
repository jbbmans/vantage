import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, statSync, unlinkSync } from 'node:fs';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest } from '../lib/errors.ts';
import { requireAuth, requireOperator, requireSudo } from '../auth/middleware.ts';
import { audit, verifyAuditChain } from '../services/audit.ts';
import { aiStatus, discoverModels, unlockAi } from '../services/ai.ts';
import { syncMaradmins, maradminSyncState } from '../services/maradmins.ts';
import { exportInstance, importInstance } from '../services/exports.ts';
import { metaSet, SCHEMA_VERSION } from '../db/index.ts';
import { VERSION } from '../version.ts';
import { newId, now } from '../lib/ids.ts';
import { layout } from '../services/email.ts';
import { runDigestTick } from '../services/digest.ts';
import { RECORD_TABLE_NAMES } from '../services/records.ts';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireOperator, requireSudo);

adminRouter.get('/overview', wrap((req, res) => {
  const { db } = req.ctx;
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  let sizeBytes: number | null = null;
  try { sizeBytes = db.name === ':memory:' ? null : statSync(db.name).size; } catch {}
  res.json({
    version: VERSION, schemaVersion: SCHEMA_VERSION, uptime: Math.round(process.uptime()), node: process.version,
    users: count('SELECT COUNT(*) AS n FROM users WHERE active = 1'), inactiveUsers: count('SELECT COUNT(*) AS n FROM users WHERE active = 0'),
    operators: count('SELECT COUNT(*) AS n FROM users WHERE is_operator = 1 AND active = 1'), units: count('SELECT COUNT(*) AS n FROM units WHERE active = 1'),
    records: RECORD_TABLE_NAMES.reduce((t, table) => t + count(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`), 0),
    sessions: count('SELECT COUNT(*) AS n FROM sessions'), attachments: count('SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL'),
    mfaUsers: count('SELECT COUNT(*) AS n FROM users WHERE totp_enabled = 1 AND active = 1'), passkeyUsers: count('SELECT COUNT(DISTINCT user_id) AS n FROM passkeys'),
    database: { path: db.name, sizeBytes, maxBytes: req.ctx.config.limits.maxDatabaseBytes },
    email: { provider: req.ctx.mailer.provider, enabled: req.ctx.mailer.enabled, from: req.ctx.config.email.from, recent: db.prepare('SELECT to_address, kind, status, error, created_at FROM email_log ORDER BY created_at DESC LIMIT 10').all() },
    maradmins: maradminSyncState(req.ctx),
    runtime: req.ctx.runtime,
    publicUrl: req.ctx.config.publicUrl, rpId: req.ctx.config.rpId, timezone: req.ctx.config.timezone,
    audit: verifyAuditChain(req.ctx),
  });
}));

const runtimeSchema = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  organizationName: z.string().trim().max(120).optional(),
  announcement: z.string().max(240).optional(),
  selfRegistration: z.boolean().optional(),
  aiEnabled: z.boolean().optional(),
  aiModels: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,99}$/)).max(30).optional(),
  aiDefaultModel: z.string().max(100).optional(),
  attachmentsEnabled: z.boolean().optional(),
  maradminsEnabled: z.boolean().optional(),
  maintenance: z.boolean().optional(),
});

adminRouter.put('/runtime', wrap((req, res) => {
  const ctx = req.ctx;
  const patch = parse(runtimeSchema, req.body);
  Object.assign(ctx.runtime, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  if (!ctx.runtime.aiModels.length) ctx.runtime.aiModels = [...ctx.config.ai.models];
  if (!ctx.runtime.aiModels.includes(ctx.runtime.aiDefaultModel)) ctx.runtime.aiDefaultModel = ctx.runtime.aiModels[0];
  ctx.saveRuntime();
  audit(ctx, { actor_id: req.user.id, action: 'edit_configuration', entity: 'instance', detail: Object.keys(patch).join(', '), ip: clientIp(req) });
  res.json(ctx.runtime);
}));

adminRouter.get('/ai', wrap((req, res) => res.json(aiStatus(req.ctx, { operator: true, userId: req.user.id }))));
adminRouter.post('/ai/discover', wrap(async (req, res) => res.json({ models: await discoverModels(req.ctx) })));
adminRouter.post('/ai/unlock', wrap((req, res) => { unlockAi(); audit(req.ctx, { actor_id: req.user.id, action: 'ai_unlocked', entity: 'instance', ip: clientIp(req) }); res.json(aiStatus(req.ctx, { operator: true })); }));

adminRouter.post('/maradmins/sync', wrap(async (req, res) => {
  const result = await syncMaradmins(req.ctx, { force: true });
  audit(req.ctx, { actor_id: req.user.id, action: 'sync_maradmins', entity: 'instance', detail: JSON.stringify(result), ip: clientIp(req) });
  res.json({ ...result, state: maradminSyncState(req.ctx) });
}));

adminRouter.post('/email/test', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (!ctx.mailer.enabled) throw badRequest('Email is not configured. Set VANTAGE_EMAIL_PROVIDER and its credentials.');
  const to = String(req.body?.to || req.user.email || '');
  if (!to) throw badRequest('Provide a destination address or add an email to your profile.');
  const mail = layout({ title: 'Vantage email is working', intro: `This test was sent from ${ctx.config.publicUrl} using the ${ctx.mailer.provider} provider.` });
  const result = await ctx.mailer.send({ to, subject: 'Vantage email test', text: mail.text, html: mail.html, kind: 'test', userId: req.user.id });
  if (!result.ok) throw badRequest(result.error || 'Send failed.');
  res.json({ ok: true });
}));

adminRouter.post('/digest/run', wrap(async (req, res) => res.json(await runDigestTick(req.ctx))));

adminRouter.get('/users', wrap((req, res) => {
  const rows = req.ctx.db.prepare(`SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.is_operator, u.active, u.totp_enabled, u.must_change_password, u.last_login_at, u.created_at, r.abbr AS rank_abbr,
    (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys, (SELECT COUNT(*) FROM unit_members um WHERE um.user_id = u.id) AS units
    FROM users u LEFT JOIN ranks r ON r.id = u.rank_id ORDER BY u.active DESC, u.last_name`).all();
  res.json({ users: rows });
}));

adminRouter.get('/units', wrap((req, res) => {
  const rows = req.ctx.db.prepare(`SELECT u.*, o.first_name AS owner_first, o.last_name AS owner_last, (SELECT COUNT(*) FROM unit_members um WHERE um.unit_id = u.id) AS members FROM units u LEFT JOIN users o ON o.id = u.owner_user_id ORDER BY u.active DESC, u.name`).all();
  res.json({ units: rows });
}));

adminRouter.post('/units/:unitId/claim', wrap((req, res) => {
  const ctx = req.ctx;
  const unitId = String(req.params.unitId);
  const ownerId = String(req.body?.owner_user_id || req.user.id);
  const unit = ctx.db.prepare('SELECT id, owner_user_id FROM units WHERE id = ? AND active = 1').get(unitId) as { id: string; owner_user_id: string | null } | undefined;
  if (!unit) throw badRequest('No such unit.');
  if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(ownerId)) throw badRequest('No such active account.');
  const { claimUnit } = claimModule();
  claimUnit(ctx, unitId, ownerId);
  audit(ctx, { actor_id: req.user.id, action: 'claim_unit', entity: 'unit', entity_id: unitId, subject_id: ownerId, unit_id: unitId, ip: clientIp(req) });
  res.json({ ok: true });
}));

adminRouter.get('/audit', wrap((req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  const rows = req.ctx.db.prepare(`SELECT al.*, u.username AS actor_username, s.username AS subject_username FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id ORDER BY al.seq DESC LIMIT ?`).all(limit);
  res.json({ rows, chain: verifyAuditChain(req.ctx) });
}));

adminRouter.get('/backup', wrap(async (req, res) => {
  const ctx = req.ctx;
  if (ctx.db.name === ':memory:') throw badRequest('In-memory databases cannot be backed up.');
  const stamp = now().replace(/[-:]/g, '').slice(0, 13);
  const dest = join(tmpdir(), `vantage-backup-${stamp}-${newId().slice(0, 6)}.db`);
  await ctx.db.backup(dest);
  chmodSync(dest, 0o600);
  metaSet(ctx.db, 'last_backup_at', now());
  audit(ctx, { actor_id: req.user.id, action: 'backup', entity: 'database', detail: `${statSync(dest).size} bytes`, ip: clientIp(req) });
  res.download(dest, `vantage-backup-${stamp}.db`, () => { try { unlinkSync(dest); } catch {} });
}));

adminRouter.get('/export', wrap((req, res) => {
  const archive = exportInstance(req.ctx);
  audit(req.ctx, { actor_id: req.user.id, action: 'instance_export', entity: 'instance', ip: clientIp(req) });
  res.setHeader('Content-Disposition', `attachment; filename="vantage-instance-${now().slice(0, 10)}.json"`);
  res.json(archive);
}));

adminRouter.post('/import', express.json({ limit: '512mb' }), wrap((req, res) => {
  const archive = req.body;
  let counts;
  try { counts = importInstance(req.ctx, archive, req.user.id); } catch (error) { throw badRequest((error as Error).message); }
  res.json({ ok: true, counts, note: 'All sessions were reset. Sign in again.' });
}));

adminRouter.post('/maintenance', wrap((req, res) => {
  req.ctx.runtime.maintenance = Boolean(req.body?.enabled);
  req.ctx.saveRuntime();
  audit(req.ctx, { actor_id: req.user.id, action: req.ctx.runtime.maintenance ? 'maintenance_on' : 'maintenance_off', entity: 'instance', ip: clientIp(req) });
  res.json({ maintenance: req.ctx.runtime.maintenance });
}));

import { claimUnit as _claimUnit } from '../services/org.ts';
function claimModule() { return { claimUnit: _claimUnit }; }
