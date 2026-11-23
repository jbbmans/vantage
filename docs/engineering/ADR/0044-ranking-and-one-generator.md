# ADR-0044 · Ranking by outcome, the same work said once, and one generator for the package, the record, the résumé and the badge

**Status:** accepted · **Date:** 2026-11-23 · **Builds on:** [ADR-0043](0043-bullet-writer-rules.md) (the writer's
rules), [docs/product/NARRATIVE_WRITER.md](../../product/NARRATIVE_WRITER.md)

## Context

Read on `9770155` and run over the writer corpus, the demo seed and the 81 fixed examples:

- **Dollars outranked outcomes.** `weigh` gave money up to 3 points and a measured outcome 2.5, so "Processed 400
  travel vouchers" with $5M and no outcome (6.0) took the space from the same work with "cut payment time from 21 days
  to 6 days" (3.5).
- **Any digit was a measure.** "Approved by the CO on 12 March" was a measured outcome; "all cleared on the next
  report" and "none returned" were not. "S-4" counted as a number.
- **A billet passed for an accomplishment.** "Served as the S-4 chief" and "Assigned as platoon sergeant" got no note
  and scored like work.
- **Near-duplicates were summed.** "Processed 22 MIPRs for the G-8" and "Processed 22 MIPRs for G-8" a day later
  became "Processed 44 MIPRs ... across 2 actions".
- **The same work was listed action by action.** Entries of the same work were grouped only when the grouped plan
  scored higher, so a narrative could say "Reconciled 14 ULOs..." and "Reconciled 9 ULOs..." as two sentences, and a
  total said "across 3 actions". Evaluation input is compiled like a résumé: ten entries of OCMTs are one line with
  the total, said once.
- **Four generators disagreed.** The package ranked by its own `strength()` (dollars 2, count 1, result 1: 0 to 4),
  wrote an "Across 12 logged actions..." rollup above the bullets, and bulleted entries the narrative held back
  (annual training). The résumé was an older generator with its own verbs and glossary (`ACRONYM_GLOSS`); it failed 38
  of the 81 examples' checks and spelled LOA out as "Letter of Appreciation" in finance text. The badge read "2/5" on
  the record page and Records, "2/4" in Quick Log and "of 5" in the analysis, with a tooltip naming six fields it did
  not count. The team dashboard's "Complete entries" counted `strength >= 2`, so a dollar figure with no outcome was
  complete and an outcome with no figure was not.
- **A hand edit went stale silently.** The studio kept an edit in the browser under a key with the period's dates, so
  "last 30 days" lost it the next day, nothing said when the record changed under it, and Format or Spell out threw
  it away.

## Decision

