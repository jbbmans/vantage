# ADR-001: Governed GenAI.mil gateway

- Status: Accepted for implementation; disabled by default
- Date: 2026-09-02
- Decision owner: VANTAGE Instance Operator

## Context

VANTAGE needs AI-assisted extraction, drafting, summarization, and aggregate analysis. GenAI.mil provides an OpenAI-compatible API, a 50 million-token daily team allocation, a 120-request-per-minute allocation, and an eight-hour API-key lock. VANTAGE records are protected by exact-unit, deny-by-default authorization.

## Decision

Use one server-side adapter pinned to the GenAI.mil v1 HTTPS origin. Keep its key only in the deployment secret store. Route every capability through a named workflow with bounded inputs, output limits, per-user/global throttles, daily accounting, content minimization, and metadata-only audit entries.

AI output never writes records automatically. Personal workflows query only the session user's records. Command analysis requires `EXPORT_DATA` and sends aggregates from exactly one unit. Attachments, evidence links, private notes, rosters, security incidents, credentials, and sessions are excluded.

## Consequences

- AI help appears inside existing work and in a dedicated workspace.
- Operators can disable it immediately and inspect usage/lock state.
- Key unlock remains a human operator action.
- Prompt/response content is intentionally unavailable in VANTAGE forensic logs; workflow and usage metadata remain auditable.
- Operational use still requires approval for the intended data types and markings.
