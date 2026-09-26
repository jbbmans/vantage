import { generateKeyPairSync } from 'node:crypto';
import { resolveMx, resolveNs, resolveTxt, reverse, resolve4, resolve6 } from 'node:dns/promises';
import { connect, isIP } from 'node:net';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.ts';
import type { Db } from '../db/index.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { encryptSecret, decryptSecret } from '../lib/crypto.ts';
import { now } from '../lib/ids.ts';

/**
 * Delivery straight to each recipient's mail server, the way mail servers talk to each other: no relay and no
 * email service. Every message is DKIM-signed with a key this instance generates and keeps (encrypted) in its
 * own database, so receivers can prove it came from the sending domain.
 */

export interface DkimKey { domain: string; selector: string; privateKey: string; publicKey: string; createdAt: string }
export interface Outgoing { from: string; to: string; subject: string; text: string; html: string; replyTo?: string | null }
export interface Delivery { ok: boolean; permanent: boolean; error?: string; server?: string }
export interface PathReport { checkedAt: string; open: boolean; ip: string | null; ptr: string | null; forwardConfirmed: boolean; server: string | null; error?: string }

const DKIM_META = 'mail_dkim';
const PATH_META = 'mail_path';

export const addressOf = (from: string) => (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
export const domainOf = (address: string) => addressOf(address).split('@')[1] || '';

/** The signing key for the sending domain, generated on first use. */
export function dkimKey(db: Db, config: AppConfig): DkimKey {
  const domain = domainOf(config.email.from);
  const stored = metaGet(db, DKIM_META);
  if (stored) {
    const row = JSON.parse(stored) as { domain: string; selector: string; key: string; public: string; created_at: string };
    const privateKey = decryptSecret(config.secret, row.key);
    if (privateKey && row.domain === domain) return { domain, selector: row.selector, privateKey, publicKey: row.public, createdAt: row.created_at };
  }
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const selector = config.email.dkimSelector;
  const createdAt = now();
  metaSet(db, DKIM_META, JSON.stringify({ domain, selector, key: encryptSecret(config.secret, pem), public: pub, created_at: createdAt }));
  return { domain, selector, privateKey: pem, publicKey: pub, createdAt };
}

export function lastPath(db: Db): PathReport | null {
  const raw = metaGet(db, PATH_META);
  return raw ? JSON.parse(raw) as PathReport : null;
}

/** The DNS records the sending domain needs, with the values to paste. */
export function requiredRecords(db: Db, config: AppConfig) {
  const key = dkimKey(db, config);
  const path = lastPath(db);
  const ip = path?.ip;
  return [
    { id: 'dkim', type: 'TXT', host: `${key.selector}._domainkey`, fqdn: `${key.selector}._domainkey.${key.domain}`, value: `v=DKIM1; k=rsa; p=${key.publicKey}`, why: 'Proves each message was signed by this instance. Receivers check it on every message.' },
    { id: 'spf', type: 'TXT', host: '@', fqdn: key.domain, value: mergeSpf(null, ip ?? null), why: 'Names the servers allowed to send for the domain. A domain has one SPF record: if one exists, edit it to add this server rather than adding a second. Check everything shows the merged value. Add every outbound address your host lists.' },
    { id: 'dmarc', type: 'TXT', host: '_dmarc', fqdn: `_dmarc.${key.domain}`, value: 'v=DMARC1; p=quarantine; adkim=r; aspf=r', why: 'Tells receivers what to do with mail that fails the checks. Move to p=reject once test mail lands in the inbox.' },
  ];
}

const txt = async (name: string) => { try { return (await resolveTxt(name)).map((parts) => parts.join('')); } catch { return []; } };
const squash = (value: string) => value.replace(/\s+/g, '').toLowerCase();

/**
 * A domain may publish only one SPF record, so a new sender is added to the one already there (email
 * forwarding usually has one) rather than published beside it.
 */
export function mergeSpf(existing: string | null, ip: string | null): string {
  const mechanism = ip ? `${isIP(ip) === 6 ? 'ip6' : 'ip4'}:${ip}` : 'ip4:<your server’s outbound address>';
  if (!existing) return `v=spf1 ${mechanism} ~all`;
  const parts = existing.trim().split(/\s+/);
  if (parts.includes(mechanism)) return existing.trim();
  const all = parts.findIndex((p) => /^[~?+-]?all$/i.test(p));
  if (all < 0) return [...parts, mechanism, '~all'].join(' ');
  return [...parts.slice(0, all), mechanism, ...parts.slice(all)].join(' ');
}

const DNS_HOSTS: Array<[RegExp, string]> = [[/cloudflare\.com$/i, 'Cloudflare'], [/registrar-servers\.com$/i, 'Namecheap'], [/awsdns/i, 'Amazon Route 53'], [/googledomains\.com$|google\.com$/i, 'Google'], [/domaincontrol\.com$/i, 'GoDaddy'], [/azure-dns/i, 'Azure DNS']];

/** Who hosts the domain's DNS, so the owner knows where to paste the records. */
export async function dnsHostOf(domain: string): Promise<{ name: string | null; nameservers: string[] }> {
  const ns = await resolveNs(domain).catch(() => [] as string[]);
  return { name: DNS_HOSTS.find(([re]) => ns.some((n) => re.test(n)))?.[1] ?? null, nameservers: ns };
}

/** Reads the published records and says which ones are right. */
export async function checkRecords(db: Db, config: AppConfig) {
  const records = requiredRecords(db, config);
  const ip = lastPath(db)?.ip || null;
  const out = [];
  for (const r of records) {
    const found = await txt(r.fqdn);
    let status: 'ok' | 'missing' | 'different' | 'unknown';
    let value = r.value;
    if (r.id === 'dkim') status = found.some((v) => squash(v).includes(squash(`p=${dkimKey(db, config).publicKey}`))) ? 'ok' : found.length ? 'different' : 'missing';
    else if (r.id === 'spf') {
      const spf = found.filter((v) => /^v=spf1/i.test(v.trim()));
      value = mergeSpf(spf[0] || null, ip);
      // Until the path check has seen this server's address, an SPF record cannot be judged either way.
      status = spf.length > 1 ? 'different' : !spf.length ? 'missing' : !ip ? 'unknown' : spf[0].includes(ip) ? 'ok' : 'different';
    } else status = found.some((v) => /^v=DMARC1/i.test(v.trim())) ? 'ok' : 'missing';
    out.push({ ...r, value, status, found });
  }
  return out;
}

/** Where to deliver for a domain: its MX hosts by preference, or the domain itself when it publishes none. */
export async function mailServers(domain: string, config: AppConfig): Promise<Array<{ host: string; port: number }>> {
  if (config.test && config.email.directRoute) {
    const [host, port] = config.email.directRoute.split(':');
    return [{ host, port: Number(port) || 25 }];
  }
  try {
    const mx = (await resolveMx(domain)).sort((a, b) => a.priority - b.priority);
    if (mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')) throw Object.assign(new Error(`${domain} does not accept mail.`), { permanent: true });
    if (mx.length) return mx.map((m) => ({ host: m.exchange, port: 25 }));
  } catch (error) {
    if ((error as { permanent?: boolean }).permanent) throw error;
    const code = (error as { code?: string }).code;
    if (code !== 'ENODATA' && code !== 'ENOTFOUND') throw error;
  }
  const hasAddress = (await resolve4(domain).catch(() => [])).length || (await resolve6(domain).catch(() => [])).length;
  if (!hasAddress) throw Object.assign(new Error(`${domain} has no mail server.`), { permanent: true });
  return [{ host: domain, port: 25 }];
}

/** The name this server gives when it greets a receiver: its own reverse DNS name when that checks out. */
export function heloName(db: Db, config: AppConfig): string {
  if (config.email.helo) return config.email.helo;
  const path = lastPath(db);
  return path?.forwardConfirmed && path.ptr ? path.ptr : domainOf(config.email.from) || 'localhost';
}

/** One attempt at delivery. A 5xx answer is permanent; anything else is worth another try later. */
export async function deliver(db: Db, config: AppConfig, mail: Outgoing): Promise<Delivery> {
  const domain = domainOf(mail.to);
  if (!domain) return { ok: false, permanent: true, error: 'That address has no domain.' };
  let servers: Array<{ host: string; port: number }>;
  try { servers = await mailServers(domain, config); }
  catch (error) { return { ok: false, permanent: Boolean((error as { permanent?: boolean }).permanent), error: (error as Error).message }; }
  const key = dkimKey(db, config);
  const name = heloName(db, config);
  let last: Delivery = { ok: false, permanent: false, error: 'No mail server answered.' };
  for (const server of servers.slice(0, 5)) {
    const transport = nodemailer.createTransport({
      host: server.host, port: server.port, secure: false, name,
      // Opportunistic TLS, as between mail servers: encrypt whenever the receiver offers it.
      tls: { rejectUnauthorized: false, servername: server.host },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      dkim: { domainName: key.domain, keySelector: key.selector, privateKey: key.privateKey },
    });
    try {
      await transport.sendMail({
        from: config.email.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
        replyTo: mail.replyTo || undefined, envelope: { from: addressOf(config.email.from), to: mail.to },
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
      return { ok: true, permanent: false, server: server.host };
    } catch (error) {
      const e = error as { responseCode?: number; response?: string; message: string };
      const permanent = Boolean(e.responseCode && e.responseCode >= 500 && e.responseCode < 600);
      last = { ok: false, permanent, error: `${server.host}: ${(e.response || e.message).slice(0, 300)}`, server: server.host };
      if (permanent) return last;
    } finally {
      transport.close();
    }
  }
  return last;
}

/**
 * Says whether this host can reach mail servers on port 25 at all, and what address it sends from. Gmail's
 * greeting names the connecting address, and that address's reverse DNS is what receivers check.
 */
export async function probePath(db: Db, config: AppConfig): Promise<PathReport> {
  const checkedAt = now();
  let server: string | null = null;
  const save = (report: PathReport) => { metaSet(db, PATH_META, JSON.stringify(report)); return report; };
  try {
    server = config.test && config.email.directRoute ? config.email.directRoute.split(':')[0] : (await resolveMx('gmail.com')).sort((a, b) => a.priority - b.priority)[0].exchange;
    const port = config.test && config.email.directRoute ? Number(config.email.directRoute.split(':')[1]) : 25;
    const transcript = await smtpHello(server, port, domainOf(config.email.from) || 'localhost');
    const ip = transcript.match(/\[([0-9a-f.:]+)\]/i)?.[1] || null;
    let ptr: string | null = null;
    let forwardConfirmed = false;
    if (ip) {
      ptr = (await reverse(ip).catch(() => []))[0] || null;
      if (ptr) forwardConfirmed = [...await resolve4(ptr).catch(() => [] as string[]), ...await resolve6(ptr).catch(() => [] as string[])].includes(ip);
    }
    return save({ checkedAt, open: true, ip, ptr, forwardConfirmed, server });
  } catch (error) {
    return save({ checkedAt, open: false, ip: null, ptr: null, forwardConfirmed: false, server, error: (error as Error).message });
  }
}

function smtpHello(host: string, port: number, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = '';
    let stage = 0;
    const done = (error?: Error) => { clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(buffer); };
    const timer = setTimeout(() => done(new Error(`No answer from ${host}:${port} within 10 seconds. Outbound port ${port} is probably blocked by the host.`)), 10_000);
    socket.on('error', (e) => done(e));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const complete = /(^|\r\n)\d{3} [^\r\n]*\r\n$/.test(buffer);
      if (!complete) return;
      if (stage === 0) { stage = 1; socket.write(`EHLO ${name}\r\n`); }
      else if (stage === 1) { stage = 2; socket.write('QUIT\r\n'); done(); }
    });
  });
}
