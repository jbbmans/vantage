# ADR-0048 · Email: one dress-blues look, nothing fetched, and the domains mail may go to

**Status:** accepted · **Date:** 2026-11-24 · **Builds on:** [ADR-0040](0040-security-fixes-for-later-features.md)
(TLS to the relay on MCEN), [ADR-0020](0020-reports-printable-output.md) (the handling marking), [ADR-0013](0013-security-audit-least-privilege.md)
(the audit trail)

## Context

Read on `25e7b51`:

- Seven kinds of mail leave Vantage: a password reset, an email change, an invitation, the Vantage Administrator
  console's test, sign-in details, a leader's message to their team, and the weekly digest. All seven already used one
  layout (`server/services/mailLayout.ts`), but four of them were written inside their routes, so nothing could render
  all seven to test them.
- The layout was the old look: a cool blue canvas, a teal and blue bar, a round card, a teal note. The app wears dress
  blues (`docs/design/DESIGN_SYSTEM.md`).
- Dark mode was wrong. A figure in the digest carried the ink's class with its tone inline, and the ink's dark rule
  (`!important`) won, so the red overdue count and the amber due-soon count turned plain white. The footer's links had
  no class, so in a dark inbox they kept a grey at about 3:1.
- Over HTTPS the header loaded `/brand/email-mark.png` from the deployment: one remote fetch on every open, which a
  mail client either blocks or reports as an opened message.
- Nothing limited who mail went to. The console's test sent to whatever address was typed.

## Decision

1. **One look** (`mailLayout.ts`), dress blues as the app wears it, with the same tables and inline styles Outlook and
   Gmail need:
   - A masthead on the coat's navy (`#0C1930`) with the wordmark **VANTAGE** as text, the eyebrow in gold, the title in
     the book serif, and the piping along its foot: a gold pinline, a navy gap, a scarlet stripe.
   - A white card on warm paper, square-cut corners, navy ink; details and figures on the panel colour with its rules;
     a figure under a short gold rule; the button in cobalt; the note an aside with a gold rule.
   - **Nothing is fetched.** No `<img>`, no `background=`, no CSS `url()`, no `<link>`, no `@import`, no web font.
     The mark is gone from mail; `public/brand/email-mark.png` stays so mail already sent still shows it.
   - **Dark mode by class.** Every coloured element names its colour by a class, and the dark rules map each class to
     the app's dark tokens, once in `@media (prefers-color-scheme: dark)` for the clients that honour it (Apple Mail,
     Outlook for Mac and iOS) and again for Outlook.com's own dark mode (`[data-ogsc]` for text, `[data-ogsb]` for
     grounds). Gmail honours neither and applies its own dark colours; the palette's pairs keep their contrast there
     only as far as Gmail's own mapping does. A toned figure names its tone (`v-good`, `v-warn`, `v-bad`),
     never the ink. The masthead keeps the frame's navy in both schemes, as the app's frame does.
   - **Accessible.** `lang` and `dir`; an `article` wrapper named by the title; layout tables are presentational; the
     title is the one `h1` and section headings are `h2`; section lines are a list; details are a table with a header
     on each row; the button's arrow and the preheader are hidden from screen readers. Every text colour reads at
     4.5:1 or better on every ground it sits on, light and dark (`MAIL_PALETTE`, tested pair by pair).
   - **The handling marking.** A message that carries one prints it above the masthead and under the footer, in both
     parts. Team messages and the digest carry the deployment's report marking (`runtime.reportMarking`, set by
     Vantage Administrators; "Working paper" when none is set). Vantage never decides a marking itself.
   - The plain-text part says what the HTML says, in the same order, with a `-- ` signature line before the footer.
2. **The seven messages in one module** (`server/services/mailMessages.ts`): `resetMessage`, `emailChangeMessage`,
   `inviteMessage`, `testMessage`, `signInMessage`, `teamMessage` and `digestMessage`, each from what it says and
   nothing else (no database, no request). The routes and services gather the facts and send what these return. The
   words did not change.
