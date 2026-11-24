# ADR-0047 · FITREP standing: the reports a Marine received, their relative value, and evidence strength

**Status:** accepted · **Date:** 2026-11-24 · **Builds on:** [ADR-0046](0046-jepes-estimate.md) (versioned tables),
[ADR-0045](0045-one-grade-for-written-input.md) (the writer's strength points), [ADR-0041](0041-verified-backups-and-safer-upgrades.md)
(database fixtures and the schema ledger)

## Context

Read on `7be00d3`:

- The FITREP side of Readiness held PFT, CFT, the rifle, the belt, PME and the reporting period's end, and an
  "Attribute coverage" panel that counted, for each of the fourteen attributes, how many entries the writer read as
  speaking to it. A count of one weak entry and a count of one strong entry looked the same, and every entry the
  Marine ever logged counted, whatever period it was in.
- Nothing held the fitness reports a Marine had received. A Marine reads their standing off the Master Brief Sheet
  (MBS): each report's average (RPT Avg), the reporting senior's profile (RS Avg, RS High, "Reports x of y"), and the
  relative value at processing and cumulative. The method behind those figures is published, in MCO 1610.7B's
  Chapter 8 and in the Marine Corps' own training on it, but Vantage did not show it or work it.

## Decision

1. **The method as a versioned table** (`shared/fitrepMethod.ts`, `FITREP_METHOD`, by ADR-0046's helper), frozen,
   fingerprinted in `tests/server/fitrepStanding.test.ts`, every rule cited:
   - The report average is the unweighted mean of the observed marks, A = 1 through G = 7; H (not observed) is in
     neither the sum nor the count. MMOA-4's own example (marks summing to 43 over 13 observed) is 3.31.
   - The relative value is the straight line through the RS High at 100 and the RS Avg at 90:
     RV = 90 + 10 × (FRA − RS Avg) ÷ (RS High − RS Avg), raised to 80 at the floor (TBS W3G0001XQ p. 6, CNA). On
     CNA's published MBS row (RPT Avg 2.50, RS Avg 2.99, RS High 5.00) it gives the printed 87.56. A profile whose
     reports share one average values each at 90. With the RS High at the RS Avg, a report above both is above the
     high (100, and flagged); one below them gives no line to read, since the MBS rounds both figures, so no value is
     worked and the page says why.
   - No relative value until the RS has written three reports on Marines of the grade (TBS, CNA), and never for an
     end of service (EN), not observed, extended or academic report (MCO 1610.7A, MMOA-4, CNA).
   - Thirds by the value as printed: 93.34 to 100 upper, 86.67 to 93.33 middle, 80.00 to 86.66 lower (PES Manual
     p. 8-6, as CNA quotes it).
   - A profile is one RS and one grade (TBS B3K3738).
2. **The standing, pure** (`shared/fitrepStanding.ts`): `standingOf(report)` gives the average (from the marks, or
   the RPT Avg as printed), the position against the RS Avg and RS High, the cumulative relative value worked from the
   RS figures now on the MBS with its arithmetic in words, the third, the value at processing as printed (never
   worked again: the profile at processing is not on the MBS; with the count at processing blank, a profile under
   three now was under it then), and a check that says when the working and the printed Cum RV differ by more than
   one hundredth. A missing figure is said, never guessed. `project()` adds the coming report to a profile (it counts
   in its own profile), works its value at processing, the profile's new average and high, how the Marine's earlier
   reports in that profile move, and the lowest average, in whole marks over the attributes observed, that reaches
   the middle third, 90, the upper third and 100. The attributes observed are 14 unless the newest marks in the
   profile observed fewer, and the Marine may change it. A profile the coming report leaves under three shows "No RV
   yet" for each. Nothing it works is saved.
3. **The record** (`fitness_reports`, migration 045): one row per report, owned by the Marine: period, occasion,
   type, grade, how the Marine names the RS, the fourteen marks or the RPT Avg, the RS Avg and High, the report counts,
   the values as printed, and `shared` (0 by default). CHECKs hold every range and order (the high at or above the
   average, the count now at or above the count at processing). Soft delete. Only `server/services/fitnessReports.ts`
   reads or writes the table, which a structural test holds.
4. **Who sees a report.** The Marine, at `GET/POST /api/me/fitness-reports` and `PUT/DELETE /api/me/fitness-reports/:id`
   (another Marine's id reads as no report). A change names the version it changes, so a stale one is refused, and a
   field it leaves out keeps what is stored; the checks across fields read the report as it will be saved. A leader who may open the Marine's
   readiness reads the ones the Marine shares, and only those, at `GET /api/me/readiness/:id/fitness-reports`, by the
   same unit check as readiness; each read is audited as `view_fitness_reports` with the count shown. Nothing lists,
   sorts or compares reports across Marines. The member page reads them only on its overview.
5. **Evidence strength** (`fitrepEvidence` in `shared/evaluation.ts`, replacing `fitrepCoverage`). For the coming
   report's period (the day after the last report entered, to the period end on the page; an entry with any day in it
   counts, as ADR-0018 reads a period, so ongoing work begun before it counts; an undated entry counts; a period end
   on or before the last report is the last one's, so the period runs on and the page says to set the coming one's),
   each attribute's entries are graded by the writer's own five strength points: Strong with two entries at 4 or 5,
   Some with one, Thin with entries all below 4, None with none. Each names its strongest entry and what it lacks. The
   coaching reads it ("N attributes rest on thin evidence"), and counts entries and outcomes over the same period.
6. **The pages.** Readiness (FITREP) shows the reports with their standing and working, an MBS-style count by third,
   the coming report, evidence strength and the method's sources. The leader's member page shows the shared reports.
   Both say the Master Brief Sheet is the record. The demo's section lead has three reports, one shared.
7. The personal export carries every report the Marine entered, removed ones marked, in the JSON, a Fitness reports
   sheet in the workbook and `fitness-reports.csv` in the ZIP; an import says they stay in the export; the instance move carries the
   table; the privacy inventory, record kinds, privacy page, Help and What's new say what is kept and who sees it.

## Readings the sources leave open

Each is a note on the method version, shown with the sources on the page:

1. Chapter 8 of MCO 1610.7B could not be read where the rules were gathered. They are the ones The Basic School
   teaches and CNA quotes from the PES Manual; they are to be checked against Chapter 8.
2. The report being worked counts in its own profile: the RS High is the highest of all the reports the RS has
   written on the grade, that one included, and it is one of the three a value needs.
3. Figures are worked as the MBS prints them, to two places. The sources do not say whether the system rounds the
   averages before it works the value; CNA's 3.15 / 3.23 / 3.30 example fits only if 3.23 is the average it used.
4. The cumulative value is worked from the RS Avg and RS High the Marine copies from their current MBS; the value at
   processing is the printed one.
5. A report above the RS High entered is inconsistent: it shows 100 and says the figures disagree.

## Consequences

- A change in the method is a new version with its own date and source; the test refuses an edit to a released one.
- `fitrepCoverage` is gone; `recommendFitrep` takes `evidence`. The FITREP balance label reads "Evidence strength".
- The Section C draft, the strength badge and evidence strength grade an entry the same way.

## Tests

`tests/server/fitrepStanding.test.ts`: the method's fingerprint, freezing and citations; MMOA-4's 3.31 and 28 over
14; the CNA row to 87.56 with its arithmetic; 100, 90, the floor, all-same and above-the-high; the thirds at
86.66/86.67 and 93.33/93.34; no value at two reports or for EN, not observed, extended and academic; the value at
processing, and with its count blank; the hundredth either side of the printed Cum RV; the RS High at the RS Avg;
the projection counting the report in its own profile and each target giving back its value, one mark less not, over
13 or 14 observed, and "No RV yet" under three; evidence levels, the period window (ongoing and spanning work, a period end before its start) and an award for an earlier period; the body schema; the structural
test; routes (owner only, 404 for another's, version required and conflicting, a field left out kept, a leader reads shared only and is audited, a peer and
an outsider refused) and the personal export (JSON, workbook sheet, ZIP CSV, counts). `migrations.test.ts` (045), `databaseFixtures.test.ts` (a fixture frozen
from `7be00d3` at schema 44), `writer.test.ts`, `shared.test.ts`, and `tests/browser/60-fitrep-standing.spec.ts`.
