# DNS for vantageusmc.com

Namecheap is the registrar. Cloudflare hosts the DNS: the domain's nameservers are
`brodie.ns.cloudflare.com` and `susan.ns.cloudflare.com`, set in Namecheap under **Domain List → Manage →
Nameservers → Custom DNS**. Every record below is edited in Cloudflare. Namecheap's **Advanced DNS** host
records are not served while custom nameservers are set, so changes there do nothing.

## Site records

| Type | Name | Content | Proxy |
| --- | --- | --- | --- |
| A | `@` | `216.24.57.1` | Proxied |
| CNAME | `www` | the service's `*.onrender.com` hostname | Proxied |

Confirm both values in Render under **Settings → Custom Domains**; it prints what it expects. When adding a
domain, set the records to **DNS only** until Render shows the certificates as issued, then switch them to
**Proxied**. Do not add `AAAA` records of your own; Render has no IPv6 origin.

`www` redirects to the apex because `VANTAGE_PUBLIC_URL` names the apex. Passkeys are bound to that
hostname, so users arriving on `www` still sign in.

## Cloudflare settings

| Where | Setting | Why |
| --- | --- | --- |
| SSL/TLS → Overview | **Full (strict)** | Render serves a valid certificate. **Flexible** loops forever, because Render redirects HTTP to HTTPS. |
| SSL/TLS → Edge Certificates | Always Use HTTPS **on**, Minimum TLS **1.2**, TLS 1.3 **on** | |
| SSL/TLS → Edge Certificates | HSTS **off** | The application sends its own header. Two sources drift apart. |
| Speed → Optimization | Rocket Loader **off** | It rewrites script tags, which the Content Security Policy blocks. |
| Scrape Shield | Email Address Obfuscation **off** | It injects a script that the Content Security Policy blocks. |
| Web Analytics | no automatic injection | Same reason. |
| Network | HTTP/3 **on** | |
| Caching → Configuration | Development Mode **off** | Caching itself is Render's edge cache (see [deploy-render.md](deploy-render.md)). |

## Email records

The domain sends mail only if email is configured (see [email.md](email.md)), and it receives mail only if
something is set up to receive it. Pick one of the two setups.

**Not receiving mail at the domain.** Replace the current Namecheap forwarding records with:

| Type | Name | Content |
| --- | --- | --- |
| MX | `@` | `.` (priority 0; a null MX says the domain takes no mail) |
| TXT | `@` | `v=spf1 -all` |
| TXT | `_dmarc` | `v=DMARC1; p=reject; sp=reject` |

**Receiving mail (for example `contact@vantageusmc.com` forwarded to a personal inbox).** The existing MX
records point to Namecheap's email forwarding (`eforward*.registrar-servers.com`), whose rules live in the
Namecheap page that custom nameservers switch off. Use Cloudflare instead: **Email → Email Routing →
Enable**, add the addresses and their destinations, and let it replace the MX and SPF records. Then add the
same `_dmarc` record as above; forwarding keeps the original sender, so `p=reject` does not affect it.

When Resend is turned on, add the records Resend shows for the domain (an MX and a TXT on `send`, and a TXT
on `resend._domainkey`). They sit on their own names, so the records above stay as they are, and Resend's
DKIM signature keeps DMARC passing.

Keep the `google-site-verification` TXT record; Search Console uses it.

## Certificate authorities

Add CAA records so only the authorities Render uses can issue certificates for the domain:

| Type | Name | Content |
| --- | --- | --- |
| CAA | `@` | `0 issue "letsencrypt.org"` |
| CAA | `@` | `0 issue "pki.goog"` |

Cloudflare adds the authorities for its own edge certificates automatically.

## DNSSEC

1. Cloudflare: **DNS → Settings → Enable DNSSEC**. It shows a DS record (key tag, algorithm 13, digest type
   2, digest).
2. Namecheap: **Domain List → Manage → Advanced DNS → DNSSEC → Add new DS**, and enter those four values.
3. Cloudflare reports DNSSEC as active within a day. Before changing nameservers again, turn DNSSEC off
   and remove the DS record first, or the domain stops resolving.

## Registrar

In Namecheap: auto-renew on, domain privacy on, and the registrar (transfer) lock on. Use two-factor
sign-in on both the Namecheap and Cloudflare accounts; either one can take the site down.

## HSTS preload

The application sends `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, which
meets the preload list's requirements. Submitting the domain at hstspreload.org builds HTTPS-only into
browsers for the domain and every subdomain. Removal takes months, so submit only once nothing under
`vantageusmc.com` will ever need plain HTTP. Until then, the header protects every returning visitor.
