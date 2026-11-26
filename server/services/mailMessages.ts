import { layout, type MailContent } from './mailLayout.ts';
import { MIN_PASSWORD_LENGTH } from '../../shared/password.ts';
import { ATTACHMENT_TYPE_NAMES, formatFileSize } from '../../shared/attachments.ts';

/**
 * The seven messages Vantage sends, each from what it needs to say and nothing else: no database, no request. Routes and
 * services gather the facts and send what these return, so every message wears the one layout (mailLayout.ts) and the
 * tests can render all seven from samples (ADR-0048).
 */
export interface MailMessage { subject: string; text: string; html: string }

const message = (subject: string, content: MailContent): MailMessage => ({ subject, ...layout(content) });

/** Subjects a caller needs before the message exists, to check the recipient before it issues a link. */
export const RESET_SUBJECT = 'Reset your Vantage password';
export const EMAIL_CHANGE_SUBJECT = 'Confirm your Vantage email';
export const SIGN_IN_SUBJECT = 'Your Vantage sign-in details';

/** A password reset the account's holder asked for: a link that works once, for 30 minutes. */
export function resetMessage(p: { firstName: string; username: string; url: string; origin: string }): MailMessage {
  return message(RESET_SUBJECT, {
    eyebrow: 'Account recovery',
    title: 'Reset your password',
    preheader: 'A one-time link to choose a new Vantage password. It works for 30 minutes.',
    intro: `${p.firstName}, someone asked to reset the password for your Vantage account. Choose a new one with the button below.`,
    details: [{ label: 'Username', value: p.username, mono: true }],
    cta: { label: 'Choose a new password', url: p.url },
    note: 'This link works once and expires in 30 minutes. If you did not ask for it, ignore this message: your password stays as it is.',
    footer: 'Vantage sent this because a password reset was requested for your account.',
    origin: p.origin,
  });
}

/** Confirming a new address before it replaces the account's: a link that works once, for an hour. */
export function emailChangeMessage(p: { username: string; email: string; url: string; origin: string }): MailMessage {
  return message(EMAIL_CHANGE_SUBJECT, {
    eyebrow: 'Confirm your email',
    title: 'Is this your address?',
    preheader: `Confirm ${p.email} for your Vantage account. The link works for one hour.`,
    intro: 'Confirm that this address belongs to your Vantage account. Once confirmed, it receives your reset links and, if you turn it on, the weekly digest.',
    details: [{ label: 'Username', value: p.username, mono: true }, { label: 'Email', value: p.email }],
    cta: { label: 'Confirm email', url: p.url },
    note: 'The link works once, for one hour. If you did not ask for this, ignore it and nothing changes.',
    footer: 'Vantage sent this because someone added this address to an account.',
    origin: p.origin,
  });
}

/** A leader's invitation to a unit: a link that works once, for seven days. */
export function inviteMessage(p: { inviter: string; unitName: string; unitShortName?: string | null; url: string; origin: string }): MailMessage {
  const label = p.unitShortName || p.unitName;
  return message(`Invitation to ${label} on Vantage`, {
    eyebrow: 'Invitation',
    title: `Join ${label} on Vantage`,
    preheader: `${p.inviter} invited you to ${p.unitName}. The invitation works for seven days.`,
    intro: `${p.inviter} invited you to join ${p.unitName} on Vantage, where your team keeps its work, record and career plans in one place. Accept with the button below. If you already use Vantage, sign in with that account: your record and history come with you.`,
    details: [{ label: 'Unit', value: p.unitName }, { label: 'Invited by', value: p.inviter }],
    cta: { label: 'Accept invitation', url: p.url },
    note: 'The invitation works once, for seven days. If you were not expecting it, you can ignore this message.',
    footer: `${p.inviter} sent this invitation through Vantage.`,
    origin: p.origin,
  });
}

/** The Vantage Administrator console's test: proof the deployment can reach an inbox. */
export function testMessage(p: { appUrl: string; provider: string; from: string; sentAt: string; origin: string }): MailMessage {
  return message('Vantage email test', {
    eyebrow: 'Test message',
    title: 'Email is working',
    intro: 'If you are reading this, Vantage can reach this inbox. Reset links, invitations, sign-in details and digests will arrive the same way.',
    details: [{ label: 'Sent from', value: p.appUrl }, { label: 'Provider', value: p.provider }, { label: 'From address', value: p.from }, { label: 'Sent at', value: p.sentAt }],
    note: 'Check that this message did not land in spam. For direct delivery, open the message headers and look for “dkim=pass”.',
    footer: 'Vantage staff sent this test from the Vantage Administrator console.',
    origin: p.origin,
  });
}

/**
 * Sign-in details (signInMail.ts): the username and a one-time link to choose a password. A person who has signed in
 * before is told nothing changed; a new one is walked through the first sign-in.
 */
