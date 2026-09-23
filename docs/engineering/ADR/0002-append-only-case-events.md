# ADR-0002 · An append-only event log per work item

**Status:** accepted · **Date:** 2026-09-23

## Context

The work item row held only its current state and holder. `work_actions` recorded some things people
did. Who claimed, handed off, changed stage, waited, observed, decided, submitted or verified, and
when, was either missing or scattered across the audit log. Contributions must survive handoffs and
stage changes, and corrections must not erase history.

## Decision

Add `work_events`. Every change to who holds work or where it stands writes an event in the same
transaction as the change. Research, execution and control entries are events, with a body validated
per kind (`shared/caseModel.ts`). A correction is a new event carrying `supersedes_id`. Database
triggers refuse UPDATE, and DELETE outside a demo database. Record projections and contribution counts
are computed from events, never stored. Migration 008 backfills existing `work_actions` and current
claims as events, marked `backfilled`.

## Alternatives considered

- *Extend `work_actions`*: its columns are shaped for quantity and value outcomes, and it has no place
  for typed observations, controls or ownership changes.
- *Use the audit log*: it is a security trail, owner-readable and chained. Case history must be readable
  by the people who can read the work, and it has a different retention story.

## Consequences

The history is complete from this version on. Contribution counts can be recomputed under new
definitions without a migration. Events are not hash-chained, so tamper evidence against a database
administrator depends on the audit log and database controls (SECURITY_MODEL).
