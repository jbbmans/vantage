# The narrative writer

Vantage writes a Marine's evaluation input from what they logged: JEPES billet accomplishments for Privates through
Corporals, and a FITREP Section C draft for Sergeants and above. The writer is deterministic code in `shared/writer/`.
It runs on the server for the report and the PDF, and in the browser for the narrative studio on Analysis. It sends
nothing anywhere, and the same entries and choices always give the same text.

It writes the Marine's **input**. It never writes the reporting chain's judgments: marks, the Section I word picture,
rankings, or promotion and assignment recommendations.

## What the orders say, and what the writer does with it

Each rule below is labelled by what it rests on. The reviewer shows the same label beside every finding, so a
preference is never presented as a rule.

| Rule | Basis | What the writer does |
|---|---|---|
| JEPES command input is marked on three lines: Individual Character; Military Occupational Specialty (MOS) and/or Mission Accomplishment; Leadership. | **Order**: MCO 1616.1 | Bullets are grouped under those three headings, in that order. |
| The Marine "is encouraged, but is not required to, submit accomplishments". They should be "specific, quantifiable, and directly related to the three areas of command input". | **Order**: MCO 1616.1, Appendix E | Entries with numbers and outcomes weigh more. An empty line, or a sentence with no number, is a finding. |
| Not billet accomplishments: required annual training, awards for a previous period, personal hobbies. | **Order**: MCO 1616.1, Appendix E | Required annual training (Cyber Awareness, SAPR and the like) is held back, with the rule shown; the Marine can keep it anyway. |
| The order's examples: a dash, a past-tense verb, the number and context, then the result ("-Performed corrective maintenance on 75 aircraft resulting in 100% mission readiness."), with acronyms spelled out on first use ("Position Safety Officer (PSO)"). | **Order**: MCO 1616.1, Appendix E examples | Bullet form is the default. A measured outcome reads "…, resulting in …". Standard acronyms are spelled out once (`GLOSSARY`). |
| FITREP attributes: D Mission Accomplishment (Performance, Proficiency); E Individual Character (Courage, Effectiveness Under Stress, Initiative); F Leadership (Leading Subordinates, Developing Subordinates, Setting the Example, Ensuring Well-Being of Subordinates, Communication Skills); G Intellect and Wisdom (PME, Decision Making Ability, Judgment); H Fulfillment of Evaluation Responsibilities. | **Form**: NAVMC 10835 | Each entry is read for the attributes it gives evidence for (`attributes.ts`: its verb, then words that name an attribute, such as JEPES command input for Evaluations or a course for PME). An untagged FITREP entry sits in its attribute's section. The studio shows the attribute; Readiness counts coverage from the same reading. |
| The MRO routes accomplishments to the reporting senior on the MRO worksheet (MROW, in A-PES). Its blocks: billet description, "Major Accomplishments During This Period", "PME/Self Education", and "Other (i.e. Awards, Commendatory Correspondence, Community Involvement)". | **Order/form**: MCO 1610.7B; the A-PES MROW as reproduced in the NPS thesis (2024) | FITREP input is the Section C draft for the accomplishments block, and the PME and Other blocks beside it (`worksheet.ts`). On FITREP, an entry whose attribute is PME, or a Volunteer Service entry, is routed to its block rather than spent from Section C; it can be kept in Section C. |
| Section C is written as dash bullets. | **Guidance**: NPS FITREP bulletin, Aug 2025 | One list with no headings (`headings: false`), ordered by section D to H so every section has evidence. The studio shows the section beside each group; Copy and the PDF leave it out. |
| Section H, Evaluations: "the extent to which this officer serving as a reporting official conducted, or required others to conduct, accurate, uninflated, and timely evaluations." | **Form**: NAVMC 10835 | Evaluation duties (FITREPs written as RS or RO, JEPES command input) are read as Section H. Readiness asks about H only as applying when the Marine served as a reporting official. |
| PME attribute baseline: "completed or is enrolled in appropriate level of PME for grade"; the attribute also counts nonresident courses, civilian coursework and reading. Sergeants complete the distance program and either Sergeants School or its seminar. | **Form**: NAVMC 10835; **Order**: MARADMIN 630/24 | Readiness no longer tells anyone to go resident; it asks for PME status, and tells a Sgt with distance PME that the distance program is part of it. |
| Section C lists results only: "objective rather than qualitative", no personal qualities or potential impact; "void of superlatives". | **Form/order**: NAVMC 10835; MCO P1610.7F 4005 (reported unchanged in 1610.7B) | Praise adverbs are removed like filler; superlatives and predicted impact are findings. |
| Section C is 1,232 characters. | **Guidance**: NPS FITREP bulletin, Aug 2025 | The FITREP default length. |
| Board readers discount clichés ("valued asset", "team player"). | **Guidance**: Marine Corps Gazette, 2019 and 2020 | A finding, never a rewrite. |
| "Helped", "assisted" and the passive voice weaken a bullet. | **Style**: no order forbids them | A finding marked as a preference. "Helped" is never rewritten into a stronger verb, because that would change the claim. |

