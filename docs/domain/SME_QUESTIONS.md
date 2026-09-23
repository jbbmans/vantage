# Questions for subject-matter experts

Financial behavior Vantage does not encode until these are answered. Until then the product asks the
analyst to decide, requires a reason, and labels its own figures as candidates. Please answer against
current policy or official system guidance where possible, and say which.

| ID | Question | Where it matters | Status |
|---|---|---|---|
| Q-01 | What exact comparison decides whether requisition funding is sufficient for the award modification? Is it against the adjustment, the target award, or something else, and does it net anything? | Funding decision step | Open. The analyst decides and writes why |
| Q-02 | What do DAI's "PO open Qty" and "DCAS qty" measure for a service line versus a supply line, and how do they relate to dollars? | Trigger interpretation | Open |
| Q-03 | How does the procedure change for multi-line awards? Is the arithmetic per line or per award? | Calculation | Open. Single line only |
| Q-04 | How are partial invoices treated? Should an invoice that is not yet posted be counted in the invoice total? | Calculation, verification | Open |
| Q-05 | What should happen when the candidate adjustment is zero or negative? | Calculation | Open. Always requires review |
| Q-06 | How are award modification numbers assigned, and are there office or DODAAC differences? | Action steps | Open. Reference is free text |
| Q-07 | What signal in DAI shows a requisition amendment is approved, and what separately shows it is effective? | Amendment step | Open |
| Q-08 | What signals show the modification is approved, and then posted? | Modification step | Open |
| Q-09 | Is verifying invoice posting always required before resolution, or only when an invoice was pending? | Verification | Open. Shown as a step, not a gate |
| Q-10 | What is the authoritative way to confirm the UMT condition cleared (which report, which run, what timing)? | Final verification | Open. A reference is required |
| Q-11 | Should a funds check WARNING ever permit submission? If so, who may acknowledge it? | Control | Open. Currently the holder may, with a written reason |
| Q-12 | What are the DAI screen paths for each step, in the current release? | Step help | Open. No paths published |
| Q-13 | Who may resolve a financial case: the analyst, a reviewer, or both? | Resolution permission | Open. RESOLVE_WORK role permission |
| Q-14 | Which offices use this procedure, and where does it differ between MARFORRES and other commands? | Applicability | Open |
| Q-15 | Is the invoice number a reliable identity for an invoice across DAI screens, so that two readings with the same number are the same invoice? | Invoice total | Assumed yes: same reference collapses to the latest reading |
