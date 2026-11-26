import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { newId, now } from '../lib/ids.ts';
import { encryptSecret, decryptSecret } from '../lib/crypto.ts';
import { secretsOf } from '../lib/keys.ts';
import { deliver } from './directMail.ts';
import { recipientAddress, recipientDomain, recipientRefusal } from '../lib/recipientDomains.ts';
import { audit } from './audit.ts';
import type { AppContext } from '../context.ts';

export interface Mail {
  to: string; subject: string; text: string; html: string; kind: string; userId?: string | null; replyTo?: string | null; orgId?: string | null;
  /** Who caused the message (the leader inviting, the Marine changing their address); none for the service's own. */
  actorId?: string | null;
}
export interface SendResult {
  ok: boolean;
  queued?: boolean;
  /** Why not, for the mail log and the Email tab: a provider's own words, which stay there (see notSentMessage). */
  error?: string;
  /** Not sent: the address is outside the allowed domains or not one address. */
  refused?: boolean;
  /** Not sent and not worth another try: the receiving server, or the provider, said no for good. */
  permanent?: boolean;
  /** The permanent failure concerned the address itself: no mail server for its domain, or the server refused it. */
  recipient?: boolean;
  /** No provider is configured. */
  disabled?: boolean;
}

/**
 * What the person who asked for a message is told when it did not go. The allow-list's reason is meant for them. A
 * provider's own words are not: they can name hosts and addresses, so they stay in the mail log for Vantage
 * Administrators, and the person is told what they can do about it. `what` names the message: "The invitation".
 */
export function notSentMessage(result: SendResult, what: string): string {
  if ((result.refused || result.disabled) && result.error) return result.error;
  if (result.recipient) return `${what} could not be sent: the mail server for that address did not accept it. Check the address.`;
  if (result.permanent) return `${what} could not be sent. A Vantage Administrator can see why on the Email tab.`;
  return `${what} could not be sent. Try again later.`;
}
/** A message the allowed domains kept from leaving: its email_log row, why, and the domain it was for. */
export interface MailRefusal { mail: Pick<Mail, 'to' | 'kind' | 'userId' | 'orgId' | 'actorId'>; logId: string | null; reason: string; domain: string | null }
export interface Mailer {
  enabled: boolean;
  provider: string;
  send: (mail: Mail) => Promise<SendResult>;
  /** Why this address would be refused, or null when it would be sent to (ADR-0048). */
  refusal: (address: string) => string | null;
  /**
   * The recipient check on its own, as send makes it: a refused address is logged and audited and the refusal returned;
   * null when the message may go. For a caller that must not issue a link it cannot deliver.
   */
  checkRecipient: (mail: Omit<Mail, 'text' | 'html'>) => SendResult | null;
  /** The allowed domains, or null for every domain. */
  allowedDomains: readonly string[] | null;
  /** Retries direct deliveries a receiver asked to try again later. */
  retryQueued: () => Promise<{ sent: number; failed: number; waiting: number }>;
  outbox: Mail[];
}

/** How long a message is worth retrying: a reset link is dead after 30 minutes, so its email is too. */
const RETRY_WINDOW_MINUTES: Record<string, number> = { reset: 30, test: 60, digest: 12 * 60, email_change: 24 * 60, invite: 48 * 60, team_message: 48 * 60, sign_in: 72 * 60 };
/** Every kind of message Vantage sends, each with its retry window. */
export const MAIL_KINDS: readonly string[] = Object.keys(RETRY_WINDOW_MINUTES);
const BACKOFF_MINUTES = [2, 10, 30, 60, 120, 240, 480];

/**
 * The relay connection on MCEN (ADR-0040): from SMTP_URL's address and sign-in only, with TLS required. smtps:// starts
 * in TLS; smtp:// must upgrade with STARTTLS or nothing is sent. TLS 1.2 or later, and the relay's certificate checked
 * against Node's bundled roots and NODE_EXTRA_CA_CERTS (the host's own store only under --use-system-ca). These are set
 * after everything the URL gives, so no part of it can weaken them; the start already refused a URL that tried, or one
 * whose sign-in cannot be read.
 */
/** A user name or password from SMTP_URL as written, its %-escapes read; one the start would refuse is kept as it is. */
export function smtpUserinfo(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

export function tlsOnlyTransport(smtpUrl: string) {
  const url = new URL(smtpUrl);
  const secure = url.protocol === 'smtps:';
  const name = url.searchParams.get('name');
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    ...(url.username ? { auth: { user: smtpUserinfo(url.username), pass: smtpUserinfo(url.password) } } : {}),
    ...(name ? { name } : {}),
    secure,
    requireTLS: true,
    ignoreTLS: false,
    opportunisticTLS: false,
    tls: { minVersion: 'TLSv1.2' as const, rejectUnauthorized: true },
  };
}

