/**
 * Vantage application configuration.
 *
 * Non-secret settings live in config/app.yaml so an operator can review the
 * deployment in one place. Environment variables override the handful of
 * values that hosting platforms normally inject. Secrets (setup token and the
 * CAC/PIV proxy shared secret) intentionally never belong in source-controlled
 * YAML.
 *
 * The parser implements the small, deliberately boring YAML subset this file
 * needs: two-space mappings, scalars and inline scalar arrays. Unsupported YAML
 * fails closed at boot instead of being interpreted differently than intended.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SERVER_DIR, '..');

export const DEFAULT_CONFIG = Object.freeze({
  app: {
    name: 'VANTAGE',
    data_mode: 'evaluation',
    region: 'us',
  },
  deployment: {
    trust_proxy: false,
  },
  ui: {
    palette: 'ocean-light',
    default_theme: 'light',
  },
  auth: {
    provider: 'password',
    password_enabled: true,
    self_registration: true,
    cac_piv: {
      enabled: false,
      subject_header: 'x-vantage-cac-subject',
      username_header: 'x-vantage-cac-username',
      first_name_header: 'x-vantage-cac-first-name',
      last_name_header: 'x-vantage-cac-last-name',
      verification_header: 'x-vantage-cac-verified',
      verification_value: 'verified',
      proxy_secret_header: 'x-vantage-proxy-secret',
    },
  },
  sessions: {
    idle_minutes: 60,
    absolute_hours: 12,
    max_active: 8,
  },
  limits: {
    mutations_per_15_minutes: 240,
    registrations_per_15_minutes: 20,
    max_records_per_user: 10000,
    max_database_bytes: 786432000,
    max_guest_days: 30,
  },
  storage: {
    database_path: 'vantage.db',
  },
  attachments: {
    enabled: true,
    max_bytes: 10485760,
    max_per_record: 10,
    allowed_types: [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'text/plain',
      'text/csv',
    ],
  },
  retention: {
    soft_delete: true,
    purge_days: 0,
  },
  experience_metrics: {
    enabled: true,
    mode: 'first_party_aggregate',
  },
});

function stripComment(raw) {
  let quote = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if ((char === '"' || char === "'") && raw[i - 1] !== '\\') {
      quote = quote === char ? null : (quote || char);
    }
    if (char === '#' && !quote && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i).trimEnd();
  }
  return raw;
}

function parseScalar(raw, lineNumber) {
  const value = stripComment(raw).trim();
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('"')) {
    try { return JSON.parse(value); }
    catch { throw new Error(`Invalid quoted value on line ${lineNumber}.`); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('[') && value.endsWith(']')) {
    const inside = value.slice(1, -1).trim();
    if (!inside) return [];
    return inside.split(',').map((item) => parseScalar(item, lineNumber));
  }
  if ('[]{},&*!>|%@`'.includes(value[0])) {
    throw new Error(`Unsupported YAML syntax on line ${lineNumber}.`);
  }
  return value;
}

export function parseConfigYaml(text) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);

  lines.forEach((source, index) => {
    const lineNumber = index + 1;
    if (!source.trim() || source.trimStart().startsWith('#')) return;
    if (source.includes('\t')) throw new Error(`Tabs are not allowed in config YAML (line ${lineNumber}).`);
    const indent = source.match(/^ */)[0].length;
    if (indent % 2 !== 0) throw new Error(`Use two-space indentation in config YAML (line ${lineNumber}).`);
    const content = stripComment(source.slice(indent));
    if (!content.trim()) return;
    const match = content.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!match) throw new Error(`Expected "key: value" on line ${lineNumber}.`);
    const [, key, scalar] = match;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new Error(`Unsafe configuration key on line ${lineNumber}.`);
    }

    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1)?.value;
    if (!parent || Array.isArray(parent)) throw new Error(`Invalid nesting on line ${lineNumber}.`);
    if (Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`Duplicate key "${key}" on line ${lineNumber}.`);

    if (scalar === undefined) {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseScalar(scalar, lineNumber);
    }
  });

  return root;
}

