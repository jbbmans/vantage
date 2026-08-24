# Migration fixtures

## `v3_3_0.db` — a real v3.3.0 database

The v3.4 Definition of Done requires that migration tests run **against a
captured v3.3.0 database file, not a synthetic one**. This is that file.

It is not hand-built and it is not a fabricated set of INSERTs. It was produced
by checking out v3.3.0, booting *its* server, and driving *its* routes — so the
rows have exactly the shape v3.3.0 wrote, including the parts a hand-written
fixture would get subtly wrong: the audit trail, the fingerprints, the
`assignments.role` blanking left by migration 005, and the ordering of the
`meta` table.

What it contains, and why each part is there:

| Shape | Count | Why it is in the fixture |
|---|---|---|
| Units | 34 | The full shipped MARFORRES tree, so subtree expansion is real |
| Users | 9 | Including the bootstrap administrator |
| Global roles (`unit_id IS NULL`) | 6 | The seeded set — the whole of finding 1 |
| Unit-scoped roles | 2 | One cascading, one flat, so both branches of the fork are exercised |
| Grants | 16 | Including grants of a cascading role, which migration 006 must materialise |
| `chain` rows | 12 | Four each on activities, recognitions, trainings — what migration 007 rewrites |
| Records at every visibility | 32 | `private` rows must survive untouched; hiding them would be a different bug |

Two commands share the database — a G-8 tree and CLR-4 — because tenancy
isolation is meaningless to test inside a single org chart.

**The Marines in it are fabricated.** Names are placeholder strings, the ranks
and MOS are plausible but invented, and no readiness or command-mark values are
real. Nothing in this file is PII and nothing in it came from a live roster.

## `v3_3_0.snapshot.json` — the permission oracle

Captured at the same moment, by calling v3.3.0's own `permissionsIn()` for
every (user, unit) pair. This is what the migration test replays: for each
user, in each of the 34 units, the bits they held under v3.3.0 semantics.

It is the oracle for the load-bearing claim in finding 1 — *"migration 006 over
a v3.3 database preserves every effective permission every user had before the
migration."* Recomputing the expected values inside the test would be marking
your own homework; the point is that the numbers were taken **before** the new
code existed.

The snapshot also records row counts per table and the visibility histogram, so
the test can prove migration 007 rewrote `chain` rows without silently losing
any.

### One deliberate exception

`snapshot.users.boletz` holds every permission in all 34 units, because v3.3's
`permissionMap` fanned an `ADMINISTRATOR` grant across every unit in the
database. Migration 006 does **not** preserve that, and the migration test
asserts that it does not.

Carrying it forward would mean writing an administrator grant into all 34
units, which is precisely the cross-tenant superuser finding 4 exists to
delete — preserving it *is* the leak the same Definition of Done forbids. The
migration converts it instead: the administrator becomes Unit Owner of the
units they were actually a member of, keeps every unit-scoped bit they held,
and loses reach into units they were never in. What was dropped is counted in
`meta.migration_006_report` and written to the instance audit, so it is a
recorded act rather than a silent downgrade.

## Regenerating the fixture

You need a v3.3.0 checkout, because the point is that v3.3.0's code wrote it.

```sh
git worktree add /tmp/v330 <v3.3.0 tag or commit>
cp tests/fixtures/capture-v3_3_0.mjs /tmp/v330/capture.mjs
cd /tmp/v330 && ln -s <this repo>/node_modules node_modules
node capture.mjs <this repo>/tests/fixtures/v3_3_0.db
```

Regenerating changes the file, so do it deliberately and read the diff in the
snapshot: a change there means either the fixture got richer (fine, and the
migration test should get stricter alongside it) or v3.3.0's behaviour was
misremembered (not fine, and worth stopping for).
