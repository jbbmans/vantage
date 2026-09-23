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

## Not yet modeled

ULO review and deobligation, partial liquidation, requisition-only work, award closeout, funding
changes across fiscal years, and anything multi-line. Each needs its own procedure, modeled from an
actual SOP (`PROCEDURE_MODEL.md`).
