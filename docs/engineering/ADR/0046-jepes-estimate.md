# ADR-0046 · A JEPES estimate from the published tables, versioned, with the reason for each part

**Status:** accepted · **Date:** 2026-11-24 · **Builds on:** [ADR-0045](0045-one-grade-for-written-input.md)
(Readiness advice), [ADR-0041](0041-verified-backups-and-safer-upgrades.md) (database fixtures and the schema ledger)

## Context

Read on `eb0f5ca`:

- Readiness showed the four pillars as lists of what was entered, a "pillars with data" percentage, and the line
  "Vantage never computes a JEPES score". The advice was heuristic: "Shoot Expert", "Push the PFT toward 300",
  "Advance to the next belt", with no number to say which was worth more.
- MCO 1616.1 (25 Nov 2020, effective 1 Feb 2021) publishes the arithmetic: Appendix B's worksheet (p. B-1), its
  instructions (pp. B-2 to B-6) and Tables 1 to 4 (pp. B-7 to B-9). MARADMIN 367/21 reweighted Mental Agility from
  29 Jul 2021 and added MOS courses and qualifications, 046/24 extended those to every MOS, and 695/21 added a reserve
  affiliation incentive from 7 Dec 2021. Nothing in Vantage read them.
- Readiness kept PFT, CFT, the rifle classification, the belt, CEUs, college credits, the degree, PME and the three
  command marks. The worksheet also reads the rifle score (0 to 350), whether a Marine is a certified instructor at
  their belt, associate degrees, off-duty courses in service and in grade, MOS qualification points and the bonus
  lines, none of which were kept.

## Decision

1. **Versioned tables** (`shared/versioned.ts`). A table is a list of versions, each with an id, the first day it
   applies, where it was published (document, place in it, link) and any reading the source leaves open. Versions are
   checked as the module loads (ids unique, dates strictly increasing, each cited) and frozen. `inForce(day)` is the
   newest version in effect that day, by the same `policyOn` duty scoring uses. A released version is never edited:
   `tests/server/jepesEstimate.test.ts` pins each version's SHA-256 over its canonical JSON, so a change has to be a
   new version with its own date and source, and an old estimate reads the same under the rules of its day.
2. **The tables** (`shared/jepesTables.ts`), each version citing its page or paragraph:
   - Tables 3 and 4 (pp. B-8, B-9): PFT, CFT and rifle score to a value 0 to 100, for Lance Corporal and below and
     for Corporal. Each column is one unbroken run of whole scores from 0 to the top of its scale, values rising. The
     order says these tables are updated yearly on MOL; only the printed ones are published, so these are the ones read.
   - Tables 1 and 2 (p. B-7): the belt's MCTFS code to its value. A belt above a table's top row takes its top value.
   - The worksheet: pillar sum times 1.25, rounded half up (p. B-2: 200.5 is 201), at most 250; command marks times 50,
     summed, divided by 3; total at most 1,000.
   - Mental Agility: the order's line 3 (MarineNet to 100, degrees to 40, courses 10 each to 30) until 28 Jul 2021,
     then 367/21's weights (MOS qualifications 100, MarineNet 40, degrees 20, courses 5 each to 20 in service and in
     grade), citing 046/24 for the qualification table on MOL.
   - Bonus: the order's line 5 (four schools and Security Forces 50 each, command recruiting 20 each to 100, at most
     100), then the same with 695/21's reserve affiliation incentive of 50.
3. **A pure estimator** (`shared/jepesEstimate.ts`, `estimateJepes(inputs, { on })`), used by the page, the leader's
   view and the tests alike. It works the worksheet line by line for the Marine's grade: E-1 to E-3 read Tables 1 and
   3, E-4 Tables 2 and 4, Sergeant and above are not on JEPES, and with no rank both are read and the line is a range.
   Every line has a low and a high: equal when its figure is entered, its whole range when blank, so a pillar and the
   total are exact or a range. A yes or no the Marine knows (a degree, a bonus school) reads blank as none. Each line
   says what it read, the value the table gives and where ("Rifle 310 is value 55 on Table 3 (Lance Corporal and
   below)", MCO 1616.1 Appendix B, Table 3, p. B-8), and each pillar shows its sum, the multiplier and the rounding.
   It reads one Marine's own figures and nothing else: no peer, no unit, no pool of Marines in any Unit Instance.
