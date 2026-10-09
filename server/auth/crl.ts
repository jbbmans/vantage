import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The certificate revocation lists a direct-mode server checks every card against. DoD CAs publish their CRLs as
 * DER files; a site may also mirror them as PEM. Both are read, and the TLS layer refuses a card whose serial is
 * listed, or whose issuer has no CRL here at all (it fails closed rather than skipping the check).
 */
export function readCrls(dir: string): Array<string | Buffer> {
  const out: Array<string | Buffer> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isFile() || !/\.(crl|pem|der)$/i.test(name)) continue;
    const bytes = readFileSync(path);
    const text = bytes.toString('latin1');
    if (text.includes(PEM_BEGIN)) {
      for (const block of pemBlocks(text)) out.push(block);
    } else if (!text.includes('-----BEGIN') && bytes[0] === 0x30) {
      // DER: an ASN.1 SEQUENCE. A PEM file holding something else (a certificate, a key) is not a CRL and is skipped.
      out.push(`-----BEGIN X509 CRL-----\n${bytes.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END X509 CRL-----\n`);
    }
  }
  if (!out.length) throw new Error(`CAC_CRL_DIR (${dir}) holds no CRL files (.crl, .pem or .der).`);
  return out;
}

const PEM_BEGIN = '-----BEGIN X509 CRL-----';
const PEM_END = '-----END X509 CRL-----';

/** Each PEM CRL block in a file, found by position: a regular expression rescans the file for every unmatched BEGIN. */
function pemBlocks(text: string): string[] {
  const blocks: string[] = [];
  let at = text.indexOf(PEM_BEGIN);
  while (at >= 0) {
    const end = text.indexOf(PEM_END, at + PEM_BEGIN.length);
    if (end < 0) break;
    blocks.push(text.slice(at, end + PEM_END.length));
    at = text.indexOf(PEM_BEGIN, end + PEM_END.length);
  }
  return blocks;
}

/** The newest modification time in the directory, to notice when a refresh job has replaced the CRLs. */
export function crlStamp(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
  return newest;
}

/**
 * What the Vantage Administrator console shows about each CRL (ADR-0011): whose it is and the window it is good for.
 * A CRL past its nextUpdate is stale, and the TLS layer then refuses every card that CA issued, so an expired list is a
 * sign-in outage waiting for its first user. Read straight from the DER (RFC 5280 §5.1), which Node has no parser for.
 */
export interface CrlValidity { file: string; issuer: string | null; thisUpdate: string | null; nextUpdate: string | null; error: string | null }

/** Each file's reading, until the file changes: a DoD CRL runs to megabytes, and the console asks on every page load. */
const inventoryCache = new Map<string, { stamp: string; entries: CrlValidity[] }>();

export function crlInventory(dir: string): CrlValidity[] {
  const out: CrlValidity[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return [{ file: dir, issuer: null, thisUpdate: null, nextUpdate: null, error: 'The directory cannot be read.' }]; }
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || !/\.(crl|pem|der)$/i.test(name)) continue;
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      const cached = inventoryCache.get(path);
      if (cached?.stamp === stamp) { out.push(...cached.entries); continue; }
      const bytes = readFileSync(path);
      const text = bytes.toString('latin1');
      const blocks = text.includes(PEM_BEGIN)
        ? pemBlocks(text).map((b) => Buffer.from(b.slice(PEM_BEGIN.length, -PEM_END.length).replace(/\s/g, ''), 'base64'))
        : !text.includes('-----BEGIN') && bytes[0] === 0x30 ? [bytes] : [];
      const entries: CrlValidity[] = blocks.map((der) => {
        try { return { file: name, ...crlDates(der), error: null }; } catch (e) { return { file: name, issuer: null, thisUpdate: null, nextUpdate: null, error: (e as Error).message.slice(0, 120) }; }
      });
      inventoryCache.set(path, { stamp, entries });
      out.push(...entries);
    } catch (e) {
      out.push({ file: name, issuer: null, thisUpdate: null, nextUpdate: null, error: (e as Error).message.slice(0, 120) });
    }
  }
  return out;
}

/** One DER element: its tag, where its contents start, and where it ends. Single-byte tags, definite lengths: DER. */
function element(der: Buffer, at: number): { tag: number; start: number; end: number } {
  if (at + 2 > der.length) throw new Error('not a CRL: truncated');
  const tag = der[at];
  let length = der[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    if (!n || n > 4 || start + n > der.length) throw new Error('not a CRL: bad length');
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + der[start + i];
    start += n;
  }
  if (start + length > der.length) throw new Error('not a CRL: truncated');
  return { tag, start, end: start + length };
}

/** UTCTime (0x17, YYMMDDHHMMSSZ) or GeneralizedTime (0x18, YYYYMMDDHHMMSSZ), as RFC 5280 encodes them. */
function asn1Time(der: Buffer, el: { tag: number; start: number; end: number }): string {
  const text = der.subarray(el.start, el.end).toString('latin1');
  const m = el.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(text);
  if (!m) throw new Error('not a CRL: unreadable time');
  const year = el.tag === 0x17 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
}

/** The common name in an X.501 Name: the first value after the commonName OID (2.5.4.3), as a string. */
function commonName(der: Buffer, name: { start: number; end: number }): string | null {
  const oid = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
  const at = der.subarray(name.start, name.end).indexOf(oid);
  if (at < 0) return null;
  const value = element(der, name.start + at + oid.length);
  return der.subarray(value.start, value.end).toString('utf8').slice(0, 200);
}

/** CertificateList → TBSCertList → [version], signature, issuer, thisUpdate, [nextUpdate]. */
export function crlDates(der: Buffer): { issuer: string | null; thisUpdate: string; nextUpdate: string | null } {
  const list = element(der, 0);
  if (list.tag !== 0x30) throw new Error('not a CRL');
  const tbs = element(der, list.start);
  if (tbs.tag !== 0x30) throw new Error('not a CRL');
  let next = element(der, tbs.start);
  if (next.tag === 0x02) next = element(der, next.end); // version, present in a v2 CRL
  if (next.tag !== 0x30) throw new Error('not a CRL: no signature algorithm');
  const issuer = element(der, next.end);
  if (issuer.tag !== 0x30) throw new Error('not a CRL: no issuer');
  const thisEl = element(der, issuer.end);
  const thisUpdate = asn1Time(der, thisEl);
  let nextUpdate: string | null = null;
  if (thisEl.end < tbs.end) {
    const after = element(der, thisEl.end);
    if (after.tag === 0x17 || after.tag === 0x18) nextUpdate = asn1Time(der, after);
  }
  return { issuer: commonName(der, issuer), thisUpdate, nextUpdate };
}
