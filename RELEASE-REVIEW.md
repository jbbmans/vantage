# VANTAGE 3.6.0 Release Review

## Release profile

VANTAGE 3.6 is the command-ready controlled-evaluation release of the performance, productivity, career, and operational-record workspace. It combines low-friction daily capture, a chart-first operational picture, exact-unit teamwork, rank-aware evaluation preparation, configurable reports, auditable administration, and first-party deployment controls in one self-hosted product.

## Product scorecard

| Area | Release result |
| --- | --- |
| Command experience | At-a-glance measures, primary trend, actionable attention, recent work, and personalized supporting views |
| Daily capture | Always-available Quick Log with editable date, quantity, units, dollars, transaction type, context, visibility, outcome, and notes |
| Records and reporting | Searchable source ledger, duplicate-aware import, safe export, evaluation narrative, bullet package, change report, and print workflows |
| Work and career | Tasks, projects, measurable goals, Training & PME, Recognition, Readiness, and rank-aware preparation |
| Team administration | Exact-unit roster, assignments, guest access, in-context role editing and ordering, permissions, unit ownership, account lifecycle, and access review |
| Configuration | Per-account theme, density, periods, report format, Quick Log defaults, dashboard layout, and allow-listed operator runtime controls |
| Security boundary | Revocable sessions, exact-unit authorization, owner-only personal scope, audited protected reads, validation, throttling, and deployment-owned secrets |
| Deployment | Same-origin Node/Express application, SQLite persistence, Docker, Render, Fly.io, health checks, backup, restore, reset, and roster provisioning |

## Verification evidence

- Production build completed successfully.
- Lint completed with no errors.
- 406 server, domain, security, configuration, migration, and isolation checks passed.
- The isolated 50-account workload completed 50 registrations, 50 sign-ins, 250 core writes, and 250 authenticated reads with personal-record isolation intact.
- The authenticated product audit covered Command, Records, Team, member detail, Work, Goals, Career, Readiness, Reports, Help, Settings, Quick Log, search, account controls, theme behavior, Units, and Roles.
- The VANTAGE 3.6 implementation resolves the audit findings through useful empty states, stable navigation and scroll behavior, exact-unit role filtering, non-duplicated Career navigation, responsive Quick Log fields, a complete Report studio entry experience, in-app preferences, operator configuration, and a full in-product field guide.

## Release decision

VANTAGE 3.6.0 is approved for deployment in controlled evaluation mode with synthetic or specifically authorized information. Operational deployment follows the documented command, privacy, records-management, hosting, CAC/PIV, MCEN, and RMF/ATO process.
