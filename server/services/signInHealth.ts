import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { crlInventory, type CrlValidity } from '../auth/crl.ts';
import { seatedOrgRole } from '../authz/scope.ts';
import { now } from '../lib/ids.ts';
import { signInMethods } from './deployment.ts';
import type { HealthCheck, HealthStatus } from './operations.ts';

/**
 * Authentication health for the Vantage Administrator console (ADR-0011): whether each way in this deployment accepts
 * can still let people in, and how sign-in has gone lately. Counts and dates only; never who signed in or from where.
 */

const DAY = 86_400_000;
/** A revocation list this close to its next update means the job that refreshes them has stopped. A choice, not a DoD figure. */
export const CRL_WARN_HOURS = 48;
/** A trusted CA this close to expiring needs its replacement in the bundle. */
export const CA_WARN_DAYS = 30;

const SIGN_IN_ACTIONS = ['login', 'setup', 'register', 'invite_login', 'password_reset_login'] as const;
const REFUSALS = { lockouts: 'login_lockout', cacRejected: 'cac_rejected', oidcRejected: 'oidc_rejected', consoleRefused: 'console_sign_in_refused', stepUpRefused: 'cac_step_up_refused' } as const;

const worst = (statuses: HealthStatus[]): HealthStatus => (statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok');

export interface CrlStatus extends CrlValidity { status: HealthStatus }
export interface CaStatus { subject: string; validTo: string; status: HealthStatus }

function crlStatuses(ctx: AppContext, at: number): CrlStatus[] {
  return crlInventory(ctx.config.cac.crlDir).map((crl) => {
    if (crl.error) return { ...crl, status: 'fail' };
    if (!crl.nextUpdate) return { ...crl, status: 'ok' };
    const left = Date.parse(crl.nextUpdate) - at;
    return { ...crl, status: left <= 0 ? 'fail' : left < CRL_WARN_HOURS * 3_600_000 ? 'warn' : 'ok' };
  });
}

function caStatuses(ctx: AppContext, at: number): CaStatus[] | { error: string } {
  let text: string;
  try { text = readFileSync(ctx.config.cac.caBundlePath, 'utf8'); } catch (e) { return { error: `The CA bundle could not be read: ${(e as Error).message}` }; }
  const out: CaStatus[] = [];
  for (const pem of text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) {
    try {
      const cert = new X509Certificate(pem);
      const until = Date.parse(cert.validTo);
      const subject = /CN=([^\n,]+)/.exec(cert.subject)?.[1] ?? cert.subject.split('\n')[0];
      out.push({ subject, validTo: new Date(until).toISOString(), status: until <= at ? 'fail' : until - at < CA_WARN_DAYS * DAY ? 'warn' : 'ok' });
    } catch { out.push({ subject: 'unreadable certificate', validTo: '', status: 'fail' }); }
  }
  return out;
}

function countsSince(ctx: AppContext, since: string) {
  const rows = ctx.db.prepare(`SELECT action, detail, COUNT(*) AS n FROM audit_log
     WHERE action IN (${[...SIGN_IN_ACTIONS, ...Object.values(REFUSALS)].map(() => '?').join(', ')}) AND at >= ? AND org_id IS NULL AND unit_id IS NULL
     GROUP BY action, detail`).all(...SIGN_IN_ACTIONS, ...Object.values(REFUSALS), since) as Array<{ action: string; detail: string | null; n: number }>;
  const signIns: Record<string, number> = {};
  const refused = Object.fromEntries(Object.keys(REFUSALS).map((k) => [k, 0])) as Record<keyof typeof REFUSALS, number>;
  for (const r of rows) {
    const refusal = (Object.entries(REFUSALS) as Array<[keyof typeof REFUSALS, string]>).find(([, action]) => action === r.action);
    if (refusal) refused[refusal[0]] += r.n;
    // The method is all a sign-in's detail holds; anything else would not be counted here.
    else if (r.detail && /^[a-z+]{1,20}$/.test(r.detail)) signIns[r.detail] = (signIns[r.detail] ?? 0) + r.n;
  }
  return { signIns, ...refused };
}

const lastSignIn = (ctx: AppContext, method: string) =>
  (ctx.db.prepare(`SELECT MAX(at) AS at FROM audit_log WHERE action IN (${SIGN_IN_ACTIONS.map(() => '?').join(', ')}) AND detail = ? AND org_id IS NULL AND unit_id IS NULL`).get(...SIGN_IN_ACTIONS, method) as { at: string | null }).at;

function coverage(ctx: AppContext) {
  const t = now();
  const passwordOnly = `u.totp_enabled = 0 AND NOT EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id = u.id)`;
  // A card that has signed its holder in is a second factor of its own (possession and PIN), for staff as for Unit Managers.
  const staff = ctx.db.prepare(`SELECT COUNT(DISTINCT u.id) AS n, COUNT(DISTINCT CASE WHEN ${passwordOnly} AND u.edipi_verified_at IS NULL THEN u.id END) AS weak
      FROM platform_roles p JOIN users u ON u.id = p.user_id WHERE u.active = 1`).get() as { n: number; weak: number };
  const managers = ctx.db.prepare(`SELECT COUNT(DISTINCT u.id) AS n, COUNT(DISTINCT CASE WHEN ${passwordOnly} AND u.edipi_verified_at IS NULL THEN u.id END) AS weak
      FROM org_roles r JOIN users u ON u.id = r.user_id WHERE u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}`).get(t) as { n: number; weak: number };
  return { staff: staff.n, staffWithoutSecondFactor: staff.weak, managers: managers.n, managersPasswordOnly: managers.weak };
}

/** The checks the Operations page folds into the service's health. */
export function signInChecks(ctx: AppContext, at = Date.now()): HealthCheck[] {
  const { cac } = ctx.config;
  const methods = signInMethods(ctx.config);
  const checks: HealthCheck[] = [];
  if (cac.mode === 'direct') {
    if (cac.revocation === 'crl') {
      const crls = crlStatuses(ctx, at);
      const expired = crls.filter((c) => c.status === 'fail').length;
      const soon = crls.filter((c) => c.status === 'warn').length;
      checks.push({
        id: 'cac_crl', label: 'CAC revocation lists',
        status: !crls.length ? 'fail' : expired ? 'fail' : soon ? 'warn' : 'ok',
        summary: !crls.length ? 'No revocation lists in CAC_CRL_DIR, so every card is refused.'
          : expired ? `${expired} of ${crls.length} lists are expired or unreadable. Cards from those CAs are refused until the lists are refreshed.`
          : soon ? `${soon} of ${crls.length} lists expire within ${CRL_WARN_HOURS} hours. Check the job that refreshes them.`
          : `${crls.length} lists, all current.`,
      });
    } else checks.push({ id: 'cac_crl', label: 'CAC revocation lists', status: 'warn', summary: 'CAC_REVOCATION=off: revoked cards are not refused.' });
    const cas = caStatuses(ctx, at);
    if ('error' in cas) checks.push({ id: 'cac_ca', label: 'Trusted CAs', status: 'fail', summary: cas.error });
    else {
      const expired = cas.filter((c) => c.status === 'fail').length;
      const soon = cas.filter((c) => c.status === 'warn').length;
      checks.push({
        id: 'cac_ca', label: 'Trusted CAs',
        status: !cas.length || expired === cas.length ? 'fail' : expired || soon ? 'warn' : 'ok',
        summary: !cas.length ? 'The CA bundle holds no certificates.' : expired ? `${expired} of ${cas.length} CA certificates have expired.` : soon ? `${soon} of ${cas.length} CA certificates expire within ${CA_WARN_DAYS} days.` : `${cas.length} CA certificates, all current.`,
      });
    }
  }
  const cover = coverage(ctx);
  if (cover.staffWithoutSecondFactor) checks.push({ id: 'staff_second_factor', label: 'Staff second factor', status: 'warn', summary: `${cover.staffWithoutSecondFactor} of ${cover.staff} Vantage staff have no authenticator, passkey or proven CAC.` });
  if (methods.password && cover.managersPasswordOnly) checks.push({ id: 'manager_password_only', label: 'Unit Manager sign-in', status: 'info', summary: `${cover.managersPasswordOnly} of ${cover.managers} Unit Managers sign in with a password alone: no authenticator, passkey or proven CAC.` });
  return checks;
}

/** The Sign-in health page. */
export function signInHealth(ctx: AppContext, at = Date.now()) {
  const { cac, oidc, security } = ctx.config;
  const checks = signInChecks(ctx, at);
  const t = new Date(at).toISOString();
  const open = ctx.db.prepare('SELECT method, COUNT(*) AS n FROM sessions WHERE expires_at > ? AND absolute_expires_at > ? GROUP BY method').all(t, t) as Array<{ method: string; n: number }>;
  const caList = cac.mode === 'direct' ? caStatuses(ctx, at) : null;
  return {
    checkedAt: t,
    status: worst(checks.map((c) => c.status)),
    checks,
    methods: signInMethods(ctx.config),
    cac: {
      mode: cac.mode,
      revocation: cac.mode === 'direct' ? cac.revocation : cac.mode === 'proxy' ? 'gateway' : null,
      crls: cac.mode === 'direct' && cac.revocation === 'crl' ? crlStatuses(ctx, at) : [],
      cas: caList && !('error' in caList) ? caList : [],
      lastSignIn: cac.mode === 'off' ? null : lastSignIn(ctx, 'cac'),
      policyOids: cac.requirePolicyOids.length,
    },
    oidc: {
      enabled: oidc.enabled,
      issuerHost: oidc.enabled ? (() => { try { return new URL(oidc.issuer).host; } catch { return oidc.issuer; } })() : null,
      label: oidc.enabled ? oidc.label : null,
      linkBy: oidc.linkBy,
      exclusive: oidc.exclusive,
      lastSignIn: oidc.enabled ? lastSignIn(ctx, 'oidc') : null,
    },
    lockout: {
      attempts: security.lockoutAttempts,
      minutes: security.lockoutMinutes,
      lockedNow: (ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE locked_until > ?').get(t) as { n: number }).n,
    },
    coverage: coverage(ctx),
    last24h: countsSince(ctx, new Date(at - DAY).toISOString()),
    sessions: { open: open.reduce((n, r) => n + r.n, 0), byMethod: Object.fromEntries(open.map((r) => [r.method, r.n])) },
  };
}
