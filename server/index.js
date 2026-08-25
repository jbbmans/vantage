/**
 * Vantage — API server.
 *
 * Serves the built SPA and a JSON API over the same origin, so there is no CORS
 * surface and no third-party host in the data path. One process, one SQLite
 * file, deployable to anything that runs Node.
 *
 * v3.2.2: this file is now wired to the v3.3 security modules that v3.2.1
 * introduced. Every role operation goes through roleGuard, every request body
 * through validate, sign-in through the layered throttle in security, and the
 * personnel transitions (transfer, deactivation, resets) through lifecycle.
 * Error responses carry { error, code?, fieldErrors? } — `error` stays a plain
 * string so existing clients keep rendering something useful.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  getDb, bootstrapAdmin, audit, newId, now, grantRole, revokeRole,
  claimUnit, copyTemplateInto, ownerRoleId, addMember, removeMember,
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
// org.js is DISPLAY ONLY. It is imported here for breadcrumbs and the unit
// picker and must never appear in an authorization decision — see org.js and
// tests/static.test.mjs, which fails the build if it drifts into one.
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
import { config, safeConfig } from './config.js';
import { attachmentDisposition, inspectAttachment } from './attachments.js';
import { EXPERIENCE_EVENTS, recordExperience } from './experience.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = getDb();
pruneSessions(db);

const app = express();
const PRODUCTION = process.env.NODE_ENV === 'production';
const DEPLOYMENT_MODE = config.app.data_mode;

/**
 * The shell sets the theme before first paint via a small inline script, so a
 * strict script-src would block it and the app would load light-flashing on
 * every navigation. Rather than opening the policy with 'unsafe-inline' — which
 * would defeat most of the point of having a CSP — the script is hashed at
 * boot and the hash allow-listed. Change the script and the hash follows it.
 */
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

/**
 * Proxy trust is security-sensitive (finding 18): whatever Express trusts here
 * decides what req.ip and req.secure mean, and those feed rate limiting and
 * secure-cookie behaviour. Trusting forwarding headers when there is no proxy
 * lets any client spoof its IP with one header.
 *
 *   TRUST_PROXY unset   → 1 hop in production (every supported platform —
 *                         Fly, Render, Railway — fronts the app with exactly
 *                         one proxy), none in development.
 *   TRUST_PROXY=false/0 → trust nothing. Use when exposed directly.
 *   TRUST_PROXY=<n>     → trust n hops.
 *   anything else       → passed to Express verbatim ('loopback', a CIDR…).
 *
 * fly.toml and render.yaml set TRUST_PROXY=1 explicitly so the deployment
 * files document their own topology.
 */
function resolveTrustProxy(raw) {
  if (raw === undefined || raw === '') return PRODUCTION ? 1 : false;
  const v = String(raw).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'none'].includes(v)) return false;
  if (['true', 'yes', 'on'].includes(v)) return 1; // "trust everything" is never the right reading
  if (/^\d+$/.test(v)) return Number(v);
  return raw;
}
app.set('trust proxy', resolveTrustProxy(config.deployment.trust_proxy));

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

/**
 * Security headers. Hand-rolled rather than pulling in a dependency that sits
 * in the path of every request to a system holding personnel data.
 *
 * The CSP is the important one: connect-src 'self' means that even a
 * compromised build cannot ship records to another origin.
 */
app.use((req, res, next) => {
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

// Keep the in-memory login counters and the sessions table from growing
// without bound on a long-lived process.
setInterval(() => {
  pruneCounters();
  try { pruneSessions(db); } catch { /* db closing during shutdown */ }
}, 15 * 60 * 1000).unref?.();

/** Platform health probe. Confirms the database answers, not just that we booted. */
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, version: VERSION, mode: DEPLOYMENT_MODE, uptime: Math.round(process.uptime()) });
  } catch (err) {
    console.error('Database health check failed:', err);
    res.status(503).json({ ok: false, error: 'Database health check failed.' });
  }
});

/** Safe, non-secret deployment capabilities used by sign-in and Settings. */
app.get('/api/config', (req, res) => {
  res.json(safeConfig());
});

const auth = requireAuth(db);
const fail = (res, code, msg, extra = {}) => res.status(code).json({ error: msg, ...extra });
const failValidation = (res, fieldErrors) =>
  fail(res, 400, fieldErrorMessage(fieldErrors), { code: 'validation', fieldErrors });
const denyResult = (res, r) => fail(res, r.status || 403, r.message, { code: r.code });

/** Guard a route on a permission held in a specific unit. */
const needs = (flag, unitFrom = (req) => req.body?.unit_id || req.params?.unitId) => (req, res, next) => {
  const unitId = unitFrom(req);
  if (!unitId) return fail(res, 400, 'A unit is required for this action.');
  if (!can(db, req.user, flag, unitId)) return fail(res, 403, 'You do not have that permission in this unit.');
  next();
};

