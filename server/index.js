import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  getDb, bootstrapAdmin, audit, newId, now, grantRole, revokeRole,
  claimUnit, copyTemplateInto, ownerRoleId, addMember, removeMember, notifyUser,
} from './db.js';
import { VERSION } from './version.js';
import { PERMISSIONS, PERMISSION_LIST, ROLE_TEMPLATES, templateSummaries, DEFAULT_TEMPLATE_ID } from './roles.js';
import {
  verifyPassword, hashPassword, createSession, destroySession, pruneSessions,
  requireAuth, burnVerification, invalidateUserSessions,
  listSessions, revokeSessionByPrefix, sessionIdForToken,
} from './auth.js';
import {
  resolveScope, visibleUserIds, visibilityClause, canEdit, canShareTo,
  can, unitsWith, permissionsIn, permissionMap, positionIn, canManageRole,
  isUnitOwner, isMember, memberUnitIds, VISIBILITIES, DEFAULT_VISIBILITY,
} from './permissions.js';
import { ancestorChain, ancestorIds, wouldCycle, LEVELS } from './org.js';
import { isInstanceOperator, isBootstrapOperator, operatorGate } from './instance.js';
import { normalizeUsername } from './identity.js';
import {
  checkLoginAllowed, checkRegistrationAllowed, recordLoginFailure, recordLoginSuccess, pruneCounters,
} from './security.js';
import {
  RECORD_SCHEMAS, READINESS_SCHEMA, USER_SCHEMA, validate, fieldErrorMessage, BULK_LIMITS,
} from './validate.js';
import { validateRoleDefinition, validateRoleGrant, canManageRoleDefinition } from './roleGuard.js';
import { tmpdir } from 'node:os';
import {
  transferMember, deactivateMember, reactivateMember, resetMemberPassword, forceLogout,
  accessReview, primaryAssignment,
} from './lifecycle.js';
import { applyEditableConfig, config, editableConfig, safeConfig } from './config.js';
import { attachmentDisposition, inspectAttachment } from './attachments.js';
import { EXPERIENCE_EVENTS, recordExperience } from './experience.js';
import { maradminSyncState, syncMaradmins } from './maradmins.js';
import { isTrustedProxyAddress, singleHeader } from './proxyTrust.js';
import {
  INTEGRATION_SCOPE, decodeCursor, encodeCursor, issueIntegrationClient,
  listIntegrationClients, requireExactIntegrationUnit, requireIntegration, revokeIntegrationClient,
} from './integrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = getDb();
try {
  const savedRuntimeConfig = db.prepare("SELECT value FROM meta WHERE key = 'runtime_config'").get()?.value;
  if (savedRuntimeConfig) applyEditableConfig(JSON.parse(savedRuntimeConfig));
} catch (err) {
  console.error('Ignoring invalid saved runtime configuration:', err.message);
}
const maintenancePath = `${db.name}.maintenance`;
pruneSessions(db);

const app = express();
const PRODUCTION = process.env.NODE_ENV === 'production';
if (PRODUCTION && process.env.VANTAGE_TEST === '1') {
  throw new Error('VANTAGE_TEST must never be enabled in production.');
}
const DEPLOYMENT_MODE = config.app.data_mode;
const BUILD_ID = String(process.env.RENDER_GIT_COMMIT || process.env.VANTAGE_BUILD_ID || VERSION).slice(0, 64);

function inlineScriptHashes() {
  const indexPath = join(__dirname, '..', 'dist', 'index.html');
  if (!existsSync(indexPath)) return [];
  const html = readFileSync(indexPath, 'utf8');
  const hashes = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const digest = createHash('sha256').update(match[1], 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

const SCRIPT_SRC = ["'self'", ...inlineScriptHashes()].join(' ');

app.disable('x-powered-by');

function maintenanceGuard(lockPath) {
  return (req, res, next) => {
    if (req.path.startsWith('/api') && req.path !== '/api/health' && existsSync(lockPath)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(503).json({
        error: 'Vantage is in scheduled maintenance. Try again after the deployment is reopened.',
        code: 'maintenance',
      });
    }
    next();
  };
}
app.use(maintenanceGuard(maintenancePath));

function resolveTrustProxy(raw) {
  if (raw === undefined || raw === '') return PRODUCTION ? 1 : false;
  const v = String(raw).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'none'].includes(v)) return false;
  if (['true', 'yes', 'on'].includes(v)) return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return raw;
}
app.set('trust proxy', resolveTrustProxy(config.deployment.trust_proxy));

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader('X-Vantage-Build', BUILD_ID);
  res.setHeader('X-Vantage-Product', 'Vantage');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src ${SCRIPT_SRC}; style-src 'self' 'unsafe-inline'; `
    + "img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; "
    + "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
  }
  if (PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

setInterval(() => {
  pruneCounters();
  try { pruneSessions(db); } catch {}
}, 15 * 60 * 1000).unref?.();

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, version: VERSION, build: BUILD_ID, mode: DEPLOYMENT_MODE, uptime: Math.round(process.uptime()) });
  } catch (err) {
    console.error('Database health check failed:', err);
    res.status(503).json({ ok: false, error: 'Database health check failed.' });
  }
});

app.get('/api/config', (req, res) => {
  res.json(safeConfig());
});

const auth = requireAuth(db);
const fail = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });
const failValidation = (res, fieldErrors) =>
  fail(res, 400, fieldErrorMessage(fieldErrors), { code: 'validation', fieldErrors });
const denyResult = (res, r) => fail(res, r.status || 403, r.message, { code: r.code });
const revokePrivilegeSessions = (userIds) => {
  let revoked = 0;
  for (const userId of new Set(userIds.filter(Boolean))) revoked += invalidateUserSessions(db, userId);
  return revoked;
};

const adminHost = (() => {
  try { return config.deployment.admin_url ? new URL(config.deployment.admin_url).hostname.toLowerCase() : ''; }
  catch { return ''; }
})();

const operatorHostGate = (req, res, next) => {
  if (!PRODUCTION || !adminHost || req.hostname.toLowerCase() === adminHost) return next();
  return fail(res, 404, 'Owner-console actions are available only on the configured admin host.', { code: 'admin_host_required' });
};

app.get('/api/admin/config', auth, operatorHostGate, operatorGate(db), (req, res) => {
  res.json({ ...safeConfig(), editable: editableConfig() });
});

app.put('/api/admin/config', auth, operatorHostGate, operatorGate(db), (req, res) => {
  try {
    const saved = applyEditableConfig(req.body || {});
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('runtime_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(JSON.stringify(saved));
    audit({
      actor_id: req.user.id,
      action: 'edit_configuration',
      entity: 'instance',
      detail: Object.entries(req.body || {}).flatMap(([section, values]) =>
        Object.keys(values || {}).map((key) => `${section}.${key}`)
      ).join(', '),
    });
    res.json({ ...safeConfig(), editable: editableConfig() });
  } catch (err) {
    fail(res, 400, err.message || 'That configuration change is not valid.');
  }
});

app.get('/api/admin/integrations', auth, operatorHostGate, operatorGate(db), (req, res) => {
  const units = db.prepare(
    'SELECT id, code, name, short_name FROM units WHERE active = 1 ORDER BY level, name'
  ).all();
  res.json({ enabled: config.integrations.enabled, scope: INTEGRATION_SCOPE, clients: listIntegrationClients(db), units });
});

app.post('/api/admin/integrations', auth, operatorHostGate, operatorGate(db), (req, res) => {
  try {
    const client = issueIntegrationClient(db, {
      name: req.body?.name,
      unitId: req.body?.unit_id,
      expiresInDays: req.body?.expires_in_days ?? 90,
      createdBy: req.user.id,
    });
    audit({
      actor_id: req.user.id,
      action: 'integration_client_created',
      entity: 'integration_client',
      entity_id: client.id,
      unit_id: client.unit_id,
      detail: `${client.name}; ${client.scope}; expires ${client.expires_at}`,
    });
    res.status(201).json(client);
  } catch (err) {
    fail(res, 400, err.message || 'Integration client could not be created.', { code: 'validation' });
  }
});

app.delete('/api/admin/integrations/:id', auth, operatorHostGate, operatorGate(db), (req, res) => {
  const client = db.prepare('SELECT id, name, unit_id FROM integration_clients WHERE id = ?').get(req.params.id);
  if (!client || !revokeIntegrationClient(db, client.id, req.user.id)) {
    return fail(res, 404, 'No active integration client was found.', { code: 'not_found' });
  }
  audit({
    actor_id: req.user.id,
    action: 'integration_client_revoked',
    entity: 'integration_client',
    entity_id: client.id,
    unit_id: client.unit_id,
    detail: client.name,
  });
  res.json({ ok: true });
});

const integrationAuth = requireIntegration(db);
const exactIntegrationUnit = [integrationAuth, requireExactIntegrationUnit];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validIsoDate = (value) => {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const integrationDateRange = (query) => {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const from = String(query.from || defaultFrom);
  const to = String(query.to || defaultTo);
  if (!validIsoDate(from) || !validIsoDate(to)) return null;
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs || toMs - fromMs > 366 * 86_400_000) return null;
  return { from, to };
};

app.get('/api/integrations/v1', integrationAuth, (req, res) => {
  res.json({
    api_version: '1.0',
    scope: req.integration.scope,
    unit_id: req.integration.unit_id,
    links: {
      unit: `/api/integrations/v1/units/${req.integration.unit_id}`,
      activities: `/api/integrations/v1/units/${req.integration.unit_id}/activities`,
      summary: `/api/integrations/v1/units/${req.integration.unit_id}/summary`,
    },
  });
});

app.get('/api/integrations/v1/units/:unitId', ...exactIntegrationUnit, (req, res) => {
  const unit = db.prepare(
    `SELECT id, parent_id, code, name, short_name, echelon, level, data_mode
       FROM units WHERE id = ? AND active = 1`
  ).get(req.integration.unit_id);
  if (!unit) return fail(res, 404, 'No such integration resource.', { code: 'not_found' });
  res.json({ api_version: '1.0', data: unit });
});

app.get('/api/integrations/v1/units/:unitId/summary', ...exactIntegrationUnit, (req, res) => {
  const range = integrationDateRange(req.query);
  if (!range) return fail(res, 400, 'Use a valid from/to date window of no more than 366 days.', { code: 'invalid_range' });
  const categories = db.prepare(
    `SELECT COALESCE(category, 'Uncategorized') AS category,
            COUNT(*) AS entries,
            COALESCE(SUM(quantity), 0) AS action_amount,
            COALESCE(SUM(dollar_amount), 0) AS transaction_value
       FROM activities
      WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND date >= ? AND date <= ?
      GROUP BY COALESCE(category, 'Uncategorized') ORDER BY entries DESC, category`
  ).all(req.integration.unit_id, range.from, range.to);
  const dollarTypes = db.prepare(
    `SELECT COALESCE(dollar_type, 'Unclassified') AS dollar_type,
            COUNT(*) AS entries, COALESCE(SUM(dollar_amount), 0) AS transaction_value
       FROM activities
      WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND date >= ? AND date <= ?
        AND dollar_amount IS NOT NULL
      GROUP BY COALESCE(dollar_type, 'Unclassified') ORDER BY transaction_value DESC, dollar_type`
  ).all(req.integration.unit_id, range.from, range.to);
  res.json({
    api_version: '1.0',
    unit_id: req.integration.unit_id,
    range,
    totals: {
      entries: categories.reduce((sum, row) => sum + Number(row.entries || 0), 0),
      action_amount: categories.reduce((sum, row) => sum + Number(row.action_amount || 0), 0),
      transaction_value: categories.reduce((sum, row) => sum + Number(row.transaction_value || 0), 0),
    },
    categories,
    dollar_types: dollarTypes,
  });
});

app.get('/api/integrations/v1/units/:unitId/activities', ...exactIntegrationUnit, (req, res) => {
  const requestedLimit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
    return fail(res, 400, 'limit must be an integer from 1 through 200.', { code: 'invalid_limit' });
  }
  const cursor = decodeCursor(req.query.cursor);
  if (req.query.cursor && !cursor) return fail(res, 400, 'cursor is invalid.', { code: 'invalid_cursor' });
  const cursorClause = cursor ? 'AND (a.updated_at > ? OR (a.updated_at = ? AND a.id > ?))' : '';
  const params = cursor
    ? [req.integration.unit_id, cursor.updatedAt, cursor.updatedAt, cursor.id, requestedLimit + 1]
    : [req.integration.unit_id, requestedLimit + 1];
  const rows = db.prepare(
    `SELECT a.id, a.user_id AS subject_id, a.unit_id, a.date, a.title, a.category, a.jepes_area,
            a.quantity AS action_amount, a.unit_label AS action_unit,
            a.dollar_amount AS transaction_value, a.dollar_type,
            a.result, a.organization, a.system, a.status, a.created_at, a.updated_at
       FROM activities a
      WHERE a.unit_id = ? AND a.visibility = 'unit' AND a.deleted_at IS NULL ${cursorClause}
      ORDER BY a.updated_at, a.id LIMIT ?`
  ).all(...params);
  const hasMore = rows.length > requestedLimit;
  const data = hasMore ? rows.slice(0, requestedLimit) : rows;
  res.json({
    api_version: '1.0',
    unit_id: req.integration.unit_id,
    data,
    page: { limit: requestedLimit, next_cursor: hasMore ? encodeCursor(data.at(-1)) : null },
  });
});

const needs = (flag, unitFrom = (req) => req.body?.unit_id || req.params?.unitId) => (req, res, next) => {
  const unitId = unitFrom(req);
  if (!unitId) return fail(res, 400, 'A unit is required for this action.');
  if (!can(db, req.user, flag, unitId)) return fail(res, 403, 'You do not have that permission in this unit.');
  next();
};

const TABLES = {
  activities: {
    fields: ['date', 'title', 'category', 'jepes_area', 'quantity', 'unit_label', 'dollar_amount', 'dollar_type',
      'result', 'organization', 'system', 'project_id', 'status', 'notes', 'evidence_links', 'visibility', 'unit_id'],
    json: ['evidence_links'],
    defaultVisibility: DEFAULT_VISIBILITY,
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
  projects: {
    fields: ['name', 'description', 'status', 'priority', 'progress', 'start_date', 'target_date',
      'organization', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'private',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
    memberReadable: true,
  },
  tasks: {
    fields: ['title', 'notes', 'status', 'priority', 'due_date', 'project_id', 'assignee_id', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'private',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
    memberReadable: true,
  },
  goals: {
    fields: ['title', 'description', 'type', 'category', 'current_value', 'target_value', 'unit_label',
      'status', 'period_start', 'period_end', 'assignee_id', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'private',
    shareFlag: PERMISSIONS.CREATE_SHARED_GOALS,
    memberReadable: true,
  },
  recognitions: {
    fields: ['date', 'title', 'type', 'from_whom', 'organization', 'notes', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: DEFAULT_VISIBILITY,
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
  trainings: {
    fields: ['date', 'title', 'type', 'hours', 'provider', 'status', 'notes', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: DEFAULT_VISIBILITY,
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
};

const MAX_RECORDS_PER_USER = config.limits.max_records_per_user;
const MAX_DB_BYTES = config.limits.max_database_bytes;

function ownedRecordCount(userId) {
  return Object.keys(TABLES).reduce(
    (sum, table) => sum + db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId).n,
    0
  );
}

function recordCapacityProblem(userId, additional = 1) {
  if (ownedRecordCount(userId) + additional > MAX_RECORDS_PER_USER) {
    return `This account has reached its ${MAX_RECORDS_PER_USER.toLocaleString()}-record retention limit. Contact the Instance Operator.`;
  }
  try {
    if (statSync(db.name).size >= MAX_DB_BYTES) {
      return 'The database has reached its configured safety threshold. New records are paused to preserve recovery headroom.';
    }
  } catch {}
  return null;
}

function auditForeignListReads(actor, table, rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row.user_id || row.user_id === actor.id) continue;
    const key = `${row.user_id}\0${row.unit_id || ''}`;
    const prior = grouped.get(key) || { subjectId: row.user_id, unitId: row.unit_id || null, count: 0 };
    prior.count += 1;
    grouped.set(key, prior);
  }
  const recentlyAudited = db.prepare(
    `SELECT 1 FROM audit_log
      WHERE actor_id = ? AND action = 'list_records' AND entity = ?
        AND subject_id = ? AND unit_id IS ?
        AND julianday(at) > julianday('now', '-5 minutes') LIMIT 1`
  );
  for (const group of grouped.values()) {
    if (recentlyAudited.get(actor.id, table, group.subjectId, group.unitId)) continue;
    audit({
      actor_id: actor.id, action: 'list_records', entity: table,
      subject_id: group.subjectId, unit_id: group.unitId,
      detail: `${group.count} ${table} returned in an authorized list`,
    });
  }
}

const hydrate = (row, spec) => {
  if (!row) return row;
  for (const key of spec.json) {
    if (typeof row[key] === 'string') {
      try { row[key] = JSON.parse(row[key]); } catch { row[key] = []; }
    }
  }
  return row;
};

function unitAllowedForRecord(user, unitId, shareFlag) {
  if (!unitId) return true;
  if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) return false;
  if (isMember(db, user.id, unitId)) return true;

  return can(db, user, shareFlag, unitId) || can(db, user, PERMISSIONS.MANAGE_RECORDS, unitId);
}

function assigneeError(user, assigneeId, unitId) {
  if (!assigneeId || assigneeId === user.id) return null;
  const target = db.prepare('SELECT id, active FROM users WHERE id = ?').get(assigneeId);
  if (!target) return 'No such Marine.';
  if (!target.active) return 'That account is deactivated.';
  if (!visibleUserIds(db, user).includes(assigneeId)) return 'That Marine is outside your scope.';

  if (unitId && !isMember(db, assigneeId, unitId)) {
    return 'That Marine is not a member of that unit.';
  }
  return null;
}

app.get('/api/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({
    needsSetup: n === 0,
    requiresSetupToken: n === 0 && PRODUCTION,
    selfRegistration: config.auth.self_registration,
    passwordEnabled: config.auth.password_enabled,
    cacPivEnabled: config.auth.cac_piv.enabled,
    defaultTheme: config.ui.default_theme,
  });
});

function setupTokenAccepted(req) {
  if (!PRODUCTION) return { ok: true };
  const expected = String(process.env.VANTAGE_SETUP_TOKEN || '');
  if (expected.length < 24) {
    return { ok: false, status: 503, message: 'First-run setup is locked until VANTAGE_SETUP_TOKEN is configured.' };
  }
  const supplied = String(req.get('x-vantage-setup-token') || req.body?.setup_token || '');
  const left = createHash('sha256').update(supplied).digest();
  const right = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(left, right)) {
    return { ok: false, status: 403, message: 'The deployment setup token is incorrect.' };
  }
  return { ok: true };
}

app.post('/api/setup', (req, res) => {
  const blocked = checkLoginAllowed(req.ip, '');
  if (blocked) {
    res.setHeader('Retry-After', String(blocked.retryAfter));
    return fail(res, blocked.status, blocked.message, { code: 'throttled' });
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    return fail(res, 409, 'Vantage is already set up.');
  }
  const setupGate = setupTokenAccepted(req);
  if (!setupGate.ok) {
    recordLoginFailure(req.ip, '');
    return fail(res, setupGate.status, setupGate.message, { code: 'setup_locked' });
  }
  const setupBody = { ...(req.body || {}), username: normalizeUsername(req.body?.username) };
  const setupErrors = validate(USER_SCHEMA, setupBody)?.fieldErrors || {};
  const setupUnitCode = setupBody.unit_code || 'MFR';
  if (!db.prepare('SELECT 1 FROM units WHERE code = ? AND active = 1').get(setupUnitCode)) {
    setupErrors.unit_code = 'No such active unit code.';
  }
  if (setupBody.rank_id && !db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(setupBody.rank_id)) {
    setupErrors.rank_id = 'No such rank.';
  }
  if (setupBody.billet_title && !db.prepare('SELECT 1 FROM billets WHERE title = ? AND active = 1').get(setupBody.billet_title)) {
    setupErrors.billet_title = 'No such active billet.';
  }
  if (Object.keys(setupErrors).length) {
    recordLoginFailure(req.ip, '');
    return failValidation(res, setupErrors);
  }
  try {
    const created = bootstrapAdmin(setupBody);
    if (!created) {
      recordLoginFailure(req.ip, '');
      return fail(res, 409, 'Vantage is already set up.');
    }
    res.json(created);
  } catch (err) {
    recordLoginFailure(req.ip, '');
    console.error('First-run setup failed:', err);
    fail(res, 500, 'First-run setup could not complete. No account was created.');
  }
});

app.post('/api/register', (req, res) => {
  if (!config.auth.password_enabled || !config.auth.self_registration) {
    return fail(res, 404, 'Self-registration is not enabled.', { code: 'registration_disabled' });
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    return fail(res, 409, 'The deployment must be initialized before accounts can self-register.', {
      code: 'setup_required',
    });
  }
  const limited = checkRegistrationAllowed(req.ip);
  if (limited) {
    res.setHeader('Retry-After', String(limited.retryAfter));
    return fail(res, 429, 'Too many accounts were requested from this connection. Try again later.', {
      code: 'registration_throttled',
    });
  }
  const body = {
    username: normalizeUsername(req.body?.username),
    password: req.body?.password,
    first_name: req.body?.first_name,
    last_name: req.body?.last_name,
    middle_initial: req.body?.middle_initial,
    rank_id: req.body?.rank_id,
    mos: req.body?.mos,
    email: req.body?.email,
  };
  const errors = validate(USER_SCHEMA, body)?.fieldErrors || {};
  if (body.rank_id && !db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) {
    errors.rank_id = 'No such rank.';
  }
  if (Object.keys(errors).length) return failValidation(res, errors);

  try {
    const id = newId();
    db.prepare(
      `INSERT INTO users
        (id, username, password_hash, last_name, first_name, middle_initial, rank_id, mos, email,
         must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id, body.username, hashPassword(body.password), body.last_name, body.first_name,
      body.middle_initial || null, body.rank_id || null, body.mos || null, body.email || null,
      now(), now()
    );
    audit({ actor_id: id, action: 'self_register', entity: 'user', entity_id: id, subject_id: id });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return failValidation(res, { username: 'That username is unavailable.' });
    }
    console.error('Self-registration failed:', err);
    return fail(res, 500, 'The account could not be created.', { code: 'registration_failed' });
  }
});

