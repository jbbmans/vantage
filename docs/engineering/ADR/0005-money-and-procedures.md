# ADR-0005 · Exact money, and procedures as versioned code

**Status:** accepted · **Date:** 2026-09-23

## Money

Case money is integer cents with a currency, parsed from text by `shared/money.ts`. It is never
multiplied as a float, and more than two decimals is refused. Sums use BigInt internally and return
safe integers. Existing REAL columns are left alone and read through the same parser.

## Procedures

Procedures are TypeScript modules in `shared/procedures.ts`. Each has a key, a version, an authority, a
source, limitations and typed steps. A work item pins the key and version. Progress is derived from
events and never stored. There is no workflow designer.

**Why code.** A small number of reviewed procedures is safer, and easier to test, than a configurable
engine. Reuse is extracted only when two real SOPs show it.

**Consequence.** Adding or changing a procedure is a code change with tests and review. A new version is
added alongside the old one, so work pinned to the old version keeps its meaning.
