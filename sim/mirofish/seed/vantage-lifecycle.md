# Vantage, cradle to grave: one section, one tool, a whole enlistment

All people and the unit in this document are synthetic. Nothing here describes a real Marine.

## The tool

Vantage is a web application for a Marine Corps budget execution section. It is a work tracker, a personal record and an evaluation-input tool in one. It runs on the command's own server, not a commercial cloud. It is not a system of record: DAI, MOL, MCTFS, A-PES and GCSS-MC stay authoritative, and Vantage says where every number came from. It never scores or ranks people, and it never measures effort from typing or open tabs.

Its promise is "do the work once, keep the record, know what comes next". A case a Marine researches today becomes a fact in their Record tomorrow, and evidence in their evaluation input next quarter. Nothing is typed twice.

## The section

The G-8 Budget Execution section is part of a synthetic Marine Forces Reserve headquarters. It runs the 2-Way UMT backlog, open obligations, invoice holds and year-end close in DAI. It is piloting Vantage for one fiscal year. Its people:

- **LCpl Jordan Avery** is a 3451 budget analyst, 20 years old, in the section eight months. Avery logs on a phone between tasks and wants credit that holds up at JEPES time. Avery works the 2-Way UMT queue.
- **LCpl Sam Patel** is a budget analyst who prefers the old shared spreadsheet. Patel distrusts any tool that "watches" Marines and is slow to log anything.
- **PFC Casey Brooks** is the newest analyst, two weeks out of MOS school. Brooks does not yet know the procedures or the acronyms.
- **Cpl Riley Chen** is an NCO and the section's best researcher. Chen helps the junior Marines, hands off cases with notes, and is halfway through Corporals Course by distance education.
- **Cpl Taylor Nguyen** is on the Sergeant cutting score. When Nguyen is promoted, evaluation moves from JEPES to fitness reports (FITREPs).
- **Sgt Alex Moreno** was promoted last quarter and is writing input for a first FITREP. Moreno has PCS orders to another command in five months.
- **SSgt Morgan Diaz** is the SNCOIC. Diaz assigns work, watches workload and waiting, writes JEPES command input for the section's Marines, and is reporting senior for Sgt Moreno.
- **Capt Drew Whitfield** is the section OIC, a 3404 financial management officer. Whitfield is SSgt Diaz's reporting senior and wants throughput without judging individuals.
- **Maj Lee Okafor** is the G-8 deputy and the reviewing officer for the section's fitness reports.
- **GySgt Pat Romero** is the S-1 admin chief. Romero produces the MCTFS personnel extract each month, which Vantage reads to keep ranks, units and separations current.
- **Mr. Chris Halvorsen** is the command's ISSM, a civilian. Halvorsen must approve Vantage on the network and cares about audit, data at rest, the privacy impact assessment and who can read what.
- **Ms. Dana Kim** is the civilian system owner who runs the Vantage server: backups, sign-in configuration, retention schedules and legal holds.

## The lifecycle, stage by stage

### 1. Arrival and first sign-in

A Marine joins through an invitation link or a join code from SSgt Diaz. They sign in with a CAC, or with the command's Entra ID where that is configured, and accept the DoD consent banner. Rank decides the evaluation track: E-1 to E-4 are on JEPES, Sergeant and above on FITREP. A "Getting started" list asks for rank, MOS and an email for password resets. Once the personnel feed links an account to an EDIPI, rank, unit, MOS and EAS come from MCTFS and the Marine can no longer edit them.

Open questions: Will PFC Brooks finish the setup? Does the consent banner and CAC step feel like friction or like legitimacy? What happens when an account carries no EDIPI?

### 2. Daily work

**Today** shows what a Marine holds and the next step on each case. Work comes from imported spreadsheets: an S-1 or analyst imports the UMT report, and each row becomes a case in a shared queue.

- **Taking and handing off work.** A Marine claims a case, which puts it on their list at once. They can also hand it off with a note.
- **Procedures.** Each case follows a versioned procedure, such as the 2-Way UMT. The procedure shows the next step and refuses to mark a case resolved without a verified outcome and its evidence.
- **Corrections.** A correction keeps the original. Every case history is sealed against tampering.
- **Quick Log.** Pressing N anywhere opens Quick Log for work that did not start as a tasker. It reads one sentence ("Reconciled 30 ULOs totaling $1,118.38 in DAI on Sep 30") into a dated, counted entry. It works offline and syncs later.
- **On a phone,** Today, Work, a log button and the Record sit at the bottom of the screen.

Open questions:
- Does LCpl Patel log anything at all?
- Do Marines trust that held work is not surveillance?
- What happens when two reports key their rows by the same document number? Vantage now refuses to overwrite a case from a different report and asks the importer to key by two columns.

### 3. Leading the section

SSgt Diaz's **Today** lists the work that needs a leader:
- unassigned and overdue work;
- blocked work;
- work waiting on posting, an approval or an outside response, with how long it has waited.

**Workload** shows, per person, what each Marine holds and the documents they researched in a window. Every count carries its definition and what it cannot show. Totals from fewer than three people are withheld, so no single Marine's figures leak through a team total. Leaders can assign work nobody holds, with a note.

