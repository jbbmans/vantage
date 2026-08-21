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
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { getDb, bootstrapAdmin, audit, newId, now, grantRole, revokeRole } from './db.js';
import { VERSION } from './version.js';
import { PERMISSIONS, PERMISSION_LIST, SYSTEM_ROLES } from './roles.js';
import {
  verifyPassword, hashPassword, createSession, destroySession, pruneSessions,
  requireAuth, requireAdmin, burnVerification, invalidateUserSessions,
  listSessions, revokeSessionByPrefix,
} from './auth.js';
import {
  resolveScope, visibleUserIds, visibilityClause, canEdit, canShareTo, ancestorChain, subtreeIds,
  can, canAnywhere, unitsWith, permissionsIn, permissionMap, canManageRole, VISIBILITIES,
} from './permissions.js';
import { checkLoginAllowed, recordLoginFailure, recordLoginSuccess, pruneCounters } from './security.js';
import {
  RECORD_SCHEMAS, READINESS_SCHEMA, USER_SCHEMA, validate, fieldErrorMessage, BULK_LIMITS,
} from './validate.js';
import { validateRoleDefinition, validateRoleGrant, canManageRoleDefinition, isTrueAdmin } from './roleGuard.js';
import { tmpdir } from 'node:os';
import {
  transferMember, deactivateMember, reactivateMember, resetMemberPassword, forceLogout,
  accessReview, primaryAssignment,
} from './lifecycle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = getDb();
pruneSessions(db);

