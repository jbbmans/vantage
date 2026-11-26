import { plainAddress, plainDomain, splitPlainAddress } from '../../shared/emailAddress.ts';

/**
 * Who Vantage may email (VANTAGE_EMAIL_ALLOWED_DOMAINS, ADR-0048). An entry names one domain, or with "*." in front every
 * subdomain of one (not the domain itself). With no list every domain is allowed; on MCEN the start refuses to send mail
 * without one. Whatever the list, a message goes to one plain address, read by the rule the address fields use
 * (shared/emailAddress.ts): a list, a display name or a quoted part could carry a second recipient past the check, so
 * none is accepted, and the message goes to the ASCII form of the domain the check read.
 */

/** A host name in its ASCII form, lower case, or null when it is not one (the shared rule). */
export const asciiDomain = plainDomain;

/**
 * The list as written, each entry in its plain form (`usmc.mil`, `*.navy.mil`), or null for none. Entries that are not
 * domains come back in `problems`, word for word, so the start can name them.
 */
export function parseAllowedDomains(raw: string | undefined): { domains: string[] | null; problems: string[] } {
  const items = String(raw ?? '').split(/[\s,;]+/).filter(Boolean);
  const domains = new Set<string>();
  const problems: string[] = [];
  for (const item of items) {
    let value = item.toLowerCase().replace(/^@/, '');
    const wildcard = value.startsWith('*.');
    if (wildcard) value = value.slice(2);
    const domain = asciiDomain(value);
    // A single name ("mil") receives no mail; "*.mil" is how to name everything under one.
    if (!domain || (!wildcard && !domain.includes('.'))) problems.push(item);
    else domains.add(wildcard ? `*.${domain}` : domain);
  }
  return { domains: domains.size ? [...domains] : null, problems };
}

/** The domain an address is at, in ASCII lower case, or null when the string is not one plain address. */
export function recipientDomain(address: string): string | null {
  const parts = splitPlainAddress(address);
  return parts ? plainDomain(parts.domain) : null;
}

/** The address as the mailer sends it (the domain in ASCII), or null when the string is not one plain address. */
export const recipientAddress = plainAddress;

/** Whether a domain is on the list: an exact entry, or under a "*." entry. No list allows every domain. */
export function domainAllowed(domains: readonly string[] | null, domain: string): boolean {
  if (!domains) return true;
  return domains.some((entry) => entry.startsWith('*.') ? domain.endsWith(entry.slice(1)) : domain === entry);
}

/** The list in words: "usmc.mil or mail.mil", "usmc.mil, mail.mil or any subdomain of navy.mil". */
export function describeAllowedDomains(domains: readonly string[]): string {
  const words = domains.map((d) => d.startsWith('*.') ? `any subdomain of ${d.slice(2)}` : d);
  const shown = words.length > 6 ? [...words.slice(0, 5), `${words.length - 5} more`] : words;
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} or ${shown.at(-1)}`;
}

/** Why Vantage will not send to this address, or null when it will. */
export function recipientRefusal(domains: readonly string[] | null, address: string): string | null {
  const domain = recipientDomain(address);
  if (!domain) return 'That is not one email address, so Vantage did not send to it.';
  if (domainAllowed(domains, domain)) return null;
  return `Vantage emails only addresses at ${describeAllowedDomains(domains!)}. ${domain} is not one of them.`;
}
