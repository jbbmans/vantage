import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { newId, now } from '../lib/ids.ts';
import { encryptSecret, decryptSecret } from '../lib/crypto.ts';
import { secretsOf } from '../lib/keys.ts';
import { deliver } from './directMail.ts';

export interface Mail { to: string; subject: string; text: string; html: string; kind: string; userId?: string | null; replyTo?: string | null }
export interface SendResult { ok: boolean; queued?: boolean; error?: string }
export interface Mailer {
  enabled: boolean;
  provider: string;
  send: (mail: Mail) => Promise<SendResult>;
  /** Retries direct deliveries a receiver asked to try again later. */
  retryQueued: () => Promise<{ sent: number; failed: number; waiting: number }>;
  outbox: Mail[];
}

/** How long a message is worth retrying: a reset link is dead after 30 minutes, so its email is too. */
const RETRY_WINDOW_MINUTES: Record<string, number> = { reset: 30, test: 60, digest: 12 * 60, email_change: 24 * 60, invite: 48 * 60, team_message: 48 * 60, sign_in: 72 * 60 };
const BACKOFF_MINUTES = [2, 10, 30, 60, 120, 240, 480];
const RESEND_ATTEMPTS = 4;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMailer(config: AppConfig, db: Db): Mailer {
  const { provider, from, resendApiKey, smtpUrl } = config.email;
  const outbox: Mail[] = [];
  const log = (mail: Mail, status: string, error?: string) => {
    const id = newId();
    db.prepare('INSERT INTO email_log (id, user_id, to_address, kind, subject, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, mail.userId ?? null, mail.to, mail.kind, mail.subject, status, error ? String(error).slice(0, 500) : null, now());
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
        if ((res.status !== 429 && res.status < 500) || attempt >= RESEND_ATTEMPTS) throw new Error(error);
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Math.min(10_000, retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt));
      }
    };
  } else if (provider === 'smtp' && smtpUrl) {
    const transporter = nodemailer.createTransport(smtpUrl);
    transport = async (mail) => { await transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: replyTo(mail) }); };
  } else if (provider === 'direct') {
    transport = async (mail) => {
      const result = await deliver(db, config, { from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, replyTo: replyTo(mail) });
      if (result.ok) return { ok: true };
      if (result.permanent) throw new Error(result.error || 'The receiving server refused the message.');
      // A temporary refusal (greylisting, a busy server): keep it, encrypted, and try again on a backoff.
      const logId = log(mail, 'queued', result.error);
      const minutes = RETRY_WINDOW_MINUTES[mail.kind] ?? 24 * 60;
      const at = Date.now();
      db.prepare('INSERT INTO email_queue (id, log_id, to_address, kind, payload, attempts, last_error, next_attempt_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(newId(), logId, mail.to, mail.kind, encryptSecret(config.secret, JSON.stringify({ subject: mail.subject, text: mail.text, html: mail.html, replyTo: replyTo(mail) ?? null, userId: mail.userId ?? null })),
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
      const plain = decryptSecret(secretsOf(config), row.payload);
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
    async send(mail) {
      if (!transport) { log(mail, 'skipped', 'no provider'); return { ok: false, error: 'Email is off on Vantage right now.' }; }
      try {
        const result = await transport(mail);
        if (result && result.queued) return result;
        log(mail, 'sent');
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(mail, 'failed', message);
        console.error('Email send failed:', message);
        return { ok: false, error: message };
      }
    },
  };
}
