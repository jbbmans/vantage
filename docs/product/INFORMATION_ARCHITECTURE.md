# Information architecture

| Destination | Question it answers | Tabs / sections | Route |
|---|---|---|---|
| **Today** | What do I need to do, what am I waiting on, what changed, what can I quickly record? | Leader: your section (unassigned, overdue, blocked, waiting; needs a decision; who holds what). Everyone: your work with next steps; waiting on someone else; open to claim; quick capture; since you last looked; record and development; outcomes you logged | `/` |
| **Work** | What work exists, what is mine, what can I claim, where does it stand? | Queue (all open work / open to claim / mine / resolved), Taskers and projects, Tasks, Correspondence | `/work` |
| Work item | What is this, what happened, what comes next? | Header with stage and holder; next step with help and a form for that step; candidate calculation; add any entry; history; procedure checklist; who worked this; source; correspondence | `/work/items/:id` |
| **Record** | What have I actually done, and what supports it? | Overview (contributions with definitions; assigned to you; what you recorded yourself), Contributions, Your entries, Drafts | `/record` |
| **Goals** | What am I working toward, and how far have I come? | Active / all goals, typed or by hand | `/goals` |
| **Career** | Where do I stand, and what are my next steps? | Plan and next steps, Training, Awards, Counseling, Readiness | `/career` |
| Team (leaders) | Who carries what, and what is stuck? | Workload, Roster, Unit dashboard, Invitations, Roles, Units, Access log | `/team` |
| More | Evaluation input, messages, settings, help | Reports, MARADMINs (when enabled), Settings, Owner console (operators), Field guide | — |

## Placement rules

- Research belongs inside the work item, not in a separate research area.
- Import belongs beside the queue it fills.
- Procedure help sits under the step it explains, behind "How to do this".
- Quick capture is available from every screen (header button and `N`) and on Today.
- A leader's view of workload lives in Team and on their Today, never only in an admin console.

## Retired paths

`/queue`, `/correspondence`, `/studio`, `/activities`, `/records`, `/readiness`, and `/assist` redirect
to their new homes and keep their query string (`src/config/nav.ts`).
