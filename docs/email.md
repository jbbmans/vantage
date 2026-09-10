# Email

Email is optional but enables password reset links, invitation emails, email-change confirmation, and the weekly digest. Without it, leaders send invite links by hand and the owner issues temporary passwords from the Team or Owner pages.

## Resend (recommended)

1. Create a Resend account, add `vantageusmc.com` as a domain, and copy the DNS records it gives you into Namecheap (one TXT for SPF, three CNAMEs for DKIM, optionally a DMARC TXT).
2. Create an API key with sending permission.
3. On Render set `VANTAGE_EMAIL_PROVIDER=resend`, `RESEND_API_KEY=<key>`, and `VANTAGE_EMAIL_FROM="Vantage <no-reply@vantageusmc.com>"`.
4. Redeploy, then use **Owner console → Overview → Send test**.

Resend's free tier (3,000 emails a month) covers a unit comfortably.

## SMTP

Any SMTP relay works: `VANTAGE_EMAIL_PROVIDER=smtp` and `SMTP_URL=smtps://user:pass@smtp.example.com:465`.

## Records that keep mail out of spam

| Type | Host | Value |
| --- | --- | --- |
| TXT | `@` | `v=spf1 include:amazonses.com ~all` (Resend's SPF; copy the exact value from Resend) |
| CNAME ×3 | `resend._domainkey` etc. | as shown by Resend |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@vantageusmc.com` |

## What gets sent

- Reset links: 30-minute, single-use, only when the account has an email.
- Invitations: 7-day link, sent when the leader supplies an address.
- Email change: confirmation link before the address changes.
- Weekly digest: opt-in per user, at their chosen day and hour in the instance time zone; what they logged, what is overdue, and what is closing.

Every send is logged in `email_log` (recipient, kind, status, error) and shown on the owner overview.