function finishSignIn(req, res, row, action = 'login') {
  const { token, expires } = createSession(db, row.id, { ip: req.ip, userAgent: req.get('user-agent') });
  audit({ actor_id: row.id, action, unit_id: primaryAssignment(db, row.id)?.unit_id || null });
  res.cookie('vantage_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: PRODUCTION || req.secure,
  });
  res.cookie('vantage_signed_in', '1', {
    httpOnly: false,
    sameSite: 'strict',
    secure: PRODUCTION || req.secure,
  });
  const response = { expires, mustChangePassword: Boolean(row.must_change_password) };
  if (process.env.VANTAGE_TEST === '1') response.token = token;
  return res.json(response);
}

app.post('/api/login', (req, res) => {
  if (!config.auth.password_enabled) {
    return fail(res, 503, 'Password sign-in is disabled for this deployment.', { code: 'password_disabled' });
  }
  const { username, password } = req.body || {};
  const loginName = typeof username === 'string' && username.length <= 40 ? normalizeUsername(username) : '';
  const loginPassword = typeof password === 'string' && password.length <= 512 && [...password].length <= 256 ? password : '';
  const blocked = checkLoginAllowed(req.ip, loginName);
  if (blocked && blocked.scope !== 'account') {
    res.setHeader('Retry-After', String(blocked.retryAfter));
    return fail(res, blocked.status, blocked.message, { code: 'throttled' });
  }

  const accountBlocked = blocked?.scope === 'account';
  const row = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND active = 1').get(loginName);

  if (!row) {
    burnVerification(loginPassword);
    recordLoginFailure(req.ip, loginName);
    if (accountBlocked) {
      res.setHeader('Retry-After', String(blocked.retryAfter));
      return fail(res, 429, blocked.message, { code: 'throttled' });
    }
    return fail(res, 401, 'Username or password is incorrect.');
  }
  if (!verifyPassword(loginPassword, row.password_hash)) {
    const crossedThreshold = recordLoginFailure(req.ip, loginName);
    if (crossedThreshold) {
      audit({ actor_id: row.id, action: 'login_lockout', detail: 'failed-attempt threshold reached for this account' });
    }
    if (accountBlocked) {
      res.setHeader('Retry-After', String(blocked.retryAfter));
      return fail(res, 429, blocked.message, { code: 'throttled' });
    }
    return fail(res, 401, 'Username or password is incorrect.');
  }

  recordLoginSuccess(req.ip, loginName);
  return finishSignIn(req, res, row);
});

