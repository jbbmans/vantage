import type { AppConfig, DeploymentConfig } from '../config.ts';
import type { AppContext, RuntimeSettings } from '../context.ts';
import type { Db } from '../db/index.ts';
import { conflict, forbidden } from '../lib/errors.ts';

/**
 * The deployment's own rules (ADR-0007): which profile and topology it runs under, which runtime settings that fixes,
 * how many Unit Instances its database may hold, and every connection it can open to anything outside itself.
 */

/** Runtime settings the profile fixes off, with the reason the admin dashboard gives when somebody tries to turn one on. */
export function lockedRuntime(config: AppConfig): Partial<Record<keyof RuntimeSettings, string>> {
  if (config.deployment.profile !== 'mcen') return {};
  return {
    selfRegistration: 'On MCEN, accounts come from invitations, the personnel roster or CAC provisioning, not self-registration.',
    selfServiceUnits: 'On MCEN, Vantage Administrators provision Unit Instances; nobody founds one by creating a top-level unit.',
  };
}

/** Holds the profile's locks on a loaded runtime, whatever an earlier deployment saved. */
export function applyRuntimeLocks(config: AppConfig, runtime: RuntimeSettings) {
  for (const key of Object.keys(lockedRuntime(config))) (runtime as unknown as Record<string, unknown>)[key] = false;
}

/** Refuses a settings change that would turn on what the profile locks. Turning it off again is always allowed. */
export function assertRuntimePatchAllowed(config: AppConfig, patch: Record<string, unknown>) {
  for (const [key, reason] of Object.entries(lockedRuntime(config))) {
    if (patch[key] === true) throw forbidden(reason, 'locked_by_profile');
  }
}

const DEDICATED_TRIGGER = 'dedicated_one_unit_instance';

/**
 * A dedicated deployment's database holds one Unit Instance. The rule lives in the database connection itself, as a
 * temporary trigger, so every path that could found a second one (a top-level unit, the admin dashboard, an archive
 * import, a script) is refused the same way. It is not stored in the file: the configuration decides it on each start.
 */
