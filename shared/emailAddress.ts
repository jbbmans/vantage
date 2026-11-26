/**
 * One plain email address, as Vantage stores and sends it (ADR-0048). One rule reads an address field, each entry of
 * the allowed-domains list and every recipient the mailer is given, so what is stored is what the mailer sends to.
 *
 * The local part has none of what separates addresses, names one, quotes, comments, routes mail on (% and !) or breaks
 * a header line. The domain is read as a URL's host is, which gives its ASCII form (punycode for an international
 * name), and it is taken only when that form means what was written: lower case, stable under compatibility
 * normalization (a full-width or ligature letter is refused), no invisible character, each label starting with a letter
 * or digit and ending in neither a hyphen nor a dot, a lettered top level, and, when written in ASCII, identical to its
 * parsed form (a path, a query or an encoded dot is refused).
 */
const LOCAL = /^[^\s\p{Cc}\p{Cf}@<>,;:"()[\]\\%!]+$/u;
const LABEL = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]{0,62}$/u;
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;
const ASCII = /^[\x21-\x7e]+$/;

/** A domain in its ASCII form, lower case, or null when the string is not a domain by the rule above. */
export function plainDomain(raw: string): string | null {
  const written = raw.toLowerCase().normalize('NFC');
  if (!written || written.length > 253 || written !== written.normalize('NFKC') || IGNORABLE.test(written)) return null;
  const labels = written.split('.');
  if (!labels.every((l) => LABEL.test(l) && !l.endsWith('-'))) return null;
  // A top level of digits only would be an address, not a name.
  if (!/\p{L}/u.test(labels.at(-1)!)) return null;
  let host: string;
  try { host = new URL(`http://${written}/`).hostname; } catch { return null; }
  if (ASCII.test(written)) return host === written ? host : null;
  // An international name: its ASCII form label for label, each within the wire limit.
  const ascii = host.split('.');
  if (ascii.length !== labels.length || host.length > 253) return null;
  for (let i = 0; i < labels.length; i++) {
    if (ascii[i].length > 63) return null;
    if (ASCII.test(labels[i]) ? ascii[i] !== labels[i] : !ascii[i].startsWith('xn--')) return null;
  }
  return host;
}

/** The two parts of one plain address, the domain still as written, or null when the string is not one. */
export function splitPlainAddress(value: string): { local: string; domain: string } | null {
  if (value.length > 254) return null;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!LOCAL.test(local) || !domain.includes('.')) return null;
  return { local, domain };
}

/** The address the mailer sends to: the local part as written at the domain's ASCII form, or null when not one address. */
export function plainAddress(value: string): string | null {
  const parts = splitPlainAddress(value);
  const domain = parts && plainDomain(parts.domain);
  return domain ? `${parts!.local}@${domain}` : null;
}

export const isPlainEmail = (value: string): boolean => plainAddress(value) !== null;
