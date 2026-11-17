# ADR-0033 · The counseling worksheet is the form in use, and its EDIPI boxes come from each person's own profile

**Status:** accepted · **Date:** 2026-11-17 · **Amends:** [ADR-0027](0027-counseling-workflow-navmc-2795.md) (its
worksheet) · **Builds on:** [ADR-0009](0009-identity-and-unit-membership.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0020](0020-reports-printable-output.md)

## Context

Task 20 printed a counseling as a worksheet "in the layout of NAVMC 2795 Appendix A": Figure A-1 for a Lance Corporal
and below, Figure A-2 for the rest, labelled "Not an official form", with no SSN box. Between Task 25 and Task 26, John
(2026-11-17 00:06 UTC) asked for:

> SSN on Counseling: Box visible, editable after export
> Form for Counseling: the actual NAV FORMAT, THE ACTUAL FORM. not a custom, the actual one used.

marines.mil and the archives that hold the guide refuse this environment, so the form could not be fetched. John sent
a photograph of the form his command uses (00:17): a one-page **COUNSELING WORKSHEET**, references NAVMC 2795, MCI
8002, MCI 7104, IRAM and MCO P1610.7E (PES), with black bars over sections A to G, and "font in the black boxes is NOT
italic". Its ID box reads **EDIPI**, not SSN; John confirmed that label on a card (00:24, "EDIPI, as on your form").

Then (00:24): "Make it take EDIPI from user's profile. If not there, make them type. Once typed, it would save to that
persons profile." And on a second card (00:27), whether a counselor may type the Marine's missing EDIPI into the
Marine's profile: **"Each person types their own."**

## Decision

### 1. One form, drawn three ways

The worksheet is the COUNSELING WORKSHEET in John's photograph, for every grade. `shared/counseling.ts`
(`counselingWorksheet`) says what goes in each box; the dialog preview, the print page and the PDF draw it from that
one description. Figures A-1 and A-2, their head boxes and their narrative blocks are gone (`worksheetFor`,
`worksheetBlocks`, `worksheetHead`, `sessionKindFor`, `SSN_NOTICE`). The document's form id is now
`vantage-counseling/2`.

- **Columns.** Eight, in the photograph's proportions (`WORKSHEET_COLUMNS`, in points on a 540pt line). Every row of
  section A covers all eight edge to edge, which a unit test checks.
- **A. Administrative Information.** Marine Reported On: Last Name, First Name, MI, EDIPI, Rank, DOR, PMOS, BILMOS;
  Occasion (the counseling's type); Period Covered From (blank) and To (the counseling's date, YYYYMMDD); Marine
  Performing Counseling (Reporting Senior): Last Name, First Name, MI, EDIPI, Rank, Billet. Names and ranks print in
  capitals, as typed on the form. The particulars kept at finalization now hold the split names and the counselor's
  billet (their billet in the counseling's unit, else their primary unit's); particulars kept before this change hold
  only "Last, First M" and are split on the comma. A counselor typed in by hand ("Sgt Juandiego, Luis") prints its
  leading rank in the Rank box (`leadingRank`, the Marine Corps abbreviations in `server/db/ranks.ts`); anything else
  typed stays as typed.
- **B. Billet Title** is the Marine's billet.
- **C. Major Accomplishments/Significant Events** is Strengths. **D. Evaluation of Performance This Period** is the
  Summary, then Areas to improve under its own label. **E. Tasks Assigned Next Period** is Goals set. **F. Additional
  Comments** is the target date for the next counseling.
- **G. Certification**: the reporting senior's signature and date, then the Marine's. Vantage does not sign.
- **Bars** are white upright Helvetica-Bold on black, never italic. Values are Courier, as typed on the form.

### 2. Blank boxes are the reader's, and the PDF lets them type in them

Vantage leaves blank what it does not hold: date of rank, billet MOS, the start of the period, a middle initial it does
not have, the signatures and their dates, and an EDIPI not on the person's profile. In the PDF each of these is an
AcroForm field named for its box (`reported_dor`, `senior_edipi`, `senior_signature`, …) with a tooltip, a length limit
where the box has one (EDIPI 10, DOR 8, MOS 4, MI 1) and Courier 10; a signature box is a signature field; a section
Vantage has nothing for is a multi-line field. The file carries no JavaScript and no format actions. On screen a blank
box stays empty, as on paper; a screen reader hears "Blank".

