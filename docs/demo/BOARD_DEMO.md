# Board demonstration

The whole product on synthetic data: work, the record it builds, and personal development. Every step
below runs on the real application and is automated in `tests/browser/22-demo.spec.ts`.

## Start the demo

```bash
npm ci && npm run build
VANTAGE_ACCESS_MODE=demo VANTAGE_DB=:memory: VANTAGE_EMAIL_PROVIDER=none \
VANTAGE_SECRET=$(openssl rand -hex 32) PORT=8787 npm start
# open http://localhost:8787
```

- Do not set `NODE_ENV=production`: demo mode refuses it.
- A hosted demo sits behind HTTPS with `TRUST_PROXY` naming the proxy.
- Each visitor gets their own workspace, which is removed after 24 hours.
- "Start over" (in the banner, or the account menu) makes a fresh one.

## The story (about 12 minutes)

| # | Step | What to point out |
|---|---|---|
| 1 | Open the URL. Vantage lands on **Today** as LCpl Jordan Avery. | No sign-in form. One banner says it is synthetic, names the persona, and states how long changes last. "Your work" shows the next step on each item; "Open to claim" shows where to start. |
| 2 | **View as the section lead** (SSgt Morgan Diaz), then **Today** and **Team → Workload**. | The lead sees their section first: 11 unassigned, overdue, 1 blocked, 3 waiting (2 posting, 1 approval). Documents researched: 39, 30, 27, 0, 0, beside what each person holds. "How to read these numbers" says counts are not effort and zero recorded is not zero work. The section counts 81 distinct documents, not the 96 the individuals add to. |
| 3 | Optional: **Work → Import a spreadsheet** with the sample sheet (`/api/demo/sample.csv`). | The original file is kept with its hash. The preview comes before anything is written. Reimporting changes nothing. |
| 4 | **View as the Marine.** **Work → Open to claim → SYN-26-P-0047 → Claim.** | "It is yours. It is on your assigned list now." Record → Overview shows it assigned. Contribution counts do not move: holding work is not credit. |
| 5 | Research: enter the award $91,250.00, then invoices $45,000.00 (SYN-INV-0047-1) and $44,725.00 (SYN-INV-0047-2), then the requisition funding $1,500.00. | The synthetic system values panel shows what a Marine would read in DAI. "How to do this in DAI" gives the objective, meaning and completion signal. The screen path is honestly "not documented yet". |
| 6 | **Calculate the candidate.** | $89,725.00 invoice total → $94,025.00 target → **+$2,775.00**. Each input is listed with its source; the UMT amount came from the imported sheet. "Candidate only: applicability not validated; direction does not authorize action." |
| 7 | Decide **Amend the requisition first**, with a reason. | The analyst decides, not the software. The rationale is required and is kept in the history. |
| 8 | **Hand off** to SSgt Diaz with a note. View as the lead, open the item, record the amendment as submitted. | The history says who handed it to whom and why. **Who worked this** lists both people, each with their own entries. |
| 9 | Walk the controls: record a funds check of FAILED, then try to submit. Record WARNING, then submit with a reason. | FAILED, NOT_RUN or UNKNOWN blocks submission. WARNING needs a written reason. Approved and posted are recorded separately. The case resolves only after "UMT cleared" is verified with a reference. |
| 10 | As the Marine: **Prepare a private draft from my work** → Record → Drafts. | The facts are only hers, each citing its entry. The suggested wording is editable and labelled. It is private: no leader can open it, and nothing is sent anywhere. **Keep in my record** adds a private entry. |
| 11 | **Quick capture** on Today: "Volunteered 4 hours at the base food pantry". | One sentence, parsed. It appears under Record → Your entries. No document number is demanded. |
| 12 | **Goals**: edit "Raise PFT score to 270" to 252. **Career → Plan and next steps**: add "Enroll in Sergeants Course DEP". | Measurable progress. Career steps carry their source and whether anybody checked it ("Not verified"). |

## What this demo is not

It is not connected to DAI or any authoritative system, and holds no real data. The 2-Way UMT
procedure is an unvalidated SME walkthrough, as labelled. Operational use needs an accounts-mode
deployment with approved identity, hosting and data authorization. See `docs/PROGRESS.md` and
`docs/engineering/INFRASTRUCTURE_QUESTIONS.md`.