export function signInMessage(p: {
  greeting: string; username: string; returning: boolean; senderName: string; unitName: string | null; host: string; url: string; expires: string; origin: string;
}): MailMessage {
  return message(SIGN_IN_SUBJECT, {
    eyebrow: 'Your sign-in details',
    title: p.returning ? `Your Vantage sign-in, ${p.greeting}` : `Welcome to Vantage, ${p.greeting}`,
    preheader: `Your username is ${p.username}. ${p.returning ? 'Keep this for when you need it.' : 'Choose your password to sign in.'}`,
    intro: p.returning
      ? `${p.senderName} sent everyone their Vantage sign-in details. If you already know your password, keep using it: nothing about your account has changed. If you do not, choose a new one with the button below.`
      : `${p.senderName} set up your Vantage account${p.unitName ? ` in ${p.unitName}` : ''}. Here is everything you need to sign in. Keep this email: your username does not change.`,
    details: [
      { label: 'Username', value: p.username, mono: true },
      { label: 'Sign-in page', value: `${p.host}/login` },
      ...(p.unitName ? [{ label: 'Unit', value: p.unitName }] : []),
    ],
    cta: { label: p.returning ? 'Choose a new password' : 'Choose your password', url: p.url },
    sections: p.returning ? [] : [{ heading: 'Signing in for the first time', lines: [
      `Press the button and choose a password of at least ${MIN_PASSWORD_LENGTH} characters. A short phrase you will remember works well.`,
      'You are signed in as soon as it is saved. After that, sign in on the sign-in page with your username and that password.',
      'Then add an authenticator app or a passkey under Settings, so a password alone is never enough.',
    ] }],
    note: `This link works once and expires ${p.expires}. After that, use “Forgot password” on the sign-in page, or ask your leader for a new link. Vantage never asks for your password by email.`,
    footer: `${p.senderName} sent this from ${p.host}. If you were not expecting a Vantage account, you can ignore this message.`,
    origin: p.origin,
  });
}

/**
 * A leader's message to a unit and every team beneath it. Vantage keeps it, and the button opens that copy (ADR-0049).
 * Files it carries are attached to the email; the message names each, with its type and size, in both parts.
 */
export function teamMessage(p: {
  unitLabel: string; unitName: string; subject: string; body: string; senderName: string; replies: boolean; messageUrl: string; marking: string; origin: string;
  files?: ReadonlyArray<{ name: string; mime: string; size: number }>; keptDays: number;
}): MailMessage {
  const files = p.files ?? [];
  return message(`[${p.unitLabel}] ${p.subject}`, {
    eyebrow: `Message to ${p.unitLabel}`,
    title: p.subject,
    intro: p.body,
    details: [{ label: 'From', value: p.senderName }, { label: 'To', value: `${p.unitName} and every team beneath it` }],
    ...(files.length ? { sections: [{ heading: files.length === 1 ? 'Attached file' : `${files.length} attached files`, lines: files.map((f) => `${f.name} (${ATTACHMENT_TYPE_NAMES[f.mime] ?? f.mime}, ${formatFileSize(f.size)})`) }] } : {}),
    cta: { label: 'Read it in Vantage', url: p.messageUrl },
    note: files.length
      ? `${files.length === 1 ? 'The file is' : 'The files are'} attached to this email. Vantage scanned ${files.length === 1 ? 'it' : 'each one'} for malware and found nothing. The message and its files stay in Vantage for ${p.keptDays} days.`
      : `The message stays in Vantage for ${p.keptDays} days.`,
    footer: `${p.senderName} sent this to ${p.unitLabel} through Vantage.${p.replies ? ' Reply to reach them directly.' : ''}`,
    marking: p.marking,
    origin: p.origin,
  });
}

/** The weekly digest (digest.ts works out the figures and sections): counts only, nobody's words. */
export function digestMessage(p: {
  firstName: string; logged: number; impact: string | null; overdue: number; dueSoon: number;
  sections: Array<{ heading: string; lines: string[] }>; appUrl: string; marking: string; origin: string;
}): MailMessage {
  return message(`Vantage weekly: ${p.logged} logged${p.overdue ? `, ${p.overdue} overdue` : ''}`, {
    eyebrow: 'Weekly digest',
    title: `Your week, ${p.firstName}`,
    intro: p.logged ? 'Here is what your record picked up this week and what needs attention next.' : 'Nothing was logged this week. One entry keeps the record current.',
    stats: [
      { label: p.logged === 1 ? 'entry logged' : 'entries logged', value: String(p.logged) },
      ...(p.impact ? [{ label: 'headline impact', value: p.impact, tone: 'good' as const }] : []),
      { label: 'overdue tasks', value: String(p.overdue), ...(p.overdue ? { tone: 'bad' as const } : {}) },
      { label: 'due in 14 days', value: String(p.dueSoon), ...(p.dueSoon ? { tone: 'warn' as const } : {}) },
    ],
    sections: p.sections,
    cta: { label: 'Open Vantage', url: `${p.appUrl}/` },
    footer: 'You receive this weekly digest because it is enabled in Settings. Turn it off there at any time.',
    marking: p.marking,
    origin: p.origin,
  });
}