/* ── record tables ────────────────────────────────────────────────── */

/**
 * `shareFlag` is finding 5: which permission lets you post THIS kind of record
 * into a unit you are not assigned to. v3.2 used CREATE_SHARED_WORK for
 * everything, which made CREATE_SHARED_GOALS decorative — a role holding only
 * the work bit could post goals, and a goals-only role could not.
 */
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
  } catch { /* in-memory test database or platform without a normal file */ }
  return null;
}

/** One bounded access receipt per actor/subject/table/unit in a five-minute refresh window. */
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

/**
 * Ownership/unit consistency (finding 38). A record's unit must be a unit the
 * author actually stands in some relation to: assigned there, holds the
 * relevant sharing permission there, can manage records there, or is an
 * administrator. Without this a user can pin their private records to
 * arbitrary units and every future unit-scoped feature inherits the lie.
 */
function unitAllowedForRecord(user, unitId, shareFlag) {
  if (!unitId) return true;
  if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) return false;
  if (isMember(db, user.id, unitId)) return true;
  // v3.3 ended this chain with `|| isTrueAdmin(db, user)`, which let anyone
  // holding ADMINISTRATOR in any unit pin records into any other unit in the
  // database. Under tenancy the only remaining answers are membership or a
  // grant IN THAT UNIT.
  return can(db, user, shareFlag, unitId) || can(db, user, PERMISSIONS.MANAGE_RECORDS, unitId);
}

/**
 * Assignee validation (finding 14). Assigning work to somebody requires that
 * they exist, are active, are inside the actor's visibility scope, and — when
 * the record is pinned to a unit — actually serve in that unit's subtree.
 */
function assigneeError(user, assigneeId, unitId) {
  if (!assigneeId || assigneeId === user.id) return null;
  const target = db.prepare('SELECT id, active FROM users WHERE id = ?').get(assigneeId);
  if (!target) return 'No such Marine.';
  if (!target.active) return 'That account is deactivated.';
  if (!visibleUserIds(db, user).includes(assigneeId)) return 'That Marine is outside your scope.';
  // v3.3 accepted an assignee anywhere in the unit's SUBTREE, which is the
  // tree leaking into a write path. Membership in the unit itself, or nothing.
  if (unitId && !isMember(db, assigneeId, unitId)) {
    return 'That Marine is not a member of that unit.';
  }
  return null;
}

/* ── auth ─────────────────────────────────────────────────────────── */

