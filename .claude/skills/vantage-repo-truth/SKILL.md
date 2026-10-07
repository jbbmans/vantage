---
name: vantage-repo-truth
description: Use whenever changing Vantage code or architecture. Forces repository-first inspection and prevents invented files, routes, APIs, or behavior.
---

# Vantage Repository Truth

Before proposing or editing code:

1. Identify current repository branch and commit SHA.
2. Read package.json and relevant current source files, tests, docs and ADRs.
3. Search for an existing implementation of the requested capability.
4. Prefer extending exact existing Vantage patterns over creating a parallel system.
5. Never claim a file/function/route exists unless inspected.
6. In the handoff, list exact files inspected, reused, changed, and tested.
7. If the prompt conflicts with the current repository, explain the real current state and migrate toward the requested end state.
