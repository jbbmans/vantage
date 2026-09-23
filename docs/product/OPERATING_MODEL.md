# Operating model

How work moves through a section using Vantage, and who does what.

1. **A tasker arrives.** A leader brings in the spreadsheet (Work → Queue → Import). The original file
   is stored unchanged with its hash. Each row becomes a work item with its source row and a
   `created` event. Reimporting the same file changes nothing. A changed value on a claimed item is
   flagged to its holder rather than silently overwritten.
2. **Work is claimed or assigned.** A Marine claims an open item, or a leader with reassignment
   authority hands it to someone. It appears on that Marine's Today and in Record → Assigned at once.
3. **The work is researched.** On the item page the Marine records what they read: observations with
   exact amounts and where they read them, questions, findings, notes. Where a procedure applies, the
   next step and its form come first.
4. **Values become transparent calculations.** The candidate calculation reads the recorded values and
   cites each one. It is a candidate. The analyst decides and writes why.
5. **Actions are taken in the authoritative system and recorded.** Each is recorded separately:
   prepared, submitted (only after a passing control), and what the system later reports (approved,
   effective, posted). Waiting is recorded with its category, as calendar time.
6. **Work changes hands when it should.** A handoff carries a note. Each person keeps their own entries.
7. **The outcome is verified, then resolved.** A procedure case resolves only after the original
   condition is verified cleared with a reference.
8. **The record builds itself.** Contributions appear in the Marine's Record. A private draft can be
   prepared from their own facts and kept in their record. Nothing is submitted anywhere.
9. **Leaders read the workload.** Team → Workload and the leader's Today show unassigned, waiting,
   blocked, aging and overdue work, plus per-person counts with their definitions and limits.
   Decisions come from there, not from a roll call.

## Roles, briefly

Rank is not authority. Authority is an explicit role in a specific unit (`shared/permissions.ts`).
Templates: Marine, NCO, Fire Team Leader, SNCO, SNCOIC, Unit Leader. Claiming, editing, resolving and
reassigning work are separate permissions. See `docs/security/SECURITY_MODEL.md`.