Long text keeps the one-page form when it can: 9, 8 and then 7 point with the form's box heights; then the same sizes
with short sections giving their room to long ones; only then a section runs on, with a "(CONTINUED)" bar on the next
page. A page after the form ("About this worksheet") prints only when there is something the form has no box for: a
draft or replaced band, amendment history, own notes, or particulars that are as they are now rather than as finalized.

### 3. The EDIPI comes from each person's own profile, and only they set it

- **Where it comes from.** The EDIPI on the account (`users.edipi`, from the CAC or the unit's roster, ADR-0009) when
  there is one; otherwise the one the person typed for their forms, `users.form_edipi` (migration 040). The account's
  EDIPI always wins.
- **A separate column, on purpose.** `users.edipi` is unique and is how a CAC finds its account. A number typed for a
  form must never be able to link a card to an account, so it never goes there: `form_edipi` is not unique, no sign-in
  path reads it, and the account's EDIPI is corrected only as ADR-0009 says.
- **Only its own person sets it** (`PUT /api/me/edipi`, ten digits or null). A person whose account already carries an
  EDIPI is refused (`edipi_on_account`). A Unit Manager, a counselor and Vantage support cannot set anyone's: John's
  "Each person types their own". A box still missing stays blank and fillable.
- **When it is asked for.** Downloading a worksheet whose own EDIPI box is empty asks for it first, in a dialog; the
  print page asks inline and keeps Print and the PDF off until it is saved (Print opens that page on the click itself,
  so the browser does not block the tab). The preview offers "Add yours" in the box. Settings → Profile has it too.
- **Who sees it.** Only the Marine and the counselor are given either EDIPI on the worksheet (para 3005.1.i: the paper
  is theirs alone); a Unit Manager or records manager reading the counseling gets none. On screen it is masked to its
  last four digits; whole only on the print page and in the PDF. `GET /api/me` no longer sends the account's EDIPI at
  all: it sends `edipi_on_file: { source: 'account' | 'typed', last4 }`.
- **Never stored on the counseling.** The particulars kept at finalization hold no EDIPI; it is read when the worksheet
  is drawn, so an anonymized counseling (retention) prints none.
- **Audit.** Setting, changing or removing it is `edit_profile` with "form EDIPI added|changed|removed", never the
  number. `print_counseling` and the PDF's `export_record` add "; EDIPI of Marine[ and counselor]" when one printed.
- **Privacy inventory.** `users.form_edipi` is an identifier, `users.form_edipi_at` technical. The instance export
  carries them with the rest of the account, so a moved Unit Instance keeps them; the personal export leaves them out,
  as it does the account's EDIPI.

### 4. Migration 040 (`040_form_edipi`)

Adds `users.form_edipi` (NULL, or exactly ten digits, by CHECK) and `users.form_edipi_at` (set exactly when
`form_edipi` is). Additive; no row changes; idempotent through `columnsOf`. Rolling back means the build before this
one, which refuses schema 40: restore the backup taken before the upgrade.

## Consequences

- The worksheet is the form John's command uses, and a Marine can hand it over as is. It is still produced from the
  record, and the record stays the source.
- The SSN never appears. The EDIPI does, which makes a downloaded or printed worksheet PII: the notice on its last page
  says so, and only its two parties get it.
- A grade no longer picks a figure. Counselings finalized before this change print on the new form from the same
  record; their particulars split on the comma, and their counselor's billet is blank.
- Two places hold an EDIPI. The account's wins, and a person whose account gains one (a CAC sign-in, a roster) prints
  that one from then on; the typed one stays on their profile until they remove it.

## Not done

- The form was matched to a photograph, not to a published blank. If a published revision differs, only
  `counselingWorksheet` and the drawing in `server/lib/pdfCounseling.ts` change.
- No digital signature: the signature boxes are fields to sign in a reader that can, or by hand.