const RESEND_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A refused message in the audit trail (ADR-0048): what kind, the domain it was for (the address stays in email_log),
 * who caused it and whom it was for, under the Unit Instance it was sent for, or the platform's own trail when none.
 */
export function auditMailRefusal(ctx: AppContext, refused: MailRefusal) {
  const { mail, domain } = refused;
  audit(ctx, {
    actor_id: mail.actorId ?? null, action: 'email_refused', entity: 'email_log', entity_id: refused.logId, subject_id: mail.userId ?? null, org_id: mail.orgId ?? null,
    detail: `${mail.kind}; ${domain ? `${domain} is not on the allowed domains` : 'not one email address'}`,
  });
}

/**
 * `onRefused` hears of every message the allowed domains keep back, at send and at retry; the context passes one that
 * writes the audit entry (auditMailRefusal).
 */
export function createMailer(config: AppConfig, db: Db, onRefused?: (refused: MailRefusal) => void): Mailer {
  const { provider, from, resendApiKey, smtpUrl, allowedDomains } = config.email;
  const refusal = (address: string) => recipientRefusal(allowedDomains, address);
  const outbox: Mail[] = [];
  const log = (mail: Mail, status: string, error?: string) => {
    const id = newId();
    db.prepare('INSERT INTO email_log (id, user_id, to_address, kind, subject, status, error, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, mail.userId ?? null, mail.to, mail.kind, mail.subject, status, error ? String(error).slice(0, 500) : null, now(), mail.orgId ?? null);
    return id;
  };
  const replyTo = (mail: Mail) => mail.replyTo || config.email.replyTo || undefined;

  let transport: ((mail: Mail) => Promise<void | SendResult>) | null = null;
  if (provider === 'resend' && resendApiKey) {
    transport = async (mail) => {
      // One key for every attempt, so a retry after a lost answer cannot deliver the message twice.
      const idempotencyKey = newId();
      for (let attempt = 1; ; attempt += 1) {
        const res = await fetch(config.email.resendUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html, ...(replyTo(mail) ? { reply_to: replyTo(mail) } : {}) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) return;
        const error = `Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
        // Resend allows a few requests a second, and emailing a whole roster reaches that. Wait as told, then retry.
        // A 4xx other than the rate limit is Resend refusing the request itself, and another try would get the same answer.
        if ((res.status !== 429 && res.status < 500) || attempt >= RESEND_ATTEMPTS) throw Object.assign(new Error(error), { permanent: res.status !== 429 && res.status < 500 });
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Math.min(10_000, retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt));
      }
    };
  } else if (provider === 'smtp' && smtpUrl) {
    const transporter = nodemailer.createTransport(config.email.requireTls ? tlsOnlyTransport(smtpUrl) : smtpUrl);
    transport = async (mail) => { await transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: replyTo(mail) }); };
  } else if (provider === 'direct') {
    transport = async (mail) => {
      const result = await deliver(db, config, { from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: replyTo(mail) });
      if (result.ok) return { ok: true };
      if (result.permanent) throw Object.assign(new Error(result.error || 'The receiving server refused the message.'), { permanent: true, recipient: Boolean(result.recipient) });
      // A temporary refusal (greylisting, a busy server): keep it, encrypted, and try again on a backoff.
      const logId = log(mail, 'queued', result.error);
      const minutes = RETRY_WINDOW_MINUTES[mail.kind] ?? 24 * 60;
      const at = Date.now();
      db.prepare('INSERT INTO email_queue (id, log_id, to_address, kind, payload, attempts, last_error, next_attempt_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(newId(), logId, mail.to, mail.kind, encryptSecret(config.secret, JSON.stringify({ subject: mail.subject, text: mail.text, html: mail.html, replyTo: replyTo(mail) ?? null, userId: mail.userId ?? null, actorId: mail.actorId ?? null })),
          result.error?.slice(0, 500) ?? null, new Date(at + BACKOFF_MINUTES[0] * 60_000).toISOString(), new Date(at + minutes * 60_000).toISOString(), now());
      return { ok: true, queued: true };
    };
  } else if (provider === 'memory') {
    transport = async (mail) => { outbox.push(mail); };
  }

  const retryBatch: Mailer['retryQueued'] = async () => {
    const counts = { sent: 0, failed: 0, waiting: 0 };
    // Switching providers must not retain old encrypted queue payloads beyond their lifetime.
    counts.failed = db.transaction(() => {
      const at = now();
      db.prepare("UPDATE email_log SET status = 'failed', error = 'The queued message expired before it could be delivered.' WHERE id IN (SELECT log_id FROM email_queue WHERE expires_at <= ?)").run(at);
      return db.prepare('DELETE FROM email_queue WHERE expires_at <= ?').run(at).changes;
    })();
    if (provider !== 'direct') return counts;
    const due = db.prepare('SELECT * FROM email_queue WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25').all(now()) as Array<{ id: string; log_id: string | null; to_address: string; kind: string; payload: string; attempts: number; expires_at: string }>;
    for (const row of due) {
      const finish = (status: string, error: string | null) => {
        db.prepare('DELETE FROM email_queue WHERE id = ?').run(row.id);
        if (row.log_id) db.prepare('UPDATE email_log SET status = ?, error = ? WHERE id = ?').run(status, error?.slice(0, 500) ?? null, row.log_id);
      };
      if (row.expires_at <= now()) {
        finish('failed', 'The queued message expired before it could be delivered.');
        counts.failed++;
        continue;
      }
      // The list can change while a message waits; it is checked again before every attempt.
      const refused = refusal(row.to_address);
      const plain = decryptSecret(secretsOf(config), row.payload);
      if (refused) {
        const sent = row.log_id ? db.prepare('SELECT user_id, org_id FROM email_log WHERE id = ?').get(row.log_id) as { user_id: string | null; org_id: string | null } | undefined : undefined;
        // Who caused it is in the sealed payload; one queued before it was kept there, or unreadable, names nobody.
        let actorId: string | null = null;
        try { actorId = plain ? (JSON.parse(plain) as { actorId?: string | null }).actorId ?? null : null; } catch { actorId = null; }
        finish('refused', refused);
        counts.failed++;
        onRefused?.({ mail: { to: row.to_address, kind: row.kind, userId: sent?.user_id ?? null, orgId: sent?.org_id ?? null, actorId }, logId: row.log_id, reason: refused, domain: recipientDomain(row.to_address) });
        continue;
      }
      if (!plain) { finish('failed', 'The queued message could not be read with this instance secret.'); counts.failed++; continue; }
      const body = JSON.parse(plain) as { subject: string; text: string; html: string; replyTo: string | null };
      const result = await deliver(db, config, { from, to: row.to_address, subject: body.subject, text: body.text, html: body.html, replyTo: body.replyTo });
      if (result.ok) { finish('sent', null); counts.sent++; continue; }
      const next = new Date(Date.now() + (BACKOFF_MINUTES[Math.min(row.attempts, BACKOFF_MINUTES.length - 1)] * 60_000));
      if (result.permanent || next.toISOString() > row.expires_at) {
        finish('failed', `${result.permanent ? '' : `gave up after ${row.attempts + 1} attempts: `}${result.error || 'no answer'}`);
        counts.failed++;
      } else {
        db.prepare('UPDATE email_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?').run(result.error?.slice(0, 500) ?? null, next.toISOString(), row.id);
        counts.waiting++;
      }
    }
    return counts;
  };
  const checkRecipient: Mailer['checkRecipient'] = (mail) => {
    // With no provider nothing leaves anyway, and send says so.
    if (!transport) return null;
    const refused = refusal(mail.to);
    if (!refused) return null;
    const logId = log({ ...mail, text: '', html: '' }, 'refused', refused);
    onRefused?.({ mail, logId, reason: refused, domain: recipientDomain(mail.to) });
    return { ok: false, refused: true, error: refused };
  };

  // A batch can outlast the scheduler's interval. Share it instead of sending the same rows twice.
  let retryInFlight: ReturnType<Mailer['retryQueued']> | null = null;
  const retryQueued: Mailer['retryQueued'] = () => {
    retryInFlight ??= retryBatch().finally(() => { retryInFlight = null; });
    return retryInFlight;
  };

  return {
    enabled: Boolean(transport),
    provider: transport ? provider : 'none',
    outbox,
    retryQueued,
    refusal,
    allowedDomains,
    checkRecipient,
    async send(mail) {
      if (!transport) { log(mail, 'skipped', 'no provider'); return { ok: false, disabled: true, error: 'Email is off on Vantage right now.' }; }
      // The one check every message passes before any provider sees it.
      const refused = checkRecipient(mail);
      if (refused) return refused;
      // The provider gets the address the check read: the local part as written, the domain in its ASCII form.
      const outgoing = { ...mail, to: recipientAddress(mail.to) ?? mail.to };
      try {
        const result = await transport(outgoing);
        if (result && result.queued) return result;
        log(mail, 'sent');
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(mail, 'failed', message);
        console.error('Email send failed:', message);
        // The direct transport says when a failure is final and whether the address was the trouble; the SMTP relay's
        // answer says the same in its code (a 5xx) and the command it refused (nodemailer names it).
        const e = error as { permanent?: boolean; recipient?: boolean; responseCode?: number; command?: string };
        const permanent = e.permanent ?? Boolean(e.responseCode && e.responseCode >= 500 && e.responseCode < 600);
        const recipient = e.recipient ?? (permanent && e.command === 'RCPT TO');
        return { ok: false, error: message, permanent, recipient };
      }
    },
  };
}
