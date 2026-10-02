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
    if (text.includes('-----BEGIN X509 CRL-----')) {
      for (const block of text.match(/-----BEGIN X509 CRL-----[\s\S]+?-----END X509 CRL-----/g) || []) out.push(block);
    } else if (!text.includes('-----BEGIN') && bytes[0] === 0x30) {
      // DER: an ASN.1 SEQUENCE. A PEM file holding something else (a certificate, a key) is not a CRL and is skipped.
      out.push(`-----BEGIN X509 CRL-----\n${bytes.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END X509 CRL-----\n`);
    }
  }
  if (!out.length) throw new Error(`CAC_CRL_DIR (${dir}) holds no CRL files (.crl, .pem or .der).`);
  return out;
}

/** The newest modification time in the directory, to notice when a refresh job has replaced the CRLs. */
export function crlStamp(dir: string): number {
  let newest = 0;
  for (const name of readdirSync(dir)) newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
  return newest;
}
