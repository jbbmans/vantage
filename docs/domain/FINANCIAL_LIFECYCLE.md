# Financial lifecycle

What Vantage models, what it deliberately does not, and the distinctions it enforces. Terminology
here is the conceptual shape used by the product. Current official terminology and system-specific
behavior must be verified against governing policy (DoD FMR, USMC guidance, DAI desk guides) before
any rule depends on it. See `SME_QUESTIONS.md`.

## Conceptual stages of a dollar

commitment → obligation → expense/accrual → invoice/expenditure → payment/liquidation

These are separate facts. Vantage never treats them as interchangeable and never assumes that every
transaction follows this line in order. A work item can concern any one of them. Its observations say
which.

## Business events and execution procedures are different things

- *Increasing a commitment* is a business event.
- *Amending a requisition in DAI* is one execution procedure that realizes it.

The 2-Way UMT procedure records both. The funding decision is the business decision, and the
amendment step is its execution.

## Distinctions the product enforces

| Not the same as | Enforced by |
|---|---|
| Drafted ≠ submitted | `action_prepared` and `action_submitted` are separate kinds. "Record as prepared" says nothing was submitted. |
| Submitted ≠ approved | Approval is an `external_event` recorded when it is observed. |
| Approved ≠ effective or posted | `external_event` kinds are separate. A step that completes on `posted` stays open after `approved`, with the note "Approved, not yet posted". |
| Funds checked ≠ funds obligated | A funds check is a control (`funds_check`) with one of PASSED, FAILED, WARNING, NOT_RUN, UNKNOWN. It never changes an obligation. |
| Invoice expected ≠ invoice posted | Posting is a verification (`verification: invoice_posted`) that needs a reference. |
| Response received ≠ matter resolved | Correspondence keeps reply, knowledge-received and resolved as three dates. |
| Procedure followed ≠ condition verified | A procedure case resolves only after `verification: condition_cleared` is verified with a reference. |

## Controls

- Submission of the award modification is refused when the latest funds check is FAILED, NOT_RUN,
  UNKNOWN or absent. A WARNING needs a written acknowledgement, stored with the submission together
  with the id and result of the check it relied on.
- A verified result needs a reference.
- A decision needs a rationale and one of the procedure's choices.

## Value handling

- Exact integer cents, with the currency stated, parsed from text. More than two decimals is refused,
  not rounded.
- Sign and meaning are kept: an adjustment carries its direction, and a direction is not a permission.
- Transaction value, commitment change, obligation change and verified financial effect are separate
  fields where they are recorded. A total document value is never labelled savings, and credit is never
  multiplied by stage changes.

## The four phases, as the FMRA reference teaches them

The FMRAC training reference reads one document through four phases, each with its own general-ledger
anchor, and names the gap between two adjacent phases (`shared/fmra/lifecycle.ts`, `conditions.ts`):

| Gap | Condition | What is open |
|---|---|---|
| commitment − obligation | **OCMT**, open commitment | a requirement not yet covered by an award |
| obligation − delivered | **UDOU**, undelivered order | an award whose goods or services are not yet received |
| delivered − paid | **DOU**, delivered order unpaid | a receipt not yet paid |
| travel obligation − paid | **OTO**, open travel obligation | a TDY obligation not yet liquidated |

The diagnoser (`shared/fmra/diagnose.ts`, and Reference → Diagnose in the app) classifies the figures as
the reference's eight classroom examples do (full or partial), flags abnormal shapes (a later phase
larger than an earlier one, payment without delivery), and answers in the reference's order: observed
condition, financial meaning, possible causes, research, responsible role, next action, wait and
verification, references and limits. Causes are possibilities to research, never findings; the purchase
method narrows them (a MIPR's open commitment points at the DD 448-2; GPC payments settle through the
bank). The arithmetic is the reference's editorial example, not a rule for live balances, and the
figures must share one document, line and scope.

**Not shown is not zero.** A report cell with a dash is recorded as `not_shown`, drawn as an empty
outline, and excluded from arithmetic that would otherwise treat it as nothing received or paid.

The "true available balance" the reference describes (available funds less pending file items not yet
posted) is shown as a teaching aid in the Reference, never computed against a live ledger.

## Not yet modeled

ULO deobligation as its own procedure (the normal-condition procedures cover research, the correction
decision and verification, but not the deobligation document itself), partial liquidation, award
closeout, funding changes across fiscal years, and anything multi-line. Each needs its own procedure,
modeled from an actual SOP (`PROCEDURE_MODEL.md`).
