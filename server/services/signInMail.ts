import type { AppContext, SessionUser } from '../context.ts';
import { issueToken, revokeTokens } from '../auth/tokens.ts';
import { layout } from './mailLayout.ts';
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

/** Every active account but the sender's, split by whether there is an address to send to. */
export function signInAudience(ctx: AppContext, actorId: string) {
  const rows = ctx.db.prepare(`${ACCOUNT_SQL} AND u.id <> ? ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE`).all(actorId) as Account[];
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
  const host = new URL(ctx.config.publicUrl).host;
  const expires = expiresAt.toLocaleString('en-US', { timeZone: ctx.config.timezone, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const returning = Boolean(account.last_login_at);
  return layout({
    eyebrow: 'Your sign-in details',
    title: returning ? `Your Vantage sign-in, ${greeting}` : `Welcome to Vantage, ${greeting}`,
    preheader: `Your username is ${account.username}. ${returning ? 'Keep this for when you need it.' : 'Choose your password to sign in.'}`,
    intro: returning
      ? `${senderName} sent everyone their Vantage sign-in details. If you already know your password, keep using it: nothing about your account has changed. If you do not, choose a new one with the button below.`
      : `${senderName} set up your Vantage account${unit ? ` in ${unit.name}` : ''}. Here is everything you need to sign in. Keep this email: your username does not change.`,
    details: [
      { label: 'Username', value: account.username, mono: true },
      { label: 'Sign-in page', value: `${host}/login` },
      ...(unit ? [{ label: 'Unit', value: unit.name }] : []),
    ],
    cta: { label: returning ? 'Choose a new password' : 'Choose your password', url },
    sections: returning ? [] : [{ heading: 'Signing in for the first time', lines: [
      'Press the button and choose a password of at least 15 characters. A short phrase you will remember works well.',
      'You are signed in as soon as it is saved. After that, sign in on the sign-in page with your username and that password.',
      'Then add an authenticator app or a passkey under Settings, so a password alone is never enough.',
    ] }],
    note: `This link works once and expires ${expires}. After that, use “Forgot password” on the sign-in page, or ask your leader for a new link. Vantage never asks for your password by email.`,
    footer: `${senderName} sent this from ${host}. If you were not expecting a Vantage account, you can ignore this message.`,
    origin: ctx.config.publicUrl,
  });
}

export type SignInResult = { id: string; status: 'sent' | 'queued' | 'failed' | 'skipped'; error?: string };

export async function sendSignInDetails(ctx: AppContext, sender: SessionUser, userId: string, ip?: string): Promise<SignInResult> {
  const account = ctx.db.prepare(`${ACCOUNT_SQL} AND u.id = ?`).get(userId) as Account | undefined;
  if (!account) return { id: userId, status: 'skipped', error: 'No such active account.' };
  if (account.id === sender.id) return { id: userId, status: 'skipped', error: 'That is your own account.' };
  if (!account.email) return { id: userId, status: 'skipped', error: 'No email on file.' };
  if (!ctx.mailer.enabled) return { id: userId, status: 'failed', error: 'Email is not configured on this server.' };

  // Only the newest link works, whichever way it was sent.
  revokeTokens(ctx, 'reset', account.id);
  const expiresAt = new Date(Date.now() + SIGN_IN_LINK_HOURS * 3_600_000);
  const { token } = issueToken(ctx, 'reset', { userId: account.id, email: account.email, ttlMinutes: SIGN_IN_LINK_HOURS * 60, createdBy: sender.id, payload: { purpose: 'sign_in', ip: ip ?? null } });
  const url = `${ctx.config.publicUrl}/reset?token=${encodeURIComponent(token)}`;
  const mail = composeSignInMail(ctx, account, sender, url, expiresAt);
  const result = await ctx.mailer.send({ to: account.email, subject: 'Your Vantage sign-in details', text: mail.text, html: mail.html, kind: 'sign_in', userId: account.id });
  // An undelivered link is one nobody should hold.
  if (!result.ok) revokeTokens(ctx, 'reset', account.id);
  const status = !result.ok ? 'failed' : result.queued ? 'queued' : 'sent';
  audit(ctx, { actor_id: sender.id, action: 'sign_in_details_sent', entity: 'user', entity_id: account.id, subject_id: account.id, detail: `${account.username}; ${status}${result.error ? `; ${result.error.slice(0, 200)}` : ''}`, ip });
  return { id: account.id, status, ...(result.error ? { error: result.error } : {}) };
}
