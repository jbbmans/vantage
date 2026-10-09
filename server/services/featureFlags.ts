import type { AppContext, RuntimeSettings } from '../context.ts';
import { lockedRuntime, outboundConnections } from './deployment.ts';

/**
 * Feature flags for the Vantage Administrator console (ADR-0011): the platform-level switches in one place. A runtime
 * flag is changed from the console by a holder of platform.settings and takes effect at once; an environment flag is set
 * when the service is deployed and only read here. Flags are service-wide: a Unit Instance's own settings are its Unit
 * Managers' (Task 6), and nothing here turns a feature on for one Unit Instance alone.
 */

export type RuntimeFlagKey = 'selfRegistration' | 'selfServiceUnits' | 'attachmentsEnabled' | 'maradminsEnabled' | 'aiEnabled';

interface RuntimeFlagSpec { key: RuntimeFlagKey; label: string; hint: string; settings: string[]; outbound?: 'genai' | 'maradmins' }

export const RUNTIME_FLAGS: RuntimeFlagSpec[] = [
  { key: 'selfRegistration', label: 'Self-registration', hint: 'Anyone can create an account from the sign-in page. Otherwise accounts come from invitations, the personnel roster, CAC or organization sign-in.', settings: ['VANTAGE_SELF_REGISTRATION'] },
  { key: 'selfServiceUnits', label: 'Self-service Unit Instances', hint: 'Anyone signed in can found a Unit Instance by creating a top-level unit, up to the limit per person.', settings: [] },
  { key: 'attachmentsEnabled', label: 'File attachments', hint: 'People can attach files to records and comments.', settings: ['VANTAGE_ATTACHMENTS_ENABLED'] },
  { key: 'maradminsEnabled', label: 'MARADMIN feed', hint: 'The server fetches the MARADMIN list and shows it in the app.', settings: ['VANTAGE_MARADMIN_ENABLED'], outbound: 'maradmins' },
  { key: 'aiEnabled', label: 'AI assistance', hint: 'Drafting and analysis with the configured model. Models and limits are on the AI page.', settings: ['VANTAGE_AI_ENABLED'], outbound: 'genai' },
];

export const RUNTIME_FLAG_KEYS = RUNTIME_FLAGS.map((f) => f.key);

/** Why a runtime flag cannot be turned on here, if it cannot. */
function blockedBy(ctx: AppContext, key: RuntimeFlagKey): string | null {
  const locked = lockedRuntime(ctx.config)[key as keyof RuntimeSettings];
  if (locked) return locked;
  if (key === 'aiEnabled' && !ctx.config.ai.apiKey) return 'No model key is configured (VANTAGE_GENAI_API_KEY), so AI assistance cannot run.';
  return null;
}

/** The newest settings change that named this flag, from the platform trail. */
/**
 * The last change to one setting. It matches the setting names the entry records (entity_id), never its text: an
 * announcement that mentions a flag's name is not a change to that flag. Entries from before the names were recorded
 * hold only the names, comma-separated, in their detail.
 */
function lastChange(ctx: AppContext, key: string) {
  return (ctx.db.prepare(`SELECT al.at, al.detail, u.first_name || ' ' || u.last_name AS by FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
     WHERE al.action = 'edit_configuration' AND al.org_id IS NULL AND al.unit_id IS NULL
       AND (instr(',' || al.entity_id || ',', ',' || ? || ',') > 0
         OR (al.entity_id IS NULL AND instr(',' || replace(al.detail, ' ', '') || ',', ',' || ? || ',') > 0))
     ORDER BY al.seq DESC LIMIT 1`).get(key, key) as { at: string; detail: string; by: string | null } | undefined) ?? null;
}

export function featureFlags(ctx: AppContext) {
  const { config, runtime } = ctx;
  const outbound = new Map(outboundConnections(ctx).map((c) => [c.id, c]));
  const runtimeFlags = RUNTIME_FLAGS.map((flag) => {
    const change = lastChange(ctx, flag.key);
    const connection = flag.outbound ? outbound.get(flag.outbound) : undefined;
    return {
      key: flag.key, label: flag.label, hint: flag.hint, settings: flag.settings,
      on: Boolean(runtime[flag.key]),
      blockedBy: blockedBy(ctx, flag.key),
      reaches: connection ? { destination: connection.destination, mcen: connection.mcen } : null,
      changedAt: change?.at ?? null,
      changedBy: change?.by?.trim() || null,
    };
  });
  const environment = [
    { key: 'publicSite', label: 'Public site', on: config.deployment.publicSite, settings: ['VANTAGE_DEPLOYMENT_PROFILE'], hint: 'The marketing pages, search indexing and link previews. Off on MCEN.' },
    { key: 'browserBackups', label: 'Backups through the browser', on: config.security.browserBackups, settings: ['VANTAGE_BROWSER_BACKUPS'], hint: 'Lead Vantage Administrators can download the database and the service archive. Off on MCEN by default; take backups on the server.' },
    { key: 'consentBanner', label: 'Notice and consent banner', on: config.security.consentBanner !== 'off', value: config.security.consentBanner, settings: ['VANTAGE_CONSENT_BANNER', 'VANTAGE_CONSENT_TEXT'], hint: 'Shown, and acknowledged, before the sign-in form.' },
    { key: 'cacExclusive', label: 'CAC only', on: config.cac.exclusive, settings: ['CAC_EXCLUSIVE'], hint: 'Passwords are off; people sign in with their card or a passkey.' },
    { key: 'oidcExclusive', label: 'Organization sign-in only', on: config.oidc.exclusive, settings: ['VANTAGE_OIDC_EXCLUSIVE'], hint: 'Passwords are off; people sign in through the organization’s identity provider.' },
    { key: 'cacAutoProvision', label: 'Accounts from CAC and the roster', on: config.cac.autoProvisionFromRoster, settings: ['CAC_AUTO_PROVISION'], hint: 'A card whose DoD ID is on a Unit Instance’s personnel roster opens an account at first sign-in.' },
    { key: 'oidcAutoProvision', label: 'Accounts from organization sign-in and the roster', on: config.oidc.enabled && config.oidc.autoProvisionFromRoster, settings: ['VANTAGE_OIDC_AUTO_PROVISION'], hint: 'An organization sign-in that matches the personnel roster opens an account.' },
    { key: 'intake', label: 'Spreadsheet intake', on: config.intake.enabled, settings: ['VANTAGE_INTAKE_ENABLED'], hint: 'People can upload spreadsheets for import.' },
    { key: 'scanRequired', label: 'Malware scan required', on: config.intake.scanRequired, settings: ['VANTAGE_SCAN_REQUIRED', 'VANTAGE_CLAMD', 'VANTAGE_SCANNER_COMMAND'], hint: 'An upload is refused unless the scanner passes it.' },
  ];
  return {
    profile: config.deployment.profile,
    runtime: runtimeFlags,
    selfServiceUnitLimit: runtime.selfServiceUnitLimit,
    environment,
  };
}