3. **Who mail may go to** (`VANTAGE_EMAIL_ALLOWED_DOMAINS`, `server/lib/recipientDomains.ts`):
   - Domains separated by commas, semicolons or spaces. `usmc.mil` is that domain only; `*.usmc.mil` is every
     subdomain of it, not the domain itself. Case is ignored, a leading `@` is dropped, an international name is read
     in its ASCII form. An entry that is not a domain, or a single name such as `mil`, stops the start and is named.
   - **Unset is every domain**, as before, for development and the legacy public site. **On MCEN with
     `VANTAGE_EMAIL_PROVIDER=smtp` the list is required**, and the start refuses without it, with the other MCEN
     refusals. Which domains MCEN names is infrastructure question I-37.
   - **One check, in the mailer**, before any provider sees the message: `send()` and the direct-delivery retry,
     which checks a queued message again in case the list changed while it waited. Every message, and any added later,
     passes it. A route that would issue a link first asks the same check (`checkRecipient`), so a link it cannot
     deliver is never made: the reset, the email change and sign-in details.
   - **One plain address, by one rule** (`shared/emailAddress.ts`). Exactly one `@`; a local part with nothing that
     separates addresses, names one, quotes, comments, routes mail on (`%`, `!`) or breaks a header line; and a
     domain with at least one dot and a lettered top level, read as a URL's host is read, which gives its ASCII form.
     A URL parser would quietly take `usmc.mil/x` as `usmc.mil`, decode `usmc%2Emil`, and map a full-width, ligature
     or Roman-numeral letter and an invisible character to another name, so the domain is taken only when that form
     means what was written: lower case, stable under compatibility normalization, no invisible character, each
     label starting with a letter or digit, and, written in ASCII, identical to its parsed form. Anything else is
     refused, list or no list, so no form of address carries a second recipient past the check. **The provider is
     given the form the check read**: the local part as written at the domain's ASCII form, so the domain checked
     is the domain the message goes to, whatever the case or script it was typed in.
   - **Refused means:** nothing reaches the provider; `email_log` keeps the row with status `refused` and the reason;
     the audit trail gets `email_refused` (enterprise category: the service enforcing a deployment setting) with the
     kind, the domain (never the whole address), who caused it, whom it was for, and the Unit Instance it was sent
     for, so it lands in that Unit Instance's trail, or the platform's for an account's own mail. A queued message
     keeps who caused it, so a refusal at retry names them too. A weekly digest to a refused address is refused once
     that week, not at every quarter-hour tick of its hour.
   - **Address fields read by the same function**: registration, Settings, invitations, account fields, the roster
     import and the address a sign-in provider asserts (`server/auth/oidc.ts`) accept exactly what the mailer sends
     to and nothing else, so an address that is stored is one the mailer will take.
   - **What people see:** the reason, "Vantage emails only addresses at usmc.mil or mail.mil. gmail.com is not one of
     them." The email-change form shows it on the field; an invitation is still made and the leader is told why it
     was not emailed; sign-in details show it per person; a team message counts those outside the list before it is
     sent and after, and they still get it in Vantage; the Email tab shows the list. A password reset answers the
     same whatever happens, so it says nothing about the account.
   - **A provider's own words stay in the mail log** (`notSentMessage`, `server/services/email.ts`). They can name
     hosts and addresses, so the person who asked for a message (the digest, an email change, an invitation,
     sign-in details) is told what they can do instead: "Try again later" when another try may work; that a Vantage
     Administrator can see why on the Email tab when the provider said no for good; and, when the receiving mail
     server refused the address itself (no mail server for its domain, or a 5xx to `RCPT TO`), to check the
     address, said on the field. The Unit Instance's trail carries the same words for sign-in details, never the
     provider's. The one place the provider's words are shown is the Vantage Administrator console's test, which
     exists to read them.

## Consequences

- A change to a message's words is made in `mailMessages.ts`, and the look tests render it.
- A deployment that sets the list and has accounts at other domains stops mailing those accounts until their
  addresses change or the list grows. Each refusal is in the mail log on the Email tab. A refusal sent for a Unit
  Instance is in that Unit Instance's trail, and one for an account's own mail in the platform's, so its Lead Unit
  Managers or a Vantage Administrator can see who.
- On MCEN, a deployment that sends through the relay must set the list before it upgrades, or it does not start. The
  refusal names the setting and gives an example.
- Address fields now take one plain address only (`shared/emailAddress.ts`). Before, they took a looser pattern, so
  an older stored address may not be one (a display name, a trailing dot, a `%`, a full-width letter). Such an
  address is refused at every send, logged and audited, until its holder changes it in Settings.
- No migration. `email_log.status` gains the value `refused`; the column has no constraint. The Email tab shows the
  status as stored (`refused`) with its reason in the not-sent colour; Vantage support's queue shows the status and
  the reason; a unit's support queue shows the status alone, as it does for every delivery (ADR-0013). The health
  counts of sent and failed mail leave a refusal out of both: it is a setting doing its job, not a delivery that
  failed.

## Tests

`tests/server/mailLook.test.ts` renders all seven from `tests/server/mailSamples.ts`: nothing fetched, links only to
the deployment, `lang`, the article wrapper, one `h1`, the wordmark as text, layout tables presentational and the one
data table with row headers; every class has a rule and every coloured element a class; a toned figure keeps its
tone; every colour pair at 4.5:1, light and dark; the marking top and foot only on the two that carry it; the plain
text holds every word of the HTML; and each of the seven sent through its real route or service arrives in the look.
`tests/server/emailDomains.test.ts`: parsing (exact, wildcard, case, `@`, international names, what is refused,
including a path, a query and invisible characters); matching (the domain only, subdomains only with `*.`, lookalikes
such as `usmc.mil.evil.com` and `evilusmc.mil`, lists, display names, quoting and header breaks refused); the one
rule read by the fields and the mailer alike, over addresses both take (case, a decomposed letter, `ß`) and both
refuse (a path, a port, an encoded dot, full-width and ligature letters, a Roman numeral, a variation selector, a
leading combining mark, bad punycode, a symbol, an over-long label), a field refusing before the mailer is asked, and
the provider given the ASCII form; the MCEN start; a refused send logged and audited with actor, subject, Unit
Instance and domain only; each flow refusing an outside recipient (the reset answering the same and making no link,
the email change on its field, the invitation made with its reason, the console test, the digest, sign-in details
making no link and leaving an earlier one working); a team message's counts; a queued message refused at retry,
naming who queued it; one digest refusal a week; and a relay that cannot be reached kept out of what the Marine, the
Unit Manager, the leader and the Unit Instance's trail see. `tests/server/directMail.test.ts`: the queued payload
carries who caused it, and a `550` to `RCPT TO` is said to be the address's trouble, on the field, in words that are
not the server's, with nothing queued. `tests/browser/61-email-look.spec.ts` opens all seven in Chromium, light and dark,
with every request refused and counted, axe on each, and the dark colours and a toned figure checked.
