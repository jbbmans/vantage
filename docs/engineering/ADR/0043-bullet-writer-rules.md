# ADR-0043 · The bullet writer's rules: where the count goes, one money word, one way to join an outcome, a summary that repeats nothing, and a FITREP form

**Status:** accepted · **Date:** 2026-11-23 · **Builds on:** [docs/product/NARRATIVE_WRITER.md](../../product/NARRATIVE_WRITER.md)
(the writer), [ADR-0038](0038-custom-date-ranges.md) (the narrative studio's periods)

## Context

The writer (`shared/writer/`) turns an entry into the bullet the record, the package, the coach, the FITREP worksheet
and the narrative studio show. Read on `3cb06ef` and run over the writer corpus and the demo seed, it had five faults a
reviewer would mark on any page:

- **The count went in parentheses.** "Processed MIPRs for the G-8" logged with 22 MIPRs became "Processed MIPRs for
  the G-8 (22 MIPRs totaling $240,000)", where MCO 1616.1 Appendix E's examples put the number with the work
  ("Performed corrective maintenance on 75 aircraft"). A count was "already stated" when its digits appeared anywhere,
  so 4 MIPRs on "Processing MIPRs for Q4" lost the count to the "4" of "Q4". Distances (km, miles) were never written
  at all unless the title held them.
- **The money word was a coin toss.** "worth", "totaling" or "valued at" was picked by a hash of the seed and the
  entry, so one narrative read "45 ULOs valued at $90,750" beside "4 UMTs totaling $6,206" for the same kind of
  dollars.
- **The outcome was glued on.** A result that opened with a verb followed a semicolon ("Built a UMT tracker in
  Excel; cut the weekly review from 3 hours to 1 hour"), and a measured result in paragraph form was joined by
  another coin toss between "; " and ", resulting in".
- **"In all" repeated claims.** The area total added up every entry, including those with a sentence of their own,
  so its figures were said twice, and it opened with "In all", not with what was done.
- **FITREP was JEPES.** `sentenceFor` had no track. The record's FITREP toggle, the FITREP package and the Section C
  draft wrote the JEPES sentence into a block of 1,232 characters shared by every accomplishment.

## Decision

1. **The count goes with its noun.** When the title names the unit, the count goes in front of the noun phrase,
   back over up to two words that describe it ("Processed 22 MIPRs for the G-8", "Drafted 6 award recommendations",
   "Conducted PMCS on the battalion's 12 MTVRs", "Cleared 4 2-Way UMTs", "Drafted 30 Page 11 entries"); a "the" in
   front gives way ("Inspected 30 vehicles for corrosion"), and so does a vague or rough count the Marine typed
   ("several", "a few", "a dozen", "hundreds of", "20+", "about 20", "twenty-five": "Inspected 6 vehicles before the
   convoy", "Reviewed 300 travel claims"). Words joined by "and" in front of the noun stay together ("Processed 25
   leave and liberty requests", "Processed 18 DTS and GPC reconciliations"). A word the
   unit only modifies is not the unit ("parts requisitions" with 75 parts keeps "(75 parts)"). When the unit is not in
   the words and the title goes straight from its verb to a preposition, the count is the verb's object, for verbs the
   lexicon knows take one: people after a verb of leading, developing, caring or communicating ("Trained 3 Marines on
   DAI"), hours, days, weeks, months and years after a verb of time ("Volunteered 6 hours at the base food pantry",
   "Served 3 months as acting section chief"), things after any verb that takes an object. A verb that goes with its
   preposition ("checked on", "accounted for", "briefed at", "sorted through") keeps it, and the count goes in
   parentheses after the clause, inside the title's own parentheses when it ends on one ("(OMPFs; 85 records)").
   Never between a verb and its particle ("Turned in excess equipment to DLA Disposition (38 items)"), never on a name
   that holds the unit's word ("Organized a Toys for Tots drive"). A count is stated only as a whole number of its
   own, not as the digits inside "Q4", "G-8", "2-Way" or "FY26"; a count the outcome states ("collecting 400 toys",
   "all 4 earned their tan belt") is not said again; a title that states a different count is the Marine's to correct
   and stands as typed. A distance or score not in the words goes in parentheses ("(1,200 miles)").
2. **One money word per kind of dollars** (`connectorFor`, realize.ts): reconciled "totaling", obligated
   "obligating", saved ", saving" after the clause, reviewed "covering", impact "valued at"; a configured kind by
   whether it sums, read from the command's own value types on the record page, Quick Log, the package and the
   narrative alike. The same word for every entry and every total of that kind in a text. When the word would repeat
   the opening verb ("Obligated 12 MIPRs obligating"), the kind's summing word is used instead ("Obligated 12 MIPRs
   totaling $999,960"). A money verb with nothing after it takes the dollars as its object ("Reconciled $441,300"),
   and so does "funds" or "money" after one ("Obligated funds for the range upgrade" is "Obligated $45,000 for the
   range upgrade"; "Saved the battalion money by consolidating orders" is "Saved the battalion $12,000 by
   consolidating orders"). What was saved is the money, so a count beside it goes in parentheses ("Saved $441,300
   (1,200 documents)"). Dollars the outcome already states are not said again ("Recovered overpayments from 14 DTS
   vouchers, saving the command $40K"). "Another wording" keeps working: the seed picks one of two whole sets (the
   second: "worth", "valued at", ", saving", "covering", "worth"), never a word per entry.
3. **One rule for joining an outcome**, both formats: a grade "with a 3.8 GPA" (also "graduated with a 92 average"
   and a PFT, CFT or range score); a result that opens with a past-tense verb and its object becomes a participle
   ("Built a UMT tracker in Excel, cutting the weekly review from 3 hours to 1 hour", "Inspected 6 vehicles before
   the convoy, finding and fixing 2 leaking hoses", "sorting and shelving the weekly delivery"), and so does a second
   verb joined by "and" with an object of its own ("identifying 4 errors and replacing the pages"); a verb the lexicon
   does not know takes the regular "-ing" ("producing all 120 supporting documents"); a result the Marine already
   wrote as an "-ing" phrase follows a comma ("Reviewed 12 GPC statements, covering $2,875 in purchases"); a measured outcome
   ", resulting in 100% mission readiness" on JEPES, as Appendix E's examples write it, where a measure is a figure or
   "zero"/"no" with no verb of its own; anything else after a semicolon ("; all cleared on the next report", "; 28
   Marines passed on the first attempt", "; 2 days early"), in lower case after the semicolon. A result is not made a
   participle when it has a second verb after a comma ("; found 6 missing pages, corrected all"), a subject of its own
   ("; processed vouchers increased from 40 to 60 a week", "; found 4 cracked frames and the CO ordered a stand
   down"), nothing after its verb ("; completed ahead of schedule"), a preposition or adverb right after its verb, or
   an "-ing" phrase of its own. After a
   clause that already ends on an "-ing" phrase or a trailing figure (", saving $18,250", FITREP's ", supporting the
   close"), the outcome follows a semicolon as typed, so no sentence stacks two of them. No coin toss.
4. **The summary repeats nothing.** It is built after the sentences are chosen, from the entries in its area with
   no sentence of their own, and only when two or more are left: "Reconciled 14 ULOs totaling $48,250 and corrected 6
   rejects totaling $4,120", or, short of room, the counts alone when they still speak for two entries. It opens with
   a verb, says "more" when a sentence already counts the same work ("Reconciled 31 more ULOs"), and names only the
   entries a figure in it comes from. It counts only work whose own bullet makes the count the verb's object, so
   "Checked on every section Marine (6 Marines)" is never totalled as "Checked 6 Marines"; the same rule picks the
   entries a group sentence ("Reconciled 23 ULOs totaling $60K across 3 actions") adds up. Dollars of more than one
   kind are not summed into one figure, and entries whose dollars are of different kinds, or of a kind that does not
   sum, are not made one group sentence. The studio's card for it lists its entries.
5. **A FITREP form.** `sentenceFor` takes the track. FITREP Section C writes dollars of $10K or more short ("$48.3K",
   "$1.5M", "$1.2T"), with the unit chosen after rounding ("$1M" for $999,960, never "$1000K"; "$10K" for $9,999.99),
   including amounts the Marine typed in the title or the outcome ("clearing $48.3K in aged balances"); smaller sums
   stay in full ("$4,500"). A measured outcome follows a semicolon in place
   of ", resulting in", and "supporting" takes the place of ", in support of". JEPES keeps Appendix E's full form.
   `composeBullet` with the FITREP style, the FITREP package, `coachEntry` on FITREP and the worksheet blocks write it.
   The Reports page sends no bullet style until one is picked, so a package is written in its own track's form
   whoever reads it.
6. **Tidying.** A word twice in a row is written once, in the same case only, so "Completed AT at Camp Lejeune",
   "two two-day ranges" and "had had" stand (`finish`). A trailing "-", "&", "/" or "+" is dropped. A placeholder
   outcome ("N/A", "TBD", "none", "-") is no outcome. A second sentence in a title or outcome joins the first ("Zero
   returned; CO was pleased"), except after an abbreviation ("Lt. Col."). The first person comes out of an outcome as
   it does from a title. A title's heading before a colon ("Led section PT: 10 km hike") is its purpose. A spelled-out
   acronym takes the right article ("a UMT", "an NCO", "the Defense Agencies Initiative (DAI)") and keeps its
   possessive ("the noncommissioned officer's (NCO's) 9 Marines"). A title that opens with a gerund the lexicon does
   not know is put in the past tense by the regular rule ("Digitizing the training records" is "Digitized 400 training
   records"). A purpose taken from a title with no verb gets "the" when it names one thing ("in support of the FY26
   year-end close"). The lexicon gains
   return, move, collect, sort, shelve, rebuild and irregular pasts (broke, caught, hung, threw, rose, fought, dug,
   swept, wove, sought), some for their past form only, so "order" and "replace" do not turn a noun into a verb; and a
   list of words that end in "ed" but are not verbs ("Speed", "Need", "Exceed", "hundred").
7. **Held to fixed examples and checks.** `tests/server/bulletExamples.ts` holds 60 entries, ten each in finance,
   admin, motor transport, supply, training and leadership, with the exact JEPES and FITREP bullet for each, and 21
   edge cases an independent review of those examples turned up, each with its exact text.
   `tests/server/bulletChecks.ts` holds the checks: the bullet opens with a capitalized past-tense verb, not two verbs; no
   parentheses inside, beside or doubled with others; no "resulting in" before a clause with its own verb; every
   number comes from the entries as what it is (dollars as dollars, a count as typed, dollars rounded as shown, or a
   total of one kind of work or one kind of dollars for a group or a summary, and how many entries a group speaks
   for); the entry's count and dollars are not lost; no figure said more often than the entries say it (a count typed
   in the title and the count field are one statement); one period at the end, nothing left dangling, one sentence;
   no outcome glued on after a semicolon (nor an "-ing" phrase, a capital or a placeholder after one), no opening verb
   said again as the money word, no two "-ing" phrases in a row, no verb after "in support of"; no "resulting in"
   before a time or a grade; the count where it reads (not beside a word that guesses it, inside the opening verbs or a
   name, before a gerund, after a word that describes the noun, before a noun the unit describes, or after a verb that
   needs its preposition, unless the Marine typed it that way), and no unit twice in one pair of parentheses; no
   "$1000K", and on FITREP no dollars of $10K or more in full; within the limit (250 characters and 40 words for a bullet, the
   narrative's own limit for a narrative); plain ASCII, no first person ("Phase I", "Class I" and "I MEF" are not),
   no word twice in a row. Across a narrative, each entry is said by one sentence only, a summary counts work only
   the way its entries' own bullets do, and each entry a summary names is in one of its figures. Each check has a case
   it must catch and a case it must pass. They run over every example on both tracks and with the other wording, over
   the edge cases, the writer corpus, the narrative spec's entries, the demo seed's entries (now exported from
   `server/services/demo.ts`) and the examples and edge cases as narratives in
   both formats, both tracks, four limits, two seeds, with and without spelling out; and the structural ones over the
   writer's random-input run and a 600-entry random run of bullets whose dollars include the amounts at each unit's
   edge.

## Consequences

- Every bullet a Marine has logged reads differently after the upgrade, in the record, the package and the studio.
  Nothing stored changes and there is no migration: the writer reads entries, and the text is written when it is
  shown. A report revision keeps the sections it was saved with, and text edited by hand in the studio stays as edited
  (it is kept in the browser with the studio's other choices, whose keys and seed still apply).
- The writer's tests pin exact text, not "any of three" patterns, so a change to its rules shows up as the lines it
  moves.
- The writer does not correct what the Marine typed. "Mentored a NCO" keeps its article, and a count whose unit is
  the second of two nouns goes with that noun ("Inspected trucks and 10 trailers"), because the entry does not say
  how many trucks.
- A bullet whose count fits neither in front of its noun nor after its verb still uses parentheses. The examples
  keep some on purpose ("Deobligated dormant MIPR balances (3 MIPRs)", where the title names balances, not MIPRs;
  "Briefed at the Marines Memorial Club (40 Marines)", where the verb goes with its preposition).
- A title with no verb and nothing the Marine classified to supply one ("FY26 year-end close" with no dollar type)
  still opens with its noun. The review flags it ("Does not start with what you did"); the writer adds no verb of its
  own, because a verb would be a claim. A title that opens with a preposition ("of reconciled") is not taken as the
  work a value type's verb supported.
- FITREP and JEPES now differ only where Section C's shorthand applies. An entry with no dollars, no measured outcome
  and no purpose reads the same on both.
- A summary leaves out work its entries do not count as the verb's object, so it can be shorter than before or not
  written at all.
- Out of scope, for the next part: ranking by outcome, billet statements, merging near-duplicates, one generator for
  the package, record bullet, résumé and strength badge, the glossary merge, the edited-narrative banner, and the
  group sentence's ", including 14: …" form. The résumé style is not changed.

## Alternatives considered

- **Keep the parentheses and only fix "Q4".** Smallest change, but the order's examples put the number with the work,
  and a reviewer reads "(22 MIPRs totaling $240,000)" as an afterthought.
- **One money word for everything ("totaling").** Consistent, but "totaling $18,250" says nothing about savings, and
  "obligating" is what a budget analyst writes for an obligation.
- **Rewrite the summary to total every entry, as before, but drop its sentence when the others cover the figures.**
  It still says each covered figure twice whenever any entry is left over.
- **A separate FITREP writer.** Two generators drift; one writer with a track keeps both in step, and the fixed
  examples show both.
