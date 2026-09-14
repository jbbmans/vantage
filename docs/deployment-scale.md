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

## Corps-wide, and what that does not settle

The intent is Marine Corps wide. That is a decision about reach, and it is worth being precise that
it is not yet a decision about storage, because the two get conflated and the conflation is what
buys the wrong database.

Corps-wide reach is satisfied by either shape:

- **Federated.** One instance per command, on the boundary above. Reach comes from deploying many
  instances; a higher echelon is fed by exports and submitted reports. This is what the current
  build does, today, at the measured sizes.
- **Central.** One live database holding every Marine's records, with commands as scopes inside it.

They are the same product to a user and a different problem to an engineer. Federated is a
deployment exercise with the code that already exists. Central is a port.

## What central costs, if that is the call

At Corps scale a single live database is well past SQLite. A Marine Corps of roughly 170,000 at the
same 300 records per person is on the order of 50M rows and about 30 GB — two orders of magnitude
above the largest size measured above, and the rollup query that already needs 298 ms at 5,000
people does not get better with more rows. A single writer is also the wrong shape for that many
concurrent sessions regardless of row count. The answer there is PostgreSQL.

That port is not started. `better-sqlite3` is synchronous, and the whole server is written against
that fact: about a thousand database call sites across 46 files, every one of which becomes async,
along with the 288 server tests that await them.

```
# statement prepares and executions, which is the set that has to change
grep -rnoE '\.(prepare|exec|pragma|transaction)\(|\)\.(get|all|run)\(' server/ shared/ scripts/ | wc -l
```

It is large and mechanical rather than clever, which makes it schedulable but not cheap, and it is
the kind of change that should be done deliberately and reviewed rather than folded into a UI pass.

Beyond the mechanical work, central deployment also has to answer the things federation answers by
construction: whose
authorization envelope covers one database holding every Marine's counseling history, who the
records officer for it is, and what an outage or a bad restore touches.

Recorded here so the decision is made on the record rather than inherited from whichever store
happened to be in the repository.
