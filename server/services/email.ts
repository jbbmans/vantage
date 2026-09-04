import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { newId, now } from '../lib/ids.ts';

export interface Mail { to: string; subject: string; text: string; html: string; kind: string; userId?: string | null }
export interface Mailer {
  enabled: boolean;
  provider: string;
  send: (mail: Mail) => Promise<{ ok: boolean; error?: string }>;
  outbox: Mail[];
}

export function createMailer(config: AppConfig, db: Db): Mailer {
  const { provider, from, resendApiKey, smtpUrl } = config.email;
  const outbox: Mail[] = [];
  const log = (mail: Mail, status: string, error?: string) => {
    db.prepare('INSERT INTO email_log (id, user_id, to_address, kind, subject, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), mail.userId ?? null, mail.to, mail.kind, mail.subject, status, error ? String(error).slice(0, 500) : null, now());
  };

  let transport: ((mail: Mail) => Promise<void>) | null = null;
  if (provider === 'resend' && resendApiKey) {
    transport = async (mail) => {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Resend returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    };
  } else if (provider === 'smtp' && smtpUrl) {
    const transporter = nodemailer.createTransport(smtpUrl);
    transport = async (mail) => { await transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }); };
  } else if (provider === 'memory') {
    transport = async (mail) => { outbox.push(mail); };
  }

  return {
    enabled: Boolean(transport),
    provider: transport ? provider : 'none',
    outbox,
    async send(mail) {
      if (!transport) { log(mail, 'skipped', 'no provider'); return { ok: false, error: 'Email is not configured on this server.' }; }
      try {
        await transport(mail);
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
      <p style="margin:0 0 16px;line-height:1.55;color:#374151">${escape(intro)}</p>
      ${sections.map((s) => `<h2 style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin:18px 0 6px">${escape(s.heading)}</h2><ul style="margin:0;padding-left:18px;color:#374151;line-height:1.55">${s.lines.map((l) => `<li>${escape(l)}</li>`).join('')}</ul>`).join('')}
      ${cta ? `<p style="margin:22px 0 8px"><a href="${escape(cta.url)}" style="display:inline-block;background:#b91c1c;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${escape(cta.label)}</a></p><p style="font-size:12px;color:#6b7280;word-break:break-all">${escape(cta.url)}</p>` : ''}
      <p style="margin-top:24px;font-size:12px;color:#9ca3af">${escape(footer || 'Sent by Vantage. Records stay on the deployment server.')}</p>
    </div></div></body></html>`;
  return { text, html };
}
