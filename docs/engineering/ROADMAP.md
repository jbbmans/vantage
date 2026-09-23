# Roadmap

Phases from the delivery contract, with what is done and what is next. Dates are not promised.

## Phase A: recover the product and plan (done)

Inspected `main` running. Wrote the parity checklist, product decisions, domain model and migration
plan. Found and fixed test fixtures that had expired.

## Phase B: prove the experience (built; awaiting owner review)

The synthetic demo opens on Today with no sign-in form. Today, Work, the item page with the 2-Way UMT
procedure, Record, Goals, Career plan and Team workload all work on the real server. The flagship
path is automated in `tests/browser/22-demo.spec.ts`.
**Remaining:**
- the owner's review of the running screens;
- an observed usability check with someone new to Vantage;
- Field guide text for the new navigation.

## Phase C: persist the slice on PostgreSQL (next)

- ADR-0003 stages 1–4.
- A reviewer role scoped to review and verification.
- Chaining `work_events` for tamper evidence, if evaluators require it.

## Phase D: spreadsheet taskers and leadership visibility

- A versioned import recipe for the recurring UMT report, with the procedure applied at import.
- Batch assignment from the queue.
- Load test with 500–1,000 rows and concurrent claims.
- Workload charts, only after the owner confirms the metric definitions.

## Phase E: enterprise packaging and proposed pilot

- Linux service install, reverse proxy and TLS, health and readiness endpoints, backup and restore
  drills including attachments.
- Offline dependency bundle, SBOM (CycloneDX), and an operation test with egress blocked.
- The enterprise identity boundary (OIDC/SAML or authenticating proxy), once chosen.
- Documents: DEPLOYMENT*, BACKUP-RESTORE, UPGRADE, NETWORK-REQUIREMENTS, DATA-FLOW, operator, admin and
  user guides, MCEN pilot plan, technical handoff.

## Phase F: more workflows and integrations

Additional SOPs through the procedure model, and approved integrations (Microsoft 365 read-only
already exists). No integration becomes a core dependency.