function mergeKnown(defaults, supplied, path = '') {
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults };
  for (const [key, value] of Object.entries(supplied || {})) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      throw new Error(`Unknown configuration setting: ${path}${key}`);
    }
    const baseline = defaults[key];
    if (baseline && typeof baseline === 'object' && !Array.isArray(baseline)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Configuration section ${path}${key} must be a mapping.`);
      }
      out[key] = mergeKnown(baseline, value, `${path}${key}.`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function numberIn(name, value, min, max) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
}

function validateConfig(value) {
  if (!['evaluation', 'operational'].includes(value.app.data_mode)) {
    throw new Error('app.data_mode must be evaluation or operational.');
  }
  if (!['light', 'dark'].includes(value.ui.default_theme)) {
    throw new Error('ui.default_theme must be light or dark.');
  }
  if (!['password', 'cac_piv'].includes(value.auth.provider)) {
    throw new Error('auth.provider must be password or cac_piv.');
  }
  if (value.auth.provider === 'cac_piv' && !value.auth.cac_piv.enabled) {
    throw new Error('auth.provider cannot be cac_piv while auth.cac_piv.enabled is false.');
  }
  for (const [name, flag] of [
    ['auth.password_enabled', value.auth.password_enabled],
    ['auth.self_registration', value.auth.self_registration],
    ['auth.cac_piv.enabled', value.auth.cac_piv.enabled],
    ['attachments.enabled', value.attachments.enabled],
    ['retention.soft_delete', value.retention.soft_delete],
    ['experience_metrics.enabled', value.experience_metrics.enabled],
  ]) {
    if (typeof flag !== 'boolean') throw new Error(`${name} must be true or false.`);
  }
  numberIn('sessions.idle_minutes', value.sessions.idle_minutes, 5, 1440);
  numberIn('sessions.absolute_hours', value.sessions.absolute_hours, 1, 720);
  numberIn('sessions.max_active', value.sessions.max_active, 2, 100);
  numberIn('limits.mutations_per_15_minutes', value.limits.mutations_per_15_minutes, 30, 10000);
  numberIn('limits.registrations_per_15_minutes', value.limits.registrations_per_15_minutes, 1, 1000);
  numberIn('limits.max_records_per_user', value.limits.max_records_per_user, 1000, 1000000);
  numberIn('limits.max_database_bytes', value.limits.max_database_bytes, 104857600, 1099511627776);
  numberIn('limits.max_guest_days', value.limits.max_guest_days, 1, 365);
  numberIn('attachments.max_bytes', value.attachments.max_bytes, 1024, 52428800);
  numberIn('attachments.max_per_record', value.attachments.max_per_record, 1, 50);
  if (!Array.isArray(value.attachments.allowed_types) || !value.attachments.allowed_types.length) {
    throw new Error('attachments.allowed_types must be a non-empty inline array.');
  }
  if (value.retention.purge_days !== 0) {
    throw new Error('retention.purge_days must remain 0; Vantage does not silently purge personnel records.');
  }
  return value;
}

function envNumber(name, current) {
  if (process.env[name] === undefined || process.env[name] === '') return current;
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be numeric.`);
  return parsed;
}

