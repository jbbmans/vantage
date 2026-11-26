# Email

> On MCEN (`VANTAGE_DEPLOYMENT_PROFILE=mcen`) mail goes only through the enterprise relay: `smtp` with `SMTP_URL`, or `none`. Resend and direct delivery below are for the legacy public site and development; see [deploy-mcen.md](deploy-mcen.md).

Email is optional but enables password reset links, invitation emails, email-change confirmation, the weekly digest, and leaders' messages to their team. Without it, leaders send invite links by hand, the owner issues temporary passwords, and team messages arrive in Vantage only.

## From your own domain, with no email service (direct)

Vantage can deliver its own mail. For each recipient it looks up the receiving domain's mail servers and hands the message to them on port 25, the way mail servers talk to each other. Every message is signed with DKIM using a key Vantage generates on first use and keeps, encrypted with `VANTAGE_SECRET`, in its own database. No account, API key or relay is involved.

1. On Render set `VANTAGE_EMAIL_PROVIDER=direct` and `VANTAGE_EMAIL_FROM="Vantage <no-reply@vantageusmc.com>"`. Set `VANTAGE_EMAIL_REPLY_TO` to an address that receives mail (see [Replies](#replies)). Redeploy.
2. Open **Vantage Administrator console → Email** and press **Check everything**. It tests whether the server can reach mail servers on port 25, finds the address it sends from, and reads your DNS.
3. Add the three records it shows in Cloudflare, which hosts `vantageusmc.com`'s DNS (**DNS → Records → Add record**, type TXT; the host column is the **Name** field):

   | Name | Value |
   | --- | --- |
   | `vantage._domainkey` | `v=DKIM1; k=rsa; p=…` (copy it from the Email tab: it is this instance's own key) |
   | `@` | the SPF value shown. The domain already has one for Namecheap's forwarding, so **edit that record** to the merged value the tab shows; never add a second SPF record |
   | `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r` (if the domain already has a DMARC record, such as the one Cloudflare's DMARC Management adds, keep it and raise its `p=` instead) |

4. Press **Check everything** again until all three read *Published*, then **Send test** to an address you can open. In the message's original headers, look for `dkim=pass` and `dmarc=pass`.
5. After a week of clean delivery, change the DMARC record to `p=reject`.

A receiver that answers "try again later" (greylisting, a busy server) is retried automatically on a backoff for up to two days, or 30 minutes for a reset link, which is dead after that anyway. The queued copy is encrypted and deleted when it is delivered or given up. A refusal is final and its exact reason is shown on the Email tab and in `email_log`.

### What the host has to allow

- **Outbound port 25.** Render blocks it on free web services and allows it on paid instance types; this deployment runs on Starter. The Email tab's path check proves it either way: *Port 25: Open* or *Blocked*.
- **Every address the server sends from, in SPF.** Render sends from a small set of outbound addresses per region, listed on the service's **Connect → Outbound** panel. Add each one to the SPF record as `ip4:…`. The path check shows the one it saw.
- **Reverse DNS.** Large receivers check that the sending address's reverse name points back to it. On Render that name belongs to Render; the Email tab shows it and whether it is confirmed both ways. Vantage greets receivers with that name when it checks out. Set `VANTAGE_EMAIL_HELO` only if you run on a host where you control reverse DNS.

### Honest limits

Mail from a new sender on shared cloud addresses has no reputation yet. DKIM, SPF and DMARC make it authentic; they do not make every receiver trust it on day one. Gmail and most civilian providers accept authenticated mail at this volume. **DoD mail gateways (`.mil` addresses) are stricter** and may refuse or quarantine mail from cloud addresses whatever its authentication. When that happens the Email tab shows their answer word for word. If `.mil` delivery matters more than avoiding a service, use a relay the gateways already trust (the SMTP option below).

### Replies

Vantage sends; it does not receive. A Render web service cannot accept mail on port 25. `vantageusmc.com`'s MX records point to Namecheap's email forwarding, which already delivers mail sent to the domain to a mailbox you read, so set `VANTAGE_EMAIL_REPLY_TO` to one of those forwarded addresses. A leader's team message sets Reply-To to the leader's own address instead, so replies reach them directly.

## Resend

Resend's records sit on their own names (`resend._domainkey`, and an MX and SPF on `send`), so they never collide with the direct-mode records above.

1. Create a Resend account, add `vantageusmc.com` as a domain, and copy the DNS records it gives you into Cloudflare (see [dns-namecheap.md](dns-namecheap.md)).
2. Create an API key with sending permission.
3. On Render set `VANTAGE_EMAIL_PROVIDER=resend`, `RESEND_API_KEY=<key>`, and `VANTAGE_EMAIL_FROM="Vantage <no-reply@vantageusmc.com>"`.
4. Redeploy, then use **Vantage Administrator console → Overview → Send test**.

Resend accepts a few requests a second. When it answers 429 (or is briefly unavailable), Vantage waits as told and tries again up to four times under one idempotency key, so a roster-wide send finishes and no one gets a message twice.

### Moving from Resend to direct

1. Set `VANTAGE_EMAIL_PROVIDER=direct` on Render (in `render.yaml` too, or the next blueprint sync puts `resend` back) and redeploy. Leave `RESEND_API_KEY` and Resend's DNS records in place for now.
2. Follow [the direct steps](#from-your-own-domain-with-no-email-service-direct) from step 2: publish `vantage._domainkey`, merge the server's outbound addresses into the apex SPF, and send a test.
3. When test mail shows `dkim=pass` for `vantageusmc.com`, delete `RESEND_API_KEY` and, in Cloudflare, the `resend._domainkey` TXT and the `send` MX and TXT. To go back, reverse step 1; nothing else changes.

## SMTP

Any SMTP relay works: `VANTAGE_EMAIL_PROVIDER=smtp` and `SMTP_URL=smtps://user:pass@smtp.example.com:465`.

On MCEN the relay is reached only over TLS 1.2 or later, to a certificate that checks: `smtps://` (465), or `smtp://`
that must start TLS (587). An `SMTP_URL` that sets its own TLS terms in its query stops the start, as does a `%` in
its user name or password that starts no escape (write it `%25`). The certificate is checked against Node's bundled
roots, so a relay certificate signed by an enterprise CA needs that CA in `NODE_EXTRA_CA_CERTS`.

## What gets sent

- Reset links: 30-minute, single-use, only when the account has an email.
- Sign-in details: from **Unit Manager console → People → Email sign-in details**, everyone in the organization (or only those who have never signed in, or those not sent one yet) gets their username, the sign-in page, their unit, and a single-use link to choose a password that lasts 72 hours. No password is ever emailed: passwords are stored only as hashes, and nobody's current password changes until they use the link. Sending again replaces the earlier link. Accounts without an address are listed so the owner can hand them a temporary password instead. **Email sign-in** on any row sends to one person.
- Invitations: 7-day link, sent when the leader supplies an address.
- Email change: confirmation link before the address changes.
- Weekly digest: opt-in per user, at their chosen day and hour in the instance time zone; what they logged, what is overdue, and what is closing.
- Team messages: a leader who manages a unit's members can email everyone in it and the teams beneath it from **Team → Email the team**. Each Marine gets their own copy, replies go to the leader, everyone also sees it in Vantage, and it is recorded in the unit's access log. Five messages an hour per leader.

Every message shares one design (`server/services/mailLayout.ts`, words in `server/services/mailMessages.ts`, [ADR-0048](engineering/ADR/0048-email-look-and-allowed-domains.md)): dress blues as the app wears it, with the wordmark as text on a navy masthead, the gold and scarlet piping, a white card on warm paper and a cobalt button. It is table-based so Outlook lays it out, with inline styles so Gmail keeps them. Every coloured element has a class that dark mode maps, so a red or amber figure stays red or amber: once for clients that follow the device's dark setting (Apple Mail, Outlook for Mac and iOS) and again for Outlook.com's own dark mode. Gmail ignores both and applies its own dark colours. Nothing is fetched when a message opens: no image, stylesheet or font, the deployment's included. The plain-text part says everything the HTML does. Team messages and the weekly digest print the deployment's handling marking (set by Vantage Administrators) at the top and the foot.

## Who mail may go to

`VANTAGE_EMAIL_ALLOWED_DOMAINS` limits the domains Vantage sends to, for example `usmc.mil, mail.mil` or `*.usmc.mil`
(every subdomain of `usmc.mil`, not `usmc.mil` itself). Separate entries with commas or spaces; case does not matter.
An entry that is not a domain stops the start and is named. Unset, any domain is allowed. On MCEN with
`VANTAGE_EMAIL_PROVIDER=smtp` it is required.

The mailer checks every message before any provider sees it, and checks a queued message again before each retry.
Whatever the list, a message goes to one plain address: a list of addresses, a display name, a quoted part, or a
domain that does not mean what was written (a path, an encoded dot, a look-alike letter) is refused. Address fields
read an address by the same rule (`shared/emailAddress.ts`), so what is stored is what the mailer sends to; an older
stored address that is not one is refused at every send until its holder changes it in Settings. The provider is
given the domain in its ASCII form, the form the check read. A refused message is not sent, is logged with the status
`refused` and the reason, and is audited as `email_refused` with its kind and the recipient's domain.
A refusal sent for a Unit Instance (an invitation, sign-in details, a team message) is in that Unit Instance's access
log; one for an account's own mail (a reset, an email change, the digest) or the console's test is in the platform's.
A weekly digest that is refused is tried once that week, not at every tick. What each sender sees:

- **Email change:** the reason, on the address field. No confirmation link is made.
- **Password reset:** the same answer as always. No link is made.
- **Invitation:** the invitation is made, and the leader is told why it was not emailed and copies the link.
- **Sign-in details:** that person is listed as not sent, with the reason. Their earlier link keeps working.
- **Team message:** the dialog counts those with an address outside the list, and the result counts them again. They get the message in Vantage.
- **Weekly digest and the console's test:** the reason.

When a message is not refused but still does not go, the provider's own words stay in the mail log on the Email tab.
The person who asked is told what they can do: try again later; or, when the provider said no for good, that a
Vantage Administrator can see why on the Email tab; or, when the receiving mail server refused the address itself,
to check the address. The console's test is the exception and shows the provider's answer, since that is what it is
for.

The Email tab of the Vantage Administrator console shows the list as the server read it.

Every send is logged in `email_log` (recipient, kind, status, error) and shown on the owner overview and the Email tab.