JEPES sets no length. The writer uses 1,000 characters to keep the input readable. The order's per-attribute
descriptors (its Figure 1-2) were not available as text, so the writer does not quote or paraphrase them.

## How it writes

1. **Read** (`facts.ts`). Each entry becomes a fact:
   - The title is cleaned: past tense ("Reconciling" becomes "Reconciled"), word order ("14 ULOs reconciled" becomes "Reconciled 14 ULOs"), no first person, no filler or praise adverbs.
   - The opening verb is found in a lexicon of about 170 verbs, each with a kind and a strength.
   - Numbers are sorted into work items, people, time, or measures such as kilometres.
   - Anything a reviewer would ask about is noted.
   - An untagged entry is placed in the area its words point to, and says so.
   - Only the written text changes; the entry itself is untouched.
2. **Hold** (`repeats.ts`, `facts.ts`). The same work logged twice (the same verb, figures, system and organization, a day apart at most, the same words) is held once, the fuller copy leading; keeping the held copy says it was separate work. Required annual training, a prior period's award, work still in progress and rankings are held with their rule ([ADR-0044](../engineering/ADR/0044-ranking-and-one-generator.md)).
3. **Weigh** (`score.ts`). Each fact gets a tier and a score, with every point carrying its reason:
   - the outcome decides first: measured (a number, a zero, every one, a deadline met; never a date, a fiscal year, a quarter or "S-4"), stated, or none, each a band of its own, so a measured outcome outranks any dollar figure;
   - then the largest figure, read on a log scale, with the people led and the Marine's largest count of a unit;
   - a weak opening, a billet named instead of the work ("Served as the S-4 chief"), a superlative or a cliché counts against it.
4. **Compile** (`compose.ts`). The same work (verb and unit) is one total, said once, whether or not its entries would fit one by one: "Cleared 100 OCMTs totaling $111,250 in DAI." The words every entry shares stay; an outcome every entry states is said once, otherwise the strongest with the entries it is true of ("Reconciled 45 ULOs totaling $90,750, including 14 in DAI: all cleared on the next report"). A total only repeats an outcome that one of its entries actually stated, and its entries are never offered on their own.
5. **Plan** (`compose.ts`). Each area with entries gets its best sentence first, by tier and then score. The rest of the limit then goes to the plan that says the most:
   - It tries by value per character and by value outright, outcomes first in both, and keeps the best.
   - It penalises three sentences opening with the same verb.
   - A sentence switches to its compact form (shorter money, no system) when that is what makes it fit.
   - A summary accounts for counted work and dollars that did not get a sentence, once two or more entries are left: "Reconciled 14 ULOs totaling $48,250 and corrected 6 rejects totaling $4,120." It opens with a verb, says "more" when a sentence already counts the same work, counts only work whose own bullet makes the count the verb's object ("Checked on every section Marine" is not "Checked 6 Marines"), and repeats no figure a sentence gives ([ADR-0043](../engineering/ADR/0043-bullet-writer-rules.md)).
   - Pinned sentences always stay; left-out ones never return unasked.
   - Credit from the case histories (documents researched, outcomes verified, cases resolved) is a sentence of its own.
