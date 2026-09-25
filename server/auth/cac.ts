import { X509Certificate, timingSafeEqual } from 'node:crypto';
import { newId, now } from '../lib/ids.ts';
import type { Request } from 'express';
import type { AppContext } from '../context.ts';
import type { CacConfig } from '../config.ts';
import { isEdipi } from '../services/personnel.ts';

export interface CertIdentity {
  edipi: string;
  commonName: string | null;
  issuer: string | null;
  serial: string | null;
  validTo: string | null;
  policies: string[];
}

export class CacError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

/** Constant-time compare that does not leak length through an early return. */
function secretMatches(presented: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(presented || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still do a comparison so the timing does not depend on length alone.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function normalizePem(raw: string): string {
  let text = raw.trim();
  if (text.includes('%')) { try { text = decodeURIComponent(text); } catch { /* leave as-is */ } }
  text = text.replace(/\s*\\n\s*/g, '\n');
  if (text.includes('BEGIN CERTIFICATE')) return text.replace(/\r/g, '');
  // Bare base64 body: wrap it back into PEM so X509Certificate can read it.
  const body = text.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!body) throw new CacError('The certificate header was empty.', 'cac_no_certificate');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Pull the EDIPI out of a `LAST.FIRST.MI.1234567890` common name. */
function edipiFromCommonName(cn: string | null): string | null {
  if (!cn) return null;
  const last = cn.trim().split('.').pop();
  return isEdipi(last) ? last : null;
}

function edipiFromSan(san: string | null): string | null {
  if (!san) return null;
  const upn = san.match(/(?:^|[,\s:])(\d{10})@/);
  if (upn) return upn[1];
  for (const part of san.split(',')) {
    const value = part.trim().replace(/^(?:[A-Za-z][A-Za-z0-9 _-]*:)+/, '');
    if (isEdipi(value)) return value;
  }
  return null;
}

function fieldFromSubject(subject: string, key: string): string | null {
  for (const line of subject.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (k?.trim().toUpperCase() === key) return rest.join('=').trim();
  }
  return null;
}

export function identityFromPem(pem: string, cac: CacConfig, at = new Date()): CertIdentity {
  let cert: X509Certificate;
  try { cert = new X509Certificate(normalizePem(pem)); }
  catch { throw new CacError('That client certificate could not be read.', 'cac_bad_certificate'); }

  const from = new Date(cert.validFrom); const to = new Date(cert.validTo);
  if (Number.isFinite(from.getTime()) && at < from) throw new CacError('That certificate is not valid yet.', 'cac_not_yet_valid');
  if (Number.isFinite(to.getTime()) && at > to) throw new CacError('That certificate has expired.', 'cac_expired');

  const commonName = fieldFromSubject(cert.subject || '', 'CN');
  const fromCn = edipiFromCommonName(commonName);
  const fromSan = edipiFromSan(cert.subjectAltName ?? null);
  // When the certificate states it twice it has to agree with itself.
  if (fromCn && fromSan && fromCn !== fromSan) throw new CacError('That certificate names two different people.', 'cac_ambiguous');
  const edipi = fromSan || fromCn;
  if (!edipi) throw new CacError('That certificate carries no DoD ID.', 'cac_no_edipi');

  const policies = certificatePolicies(cert.raw);
  if (cac.requirePolicyOids.length) {
    const ok = cac.requirePolicyOids.some((oid) => policies.includes(oid));
    if (!ok) throw new CacError('That certificate is not issued under an accepted policy.', 'cac_policy');
  }

  return {
    edipi,
    commonName,
    issuer: fieldFromSubject(cert.issuer || '', 'CN'),
    serial: cert.serialNumber ?? null,
    validTo: Number.isFinite(to.getTime()) ? to.toISOString() : null,
    policies,
  };
}

export function presentedCertificate(req: Request, cac: CacConfig): CertIdentity | null {
  if (cac.mode === 'off') return null;

  if (cac.mode === 'direct') {
    const socket = req.socket as unknown as { authorized?: boolean; authorizationError?: Error; getPeerCertificate?: (d?: boolean) => { raw?: Buffer } };
    if (typeof socket.getPeerCertificate !== 'function') return null;
    const peer = socket.getPeerCertificate();
    if (!peer || !peer.raw || !peer.raw.length) return null;
    if (socket.authorized !== true) throw new CacError(`That certificate was not accepted: ${socket.authorizationError?.message || 'it does not chain to a trusted CA'}.`, 'cac_untrusted');
    return identityFromPem(`-----BEGIN CERTIFICATE-----\n${peer.raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`, cac);
  }

  // proxy mode
  const header = req.get(cac.certHeader);
  if (!header) return null;
  if (!secretMatches(req.get(cac.proxySecretHeader) || '', cac.proxySecret)) return null;
  const verdict = (req.get(cac.verifyHeader) || '').trim();
  if (verdict && verdict.toUpperCase() !== cac.verifySuccessValue.toUpperCase()) {
    throw new CacError('The gateway did not verify that certificate.', 'cac_untrusted');
  }
  if (!verdict) throw new CacError('The gateway did not report a verification result.', 'cac_untrusted');
  return identityFromPem(header, cac);
}

export interface CacResolution {
  identity: CertIdentity;
  userId: string;
  provisioned: boolean;
}

export function resolveAccount(ctx: AppContext, identity: CertIdentity): CacResolution {
  const { db, config } = ctx;
  const existing = db.prepare('SELECT id, active FROM users WHERE edipi = ?').get(identity.edipi) as { id: string; active: number } | undefined;
  if (existing) {
    if (!existing.active) throw new CacError('That account is not active.', 'cac_inactive');
    return { identity, userId: existing.id, provisioned: false };
  }

  if (!config.cac.autoProvisionFromRoster) {
    throw new CacError('No Vantage account is linked to that card. Ask your admin to link it.', 'cac_unlinked');
  }
  const roster = db.prepare("SELECT * FROM personnel_roster WHERE edipi = ? AND status = 'active'").get(identity.edipi) as Record<string, string | null> | undefined;
  if (!roster) throw new CacError('That card is not on this command’s roster.', 'cac_not_on_roster');

  const at = now();
  const id = newId();
  const username = `edipi-${identity.edipi}`;
  db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, middle_initial, rank_id, mos, eas, edipi, identity_source, identity_synced_at, active, created_at, updated_at)
              VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?, 'roster', ?, 1, ?, ?)`)
    .run(id, username, roster.first_name, roster.last_name, roster.middle_initial, roster.rank_id, roster.mos, roster.eas, identity.edipi, at, at, at);
  return { identity, userId: id, provisioned: true };
}

/** Decode a DER OID body into dotted-decimal form. */
function decodeOid(bytes: Buffer): string {
  if (!bytes.length) return '';
  const first = bytes[0];
  const parts = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(value); value = 0; }
  }
  return parts.join('.');
}

function readLength(der: Buffer, pos: number): { length: number; start: number } | null {
  if (pos >= der.length) return null;
  const first = der[pos];
  if (first < 0x80) return { length: first, start: pos + 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || pos + 1 + count > der.length) return null;
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + der[pos + 1 + i];
  return { length, start: pos + 1 + count };
}

export function certificatePolicies(der: Buffer): string[] {
  const marker = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x20]);
  let from = 0;
  for (;;) {
    const at = der.indexOf(marker, from);
    if (at < 0) return [];
    from = at + marker.length;
    let pos = from;
    // An optional BOOLEAN `critical` may sit between the OID and the value.
    if (der[pos] === 0x01) {
      const boolLen = readLength(der, pos + 1);
      if (!boolLen) continue;
      pos = boolLen.start + boolLen.length;
    }
    // The extension value is an OCTET STRING wrapping the real structure.
    if (der[pos] !== 0x04) continue;
    const octet = readLength(der, pos + 1);
    if (!octet) continue;
    const inner = der.subarray(octet.start, octet.start + octet.length);
    // SEQUENCE OF PolicyInformation
    if (inner[0] !== 0x30) continue;
    const seq = readLength(inner, 1);
    if (!seq) continue;
    const out: string[] = [];
    let p = seq.start;
    const end = Math.min(seq.start + seq.length, inner.length);
    while (p < end) {
      if (inner[p] !== 0x30) break;                       // PolicyInformation ::= SEQUENCE
      const info = readLength(inner, p + 1);
      if (!info) break;
      if (inner[info.start] === 0x06) {                   // policyIdentifier ::= OID
        const oid = readLength(inner, info.start + 1);
        if (oid) out.push(decodeOid(inner.subarray(oid.start, oid.start + oid.length)));
      }
      p = info.start + info.length;
    }
    if (out.length) return out;
  }
}
