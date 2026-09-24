# FMRA knowledge and responsibility routing

Vantage should treat the FMRAC material as a controlled operating model, not as a collection of free-text notes.

## What the model represents

Every financial work item has three separate dimensions:

1. **Lifecycle phase** — authority, commitment, obligation, delivered, paid, or reconciliation/exception.
2. **Evidence state** — what was read, observed, decided, submitted, waited on, verified, or resolved.
3. **Responsibility routing** — who may perform a step, who must approve it, and who must verify its result.

The lifecycle answers “where is the transaction?” Evidence answers “what proves that?” Responsibility answers “who should touch the next step?”

Vantage application roles remain separate. A person can be a Vantage SNCO and still lack a DAI Procurement Analyst responsibility. A person can be assigned DAI P2P Inquiry and still lack authority to amend or approve a requisition.

## Catalog and source hierarchy

The file shared/fmra.ts contains the initial vocabulary for:

- DAI P2P inquiry, procurement analyst, UMT/TBO manager, requisitions, requisition approver, procurement officer, receipts, MIPR acknowledgement, and analyst/funds certifier.
- OBIEE/OAS, Advana, GCSS-MC/FOM, DTS FDTA and AXOL, ServMart and fuel alias tables, WAWF/WebVLIPS, G-Invoicing, DFAS 1081, supply, and contracting responsibilities.
- The six financial phases and the key supporting document (KSD) pattern for purchase card, ServMart, contract/order, G-Invoicing, MIPR/IGT, and fuel/feeder transactions.
- Step routing for the current 2-Way UMT walkthrough.

The source hierarchy is intentional:

1. Current official policy and official system guidance.
2. Approved local SOP and delegation.
3. Validated SME workflow.
4. SME walkthrough.
5. Historical case or AI inference.

The current 2-Way UMT procedure is still a SME walkthrough. The catalog can route work and show missing coverage, but it must not be treated as an authorization system or approved SOP.

## User responsibility profile

The first slice stores the personal profile in the existing users.prefs JSON field as fmraResponsibilities. Each entry has:

- key — stable catalog key.
- status — assigned, training, or not_assigned.
- verified — whether a leader or administrator has verified the assignment.
- note — optional local context.

The Responsibilities page makes the distinction visible and labels assigned items as self-reported until verified. This avoids converting a self-selected checkbox into a false permission grant.

The next admin layer should move verification into a dedicated table:

- user_id
- unit_id
- responsibility_key
- status
- source (unit roster, DAI role export, delegation, training record, manual)
- verified_by
- verified_at
- expires_at
- notes

A verified profile should be scoped to a unit. The same person can hold different responsibilities in different units, and a responsibility can expire or enter training status.

## Assigning documents and steps

A procedure step carries three routing lists:

- perform — people who may execute the step when locally authorized.
- approve — the required approval or delegated authority.
- verify — the person who should confirm that the evidence cleared the original condition.

For the UMT walkthrough, examples are:

- Research the award: DAI P2P Inquiry, Procurement Analyst, or UMT/TBO Manager.
- Amend the requisition: DAI Requisitions; approval by Requisitions Approver or Analyst/Funds Certifier.
- Create and submit the award modification: Procurement Analyst; approval by Procurement Officer or Contracting Officer.
- Verify the unmatched transaction cleared: UMT/TBO Manager or P2P Inquiry.

The Work Item procedure panel displays these responsibility chips and highlights a chip when the current user has marked that responsibility assigned or training. The next assignment step should add:

1. “Assign by responsibility” to the work queue.
2. Candidate members filtered by a verified responsibility in the same unit.
3. A warning and required override reason when a leader assigns work to someone without a verified match.
4. An append-only event recording the responsibility used, candidate set, assignee, and override reason.
5. Batch assignment for imported rows that share a procedure, exception type, or required responsibility.

A missing responsibility should be a routing warning by default. Local units may turn on enforcement after their roster and delegation data are trustworthy.

## Financial records and evidence

Imported source fields must remain immutable. FMRA metadata belongs in a separate envelope on the work item or in append-only events:

- lifecycle phase
- exception type (OCMT, ULO/UDOU, DOU, OTO, invoice hold, UMT, interface error, BFS reject)
- requisition, award/PO, invoice, document, project, task, POET, SLOA, fiscal year, period of performance
- amount and quantity before/after correction
- required responsibilities
- evidence links and source references

The case history should continue to distinguish:

- source read / observation
- calculation
- decision and rationale
- action prepared
- action submitted
- external approval/effective/posted event
- wait state
- verification
- resolution

That prevents “submitted” from being confused with “approved,” “posted,” “obligated,” “delivered,” or “paid.”

## G-Invoicing extension

G-Invoicing needs its own procedure family:

- GT&C / 7600A: agreement terms; no commitment or obligation.
- Order / 7600B: order between buyer and seller.
- Performance: goods/services delivered or accepted.
- Settlement: payment or reimbursement completed.

The tool should store buyer/seller role, order type (Buyer Initiated or Seller Facilitated), funding agency, servicing agency, project/task, and settlement status. A reimbursable project should not be closed just because the GT&C exists or performance is complete.

## Implementation sequence

1. **Catalog and profile** — shipped in this branch: FMRA vocabulary, lifecycle/KSD catalog, profile page, and UMT routing display.
2. **Verified unit roster** — add the scoped responsibility table and leader verification workflow.
3. **Assignment routing** — candidate filtering, responsibility-based batch assignment, and override audit events.
4. **Procedure coverage** — add OCMT, ULO/UDOU, invoice hold, interface error, MIPR/IGT, and G-Invoicing procedures.
5. **Controls and reporting** — responsibility coverage, aged exceptions by phase, unresolved verification steps, and KPI/error-correction reports.
6. **Authoritative review** — mark procedures as validated only after local finance, contracting, supply, and system owners review them.

The tool remains a work and evidence layer. DAI, DTS, GCSS-MC, WAWF, G-Invoicing, and DFAS remain the systems of record for their own transactions.
