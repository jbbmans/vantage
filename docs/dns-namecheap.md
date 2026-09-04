# Namecheap DNS for vantageusmc.com

Render needs two records. Both are set in Namecheap under **Domain List → Manage → Advanced DNS**.

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| A | `@` | `216.24.57.1` | Automatic |
| CNAME | `www` | `vantage.onrender.com` | Automatic |

Replace `vantage.onrender.com` with the hostname Render shows on the service page, and confirm the A-record IP in Render's custom-domain dialog (it prints the current value; the one above is Render's long-standing anycast address).

Steps:

1. In Render, open the service, **Settings → Custom Domains**, add `vantageusmc.com` and `www.vantageusmc.com`. Render shows the records it expects.
2. In Namecheap, delete the parking records (the `URL Redirect` and default `CNAME` for `www`) and add the two rows above.
3. Wait for propagation (usually minutes, up to an hour). Render verifies, then issues the certificate automatically.
4. Optional but recommended: add a `CAA` record `0 issue "letsencrypt.org"` so only Let's Encrypt can issue for the domain.

`www` redirects to the apex because both are listed in `render.yaml` and `VANTAGE_PUBLIC_URL` names the apex; the app sets the passkey relying-party ID from that URL, so users on `www` still sign in.

Email deliverability records (SPF, DKIM, DMARC) are covered in [email.md](email.md).
