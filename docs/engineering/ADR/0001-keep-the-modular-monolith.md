# ADR-0001 · Keep the modular monolith and its stack

**Status:** accepted · **Date:** 2026-09-23

## Context

The reference product is a single Node/Express process with a React client, zod at trust boundaries,
versioned migrations and a broad test suite. The contract prefers React/TypeScript, Node/TypeScript
with Fastify or Express, zod, PostgreSQL, versioned migrations, and local storage. It also says to keep
suitable existing technology and not to introduce a framework only to match a template.

## Decision

Keep Express 5, React 19, Vite, Tailwind, TanStack Query and zod. Add capability as modules inside the
existing process: cases, record, demo. No microservices, no event bus, no Redis. The one planned
substitution is the database (ADR-0003).

## Consequences

Existing behavior and tests carry over unchanged. The server still runs TypeScript directly on
Node 22.18+, so restricted environments need a Node 22 runtime or a prebuilt container. That is
tracked in INFRASTRUCTURE_QUESTIONS.