const app = express();
const PRODUCTION = process.env.NODE_ENV === 'production';

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
app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));

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
    res.json({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
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
    defaultVisibility: 'chain',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
  projects: {
    fields: ['name', 'description', 'status', 'priority', 'progress', 'start_date', 'target_date',
      'organization', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'private',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
  tasks: {
    fields: ['title', 'notes', 'status', 'priority', 'due_date', 'project_id', 'assignee_id', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'private',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
  goals: {
    fields: ['title', 'description', 'type', 'category', 'current_value', 'target_value', 'unit_label',
      'status', 'period_start', 'period_end', 'assignee_id', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'private',
    shareFlag: PERMISSIONS.CREATE_SHARED_GOALS,
  },
  recognitions: {
    fields: ['date', 'title', 'type', 'from_whom', 'organization', 'notes', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'chain',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
  trainings: {
    fields: ['date', 'title', 'type', 'hours', 'provider', 'status', 'notes', 'visibility', 'unit_id'],
    json: [],
    defaultVisibility: 'chain',
    shareFlag: PERMISSIONS.CREATE_SHARED_WORK,
  },
};

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
  const { unitIds } = resolveScope(db, user);
  if (unitIds.includes(unitId)) return true;
  return (
    can(db, user, shareFlag, unitId)
    || can(db, user, PERMISSIONS.MANAGE_RECORDS, unitId)
    || isTrueAdmin(db, user)
  );
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
  if (unitId) {
    const within = subtreeIds(db, [unitId]);
    const placeholders = within.map(() => '?').join(',');
    const assigned = db
      .prepare(
        `SELECT 1 FROM assignments WHERE user_id = ? AND unit_id IN (${placeholders})
          AND (end_date IS NULL OR end_date > date('now')) LIMIT 1`
      )
      .get(assigneeId, ...within);
    if (!assigned) return 'That Marine is not assigned in that unit.';
  }
  return null;
}

/* ── auth ─────────────────────────────────────────────────────────── */

app.get('/api/setup', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ needsSetup: n === 0 });
});

app.post('/api/setup', (req, res) => {
  const blocked = checkLoginAllowed(req.ip, '');
  if (blocked) {
    res.setHeader('Retry-After', String(blocked.retryAfter));
    return fail(res, blocked.status, blocked.message, { code: 'throttled' });
  }
  try {
    const created = bootstrapAdmin(req.body || {});
    if (!created) {
      recordLoginFailure(req.ip, '');
      return fail(res, 409, 'Vantage is already set up.');
    }
    res.json(created);
  } catch (err) {
    recordLoginFailure(req.ip, '');
    fail(res, 400, err.message);
  }
});

/**
 * Sign in, behind the layered throttle (finding 17): per-IP, per-account and
 * global counters, failures only, with a burned scrypt verification on unknown
 * usernames so "no such user" is not distinguishable by timing.
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const blocked = checkLoginAllowed(req.ip, username);
  if (blocked) {
    res.setHeader('Retry-After', String(blocked.retryAfter));
    return fail(res, blocked.status, blocked.message, { code: 'throttled' });
  }

  const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').trim());
  // Same response either way — a different message for "no such user" tells an
  // attacker which usernames are real.
  if (!row) {
    burnVerification(password);
    recordLoginFailure(req.ip, username);
    return fail(res, 401, 'Username or password is incorrect.');
  }
  if (!verifyPassword(password || '', row.password_hash)) {
    const crossedThreshold = recordLoginFailure(req.ip, username);
    if (crossedThreshold) {
      audit({ actor_id: row.id, action: 'login_lockout', detail: 'failed-attempt threshold reached for this account' });
    }
    return fail(res, 401, 'Username or password is incorrect.');
  }

  recordLoginSuccess(req.ip, username);
  const { token, expires } = createSession(db, row.id, { ip: req.ip, userAgent: req.get('user-agent') });
  audit({ actor_id: row.id, action: 'login', unit_id: primaryAssignment(db, row.id)?.unit_id || null });
  // Session cookie on purpose (finding 3): no Expires/Max-Age, so closing the
  // browser on a shared workstation ends authentication. The server enforces
  // the inactivity and absolute deadlines regardless.
  res.cookie('vantage_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: PRODUCTION || req.secure,
  });
  // A presence marker the SPA is allowed to read. It carries no credential —
  // it only tells a fresh page load whether asking /api/me is worth a round
  // trip, so a signed-out browser doesn't log a 401 probe on every visit.
  res.cookie('vantage_signed_in', '1', {
    httpOnly: false,
    sameSite: 'strict',
    secure: PRODUCTION || req.secure,
  });
  res.json({ token, expires });
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
    permissions: scope.permissions,
    globalPermissions: scope.globalPermissions,
    topPosition: scope.topPosition,
    manageableUnits: unitsWith(db, req.user, PERMISSIONS.MANAGE_UNITS),
    chain: scope.assignments.length ? ancestorChain(db, scope.assignments[0].unit_id) : [],
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
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
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
  const isCurrent = req.token.startsWith(req.params.sid);
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
  res.json({
    ranks: db.prepare('SELECT * FROM ranks ORDER BY sort').all(),
    billets: db.prepare('SELECT * FROM billets WHERE active = 1 ORDER BY category, title').all(),
    units: db.prepare('SELECT * FROM units WHERE active = 1 ORDER BY echelon, name').all(),
    roles: db.prepare('SELECT * FROM roles ORDER BY position DESC, name').all(),
    permissionCatalogue: PERMISSION_LIST.map((p) => ({ ...p, bit: PERMISSIONS[p.key] })),
  });
});

/**
 * Create a unit. Requires MANAGE_UNITS on the parent, so a section head can
 * stand up their own fire teams without anyone becoming an administrator.
 */
app.post('/api/org/units', auth, (req, res) => {
  const { code, name, short_name, echelon, location, parent_id } = req.body || {};
  const fieldErrors = {};
  if (!name || typeof name !== 'string' || !name.trim()) fieldErrors.name = 'Required.';
  else if (name.length > 120) fieldErrors.name = 'Too long (limit 120 characters).';
  if (!echelon || typeof echelon !== 'string') fieldErrors.echelon = 'Required.';
  else if (echelon.length > 40) fieldErrors.echelon = 'Too long (limit 40 characters).';
  if (short_name && (typeof short_name !== 'string' || short_name.length > 40)) fieldErrors.short_name = 'Too long (limit 40 characters).';
  if (location && (typeof location !== 'string' || location.length > 120)) fieldErrors.location = 'Too long (limit 120 characters).';
  if (Object.keys(fieldErrors).length) return failValidation(res, fieldErrors);
  if (!parent_id) return fail(res, 400, 'Choose a parent unit.');
  if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(parent_id)) {
    return fail(res, 400, 'No such parent unit.');
  }
  if (!can(db, req.user, PERMISSIONS.MANAGE_UNITS, parent_id)) {
    return fail(res, 403, 'You cannot create units under that parent.');
  }

  // Codes are stable keys; generate one when the user doesn't supply it.
  const id = (code || name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!id) return fail(res, 400, 'That name produces an empty unit code.');

  try {
    db.prepare(
      `INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, id, name, short_name || null, echelon, location || null, parent_id, now());
    audit({ actor_id: req.user.id, action: 'create_unit', entity: 'unit', entity_id: id, unit_id: id, detail: name });
    res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(id));
  } catch (err) {
    fail(res, 400, err.message.includes('UNIQUE') ? 'That unit code already exists.' : err.message);
  }
});

app.put('/api/org/units/:unitId', auth, needs(PERMISSIONS.MANAGE_UNITS, (r) => r.params.unitId), (req, res) => {
  const { name, short_name, echelon, location } = req.body || {};
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.unitId);
  if (!unit) return fail(res, 404, 'No such unit.');
  db.prepare('UPDATE units SET name = ?, short_name = ?, echelon = ?, location = ? WHERE id = ?').run(
    name ?? unit.name, short_name ?? unit.short_name, echelon ?? unit.echelon, location ?? unit.location,
    req.params.unitId
  );
  audit({ actor_id: req.user.id, action: 'edit_unit', entity: 'unit', entity_id: req.params.unitId, unit_id: req.params.unitId });
  res.json(db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.unitId));
});

/** Deactivate rather than delete — records point at units. */
app.delete('/api/org/units/:unitId', auth, needs(PERMISSIONS.MANAGE_UNITS, (r) => r.params.unitId), (req, res) => {
  const children = db.prepare('SELECT COUNT(*) AS n FROM units WHERE parent_id = ? AND active = 1').get(req.params.unitId).n;
  if (children) return fail(res, 400, 'That unit still has sub-units. Move or archive those first.');
  const members = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE unit_id = ?').get(req.params.unitId).n;
  if (members) return fail(res, 400, 'Marines are still assigned to that unit.');
  db.prepare('UPDATE units SET active = 0 WHERE id = ?').run(req.params.unitId);
  audit({ actor_id: req.user.id, action: 'archive_unit', entity: 'unit', entity_id: req.params.unitId, unit_id: req.params.unitId });
  res.json({ ok: true });
});

/* ── roles ────────────────────────────────────────────────────────── */

app.get('/api/roles', auth, (req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY position DESC, name').all();
  const { topPosition } = permissionMap(db, req.user);
  res.json({
    roles: roles.map((r) => ({
      ...r,
      manageable: canManageRole(db, req.user, r),
      editable: canManageRoleDefinition(db, req.user, r),
    })),
    topPosition,
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
  const { name, description, color, position, permissions, inherits_down, unit_id } = req.body || {};
  if (color && (typeof color !== 'string' || color.length > 20)) return failValidation(res, { color: 'Not a color.' });

  const def = {
    name,
    description,
    position: position === undefined ? 0 : Number(position),
    permissions: Number(permissions) || 0,
    inherits_down: inherits_down ? 1 : 0,
    unit_id: unit_id || null,
  };
  const verdict = validateRoleDefinition(db, req.user, def);
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${newId().slice(0, 6)}`;
  db.prepare(
    `INSERT INTO roles (id, unit_id, name, description, color, position, permissions, inherits_down, is_default, is_system, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
  ).run(id, def.unit_id, name, description || null, color || '#8D98A8', def.position, def.permissions, def.inherits_down, now());
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
  if (role.is_system) return fail(res, 400, 'Built-in roles cannot be edited. Copy it into a new role instead.');

  const { name, description, color, position, permissions, inherits_down, unit_id } = req.body || {};
  if (color && (typeof color !== 'string' || color.length > 20)) return failValidation(res, { color: 'Not a color.' });

  const def = {
    name: name ?? role.name,
    description: description ?? role.description,
    position: position === undefined ? role.position : Number(position),
    permissions: permissions === undefined ? role.permissions : Number(permissions),
    inherits_down: inherits_down === undefined ? role.inherits_down : (inherits_down ? 1 : 0),
    // Rescoping a role is an edit like any other; the validator checks the
    // actor's authority over BOTH the old and the new scope.
    unit_id: unit_id === undefined ? role.unit_id : (unit_id || null),
  };
  const verdict = validateRoleDefinition(db, req.user, def, { existing: role });
  if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });

  db.prepare(
    'UPDATE roles SET name = ?, description = ?, color = ?, position = ?, permissions = ?, inherits_down = ?, unit_id = ? WHERE id = ?'
  ).run(
    def.name, def.description, color ?? role.color, def.position, def.permissions, def.inherits_down, def.unit_id,
    req.params.roleId
  );
  audit({ actor_id: req.user.id, action: 'edit_role', entity: 'role', entity_id: req.params.roleId, unit_id: def.unit_id });
  res.json(db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId));
});

app.delete('/api/roles/:roleId', auth, (req, res) => {
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(req.params.roleId);
  if (!role) return fail(res, 404, 'No such role.');
  if (role.is_system) return fail(res, 400, 'Built-in roles cannot be deleted.');
  // Finding 7: deleting needs authority over the role's SCOPE, not just a
  // lower position number. Org-wide definitions are an administrator's.
  if (!canManageRoleDefinition(db, req.user, role)) {
    return fail(res, 403, role.unit_id
      ? 'That role belongs to a unit outside your authority.'
      : 'That is an organization-wide role; only an administrator can delete it.');
  }
  db.prepare('DELETE FROM member_roles WHERE role_id = ?').run(req.params.roleId);
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
  if (!isTrueAdmin(db, req.user)) {
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

app.post('/api/org/billets', auth, requireAdmin, (req, res) => {
  const { title, category, echelon, default_role } = req.body || {};
  if (!title) return fail(res, 400, 'A billet needs a title.');
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    db.prepare('INSERT INTO billets (id, title, category, echelon, default_role) VALUES (?, ?, ?, ?, ?)')
      .run(id, title, category || 'Staff', echelon || 'section', default_role || 'member');
    res.json(db.prepare('SELECT * FROM billets WHERE id = ?').get(id));
  } catch (err) {
    fail(res, 400, err.message.includes('UNIQUE') ? 'That billet already exists.' : err.message);
  }
});

/* ── roster and team management ───────────────────────────────────── */

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

const rolesForUsers = (ids) => {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT mr.user_id, mr.unit_id, r.id, r.name, r.color, r.position, r.permissions
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id IN (${ids.map(() => '?').join(',')})
        ORDER BY r.position DESC`
    )
    .all(...ids);
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
  const roleMap = rolesForUsers(ids);
  for (const row of rows) row.roles = roleMap.get(row.id) || [];
  const scope = resolveScope(db, req.user);
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
  });
});

/** One Marine's full record. Every read of somebody else's is logged. */
app.get('/api/team/:id', auth, (req, res) => {
  const allowed = visibleUserIds(db, req.user);
  if (!allowed.includes(req.params.id)) return fail(res, 403, 'That Marine is outside your chain.');

  // Being able to see someone on a roster is not the same as being able to open
  // their record. A Training NCO tracking PME across a section has the first
  // without the second.
  const theirUnit = db
    .prepare('SELECT unit_id FROM assignments WHERE user_id = ? AND is_primary = 1')
    .get(req.params.id)?.unit_id;
  if (req.params.id !== req.user.id) {
    if (!theirUnit || !can(db, req.user, PERMISSIONS.VIEW_MEMBER_DETAIL, theirUnit)) {
      return fail(res, 403, 'You can see this Marine on the roster but not open their record.');
    }
  }

  const person = db.prepare(rosterQuery.replace('%IDS%', '?')).get(req.params.id);
  if (!person) return fail(res, 404, 'No such Marine.');

  // Viewing your own record shows everything. Viewing someone else's shows only
  // what they chose to share — the generic list endpoints already enforce this,
  // and an endpoint that reads straight from the table would quietly undo it.
  const isSelf = req.params.id === req.user.id;
  const scoped = (table) =>
    db
      .prepare(
        `SELECT * FROM ${table}
          WHERE user_id = ? AND deleted_at IS NULL
            ${isSelf ? '' : "AND visibility <> 'private'"}
          ORDER BY date DESC`
      )
      .all(req.params.id);

  if (req.params.id !== req.user.id) {
    audit({
      actor_id: req.user.id, action: 'view_member', entity: 'user',
      entity_id: req.params.id, subject_id: req.params.id, unit_id: theirUnit || null,
    });
  }

  res.json({
    person,
    roles: db.prepare(
      `SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id = ? ORDER BY r.position DESC`
    ).all(req.params.id),
    assignments: db.prepare(
      `SELECT a.*, u.name AS unit_name, u.short_name AS unit_short, b.title AS billet_title
         FROM assignments a JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ?`
    ).all(req.params.id),
    activities: scoped('activities').map((r) => hydrate(r, TABLES.activities)),
    recognitions: scoped('recognitions'),
    trainings: scoped('trainings'),
    goals: db
      .prepare(
        `SELECT * FROM goals
          WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL
            ${isSelf ? '' : "AND visibility <> 'private'"}`
      )
      .all(req.params.id, req.params.id),
  });
});

/** Create a Marine. Leaders create within their scope; admins anywhere. */
app.post('/api/team', auth, (req, res) => {
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
    const verdict = validateRoleGrant(db, req.user, extraRole, unit_id);
    if (!verdict.ok) return fail(res, roleDenyStatus(verdict.code), verdict.message, { code: verdict.code });
  }

  try {
    const id = newId();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO users (id, username, password_hash, last_name, first_name, middle_initial, rank_id, mos, email, eas, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, username.trim(), hashPassword(password), last_name, first_name, middle_initial || null,
        rank_id || null, mos || null, email || null, eas || null, now(), now());

      // Finding 9, Option A: a billet is an organizational position; permissions
      // come only from role grants. The legacy assignments.role column is no
      // longer written — a value there looked authoritative and never was.
      db.prepare(
        `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
         VALUES (?, ?, ?, ?, '', 1, ?, ?)`
      ).run(newId(), id, unit_id, billet_id || null, now().slice(0, 10), now());

      // Everyone starts with the default role; anything more is granted explicitly.
      const defaultRole = db.prepare('SELECT id FROM roles WHERE is_default = 1 LIMIT 1').get();
      if (defaultRole) grantRole(id, defaultRole.id, unit_id, req.user.id);
      if (extraRole) grantRole(id, extraRole.id, unit_id, req.user.id);
    })();

    audit({ actor_id: req.user.id, action: 'create_member', entity: 'user', entity_id: id, subject_id: id, unit_id });
    res.json({ id });
  } catch (err) {
    fail(res, 400, err.message.includes('UNIQUE') ? 'That username is taken.' : err.message);
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

app.post('/api/team/:id/deactivate', auth, (req, res) => {
  const result = deactivateMember(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/reactivate', auth, (req, res) => {
  const result = reactivateMember(db, req.user, req.params.id);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/password', auth, (req, res) => {
  const err = USER_SCHEMA.password(req.body?.password);
  if (err) return failValidation(res, { password: err });
  const result = resetMemberPassword(db, req.user, req.params.id, req.body.password);
  if (!result.ok) return denyResult(res, result);
  res.json(result);
});

app.post('/api/team/:id/logout', auth, (req, res) => {
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
app.get('/api/admin/db', auth, (req, res) => {
  if (!isTrueAdmin(db, req.user)) return fail(res, 403, 'Administrator only.');
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
app.get('/api/admin/backup', auth, async (req, res) => {
  if (!isTrueAdmin(db, req.user)) return fail(res, 403, 'Administrator only.');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  const dest = join(tmpdir(), `vantage-backup-${stamp}-${newId().slice(0, 6)}.db`);
  try {
    await db.backup(dest);
    metaSet('last_backup_at', now());
    audit({ actor_id: req.user.id, action: 'backup', entity: 'database', detail: `backup downloaded (${statSync(dest).size} bytes)` });
    res.download(dest, `vantage-backup-${stamp}.db`, () => {
      try { unlinkSync(dest); } catch { /* already gone */ }
    });
  } catch (err) {
    try { unlinkSync(dest); } catch { /* never written */ }
    fail(res, 500, `Backup failed: ${err.message}`);
  }
});

/** Everything one account can reach, with the smells flagged (finding 27). */
app.get('/api/team/:id/access', auth, (req, res) => {
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
  const allowed = visibleUserIds(db, req.user);
  if (!allowed.includes(req.params.id)) return fail(res, 403, 'Outside your chain.');
  const theirUnit = db.prepare('SELECT unit_id FROM assignments WHERE user_id = ? AND is_primary = 1').get(req.params.id)?.unit_id;
  if (req.params.id !== req.user.id && (!theirUnit || !can(db, req.user, PERMISSIONS.VIEW_MEMBER_DETAIL, theirUnit))) {
    return fail(res, 403, 'You cannot open that record.');
  }
  if (req.params.id !== req.user.id) {
    audit({
      actor_id: req.user.id, action: 'view_readiness', entity: 'user',
      entity_id: req.params.id, subject_id: req.params.id, unit_id: theirUnit || null,
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

  const units = subtreeIds(db, [unitId]);
  const uph = units.map(() => '?').join(',');
  const members = db
    .prepare(
      `SELECT DISTINCT u.id, u.username, u.first_name, u.last_name, u.mos, u.eas, u.active,
              r.abbr AS rank_abbr, a.unit_id
         FROM users u JOIN assignments a ON a.user_id = u.id
         LEFT JOIN ranks r ON r.id = u.rank_id
        WHERE a.unit_id IN (${uph}) AND (a.end_date IS NULL OR a.end_date > date('now'))`
    )
    .all(...units);
  const memberIds = members.map((m) => m.id);

  const out = { unit: { id: unit.id, name: unit.name }, generated_at: now(), members };
  for (const [table, spec] of Object.entries(TABLES)) {
    if (!memberIds.length) { out[table] = []; continue; }
    const mph = memberIds.map(() => '?').join(',');
    out[table] = db
      .prepare(
        `SELECT * FROM ${table}
          WHERE deleted_at IS NULL AND visibility <> 'private'
            AND (user_id IN (${mph}) OR unit_id IN (${uph}))
          ORDER BY created_at DESC`
      )
      .all(...memberIds, ...units)
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
    const { clause, params } = visibilityClause(db, req.user, { table: 't' });
    const rows = db
      .prepare(`SELECT t.* FROM ${table} t WHERE t.deleted_at IS NULL AND ${clause} ORDER BY t.created_at DESC`)
      .all(...params);
    res.json(rows.map((r) => hydrate(r, spec)));
  });

  app.post(`/api/${table}`, auth, (req, res) => {
    const body = req.body || {};
    // Finding 11: the server is the authoritative validator. Reject, don't clamp.
    const errors = validate(RECORD_SCHEMAS[table], body);
    if (errors) return failValidation(res, errors.fieldErrors);

    const visibility = body.visibility || spec.defaultVisibility;
    const scope = resolveScope(db, req.user);
    const unitId = body.unit_id || scope.assignments.find((a) => a.is_primary)?.unit_id || scope.unitIds[0] || null;

    if (!VISIBILITIES.includes(visibility)) return fail(res, 400, 'Unknown visibility.');
    if (visibility !== 'private' && !canShareTo(db, req.user, visibility, unitId, spec.shareFlag)) {
      return fail(res, 403, 'You cannot share to that unit.');
    }
    if (body.unit_id && !unitAllowedForRecord(req.user, body.unit_id, spec.shareFlag)) {
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

    const finalUnit = body.unit_id !== undefined ? body.unit_id : row.unit_id;
    if (body.unit_id !== undefined && body.unit_id !== row.unit_id && body.unit_id !== null
        && !unitAllowedForRecord(req.user, body.unit_id, spec.shareFlag)) {
      return fail(res, 403, 'You are not assigned to that unit and hold no permission there.', {
        code: 'forbidden', fieldErrors: { unit_id: 'Not your unit.' },
      });
    }
    if ('assignee_id' in RECORD_SCHEMAS[table] && body.assignee_id !== undefined) {
      const err = assigneeError(req.user, body.assignee_id, finalUnit);
      if (err) return failValidation(res, { assignee_id: err });
    }

    const sets = ['updated_at = ?', 'version = version + 1'];
    const vals = [now()];
    for (const f of spec.fields) {
      if (body[f] === undefined) continue;
      if (f === 'visibility' && body[f] !== 'private') {
        if (!canShareTo(db, req.user, body[f], finalUnit, spec.shareFlag)) return fail(res, 403, 'You cannot share to that unit.');
      }
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

    if (row.user_id !== req.user.id) {
      audit({ actor_id: req.user.id, action: 'edit', entity: table, entity_id: row.id, subject_id: row.user_id, unit_id: row.unit_id });
    }
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
  const spec = TABLES.activities;
  const created = [];
  const duplicates = [];

  const insert = db.transaction(() => {
    for (let i = 0; i < rows.length; i += 1) {
      const body = rows[i];
      const id = newId();
      const cols = ['id', 'user_id', 'unit_id', 'visibility', 'fingerprint', 'created_at', 'updated_at'];
      const vals = [id, req.user.id, unitId, body.visibility || 'chain', activityFingerprint(req.user.id, body), now(), now()];
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
    actor_id: req.user.id, action: 'import', entity: 'activities', unit_id: unitId,
    detail: `${created.length} rows${duplicates.length ? `, ${duplicates.length} duplicates skipped` : ''}`,
  });
  res.json({ created: created.length, duplicates: duplicates.length, duplicateRows: duplicates });
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