app.post('/api/auth/cac-piv', (req, res) => {
  if (!config.auth.cac_piv.enabled) {
    return fail(res, 404, 'CAC/PIV sign-in is not enabled.', { code: 'cac_piv_disabled' });
  }
  const blocked = checkLoginAllowed(req.ip, '');
  if (blocked) {
    res.setHeader('Retry-After', String(blocked.retryAfter));
    return fail(res, blocked.status, blocked.message, { code: 'throttled' });
  }
  const rejectAssertion = (status, message, code) => {
    recordLoginFailure(req.ip, '');
    return fail(res, status, message, { code });
  };
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    return fail(res, 409, 'The deployment must be initialized before CAC/PIV accounts can be created.', {
      code: 'setup_required',
    });
  }
  const proxySecret = String(process.env.VANTAGE_CAC_PROXY_SECRET || '');
  if (proxySecret.length < 32) {
    return fail(res, 503, 'CAC/PIV sign-in is not fully configured.', { code: 'cac_piv_unconfigured' });
  }
  if (!isTrustedProxyAddress(req.socket?.remoteAddress, config.auth.cac_piv.trusted_proxy_ips)) {
    return rejectAssertion(401, 'CAC/PIV assertion was not issued by the trusted proxy.', 'cac_piv_untrusted');
  }
  const suppliedSecret = singleHeader(req, config.auth.cac_piv.proxy_secret_header);
  if (suppliedSecret === null) {
    return rejectAssertion(401, 'CAC/PIV assertion was not issued by the trusted proxy.', 'cac_piv_untrusted');
  }
  const suppliedDigest = createHash('sha256').update(suppliedSecret).digest();
  const expectedDigest = createHash('sha256').update(proxySecret).digest();
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    return rejectAssertion(401, 'CAC/PIV assertion was not issued by the trusted proxy.', 'cac_piv_untrusted');
  }
  const verifiedHeader = singleHeader(req, config.auth.cac_piv.verification_header);
  const verified = String(verifiedHeader || '').toLowerCase();
  if (verified !== String(config.auth.cac_piv.verification_value).toLowerCase()) {
    return rejectAssertion(401, 'The client certificate was not verified.', 'cac_piv_unverified');
  }

  const subject = String(singleHeader(req, config.auth.cac_piv.subject_header) || '').trim();
  const username = normalizeUsername(singleHeader(req, config.auth.cac_piv.username_header));
  const firstName = String(singleHeader(req, config.auth.cac_piv.first_name_header) || '').trim();
  const lastName = String(singleHeader(req, config.auth.cac_piv.last_name_header) || '').trim();
  if (!subject || subject.length > 512 || !username || !firstName || !lastName) {
    return rejectAssertion(400, 'The trusted proxy did not supply a complete CAC/PIV identity.', 'cac_piv_incomplete');
  }

  let row = db.prepare('SELECT * FROM users WHERE cac_subject = ? AND active = 1').get(subject);
  if (!row) {
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
      return fail(res, 409, 'This CAC/PIV identity must be linked to the existing account by an operator.', {
        code: 'cac_piv_link_required',
      });
    }
    const generatedPassword = randomBytes(48).toString('base64url');
    const candidate = { username, password: generatedPassword, first_name: firstName, last_name: lastName };
    const errors = validate(USER_SCHEMA, candidate);
    if (errors) return failValidation(res, errors.fieldErrors);
    const id = newId();
    db.prepare(
      `INSERT INTO users
        (id, username, password_hash, cac_subject, last_name, first_name,
         must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(id, username, hashPassword(generatedPassword), subject, lastName, firstName, now(), now());
    audit({ actor_id: id, action: 'cac_account_created', entity: 'user', entity_id: id, subject_id: id });
    row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  recordLoginSuccess(req.ip, '');
  return finishSignIn(req, res, row, 'cac_login');
});

app.post('/api/logout', auth, (req, res) => {
  destroySession(db, req.token);
  audit({ actor_id: req.user.id, action: 'logout' });
  res.clearCookie('vantage_session');
  res.clearCookie('vantage_signed_in');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  const scope = resolveScope(db, req.user);
  const rank = req.user.rank_id ? db.prepare('SELECT * FROM ranks WHERE id = ?').get(req.user.rank_id) : null;
  res.json({
    user: { ...req.user, rank },
    assignments: scope.assignments,
    roles: scope.roles,
    canLead: scope.canLead,
    scopeUnitIds: scope.scopeUnitIds,
    unitIds: scope.unitIds,
    memberships: scope.memberships,
    ownedUnitIds: scope.ownedUnitIds,
    permissions: scope.permissions,
    positions: scope.positions,
    topPosition: scope.topPosition,
    isOperator: isInstanceOperator(req.user) || isBootstrapOperator(db, req.user),
    deploymentMode: DEPLOYMENT_MODE,
    manageableUnits: unitsWith(db, req.user, PERMISSIONS.MANAGE_UNITS),

    chain: scope.unitIds.length ? ancestorChain(db, scope.unitIds[0]) : [],
  });
});

const isOperator = (user) => isInstanceOperator(user) || isBootstrapOperator(db, user);

function rankAuthority(actor, target) {
  if (!target) return { ok: false, status: 404, message: 'No such Marine.' };
  if (actor.id === target.id) {
    if (isOperator(actor)) {
      return { ok: true, unitId: primaryAssignment(db, target.id)?.unit_id || null };
    }
    return { ok: false, status: 400, message: 'Request your own rank update instead of editing it directly.' };
  }
  if (isOperator(actor)) return { ok: true, unitId: primaryAssignment(db, target.id)?.unit_id || null };
  for (const unitId of memberUnitIds(db, target.id)) {
    if (!can(db, actor, PERMISSIONS.MANAGE_MEMBERS, unitId)) continue;
    if (isUnitOwner(db, actor.id, unitId) || positionIn(db, actor, unitId) > positionIn(db, target, unitId)) {
      return { ok: true, unitId };
    }
  }
  return { ok: false, status: 403, message: 'You cannot change this Marine’s rank.' };
}

function prepareMemberProfile(actor, target, payload) {
  const authority = rankAuthority(actor, target);
  if (!authority.ok) return authority;
  const body = Object.fromEntries(
    ['rank_id', 'mos', 'email', 'eas']
      .filter((key) => Object.prototype.hasOwnProperty.call(payload || {}, key))
      .map((key) => [key, payload[key]])
  );
  if (!Object.keys(body).length) return { ok: false, status: 400, message: 'No profile changes were provided.' };
  const errors = validate(USER_SCHEMA, body, { partial: true });
  if (errors) return { ok: false, status: 400, fieldErrors: errors.fieldErrors };
  if (body.rank_id && !db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(body.rank_id)) {
    return { ok: false, status: 400, fieldErrors: { rank_id: 'No such rank.' } };
  }
  const changes = Object.entries(body)
    .map(([key, value]) => [key, value === '' ? null : value])
    .filter(([key, value]) => (target[key] ?? null) !== value);
  return { ok: true, authority, changes };
}

function applyMemberProfile(actor, target, changes, updatedAt = now()) {
  if (!changes.length) return [];
  const sets = changes.map(([key]) => `${key} = ?`);
  db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(
    ...changes.map(([, value]) => value), updatedAt, target.id
  );
  const rankChange = changes.find(([key]) => key === 'rank_id');
  if (rankChange) {
    const nextRankId = rankChange[1];
    db.prepare(
      `UPDATE rank_change_requests
          SET status = CASE WHEN requested_rank_id = ? THEN 'approved' ELSE 'denied' END,
              reviewed_by = ?, reviewed_at = ?,
              review_note = COALESCE(review_note, 'Resolved by direct profile update'), updated_at = ?
        WHERE user_id = ? AND status = 'pending'`
    ).run(nextRankId, actor.id, updatedAt, updatedAt, target.id);
    const rank = nextRankId ? db.prepare('SELECT abbr FROM ranks WHERE id = ?').get(nextRankId) : null;
    notifyUser(target.id, {
      kind: 'profile',
      title: 'Rank updated',
      message: `Your rank was updated to ${rank?.abbr || 'Unassigned'}.`,
      actionUrl: '/settings#rank',
    });
  }
  return changes.map(([key]) => key);
}

function rankRequestRows(where, params = []) {
  return db.prepare(`
    SELECT rr.*,
           current_rank.abbr AS current_rank_abbr,
           requested_rank.abbr AS requested_rank_abbr,
           requested_rank.name AS requested_rank_name,
           u.first_name, u.last_name,
           reviewer.first_name AS reviewer_first_name,
           reviewer.last_name AS reviewer_last_name
      FROM rank_change_requests rr
      JOIN users u ON u.id = rr.user_id
      LEFT JOIN ranks current_rank ON current_rank.id = rr.current_rank_id
      JOIN ranks requested_rank ON requested_rank.id = rr.requested_rank_id
      LEFT JOIN users reviewer ON reviewer.id = rr.reviewed_by
     WHERE ${where}
     ORDER BY rr.created_at DESC
  `).all(...params);
}

function notifyRankReviewers(target, requestId, requestedRank) {
  const reviewers = db.prepare('SELECT * FROM users WHERE active = 1 AND id <> ?').all(target.id)
    .filter((candidate) => rankAuthority(candidate, target).ok);
  for (const reviewer of reviewers) {
    notifyUser(reviewer.id, {
      kind: 'rank_request',
      title: 'Rank update requested',
      message: `${target.first_name} ${target.last_name} requested ${requestedRank.abbr}.`,
      actionUrl: `/settings?rankRequest=${encodeURIComponent(requestId)}#rank`,
      dedupeKey: `rank-request:${requestId}`,
    });
  }
}

app.get('/api/notifications', auth, (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
  const rows = db.prepare(
    `SELECT id, kind, title, message, action_url, read_at, created_at
       FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(req.user.id, limit);
  const unread = db.prepare(
    'SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL'
  ).get(req.user.id).count;
  res.json({ rows, unread });
});

app.put('/api/notifications/:id/read', auth, (req, res) => {
  const result = db.prepare(
    'UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?'
  ).run(now(), req.params.id, req.user.id);
  if (!result.changes) return fail(res, 404, 'No such notification.');
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', auth, (req, res) => {
  const result = db.prepare(
    'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'
  ).run(now(), req.user.id);
  res.json({ ok: true, updated: result.changes });
});

app.get('/api/rank-requests', auth, (req, res) => {
  const mine = rankRequestRows('rr.user_id = ?', [req.user.id]).slice(0, 20);
  const review = rankRequestRows("rr.status = 'pending' AND rr.user_id <> ?", [req.user.id])
    .filter((row) => rankAuthority(req.user, { id: row.user_id }).ok)
    .slice(0, 100);
  res.json({ mine, review });
});

app.post('/api/rank-requests', auth, (req, res) => {
  const requestedRankId = String(req.body?.rank_id || '');
  const reason = String(req.body?.reason || '').trim();
  if (!requestedRankId) return failValidation(res, { rank_id: 'Select the requested rank.' });
  if (reason.length > 500) return failValidation(res, { reason: 'Keep the reason under 500 characters.' });
  const rank = db.prepare('SELECT * FROM ranks WHERE id = ?').get(requestedRankId);
  if (!rank) return failValidation(res, { rank_id: 'No such rank.' });
  if (requestedRankId === req.user.rank_id) return fail(res, 400, 'That is already your current rank.');
  const id = newId();
  const unitId = primaryAssignment(db, req.user.id)?.unit_id || memberUnitIds(db, req.user.id)[0] || null;
  try {
    db.prepare(
      `INSERT INTO rank_change_requests
        (id, user_id, current_rank_id, requested_rank_id, reason, unit_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).run(id, req.user.id, req.user.rank_id || null, requestedRankId, reason || null, unitId, now(), now());
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return fail(res, 409, 'You already have a pending rank request.', { code: 'pending_rank_request' });
    }
    throw error;
  }
  notifyRankReviewers(req.user, id, rank);
  audit({
    actor_id: req.user.id, action: 'request_rank_change', entity: 'rank_change_request',
    entity_id: id, subject_id: req.user.id, unit_id: unitId,
    detail: `${req.user.rank_id || 'unassigned'} → ${requestedRankId}`,
  });
  res.json({ id, status: 'pending' });
});

app.post('/api/rank-requests/:id/cancel', auth, (req, res) => {
  const request = db.prepare('SELECT * FROM rank_change_requests WHERE id = ?').get(req.params.id);
  if (!request || request.user_id !== req.user.id) return fail(res, 404, 'No such rank request.');
  if (request.status !== 'pending') return fail(res, 409, 'That request has already been reviewed.');
  db.prepare(
    "UPDATE rank_change_requests SET status = 'cancelled', updated_at = ? WHERE id = ?"
  ).run(now(), request.id);
  audit({
    actor_id: req.user.id, action: 'cancel_rank_change', entity: 'rank_change_request',
    entity_id: request.id, subject_id: req.user.id, unit_id: request.unit_id,
  });
  res.json({ ok: true });
});

app.put('/api/rank-requests/:id', auth, (req, res) => {
  const request = db.prepare('SELECT * FROM rank_change_requests WHERE id = ?').get(req.params.id);
  if (!request) return fail(res, 404, 'No such rank request.');
  if (request.status !== 'pending') return fail(res, 409, 'That request has already been reviewed.');
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(request.user_id);
  const authority = rankAuthority(req.user, target);
  if (!authority.ok) return fail(res, authority.status, authority.message);
  const status = String(req.body?.status || '');
  if (!['approved', 'denied'].includes(status)) return failValidation(res, { status: 'Approve or deny the request.' });
  const note = String(req.body?.note || '').trim();
  if (note.length > 500) return failValidation(res, { note: 'Keep the note under 500 characters.' });
  const requestedRank = db.prepare('SELECT abbr, name FROM ranks WHERE id = ?').get(request.requested_rank_id);
  const reviewedAt = now();
  db.transaction(() => {
    if (status === 'approved') {
      db.prepare('UPDATE users SET rank_id = ?, updated_at = ? WHERE id = ?').run(
        request.requested_rank_id, reviewedAt, request.user_id
      );
    }
    db.prepare(
      `UPDATE rank_change_requests
          SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, updated_at = ?
        WHERE id = ?`
    ).run(status, req.user.id, reviewedAt, note || null, reviewedAt, request.id);
    notifyUser(request.user_id, {
      kind: 'rank_request',
      title: `Rank request ${status}`,
      message: status === 'approved'
        ? `Your rank was updated to ${requestedRank?.abbr || request.requested_rank_id}.`
        : `Your request for ${requestedRank?.abbr || request.requested_rank_id} was not approved.${note ? ` ${note}` : ''}`,
      actionUrl: '/settings#rank',
      dedupeKey: `rank-review:${request.id}`,
    });
  })();
  audit({
    actor_id: req.user.id, action: `${status}_rank_change`, entity: 'rank_change_request',
    entity_id: request.id, subject_id: request.user_id, unit_id: authority.unitId || request.unit_id,
    detail: `${request.current_rank_id || 'unassigned'} → ${request.requested_rank_id}`,
  });
  res.json({ ok: true, status });
});

app.get('/api/maradmins', auth, async (req, res) => {
  let syncError = null;
  const cached = db.prepare('SELECT COUNT(*) AS count FROM maradmins').get().count > 0;
  if (!cached || req.query.wait === '1') {
    try { await syncMaradmins(db); }
    catch (error) { syncError = error.message || 'The official feed could not be refreshed.'; }
  } else {
    syncMaradmins(db).catch(() => {});
  }
  const rows = db.prepare(`
    SELECT m.*, state.read_at, state.saved_at
      FROM maradmins m
      LEFT JOIN maradmin_user_state state
        ON state.maradmin_id = m.id AND state.user_id = ?
     ORDER BY m.published_at DESC LIMIT 250
  `).all(req.user.id).map((row) => ({
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    audience: JSON.parse(row.audience || '[]'),
  }));
  res.json({ rows, sync: { ...maradminSyncState(db), error: syncError } });
});

