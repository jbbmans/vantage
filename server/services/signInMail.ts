import type { AppContext, SessionUser } from '../context.ts';
import { issueToken, revokeTokens } from '../auth/tokens.ts';
import { SIGN_IN_SUBJECT, signInMessage } from './mailMessages.ts';
import { notSentMessage } from './email.ts';
import { audit } from './audit.ts';

/**
 * Sign-in details: each person's username and a one-time link to choose their own password. Passwords are stored
 * only as hashes, so there is none to send, and a new one in an inbox would outlive the email. The link is a reset
 * link that lasts long enough to be found over a weekend; nobody's current password changes until they use it.
 */
export const SIGN_IN_LINK_HOURS = 72;
export const MAX_SIGN_IN_BATCH = 25;

interface Account {
  id: string; username: string; email: string | null; first_name: string; last_name: string; rank_abbr: string | null;
  last_login_at: string | null; must_change_password: number; sent_at: string | null;
}

const ACCOUNT_SQL = `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.last_login_at, u.must_change_password, r.abbr AS rank_abbr,
    (SELECT MAX(l.created_at) FROM email_log l WHERE l.user_id = u.id AND l.kind = 'sign_in' AND l.status IN ('sent', 'queued')) AS sent_at
  FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.active = 1`;

const IN_ORG = 'AND u.id IN (SELECT um.user_id FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.org_id = ?)';

/** Every active member of the organization but the sender, split by whether there is an address to send to. */
export function signInAudience(ctx: AppContext, actorId: string, orgId: string) {
  const rows = ctx.db.prepare(`${ACCOUNT_SQL} ${IN_ORG} AND u.id <> ? ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE`).all(orgId, actorId) as Account[];
  const shape = (a: Account) => ({ id: a.id, username: a.username, name: `${a.rank_abbr ? `${a.rank_abbr} ` : ''}${a.last_name}, ${a.first_name}`, email: a.email, last_login_at: a.last_login_at, must_change_password: Boolean(a.must_change_password), sent_at: a.sent_at });
  return {
    emailEnabled: ctx.mailer.enabled,
    provider: ctx.mailer.provider,
    linkHours: SIGN_IN_LINK_HOURS,
    recipients: rows.filter((a) => a.email).map(shape),
    withoutEmail: rows.filter((a) => !a.email).map(shape),
  };
}

export function composeSignInMail(ctx: AppContext, account: Account, sender: SessionUser, url: string, expiresAt: Date) {
  // The most specific membership reads best: the team, and the command above it.
  const membership = ctx.db.prepare(`SELECT un.name, p.name AS parent FROM unit_members um JOIN units un ON un.id = um.unit_id LEFT JOIN units p ON p.id = un.parent_id
    WHERE um.user_id = ? ORDER BY (un.parent_id IS NOT NULL) DESC, um.is_primary DESC, um.joined_at LIMIT 1`).get(account.id) as { name: string; parent: string | null } | undefined;
  const unit = membership ? { name: membership.parent ? `${membership.name}, ${membership.parent}` : membership.name } : undefined;
  const senderName = [sender.rank_id, sender.first_name, sender.last_name].filter(Boolean).join(' ');
  const greeting = account.rank_abbr ? `${account.rank_abbr} ${account.last_name}` : account.first_name;
  const host = new URL(ctx.config.urls.app).host;
  const expires = expiresAt.toLocaleString('en-US', { timeZone: ctx.config.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return signInMessage({
    greeting, username: account.username, returning: Boolean(account.last_login_at), senderName, unitName: unit?.name ?? null, host, url, expires, origin: ctx.config.urls.app,
  });
}

export type SignInResult = { id: string; status: 'sent' | 'queued' | 'failed' | 'skipped'; error?: string };

/** Send one person their details: a member of the organization when one is given, any account for Vantage support. */
export async function sendSignInDetails(ctx: AppContext, sender: SessionUser, userId: string, orgId: string | null, ip?: string): Promise<SignInResult> {
  const account = ctx.db.prepare(`${ACCOUNT_SQL} ${orgId ? IN_ORG : ''} AND u.id = ?`).get(...(orgId ? [orgId] : []), userId) as Account | undefined;
  if (!account) return { id: userId, status: 'skipped', error: orgId ? 'No such active member of this Unit Instance.' : 'No such active account.' };
  if (account.id === sender.id) return { id: userId, status: 'skipped', error: 'That is your own account.' };
  if (!account.email) return { id: userId, status: 'skipped', error: 'No email on file.' };
  // The link sets a password, and where a CAC or the organization's provider is the only way in, none is accepted.
  if (ctx.config.cac.exclusive || ctx.config.oidc.exclusive) return { id: userId, status: 'skipped', error: 'Passwords are off here: people sign in with their CAC or their organization’s sign-in.' };
  if (!ctx.mailer.enabled) return { id: userId, status: 'failed', error: 'Email is off on Vantage right now.' };
  // An address outside the allowed domains gets no new link, so the one its holder may already have keeps working.
  const refused = ctx.mailer.checkRecipient({ to: account.email, subject: SIGN_IN_SUBJECT, kind: 'sign_in', userId: account.id, orgId, actorId: sender.id });
  if (refused) {
    audit(ctx, { actor_id: sender.id, action: 'sign_in_details_sent', category: orgId ? undefined : 'enterprise', entity: 'user', entity_id: account.id, subject_id: account.id, org_id: orgId, detail: `${account.username}; refused; ${refused.error!.slice(0, 200)}`, ip });
    return { id: account.id, status: 'failed', error: refused.error };
  }

  // Only the newest link works, whichever way it was sent.
  revokeTokens(ctx, 'reset', account.id);
  const expiresAt = new Date(Date.now() + SIGN_IN_LINK_HOURS * 3_600_000);
  const { token } = issueToken(ctx, 'reset', { userId: account.id, email: account.email, ttlMinutes: SIGN_IN_LINK_HOURS * 60, createdBy: sender.id, payload: { purpose: 'sign_in', ip: ip ?? null } });
  const url = `${ctx.config.urls.app}/reset?token=${encodeURIComponent(token)}`;
  const mail = composeSignInMail(ctx, account, sender, url, expiresAt);
  const result = await ctx.mailer.send({ to: account.email, subject: mail.subject, text: mail.text, html: mail.html, kind: 'sign_in', userId: account.id, orgId, actorId: sender.id });
  // An undelivered link is one nobody should hold.
  if (!result.ok) revokeTokens(ctx, 'reset', account.id);
  const status = !result.ok ? 'failed' : result.queued ? 'queued' : 'sent';
  // The Unit Manager, and the Unit Instance's trail, get what they can act on; a provider's own words stay in the mail log.
  const shown = result.ok ? null : notSentMessage(result, 'The sign-in details');
  // Sent by Vantage support (no Unit Instance) it is enterprise administration; by a Unit Manager, unit administration.
  audit(ctx, { actor_id: sender.id, action: 'sign_in_details_sent', category: orgId ? undefined : 'enterprise', entity: 'user', entity_id: account.id, subject_id: account.id, org_id: orgId, detail: `${account.username}; ${status}${shown ? `; ${shown.slice(0, 200)}` : ''}`, ip });
  return { id: account.id, status, ...(shown ? { error: shown } : {}) };
}
