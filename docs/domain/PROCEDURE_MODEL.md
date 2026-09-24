# Procedure model

## Action, procedure, case

- **Action**: a reusable operational mechanism, such as research an award, amend a requisition,
  create an award modification, check funds, or verify an external event.
- **Procedure**: a versioned method. It states what triggers it, its objective, its authority and
  source, its limitations, and ordered steps. Each step has a kind (research, calculation, decision,
  action, external, control, verification, resolution), the fields it asks for, the decision choices,
  a condition for when it applies, the category it waits on, and help text.
- **Case**: one work item's events. The procedure reads them. It never writes them.

Procedures are code (`shared/procedures.ts`), reviewed like code, versioned, and pinned per work item.
There is deliberately no visual workflow designer. Shared actions will be factored out only when two
real SOPs demonstrate the reuse.

## How an SOP becomes a procedure

For each SOP, write down, before any code:

trigger · objective · financial meaning · starting identifiers · authoritative observations ·
derived values · decisions · branches · reusable actions · manual authoritative actions ·
administrative prerequisites · control checks · waiting states · verification events ·
resolution criteria · configurable parameters · human judgment · safe automation · unresolved questions

Record its source, owner, scope, authority level, version, effective date, supersession and review
status. Authority levels, from strongest to weakest:
1. current official DoD/USMC policy
2. official system guidance (for example, DAI)
3. approved local SOP
4. validated SME workflow
5. an SME walkthrough, not yet validated
6. a historical case
7. AI inference

Local or system guidance cannot override governing policy. A historical case or an AI suggestion is
never presented as an approved procedure. Material behind CAC-gated sites that could not be read is
recorded as not reviewed.

## The 2-Way UMT reference (v0.1.0)

| Field | Value |
|---|---|
| Trigger | `2WAY PO MATCH PO open Qty [value] is less than the DCAS qty [value]` |
| Objective | Get the award to cover what was invoiced so the unmatched transaction clears, with every figure and decision on the record |
| Authority | SME walkthrough, not yet validated |
| Source | One SME walkthrough of a synthetic case |
| Limitations | Single-line synthetic case only; not validated for multi-line awards, partial invoices, zero or downward adjustments, or other UMT types; sufficiency comparison not encoded; screen paths undocumented |

Steps:
1. Identify the item: document number and UMT source amount. The amount comes from the imported sheet when present.
2. Research the award and invoices.
3. Record the requisition funding.
4. Calculate the candidate adjustment.
5. Decide on requisition funding: amend first, sufficient, or refer for review. The analyst gives a rationale.
6. Amend the requisition. Only if step 5 chose to amend.
7. Record that the amendment was approved and is effective. Approved and effective are separate observations.
8. Prepare the award modification.
9. Record the funds check. Submission waits on a PASSED result.
10. Submit the modification.
11. Record that the modification was approved and posted.
12. Verify the invoice posted, with a reference.
13. Verify the UMT cleared, with a reference.
14. Resolve.

**Candidate arithmetic:**
- invoice total = sum of the observed invoices. Two observations naming the same invoice reference are
  one invoice, and the later reading is used. Unreferenced observations each count. See Q-15.
- target award = invoice total + UMT amount
- adjustment = target award − current award

Reference check, with synthetic values:
- invoices $45,000.00 + $44,725.00 = $89,725.00
- target award = $89,725.00 + $4,300.00 = $94,025.00
- adjustment = $94,025.00 − $91,250.00 = **+$2,775.00**

This is covered by `tests/server/cases.test.ts` and `tests/browser/22-demo.spec.ts`.

The demo scenario's decision to amend is the scenario, not a rule. The funding-sufficiency comparison
is an open question (SME_QUESTIONS Q-01).

## Versions, pinning and migration

A case is pinned to the procedure version current when it was applied (`work_items.procedure_version`).
A newer published version never silently changes a case in progress: the case page offers "Move this
case to vX", and the move is an attributed `procedure_applied` event with `from_version`. A case pinned
to a version the running build does not have is shown as such and refuses procedure writes (questions,
findings and notes are still accepted) until somebody moves it on the record.

The 2-Way UMT procedure is at **v0.2.0**, which adds "Match the payment to the award (NON-1081)" before
the invoice verification, following the reference's rule that NON-1081 UMTs are the FMRA's to research
and correct while 1081 UMTs belong to DFAS-Cleveland. v0.1.0 cases stay on v0.1.0 until moved.

## Step mechanics added for the FMRA procedures

- **Conditional steps.** `onlyWhen: { decision, choices }` keeps a branch out of the way until its
  decision is made; the checklist shows it as "depends on a decision" rather than "to do".
- **Evidence gates.** `requires: { check, message }` on a decision or action: the server answers 409
  `evidence_required` until that check is verified, and the case page shows the gate, with a link to the
  step that satisfies it, before anybody tries. `gate: 'funds_check'` does the same for a PASSED funds
  check.
- **Prepare-only actions.** `prepareOnly` actions are recorded as prepared; submission happens in the
  authoritative system and is observed by a later external step.
- **Observing several steps.** An external step can observe whichever of several prepared actions was
  actually taken (`observes.steps`).
- **Fields.** `options` (a closed list, validated on the server), `quantity`, `optional`, and
  `allowNotShown`, which records "the report shows a dash" as its own fact rather than as zero.
- **Responsibility.** Each step can name the role that performs it (P2P Inquiry, Funds Manager,
  Financial Manager, …) from `shared/fmra/roles.ts`; research access never implies the authority to
  create an award, a receipt or a payment correction.
- **Resolution.** `resolvesOn` lists the verifications any one of which resolves the case; resolving
  without one is refused.
- **Formulas.** Calculations name their formula (`umt2way_award_adjustment`, `lifecycle_residual`,
  `umt_award_shortfall`). A calculation is a snapshot: once an input is corrected or a newer reading of
  one is recorded, the server marks it stale with the reason.

## The FMRA procedures (v1.0.0, training reference)

Authority level: the FMRAC training reference, recorded as `training_reference` and labelled "formal
training reference, not verified against current policy" wherever it shows. Screen paths are left
undocumented until an SME confirms them.

| Key | Short | Trigger | Resolves on |
|---|---|---|---|
| `ocmt_research` | OCMT | Commitment exceeds obligation | condition cleared, or requirement shown valid |
| `udou_research` | UDOU | Obligation exceeds delivered | condition cleared, or balance validated |
| `dou_research` | DOU | Delivered exceeds paid | condition cleared, or balance validated |
| `oto_research` | OTO | Travel obligated but not paid | condition cleared, or balance validated |
| `umt_four_stage` | UMT | An unmatched transaction on the UMT report | transaction posted |
| `invoice_hold` | Hold | An invoice held in a 2- or 3-way match | condition cleared |
| `feeder_reject` | Reject | A BFS reject of a DTS or GCSS-MC transaction | condition cleared |
| `interface_error` | Interface | A transaction that did not cross an interface | condition cleared |

Each begins with research (the lifecycle figures, seeded from an import when mapped), a decision on the
cause the evidence supports (with the reference's cause list as choices), the correction for that
cause, and a verification with a reference. The decision on a DOU cause, for example, requires the
payment evidence to have been reviewed first.

Covered by `tests/server/fmraProcedures.test.ts` and `tests/server/fmra.test.ts`.