6. **Write** (`realize.ts`, [ADR-0043](../engineering/ADR/0043-bullet-writer-rules.md)).
   - The count goes in front of its noun when the title names the unit ("Processed 22 MIPRs for the G-8"), as the verb's object when the title goes straight to a preposition ("Trained 3 Marines on DAI", "Volunteered 6 hours at the base food pantry"), and otherwise in parentheses. A vague count the Marine typed ("a few vehicles", "hundreds of claims", "20+ Marines") gives way to the number. The "4" of "Q4" is not a count.
   - Money sits next to the count it belongs to, in one word per kind of dollars ("totaling", "obligating", ", saving", "covering", "valued at"; a command's own value types by whether they sum), never the opening verb again ("Obligated 12 MIPRs totaling"), and is never repeated if the title or the outcome already states it. "Funds" or "money" after a money verb becomes the amount ("Obligated $45,000 for the range upgrade").
   - An outcome joins by what it is: a grade "with a 3.8 GPA", something the Marine did as a participle (", cutting the weekly review to 1 hour", ", identifying 4 errors and replacing the pages"), a measure ", resulting in 100% mission readiness", anything else after a semicolon, in lower case.
   - FITREP Section C writes its shorthand: short dollars of $10K or more, typed ones included ("$48.3K", "$1M" for $999,960), a measure after a semicolon, "supporting" for "in support of".
   - Text is plain ASCII, so it pastes into any form.
   - A seed picks one of two whole sets of wording, so "Another wording" never changes a fact and never mixes words within a text.
7. **Review** (`review.ts`). A 100-point grade:
   - areas covered: 25;
   - outcomes stated: 25;
   - numbers: 20;
   - strong openings: 15;
   - length: 15.

   Each finding names the entries that would fix it. Text edited by hand is reviewed from its words (`reviewText`).

## Where it is used

- `shared/narrative.ts` (`composeNarrative`) is the entry point for every caller.
- The package (`shared/writer/package.ts`, `writePackage`, through `buildPackage`) is the same reading: compiled, ranked by tier, capped per area, with what the cap leaves out said once after the bullets and held entries listed with their reason.
- The record's bullet, Quick Log's preview and the coach use `bulletFor` and `coachEntry` (`coach.ts`); the résumé (`resumeFor`) is the JEPES sentence spelled out. The strength badge (`strength.ts`) counts five points from the same reading: opens with what you did, a number, an outcome, a measured outcome, an area.
- `server/services/reports.ts` writes the report and adds case-work credit (`caseworkFor` in `server/services/record.ts`).
- The PDFs (`/api/reports/pdf`, `/api/reports/analysis.pdf`) take the studio's choices (`seed`, `density`, `format`, `spell`, `chars`, `exclude`, `pin`), or the text as edited (`narrative`).
- `src/components/NarrativeStudio.tsx` is the studio. Choices are kept per person, track, period and unit in the tab's session storage until it closes or the Marine signs out; a rolling period by its name. A hand edit keeps the hashes of the entries it was written from (`basis.ts`), and the studio says when the record changed under it, or that it cannot tell for an edit kept from before; the other report views say so too, since the PDFs use the edit.
- The optional AI draft (`report_narrative` in `server/services/ai.ts`) is instructed to follow the same rules.

## Extending it

- **A verb:** add it to `VERBS` in `lexicon.ts`, with its kind and strength. Regular forms are generated; give the past tense when it is irregular.
- **An acronym:** add it to `GLOSSARY` only with a standard expansion.
- **A FITREP attribute cue:** add the words to the cue for that attribute in `attributes.ts`. Keep a cue narrow: it has to name the thing ("JEPES command input", "welfare"), not hint at it. A cue from a plain verb's entry takes the sentence; one from a specific verb (trained, led) is a second attribute.
- **A rule:** add its pattern to `lexicon.ts`, the issue to `readEntry`, and the check to `CHECKS` in `review.ts` with its basis and citation. Mark it `style` unless an order or form says it.
- **Tests:** `tests/server/bulletRanking.test.ts` with its fixed examples (`rankingExamples.ts`): ranking pairs, what is measured, billets, the same work logged twice, compiled totals, the four outputs agreeing on all 81 examples, held entries, the badge, the glossary and the banner's basis; `tests/server/writer.test.ts`, including a fuzz test that any input gives well-formed text inside its limit; `tests/server/bulletExamples.test.ts`, with 60 fixed examples and 21 edge cases (`bulletExamples.ts`) and the bullet checks (`bulletChecks.ts`), each with a case it must catch, run over every example, the corpora in `writerCorpus.ts` and random entries; `tests/server/narrativeReport.test.ts`; and `tests/browser/31-narrative.spec.ts`. A change to a rule moves the examples it touches: read each moved line before updating it.

## Sources

**Official text:**
- MCO 1616.1 (JEPES), including Appendix E: https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/2431802/mco-16161/
- MCO 1610.7B (PES): https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/1513503/mco-16107b/
- NAVMC 10835 attribute names and the Section C anchor are as reproduced in the Naval Postgraduate School thesis "FITREP Content Reliability" (2024): https://calhoun.nps.edu/entities/publication/2909b7d5-306b-4dd9-a8d5-42f095beeee2

**Guidance:**
- NPS FITREP bulletin (1 Aug 2025), for the Section C length and the MRO worksheet: https://nps.edu/documents/156841831/156919127/2025+FITREP+Guidance+for+NPS+Marines.pdf
- Marine Corps Gazette, "Words Have Meaning" (Jun 2019): https://www.mca-marines.org/wp-content/uploads/Words-Have-Meaning.pdf
- Marine Corps Gazette, "The Marine Corps Promotion Board Process" (Dec 2020): https://www.mca-marines.org/wp-content/uploads/49-The-Marine-Corps-Promotion-Board-Process.pdf

**Researched 2026-10-05.** MARADMINs 308/23, 634/23, 575/24, 595/24, 630/24, 066/26 and 209/26 were read on a verbatim mirror (maradmins.com), since marines.mil refused this environment. Annual end dates are suggested only where a MARADMIN confirms them (Capt, Maj, LtCol, E-9, active component); MCO 1610.7B Appendix A was not read directly.

**Not confirmed, so not used:**
- an official Section I character limit;
- the full 2023 "Unacceptable Comments" list;
- the text of the JEPES descriptor grid.
- the annual end dates for Sgt, SSgt, GySgt, MSgt and 1stSgt (Appendix A, seen only in a search excerpt);
- that an MRO with no evaluation duties is marked not observed in Section H (the form has the column; the paragraph was not found).