export function installTopologyGuard(db: Db, deployment: DeploymentConfig) {
  db.exec(`DROP TRIGGER IF EXISTS temp.${DEDICATED_TRIGGER}`);
  if (deployment.topology !== 'dedicated') return;
  const held = (db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n;
  if (held > 1) {
    throw new Error(`VANTAGE_TOPOLOGY=dedicated, but this database holds ${held} Unit Instances. A dedicated deployment holds one; run this database as shared, or move each Unit Instance to a deployment of its own first.`);
  }
  db.exec(`CREATE TEMP TRIGGER ${DEDICATED_TRIGGER} BEFORE INSERT ON main.organizations
    WHEN EXISTS (SELECT 1 FROM main.organizations)
    BEGIN SELECT RAISE(ABORT, 'dedicated_topology: this deployment hosts one Unit Instance'); END`);
}

/** The friendly refusal before the database's: a dedicated deployment that already has its Unit Instance founds no other. */
export function assertCanFoundUnitInstance(ctx: AppContext) {
  if (ctx.config.deployment.topology !== 'dedicated') return;
  if (ctx.db.prepare('SELECT 1 FROM organizations LIMIT 1').get()) {
    throw conflict('This deployment is dedicated to one Unit Instance, and it has one. Another Unit Instance is a deployment of its own.', 'dedicated_topology');
  }
}

/**
 * How the MCEN profile treats a connection. refused: it will not start with it. approval: it reaches a service outside
 * the deployment that needs an approved connection before it is turned on (docs/engineering/INFRASTRUCTURE_QUESTIONS.md).
 * enterprise: a service the deployment itself names, expected to be the enterprise's own (relay, SIEM, scanner, IdP).
 */
export type McenTreatment = 'refused' | 'approval' | 'enterprise';

export interface OutboundConnection {
  id: 'genai' | 'maradmins' | 'email' | 'indexnow' | 'm365' | 'oidc' | 'audit_syslog' | 'clamd';
  purpose: string;
  /** A host, host:port or description. Never a credential: an SMTP URL's user and password are left out. */
  destination: string;
  enabled: boolean;
  /** The settings that turn it on or point it somewhere. */
  settings: string[];
  mcen: McenTreatment;
}

const hostOf = (url: string) => { try { return new URL(url).host || 'unreadable address'; } catch { return 'unreadable address'; } };

/** Every connection Vantage can open from the server, whether this deployment has it on, and where it goes. */
export function outboundConnections(ctx: AppContext): OutboundConnection[] {
  const { config, runtime } = ctx;
  const email = config.email.provider;
  return [
    { id: 'genai', purpose: 'AI drafting and analysis', destination: hostOf(config.ai.baseUrl), enabled: Boolean(runtime.aiEnabled && config.ai.apiKey), settings: ['VANTAGE_AI_ENABLED', 'VANTAGE_GENAI_API_KEY', 'VANTAGE_GENAI_BASE_URL'], mcen: 'approval' },
    { id: 'maradmins', purpose: 'MARADMIN feed', destination: hostOf(config.maradmins.source), enabled: Boolean(runtime.maradminsEnabled), settings: ['VANTAGE_MARADMIN_ENABLED', 'VANTAGE_MARADMIN_SOURCE'], mcen: 'approval' },
    {
      id: 'email', purpose: 'Sign-in links, notices and digests',
      destination: email === 'smtp' ? hostOf(config.email.smtpUrl) : email === 'resend' ? hostOf(config.email.resendUrl) : email === 'direct' ? 'each recipient domain’s mail servers (MX), port 25' : 'none',
      enabled: email === 'smtp' || email === 'resend' || email === 'direct',
      settings: ['VANTAGE_EMAIL_PROVIDER', ...(email === 'smtp' ? ['SMTP_URL'] : email === 'resend' ? ['RESEND_API_KEY'] : [])],
      mcen: email === 'resend' || email === 'direct' ? 'refused' : 'enterprise',
    },
    { id: 'indexnow', purpose: 'Search-engine notices for the public site', destination: hostOf(config.search.indexNowEndpoint), enabled: config.search.indexNow, settings: ['VANTAGE_INDEXNOW'], mcen: 'refused' },
    { id: 'm365', purpose: 'Read-only Outlook mailbox connections', destination: 'Microsoft identity platform and Graph, in the cloud each mailbox is connected in', enabled: Boolean(config.m365.clientId), settings: ['VANTAGE_M365_CLIENT_ID', 'VANTAGE_M365_CLIENT_SECRET', 'VANTAGE_M365_TENANT'], mcen: 'approval' },
    { id: 'oidc', purpose: 'Single sign-on', destination: config.oidc.enabled ? hostOf(config.oidc.issuer) : 'none', enabled: config.oidc.enabled, settings: ['VANTAGE_OIDC_ISSUER', 'VANTAGE_OIDC_CLIENT_ID'], mcen: 'enterprise' },
    { id: 'audit_syslog', purpose: 'Audit forwarding to a SIEM', destination: config.audit.syslog ? hostOf(config.audit.syslog) : 'none', enabled: Boolean(config.audit.syslog), settings: ['VANTAGE_AUDIT_SYSLOG'], mcen: 'enterprise' },
    { id: 'clamd', purpose: 'Malware scanning of uploads', destination: config.intake.clamd ?? 'none', enabled: Boolean(config.intake.clamd), settings: ['VANTAGE_CLAMD'], mcen: 'enterprise' },
  ];
}

/** The ways in this deployment accepts (ADR-0009): what the admin dashboard shows beside what it reaches. */
export function signInMethods(config: AppConfig) {
  const { cac, oidc } = config;
  return {
    password: !cac.exclusive && !oidc.exclusive,
    passkey: true,
    cac: { mode: cac.mode, exclusive: cac.exclusive, autoProvision: cac.autoProvisionFromRoster, revocation: cac.mode === 'direct' ? cac.revocation : cac.mode === 'proxy' ? 'gateway' : null, stepUp: cac.mode !== 'off' },
    oidc: { enabled: oidc.enabled, exclusive: oidc.exclusive, linkBy: oidc.linkBy, autoProvision: oidc.autoProvisionFromRoster },
    // The test suite's bearer tokens. Never true on a deployment: VANTAGE_TEST needs NODE_ENV=test and is refused in production.
    testTokens: config.test,
  };
}

/** What the admin dashboard shows about the deployment: its profile, its topology, and what it reaches. */
export function deploymentPosture(ctx: AppContext) {
  const { deployment, security, email, production, cac, oidc } = ctx.config;
  const notes: string[] = [];
  if (deployment.inferred && production) notes.push('VANTAGE_DEPLOYMENT_PROFILE is not set, so this production deployment runs as legacy-public.');
  if (deployment.profile === 'mcen' && security.browserBackups) notes.push('Browser downloads of the database and the service archive are on (VANTAGE_BROWSER_BACKUPS).');
  if (deployment.profile === 'mcen' && email.provider === 'none') notes.push('No mail relay is set, so sign-in links and notices are not sent by email.');
  if (ctx.config.test) notes.push('VANTAGE_TEST is on: session tokens are accepted in an Authorization header. That is for the test suite only.');
  if (deployment.profile === 'mcen' && cac.mode === 'off' && !oidc.enabled) notes.push('Neither CAC nor organization sign-in is on, so people sign in with passwords and passkeys.');
  if (cac.mode === 'direct' && cac.revocation === 'off') notes.push('CAC_REVOCATION=off: revoked cards are not refused.');
  return {
    profile: deployment.profile,
    inferred: deployment.inferred,
    topology: deployment.topology,
    publicSite: deployment.publicSite,
    unitInstances: (ctx.db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n,
    locked: Object.keys(lockedRuntime(ctx.config)),
    outbound: outboundConnections(ctx),
    signIn: signInMethods(ctx.config),
    notes,
  };
}
