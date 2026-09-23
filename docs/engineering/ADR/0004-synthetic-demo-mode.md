# ADR-0004 · A separate synthetic demo mode instead of weakening sign-in

**Status:** accepted · **Date:** 2026-09-23

## Context

The owner asked for the sign-in step to be removed from the demonstration. The contract forbids:
- turning off authorization on protected APIs;
- substituting a real or shared administrator identity;
- entering demo mode after an authentication failure;
- running demo configuration in production.

## Decision

`VANTAGE_ACCESS_MODE=demo` is a distinct server mode:
- The client asks `/api/auth/setup` for the mode. In demo mode a signed-out visitor calls
  `POST /api/demo/start`.
- That creates a disposable workspace with one synthetic section, six synthetic people and several
  weeks of history, and returns a normal session as the Marine persona.
- The visitor can switch to the section-lead persona in the same workspace, or start over.
- Workspaces are isolated by the ordinary membership scope and removed whole on expiry.

Startup refuses demo mode in production and alongside CAC, email, AI or the MARADMIN feed. The
database is flagged as a demo database on first use. Accounts mode refuses that database, and demo
mode refuses any database with real accounts.

## Consequences

The demo is the real product on synthetic data, so what people see is what ships. A hosted demo runs
with `NODE_ENV` other than `production`, on its own database (`:memory:` is fine; the data is disposable
by design), behind HTTPS with `TRUST_PROXY` set so cookies are marked secure.