app.put('/api/maradmins/:id/state', auth, (req, res) => {
  if (!db.prepare('SELECT 1 FROM maradmins WHERE id = ?').get(req.params.id)) {
    return fail(res, 404, 'No such MARADMIN.');
  }
  const existing = db.prepare(
    'SELECT read_at, saved_at FROM maradmin_user_state WHERE user_id = ? AND maradmin_id = ?'
  ).get(req.user.id, req.params.id);
  const readAt = req.body?.read === undefined ? existing?.read_at || null : (req.body.read ? now() : null);
  const savedAt = req.body?.saved === undefined ? existing?.saved_at || null : (req.body.saved ? now() : null);
  db.prepare(`
    INSERT INTO maradmin_user_state (user_id, maradmin_id, read_at, saved_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, maradmin_id) DO UPDATE SET
      read_at = excluded.read_at,
      saved_at = excluded.saved_at
  `).run(req.user.id, req.params.id, readAt, savedAt);
  res.json({ ok: true, read_at: readAt, saved_at: savedAt });
});

app.post('/api/experience', auth, (req, res) => {
  if (!config.experience_metrics.enabled) return res.status(204).end();
  const event = String(req.body?.event || '');
  if (!EXPERIENCE_EVENTS.has(event)) {
    return fail(res, 400, 'Unknown experience event.', { code: 'invalid_experience_event' });
  }
  recordExperience(db, event);
  return res.status(204).end();
});

app.get('/api/admin/experience', auth, operatorHostGate, operatorGate(db), (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 3650);
  const rows = db.prepare(
    `SELECT day, event, count FROM ux_daily_metrics
      WHERE day >= date('now', ?) ORDER BY day DESC, event`
  ).all(`-${days - 1} days`);
  res.json({
    mode: config.experience_metrics.mode,
    enabled: config.experience_metrics.enabled,
    days,
    rows,
    privacy: 'Aggregate event counts only; no user, session, IP, record, filename, or free text.',
  });
});

app.get('/api/admin/overview', auth, operatorHostGate, operatorGate(db), (req, res) => {
  const count = (table, where = '1 = 1') => db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
  res.json({
    version: VERSION,
    uptime: Math.round(process.uptime()),
    users: count('users', 'active = 1'),
    units: count('units', 'active = 1'),
    records: ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']
      .reduce((total, table) => total + count(table, 'deleted_at IS NULL'), 0),
    sessions: count('sessions'),
    deployment: safeConfig().deployment,
    maradmins: maradminSyncState(db),
  });
});

app.post('/api/admin/maradmins/sync', auth, operatorHostGate, operatorGate(db), async (req, res) => {
  try {
    const result = await syncMaradmins(db, { force: true });
    audit({ actor_id: req.user.id, action: 'sync_maradmins', entity: 'instance', detail: JSON.stringify(result) });
    res.json({ ...result, state: maradminSyncState(db) });
  } catch (error) {
    fail(res, 502, error.message || 'The official MARADMIN feed could not be refreshed.', { code: 'maradmin_sync_failed' });
  }
});

app.post('/api/me/password', auth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current_password || ''), stored?.password_hash)) {
    return fail(res, 403, 'Current password is incorrect.', { code: 'bad_password' });
  }
  const err = USER_SCHEMA.password(new_password);
  if (err) return failValidation(res, { new_password: err });
  if (String(current_password) === String(new_password)) {
    return failValidation(res, { new_password: 'Choose a different password.' });
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(
    hashPassword(new_password), now(), req.user.id
  );
  const revoked = invalidateUserSessions(db, req.user.id, { exceptToken: req.token });
  audit({ actor_id: req.user.id, action: 'password_change', detail: `other sessions revoked: ${revoked}` });
  res.json({ ok: true, otherSessionsRevoked: revoked });
});

app.get('/api/me/sessions', auth, (req, res) => {
  res.json({ sessions: listSessions(db, req.user.id, req.token) });
});

app.post('/api/me/sessions/revoke-others', auth, (req, res) => {
  const revoked = invalidateUserSessions(db, req.user.id, { exceptToken: req.token });
  audit({ actor_id: req.user.id, action: 'revoke_sessions', detail: `own other sessions: ${revoked}` });
  res.json({ ok: true, revoked });
});

app.delete('/api/me/sessions/:sid', auth, (req, res) => {
  const isCurrent = sessionIdForToken(req.token) === req.params.sid;
  const n = revokeSessionByPrefix(db, req.user.id, req.params.sid);
  if (!n) return fail(res, 404, 'No such session.');
  audit({ actor_id: req.user.id, action: 'revoke_sessions', detail: 'one own session' });
  if (isCurrent) {
    res.clearCookie('vantage_session');
    res.clearCookie('vantage_signed_in');
  }
  res.json({ ok: true, current: isCurrent });
});

app.get('/api/org', auth, (req, res) => {
  const mine = memberUnitIds(db, req.user.id);
  const operator = isInstanceOperator(req.user) || isBootstrapOperator(db, req.user);

  const displayIds = operator
    ? db.prepare('SELECT id FROM units WHERE active = 1').all().map((r) => r.id)
    : ancestorIds(db, mine);
  const units = displayIds.length
    ? db.prepare(`SELECT * FROM units WHERE active = 1 AND id IN (${displayIds.map(() => '?').join(',')}) ORDER BY echelon, name`).all(...displayIds)
    : [];
  const roles = mine.length
    ? db.prepare(`SELECT * FROM roles WHERE unit_id IN (${mine.map(() => '?').join(',')}) ORDER BY position DESC, name`).all(...mine)
    : [];
  res.json({
    ranks: db.prepare('SELECT * FROM ranks ORDER BY sort').all(),
    billets: db.prepare('SELECT * FROM billets WHERE active = 1 ORDER BY category, title').all(),
    units,
    roles,
    permissionCatalogue: PERMISSION_LIST.map((p) => ({ ...p, bit: PERMISSIONS[p.key] })),
  });
});

app.get('/api/org/templates', auth, (req, res) => {
  res.json({ templates: templateSummaries(), default: DEFAULT_TEMPLATE_ID, levels: LEVELS });
});

