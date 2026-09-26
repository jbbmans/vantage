import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { newId, now } from '../lib/ids.ts';
import { encryptSecret, decryptSecret } from '../lib/crypto.ts';
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
const RETRY_WINDOW_MINUTES: Record<string, number> = { reset: 30, test: 60, digest: 12 * 60, email_change: 24 * 60, invite: 48 * 60, team_message: 48 * 60 };
const BACKOFF_MINUTES = [2, 10, 30, 60, 120, 240, 480];

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
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html, ...(replyTo(mail) ? { reply_to: replyTo(mail) } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

  const retryQueued: Mailer['retryQueued'] = async () => {
    const counts = { sent: 0, failed: 0, waiting: 0 };
    if (provider !== 'direct') return counts;
    const due = db.prepare('SELECT * FROM email_queue WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 25').all(now()) as Array<{ id: string; log_id: string | null; to_address: string; kind: string; payload: string; attempts: number; expires_at: string }>;
    for (const row of due) {
      const finish = (status: string, error: string | null) => {
        db.prepare('DELETE FROM email_queue WHERE id = ?').run(row.id);
        if (row.log_id) db.prepare('UPDATE email_log SET status = ?, error = ? WHERE id = ?').run(status, error?.slice(0, 500) ?? null, row.log_id);
      };
      const plain = decryptSecret(config.secret, row.payload);
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

  return {
    enabled: Boolean(transport),
    provider: transport ? provider : 'none',
    outbox,
    retryQueued,
    async send(mail) {
      if (!transport) { log(mail, 'skipped', 'no provider'); return { ok: false, error: 'Email is not configured on this server.' }; }
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

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export function layout({ title, intro, cta, footer, sections = [] }: { title: string; intro: string; cta?: { label: string; url: string }; footer?: string; sections?: Array<{ heading: string; lines: string[] }> }) {
  const text = [
    title, '', intro, '',
    ...sections.flatMap((s) => [s.heading.toUpperCase(), ...s.lines.map((l) => `- ${l}`), '']),
    cta ? `${cta.label}: ${cta.url}` : '', '', footer || 'Sent by Vantage. Records stay on the deployment server.',
  ].filter((l) => l !== undefined).join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
    <div style="background:#0f172a;color:#fff;padding:18px 24px;font-weight:600;letter-spacing:.14em;font-size:12px">VANTAGE</div>
    <div style="padding:24px">
      <h1 style="margin:0 0 12px;font-size:20px">${escape(title)}</h1>
      <p style="margin:0 0 16px;line-height:1.55;color:#374151">${escape(intro).replace(/\r?\n/g, '<br>')}</p>
      ${sections.map((s) => `<h2 style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:18px 0 6px">${escape(s.heading)}</h2><ul style="margin:0;padding-left:18px;color:#374151;line-height:1.55">${s.lines.map((l) => `<li>${escape(l)}</li>`).join('')}</ul>`).join('')}
      ${cta ? `<p style="margin:22px 0 8px"><a href="${escape(cta.url)}" style="display:inline-block;background:#b91c1c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${escape(cta.label)}</a></p><p style="font-size:12px;color:#6b7280;word-break:break-all">${escape(cta.url)}</p>` : ''}
      <p style="margin-top:24px;font-size:12px;color:#9ca3af">${escape(footer || 'Sent by Vantage. Records stay on the deployment server.')}</p>
    </div></div></body></html>`;
  return { text, html };
}