1. **Rank by outcome first** (`score.ts`). Each weight has a tier: 2 a measured outcome, 1 a stated one, 0 none. The
   score is a band per tier (1, 4.5, 8) plus at most 2.5 for the largest figure (money, a count with a bonus for the
   Marine's largest of that unit, people, time); a strong verb and recency add 0.25 each; a weak opening or a billet
   costs 1, a missing verb 0.5, a superlative or a cliché 1.5 each. Every list sorts by tier, then score (`byRank`):
   the narrative's first and second passes, what is dropped to fit, what is left out, and the package. A total takes
   its best entry's tier and score plus 0.5 per other entry, never past its band.
2. **Measured means measured** (`lexicon.ts`, `isMeasured`). Dates ("12 March 2026", "12 MAR 26" as Vantage prints
   one, "12MAR26", "March 12", "2026-03-12", "03/12/2026"), fiscal and calendar years and their ranges ("FY25-26",
   "2025-2026"), quarters ("Q4", "Q3FY26", "1st Qtr") and staff sections (S-4, G-8) are taken out first; then a digit, a
   percentage, a zero ("zero", "none", "no errors"), "every", "all", "half", "first", "on time", "ahead of" or "under
   budget" is a measure. "S-4" and "FY26" are no longer the number an entry is missing. A month is a whole word ("Mar",
   "March"), so "12 Marines" and "10 junior Marines" stay counts; "May" and "Sep" are months only beside a year or after
   "on", "by", "since", "until" or "through" ("on 4 May"), as "the 4th of May", or with a day and a year ("May 4,
   2026"), so "12 sep packages" and "the 12 SEP packages" stay counts. A day is 1 to 31 with no plural noun after it, so
   "since June 40 Marines qualified" keeps its 40; a word that ends in "s" and is no plural ("as", "is", "its",
   "across") is not one, so "completed in 2026 as planned" is a date. A short year after a month takes no comma and no
   plural noun after it, so "on 12 June, 30 Marines qualified" keeps its 30. A year is a date beside a month, in a
   range, after "the" before a singular noun ("the 2026 plan"), or after "in", "during", "since", "through", "until" or
   "throughout" with no plural noun after it: "fired 2000 rounds" and "mishap-free through 2000 miles" keep their
   number. The title and the outcome are read for a number apart, so a date that ends one and a count that opens the
   other are not one date.
3. **Billets are flagged, ranked lower, never held** (`facts.ts`, issue `billet`). "Served as", "Assigned as",
   "Appointed", "Designated", "Acting ...", "Billet:", "Primary duty", "Held the billet of", "Performed the duties of",
   with no outcome: "Names the billet, not what was done in it". A duty verb (managed, oversaw, supervised,
   maintained) with no figure and no outcome: "Says what you were in charge of, not what came of it". The reviewer
   cites Appendix E on JEPES and Section C on FITREP, also in text edited by hand.
4. **The same work logged twice is held once** (`repeats.ts`, replacing the exact-duplicate hold). Two entries are the
   same work when the verb, every figure (count and unit, dollars and kind), the system and the organization agree,
   they are at most a day apart, every word of the shorter title is in the longer, and their outcomes, when both have
   one, nest. With no figure, only the same words on the same day; with no date on either, only the same words, since
   nothing says two undated entries were a day apart. A copy joins only when it is the same work as every entry already
   held with it, so a bare "Processed 22 MIPRs" never ties "for the G-8" to "for the G-4"; entries are read fullest
   first, then by date and id, so the same record holds the same copies in any order. The fullest copy leads; the other
   is held, with a reason that says only what is true of the two (numbers when there are some, the day when both have
   one) ("Looks
   logged twice: the same work and numbers as ... Keep it if it was separate work."). Nothing is copied between them.
   Keeping the held copy is the Marine's word that it was separate work: it adds up again.
5. **The same work is one total, said once** (`compileGroups`, `sentenceForGroup`). Entries with the same verb and
   unit, where the count is the verb's object, are always one sentence, whether or not they would fit one by one:
   "Cleared 100 OCMTs totaling $111,250 in DAI." No "across N actions". The words every entry shares stay ("for the
   G-8") when they are a whole phrase in every entry, never cut short ("within" from "within 3 days" and "within 5
   days") and never an entry's own figures ("totaling $5,000"); a shared system, organization and purpose stay too.
   A phrase ends before a link that opens another one ("within", "using", a bracket) or at a comma the entry's own
   words follow ("for the S-4, all passed"); not before "of", "and" or "or", and not at a comma inside a name, so
   "the Department of the Navy" and "the Department of Defense" share nothing and "1st Battalion, 6th Marines" is never
   "1st Battalion". Dollars only some entries carry are said of those ("Reconciled 24 ULOs, 14 of them totaling
   $48,250"), set apart when an outcome or a purpose of every entry follows ("Reconciled 24 ULOs (14 of them totaling
   $48,250), cutting the backlog to zero"), and with the outcome when the same entry has both ("including 14 totaling
   $48,250: all cleared"). An outcome every entry states is said once; otherwise the strongest is said with the
   entries it is true of (", including 14 in DAI: all cleared on the next report"; "including 10 of the rest" when
   the dollars are another part's). A figure the outcome already states is not said again beside it.
   An entry of a total is never offered on its own. Leaving the total out leaves the work out; keeping one of its
   entries keeps the total. Unlike dollars (obligated beside saved, or a kind that does not sum) still do not add up.
6. **One generator.** `prepareEntries` (read, hold repeats, hold by rule, weigh) feeds the narrative, the package
   (`package.ts`, `writePackage`) and the coach. The package is the writer's candidates in full, compiled, ranked,
   capped per area, with what the cap leaves out said once after the bullets (the narrative's own summary, which
   repeats no figure), a count of the left-out entries the summary cannot speak for (no figure to add up), and held
   entries listed with their reason, in the copied text, on screen and in both PDFs, so an area's count adds up. What
   is held follows the report's track and the wording follows the bullet style, so a JEPES report in FITREP style
   never sends work to a worksheet it does not have. A held reason quotes the entry it repeats in plain characters, as
   the held text is, so every PDF font prints it. The record bullet is `bulletFor`. The résumé
   (`resumeFor`) is the JEPES sentence with each acronym spelled out, in plain characters. The badge (`strength.ts`)
   reads the same Fact.
7. **The badge counts five things**, one point each: it opens with what you did (no weak opening, no missing verb, no
   billet, not passive), it has a number, it states an outcome, the outcome is measured, it is tagged to an area.
   "Strength N/5" on the record page, Records and Quick Log, with one tooltip that names exactly those five; the
   analysis averages it and counts 0 to 5. The record page reads it for the style shown and says "Complete" only at
   5 of 5 with no note.
8. **One glossary.** The writer's `GLOSSARY` is the only expansion table. LOA is not spelled out (Line of Accounting
   in finance, Letter of Appreciation in awards), and stays in capitals with ADVANA. A test holds the Reference
   glossary's meanings to the writer's where both define a term.
9. **The out-of-date banner** (`basis.ts`, the studio). When editing starts, the studio keeps a basis beside the
   text: one 32-bit FNV-1a hash per entry over the fields the writer reads, and one for the case work. Hashes only, so
   the browser holds no second copy of the record. When the record has changed, a note above the text names what
   changed (entries changed or added, up to three titles; entries no longer in the period; the case work), keeps the
   text as written, and offers "Keep my text" (takes a new basis) or "Back to the written version". A rolling period
   (last 30 or 90 days, last 12 months, all time) is kept by its name, so the edit survives a new day; the unit is in
   the key for a Marine viewed through a unit (a Marine's own report is the same whatever unit is picked, as the
   server reads it), and each part of the key is escaped. The key before units were part of it is moved once, and
   only for a Marine's own report: a leader's old edit could have been written from another unit's view. For a
   rolling period that old key names the period's dates, so it is moved once the report is read. An edit kept
   from before the basis existed gets its own note ("cannot say whether your record has changed since") with the same
   two buttons. Format and Spell out wait while an edit stands instead of discarding it, and the studio says so in
   words. The text box holds at most 5,000 characters, what the PDF accepts. A box emptied of text is no edit: Copy
   and the PDF use the written version, and the studio says so. Edited text sent to the PDF no longer carries the
   written version's "supporting facts withheld". In the other views (Bullets, Period over period, Full analysis) a
   note says when an edit that goes into the PDFs is out of date or cannot be checked. What is read back from the
   browser is checked field by field, so a malformed value falls back to the default. The choices and the edit are
   kept in the tab's session storage, as unsaved Quick Log text is (ADR-0026, ADR-0030): closing the tab or signing
   out forgets them, and sign-out clears them even when the server cannot be reached. Another person's choices left in
   the tab go when someone else's are read. They are saved after each render from what that render showed, so a change
   made on one Marine's screen is never filed under the next one's while the page moves between them. A leader's view
   is keyed by the unit the server built the report for, which the report now returns.
10. **Consumers.** The team dashboard's "Complete entries" means an outcome is stated, as its label says. The AI
    draft's instructions ask for the same work compiled and said once, measured outcomes first. Help says what
    strength counts.

Edited narratives stay in the browser (decided 2026-11-23): no migration.

## Consequences

- A narrative and a package can be shorter than before: ten entries of the same work are one line. What was "across
  3 actions" is one sentence with the total.
- A total with no outcome stays below any single entry with a measured one, however many entries it adds up.
- The package no longer bullets what the narrative holds back, and its rollup follows the bullets instead of leading
  them. The PDFs follow.
- The résumé reads like the JEPES bullet. Its civilian verbs ("Administered", "Committed") and "resulting in" are gone.
- A billet with an outcome is not flagged: "Served as acting section chief; closed 40 of 42 taskers on time" is the
  setting and the claim.
- Records computes strength once per list (the writer reads each row), not twice per sort.
- The record page, Records, Quick Log and the analysis read one entry at a time. An entry the package compiles into a
  total shows its own sentence on its record page, and one the package holds as logged twice is not marked there: only
  the package and the narrative read the period as a whole.
- An entry with no id (an import's preview) is known by its title; two with the same title are told apart by their
  order, so neither replaces the other.
- A narrative edit lasts until its tab closes or sign-out. To keep it longer, copy it or export the PDF.
- An outcome with no letters or digits (a lone dash, an ellipsis, an arrow) or one that only types the title again is no outcome, and a
  title with none ("§§", or a script plain text cannot carry) is no title. A fraction keeps its value ("1 1/2"). A
  score made of numbers and links ("3 for 3", "12 of 12") is an outcome. The dashboard's "Complete entries" uses the
  writer's own rule, so "N/A!" is no outcome in either.
- A total can say less than its entries do: where they share no whole phrase it keeps only the verb, the count and
  the unit. It never says more than every entry does.
- Out of scope: grading the written input, the JEPES and FITREP estimates, and saving edited narratives on the server.

## Alternatives considered

- **Keep money's weight and add more for outcomes.** Any weight that adds them lets a large enough figure pass an
  outcome; a band per tier cannot.
- **Merge near-duplicates by summing and saying "including a possible duplicate".** The total would still claim work
  twice. Holding the copy, with the reason and a way to keep it, leaves the Marine the call.
- **Group the same work only when it does not fit.** That was the old rule; it lists the same work twice whenever
  there is room, which is what evaluation input must not do.
- **Keep the résumé generator and fix its glossary.** Two generators drift; the résumé is now the record's own
  sentence, spelled out.
- **Save edits on the server.** Durable across browsers, but a migration and a new store of evaluation text; the
  browser with a banner meets the need.