Open questions:
- Does Diaz stop running spreadsheet roll calls?
- Does Capt Whitfield read the counts as performance scores despite the warnings?
- Do Marines feel ranked?

### 4. The Record and JEPES input

Every case action a Marine takes lands in their **Record**, attributed to them. Verified work becomes a draft entry they can keep. Credit is for what each person did: the Marine who verified an outcome is credited with the verification, and whoever resolves the case is credited with the resolution. Training, awards, counseling, goals and readiness (PFT, CFT, rifle, MCMAP, PME) sit beside it.

When JEPES comes due, **Reports → Analysis** writes billet accomplishments in MCO 1616.1 Appendix E's form:
- under the three command input lines (Individual Character; MOS and/or Mission Accomplishment; Leadership);
- each line a dash, a past-tense verb, the number and the result;
- acronyms spelled out once.

The writer holds back required annual training and awards for an earlier period, as the order says. It never writes the chain's judgments. A reviewer grades the input out of 100 and says what would make it stronger. A Marine can click any sentence to see which entries it came from, keep it, leave it out or ask for another wording. The PDF hands the same text to the chain. SSgt Diaz enters the command input marks in MOL; Vantage never computes a JEPES score.

Open questions:
- Does LCpl Avery's input come out stronger than a Marine's who wrote from memory?
- Does LCpl Patel, who logged little, feel the tool punishes them?
- Does SSgt Diaz trust input the Marine assembled?

### 5. Promotion to Sergeant: the switch to FITREP

When Cpl Nguyen's rank changes to Sgt (from the personnel feed), Vantage moves Nguyen to the FITREP track:
- **Readiness** checks the fourteen attributes the reporting senior marks in Sections D to H, and says which have no evidence.
- **Analysis** drafts the MRO worksheet input: a Section C draft of billet accomplishments as dash bullets, results only, no superlatives, 1,232 characters. Beside it go the worksheet's PME/self-education and Other blocks.
- **Section H** (Fulfillment of Evaluation Responsibilities) applies only when the Marine served as a reporting official.
- **PME advice.** A Sergeant whose PME is by distance is told that MARADMIN 630/24 also requires Sergeants School or its seminar.
- **The reporting period** counts down on Today.

Earlier entries keep the JEPES area they were logged under and are read as the matching FITREP section.

Open questions:
- Is the switch confusing?
- Does Sgt Moreno's first MROW get to SSgt Diaz on time?
- Do the reporting senior and the reviewing officer find the input credible or self-serving?

### 6. Change of reporting senior, PCS and transfer

When Sgt Moreno leaves the section for a new command:
- Moreno's held work is released back to the queue, with the reason recorded in each case's history.
- Leaving the unit signs Moreno out everywhere, so no access cached in an open session outlives the membership.
- Access to the section's shared work follows current membership only. Moreno's personal Record (entries, drafts, career plan) stays Moreno's.
- At the new command, Moreno joins with a new join code.
- The case histories Moreno contributed to keep Moreno's name on Moreno's entries.

A change of reporting senior ends a reporting period early, and Moreno needs FITREP input for that occasion.

Open questions:
- Does anything Moreno did get lost or credited to someone else?
- Can the gaining command see anything it should not?

### 7. Separation and EAS

GySgt Romero's monthly MCTFS extract drives separations:
- A Marine dropped from the extract, or listed with a Separated status (including someone appearing for the first time already separated), is marked separated and their account is turned off.
- An extract that would separate more than 20% of the roster stops and asks. A truncated or wrongly filtered file looks exactly like a command emptying.
- A Marine listed again as active has their account turned back on, unless an operator turned it off on purpose.

Before EAS, a Marine can download a personal export: a zip of their activities, contributions, drafts and career plan, re-importable as CSV. The Record is kept after separation, because it must still answer to the Marine and to a records request.

Open questions:
- Does LCpl Patel, leaving at EAS, take anything with them?
- What does a wrong extract do to the section on a Monday morning?
- Who notices an account that never had an EDIPI?

### 8. Records disposition: the grave

Ms. Kim governs what happens to records over time:
- **Retention.** Each schedule states how long a kind of record is kept, its authority, and its disposition: report only, anonymize (free text replaced, dates and quantities kept) or destroy.
- **Holds.** Nothing disposes by default, and a legal hold always wins.
- **Logging.** Every run is logged, including runs that did nothing.
- **Audit.** The audit log is a hash chain, and every cross-person read (a leader opening a Marine's record, building their report, exporting) is audited with who, when and from where.
- **Privacy inventory.** It is generated from the live database for the PIA package.

Mr. Halvorsen reviews it for the authority to operate.

Open questions:
- Does the ISSM approve it?
- Would a records request years later find what it needs?
- Does anyone ever turn a retention schedule on?

## Constraints and known limits

- The optional AI drafting (through GenAI.mil only) is off by default and sends only the Marine's own entries for the period.
- The FMRA procedures are labelled as formal training reference, not verified against current SOPs by an SME.
- Not yet exercised end to end:
  - a real Entra tenant in GCC High or DoD;
  - PostgreSQL;
  - a real CAC revocation;
  - a restricted-network install.
- The tool is new. The section has used shared spreadsheets and email for years, and some leaders measure people by what they see in those.