app.get('/api/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({
    needsSetup: n === 0,
    requiresSetupToken: n === 0 && PRODUCTION,
    selfRegistration: config.auth.self_registration,
    passwordEnabled: config.auth.password_enabled,
    cacPivEnabled: config.auth.cac_piv.enabled,
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
  const setupUnitCode = setupBody.unit_code || 'CE-G8';
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

/**
 * Self-registration creates an identity, not a unit membership. The account's
 * record is personal-only until a unit authority explicitly attaches it. This
 * keeps onboarding convenient without making a public sign-up form an
 * authorization path.
 */
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

/**
 * Sign in, behind the layered throttle (finding 17): per-IP, per-account and
 * global counters, failures only, with a burned scrypt verification on unknown
 * usernames so "no such user" is not distinguishable by timing.
 */
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
  // Same response either way — a different message for "no such user" tells an
  // attacker which usernames are real.
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

/**
 * Disabled-by-default CAC/PIV adapter for an approved mTLS reverse proxy.
 * Vantage never accepts a browser-asserted identity header by itself: the
 * proxy must add a separate high-entropy shared secret from the platform's
 * secret store and an explicit certificate-verification result.
 */
app.post('/api/auth/cac-piv', (req, res) => {
  if (!config.auth.cac_piv.enabled) {
    return fail(res, 404, 'CAC/PIV sign-in is not enabled.', { code: 'cac_piv_disabled' });
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    return fail(res, 409, 'The deployment must be initialized before CAC/PIV accounts can be created.', {
      code: 'setup_required',
    });
  }
  const proxySecret = String(process.env.VANTAGE_CAC_PROXY_SECRET || '');
  if (proxySecret.length < 32) {
    return fail(res, 503, 'CAC/PIV sign-in is not fully configured.', { code: 'cac_piv_unconfigured' });
  }
  const suppliedSecret = String(req.get(config.auth.cac_piv.proxy_secret_header) || '');
  const suppliedDigest = createHash('sha256').update(suppliedSecret).digest();
  const expectedDigest = createHash('sha256').update(proxySecret).digest();
  if (!timingSafeEqual(suppliedDigest, expectedDigest)) {
    return fail(res, 401, 'CAC/PIV assertion was not issued by the trusted proxy.', { code: 'cac_piv_untrusted' });
  }
  const verified = String(req.get(config.auth.cac_piv.verification_header) || '').toLowerCase();
  if (verified !== String(config.auth.cac_piv.verification_value).toLowerCase()) {
    return fail(res, 401, 'The client certificate was not verified.', { code: 'cac_piv_unverified' });
  }

  const subject = String(req.get(config.auth.cac_piv.subject_header) || '').trim();
  const username = normalizeUsername(req.get(config.auth.cac_piv.username_header));
  const firstName = String(req.get(config.auth.cac_piv.first_name_header) || '').trim();
  const lastName = String(req.get(config.auth.cac_piv.last_name_header) || '').trim();
  if (!subject || subject.length > 512 || !username || !firstName || !lastName) {
    return fail(res, 400, 'The trusted proxy did not supply a complete CAC/PIV identity.', { code: 'cac_piv_incomplete' });
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
    // Breadcrumb only. `chain` here is the org-chart path drawn for the user's
    // own unit; it grants nothing and is computed from the display module.
    chain: scope.unitIds.length ? ancestorChain(db, scope.unitIds[0]) : [],
  });
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

app.get('/api/admin/experience', auth, operatorGate(db), (req, res) => {
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

/**
 * Self-service password change (finding 16). Knowing the current password is
 * the gate; every OTHER session ends on success, so a stolen session cannot
 * outlive the password that created it.
 */
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

/** A Marine's own sessions (finding 28) — the shared-workstation check. */
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

/* ── org reference ────────────────────────────────────────────────── */

app.get('/api/org', auth, (req, res) => {
  const mine = memberUnitIds(db, req.user.id);
  const operator = isInstanceOperator(req.user) || isBootstrapOperator(db, req.user);
  // Ordinary users receive only the units they belong to plus the descriptive
  // ancestors needed to draw a breadcrumb. The Instance Operator may see the
  // unit directory for recovery/claiming, but receives no unit permissions.
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

/** Role templates offered by the creation wizard (finding 5, finding 21). */
app.get('/api/org/templates', auth, (req, res) => {
  res.json({ templates: templateSummaries(), default: DEFAULT_TEMPLATE_ID, levels: LEVELS });
});

/**
 * Create a unit (finding 5).
 *
 * v3.3 required a parent the actor already held MANAGE_UNITS on, and refused
 * outright when parent_id was absent — so there was no path to a top-level
 * unit, and a SNCOIC at a command that had never used Vantage had no way in at
 * all. They would first have to be granted authority inside somebody else's
 * tree, which is exactly the dependency sovereignty exists to remove.
 *
 * Now: parent_id is optional and purely descriptive. Creating a SUB-unit of a
 * unit you manage still requires MANAGE_UNITS there — not because the tree
 * conveys authority, but because naming your unit as someone's parent is a
 * claim about their org chart. Creating a top-level organization is an
 * Instance Operator action until an approved invitation workflow exists.
 *
 * The creator becomes the Unit Owner, is enrolled as a member, receives the
 * copied Owner role, and gets a unit-local copy of the chosen template.
 */
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

  // Codes are stable keys; generate one when the user doesn't supply it.
  const id = (code || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!id) return fail(res, 400, 'That name produces an empty unit code.');

  try {
    const created = db.transaction(() => {
      db.prepare(
        `INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, level, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, id, name.trim(), short_name?.trim() || null, echelon || 'section',
        location?.trim() || null, parent_id || null, level || 'L4', now()
      );
      claimUnit(id, req.user.id, template_id || DEFAULT_TEMPLATE_ID);
      audit({ actor_id: req.user.id, action: 'create_unit', entity: 'unit', entity_id: id, unit_id: id, detail: name.trim() });
      return db.prepare('SELECT * FROM units WHERE id = ?').get(id);
    })();
    res.json(created);
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

/** Deactivate rather than delete — records point at units. */
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

/**
 * Claim an unowned unit (Instance Operator).
 *
 * A unit row with no owner and no roles is unreachable: nobody can grant
 * anything in it, so nobody can ever get in. That happens in exactly two
 * situations — a unit that arrived from an imported org chart, and a unit
 * whose Owner is gone (finding 11's recovery case). Both are instance-level
 * problems, so this is an instance-level act, and it is loud: the audit row
 * lands in the unit's own log where the new Owner will see it.
 *
 * It refuses a unit that already has an owner. Reassigning a live unit is a
 * different operation with a different consent story, and conflating them
 * would make this a quiet takeover primitive.
 */
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
  audit({
    actor_id: req.user.id, action: 'claim_unit', entity: 'unit', entity_id: unit.id,
    subject_id: ownerId, unit_id: unit.id, detail: `operator assigned owner (${template_id || DEFAULT_TEMPLATE_ID} template)`,
  });
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(unit.id));
});

/** Explicit owner succession; required before removing or deactivating an owner. */
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
  })();
  audit({
    actor_id: req.user.id, action: 'transfer_ownership', entity: 'unit', entity_id: unitId,
    subject_id: successor.id, unit_id: unitId,
    detail: `${unit.owner_user_id || 'unowned'} → ${successor.id}; former-owner administrator grants revoked: ${revokedAdminGrants}`,
  });
  res.json({ ok: true, unit_id: unitId, owner_user_id: successor.id, revokedAdminGrants });
});

/**
 * Add an existing account to a unit (findings 8 and 9).
 *
 * v3.3 had no such operation: membership was inferred from `assignments`, so
 * the only way into a unit was to be created there or reassigned there, and a
 * Marine could not belong to two units at once. Under stated membership the
 * two are separable — `assignments` keeps billet and history, `unit_members`
 * answers who is in the unit — which is what makes a guest expressible at all.
 *
 * A guest is ordinary membership with `kind = 'guest'` and an expiry, given a
 * normal unit-local role. Deliberately NOT a parallel authorization path: every
 * existing permission check already covers them, so there is no second code
 * path to drift out of step with the first.
 */
app.post('/api/org/units/:unitId/members', auth, (req, res) => {
  const { user_id, kind = 'member', role_id, expires_at } = req.body || {};
  const unitId = req.params.unitId;
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  if (!['member', 'guest'].includes(kind)) {
    return failValidation(res, { kind: 'Membership is member or guest. Ownership transfers separately.' });
  }
  if (kind === 'guest' && !expires_at) {
    // A guest membership without an expiry is a permanent one with a
    // misleading label, so the expiry is required rather than defaulted.
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

  // Judge the optional starting role before writing anything, so a refused
  // grant refuses the whole request rather than leaving a member with no role.
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

  db.transaction(() => {
    addMember(user_id, unitId, { kind, invitedBy: req.user.id, expiresAt: effectiveExpiry });
    // Attaching an otherwise-unassigned identity is the moment it gains a
    // primary unit. Without this row a later transfer could not name the unit
    // it is leaving, which would let a destination owner pull the person out
    // without source-unit approval. Guest access stays collateral-only.
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
  })();

  audit({
    actor_id: req.user.id, action: 'add_member', entity: 'unit', entity_id: unitId,
    subject_id: user_id, unit_id: unitId,
    detail: `${kind}${effectiveExpiry ? ` until ${effectiveExpiry}` : ''}${role ? ` as ${role.name}` : ''}`,
  });
  res.json({ ok: true, unit_id: unitId, user_id, kind, expires_at: effectiveExpiry });
});

/**
 * Remove someone from a unit (finding 10).
 *
 * This is "remove from unit", not "deactivate account" — three verbs v3.3
 * treated as one. It drops membership and every role grant in THIS unit and
 * touches nothing anywhere else, because Unit A has no business ending a
 * Marine's account for Unit B.
 */
app.delete('/api/org/units/:unitId/members/:userId', auth, (req, res) => {
  const { unitId, userId } = req.params;
  if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) return fail(res, 404, 'No such unit.');
  if (!db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) {
    return fail(res, 404, 'That Marine is not a member of this unit.');
  }
  if (!isUnitOwner(db, req.user.id, unitId) && !can(db, req.user, PERMISSIONS.MANAGE_MEMBERS, unitId)) {
    return fail(res, 403, 'You cannot remove members from that unit.');
  }
  // Orphan protection (finding 11): an Owner cannot walk out of their own unit
  // and leave records nobody can reach. Ownership transfers first.
  if (isUnitOwner(db, userId, unitId)) {
    return fail(res, 400, 'That Marine owns this unit. Transfer ownership before removing them.', { code: 'last_owner' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (userId !== req.user.id && !isUnitOwner(db, req.user.id, unitId)
      && positionIn(db, target, unitId) >= positionIn(db, req.user, unitId)) {
    return fail(res, 403, 'You cannot remove a Marine whose role is at or above your own.', { code: 'hierarchy' });
  }
  const removed = removeMember(userId, unitId);
  // Unit authorization is evaluated live on every request; do not turn a
  // unit-local operation into account-wide session control.
  const sessionsRevoked = 0;
  audit({
    actor_id: req.user.id, action: 'remove_member', entity: 'unit', entity_id: unitId,
    subject_id: userId, unit_id: unitId,
    detail: `roles: ${removed.roles}; assignments ended: ${removed.assignments}; records frozen: ${removed.recordsFrozen}`,
  });
  res.json({ ok: true, ...removed, sessionsRevoked });
});

/* ── roles ────────────────────────────────────────────────────────── */
/**
 * A user sees the role sets of the units they belong to, and no others.
 * v3.3 returned every role in the database, which under tenancy would show one
 * shop's role names — and permission layout — to every other shop.
 */
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

/**
 * Create a role. One validator — validateRoleDefinition — judges creation,
 * editing and granting (finding 1), so there is no second, slightly weaker
 * path to the same outcome.
 */
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

/**
 * Edit a role. The request is merged over the existing definition and the
 * MERGED result is validated — this is the route that allowed privilege
 * escalation in v3.2 (finding 1): editing checked position but never re-checked
 * that the resulting permission set was one the editor could delegate.
 */
app.put('/api/roles/:roleId', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');
  // v3.3 refused outright on is_system, because a system role was a shared
  // global object and editing it changed it for every unit. Under v3.4 every
  // role is a unit-local copy, so is_system is provenance only and the owning
  // unit may edit its own copy freely (finding 1).

  const { name, description, color, position, permissions, unit_id } = req.body || {};
  if (color && (typeof color !== 'string' || color.length > 20)) return failValidation(res, { color: 'Not a color.' });

  const def = {
    name: name ?? role.name,
    description: description ?? role.description,
    position: position === undefined ? role.position : Number(position),
    permissions: permissions === undefined ? role.permissions : Number(permissions),
    // A role cannot be moved between units — two units' role sets are
    // unrelated, so a "move" would silently re-scope every live grant. The
    // validator rejects a mismatch rather than accepting it quietly.
    unit_id: unit_id === undefined ? role.unit_id : (unit_id || null),
  };
  const verdict = validateRoleDefinition(db, req.user, def, { existing: role });
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  db.prepare(
    'UPDATE roles SET name = ?, description = ?, color = ?, position = ?, permissions = ? WHERE id = ?'
  ).run(def.name, def.description, color ?? role.color, def.position, def.permissions, req.params.roleId);
  audit({ actor_id: req.user.id, action: 'edit_role', entity: 'role', entity_id: req.params.roleId, unit_id: def.unit_id });
  res.json(db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId));
});

app.delete('/api/roles/:roleId', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');
  // Deleting needs authority over the role's own unit. There is no org-wide
  // case left, and is_system no longer protects a unit's own copy (finding 1).
  if (!canManageRoleDefinition(db, req.user, role)) {
    return fail(res, 403, 'That role belongs to a unit outside your authority.');
  }
  // Refusing to delete the unit's last owner-capable role keeps the unit from
  // being locked by a role edit. The Unit Owner's authority does not depend on
  // a role, so this is belt-and-braces, but a unit with no administering role
  // is still a unit nobody but the owner can run.
  if (role.unit_id && isUnitOwner(db, req.user.id, role.unit_id) === false && (role.permissions & PERMISSIONS.ADMINISTRATOR)) {
    return fail(res, 403, 'Only the unit owner can delete an administrator role.');
  }
  db.prepare('DELETE FROM member_roles WHERE role_id = ? AND unit_id = ?').run(req.params.roleId, role.unit_id);
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.roleId);
  audit({ actor_id: req.user.id, action: 'delete_role', entity: 'role', entity_id: req.params.roleId, unit_id: role.unit_id, detail: role.name });
  res.json({ ok: true });
});

/** Hand a role to a Marine inside a unit. */
app.post('/api/team/:id/roles', auth, (req, res) => {
  const { role_id, unit_id } = req.body || {};
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) return fail(res, 404, 'No such Marine.');

  // Finding 1/6: the grant re-runs the same delegation and scope logic as
  // create/edit. A broad role made by an administrator is not a ladder for a
  // narrower leader, and a unit-scoped definition never leaves its subtree.
  const verdict = validateRoleGrant(db, req.user, role, unit_id, targetUser);
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  grantRole(req.params.id, role_id, unit_id, req.user.id);
  audit({
    actor_id: req.user.id, action: 'grant_role', entity: 'role', entity_id: role_id,
    subject_id: req.params.id, unit_id, detail: `${role.name} @ ${unit_id}`,
  });
  res.json({ ok: true });
});

app.delete('/api/team/:id/roles/:roleId', auth, (req, res) => {
  const { unit_id } = req.query;
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');
  if (!unit_id) return fail(res, 400, 'A unit is required.');
  if (!isUnitOwner(db, req.user.id, unit_id)) {
    if (!can(db, req.user, PERMISSIONS.MANAGE_ROLES, unit_id)) return fail(res, 403, 'You cannot manage roles there.');
    if (!canManageRole(db, req.user, role)) return fail(res, 403, 'That role is at or above your own.');
  }
  revokeRole(req.params.id, req.params.roleId, unit_id);
  audit({
    actor_id: req.user.id, action: 'revoke_role', entity: 'role', entity_id: req.params.roleId,
    subject_id: req.params.id, unit_id,
  });
  res.json({ ok: true });
});

app.post('/api/org/billets', auth, operatorGate(db), (req, res) => {
  const { title, category, echelon, default_role } = req.body || {};
  if (!title) return fail(res, 400, 'A billet needs a title.');
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    db.prepare('INSERT INTO billets (id, title, category, echelon, default_role) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, category || 'Staff', echelon || 'section', default_role || 'member');
    res.json(db.prepare('SELECT * FROM billets WHERE id = ?').get(id));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return fail(res, 400, 'That billet already exists.');
    console.error('Billet creation failed:', err);
    fail(res, 500, 'The billet could not be created.');
  }
});

/* ── roster and team management ───────────────────────────────────── */

/** Minimal, prefix-only identity lookup for an authorized unit enrollment. */
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
  SELECT u.id, u.username, u.first_name, u.last_name, u.middle_initial, u.mos, u.email, u.eas,
         u.is_admin, u.active,
         r.abbr AS rank_abbr, r.name AS rank_name, r.grade AS rank_grade, r.tier AS rank_tier, r.sort AS rank_sort,
         a.role, a.is_primary, a.unit_id, a.start_date,
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
    // The list is a minimal shared-unit projection. Full profile fields live
    // behind the separately authorized and audited member-detail route.
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

/** Units in which this actor may open this specific Marine's detail. */
const memberDetailUnitIds = (actor, targetId) =>
  memberUnitIds(db, targetId)
    .filter((unitId) => can(db, actor, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId))
    // A grant to coach subordinates is not a grant to read a peer or a senior's
    // personnel record. Position is compared inside the same sovereign unit;
    // the unit boundary is still the first and controlling gate.
    .filter((unitId) => positionIn(db, actor, unitId) > positionIn(db, { id: targetId }, unitId));

/** One Marine's full record. Every read of somebody else's is logged. */
app.get('/api/team/:id', auth, (req, res) => {
  const isSelf = req.params.id === req.user.id;
  const detailUnits = isSelf ? memberUnitIds(db, req.user.id) : memberDetailUnitIds(req.user, req.params.id);
  if (!isSelf && !detailUnits.length) {
    return fail(res, 403, 'You can see this Marine on a roster but cannot open their record in any shared unit.');
  }

  const person = db.prepare(rosterQuery.replace('%IDS%', '?')).get(req.params.id);
  if (!person) return fail(res, 404, 'No such Marine.');

  // A person can serve in several sovereign units. The primary assignment may
  // be in one the viewer cannot access, so never let that unrelated unit ride
  // along in the shared profile header.
  if (!isSelf && person.unit_id && !detailUnits.includes(person.unit_id)) {
    for (const key of [
      'role', 'is_primary', 'unit_id', 'start_date', 'billet_title', 'billet_category',
      'unit_name', 'unit_short', 'unit_code', 'unit_echelon',
    ]) person[key] = null;
  }

  // Viewing your own record shows everything. Viewing someone else's shows only
  // what they chose to share — the generic list endpoints already enforce this,
  // and an endpoint that reads straight from the table would quietly undo it.
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

/** Create an instance-global identity. Unit leaders enroll existing identities; only the identity authority creates one. */
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

  // Judge the optional starting role BEFORE creating anything, so a refused
  // grant refuses the whole request instead of leaving a half-configured
  // account behind.
  let extraRole = null;
  if (role_id) {
    extraRole = db.prepare('SELECT * FROM roles WHERE id = ?').get(role_id);
    // targetUser is omitted deliberately: the account does not exist yet, so
    // the membership precondition validateRoleGrant enforces cannot be met
    // here. The transaction below writes the membership row before granting,
    // which is the same ordering guarantee by construction.
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

      // Finding 9, Option A: a billet is an organizational position; permissions
      // come only from role grants. The legacy assignments.role column is no
      // longer written — a value there looked authoritative and never was.
      db.prepare(
        `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
         VALUES (?, ?, ?, ?, '', 1, ?, ?)`
      ).run(newId(), id, unit_id, billet_id || null, now().slice(0, 10), now());

      // Membership is stated, not inferred (finding 8). This row is what makes
      // the grants below mean anything: permissionMap joins through
      // unit_members, so a grant written without one confers nothing.
      addMember(id, unit_id, { kind: 'member', invitedBy: req.user.id });

      // Everyone starts with the unit's OWN default role. There is no global
      // default role any more, because there are no global roles (finding 1).
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

/**
 * Reassign: change unit, billet or role (findings 2 and 8). The lifecycle
 * module enforces authority over both ends, refuses moves against equal or
 * higher roles, revokes old-unit role grants that aren't explicitly retained,
 * and ends the Marine's sessions when their scope changes.
 */
app.put('/api/team/:id/assignment', auth, (req, res) => {
  const result = transferMember(db, req.user, req.params.id, req.body || {}, { currentToken: req.token });
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

/* ── account lifecycle (finding 4) ────────────────────────────────── */

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

/* ── database operations (finding 31) ─────────────────────────────── */

const metaGet = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value || null;
const metaSet = (key, value) => db.prepare(
  'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
).run(key, String(value));

/** Size, schema version and last-backup time — the admin Database panel. */
app.get('/api/admin/db', auth, operatorGate(db), (req, res) => {
  let sizeBytes = null;
  try { sizeBytes = statSync(db.name).size; } catch { /* in-memory or moved */ }
  res.json({
    sizeBytes,
    path: db.name,
    schemaVersion: Number(metaGet('schema_version') || 0),
    lastBackupAt: metaGet('last_backup_at'),
  });
});

/**
 * Stream a consistent snapshot of the live database. better-sqlite3's backup
 * API copies safely while writers continue, so this never requires downtime.
 * The download itself is the audit-worthy event, and it is audited.
 */
/* Backups are an Instance Operator act (finding 4), not an administrator one:
 * a backup crosses every unit boundary at once, so it belongs to whoever runs
 * the container rather than to whoever holds a role inside one shop. */
app.get('/api/admin/backup', auth, operatorGate(db), async (req, res) => {
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
      try { unlinkSync(dest); } catch { /* already gone */ }
    });
  } catch (err) {
    try { unlinkSync(dest); } catch { /* never written */ }
    console.error('Database backup failed:', err);
    fail(res, 500, 'The database backup could not be created.');
  }
});

/** Everything one account can reach, with the smells flagged (finding 27). */
app.get('/api/team/:id/access', auth, operatorGate(db), (req, res) => {
  const result = accessReview(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

/* ── per-user interface preferences ───────────────────────────────── */

/**
 * A small JSON blob per user: dashboard layout, FITREP reporting period, and
 * whatever the interface grows next. Server-side so a Marine's dashboard
 * follows them between the duty computer and their phone; merged shallowly so
 * two features saving preferences don't clobber each other.
 */
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

/* ── readiness profile (evaluation advisor inputs) ────────────────── */

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
  // Finding 21: raw evaluation inputs are rejected out of range, never clamped.
  // A PFT of 999999 stored silently as 300 is a lie in a personnel record.
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

/** A leader with VIEW_MEMBER_DETAIL can read a Marine's readiness to coach it. */
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

/* ── audit ────────────────────────────────────────────────────────── */

app.get('/api/audit', auth, (req, res) => {
  // A Marine can always see who has been reading their own record.
  const rows = db.prepare(
    `SELECT al.*, u.first_name, u.last_name, r.abbr AS rank_abbr
       FROM audit_log al JOIN users u ON u.id = al.actor_id
       LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE al.subject_id = ? ORDER BY al.at DESC LIMIT 100`
  ).all(req.user.id);
  res.json(rows);
});

/**
 * Unit-scoped access log (finding 10). This is what VIEW_AUDIT has claimed to
 * mean since the permission catalogue was written: "read the access log for
 * this unit" — actor, subject, action, entity, time — inside the leader's
 * authorized scope and nowhere beyond it.
 */
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

/* ── export (finding 25) ──────────────────────────────────────────── */

/**
 * Server-side unit export, so EXPORT_DATA means what the catalogue says: pull
 * THE UNIT'S records, not whatever happens to be loaded in the requester's
 * browser. Private records never leave; every export writes an audit row.
 */
app.get('/api/export', auth, (req, res) => {
  const unitId = req.query.unit_id;
  if (!unitId) return fail(res, 400, 'A unit is required.');
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  if (!can(db, req.user, PERMISSIONS.EXPORT_DATA, unitId)) {
    return fail(res, 403, 'You cannot export that unit.');
  }

  /* One unit. v3.3 exported the whole SUBTREE, so EXPORT_DATA at a parent
   * pulled every subordinate shop's roster into one workbook without any of
   * them acting — the exact automatic cross-unit flow Decision 3 removes.
   * Sending data upward is a share package (finding 13), not an export. */
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
    /*
     * Export what BELONGS TO THIS UNIT. Two things changed here, and both were
     * live leaks under the v3.4 model:
     *
     *   v3.3 selected `user_id IN (members) OR unit_id IN (units)`, so a
     *   member's records from ANY other unit were swept into this unit's
     *   workbook purely because they appear on its roster — the same
     *   author-scoping mistake that was in visibilityClause. Exporting G8-FMRAC
     *   should never emit a CE-G8 record.
     *
     *   The `visibility <> 'private'` filter did not exclude PERSONAL scope,
     *   which has unit_id IS NULL and so was never the unit's to hold. Finding
     *   6 says personal records are readable by their owner and nobody else,
     *   ever; an export is a read, and this one was writing them to a file.
     *
     * A record's home unit decides who may export it.
     */
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

/* ── generic record CRUD ──────────────────────────────────────────── */

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
    // Finding 11: the server is the authoritative validator. Reject, don't clamp.
    const errors = validate(RECORD_SCHEMAS[table], body);
    if (errors) return failValidation(res, errors.fieldErrors);

    const scope = resolveScope(db, req.user);

    /* A Marine with no unit at all still gets to keep a log. Personal scope is
     * the answer (finding 6), so it is the default when there is nowhere else
     * for a record to live rather than an error. */
    const fallbackUnit = scope.assignments.find((a) => a.is_primary)?.unit_id || scope.unitIds[0] || null;
    const visibility = body.visibility || (fallbackUnit ? spec.defaultVisibility : 'personal');

    /* Personal scope is DEFINED as unit_id IS NULL. Letting a unit ride along
     * would leave a row that claims to belong to nobody while still carrying a
     * unit — which the visibility clause would then have to reason about. The
     * tier sets the column; it is not merely correlated with it. */
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
      // Scope is an atomic pair. This prevents every mixed representation:
      // personal+unit, shared+null, or a unit change judged against the old
      // visibility value.
      sets.push('visibility = ?', 'unit_id = ?');
      vals.push(finalVisibility, finalUnit);
    }
    for (const f of spec.fields) {
      if (body[f] === undefined) continue;
      if (f === 'visibility' || f === 'unit_id') continue;
      sets.push(`${f} = ?`);
      vals.push(spec.json.includes(f) ? JSON.stringify(body[f] ?? []) : body[f]);
    }

    /**
     * Optimistic concurrency (finding 36). A client that read the row sends
     * its version back; if somebody else saved in between, the update matches
     * zero rows and the caller gets the current copy instead of silently
     * overwriting it. Clients that don't send a version still bump it, so the
     * protection ratchets in as screens adopt it.
     */
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

  /** Soft delete. A performance record that leaves no trace is a record nobody trusts. */
  app.delete(`/api/${table}/:id`, auth, (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return fail(res, 404, 'No such record.');
    if (!canEdit(db, req.user, row)) return fail(res, 403, 'That record is not yours to delete.');

    let detail;
    db.transaction(() => {
      db.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(now(), req.params.id);
      if (table === 'projects') {
        // Finding 15: the client has always said deleting a project unlinks
        // its tasks and activities. Now the server actually does it, so a
        // restored task doesn't point at an archived ghost.
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

/* ── optional activity attachments ───────────────────────────────── */

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
  } catch { /* in-memory tests */ }

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

/* ── bulk import ──────────────────────────────────────────────────── */

/**
 * Fingerprint for server-side duplicate protection (finding 13). Two duty
 * computers importing the same spreadsheet at the same time both pass the
 * client-side duplicate screen; the unique index on this value means exactly
 * one of them lands each row. Normalized so cosmetic whitespace/case changes
 * don't defeat it.
 */
const activityFingerprint = (userId, row) => createHash('sha256')
  .update([
    userId,
    row.date || '',
    String(row.title || '').trim().toLowerCase().replace(/\s+/g, ' '),
    row.quantity ?? '',
    row.dollar_amount ?? '',
  ].join('|'))
  .digest('hex');

/** Bulk create, used by the spreadsheet importer. */
app.post('/api/activities/bulk', auth, (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  // Finding 12: a 2 MB JSON body can carry tens of thousands of rows; the
  // transaction below would happily insert all of them. Cap it.
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
  // With no unit, an imported row has nowhere to live but personal scope
  // (finding 6) — it must not default to a unit visibility with a null unit.
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

// Keep the API envelope stable even for unknown routes and parser/runtime
// failures. Never return an Express HTML stack or a database error to a client.
app.use('/api', (req, res) => fail(res, 404, 'No such API route.', { code: 'not_found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err?.type === 'entity.too.large') {
    return fail(res, 413, 'Request body is too large.', { code: 'too_large' });
  }
  console.error('Unhandled request error:', err);
  return fail(res, 500, 'The server could not complete that request.', { code: 'server_error' });
});

/* ── static SPA ───────────────────────────────────────────────────── */

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

  // Platforms send SIGTERM on deploy. Finish in-flight requests and close the
  // database cleanly, or SQLite is left with a hot WAL to recover on boot.
  const shutdown = (signal) => () => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => {
      try { db.close(); } catch { /* already closed */ }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
}

export { app, db };
