# ADR-0045 · One grade for the written input, read from the entries, with the field behind each part

**Status:** accepted · **Date:** 2026-11-23 · **Builds on:** [ADR-0044](0044-ranking-and-one-generator.md) (one reading
for every output), [docs/product/NARRATIVE_WRITER.md](../../product/NARRATIVE_WRITER.md)

## Context

Read on `4503096` and run over five ordinary entries:

- **Two scales for the same text.** The narrative the writer wrote was graded by `reviewWriting` on areas 25,
  outcomes 25, numbers 20, openings 15, length 15. Pressing **Edit text** put the same text in the box, and the studio
  switched to `reviewText`: numbers 40, openings 30, length 30, less 10 for the first person, split at semicolons. The
  same words graded 95 Strong and then 65 Needs work on JEPES, 84 and 65 on FITREP, with nothing changed.
- **Openings disagreed with the badge.** The written scale counted a sentence with no verb as a strong opening
  (`verbStrength ?? 2`), while the strength badge (ADR-0044) counts it as not opening with what was done.
- **No reasons.** Each part showed a count ("3 of 4 sentences") but not which field it read or what would raise it.
- **Readiness, on the same page family:** a blank command mark was read as `Number(null)` = 0, so with one mark
  entered Readiness said "MOS / Mission Accomplishment is your weakest command mark at 0.0"; PME "None" was shown as
  "Not entered", left Mental Agility unknown, and was told to "Complete the resident PME"; and the weakest-mark advice
  said "Command input is a quarter of the score", which no order cited supports and Vantage does not compute.

## Decision

1. **One scale** (`shared/writer/grade.ts`, `gradeOf`). The written scale stays, since the product doc and Marines
   already know it: areas covered 25, outcomes stated 25, numbers 20, strong openings 15, length 15 (full from 60% of
   the limit, 10 from 35%, 5 for any text that fits, none over the limit). Strong from 85, Solid from 70, Needs work
   from 50, Thin below; Empty with no sentences. A part shared over sentences is rounded once (`round(of * met / n)`).
   The panel says so under the ring (`GRADE_NOTE`).
2. **Read from the entries.** Each sentence the writer wrote is read with the badge's own reading (`strengthOf`):
   opens with what was done, has a number, states an outcome. A total opens as its entries' shared verb does and
   states the outcome they give; case-work credit counts; the rest-of-area summary counts for its area only.