app.post('/api/org/units', auth, (req, res) => {
  const { code, name, short_name, echelon, location, parent_id, level, template_id } = req.body || {};
  const fieldErrors = {};
  if (!name || typeof name !== 'string' || !name.trim()) fieldErrors.name = 'Required.';
  else if (name.length > 120) fieldErrors.name = 'Too long (limit 120 characters).';
  if (short_name && (typeof short_name !== 'string' || short_name.length > 40)) fieldErrors.short_name = 'Too long (limit 40 characters).';
  if (location && (typeof location !== 'string' || location.length > 120)) fieldErrors.location = 'Too long (limit 120 characters).';
  if (echelon && (typeof echelon !== 'string' || echelon.length > 40)) fieldErrors.echelon = 'Too long (limit 40 characters).';
  if (level && !LEVELS.includes(level)) fieldErrors.level = `Choose one of ${LEVELS.join(', ')}.`;
  if (template_id && !ROLE_TEMPLATES.some((t) => t.id === template_id)) fieldErrors.template_id = 'No such role template.';
  if (Object.keys(fieldErrors).length) return failValidation(res, fieldErrors);

  if (parent_id) {
    if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(parent_id)) {
      return fail(res, 400, 'No such parent unit.');
    }
    if (!can(db, req.user, PERMISSIONS.MANAGE_UNITS, parent_id)) {
      return fail(res, 403, 'You cannot create units under that parent.');
    }
  } else if (!isInstanceOperator(req.user) && !isBootstrapOperator(db, req.user)) {
    return fail(
      res,
      403,
      'Creating a new top-level organization is restricted to the Instance Operator.',
      { code: 'not_operator' }
    );
  }

  const id = (code || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!id) return fail(res, 400, 'That name produces an empty unit code.');
  const creatorIsOperator = isInstanceOperator(req.user) || isBootstrapOperator(db, req.user);

  try {
    const result = db.transaction(() => {
      db.prepare(
        `INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, level, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, id, name.trim(), short_name?.trim() || null, echelon || 'section',
        location?.trim() || null, parent_id || null, level || 'L4', now()
      );
      claimUnit(id, req.user.id, template_id || DEFAULT_TEMPLATE_ID);
      const sessionsRevoked = creatorIsOperator ? 0 : revokePrivilegeSessions([req.user.id]);
      audit({ actor_id: req.user.id, action: 'create_unit', entity: 'unit', entity_id: id, unit_id: id, detail: name.trim() });
      return { unit: db.prepare('SELECT * FROM units WHERE id = ?').get(id), sessionsRevoked };
    })();
    res.json({ ...result.unit, sessionsRevoked: result.sessionsRevoked });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 400, 'That unit code already exists.');
    console.error('Unit creation failed:', err);
    fail(res, 500, 'The unit could not be created. No changes were saved.');
  }
});

app.put('/api/org/units/:unitId', auth, needs(PERMISSIONS.MANAGE_UNITS, (r) => r.params.unitId), (req, res) => {
  const { name, short_name, echelon, location, parent_id, level } = req.body || {};
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  const fieldErrors = {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) fieldErrors.name = 'Required.';
  else if (name?.length > 120) fieldErrors.name = 'Too long (limit 120 characters).';
  if (short_name !== undefined && short_name !== null && (typeof short_name !== 'string' || short_name.length > 40)) fieldErrors.short_name = 'Too long (limit 40 characters).';
  if (location !== undefined && location !== null && (typeof location !== 'string' || location.length > 120)) fieldErrors.location = 'Too long (limit 120 characters).';
  if (echelon !== undefined && (typeof echelon !== 'string' || !echelon.trim() || echelon.length > 40)) fieldErrors.echelon = 'Required (limit 40 characters).';
  if (level !== undefined && !LEVELS.includes(level)) fieldErrors.level = `Choose one of ${LEVELS.join(', ')}.`;
  if (Object.keys(fieldErrors).length) return failValidation(res, fieldErrors);

  const finalParent = parent_id === undefined ? unit.parent_id : (parent_id || null);
  if (parent_id !== undefined && finalParent !== unit.parent_id) {
    const operator = isInstanceOperator(req.user) || isBootstrapOperator(db, req.user);
    if (!finalParent && !operator) {
      return fail(res, 403, 'Only the Instance Operator can detach a unit into a new top-level organization.');
    }
    if (finalParent) {
      if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(finalParent)) {
        return failValidation(res, { parent_id: 'No such active parent unit.' });
      }
      if (!operator && !can(db, req.user, PERMISSIONS.MANAGE_UNITS, finalParent)) {
        return fail(res, 403, 'You cannot move a unit under a parent you do not manage.');
      }
      if (wouldCycle(db, unit.id, finalParent)) {
        return failValidation(res, { parent_id: 'A unit cannot be placed beneath itself or one of its descendants.' });
      }
    }
  }

  db.prepare('UPDATE units SET name = ?, short_name = ?, echelon = ?, location = ?, parent_id = ?, level = ? WHERE id = ?').run(
    name === undefined ? unit.name : name.trim(),
    short_name === undefined ? unit.short_name : (short_name?.trim() || null),
    echelon === undefined ? unit.echelon : echelon.trim(),
    location === undefined ? unit.location : (location?.trim() || null),
    finalParent,
    level === undefined ? unit.level : level,
    req.params.unitId
  );
  audit({ actor_id: req.user.id, action: 'edit_unit', entity: 'unit', entity_id: req.params.unitId, unit_id: req.params.unitId });
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.unitId));
});

app.delete('/api/org/units/:unitId', auth, needs(PERMISSIONS.MANAGE_UNITS, (r) => r.params.unitId), (req, res) => {
  const children = db.prepare('SELECT COUNT(*) AS n FROM units WHERE parent_id = ? AND active = 1').get(req.params.unitId).n;
  if (children) return fail(res, 400, 'That unit still has sub-units. Move or archive those first.');
  const members = db.prepare(
    `SELECT user_id FROM unit_members
      WHERE unit_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`
  ).all(req.params.unitId);
  const ownerClosingOwnEmptyUnit = members.length === 1
    && members[0].user_id === req.user.id
    && isUnitOwner(db, req.user.id, req.params.unitId);
  if (members.length && !ownerClosingOwnEmptyUnit) {
    return fail(res, 400, 'Marines still belong to that unit. Remove or transfer the memberships first.');
  }
  db.transaction(() => {
    if (ownerClosingOwnEmptyUnit) removeMember(req.user.id, req.params.unitId);
    db.prepare('UPDATE units SET active = 0, owner_user_id = NULL WHERE id = ?').run(req.params.unitId);
  })();
  audit({ actor_id: req.user.id, action: 'archive_unit', entity: 'unit', entity_id: req.params.unitId, unit_id: req.params.unitId });
  res.json({ ok: true });
});

app.post('/api/org/units/:unitId/claim', auth, operatorGate(db), (req, res) => {
  const { owner_user_id, template_id } = req.body || {};
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(req.params.unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  if (unit.owner_user_id) return fail(res, 409, 'That unit already has an owner.', { code: 'already_owned' });
  if (template_id && !ROLE_TEMPLATES.some((t) => t.id === template_id)) {
    return failValidation(res, { template_id: 'No such role template.' });
  }
  const ownerId = owner_user_id || req.user.id;
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(ownerId)) {
    return failValidation(res, { owner_user_id: 'No such active account.' });
  }
  claimUnit(unit.id, ownerId, template_id || DEFAULT_TEMPLATE_ID);
  // An Instance Operator already has authority to claim a unit for themselves;
  // a remotely assigned owner must receive a fresh session before using it.
  const sessionsRevoked = ownerId === req.user.id ? 0 : revokePrivilegeSessions([ownerId]);
  audit({
    actor_id: req.user.id, action: 'claim_unit', entity: 'unit', entity_id: unit.id,
    subject_id: ownerId, unit_id: unit.id, detail: `operator assigned owner (${template_id || DEFAULT_TEMPLATE_ID} template)`,
  });
  res.json({ ...db.prepare('SELECT * FROM units WHERE id = ?').get(unit.id), sessionsRevoked });
});

app.post('/api/org/units/:unitId/owner', auth, (req, res) => {
  const unitId = req.params.unitId;
  const successorId = req.body?.user_id;
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  const operator = isInstanceOperator(req.user) || isBootstrapOperator(db, req.user);
  if (!operator && !isUnitOwner(db, req.user.id, unitId)) {
    return fail(res, 403, 'Only the current Unit Owner or Instance Operator can transfer ownership.');
  }
  const successor = db.prepare(
    `SELECT u.* FROM users u JOIN unit_members um ON um.user_id = u.id
      WHERE u.id = ? AND u.active = 1 AND um.unit_id = ?
        AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))`
  ).get(successorId, unitId);
  if (!successor) return failValidation(res, { user_id: 'Choose an active current member of this exact unit.' });
  if (successor.id === unit.owner_user_id) return res.json({ ok: true, already: true });

  let revokedAdminGrants = 0;
  let sessionsRevoked = 0;
  db.transaction(() => {
    db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(successor.id, unitId);
    db.prepare("UPDATE unit_members SET kind = 'member' WHERE user_id = ? AND unit_id = ?").run(unit.owner_user_id, unitId);
    db.prepare("UPDATE unit_members SET kind = 'owner', expires_at = NULL WHERE user_id = ? AND unit_id = ?").run(successor.id, unitId);
    if (unit.owner_user_id) {
      revokedAdminGrants = db.prepare(
        `DELETE FROM member_roles
          WHERE user_id = ? AND unit_id = ? AND role_id IN (
            SELECT id FROM roles WHERE unit_id = ? AND (permissions & ?) <> 0
          )`
      ).run(unit.owner_user_id, unitId, unitId, PERMISSIONS.ADMINISTRATOR).changes;
    }
    // A current Instance Operator retains instance-wide authority after handing
    // off one unit; other former owners and every successor must reauthenticate.
    sessionsRevoked = revokePrivilegeSessions([
      successor.id,
      ...(operator && unit.owner_user_id === req.user.id ? [] : [unit.owner_user_id]),
    ]);
  })();
  audit({
    actor_id: req.user.id, action: 'transfer_ownership', entity: 'unit', entity_id: unitId,
    subject_id: successor.id, unit_id: unitId,
    detail: `${unit.owner_user_id || 'unowned'} → ${successor.id}; former-owner administrator grants revoked: ${revokedAdminGrants}; sessions revoked: ${sessionsRevoked}`,
  });
  res.json({ ok: true, unit_id: unitId, owner_user_id: successor.id, revokedAdminGrants, sessionsRevoked });
});

app.post('/api/org/units/:unitId/members', auth, (req, res) => {
  const { user_id, kind = 'member', role_id, expires_at } = req.body || {};
  const unitId = req.params.unitId;
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  if (!['member', 'guest'].includes(kind)) {
    return failValidation(res, { kind: 'Membership is member or guest. Ownership transfers separately.' });
  }
  if (kind === 'guest' && !expires_at) {

    return failValidation(res, { expires_at: 'A guest membership needs an expiry date.' });
  }
  if (kind === 'guest' && (!Number.isFinite(Date.parse(expires_at)) || Date.parse(expires_at) <= Date.now())) {
    return failValidation(res, { expires_at: 'Choose a valid future expiry date.' });
  }
  const maxGuestDays = config.limits.max_guest_days;
  const expiryMs = kind === 'guest' ? Date.parse(expires_at) : null;
  if (kind === 'guest' && expiryMs > Date.now() + maxGuestDays * 86_400_000) {
    return failValidation(res, { expires_at: `Guest access is limited to ${maxGuestDays} days per approval.` });
  }
  const effectiveExpiry = kind === 'guest' ? new Date(expiryMs).toISOString() : null;
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(user_id);
  if (!target) return failValidation(res, { user_id: 'No such active account.' });
  if (user_id === req.user.id) {
    return fail(res, 403, 'A second authorized person must change your unit membership or guest expiry.', {
      code: 'self_membership_change',
    });
  }

  if (!isUnitOwner(db, req.user.id, unitId) && !can(db, req.user, PERMISSIONS.MANAGE_MEMBERS, unitId)) {
    return fail(res, 403, 'You cannot add members to that unit.');
  }

  let role = null;
  if (role_id) {
    role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);
    if (!role) return failValidation(res, { role_id: 'No such role.' });
    if (role.unit_id !== unitId) {
      return fail(res, 403, 'That role belongs to another unit.', { code: 'scope' });
    }
  } else {
    role = db.prepare('SELECT * FROM roles WHERE unit_id = ? AND is_default = 1 LIMIT 1').get(unitId) || null;
  }

  let sessionsRevoked = 0;
  db.transaction(() => {
    addMember(user_id, unitId, { kind, invitedBy: req.user.id, expiresAt: effectiveExpiry });

    if (kind === 'member' && !primaryAssignment(db, user_id)) {
      db.prepare(
        `INSERT INTO assignments (id, user_id, unit_id, role, is_primary, start_date, created_at)
         VALUES (?, ?, ?, '', 1, ?, ?)`
      ).run(newId(), user_id, unitId, now().slice(0, 10), now());
    }
    if (role) {
      const verdict = validateRoleGrant(db, req.user, role, unitId, target);
      if (!verdict.ok) throw Object.assign(new Error(verdict.message), { verdict });
      grantRole(user_id, role.id, unitId, req.user.id);
    }
    sessionsRevoked = revokePrivilegeSessions([user_id]);
  })();

  audit({
    actor_id: req.user.id, action: 'add_member', entity: 'unit', entity_id: unitId,
    subject_id: user_id, unit_id: unitId,
    detail: `${kind}${effectiveExpiry ? ` until ${effectiveExpiry}` : ''}${role ? ` as ${role.name}` : ''}; sessions revoked: ${sessionsRevoked}`,
  });
  res.json({ ok: true, unit_id: unitId, user_id, kind, expires_at: effectiveExpiry, sessionsRevoked });
});

app.delete('/api/org/units/:unitId/members/:userId', auth, (req, res) => {
  const { unitId, userId } = req.params;
  if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) return fail(res, 404, 'No such unit.');
  if (!db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) {
    return fail(res, 404, 'That Marine is not a member of this unit.');
  }
  if (!isUnitOwner(db, req.user.id, unitId) && !can(db, req.user, PERMISSIONS.MANAGE_MEMBERS, unitId)) {
    return fail(res, 403, 'You cannot remove members from that unit.');
  }

  if (isUnitOwner(db, userId, unitId)) {
    return fail(res, 400, 'That Marine owns this unit. Transfer ownership before removing them.', { code: 'last_owner' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (userId !== req.user.id && !isUnitOwner(db, req.user.id, unitId)
      && positionIn(db, target, unitId) >= positionIn(db, req.user, unitId)) {
    return fail(res, 403, 'You cannot remove a Marine whose role is at or above your own.', { code: 'hierarchy' });
  }
  const removed = removeMember(userId, unitId);

  const sessionsRevoked = revokePrivilegeSessions([userId]);
  audit({
    actor_id: req.user.id, action: 'remove_member', entity: 'unit', entity_id: unitId,
    subject_id: userId, unit_id: unitId,
    detail: `roles: ${removed.roles}; assignments ended: ${removed.assignments}; records frozen: ${removed.recordsFrozen}; sessions revoked: ${sessionsRevoked}`,
  });
  res.json({ ok: true, ...removed, sessionsRevoked });
});

app.get('/api/roles', auth, (req, res) => {
  const mine = memberUnitIds(db, req.user.id);
  const roles = mine.length
    ? db.prepare(`SELECT * FROM roles WHERE unit_id IN (${mine.map(() => '?').join(',')}) ORDER BY position DESC, name`).all(...mine)
    : [];
  const { topPosition, positions } = permissionMap(db, req.user);
  res.json({
    roles: roles.map((r) => ({
      ...r,
      manageable: canManageRole(db, req.user, r),
      editable: canManageRoleDefinition(db, req.user, r),
    })),
    topPosition,
    positions: Object.fromEntries(positions),
    templates: templateSummaries(),
    catalogue: PERMISSION_LIST.map((p) => ({ ...p, bit: PERMISSIONS[p.key] })),
  });
});

const roleDenyStatus = (code) => (['invalid', 'system_role'].includes(code) ? 400 : (code === 'not_found' ? 404 : 403));

app.post('/api/roles', auth, (req, res) => {
  const { name, description, color, position, permissions, unit_id } = req.body || {};
  if (color && (typeof color !== 'string' || color.length > 20)) return failValidation(res, { color: 'Not a color.' });

  const def = {
    name,
    description,
    position: position === undefined ? 0 : Number(position),
    permissions: Number(permissions) || 0,
    unit_id: unit_id || null,
  };
  const verdict = validateRoleDefinition(db, req.user, def);
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${newId().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO roles (id, unit_id, name, description, color, position, permissions, is_default, is_system, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(id, def.unit_id, name, description || null, color || '#8D98A8', def.position, def.permissions, now());
  audit({ actor_id: req.user.id, action: 'create_role', entity: 'role', entity_id: id, unit_id: def.unit_id, detail: name });
  res.json(db.prepare('SELECT * FROM roles WHERE id = ?').get(id));
});

app.put('/api/roles/:roleId', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');

  const { name, description, color, position, permissions, unit_id } = req.body || {};
  if (color && (typeof color !== 'string' || color.length > 20)) return failValidation(res, { color: 'Not a color.' });

  const def = {
    name: name ?? role.name,
    description: description ?? role.description,
    position: position === undefined ? role.position : Number(position),
    permissions: permissions === undefined ? role.permissions : Number(permissions),

    unit_id: unit_id === undefined ? role.unit_id : (unit_id || null),
  };
  const verdict = validateRoleDefinition(db, req.user, def, { existing: role });
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  let sessionsRevoked = 0;
  db.transaction(() => {
    db.prepare(
      'UPDATE roles SET name = ?, description = ?, color = ?, position = ?, permissions = ? WHERE id = ?'
    ).run(def.name, def.description, color ?? role.color, def.position, def.permissions, req.params.roleId);
    const holders = db.prepare('SELECT DISTINCT user_id FROM member_roles WHERE role_id = ?').all(req.params.roleId);
    sessionsRevoked = revokePrivilegeSessions(holders.map((holder) => holder.user_id));
  })();
  audit({ actor_id: req.user.id, action: 'edit_role', entity: 'role', entity_id: req.params.roleId, unit_id: def.unit_id, detail: `sessions revoked: ${sessionsRevoked}` });
  res.json({ ...db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId), sessionsRevoked });
});

app.delete('/api/roles/:roleId', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');

  if (!canManageRoleDefinition(db, req.user, role)) {
    return fail(res, 403, 'That role belongs to a unit outside your authority.');
  }

  if (role.unit_id && isUnitOwner(db, req.user.id, role.unit_id) === false && (role.permissions & PERMISSIONS.ADMINISTRATOR)) {
    return fail(res, 403, 'Only the unit owner can delete an administrator role.');
  }
  let sessionsRevoked = 0;
  db.transaction(() => {
    const holders = db.prepare('SELECT DISTINCT user_id FROM member_roles WHERE role_id = ? AND unit_id = ?').all(req.params.roleId, role.unit_id);
    db.prepare('DELETE FROM member_roles WHERE role_id = ? AND unit_id = ?').run(req.params.roleId, role.unit_id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.roleId);
    sessionsRevoked = revokePrivilegeSessions(holders.map((holder) => holder.user_id));
  })();
  audit({ actor_id: req.user.id, action: 'delete_role', entity: 'role', entity_id: req.params.roleId, unit_id: role.unit_id, detail: `${role.name}; sessions revoked: ${sessionsRevoked}` });
  res.json({ ok: true, sessionsRevoked });
});

app.post('/api/team/:id/roles', auth, (req, res) => {
  const { role_id, unit_id } = req.body || {};
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) return fail(res, 404, 'No such Marine.');

  const verdict = validateRoleGrant(db, req.user, role, unit_id, targetUser);
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  grantRole(req.params.id, role_id, unit_id, req.user.id);
  const sessionsRevoked = revokePrivilegeSessions([req.params.id]);
  audit({
    actor_id: req.user.id, action: 'grant_role', entity: 'role', entity_id: role_id,
    subject_id: req.params.id, unit_id, detail: `${role.name} @ ${unit_id}; sessions revoked: ${sessionsRevoked}`,
  });
  res.json({ ok: true, sessionsRevoked });
});

app.delete('/api/team/:id/roles/:roleId', auth, (req, res) => {
  const { unit_id } = req.query;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');
  if (!unit_id) return fail(res, 400, 'A unit is required.');
  if (role.unit_id !== unit_id) return fail(res, 403, 'That role belongs to another unit.', { code: 'scope' });
  if (!isUnitOwner(db, req.user.id, unit_id)) {
    if (!can(db, req.user, PERMISSIONS.MANAGE_ROLES, unit_id)) return fail(res, 403, 'You cannot manage roles there.');
    if (!canManageRole(db, req.user, role)) return fail(res, 403, 'That role is at or above your own.');
  }
  if (!db.prepare('SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = ? AND unit_id = ?').get(req.params.id, req.params.roleId, unit_id)) {
    return fail(res, 404, 'That Marine does not hold that role in this unit.');
  }
  revokeRole(req.params.id, req.params.roleId, unit_id);
  const sessionsRevoked = revokePrivilegeSessions([req.params.id]);
  audit({
    actor_id: req.user.id, action: 'revoke_role', entity: 'role', entity_id: req.params.roleId,
    subject_id: req.params.id, unit_id,
  });
  res.json({ ok: true, sessionsRevoked });
});

app.post('/api/org/billets', auth, operatorGate(db), (req, res) => {
  const { title, category, echelon, default_role } = req.body || {};
  if (!title) return fail(res, 400, 'A billet needs a title.');
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    db.prepare('INSERT INTO billets (id, title, category, echelon, default_role) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, category || 'Staff', echelon || 'section', default_role || 'member');
    audit({ actor_id: req.user.id, action: 'create_billet', entity: 'billet', entity_id: id, detail: title });
    res.json(db.prepare('SELECT * FROM billets WHERE id = ?').get(id));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 400, 'That billet already exists.');
    console.error('Billet creation failed:', err);
    fail(res, 500, 'The billet could not be created.');
  }
});

app.get('/api/directory', auth, (req, res) => {
  const unitId = String(req.query.unit_id || '');
  const query = normalizeUsername(req.query.q).slice(0, 40);
  if (!unitId) return fail(res, 400, 'A destination unit is required.');
  if (!isUnitOwner(db, req.user.id, unitId) && !can(db, req.user, PERMISSIONS.MANAGE_MEMBERS, unitId)) {
    return fail(res, 403, 'You cannot enroll members in that unit.');
  }
  if (query.length < 2) return failValidation(res, { q: 'Enter at least two characters.' });
  const escaped = query.replace(/[\\%_]/g, '\\$&');
  const pattern = `${escaped}%`;
  const rows = db.prepare(
    `SELECT u.id, u.username, u.first_name, u.last_name, r.abbr AS rank_abbr
       FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE u.active = 1
        AND (u.username LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE)
        AND NOT EXISTS (
          SELECT 1 FROM unit_members um WHERE um.user_id = u.id AND um.unit_id = ?
            AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))
        )
      ORDER BY CASE WHEN u.username = ? COLLATE NOCASE THEN 0 ELSE 1 END, u.last_name, u.first_name
      LIMIT 10`
  ).all(pattern, pattern, unitId, query);
  audit({ actor_id: req.user.id, action: 'directory_search', entity: 'user', unit_id: unitId, detail: `${rows.length} result(s)` });
  res.json({ results: rows });
});

const rosterQuery = `
  SELECT u.id, u.username, u.first_name, u.last_name, u.middle_initial, u.rank_id, u.mos, u.email, u.eas,
         u.is_admin, u.active,
         r.abbr AS rank_abbr, r.name AS rank_name, r.grade AS rank_grade, r.tier AS rank_tier, r.sort AS rank_sort,
         a.role, a.is_primary, a.unit_id, a.billet_id, a.start_date,
         b.title AS billet_title, b.category AS billet_category,
         un.name AS unit_name, un.short_name AS unit_short, un.code AS unit_code, un.echelon AS unit_echelon
    FROM users u
    LEFT JOIN assignments a ON a.user_id = u.id AND a.is_primary = 1
    LEFT JOIN units un ON un.id = a.unit_id
    LEFT JOIN billets b ON b.id = a.billet_id
    LEFT JOIN ranks r ON r.id = u.rank_id
   WHERE u.active = 1 AND u.id IN (%IDS%)
   ORDER BY r.sort DESC, u.last_name`;

const rolesForUsers = (ids, allowedUnitIds) => {
  if (!ids.length || !allowedUnitIds.length) return new Map();
  const rows = db
    .prepare(
      `SELECT mr.user_id, mr.unit_id, r.id, r.name, r.color, r.position, r.permissions
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id IN (${ids.map(() => '?').join(',')})
          AND r.unit_id = mr.unit_id
          AND mr.unit_id IN (${allowedUnitIds.map(() => '?').join(',')})
        ORDER BY r.position DESC`
    )
    .all(...ids, ...allowedUnitIds);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.user_id)) map.set(row.user_id, []);
    map.get(row.user_id).push(row);
  }
  return map;
};

app.get('/api/team', auth, (req, res) => {
  const ids = visibleUserIds(db, req.user);
  const rows = db.prepare(rosterQuery.replace('%IDS%', ids.map(() => '?').join(','))).all(...ids);
  const scope = resolveScope(db, req.user);
  const allowedUnits = scope.scopeUnitIds;
  const allowedSet = new Set(allowedUnits);
  const sharedAssignment = allowedUnits.length
    ? db.prepare(
      `SELECT um.unit_id, u.name AS unit_name, u.short_name AS unit_short,
              u.code AS unit_code, u.echelon AS unit_echelon,
              a.is_primary, a.start_date, b.title AS billet_title, b.category AS billet_category
         FROM unit_members um JOIN units u ON u.id = um.unit_id
         LEFT JOIN assignments a ON a.user_id = um.user_id AND a.unit_id = um.unit_id
           AND (a.end_date IS NULL OR a.end_date > date('now'))
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE um.user_id = ? AND um.unit_id IN (${allowedUnits.map(() => '?').join(',')})
          AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))
        ORDER BY a.is_primary DESC, a.start_date DESC LIMIT 1`
    )
    : null;
  const roleMap = rolesForUsers(ids, allowedUnits);
  for (const row of rows) {
    row.roles = roleMap.get(row.id) || [];
    if (row.id === req.user.id) continue;
    if (!row.unit_id || !allowedSet.has(row.unit_id)) {
      const shared = sharedAssignment?.get(row.id, ...allowedUnits) || null;
      for (const key of [
        'role', 'is_primary', 'unit_id', 'start_date', 'billet_title', 'billet_category',
        'unit_name', 'unit_short', 'unit_code', 'unit_echelon',
      ]) row[key] = shared?.[key] ?? null;
    }

    row.username = null;
    row.email = null;
    row.eas = null;
    row.is_admin = null;
  }
  if (rows.length > 1) {
    audit({ actor_id: req.user.id, action: 'view_roster', detail: `${rows.length} personnel` });
  }
  res.json({
    roster: rows,
    canLead: scope.canLead,
    scopeUnitIds: scope.scopeUnitIds,
    canManageMembers: unitsWith(db, req.user, PERMISSIONS.MANAGE_MEMBERS),
    canManageRoles: unitsWith(db, req.user, PERMISSIONS.MANAGE_ROLES),
    canManageUnits: unitsWith(db, req.user, PERMISSIONS.MANAGE_UNITS),
    canCreateAccounts: isInstanceOperator(req.user) || isBootstrapOperator(db, req.user),
  });
});

const memberDetailUnitIds = (actor, targetId) =>
  memberUnitIds(db, targetId)
    .filter((unitId) => can(db, actor, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId))

    .filter((unitId) => positionIn(db, actor, unitId) > positionIn(db, { id: targetId }, unitId));

app.get('/api/team/:id', auth, (req, res) => {
  const isSelf = req.params.id === req.user.id;
  const detailUnits = isSelf ? memberUnitIds(db, req.user.id) : memberDetailUnitIds(req.user, req.params.id);
  if (!isSelf && !detailUnits.length) {
    return fail(res, 403, 'You can see this Marine on a roster but cannot open their record in any shared unit.');
  }

  const person = db.prepare(rosterQuery.replace('%IDS%', '?')).get(req.params.id);
  if (!person) return fail(res, 404, 'No such Marine.');

  if (!isSelf && person.unit_id && !detailUnits.includes(person.unit_id)) {
    for (const key of [
      'role', 'is_primary', 'unit_id', 'start_date', 'billet_title', 'billet_category',
      'unit_name', 'unit_short', 'unit_code', 'unit_echelon',
    ]) person[key] = null;
  }

  const scoped = (table) => {
    const unitClause = isSelf
      ? ''
      : `AND visibility = 'unit' AND unit_id IN (${detailUnits.map(() => '?').join(',')})`;
    return db
      .prepare(
        `SELECT * FROM ${table}
          WHERE user_id = ? AND deleted_at IS NULL ${unitClause}
          ORDER BY date DESC`
      )
      .all(req.params.id, ...(isSelf ? [] : detailUnits));
  };

  if (req.params.id !== req.user.id) {
    audit({
      actor_id: req.user.id, action: 'view_member', entity: 'user',
      entity_id: req.params.id, subject_id: req.params.id, unit_id: detailUnits[0] || null,
    });
  }

  let memberGoals;
  if (isSelf) {
    const mine = memberUnitIds(db, req.user.id);
    const assigned = mine.length
      ? `OR (assignee_id = ? AND visibility = 'unit' AND unit_id IN (${mine.map(() => '?').join(',')}))`
      : '';
    memberGoals = db.prepare(
      `SELECT * FROM goals WHERE deleted_at IS NULL AND (user_id = ? ${assigned})`
    ).all(req.params.id, ...(mine.length ? [req.params.id, ...mine] : []));
  } else {
    memberGoals = db.prepare(
      `SELECT * FROM goals
        WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL
          AND visibility = 'unit' AND unit_id IN (${detailUnits.map(() => '?').join(',')})`
    ).all(req.params.id, req.params.id, ...detailUnits);
  }

  res.json({
    person,
    roles: db.prepare(
      `SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id = ?
          AND r.unit_id = mr.unit_id
          ${isSelf ? '' : `AND mr.unit_id IN (${detailUnits.map(() => '?').join(',')})`}
        ORDER BY r.position DESC`
    ).all(req.params.id, ...(isSelf ? [] : detailUnits)),
    assignments: db.prepare(
      `SELECT a.*, u.name AS unit_name, u.short_name AS unit_short, b.title AS billet_title
         FROM assignments a JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ?
          ${isSelf ? '' : `AND a.unit_id IN (${detailUnits.map(() => '?').join(',')})`}`
    ).all(req.params.id, ...(isSelf ? [] : detailUnits)),
    memberships: db.prepare(
      `SELECT um.unit_id, um.kind, um.joined_at, um.expires_at,
              u.name AS unit_name, u.short_name AS unit_short
         FROM unit_members um JOIN units u ON u.id = um.unit_id
        WHERE um.user_id = ? AND u.active = 1
          AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))
          ${isSelf ? '' : `AND um.unit_id IN (${detailUnits.map(() => '?').join(',')})`}
        ORDER BY um.joined_at`
    ).all(req.params.id, ...(isSelf ? [] : detailUnits)),
    activities: scoped('activities').map((r) => hydrate(r, TABLES.activities)),
    recognitions: scoped('recognitions'),
    trainings: scoped('trainings'),
    goals: memberGoals,
  });
});

app.post('/api/team', auth, operatorGate(db), (req, res) => {
  const body = req.body || {};
  const { username, password, first_name, last_name, middle_initial, rank_id, mos, email, eas,
    unit_id, billet_id, role, role_id } = body;

  const errors = validate(USER_SCHEMA, body) || { fieldErrors: {} };
  const fieldErrors = errors.fieldErrors;
  if (!unit_id) fieldErrors.unit_id = 'Required.';
  else if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unit_id)) fieldErrors.unit_id = 'No such unit.';
  if (rank_id && !db.prepare('SELECT 1 FROM ranks WHERE id = ?').get(rank_id)) fieldErrors.rank_id = 'No such rank.';
  if (billet_id && !db.prepare('SELECT 1 FROM billets WHERE id = ?').get(billet_id)) fieldErrors.billet_id = 'No such billet.';
  if (Object.keys(fieldErrors).length) return failValidation(res, fieldErrors);

  if (!can(db, req.user, PERMISSIONS.MANAGE_MEMBERS, unit_id)) {
    return fail(res, 403, 'You cannot add Marines to that unit.');
  }

  let extraRole = null;
  if (role_id) {
    extraRole = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);

    const verdict = validateRoleGrant(db, req.user, extraRole, unit_id);
    if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });
  }

  try {
    const id = newId();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, last_name, first_name, middle_initial, rank_id, mos, email, eas,
                           must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, normalizeUsername(username), hashPassword(password), last_name, first_name, middle_initial || null,
        rank_id || null, mos || null, email || null, eas || null,
        process.env.VANTAGE_TEST === '1' ? 0 : 1, now(), now());

      db.prepare(
        `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
         VALUES (?, ?, ?, ?, '', 1, ?, ?)`
      ).run(newId(), id, unit_id, billet_id || null, now().slice(0, 10), now());

      addMember(id, unit_id, { kind: 'member', invitedBy: req.user.id });

      const defaultRole = db.prepare('SELECT id FROM roles WHERE is_default = 1 AND unit_id = ? LIMIT 1').get(unit_id);
      if (defaultRole) grantRole(id, defaultRole.id, unit_id, req.user.id);
      if (extraRole) grantRole(id, extraRole.id, unit_id, req.user.id);
    })();

    audit({ actor_id: req.user.id, action: 'create_member', entity: 'user', entity_id: id, subject_id: id, unit_id });
    res.json({ id });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 400, 'That username is taken.');
    console.error('Member creation failed:', err);
    fail(res, 500, 'The account could not be created. No changes were saved.');
  }
});

app.put('/api/team/:id/profile', auth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.params.id);
  const plan = prepareMemberProfile(req.user, target, req.body);
  if (!plan.ok) {
    if (plan.fieldErrors) return failValidation(res, plan.fieldErrors);
    return fail(res, plan.status || 400, plan.message);
  }
  const updatedAt = now();
  const changed = db.transaction(() => {
    const fields = applyMemberProfile(req.user, target, plan.changes, updatedAt);
    if (fields.length) {
      audit({
        actor_id: req.user.id, action: 'edit_member_profile', entity: 'user', entity_id: target.id,
        subject_id: target.id, unit_id: plan.authority.unitId,
        detail: fields.join(', '),
      });
    }
    return fields;
  })();
  res.json({ ok: true, changed });
});

app.put('/api/team/:id/manage', auth, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.params.id);
  const plan = prepareMemberProfile(req.user, target, req.body);
  if (!plan.ok) {
    if (plan.fieldErrors) return failValidation(res, plan.fieldErrors);
    return fail(res, plan.status || 400, plan.message);
  }
  const unitId = String(req.body?.unit_id || '');
  const roleId = String(req.body?.role_id || '');
  const role = roleId ? db.prepare('SELECT * FROM roles WHERE id = ?').get(roleId) : null;
  if (roleId) {
    const verdict = validateRoleGrant(db, req.user, role, unitId);
    if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });
  }

  try {
    const result = db.transaction(() => {
      const assignment = transferMember(db, req.user, target.id, req.body || {}, { currentToken: req.token });
      if (!assignment.ok) return { denied: assignment };
      let roleSessionsRevoked = 0;
      if (role) {
        const verdict = validateRoleGrant(db, req.user, role, unitId, target);
        if (!verdict.ok) throw Object.assign(new Error(verdict.message), { verdict });
        grantRole(target.id, role.id, unitId, req.user.id);
        roleSessionsRevoked = revokePrivilegeSessions([target.id]);
        assignment.sessionsRevoked += roleSessionsRevoked;
        audit({
          actor_id: req.user.id, action: 'grant_role', entity: 'role', entity_id: role.id,
          subject_id: target.id, unit_id: unitId, detail: `${role.name} @ ${unitId}; sessions revoked: ${roleSessionsRevoked}`,
        });
      }
      const changed = applyMemberProfile(req.user, target, plan.changes);
      if (changed.length) {
        audit({
          actor_id: req.user.id, action: 'edit_member_profile', entity: 'user', entity_id: target.id,
          subject_id: target.id, unit_id: unitId, detail: changed.join(', '),
        });
      }
      return { assignment, changed, sessionsRevoked: assignment.sessionsRevoked };
    })();
    if (result.denied) return denyResult(res, result.denied);
    res.json({ ok: true, ...result });
  } catch (error) {
    if (error.verdict) {
      return fail(res, roleDenyStatus(error.verdict.code), error.verdict.message, { code: error.verdict.code });
    }
    throw error;
  }
});

app.put('/api/team/:id/assignment', auth, (req, res) => {
  const result = transferMember(db, req.user, req.params.id, req.body || {}, { currentToken: req.token });
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/deactivate', auth, operatorGate(db), (req, res) => {
  const result = deactivateMember(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/reactivate', auth, operatorGate(db), (req, res) => {
  const result = reactivateMember(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/password', auth, operatorGate(db), (req, res) => {
  const err = USER_SCHEMA.password(req.body?.password);
  if (err) return failValidation(res, { password: err });
  const result = resetMemberPassword(db, req.user, req.params.id, req.body.password);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/logout', auth, operatorGate(db), (req, res) => {
  const result = forceLogout(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

const metaGet = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value || null;
const metaSet = (key, value) => db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, String(value));

app.get('/api/admin/db', auth, operatorHostGate, operatorGate(db), (req, res) => {
  let sizeBytes = null;
  try { sizeBytes = statSync(db.name).size; } catch {}
  res.json({
    sizeBytes,
    path: db.name,
    schemaVersion: Number(metaGet('schema_version') || 0),
    lastBackupAt: metaGet('last_backup_at'),
  });
});

app.get('/api/admin/backup', auth, operatorHostGate, operatorGate(db), async (req, res) => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const dest = join(tmpdir(), `vantage-backup-${stamp}-${newId().slice(0, 6)}.db`);
  try {
    await db.backup(dest);
    chmodSync(dest, 0o600);
    metaSet('last_backup_at', now());
    const backupBytes = statSync(dest).size;
    db.transaction(() => {
      audit({ actor_id: req.user.id, action: 'backup', entity: 'database', detail: `backup downloaded (${backupBytes} bytes)` });
      for (const unit of db.prepare('SELECT id FROM units WHERE active = 1').all()) {
        audit({
          actor_id: req.user.id, action: 'backup_included', entity: 'database', unit_id: unit.id,
          detail: `complete instance backup included this unit (${backupBytes} bytes total)`,
        });
      }
    })();
    res.download(dest, `vantage-backup-${stamp}.db`, () => {
      try { unlinkSync(dest); } catch {}
    });
  } catch (err) {
    try { unlinkSync(dest); } catch {}
    console.error('Database backup failed:', err);
    fail(res, 500, 'The database backup could not be created.');
  }
});

app.get('/api/team/:id/access', auth, operatorGate(db), (req, res) => {
  const result = accessReview(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.get('/api/prefs', auth, (req, res) => {
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(req.user.id);
  let prefs = {};
  try { prefs = row?.prefs ? JSON.parse(row.prefs) : {}; } catch { prefs = {}; }
  res.json(prefs);
});

app.put('/api/prefs', auth, (req, res) => {
  const patch = req.body || {};
  if (typeof patch !== 'object' || Array.isArray(patch)) return fail(res, 400, 'Preferences must be an object.');
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(req.user.id);
  let prefs = {};
  try { prefs = row?.prefs ? JSON.parse(row.prefs) : {}; } catch { prefs = {}; }
  const merged = { ...prefs, ...patch };
  const serialized = JSON.stringify(merged);
  if (serialized.length > 32_768) return fail(res, 400, 'Preferences are too large.');
  db.prepare('UPDATE users SET prefs = ?, updated_at = ? WHERE id = ?').run(serialized, now(), req.user.id);
  res.json(merged);
});

const READINESS_FIELDS = [
  'pft_score', 'cft_score', 'rifle_score', 'rifle_qual', 'mcmap_belt',
  'ceus', 'college_credits', 'degree', 'pme_complete',
  'cmd_character', 'cmd_mos', 'cmd_leadership',
];

app.get('/api/readiness', auth, (req, res) => {
  const row = db
    .prepare(
      `SELECT u.${READINESS_FIELDS.join(', u.')}, r.grade AS rank_grade, r.abbr AS rank_abbr
         FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE u.id = ?`
    )
    .get(req.user.id);
  res.json(row || {});
});

app.put('/api/readiness', auth, (req, res) => {
  const body = req.body || {};

  const errors = validate(READINESS_SCHEMA, body, { partial: true });
  if (errors) return failValidation(res, errors.fieldErrors);
  const sets = [];
  const vals = [];
  for (const f of READINESS_FIELDS) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(body[f] === '' ? null : body[f]);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(now(), req.user.id);
  db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.get('/api/readiness/:id', auth, (req, res) => {
  const isSelf = req.params.id === req.user.id;
  const detailUnits = isSelf ? memberUnitIds(db, req.user.id) : memberDetailUnitIds(req.user, req.params.id);
  if (!isSelf && !detailUnits.length) {
    return fail(res, 403, 'You cannot open that record.');
  }
  if (!isSelf) {
    audit({
      actor_id: req.user.id, action: 'view_readiness', entity: 'user',
      entity_id: req.params.id, subject_id: req.params.id, unit_id: detailUnits[0] || null,
    });
  }
  const row = db
    .prepare(
      `SELECT u.${READINESS_FIELDS.join(', u.')}, r.grade AS rank_grade, r.abbr AS rank_abbr
         FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`
    )
    .get(req.params.id);
  res.json(row || {});
});

app.get('/api/audit', auth, (req, res) => {

  const rows = db.prepare(
    `SELECT al.*, u.first_name, u.last_name, r.abbr AS rank_abbr
       FROM audit_log al JOIN users u ON u.id = al.actor_id
       LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE al.subject_id = ? ORDER BY al.at DESC LIMIT 100`
  ).all(req.user.id);
  res.json(rows);
});

app.get('/api/audit/unit', auth, (req, res) => {
  const unitId = req.query.unit_id;
  if (!unitId) return fail(res, 400, 'A unit is required.');
  if (!db.prepare('SELECT 1 FROM units WHERE id = ?').get(unitId)) return fail(res, 404, 'No such unit.');
  if (!can(db, req.user, PERMISSIONS.VIEW_AUDIT, unitId)) {
    return fail(res, 403, 'You cannot read the access log for that unit.');
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
  const rows = db.prepare(
    `SELECT al.*, act.first_name AS actor_first, act.last_name AS actor_last, ar.abbr AS actor_rank,
            sub.first_name AS subject_first, sub.last_name AS subject_last
       FROM audit_log al
       JOIN users act ON act.id = al.actor_id
       LEFT JOIN ranks ar ON ar.id = act.rank_id
       LEFT JOIN users sub ON sub.id = al.subject_id
      WHERE al.unit_id = ? ORDER BY al.at DESC LIMIT ?`
  ).all(unitId, limit);
  res.json({ unit_id: unitId, rows });
});

app.get('/api/export', auth, (req, res) => {
  const unitId = req.query.unit_id;
  if (!unitId) return fail(res, 400, 'A unit is required.');
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  if (!can(db, req.user, PERMISSIONS.EXPORT_DATA, unitId)) {
    return fail(res, 403, 'You cannot export that unit.');
  }

  const units = [unitId];
  const uph = '?';
  const members = db
    .prepare(
      `SELECT DISTINCT u.id, u.username, u.first_name, u.last_name, u.mos, u.eas, u.active,
              r.abbr AS rank_abbr, um.unit_id
         FROM users u JOIN unit_members um ON um.user_id = u.id
         LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE um.unit_id IN (${uph}) AND u.active = 1
          AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))`
    )
    .all(...units);
  const memberIds = members.map((m) => m.id);

  const out = { unit: { id: unit.id, name: unit.name }, generated_at: now(), members };
  for (const [table, spec] of Object.entries(TABLES)) {

    out[table] = db
      .prepare(
        `SELECT * FROM ${table}
          WHERE deleted_at IS NULL
            AND visibility NOT IN ('private', 'personal')
            AND unit_id IN (${uph})
          ORDER BY created_at DESC`
      )
      .all(...units)
      .map((r) => hydrate(r, spec));
  }

  audit({
    actor_id: req.user.id, action: 'export', entity: 'unit', entity_id: unitId, unit_id: unitId,
    detail: `${members.length} members, ${Object.keys(TABLES).map((t) => `${out[t].length} ${t}`).join(', ')}`,
  });
  res.json(out);
});

for (const [table, spec] of Object.entries(TABLES)) {
  app.get(`/api/${table}`, auth, (req, res) => {
    const { clause, params } = visibilityClause(db, req.user, {
      table: 't',
      unitMemberReadable: spec.memberReadable === true,
    });
    const rows = db
      .prepare(`SELECT t.* FROM ${table} t WHERE t.deleted_at IS NULL AND ${clause} ORDER BY t.created_at DESC`)
      .all(...params);
    auditForeignListReads(req.user, table, rows);
    res.json(rows.map((r) => hydrate(r, spec)));
  });

  app.post(`/api/${table}`, auth, (req, res) => {
    const body = req.body || {};
    const capacity = recordCapacityProblem(req.user.id);
    if (capacity) return fail(res, 507, capacity, { code: 'record_quota' });

    const errors = validate(RECORD_SCHEMAS[table], body);
    if (errors) return failValidation(res, errors.fieldErrors);

    const scope = resolveScope(db, req.user);

    const fallbackUnit = scope.assignments.find((a) => a.is_primary)?.unit_id || scope.unitIds[0] || null;
    const visibility = body.visibility || (fallbackUnit ? spec.defaultVisibility : 'personal');

    const unitId = visibility === 'personal'
      ? null
      : (body.unit_id || fallbackUnit);

    if (!VISIBILITIES.includes(visibility)) return fail(res, 400, 'Unknown visibility.');
    if (visibility !== 'personal' && !unitId) {
      return failValidation(res, { unit_id: 'Private and unit-shared records must belong to a unit.' });
    }
    if (visibility !== 'private' && !canShareTo(db, req.user, visibility, unitId, spec.shareFlag)) {
      return fail(res, 403, 'You cannot share to that unit.');
    }
    if (visibility !== 'personal' && body.unit_id && !unitAllowedForRecord(req.user, body.unit_id, spec.shareFlag)) {
      return fail(res, 403, 'You are not assigned to that unit and hold no permission there.', {
        code: 'forbidden', fieldErrors: { unit_id: 'Not your unit.' },
      });
    }
    if ('assignee_id' in RECORD_SCHEMAS[table]) {
      const err = assigneeError(req.user, body.assignee_id, unitId);
      if (err) return failValidation(res, { assignee_id: err });
    }

    const id = newId();
    const cols = ['id', 'user_id', 'created_at', 'updated_at'];
    const vals = [id, req.user.id, now(), now()];
    for (const f of spec.fields) {
      if (f === 'unit_id') { cols.push(f); vals.push(unitId); continue; }
      if (f === 'visibility') { cols.push(f); vals.push(visibility); continue; }
      if (body[f] === undefined) continue;
      cols.push(f);
      vals.push(spec.json.includes(f) ? JSON.stringify(body[f] ?? []) : body[f]);
    }
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
    audit({ actor_id: req.user.id, action: 'create', entity: table, entity_id: id, unit_id: unitId });
    res.json(hydrate(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id), spec));
  });

  app.put(`/api/${table}/:id`, auth, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
    if (!row) return fail(res, 404, 'No such record.');
    if (!canEdit(db, req.user, row)) return fail(res, 403, 'That record is not yours to edit.');

    const body = req.body || {};
    const errors = validate(RECORD_SCHEMAS[table], body, { partial: true });
    if (errors) return failValidation(res, errors.fieldErrors);

    const finalVisibility = body.visibility !== undefined ? body.visibility : row.visibility;
    if (!VISIBILITIES.includes(finalVisibility)) return failValidation(res, { visibility: 'Unknown visibility.' });
    const requestedUnit = body.unit_id !== undefined ? body.unit_id : row.unit_id;
    const finalUnit = finalVisibility === 'personal' ? null : requestedUnit;
    if (finalVisibility !== 'personal' && !finalUnit) {
      return failValidation(res, { unit_id: 'Private and unit-shared records must belong to a unit.' });
    }
    const scopeChanged = finalUnit !== row.unit_id || finalVisibility !== row.visibility;
    if (row.user_id !== req.user.id && scopeChanged) {
      return fail(res, 403, 'A record manager may correct content but may not change another Marine’s disclosure scope.', {
        code: 'scope_owner_only',
      });
    }
    if (scopeChanged && finalUnit && !unitAllowedForRecord(req.user, finalUnit, spec.shareFlag)) {
      return fail(res, 403, 'You are not assigned to that unit and hold no permission there.', {
        code: 'forbidden', fieldErrors: { unit_id: 'Not your unit.' },
      });
    }
    if (finalVisibility === 'unit' && !canShareTo(db, req.user, finalVisibility, finalUnit, spec.shareFlag)) {
      return fail(res, 403, 'You cannot share to that unit.');
    }
    if ('assignee_id' in RECORD_SCHEMAS[table] && (body.assignee_id !== undefined || scopeChanged)) {
      const err = assigneeError(req.user, body.assignee_id ?? row.assignee_id, finalUnit);
      if (err) return failValidation(res, { assignee_id: err });
    }

    const sets = ['updated_at = ?', 'version = version + 1'];
    const vals = [now()];
    if (scopeChanged) {

      sets.push('visibility = ?', 'unit_id = ?');
      vals.push(finalVisibility, finalUnit);
    }
    for (const f of spec.fields) {
      if (body[f] === undefined) continue;
      if (f === 'visibility' || f === 'unit_id') continue;
      sets.push(`${f} = ?`);
      vals.push(spec.json.includes(f) ? JSON.stringify(body[f] ?? []) : body[f]);
    }

    const expected = body.version;
    if (expected !== undefined && !Number.isInteger(Number(expected))) {
      return failValidation(res, { version: 'Must be a whole number.' });
    }
    let result;
    if (expected !== undefined) {
      result = db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND version = ?`)
        .run(...vals, req.params.id, Number(expected));
      if (result.changes === 0) {
        const current = hydrate(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id), spec);
        return fail(res, 409, 'This record changed while you were editing it. Reload to see the latest version.', {
          code: 'stale', current,
        });
      }
    } else {
      db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    }

    audit({
      actor_id: req.user.id, action: 'edit', entity: table, entity_id: row.id,
      subject_id: row.user_id, unit_id: finalUnit,
      detail: row.user_id === req.user.id ? 'author edit' : 'manager edit',
    });
    res.json(hydrate(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id), spec));
  });

  app.delete(`/api/${table}/:id`, auth, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return fail(res, 404, 'No such record.');
    if (!canEdit(db, req.user, row)) return fail(res, 403, 'That record is not yours to delete.');

    let detail;
    db.transaction(() => {
      db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now(), req.params.id);
      if (table === 'projects') {

        const tasks = db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(req.params.id).changes;
        const acts = db.prepare('UPDATE activities SET project_id = NULL WHERE project_id = ?').run(req.params.id).changes;
        detail = `unlinked ${tasks} tasks, ${acts} activities`;
      }
    })();
    audit({ actor_id: req.user.id, action: 'delete', entity: table, entity_id: row.id, subject_id: row.user_id, unit_id: row.unit_id, detail });
    res.json({ ok: true, id: req.params.id });
  });

  app.post(`/api/${table}/:id/restore`, auth, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return fail(res, 404, 'No such record.');
    if (!canEdit(db, req.user, row)) return fail(res, 403, 'Not yours to restore.');
    db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(req.params.id);
    audit({ actor_id: req.user.id, action: 'restore', entity: table, entity_id: row.id, unit_id: row.unit_id });
    res.json(hydrate(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id), spec));
  });
}

