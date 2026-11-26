# ADR-0049 · Team messages kept in Vantage, and their files as real email attachments

**Status:** accepted · **Date:** 2026-11-26 · **Builds on:** [ADR-0048](0048-email-look-and-allowed-domains.md)
(the allowed domains and the mail's look), [ADR-0040](0040-security-fixes-for-later-features.md) (TLS to the relay),
[ADR-0025](0025-training-evidence.md) (files, the scanner and the audit of files), [ADR-0031](0031-workflow-messages-and-notices.md)
(notices and how long they are kept) · **Amends:** ADR-0025 §5 for files that leave Vantage by email

## Context

Read on `4594c2b`:

- `POST /api/org/units/:unitId/message` (Team → Email the team) took a subject and a body. Vantage kept nothing: each
  Marine got a notice holding the first 400 characters, with a link to `/team`, and those with an address got one email
  each. A Marine who lost the email had nowhere to read the message again.
- Nothing could go with a message. A leader with a checklist or a funds status sent it from their own mailbox, outside
  Vantage, its scanner and its trail.
- The mailer sent text and HTML only. Its four transports differ in how they protect what they send: the SMTP relay
  is TLS-only on MCEN (`tlsOnlyTransport`, ADR-0040) and opportunistic elsewhere; direct delivery is opportunistic with
  certificates unchecked; Resend is an HTTPS API to a third party.
- The product owner chose, when asked how files should travel (2026-11-19), **real email attachments**: files only to
  the allowed domains, only once scanned clean, and they cannot be withdrawn.

## Decision

1. **Every team message is kept**, with or without files, for 180 days: `team_messages` (who sent it, to which unit,
   its words and the handling marking as sent), `team_message_recipients` (each Marine it went to, captured at the send,
   and how each was reached; for a copy the receiving server asked to retry, its mail log row), `team_message_files` (each file's bytes, name, type, size, SHA-256, verdict and scanner).
   A message and its files are kept as sent: the database refuses an update to either. Migration 046 adds the three
   tables, empty; nothing sent before is invented.
2. **A page to read it**, `/team/messages/:id`, served by its own router at `/api/team-messages`. Only the application's
   host answers it; the Unit Manager console's host, which answers `/api/org`, does not. It opens for the sender and the
   Marines it went to while each is a member of the message's Unit Instance. Signed out is 401; anyone else, a Marine
   who joined after it was sent, one who has left the Unit Instance, and an id that is not one all get the same 404.
   Its files download as a record's do: `Content-Disposition: attachment`, `nosniff`, and a sandbox CSP. The sender
   sees how the Marines were reached, as counts, a queued copy as its retry left it in the mail log (sent, given up or
   refused); a Marine sees the message. The notice and the email's "Read it in
   Vantage" open it.
3. **Files travel in the send itself**: up to five, together within `VANTAGE_ATTACHMENT_MAX_BYTES` (10 MiB by
   default), as base64 in the one JSON request. The route settles the sender's unit, authority, step-up and hourly
   count before the body is read, then reads it with a parser of its own sized for the files; a body larger than files
   within the limit can be is refused as `files_too_large` (413) without its files being read. How many files there
   are, and whether each decodes, are the service's to refuse. Each file passes `inspectAttachment` (type, extension,
   signature, UTF-8 text). The same file twice is refused. Nothing is staged: a send that does not go leaves nothing
   behind. The subject is one line with no control characters; the body keeps its line breaks and tabs and loses any
   other control character, C1 and DEL among them. Either one left empty by that is refused (`subject_empty`,
   `message_empty`).
4. **The gates, all before anything is kept, notified or emailed**:
   - **Scanned clean now.** Each file goes to the scanner (`VANTAGE_CLAMD` or `VANTAGE_SCANNER_COMMAND`). Only `clean`
     lets it go: no scanner, a scanner error and a timeout are "not scanned clean" (`file_not_clean`, 409), whatever
     `VANTAGE_SCAN_REQUIRED` says; a finding is refused as malware (`malware_rejected`, 422).
   - **Where the email goes** (email on, and anyone on the list with an address):
     - an allow-list is set: with no `VANTAGE_EMAIL_ALLOWED_DOMAINS` files go by email to nobody (`no_allowed_domains`);
     - every address on the list is inside it (`recipients_outside_allowed_domains`): one Marine outside it refuses the
       files for everyone, and the leader can send the message without them, as before;
     - the mail goes through the SMTP relay, never direct delivery or Resend (`relay_not_tls`), on a connection of its
       own that must be TLS 1.2 or later to a certificate that checks, whatever the profile, and that reads no file path
       or URL a part might name (`disableFileAccess`, `disableUrlAccess`). The relay is **proven before the message is
       kept**: the mailer opens that connection (`verifyAttachmentRoute`, nodemailer's `verify()`) and closes it without
       sending. Whether to is read from the list as it is after the scans, so a Marine who gained an address while the
       files were scanned is never sent to over a relay nobody proved. A relay that will not take TLS refuses the send
       (`relay_not_tls`), and its own words go to the service log only.
   - **The sender confirms** the files cannot be withdrawn (`confirmFiles`; `files_unconfirmed`, 400 without it). The
     dialog asks it as a checkbox beside the files.
   - Files withheld from the Unit Instance (ADR-0014), or attachments off for the service, refuse the files
     (`feature_withheld`, `attachments_off`, 403).
   - With email off, or for a Marine with no address, files are kept with the message and read in Vantage; nothing
     leaves.
   - After the scans and the connection, which await, the sender's session and authority, the unit, attachments for the
     service (`attachments_off`) and for the Unit Instance (`feature_withheld`), and the recipient list are read again,
     and the allow-list checked again against the list as it is now.
   - **A refusal** is an error with a reason the leader can act on, shown in the dialog beside what was written, and a
     `team_message_refused` entry (the code, why, how many files; never a file's name). Nothing is kept, no notice and
     no email, and the five-an-hour count is not used: it is taken only once every check has passed, and asked again
     then, so two sends at once cannot both take its last place. A send that finds it used up then is refused the same
     way (`throttled`, 429).
5. **The audit of a sent message**, written in the same transaction that keeps it, before any email leaves, so a stop
   part way through still leaves the record of what was sent and to whom:
   - `team_message_file`, one per file: `file <id>: <name>; <size> bytes; <mime>; sha256 <hex>; scan clean (<scanner>)`.
   - `team_message_recipient`, one per Marine, the Marine as the entry's subject: `by email to an address at <domain>`,
     `in Vantage only`, or, for an address the mailer's check refuses (only on a message without files),
     `in Vantage only; the address check refuses an address at <domain>`; and how many files. The domain, never the
     address (ADR-0048).
   - `team_message`, after the send as before, with the message id, the counts, and the files' count and bytes.
   A copy still being sent when the server stopped is never sent later; the next start records it as not delivered by
   email (`failed`), and the Marine has the message in Vantage.
   **This departs from ADR-0025 §5**, which keeps a file's name out of the trail because a name can name a person and
   the trail is append-only. A file that leaves Vantage by email cannot be called back, so what went out, and to whom,
   must be answerable from the trail alone, after the message and its files are removed at 180 days. The name is
   that record. Refusals still never name a file.
6. **The email** (`teamMessage`, `mailMessages.ts`): the files as real MIME parts, from their bytes; a section naming each
   with its type and size, in both parts; a note that they were scanned and found clean and that the message stays 180
   days; and the button "Read it in Vantage" to the page. One email per Marine, as before.
7. **Kept 180 days**, then removed with its files and recipient list by the `team_messages_expire` job every six hours,
   unless a legal hold keeps it: a hold on its Unit Instance or on every instance, a `team_messages` record-type hold
   there or everywhere, or a hold on its sender or on any Marine it went to. Each run is a disposition run; one that
   removes anything is audited `team_messages_expired`. `team_messages` is a type a hold can name. The trail entries
   stay.
8. **Notices** keep their words and now open the message's page. A notice from before 046 still opens `/team`.
9. **Moves with the instance.** The three tables are in the instance archive, the files as bytes. The privacy inventory
   declares each column.

## Consequences

- A leader's message can be read again for 180 days, and a file sent with one is on Vantage's side of the record.
- Files by email need, on every profile, the SMTP relay, a TLS connection to it, a scanner and an allow-list. A
  deployment that sends direct or through Resend, or names no allowed domains, can still post files to a message with
  email off; with email on, it sends messages without files. The dialog says which before anything is written.
- Base64 makes a message about 1.37 times its files' size on the wire, so ten MiB of files is about fourteen MiB to the
  relay. Whether the MCEN relay takes that is infrastructure question I-38; until it is answered the deployment can
  lower `VANTAGE_ATTACHMENT_MAX_BYTES`. A message the relay refuses for its size is counted as not delivered for that
  Marine, and they still have it in Vantage.
- Each Marine's copy goes as its own message, so a message to 300 Marines with ten MiB of files is 300 uploads of
  about fourteen MiB to the relay. The relay is asked once per Marine, in turn, inside the request, as a message without
  files always was. Behind a proxy that cuts a request short, a large send can answer the leader with an error while it
  is still going out; the message is kept and its trail written before the first email, so the trail shows what went.
  Sending in the background, with delivery shown on the page as it happens, is the follow-up if MCEN's proxy timeout
  proves too short for it.
- A file a Marine downloads from their mailbox leaves Vantage's control. That is the choice the confirmation states.
- The database grows by each message's files for 180 days. The send refuses files the database has no room for
  (`database_capacity`, 507).

## Tests

`tests/server/teamMessages.test.ts`: a message with two files kept, the files attached to the email with their bytes,
listed in the plain text with type and size, the trail holding each file's name, size, SHA-256 and verdict and each
Marine as a subject (in Vantage only for an address the check refuses), and notices opening the page; the page and the download only for the sender and the Marines it
went to while members of the Unit Instance (signed out, outside the instance, joined later, left, another message's
file), the download's headers, and only the application's host answering; refusals each with a reason, an entry that
names no file, nothing kept, emailed or notified and the hourly count unused: malware, no scanner, a scanner that does
not answer, an address outside the list, no list, direct delivery, a relay that refuses STARTTLS (nothing sent in
the clear), no confirmation, the same file twice, a type Vantage does not take, a file that is not what it says,
base64 that does not decode, an empty file, six files, too many bytes together, a body far larger than the limit,
files withheld from the Unit Instance, a subject or message of control characters alone, and the hourly count used
up while the scanner holds the file; a sender signed out while the scanner holds the file sending nothing; a Marine
who gains an address while it does, over a relay that refuses STARTTLS, refusing the send; and a real STARTTLS relay with the test CA receiving the
message over TLS only, read back by `parseEml` with each attachment's name, type, size and SHA-256. Expiry at 180 days
under each kind of hold. `tests/server/directMail.test.ts`: a copy a receiving server greylists, kept queued with its mail log row, read as
emailed on the sender's page once the retry delivers it. `tests/server/migrations.test.ts`: 046 adds the tables empty, keeps a notice as it was, holds
each table to its checks, refuses updates and cascades the delete. `tests/browser/62-team-messages.spec.ts`: the
dialog's files, the confirmation before Send, a refusal shown in place with what was written kept, files chosen before
a refusal appeared kept listed so they can be removed and Send held until they are, the dialog kept open while a send
is out, the page for a
Marine it went to and not for one it did not, and axe on the dialog and the page.
