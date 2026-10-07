---
name: vantage-migration-safety
description: Use for schema changes, Unit Instance restructuring, record migrations, imports, exports, backup, restore, or effective-dated history.
---

# Vantage Migration Safety

1. Inspect existing migration conventions and schema first.
2. Prefer additive/backward-compatible migrations before destructive cleanup.
3. Preserve authoritative record type and historical meaning.
4. Define transaction boundaries.
5. Define idempotency.
6. Define rollback/recovery.
7. Define partial-failure behavior.
8. Test pre-migration production-like fixtures.
9. Verify before/after counts.
10. Never silently discard unmapped data.
11. Record migration identifiers and validation in the handoff.