function envBoolean(name, current) {
  if (process.env[name] === undefined || process.env[name] === '') return current;
  const value = String(process.env[name]).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} must be true or false.`);
}

function withEnvironment(config) {
  const next = structuredClone(config);
  if (process.env.VANTAGE_DATA_MODE) next.app.data_mode = String(process.env.VANTAGE_DATA_MODE).toLowerCase();
  if (process.env.TRUST_PROXY !== undefined) next.deployment.trust_proxy = process.env.TRUST_PROXY;
  if (process.env.VANTAGE_DB) next.storage.database_path = process.env.VANTAGE_DB;
  next.auth.self_registration = envBoolean('VANTAGE_SELF_REGISTRATION', next.auth.self_registration);
  next.auth.cac_piv.enabled = envBoolean('VANTAGE_CAC_ENABLED', next.auth.cac_piv.enabled);
  if (process.env.VANTAGE_AUTH_PROVIDER) next.auth.provider = String(process.env.VANTAGE_AUTH_PROVIDER).toLowerCase();
  next.sessions.idle_minutes = envNumber('VANTAGE_IDLE_MINUTES', next.sessions.idle_minutes);
  next.sessions.absolute_hours = envNumber('VANTAGE_SESSION_HOURS', next.sessions.absolute_hours);
  next.sessions.max_active = envNumber('VANTAGE_MAX_SESSIONS', next.sessions.max_active);
  next.limits.mutations_per_15_minutes = envNumber('VANTAGE_MUTATIONS_PER_15_MINUTES', next.limits.mutations_per_15_minutes);
  next.limits.registrations_per_15_minutes = envNumber('VANTAGE_REGISTRATIONS_PER_15_MINUTES', next.limits.registrations_per_15_minutes);
  next.limits.max_records_per_user = envNumber('VANTAGE_MAX_RECORDS_PER_USER', next.limits.max_records_per_user);
  next.limits.max_database_bytes = envNumber('VANTAGE_MAX_DB_BYTES', next.limits.max_database_bytes);
  next.limits.max_guest_days = envNumber('VANTAGE_MAX_GUEST_DAYS', next.limits.max_guest_days);
  return next;
}

function resolveConfigPath() {
  const requested = process.env.VANTAGE_CONFIG || join('config', 'app.yaml');
  return isAbsolute(requested) ? requested : resolve(PROJECT_ROOT, requested);
}

export const configPath = resolveConfigPath();
const supplied = existsSync(configPath) ? parseConfigYaml(readFileSync(configPath, 'utf8')) : {};
export const config = Object.freeze(validateConfig(withEnvironment(mergeKnown(DEFAULT_CONFIG, supplied))));

/**
 * Settings an Instance Operator may change without editing YAML or opening the
 * database.  The allow-list is intentionally narrow: proxy trust, auth proxy
 * headers, storage paths, retention guarantees, and session cryptography stay
 * deployment-owned.  These values are read dynamically by their call sites,
 * so an approved change takes effect as soon as it is saved.
 */
const EDITABLE_CONFIG = Object.freeze({
  ui: ['default_theme'],
  auth: ['self_registration'],
  limits: ['max_guest_days'],
  attachments: ['enabled', 'max_bytes', 'max_per_record'],
  experience_metrics: ['enabled'],
});

export function editableConfig() {
  return Object.fromEntries(
    Object.entries(EDITABLE_CONFIG).map(([section, keys]) => [
      section,
      Object.fromEntries(keys.map((key) => [key, config[section][key]])),
    ])
  );
}

export function applyEditableConfig(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Configuration changes must be an object.');
  }
  const next = structuredClone(config);
  for (const [section, values] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(EDITABLE_CONFIG, section)) {
      throw new Error(`Configuration section ${section} cannot be changed in the app.`);
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error(`Configuration section ${section} must be an object.`);
    }
    for (const [key, value] of Object.entries(values)) {
      if (!EDITABLE_CONFIG[section].includes(key)) {
        throw new Error(`Configuration setting ${section}.${key} cannot be changed in the app.`);
      }
      next[section][key] = value;
    }
  }
  validateConfig(next);
  for (const section of Object.keys(EDITABLE_CONFIG)) Object.assign(config[section], next[section]);
  return editableConfig();
}

export function resolveStoragePath(path) {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export function safeConfig() {
  return {
    app: config.app,
    ui: config.ui,
    auth: {
      provider: config.auth.provider,
      password_enabled: config.auth.password_enabled,
      self_registration: config.auth.self_registration,
      cac_piv: { enabled: config.auth.cac_piv.enabled },
    },
    sessions: config.sessions,
    limits: config.limits,
    attachments: config.attachments,
    retention: config.retention,
    experience_metrics: config.experience_metrics,
    editable: editableConfig(),
    config_file: process.env.VANTAGE_CONFIG || 'config/app.yaml',
  };
}