3. **An edit keeps what is unchanged** (`shared/writer/edited.ts`, `piecesOf`; `reviewEdit`). The edit is read back
   against the narrative it came from. A sentence that still stands as written (spacing, the list marker and the final
   period aside) keeps its entries' reading, so pressing Edit text alone changes nothing, part by part. A sentence
   typed or changed is read from its words with the same reader the entries use (`readTyped`, `readEntry`): its
   outcome after the joins the writer uses and a Marine types (`splitOutcome`: a semicolon; a dash between words,
   spaced or not, unless it is a range of figures or dates ("0800 - 1600", "Jun - Aug"; "M27 - 28 qualified" is no
   range) or only a list ("- 10 officers and 30 enlisted"; "- 100% mission capable, zero mishaps" is a measure);
   "resulting in"; a grade's ", with a 3.8
   GPA"; a total's ", including ...:"; or an "-ing" phrase after a comma, as the writer joins an "-ing" Result, unless
   it is a figure such as ", saving $18,250" or ", averaging 3 days", the writer's own purpose or total, or a role or a
   method such as ", working with the S-1", ", serving as" or ", using"), and a strong opening only if it opens with
   the verb as typed ("I reconciled" does not). The reader agrees with the entry reading on all 146 fixed bullets, on
   every sentence of the writer corpus and the demo record, and on a Result that opens with any "-ing" word but those.

   What a Marine does to the layout changes nothing: a list marker ("1.", "(1)", "a)", "--", "o"); a heading named
   another way, read by the area words it uses ("MOS", "Mission Accomplishments", "MOS & Mission Accomplishment",
   "Mission Accomplishment (MOS)", "Leadership.", FITREP's "Section D: Mission Accomplishment"); a label at a line's start, after a list marker or after a sentence,
   with its sentences on the same line or the next; a title or a line of the record above the text ("Billet
   accomplishments", "JEPES input", "Period: 1 Jun 2025 - 30 Nov 2026"); a sentence wrapped onto two lines anywhere,
   before "DAI" or "14" as well, or so that its last figure opens the next line; or an abbreviated date or rank ("12 Mar. 2026", "1stSgt.") in a typed sentence. An
   area named inside a sentence ("Taught 3 classes on Leadership: counseling and PT") is not a label. Every other line
   is read as a sentence, so a line with no end mark ("Promote ahead of peers") still gets the word checks. Every
   sentence counts for the area of the heading or label it sits under, as the text puts it (FITREP's text names none,
   so there it is the entry's area; under a title it is the entry's area too): a bullet moved under another heading
   covers that area, and an entry's area changed in the record later does not move text already edited. The writer's
   rest-of-area summary, reworded ("four UMTs" for "4 UMTs"), is still the summary and claims no work of its own.

   Density, Format, Length, Spell out acronyms and Another wording wait while an edit stands, since each rewrites the
   narrative the edit is read against.
4. **Each part names its field and what would raise it** (`ReviewPart.from`, `raise`). In the activity form's own
   words: the area field ("Each entry's JEPES area" or "FITREP section"), "Result", "Action amount, Transaction value,
   or a number in Title or Result", "The first word of Title", and the limit for length. An edit with typed sentences
   says how many came from each ("Result (3) and your edited text (1)"). A part short of full says what would bring it
   to full and the points: for the written text, the field to fill in on the entries behind N sentences; for an edit,
   what to write, since an entry changed later does not change text already edited. A text with no sentence that
   claims work (only the summary) is asked for one.
5. **The edit's findings are about the edit**: its kept entries' notes, word checks on what was typed (rankings, a
   superlative, a cliché, a vague count, a billet, the first person, a held reason such as last period's award), the
   areas it leaves empty, its length, and acronyms not spelled out in brackets.
6. **Readiness** (`shared/jepes.ts`). Only entered, numeric command marks are compared, a value of spaces is blank
   (and is saved blank: `optNumber` in `shared/schemas.ts` stores spaces or a bare "$" as nothing, not 0; a project's
   progress and a goal's current value, which the record always has, store a blank as 0, and an import compares a blank
   cell there as 0), a PFT or CFT of spaces has
   no class and no FITREP "PFT 0" advice, and the weakest-mark advice keeps only its counseling step. PME "None" reads "None" (attention), counts as entered, and is
   told "Complete the PME for your grade" (finish the distance program or enroll in it); distance keeps the resident
   recommendation; a blank status asks for it ("Enter your PME status") instead of assuming none.

## Consequences

- The grade on the Reviewer panel is the same for the written text, for the server's report (`buildReport`) and for
  an edit that changes nothing; it moves only when what the text says moves.
- `reviewText` is gone; its callers use `reviewEdit(edit, narrative, config)`, which needs the narrative the edit came
  from. Finding ids from an edit carry the sentence (`vague:typed:0`, `billet:<entry key>`), as written findings do.
- A sentence changed by one word is read from its words. Since the reader agrees with the entry reading on the fixed
  bullets and the corpus, that matters only when the change changes what the sentence says, or where the words alone
  cannot tell: an outcome joined some way the reader does not know is read as none.
- No migration. Edits stay in the tab (ADR-0044).

## Tests

`tests/server/grade.test.ts` and `gradeExamples.ts`: fixed examples worked out by hand (every part full; no outcomes;
one area and a weak opening; FITREP three sections of four) and edits of them (nothing changed; numbered, a heading
typed another way, a title and a wrapped line; lines reordered; an outcome cut; a typed first-person sentence; the
text typed over); list markers, headings, abbreviations, the summary reworded, a bullet moved and an area changed in
the record; each part's field pinned to the part; the same grade, part by part, written and edited on
both tracks, both forms, the demo and the corpus, and wrapped by hand at 40 and 60 columns; the words reader against
the entry reading on every fixed bullet, every written sentence and each "-ing" Result; outcome joins, ranges, names
that end in a figure, lists, measures and dashes, and an entry typed with "--"; headings named other ways, labels at a line's end, an area named inside a sentence, titles and record
lines, lines with no end mark; abbreviations and a sentence pasted twice; the bands and the note; what each part asks
for, written and edited. `narrativeReport.test.ts`: the server's report and the studio's
narrative carry the same review. `shared.test.ts`: the blank mark, saved or not, PME "None" and the advice. Browser:
`31-narrative.spec.ts`, the ring before and after Edit text. `records.test.ts` and `recordTransfer.test.ts`: a blank progress
or current value saves as 0, and a blank cell over a 0 imports as unchanged.