const attachmentBody = express.raw({
  type: () => true,
  limit: config.attachments.max_bytes,
});

function activityForAttachment(req, res) {
  const row = db.prepare('SELECT * FROM activities WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!row) {
    fail(res, 404, 'No such activity.');
    return null;
  }
  const readable = row.user_id === req.user.id
    || (row.visibility === 'unit' && row.unit_id && can(db, req.user, PERMISSIONS.VIEW_RECORDS, row.unit_id));
  if (!readable) {
    fail(res, 403, 'You cannot read attachments for that activity.');
    return null;
  }
  return row;
}

const attachmentMetadata = (row) => ({
  id: row.id,
  activity_id: row.activity_id,
  original_name: row.original_name,
  mime_type: row.mime_type,
  size_bytes: row.size_bytes,
  sha256: row.sha256,
  created_at: row.created_at,
});

app.get('/api/activities/:id/attachments', auth, (req, res) => {
  const activity = activityForAttachment(req, res);
  if (!activity) return;
  const rows = db.prepare(
    `SELECT id, activity_id, original_name, mime_type, size_bytes, sha256, created_at
       FROM attachments WHERE activity_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
  ).all(activity.id);
  if (activity.user_id !== req.user.id) {
    audit({
      actor_id: req.user.id, action: 'view_attachments', entity: 'activities', entity_id: activity.id,
      subject_id: activity.user_id, unit_id: activity.unit_id, detail: `${rows.length} file metadata rows`,
    });
  }
  res.json({ attachments: rows.map(attachmentMetadata), enabled: config.attachments.enabled });
});

app.post('/api/activities/:id/attachments', auth, attachmentBody, (req, res) => {
  if (!config.attachments.enabled) {
    return fail(res, 404, 'Attachments are not enabled.', { code: 'attachments_disabled' });
  }
  const activity = activityForAttachment(req, res);
  if (!activity) return;
  if (!canEdit(db, req.user, activity)) return fail(res, 403, 'That activity is not yours to update.');
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM attachments WHERE activity_id = ? AND deleted_at IS NULL'
  ).get(activity.id).n;
  if (count >= config.attachments.max_per_record) {
    return fail(res, 409, `An activity can hold at most ${config.attachments.max_per_record} attachments.`, {
      code: 'attachment_limit',
    });
  }
  const inspected = inspectAttachment({
    body: req.body,
    filename: req.get('x-vantage-filename'),
    contentType: req.get('content-type'),
    allowedTypes: config.attachments.allowed_types,
    maxBytes: config.attachments.max_bytes,
  });
  if (!inspected.ok) return fail(res, 400, inspected.error, { code: 'invalid_attachment' });
  try {
    if (statSync(db.name).size + inspected.size >= MAX_DB_BYTES) {
      return fail(res, 507, 'The database is too close to its configured safety threshold for that file.', {
        code: 'database_capacity',
      });
    }
  } catch {}

  const id = newId();
  try {
    db.prepare(
      `INSERT INTO attachments
        (id, activity_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, activity.id, req.user.id, inspected.filename, inspected.mime,
      inspected.size, inspected.sha256, req.body, now()
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return fail(res, 409, 'That exact file is already attached to this activity.', { code: 'duplicate_attachment' });
    }
    throw err;
  }
  audit({
    actor_id: req.user.id, action: 'upload_attachment', entity: 'attachments', entity_id: id,
    subject_id: activity.user_id, unit_id: activity.unit_id,
    detail: `${inspected.size} bytes; ${inspected.mime}`,
  });
  const saved = db.prepare(
    `SELECT id, activity_id, original_name, mime_type, size_bytes, sha256, created_at
       FROM attachments WHERE id = ?`
  ).get(id);
  return res.status(201).json(attachmentMetadata(saved));
});

