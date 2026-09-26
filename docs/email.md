# Email

Email is optional but enables password reset links, invitation emails, email-change confirmation, the weekly digest, and leaders' messages to their team. Without it, leaders send invite links by hand, the owner issues temporary passwords, and team messages arrive in Vantage only.

## From your own domain, with no email service (direct)

Vantage can deliver its own mail. For each recipient it looks up the receiving domain's mail servers and hands the message to them on port 25, the way mail servers talk to each other. Every message is signed with DKIM using a key Vantage generates on first use and keeps, encrypted with `VANTAGE_SECRET`, in its own database. No account, API key or relay is involved.

1. On Render set `VANTAGE_EMAIL_PROVIDER=direct` and `VANTAGE_EMAIL_FROM="Vantage <no-reply@vantageusmc.com>"`. Set `VANTAGE_EMAIL_REPLY_TO` to an address that receives mail (see [Replies](#replies)). Redeploy.
2. Open **Owner console → Email** and press **Check everything**. It tests whether the server can reach mail servers on port 25, finds the address it sends from, and reads your DNS.
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

This is what `render.yaml` ships with. Resend's records sit on their own names (`resend._domainkey`, and an MX and SPF on `send`), so they never collide with the direct-mode records above.

1. Create a Resend account, add `vantageusmc.com` as a domain, and copy the DNS records it gives you into Cloudflare (see [dns-namecheap.md](dns-namecheap.md)).
2. Create an API key with sending permission.
3. On Render set `VANTAGE_EMAIL_PROVIDER=resend`, `RESEND_API_KEY=<key>`, and `VANTAGE_EMAIL_FROM="Vantage <no-reply@vantageusmc.com>"`.
4. Redeploy, then use **Owner console → Overview → Send test**.

### Moving from Resend to direct

1. Set `VANTAGE_EMAIL_PROVIDER=direct` on Render (in `render.yaml` too, or the next blueprint sync puts `resend` back) and redeploy. Leave `RESEND_API_KEY` and Resend's DNS records in place for now.
2. Follow [the direct steps](#from-your-own-domain-with-no-email-service-direct) from step 2: publish `vantage._domainkey`, merge the server's outbound addresses into the apex SPF, and send a test.
3. When test mail shows `dkim=pass` for `vantageusmc.com`, delete `RESEND_API_KEY` and, in Cloudflare, the `resend._domainkey` TXT and the `send` MX and TXT. To go back, reverse step 1; nothing else changes.

## SMTP

Any SMTP relay works: `VANTAGE_EMAIL_PROVIDER=smtp` and `SMTP_URL=smtps://user:pass@smtp.example.com:465`.

## What gets sent

- Reset links: 30-minute, single-use, only when the account has an email.
- Invitations: 7-day link, sent when the leader supplies an address.
- Email change: confirmation link before the address changes.
- Weekly digest: opt-in per user, at their chosen day and hour in the instance time zone; what they logged, what is overdue, and what is closing.
- Team messages: a leader who manages a unit's members can email everyone in it and the teams beneath it from **Team → Email the team**. Each Marine gets their own copy, replies go to the leader, everyone also sees it in Vantage, and it is recorded in the unit's access log. Five messages an hour per leader.

Every send is logged in `email_log` (recipient, kind, status, error) and shown on the owner overview and the Email tab.