4. **Levers by points** (`jepesLevers`). For each figure, a realistic next step (ten more points of rifle, PFT or CFT,
   or the next score that moves the estimate; the next belt or instructor course; five more CEUs; one more off-duty
   course; the next degree; half a mark on the weakest command average; one more referral) worth what the estimator
   says it adds to the total, and what is left on its line. Blank figures come first (entering one narrows the range
   by what its line spans), then steps by points, then MOS qualifications, whose step size is on MOL's table and not
   here. `recommend()` in `shared/jepes.ts` lists them, then the coaching no table scores: PME for grade (not a
   worksheet line; tracked for promotion), entries with no outcome, and empty areas.
5. **What if.** Readiness lays changed figures over the ones entered and works the estimate again; nothing is saved.
   Each lever's "Try it" sets its change there, and the result is said in a live region.
6. **Migration 044** (`044_jepes_inputs`): thirteen nullable columns on `readiness`, each with a CHECK for its range
   (`rifle_score` 0 to 350; `mcmap_instructor` and the six bonus flags 0 or 1; `associate_degrees` 0 to 9; the course
   counts and referrals 0 to 99; `mos_qual_points` 0 to 100). Added empty, only where missing; no row changes. The
   readiness schema, the spreadsheet and JSON import columns, the personal export and the privacy inventory carry them.
   A fixture frozen from `eb0f5ca` keeps schema 43 covered.
7. **Who sees it.** The Marine on Readiness, and a leader who may open the Marine's readiness, through the audited
   `GET /api/me/readiness/:id` (`view_readiness`), on the Marine's page. Nothing lists, sorts or compares Marines by
   estimate. The page keeps "Your score of record is the one on MOL".

## Readings the sources leave open

Each is a note on the version that applies it, shown with the estimate's sources:

1. The order's text prints both MCMAP headings, then both lists. The four-row list (Green is 100) is read as the Lance
   Corporal's, since the instructor belts need a course a Lance Corporal does not normally attend.
2. The rifle line reads the 0 to 350 score MOL lists. The annual qualification is scored in destroys (MCO 3574.2M) and
   no published rule converts destroys to that scale, so none is applied; blank, the line is its whole range.
3. Under 367/21, MarineNet is the CEU sum to 40, and two associate degrees are 10 each to 20.
4. Line 5e is read as the worksheet prints it, 50 for yes and 0 for no; the instruction text says 100 for no.
5. Appendix A's dashboard example gives a Corporal's 310 as the 37th percentile; Table 4 gives 310 the value 43. The
   estimate follows the table.

## Consequences

- The rifle, PFT and CFT lines are the parts most likely to differ from MOL, which uses the year's tables. Each line
  names the table it read.
- `estimate()` and its completeness percentage are gone from `shared/jepes.ts`; `PILLARS` went with them. A
  `Recommendation` may carry `points`, `upTo` and `change`, and has the kind `estimate`.
- A new MARADMIN is a new version: add it with its effective date and citation, record its fingerprint in the test,
  and the estimate for any day before it is unchanged.

## Tests

`tests/server/jepesEstimate.test.ts`: every released version's fingerprint; versions frozen, dated and cited, and the
version in force on each boundary day; Tables 3 and 4 one rising run per column with the order's anchors and rows
read off the pages; Tables 1 and 2 and the belt codes; a Lance Corporal (656) and a Corporal (828) worked through the
worksheet by hand, line by line; the same Lance Corporal under the order's own Mental Agility (662); rounding half up
and every cap; blanks as ranges, no rank, Sergeant; levers in order, each step equal to the difference of two
estimates; the schema and import columns; the route saving the figures, a leader's read audited and others refused.
`migrations.test.ts`: 044 adds the columns empty, holds each to its range, changes no row and runs once.
`databaseFixtures.test.ts`: the schema 43 fixture. `shared.test.ts`: the advice. Browser:
`59-jepes-estimate.spec.ts`.