app.get('/api/activities/:id/attachments/:attachmentId', auth, (req, res) => {
  const activity = activityForAttachment(req, res);
  if (!activity) return;
  const file = db.prepare(
    'SELECT * FROM attachments WHERE id = ? AND activity_id = ? AND deleted_at IS NULL'
  ).get(req.params.attachmentId, activity.id);
  if (!file) return fail(res, 404, 'No such attachment.');
  audit({
    actor_id: req.user.id, action: 'download_attachment', entity: 'attachments', entity_id: file.id,
    subject_id: activity.user_id, unit_id: activity.unit_id,
    detail: `${file.size_bytes} bytes; ${file.mime_type}`,
  });
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Length', String(file.size_bytes));
  res.setHeader('Content-Disposition', attachmentDisposition(file.original_name));
  return res.send(file.content);
});

app.delete('/api/activities/:id/attachments/:attachmentId', auth, (req, res) => {
  const activity = activityForAttachment(req, res);
  if (!activity) return;
  if (!canEdit(db, req.user, activity)) return fail(res, 403, 'That activity is not yours to update.');
  const file = db.prepare(
    'SELECT * FROM attachments WHERE id = ? AND activity_id = ? AND deleted_at IS NULL'
  ).get(req.params.attachmentId, activity.id);
  if (!file) return fail(res, 404, 'No such attachment.');
  db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ?').run(now(), file.id);
  audit({
    actor_id: req.user.id, action: 'delete_attachment', entity: 'attachments', entity_id: file.id,
    subject_id: activity.user_id, unit_id: activity.unit_id,
    detail: `${file.size_bytes} bytes; retained by soft delete`,
  });
  return res.json({ ok: true });
});

