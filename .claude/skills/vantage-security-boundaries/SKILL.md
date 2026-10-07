---
name: vantage-security-boundaries
description: Use for authentication, authorization, Unit Instances, roles, exports, attachments, admin consoles, uploads, or any security-sensitive Vantage change.
---

# Vantage Security Boundaries

Read first:

- docs/security.md
- shared/permissions.ts
- server/authz/scope.ts
- relevant routes/services/tests

Then:

1. Enforce authorization server-side.
2. Treat Unit Instance isolation as a hard data boundary.
3. Apply least privilege.
4. Separate Vantage Administrator authority from Unit Manager authority.
5. Test negative cases: cross-unit read/write, ID tampering, privilege escalation, unauthorized export/download.
6. Use OWASP ASVS as a verification checklist.
7. Use NIST/DoD identity and Zero Trust guidance when relevant.
8. Do not invent MCEN-specific approval or topology facts.
9. Audit privileged changes.
