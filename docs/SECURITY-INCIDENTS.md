# Confidential security incident workflow

VANTAGE provides an in-app channel for authenticated users to report suspected vulnerabilities, security incidents, privacy concerns, account-access problems, data-integrity concerns, and availability issues.

## Access boundary

- A reporter can create a case, read only their own cases, and add follow-up information.
- The Instance Operator can read and triage every case from the restricted Owner Console.
- Unit owners, unit leaders, SNCOICs, and other role holders receive no case access from their unit permissions.
- Cases do not appear in unit exports, enterprise API responses, experience metrics, dashboards, or evaluation records.
- There is no edit or delete endpoint. New information is appended as an event.

## Lifecycle

Cases move through `submitted`, `acknowledged`, `investigating`, `mitigated`, and `closed`. A closed case can be reopened to `investigating`. Reporter-visible updates create an in-app notification. Operator-only notes remain hidden from the reporter and unit leadership.

The general tamper-evident audit chain records case creation, follow-up, status changes, and operator notes without copying the report description or note content into general audit detail. The confidential case tables retain the complete content and event history in the deployment database.

## Operational boundaries

- This workflow is not a substitute for emergency response, command incident reporting, law-enforcement notification, or an approved organizational vulnerability-disclosure program.
- Users are warned not to enter passwords, CAC PINs, access tokens, or other secrets.
- Attachments are intentionally excluded from the first release to avoid creating an unreviewed malware-submission channel.
- Cases are included in database backups and inherit the deployment's database, host, and backup protections.
- The workflow sends no email, SMS, analytics, or case content to a third party.

## Verification targets

- self-only reporter reads;
- Instance Operator-only queue access;
- no unit-role inheritance;
- reporter/internal event filtering;
- append-only application interface;
- submission throttling;
- notification and audit metadata without confidential content;
- WCAG and mobile reflow coverage for Settings and Owner Console.