const activityFingerprint = (userId, row) => createHash('sha256')
  .update([
    userId,
    row.date || '',
    String(row.title || '').trim().toLowerCase().replace(/\s+/g, ' '),
    row.quantity ?? '',
    row.dollar_amount ?? '',
  ].join('|'))
  .digest('hex');

app.post('/api/activities/bulk', auth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!rows.length) return fail(res, 400, 'No rows to import.');
  if (rows.length > BULK_LIMITS.maxRows) {
    return fail(res, 400, `Imports are limited to ${BULK_LIMITS.maxRows} activities per request. Split the file and import in batches.`, { code: 'too_many_rows' });
  }
  const capacity = recordCapacityProblem(req.user.id, rows.length);
  if (capacity) return fail(res, 507, capacity, { code: 'record_quota' });
  for (let i = 0; i < rows.length; i += 1) {
    const errors = validate(RECORD_SCHEMAS.activities, rows[i] || {});
    if (errors) {
      return fail(res, 400, `Row ${i + 1}: ${fieldErrorMessage(errors.fieldErrors)}`, {
        code: 'validation', row: i, fieldErrors: errors.fieldErrors,
      });
    }
  }

  const scope = resolveScope(db, req.user);
  const unitId = scope.assignments.find((a) => a.is_primary)?.unit_id || scope.unitIds[0] || null;

  const importVisibility = unitId ? DEFAULT_VISIBILITY : 'personal';
  const spec = TABLES.activities;
  const created = [];
  const duplicates = [];
  const planned = [];

  for (let i = 0; i < rows.length; i += 1) {
    const body = rows[i];
    const visibility = body.visibility || importVisibility;
    const rowUnit = visibility === 'personal' ? null : (body.unit_id || unitId);
    if (!VISIBILITIES.includes(visibility)) {
      return fail(res, 400, `Row ${i + 1}: unknown visibility.`, { code: 'validation', row: i });
    }
    if (visibility !== 'personal' && !rowUnit) {
      return fail(res, 400, `Row ${i + 1}: private and unit-shared activities must belong to a unit.`, { code: 'validation', row: i });
    }
    if (rowUnit && !unitAllowedForRecord(req.user, rowUnit, spec.shareFlag)) {
      return fail(res, 403, `Row ${i + 1}: you cannot import into that unit.`, { code: 'forbidden', row: i });
    }
    if (visibility === 'unit' && !canShareTo(db, req.user, visibility, rowUnit, spec.shareFlag)) {
      return fail(res, 403, `Row ${i + 1}: you cannot share into that unit.`, { code: 'forbidden', row: i });
    }
    planned.push({ body, visibility, unitId: rowUnit });
  }

  const insert = db.transaction(() => {
    for (let i = 0; i < planned.length; i += 1) {
      const { body, visibility, unitId: rowUnit } = planned[i];
      const id = newId();
      const cols = ['id', 'user_id', 'unit_id', 'visibility', 'fingerprint', 'created_at', 'updated_at'];
      const vals = [id, req.user.id, rowUnit, visibility, activityFingerprint(req.user.id, body), now(), now()];
      for (const f of spec.fields) {
        if (['unit_id', 'visibility'].includes(f) || body[f] === undefined) continue;
        cols.push(f);
        vals.push(spec.json.includes(f) ? JSON.stringify(body[f] ?? []) : body[f]);
      }
      try {
        db.prepare(`INSERT INTO activities (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
        created.push(id);
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) duplicates.push(i);
        else throw err;
      }
    }
  });
  insert();
  audit({
    actor_id: req.user.id, action: 'import', entity: 'activities',
    unit_id: [...new Set(planned.map((p) => p.unitId).filter(Boolean))].length === 1
      ? planned.find((p) => p.unitId)?.unitId || null
      : null,
    detail: `${created.length} rows${duplicates.length ? `, ${duplicates.length} duplicates skipped` : ''}`,
  });
  res.json({ created: created.length, duplicates: duplicates.length, duplicateRows: duplicates });
});

app.use('/api', (req, res) => fail(res, 404, 'No such API route.', { code: 'not_found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.too.large') {
    return fail(res, 413, 'Request body is too large.', { code: 'too_large' });
  }
  console.error('Unhandled request error:', err);
  return fail(res, 500, 'The server could not complete that request.', { code: 'server_error' });
});

app.use((req, res, next) => {
  if (!PRODUCTION || !adminHost || req.path.startsWith('/api/')) return next();
  const currentHost = req.hostname.toLowerCase();
  if (req.path === '/operator' && currentHost !== adminHost) {
    return res.redirect(302, `${config.deployment.admin_url}/operator`);
  }
  if (currentHost === adminHost && req.path === '/') return res.redirect(302, '/operator');
  next();
});

const dist = join(__dirname, '..', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(dist, 'index.html')));
}

const PORT = process.env.PORT || 8787;

if (process.env.VANTAGE_TEST !== '1') {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Vantage v${VERSION} listening on :${PORT} (${PRODUCTION ? 'production' : 'development'})`);
  });

  let maradminTimer = null;
  if (PRODUCTION) {
    const runMaradminSync = () => syncMaradmins(db).catch((error) => {
      console.warn(`MARADMIN refresh skipped: ${error.message}`);
    });
    const initialSync = setTimeout(runMaradminSync, 2_000);
    initialSync.unref?.();
    maradminTimer = setInterval(runMaradminSync, 5 * 60 * 1000);
    maradminTimer.unref?.();
  }

  const shutdown = (signal) => () => {
    console.log(`${signal} received, shutting down.`);
    if (maradminTimer) clearInterval(maradminTimer);
    server.close(() => {
      try { db.close(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

export { app, db, maintenanceGuard };
