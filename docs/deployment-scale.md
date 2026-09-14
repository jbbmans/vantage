# How big one instance can be

"SQLite does not scale" is true of the wrong deployment and false of the right one. This is the
measurement, so the deployment model can be argued from evidence.

Reproduce it with `node scripts/scale-check.ts` (`USERS=` and `RECORDS=` override the size). It seeds
a scratch database and times the queries people actually wait on.

## Measured

Each row is a single instance holding 300 records per person — about four years of steady logging.

| People | Records | Size | Worst p95 | Verdict |
| --- | --- | --- | --- | --- |
| 250 | 75,000 | 44 MB | 8.9 ms | Comfortable |
| 1,000 | 300,000 | 176 MB | 70.7 ms | Comfortable |
| 2,000 | 600,000 | 351 MB | 124.8 ms | Past the line |
| 5,000 | 1,500,000 | 875 MB | 297.7 ms | Too big |

**One instance is comfortable to roughly 1,000–1,500 people.**

## What is fast and what is not

Everything a person does about their own record stays under a millisecond at every size tested,
because `idx_activities_user_date` makes it a keyed lookup no matter how large the table gets. Those
queries do not care how many other people share the instance.

What degrades is the unit rollup on the team dashboard, which aggregates every shared row in the
unit. An index that only *finds* those rows still has to visit each one, so
`idx_activities_unit_rollup` carries the aggregated columns as well and lets SQLite answer from the
index alone. Measured at 1.5M rows, composition-by-area went from 402 ms to 33 ms. It costs about a
fifth more disk, which is the right trade for a screen a section leader opens every morning.

The one query still slow at 5,000 people is the per-person rollup, because it sorts by a computed
SUM and needs a temporary b-tree however it is indexed. That is the ceiling above.

## Why this is the architecture rather than a limitation

A command is the unit that has a network enclave, an authorizing official, and a records officer.
It is also, conveniently, about the size one instance handles comfortably. Federating on the same
boundary the authorization already follows means:

- **A smaller authorization envelope.** One instance holds one command's records. A single central
  database holding every Marine's counseling history is a much harder case to make to an AO, not an
  easier one.
- **No shared blast radius.** A mistake, an outage, or a restore touches one command.
- **Portability that already exists.** The Owner console's instance export and import moves a whole
  instance between hosts, which is what a command reorganizing actually needs.

Rolling several instances up for a higher echelon is a reporting problem, not a database problem,
and reporting can be fed by the export rather than by shared storage.

## When a central database would be right

If a requirement arrives for one live database across many commands — a Corps-wide dashboard over
individual records rather than over submitted reports — SQLite is the wrong store and the answer is
PostgreSQL.

That port is not started, deliberately. `better-sqlite3` is synchronous and used at 629 call sites
across 35 files; every one becomes async, along with the 254 tests. It is a large, mechanical,
risky change, and doing it speculatively before anyone has decided between federated and central
would be building the expensive half of a decision nobody has made. The work is well understood and
can be scheduled when the requirement is real.
