import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import { audit, newId, now } from './db.js';
import { singleHeader } from './proxyTrust.js';
import { checkIntegrationReadAllowed } from './security.js';

export const INTEGRATION_SCOPE = 'unit.shared.read';
const TOKEN_MARKER = 'vnt_int';
const TOKEN_PATTERN = /^vnt_int_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;

const digest = (token) => createHash('sha256').update(String(token || ''), 'utf8').digest('hex');

function safeEqualHex(left, right) {
  const supplied = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function publicClient(row) {
  return {
    id: row.id,
    name: row.name,
    unit_id: row.unit_id,
    unit_name: row.unit_name,
    unit_code: row.unit_code,
    scope: row.scope,
    token_hint: `${TOKEN_MARKER}_${row.token_prefix}_…`,
    active: Boolean(row.active),
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

export function listIntegrationClients(db) {
  return db.prepare(
    `SELECT c.*, u.name AS unit_name, u.code AS unit_code
       FROM integration_clients c
       JOIN units u ON u.id = c.unit_id
      ORDER BY c.created_at DESC`
  ).all().map(publicClient);
}

export function issueIntegrationClient(db, { name, unitId, expiresInDays = 90, createdBy }) {
  const cleanName = String(name || '').trim();
  const days = Number(expiresInDays);
  if (cleanName.length < 3 || cleanName.length > 80) throw new Error('Integration name must be 3–80 characters.');
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Integration expiry must be 1–365 days.');
  const unit = db.prepare('SELECT id, name, code FROM units WHERE id = ? AND active = 1').get(unitId);
  if (!unit) throw new Error('Choose an active exact unit.');

  const id = newId();
  const tokenPrefix = randomBytes(9).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  const token = `${TOKEN_MARKER}_${tokenPrefix}_${secret}`;
  const createdAt = now();
  const expiresAt = new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO integration_clients
      (id, name, unit_id, scope, token_prefix, token_hash, active, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(id, cleanName, unit.id, INTEGRATION_SCOPE, tokenPrefix, digest(token), createdBy, createdAt, expiresAt);
  const client = db.prepare(
    `SELECT c.*, u.name AS unit_name, u.code AS unit_code
       FROM integration_clients c JOIN units u ON u.id = c.unit_id WHERE c.id = ?`
  ).get(id);
  return { ...publicClient(client), token };
}

export function revokeIntegrationClient(db, id, revokedBy) {
  const revokedAt = now();
  const result = db.prepare(
    `UPDATE integration_clients
        SET active = 0, revoked_at = ?, revoked_by = ?
      WHERE id = ? AND active = 1`
  ).run(revokedAt, revokedBy, id);
  return result.changes === 1;
}

function unauthorized(res, code = 'invalid_integration_token') {
  res.setHeader('WWW-Authenticate', 'Bearer realm="VANTAGE enterprise API"');
  return res.status(401).json({ error: 'Integration credential is missing, expired, or invalid.', code });
}

export function requireIntegration(db) {
  return (req, res, next) => {
    if (!config.integrations.enabled) {
      return res.status(503).json({ error: 'The enterprise API is disabled.', code: 'integration_api_disabled' });
    }
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      return res.status(400).json({ error: 'The enterprise API requires HTTPS.', code: 'tls_required' });
    }
    const authorization = singleHeader(req, 'authorization');
    const match = String(authorization || '').match(/^Bearer\s+(.+)$/i);
    const token = match?.[1] || '';
    const parsed = token.match(TOKEN_PATTERN);
    if (!parsed) return unauthorized(res);

    const client = db.prepare(
      `SELECT c.*, u.name AS unit_name, u.code AS unit_code
         FROM integration_clients c
         JOIN units u ON u.id = c.unit_id AND u.active = 1
        WHERE c.token_prefix = ? AND c.active = 1`
    ).get(parsed[1]);
    if (!client || client.scope !== INTEGRATION_SCOPE || Date.parse(client.expires_at) <= Date.now()
      || !safeEqualHex(digest(token), client.token_hash)) {
      return unauthorized(res);
    }

    const limited = checkIntegrationReadAllowed(client.id, req.ip);
    if (limited) {
      res.setHeader('Retry-After', String(limited.retryAfter));
      return res.status(429).json({ error: 'Integration request limit reached.', code: 'integration_throttled' });
    }

    const lastUsed = client.last_used_at ? Date.parse(client.last_used_at) : 0;
    if (!lastUsed || Date.now() - lastUsed > 60_000) {
      db.prepare('UPDATE integration_clients SET last_used_at = ? WHERE id = ?').run(now(), client.id);
      audit({
        actor_id: client.created_by,
        action: 'integration_api_read',
        entity: 'integration_client',
        entity_id: client.id,
        unit_id: client.unit_id,
        detail: `${req.method} ${String(req.path || '').slice(0, 160)}`,
      });
    }
    res.setHeader('Vary', 'Authorization');
    req.integration = publicClient(client);
    next();
  };
}

export function requireExactIntegrationUnit(req, res, next) {
  if (req.params.unitId !== req.integration?.unit_id) {
    return res.status(404).json({ error: 'No such integration resource.', code: 'not_found' });
  }
  next();
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.updated_at, row.id]), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
    if (!Number.isFinite(Date.parse(parsed[0])) || !parsed[1]) return null;
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}
